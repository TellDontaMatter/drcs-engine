/**
 * UsageLog repository (Blueprint Section 14 — used by C3).
 *
 * Records every deployment INSTANCE of an asset (Blueprint C3 counting_unit =
 * "per deployment instance, regardless of category"). C3 reads this log to count
 * in-window deployments; each row is one deployment.
 *
 * All operations are tenant-scoped. `deployed_at` is the authoritative timestamp
 * for rolling-window math; the repository exposes it in ascending order so the
 * gate can reason about the oldest in-window instances.
 */
import { prisma } from '../client';

export interface UsageLogRecord {
  id: string;
  tenant_id: string;
  asset_id: string;
  deployed_at: Date;
  deployment_context: string | null;
}

export interface LogDeploymentInput {
  tenant_id: string;
  asset_id: string;
  /** Defaults to now() at the DB layer when omitted. Injectable for tests. */
  deployed_at?: Date;
  deployment_context?: string | null;
}

/**
 * Record a single deployment instance.
 * @param input Deployment fields.
 */
export async function logDeployment(
  input: LogDeploymentInput,
): Promise<UsageLogRecord> {
  const row = await prisma.usageLog.create({
    data: {
      tenant_id: input.tenant_id,
      asset_id: input.asset_id,
      ...(input.deployed_at ? { deployed_at: input.deployed_at } : {}),
      deployment_context: input.deployment_context ?? null,
    },
  });
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    asset_id: row.asset_id,
    deployed_at: row.deployed_at,
    deployment_context: row.deployment_context,
  };
}

/**
 * List every deployment instance of an asset for a tenant at or after `since`,
 * ordered oldest-first. Used by C3 to count in-window deployments and to find the
 * oldest ones for window-remaining math.
 *
 * Counting is per deployment instance regardless of category — this query
 * intentionally does NOT filter on category.
 *
 * @param tenant_id Tenant identifier.
 * @param asset_id Asset identifier.
 * @param since Lower bound (inclusive) for `deployed_at`.
 */
export async function listDeploymentsSince(
  tenant_id: string,
  asset_id: string,
  since: Date,
): Promise<UsageLogRecord[]> {
  const rows = await prisma.usageLog.findMany({
    where: { tenant_id, asset_id, deployed_at: { gte: since } },
    orderBy: { deployed_at: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    asset_id: row.asset_id,
    deployed_at: row.deployed_at,
    deployment_context: row.deployment_context,
  }));
}

/**
 * List all deployment instances of an asset for a tenant (oldest-first),
 * unbounded by time. Used for integrity checks (e.g. detecting rows with an
 * invalid timestamp) independent of the window.
 * @param tenant_id Tenant identifier.
 * @param asset_id Asset identifier.
 */
export async function listAllDeployments(
  tenant_id: string,
  asset_id: string,
): Promise<UsageLogRecord[]> {
  const rows = await prisma.usageLog.findMany({
    where: { tenant_id, asset_id },
    orderBy: { deployed_at: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    asset_id: row.asset_id,
    deployed_at: row.deployed_at,
    deployment_context: row.deployment_context,
  }));
}
