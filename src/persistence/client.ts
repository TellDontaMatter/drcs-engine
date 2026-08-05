/**
 * Prisma client singleton for the DRCS persistence layer (Blueprint Section 14 / 20 step 2).
 *
 * A single PrismaClient instance is shared process-wide to avoid exhausting DB
 * connections. The datasource (SQLite locally, PostgreSQL in production) is chosen
 * via the `DATABASE_URL` environment variable and the `provider` in schema.prisma.
 */
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __drcsPrisma: PrismaClient | undefined;
}

/** The shared PrismaClient instance. */
export const prisma: PrismaClient =
  global.__drcsPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__drcsPrisma = prisma;
}

export type { PrismaClient };
