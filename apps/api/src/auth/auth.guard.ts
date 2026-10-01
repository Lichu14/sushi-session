import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseJwtService } from './supabase-jwt.service.js';
import { AuthProfileService } from './auth-profile.service.js';
import { IS_PUBLIC_ROUTE } from './public.decorator.js';
import type { AuthenticatedRequest } from './auth.types.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: SupabaseJwtService,
    private readonly profiles: AuthProfileService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const authorizationCount = request.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === 'authorization').length;
    const match =
      typeof authorization === 'string'
        ? /^Bearer ([^\s,]+)$/i.exec(authorization)
        : null;
    if (authorizationCount !== 1 || !match?.[1]) {
      throw new UnauthorizedException('Se requiere un único token Bearer.');
    }
    const identity = await this.jwt.authenticate(match[1]);
    const profile = await this.profiles.getOrCreate(identity);
    request.authUser = Object.freeze({ ...identity, profile });
    return true;
  }
}
