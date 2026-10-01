export interface Profile {
  id: string;
  displayName: string;
  status: string;
}
export interface Visit {
  id: string;
  userId: string;
  locationId: string;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'CANCELLED';
  checkedInAt: string;
}
export interface SushiSession {
  id: string;
  visitId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  pieceCount: number;
  version: number;
  startedAt: string;
  endedAt: string | null;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface CheckInInput {
  locationId: string;
  token: string;
  idempotencyKey: string;
}
export interface SessionApi {
  updateSession(
    id: string,
    pieceCount: number,
    version: number,
  ): Promise<SushiSession>;
  completeSession(id: string, version: number): Promise<SushiSession>;
  findSession(id: string): Promise<SushiSession>;
}
