import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { databaseOperation } from './database-operation.js';
import {
  completeSessionInput,
  startSessionInput,
  updateSessionInput,
  uuid,
  type HistoryInput,
} from './inputs.js';

@Injectable()
export class SushiSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async start(userId: string, visitId: string, body: unknown) {
    const id = uuid(visitId);
    const input = startSessionInput(body);
    return databaseOperation(() =>
      this.prisma.$transaction(async (tx) => {
        const visit = await tx.visit.findFirst({ where: { id, userId } });
        if (!visit) throw new NotFoundException('No se encontró la visita.');
        const [clock] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT clock_timestamp() AS now`;
        return tx.sushiSession.create({
          data: {
            visitId: id,
            status: 'ACTIVE',
            startedAt: clock.now,
            pieceCount: 0,
            ...input,
          },
        });
      }),
    );
  }

  async update(userId: string, sessionId: string, body: unknown) {
    const input = updateSessionInput(body);
    return this.change(userId, uuid(sessionId), input.version, {
      pieceCount: input.pieceCount,
    });
  }

  async complete(userId: string, sessionId: string, body: unknown) {
    const input = completeSessionInput(body);
    // PostgreSQL fixes ended_at using its own clock in the same atomic update.
    return this.change(userId, uuid(sessionId), input.version, {
      status: 'COMPLETED',
    });
  }

  private async change(
    userId: string,
    id: string,
    version: number,
    data: { pieceCount?: number; status?: 'COMPLETED' },
  ) {
    return databaseOperation(() =>
      this.prisma.$transaction(async (tx) => {
        const owned = await tx.sushiSession.findFirst({
          where: { id, visit: { userId } },
          select: { id: true },
        });
        if (!owned) throw new NotFoundException('No se encontró la sesión.');
        const rows = await tx.sushiSession.updateManyAndReturn({
          where: { id, version, status: 'ACTIVE', visit: { userId } },
          data: { ...data, version: { increment: 1 } },
        });
        if (!rows[0])
          throw new ConflictException(
            'La sesión cambió o ya está cerrada. Consultá el historial antes de reintentar.',
          );
        return rows[0];
      }),
    );
  }

  async history(userId: string, input: HistoryInput) {
    return databaseOperation(async () => {
      const cursor = input.cursor
        ? await this.prisma.sushiSession.findFirst({
            where: { id: input.cursor, visit: { userId } },
          })
        : null;
      if (input.cursor && !cursor)
        throw new NotFoundException('No se encontró la sesión.');
      const rows = await this.prisma.sushiSession.findMany({
        where: { visit: { userId } },
        ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
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
