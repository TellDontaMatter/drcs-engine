/**
 * Per-worker test setup. Ensures the Prisma client points at the isolated test
 * SQLite DB (same absolute path as globalSetup) and clears all tables between
 * tests so each test is independent and tenant-isolation assertions are clean.
 */
import path from 'path';

// Point at the test DB BEFORE the Prisma client is constructed.
const dbPath = path.join(__dirname, '..', 'prisma', 'test.db');
process.env.DATABASE_URL = `file:${dbPath}`;

// Require (not import) so the env assignment above happens first.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/persistence/client');

afterEach(async () => {
  await prisma.assetRegistry.deleteMany();
  await prisma.gateState.deleteMany();
  await prisma.tenantConfig.deleteMany();
  await prisma.proposalApprovalLog.deleteMany();
  await prisma.usageLog.deleteMany();
  await prisma.governanceRecord.deleteMany();
  await prisma.categorySchema.deleteMany();
  await prisma.agentConfiguration.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});
