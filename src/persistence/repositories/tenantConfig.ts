/**
 * TenantConfig repository (Blueprint Section 20 step 2 — tenant-scoped configuration).
 *
 * Holds per-tenant configuration, including the C1 quarantine list. The quarantine
 * list is configuration, never hardcoded in gate logic.
 */
import { prisma } from '../client';

export interface TenantConfigData {
  tenant_id: string;
  name: string;
  quarantine_list: string[];
  created_at: Date;
}

/** Parse the JSON-encoded `quarantine_list` column into a string[]. */
function toStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/**
 * Create or replace a tenant's configuration.
 * @param tenant_id Tenant identifier (scopes all data).
 * @param name Human-readable tenant name.
 * @param quarantine_list Source ids that C1 must reject derivation from.
 */
export async function upsertTenantConfig(
  tenant_id: string,
  name: string,
  quarantine_list: string[],
): Promise<TenantConfigData> {
  const serialized = JSON.stringify(quarantine_list);
  const row = await prisma.tenantConfig.upsert({
    where: { tenant_id },
    create: { tenant_id, name, quarantine_list: serialized },
    update: { name, quarantine_list: serialized },
  });
  return {
    tenant_id: row.tenant_id,
    name: row.name,
    quarantine_list: toStringArray(row.quarantine_list),
    created_at: row.created_at,
  };
}

/**
 * Fetch a tenant's configuration, or null if the tenant does not exist.
 * @param tenant_id Tenant identifier.
 */
export async function getTenantConfig(
  tenant_id: string,
): Promise<TenantConfigData | null> {
  const row = await prisma.tenantConfig.findUnique({ where: { tenant_id } });
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    name: row.name,
    quarantine_list: toStringArray(row.quarantine_list),
    created_at: row.created_at,
  };
}

/**
 * Fetch a tenant's quarantine list. Returns an empty array if the tenant has none.
 * @param tenant_id Tenant identifier.
 */
export async function getQuarantineList(tenant_id: string): Promise<string[]> {
  const cfg = await getTenantConfig(tenant_id);
  return cfg?.quarantine_list ?? [];
}
