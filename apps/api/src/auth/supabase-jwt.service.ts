import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
import type { Environment } from '../config/environment.js';
import type { SupabaseIdentity } from './auth.types.js';

export const AUTH_FETCH = Symbol('AUTH_FETCH');
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidTokenCodes = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
]);

@Injectable()
export class SupabaseJwtService {
  private readonly issuer: string;
  private readonly publishableKey: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    config: ConfigService<Environment, true>,
    @Inject(AUTH_FETCH) private readonly authFetch: typeof fetch,
  ) {
    this.issuer = `${config.get('SUPABASE_URL', { infer: true })}/auth/v1`;
    this.publishableKey = config.get('SUPABASE_PUBLISHABLE_KEY', {
      infer: true,
    });
    // Never derive a URL/key from iss, jku or jwk in an unverified token.
    this.jwks = createRemoteJWKSet(
      new URL(`${this.issuer}/.well-known/jwks.json`),
      {
        [customFetch]: authFetch,
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      },
    );
  }

  async authenticate(token: string): Promise<SupabaseIdentity> {
    if (
      token.length > 8_192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ) {
      throw new UnauthorizedException('Token de acceso inválido.');
    }
    let identity: SupabaseIdentity;
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256'],
        typ: 'JWT',
        requiredClaims: [
          'sub',
          'exp',
          'iat',
          'iss',
          'aud',
          'role',
          'session_id',
        ],
        clockTolerance: 5,
      });
      if (
        typeof payload.sub !== 'string' ||
        !uuidPattern.test(payload.sub) ||
        typeof payload.session_id !== 'string' ||
        !uuidPattern.test(payload.session_id) ||
        payload.role !== 'authenticated' ||
        typeof protectedHeader.kid !== 'string' ||
        !protectedHeader.kid ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! > Math.floor(Date.now() / 1_000) + 5 ||
        payload.exp! <= payload.iat!
      ) {
        throw new UnauthorizedException('Token de acceso inválido.');
      }
      identity = Object.freeze({
        id: payload.sub,
        sessionId: payload.session_id,
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      if (
        error instanceof errors.JOSEError &&
        invalidTokenCodes.has(error.code)
      ) {
        throw new UnauthorizedException('Token de acceso inválido o vencido.');
      }
      throw new ServiceUnavailableException(
        'No se pudo verificar la identidad.',
      );
    }

    // A fresh Auth lookup rejects removed identities before provisioning.
    // Publishable key + user's access token; never an administrative Auth key.
    let response: Response;
    try {
      response = await this.authFetch(`${this.issuer}/user`, {
        method: 'GET',
        headers: {
          apikey: this.publishableKey,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new ServiceUnavailableException(
        'Supabase Auth no está disponible.',
      );
    }
    if ([401, 403, 404].includes(response.status)) {
      throw new UnauthorizedException(
        'La identidad no está disponible en Supabase Auth.',
      );
    }
    if (!response.ok)
      throw new ServiceUnavailableException(
        'Supabase Auth no está disponible.',
      );
    let user: unknown;
    try {
      user = await response.json();
    } catch {
      throw new ServiceUnavailableException(
        'Respuesta de Supabase Auth inválida.',
      );
    }
    if (
      !user ||
      typeof user !== 'object' ||
      !('id' in user) ||
      user.id !== identity.id
    ) {
      throw new UnauthorizedException('La identidad no coincide con el token.');
    }
    return identity;
  }
}
