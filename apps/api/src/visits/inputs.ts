import { BadRequestException } from '@nestjs/common';

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Se requiere un objeto JSON.');
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !allowed.includes(key))) {
    throw new BadRequestException(
      'La solicitud contiene campos no permitidos.',
    );
  }
  return data;
}

function string(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new BadRequestException(`${name} no es válido.`);
  }
  return value;
}

export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)
  ) {
    throw new BadRequestException('El identificador debe ser un UUID.');
  }
  return value.toLowerCase();
}

function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new BadRequestException(
      `${name} debe ser un entero entre ${min} y ${max}.`,
    );
  }
  return value;
}

export function checkInInput(value: unknown) {
  const data = object(value, ['locationId', 'token', 'idempotencyKey']);
  return {
    locationId: uuid(data.locationId),
    token: string(data.token, 'token', 2048),
    idempotencyKey: string(data.idempotencyKey, 'idempotencyKey', 120),
  };
}

export function startSessionInput(value: unknown): {
  entryMode: 'TAP' | 'MANUAL';
  notes: string | null;
} {
  const data = object(value ?? {}, ['entryMode', 'notes']);
  const entryMode = data.entryMode ?? 'TAP';
  if (entryMode !== 'TAP' && entryMode !== 'MANUAL') {
    throw new BadRequestException('entryMode debe ser TAP o MANUAL.');
  }
  if (
    data.notes !== undefined &&
    data.notes !== null &&
    (typeof data.notes !== 'string' || data.notes.length > 500)
  ) {
    throw new BadRequestException('notes admite hasta 500 caracteres.');
  }
  return { entryMode, notes: (data.notes ?? null) as string | null };
}

export function updateSessionInput(value: unknown) {
  const data = object(value, ['pieceCount', 'version']);
  return {
    pieceCount: integer(data.pieceCount, 'pieceCount', 0, 1000),
    version: integer(data.version, 'version', 1, 2147483646),
  };
}

export function completeSessionInput(value: unknown) {
  const data = object(value, ['version']);
  return { version: integer(data.version, 'version', 1, 2147483646) };
}

export function historyInput(value: unknown) {
  const data = object(value, ['limit', 'cursor']);
  if (
    data.limit !== undefined &&
    (typeof data.limit !== 'string' || !/^\d{1,3}$/.test(data.limit))
  ) {
    throw new BadRequestException('limit debe estar entre 1 y 100.');
  }
  return {
    limit:
      data.limit === undefined
        ? 50
        : integer(Number(data.limit), 'limit', 1, 100),
    cursor: data.cursor === undefined ? undefined : uuid(data.cursor),
  };
}

export type HistoryInput = ReturnType<typeof historyInput>;
