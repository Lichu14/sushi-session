import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';

// Never let a database exception log a query containing token hashes or profile data.
// Retrying a rolled-back transaction is safe: these services have no external effects.
export async function databaseOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (
          error.code === 'P2034' ||
          (error.code === 'P2010' &&
            ['40001', '40P01'].includes(String(error.meta?.code)))
        ) {
          if (attempt < 2) continue;
          throw new ConflictException(
            'La operación tuvo un conflicto concurrente. Reintentá.',
          );
        }
        if (error.code === 'P2002')
          throw new ConflictException('La operación ya existe.');
      }
      throw new ServiceUnavailableException(
        'No se pudo completar la operación. Reintentá.',
      );
    }
  }
  throw new ConflictException('Reintentá la operación.');
}
