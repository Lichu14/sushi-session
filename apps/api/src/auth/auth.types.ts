import type { Request } from 'express';
import type { User } from '../generated/prisma/client.js';

// Constructed only after verification. No token or authorization metadata retained.
export interface SupabaseIdentity {
  readonly id: string;
  readonly sessionId: string;
}

export interface AuthenticatedUser extends SupabaseIdentity {
  readonly profile: User;
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthenticatedUser;
}
