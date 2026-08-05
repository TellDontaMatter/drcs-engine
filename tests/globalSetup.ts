/**
 * Jest global setup — provisions an isolated SQLite database for the test run so
 * no external DB is required. Uses an ABSOLUTE `file:` path to avoid Prisma's
 * relative-path resolution ambiguity, then applies the schema with a clean reset.
 */
import { execSync } from 'child_process';
import path from 'path';

export default async function globalSetup(): Promise<void> {
  const dbPath = path.join(__dirname, '..', 'prisma', 'test.db');
  process.env.DATABASE_URL = `file:${dbPath}`;

  // Generate the client (idempotent) and push the schema into a fresh test DB.
  execSync('npx prisma generate', { stdio: 'inherit', env: { ...process.env } });
  execSync('npx prisma db push --force-reset --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env },
  });
}
