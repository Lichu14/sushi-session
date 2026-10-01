import {
  createContext,
  use,
  useEffect,
  useMemo,
  type PropsWithChildren,
} from 'react';
import { AppState } from 'react-native';
import { Counter } from '@/core/counter';
import type { SushiSession } from '@/core/types';
import { getApi } from '@/lib/api';
function createSessionStore() {
  const api = getApi(),
    counters = new Map<string, Counter>();
  return {
    api,
    counters,
    accept(session: SushiSession) {
      let counter = counters.get(session.id);
      if (!counter) {
        counter = new Counter(api, session);
        counters.set(session.id, counter);
      }
      return counter;
    },
  };
}
const Context = createContext<ReturnType<typeof createSessionStore> | null>(
  null,
);
export function SessionProvider({ children }: PropsWithChildren) {
  const store = useMemo(createSessionStore, []);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active')
        for (const counter of store.counters.values())
          void counter.flush().catch(() => {});
    });
    return () => {
      listener.remove();
      store.counters.forEach((counter) => counter.dispose());
      store.counters.clear();
    };
  }, [store]);
  return <Context value={store}>{children}</Context>;
}
export function useSessions() {
  const store = use(Context);
  if (!store) throw new Error('SessionProvider missing');
  return store;
}
