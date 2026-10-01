import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthGuard } from './auth.guard.js';
import { AuthProfileService } from './auth-profile.service.js';
import { AUTH_FETCH, SupabaseJwtService } from './supabase-jwt.service.js';
import { MeController } from './me.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [MeController],
  providers: [
    { provide: AUTH_FETCH, useValue: fetch },
    SupabaseJwtService,
    AuthProfileService,
    AuthGuard,
    // Protected by default. Public routes opt out explicitly.
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
  exports: [AuthGuard, AuthProfileService],
})
export class AuthModule {}
