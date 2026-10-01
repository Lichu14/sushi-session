import { ApiError, errorMessage } from './api-client.ts';
import type { SessionApi, SushiSession } from './types.ts';
export interface CounterState {
  session: SushiSession;
  count: number;
  syncing: boolean;
  finishing: boolean;
  needsReload: boolean;
  conflict: boolean;
  error: string | null;
}
export class Counter {
  private api: SessionApi;
  private state: CounterState;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private firstDirtyAt?: number;
  private pending?: Promise<void>;
  private disposed = false;
  constructor(api: SessionApi, session: SushiSession) {
    this.api = api;
    this.state = {
      session,
      count: session.pieceCount,
      syncing: false,
      finishing: false,
      needsReload: false,
      conflict: false,
      error: null,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(change: Partial<CounterState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    this.listeners.forEach((fn) => fn());
  }
  get dirty() {
    return this.state.count !== this.state.session.pieceCount;
  }
  tap(delta: number) {
    if (
      this.disposed ||
      this.state.finishing ||
      this.state.needsReload ||
      this.state.conflict ||
      this.state.session.status !== 'ACTIVE'
    )
      return;
    this.set({ count: Math.min(1000, Math.max(0, this.state.count + delta)) });
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (
      !this.dirty ||
      this.state.syncing ||
      this.state.finishing ||
      this.state.conflict ||
      this.state.needsReload ||
      this.state.error ||
      this.disposed
    )
      return;
    this.firstDirtyAt ??= Date.now();
    const delay = Math.max(
      0,
      Math.min(600, 2000 - (Date.now() - this.firstDirtyAt)),
    );
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, delay);
  }
  async reload() {
    if (this.disposed) return;
    this.set({ needsReload: true, syncing: true });
    try {
      const latest = await this.api.findSession(this.state.session.id);
      if (latest.status !== 'ACTIVE') {
        this.set({
          session: latest,
          count: latest.pieceCount,
          needsReload: false,
          conflict: false,
          error: null,
        });
      } else {
        this.set({
          session: latest,
          needsReload: false,
          conflict: this.state.count !== latest.pieceCount,
          error:
            this.state.count !== latest.pieceCount
              ? 'Revisá ambos conteos antes de continuar. No se sobrescribió el servidor.'
              : null,
        });
      }
    } catch (error) {
      this.set({ error: errorMessage(error), needsReload: true });
      throw error;
    } finally {
      this.set({ syncing: false });
    }
  }
  resolveConflict(useLocal: boolean) {
    if (!this.state.conflict || this.state.needsReload || this.state.syncing)
      return;
    this.set({
      count: useLocal ? this.state.count : this.state.session.pieceCount,
      conflict: false,
      error: null,
    });
    this.schedule();
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending) {
      await this.pending;
      return;
    }
    if (this.disposed || !this.dirty || this.state.session.status !== 'ACTIVE')
      return;
    if (this.state.needsReload || this.state.conflict)
      throw new ApiError(409, 'Revisá el estado actual antes de continuar.');
    const count = this.state.count,
      session = this.state.session;
    this.set({ syncing: true, error: null });
    this.firstDirtyAt = undefined;
    const run = async () => {
      try {
        this.set({
          session: await this.api.updateSession(
            session.id,
            count,
            session.version,
          ),
        });
      } catch (error) {
        this.set({ error: errorMessage(error), needsReload: true });
        if (error instanceof ApiError && error.status === 409)
          await this.reload();
        throw error;
      } finally {
        this.set({ syncing: false });
      }
    };
    this.pending = run();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
      this.schedule();
    }
  }
  async finish() {
    if (
      this.disposed ||
      this.state.finishing ||
      this.state.session.status !== 'ACTIVE'
    )
      return;
    if (this.state.needsReload || this.state.conflict)
      throw new ApiError(409, 'Resolvé la sincronización antes de finalizar.');
    this.set({ finishing: true, error: null });
    clearTimeout(this.timer);
    try {
      if (this.pending) await this.pending;
      if (this.dirty) await this.flush();
      if (
        this.disposed ||
        this.state.needsReload ||
        this.state.conflict ||
        this.state.session.status !== 'ACTIVE'
      )
        return;
      const result = await this.api.completeSession(
        this.state.session.id,
        this.state.session.version,
      );
      this.set({ session: result, count: result.pieceCount });
    } catch (error) {
      this.set({ error: errorMessage(error), needsReload: true });
      // Also resolves a completed POST whose reply was lost. Never blindly replay a write.
      try {
        await this.reload();
      } catch {
        /* Keep the draft and explicit retry. */
      }
      throw error;
    } finally {
      this.set({ finishing: false });
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
