import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RewardEvaluationService } from '../rewards/reward-evaluation.service.js';
import { databaseOperation } from '../visits/database-operation.js';
import { uuid } from '../visits/inputs.js';
import { MerchantAuthorizationService } from './merchant-authorization.service.js';
import {
  merchantObject,
  merchantQuery,
  rejectionReason,
} from './merchant-inputs.js';

// A merchant does not need private session notes, pieceCount, token hashes or profile details.
const visitSelect = {
  id: true,
  source: true,
  status: true,
  checkedInAt: true,
  verifiedAt: true,
  rejectedReason: true,
  location: {
    select: {
      id: true,
      name: true,
      restaurant: { select: { id: true, name: true } },
    },
  },
  user: { select: { displayName: true } },
} satisfies Prisma.VisitSelect;

@Injectable()
export class MerchantVisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MerchantAuthorizationService,
    private readonly rewards: RewardEvaluationService,
  ) {}

  async locations(userId: string, query: unknown) {
    merchantObject(query, []);
    return databaseOperation(async () => {
      await this.authorization.requireMembership(this.prisma, userId);
      const rows = await this.prisma.restaurantLocation.findMany({
        where: this.authorization.locationWhere(userId),
        select: {
          id: true,
          name: true,
          restaurant: {
            select: {
              id: true,
              name: true,
              memberships: {
                where: { userId, status: 'ACTIVE' },
                select: { role: true },
              },
            },
          },
        },
        orderBy: [{ restaurantId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      });
      return {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          restaurant: { id: row.restaurant.id, name: row.restaurant.name },
          canReview: row.restaurant.memberships.some(
            (member) => member.role !== 'ANALYST',
          ),
        })),
      };
    });
  }

  async list(userId: string, query: unknown) {
    const input = merchantQuery(query);
    return databaseOperation(async () => {
      await this.authorization.requireMembership(this.prisma, userId);
      const location = this.authorization.locationWhere(userId);
      if (
        input.locationId &&
        !(await this.prisma.restaurantLocation.findFirst({
          where: { ...location, id: input.locationId },
          select: { id: true },
        }))
      ) {
        throw new NotFoundException(
          'No se encontró la sucursal dentro de tu alcance.',
        );
      }
      const where: Prisma.VisitWhereInput = {
        location,
        status: input.status,
        ...(input.locationId ? { locationId: input.locationId } : {}),
      };
      if (
        input.cursor &&
        !(await this.prisma.visit.findFirst({
          where: { ...where, id: input.cursor },
          select: { id: true },
        }))
      ) {
        throw new NotFoundException(
          'El cursor ya no pertenece a esta consulta. Actualizá el listado.',
        );
      }
      const rows = await this.prisma.visit.findMany({
        where,
        select: visitSelect,
        orderBy: [{ checkedInAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const items = rows.slice(0, input.limit);
      return {
        items,
        nextCursor: rows.length > input.limit ? items.at(-1)!.id : null,
      };
    });
  }

  verify(userId: string, visitId: string, body: unknown) {
    merchantObject(body ?? {}, []);
    return this.review(userId, uuid(visitId), 'VERIFIED', null);
  }

  reject(userId: string, visitId: string, body: unknown) {
    return this.review(
      userId,
      uuid(visitId),
      'REJECTED',
      rejectionReason(body),
    );
  }

  private review(
    userId: string,
    id: string,
    status: 'VERIFIED' | 'REJECTED',
    reason: string | null,
  ) {
    return databaseOperation(() =>
      this.prisma.$transaction(
        async (tx) => {
          const origin = await tx.visit.findUnique({
            where: { id },
            select: { locationId: true, userId: true },
          });
          if (!origin)
            throw new NotFoundException(
              'No se encontró la visita dentro de tu alcance.',
            );
          // Same leading User lock as check-in. Acquire before any visit lock:
          // two concurrent verifications must see each other's committed progress.
          await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${origin.userId}::uuid FOR UPDATE`;
          await this.authorization.lockReviewAccess(
            tx,
            userId,
            origin.locationId,
          );
          await tx.$queryRaw`SELECT id FROM public.visits WHERE id = ${id}::uuid FOR UPDATE`;
          const current = await tx.visit.findUnique({ where: { id } });
          if (
            !current ||
            current.locationId !== origin.locationId ||
            current.userId !== origin.userId
          )
            throw new ConflictException(
              'La visita cambió. Actualizá el listado.',
            );
          if (current.status === status) {
            if (status === 'REJECTED' && current.rejectedReason !== reason)
              throw new ConflictException(
                'La visita ya fue rechazada con otro motivo.',
              );
            return tx.visit.findUniqueOrThrow({
              where: { id },
              select: visitSelect,
            });
          }
          if (current.status !== 'PENDING')
            throw new ConflictException(
              'La visita ya fue resuelta y no admite esa transición.',
            );
          const [clock] = await tx.$queryRaw<
            { now: Date }[]
          >`SELECT clock_timestamp() AS now`;
          const result = await tx.visit.update({
            where: { id },
            data: {
              status,
              verifiedAt: status === 'VERIFIED' ? clock.now : null,
              rejectedReason: reason,
            },
            select: visitSelect,
          });
          if (status === 'VERIFIED') await this.rewards.evaluate(tx, current);
          return result;
        },
        { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 },
      ),
    );
  }
}
