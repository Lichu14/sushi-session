import { BadRequestException } from '@nestjs/common';
import { historyInput, uuid } from '../visits/inputs.js';
import type { VisitStatus } from '../generated/prisma/client.js';

export function merchantObject(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new BadRequestException(
      'La solicitud contiene campos no permitidos.',
    );
  }
  return value as Record<string, unknown>;
}

export function merchantQuery(value: unknown) {
  const data = merchantObject(value, [
    'locationId',
    'status',
    'limit',
    'cursor',
  ]);
  const status = data.status ?? 'PENDING';
  if (
    typeof status !== 'string' ||
    !['PENDING', 'VERIFIED', 'REJECTED', 'CANCELLED'].includes(status)
  ) {
    throw new BadRequestException('El estado de visita no es válido.');
  }
  return {
    ...historyInput({
      ...(data.limit === undefined ? {} : { limit: data.limit }),
      ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
    }),
    status: status as VisitStatus,
    locationId:
      data.locationId === undefined ? undefined : uuid(data.locationId),
  };
}

export function rejectionReason(body: unknown): string {
  const data = merchantObject(body, ['reason']);
  if (
    typeof data.reason !== 'string' ||
    !data.reason.trim() ||
    data.reason.trim().length > 300
  ) {
    throw new BadRequestException(
      'El motivo es obligatorio y admite hasta 300 caracteres.',
    );
  }
  return data.reason.trim();
}
