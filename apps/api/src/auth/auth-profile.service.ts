import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SupabaseIdentity } from './auth.types.js';

@Injectable()
export class AuthProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(identity: SupabaseIdentity): Promise<User> {
    let profile: User | null;
    try {
      profile = await this.prisma.user.findUnique({
        where: { id: identity.id },
      });
      if (!profile) {
        // ON CONFLICT DO NOTHING makes concurrent first requests idempotent.
        // Existing preferences/status are never overwritten by login or metadata.
        await this.prisma.user.createMany({
          data: {
            id: identity.id,
            displayName: 'Usuario',
            locale: 'es-AR',
            timeZone: 'UTC',
            status: 'ACTIVE',
          },
          skipDuplicates: true,
        });
        profile = await this.prisma.user.findUnique({
          where: { id: identity.id },
        });
      }
    } catch (error) {
      // The Auth FK also protects against identity deletion racing with provisioning.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new UnauthorizedException(
          'La identidad ya no existe en Supabase Auth.',
        );
      }
      throw new ServiceUnavailableException('No se pudo obtener el perfil.');
    }
    if (!profile)
      throw new ServiceUnavailableException('No se pudo obtener el perfil.');
    if (profile.status !== 'ACTIVE' || profile.deletedAt !== null) {
      throw new ForbiddenException('El perfil no está habilitado.');
    }
    return profile;
  }
}
