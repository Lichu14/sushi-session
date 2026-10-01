import { ApiError } from "./api-client.ts";
import type {
  CheckInInput,
  Page,
  Profile,
  SushiSession,
  Visit,
} from "./types.ts";
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function createSushiApi(request: Request) {
  const sessions = (cursor?: string) =>
    request<Page<SushiSession>>(
      "/me/sessions?limit=100" +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    );
  async function find(
    predicate: (row: SushiSession) => boolean,
  ): Promise<SushiSession> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await sessions(cursor);
      const result = page.items.find(predicate);
      if (result) return result;
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor))
        throw new ApiError(502, "No se pudo recorrer el historial.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new ApiError(404, "No se encontró la sesión en tu historial.");
  }
  return {
    me: () => request<Profile>("/me"),
    checkIn: (input: CheckInInput) =>
      request<Visit>("/check-ins", "POST", input),
    visits: () => request<Page<Visit>>("/me/visits?limit=100"),
    sessions,
    findSession: (id: string) => find((row) => row.id === id),
    async startSession(visitId: string) {
      try {
        return await request<SushiSession>(
          `/visits/${encodeURIComponent(visitId)}/session`,
          "POST",
          { entryMode: "TAP" },
        );
      } catch (error) {
        // Handles duplicate starts and an accepted POST whose response was lost.
        if (error instanceof ApiError && error.status === 409)
          return find((row) => row.visitId === visitId);
        throw error;
      }
    },
    updateSession: (id: string, pieceCount: number, version: number) =>
      request<SushiSession>(`/sessions/${encodeURIComponent(id)}`, "PATCH", {
        pieceCount,
        version,
      }),
    completeSession: (id: string, version: number) =>
      request<SushiSession>(
        `/sessions/${encodeURIComponent(id)}/complete`,
        "POST",
        { version },
      ),
  };
}
