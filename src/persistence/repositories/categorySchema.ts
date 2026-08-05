/**
 * CategorySchema repository (Blueprint Section 14 — used by C2).
 *
 * Holds the per-tenant situational taxonomy (Blueprint Section 11). Every
 * operation is tenant-scoped: `tenant_id` is part of the composite primary key,
 * so category ids are unique per tenant and no query can return another tenant's
 * rows.
 *
 * `asset_list` is stored as a JSON-encoded string (identical schema for SQLite in
 * dev/test and PostgreSQL in production) and parsed to string[] here.
 */
import { prisma } from '../client';
import { CategoryRecordData } from '../../types';

export interface UpsertCategoryInput {
  tenant_id: string;
  category_id: string;
  name: string;
  protected_flag?: boolean;
  prestocked_flag?: boolean;
  asset_list?: string[];
}

/** Parse the JSON-encoded `asset_list` column into a string[]. */
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

function rowToRecord(row: {
  tenant_id: string;
  category_id: string;
  name: string;
  protected_flag: boolean;
  prestocked_flag: boolean;
  asset_list: unknown;
  created_at: Date;
}): CategoryRecordData {
  return {
    tenant_id: row.tenant_id,
    category_id: row.category_id,
    name: row.name,
    protected_flag: row.protected_flag,
    prestocked_flag: row.prestocked_flag,
    asset_list: toStringArray(row.asset_list),
    created_at: row.created_at,
  };
}

/**
 * Create or replace a category for a tenant.
 * @param input Category fields.
 */
export async function upsertCategory(
  input: UpsertCategoryInput,
): Promise<CategoryRecordData> {
  const asset_list = JSON.stringify(input.asset_list ?? []);
  const row = await prisma.categorySchema.upsert({
    where: {
      tenant_id_category_id: {
        tenant_id: input.tenant_id,
        category_id: input.category_id,
      },
    },
    create: {
      tenant_id: input.tenant_id,
      category_id: input.category_id,
      name: input.name,
      protected_flag: input.protected_flag ?? false,
      prestocked_flag: input.prestocked_flag ?? false,
      asset_list,
    },
    update: {
      name: input.name,
      protected_flag: input.protected_flag ?? false,
      prestocked_flag: input.prestocked_flag ?? false,
      asset_list,
    },
  });
  return rowToRecord(row);
}

/**
 * Fetch one category by id within a tenant, or null if absent.
 * @param tenant_id Tenant identifier.
 * @param category_id Category identifier.
 */
export async function getCategory(
  tenant_id: string,
  category_id: string,
): Promise<CategoryRecordData | null> {
  const row = await prisma.categorySchema.findUnique({
    where: { tenant_id_category_id: { tenant_id, category_id } },
  });
  return row ? rowToRecord(row) : null;
}

/**
 * Find a category by its (case-insensitive) name within a tenant, or null.
 * Name matching is done in-process so behavior is identical across SQLite and
 * PostgreSQL (SQLite `mode: 'insensitive'` is not supported).
 * @param tenant_id Tenant identifier.
 * @param name Category name to match.
 */
export async function getCategoryByName(
  tenant_id: string,
  name: string,
): Promise<CategoryRecordData | null> {
  const target = name.trim().toLowerCase();
  const rows = await prisma.categorySchema.findMany({ where: { tenant_id } });
  const match = rows.find((r) => r.name.trim().toLowerCase() === target);
  return match ? rowToRecord(match) : null;
}

/**
 * List all categories for a tenant (alphabetical by name).
 * @param tenant_id Tenant identifier.
 */
export async function listCategories(
  tenant_id: string,
): Promise<CategoryRecordData[]> {
  const rows = await prisma.categorySchema.findMany({
    where: { tenant_id },
    orderBy: { name: 'asc' },
  });
  return rows.map(rowToRecord);
}

/**
 * Count categories for a tenant. Used to check the Section 5A prerequisite
 * (taxonomy must be seeded before selection can function).
 * @param tenant_id Tenant identifier.
 */
export async function countCategories(tenant_id: string): Promise<number> {
  return prisma.categorySchema.count({ where: { tenant_id } });
}
