import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { databaseOperation } from './database-operation.js';
import { checkInInput, type HistoryInput } from './inputs.js';

// Pilot decision: elapsed time from the first accepted visit, never a sliding retry window.
export const CHECK_IN_WINDOW_MS = 4 * 60 * 60 * 1000;

@Injectable()
export class CheckInService {
  constructor(private readonly prisma: PrismaService) {}

  async checkIn(userId: string, body: unknown) {
    const input = checkInInput(body);
    const tokenHash = createHash('sha256')
      .update(input.token, 'utf8')
      .digest('hex');
    return databaseOperation(() =>
      this.prisma.$transaction(
        async (tx) => {
          // Global order for check-ins: authenticated User, then CheckInCode.
          await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
          const existing = await tx.visit.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            include: {
              evidence: { include: { code: { select: { tokenHash: true } } } },
            },
          });
          if (existing) {
            const { evidence, ...visit } = existing;
            if (
              visit.userId !== userId ||
              visit.locationId !== input.locationId ||
              visit.source !== 'QR' ||
              evidence?.code.tokenHash !== tokenHash
            ) {
              throw new ConflictException(
                'La clave de idempotencia ya se usó para otra solicitud.',
              );
            }
            // A successful retry must work even if its code was later revoked or exhausted.
            return visit;
          }

          await tx.$queryRaw`SELECT id FROM public.check_in_codes WHERE token_hash = ${tokenHash} FOR UPDATE`;
          const code = await tx.checkInCode.findUnique({
            where: { tokenHash },
            include: { location: { include: { restaurant: true } } },
          });
          const [clock] = await tx.$queryRaw<
            { now: Date }[]
          >`SELECT clock_timestamp() AS now`;
          const now = clock.now;
          if (
            !code ||
            code.locationId !== input.locationId ||
            code.status !== 'ACTIVE' ||
            code.revokedAt ||
            code.validFrom > now ||
            (code.validUntil && code.validUntil <= now) ||
            code.location.status !== 'ACTIVE' ||
            code.location.restaurant.status !== 'ACTIVE'
          ) {
            throw new BadRequestException(
              'El código QR no es válido para esta sucursal o ya no está vigente.',
            );
          }
          if (
            code.maxUses !== null &&
            (await tx.visitCheckInEvidence.count({
              where: { checkInCodeId: code.id },
            })) >= code.maxUses
          ) {
            throw new BadRequestException('El código QR agotó sus usos.');
          }
          const recent = await tx.visit.findFirst({
            where: {
              userId,
              locationId: input.locationId,
              checkedInAt: { gt: new Date(now.getTime() - CHECK_IN_WINDOW_MS) },
            },
          });
          if (recent)
            throw new ConflictException(
              'Ya registraste una visita en esta sucursal durante las últimas 4 horas.',
            );

          return tx.visit.create({
            data: {
              userId,
              locationId: input.locationId,
              source: 'QR',
              status: 'PENDING',
              checkedInAt: now,
              idempotencyKey: input.idempotencyKey,
              evidence: {
                create: { checkInCodeId: code.id, validatedAt: now },
              },
            },
          });
        },
        { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 },
      ),
    );
  }

  async history(userId: string, input: HistoryInput) {
    return databaseOperation(async () => {
      const cursor = input.cursor
        ? await this.prisma.visit.findFirst({
            where: { id: input.cursor, userId },
          })
        : null;
      if (input.cursor && !cursor)
        throw new NotFoundException('No se encontró la visita.');
      const rows = await this.prisma.visit.findMany({
        where: { userId },
        ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
        orderBy: [{ checkedInAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      });
      const items = rows.slice(0, input.limit);
      return {
        items,
        nextCursor: rows.length > input.limit ? items.at(-1)?.id : null,
      };
    });
  }
}
