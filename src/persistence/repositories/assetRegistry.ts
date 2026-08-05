/**
 * AssetRegistry repository (Blueprint Section 14 — used by C1, C2, C4, C5).
 *
 * All operations are tenant-scoped: `tenant_id` is required on every call and is
 * part of the composite primary key, so asset ids are unique per tenant and no
 * query can return another tenant's rows.
 */
import { prisma } from '../client';
import { AssetTag } from '../../types';

export interface AssetRecord {
  tenant_id: string;
  asset_id: string;
  tag: AssetTag;
  category: string | null;
  parent_asset_id: string | null;
  content_hash: string | null;
  sealed_hash: string | null;
  created_at: Date;
}

export interface CreateAssetInput {
  tenant_id: string;
  asset_id: string;
  tag: AssetTag;
  category?: string | null;
  parent_asset_id?: string | null;
  content_hash?: string | null;
  /** Recorded content hash captured at lock time; defaults to content_hash. */
  sealed_hash?: string | null;
}

/** Cast the stored string tag back to the strict AssetTag union. */
function rowToRecord(row: {
  tenant_id: string;
  asset_id: string;
  tag: string;
  category: string | null;
  parent_asset_id: string | null;
  content_hash: string | null;
  sealed_hash: string | null;
  created_at: Date;
}): AssetRecord {
  return { ...row, tag: row.tag as AssetTag };
}

/**
 * Register (create) an asset for a tenant.
 * @param input Asset fields; `sealed_hash` defaults to `content_hash` when omitted.
 */
export async function createAsset(input: CreateAssetInput): Promise<AssetRecord> {
  const row = await prisma.assetRegistry.create({
    data: {
      tenant_id: input.tenant_id,
      asset_id: input.asset_id,
      tag: input.tag,
      category: input.category ?? null,
      parent_asset_id: input.parent_asset_id ?? null,
      content_hash: input.content_hash ?? null,
      sealed_hash: input.sealed_hash ?? input.content_hash ?? null,
    },
  });
  return rowToRecord(row);
}

/**
 * Fetch one asset by id within a tenant, or null if absent.
 * @param tenant_id Tenant identifier.
 * @param asset_id Asset identifier.
 */
export async function getAsset(
  tenant_id: string,
  asset_id: string,
): Promise<AssetRecord | null> {
  const row = await prisma.assetRegistry.findUnique({
    where: { tenant_id_asset_id: { tenant_id, asset_id } },
  });
  return row ? rowToRecord(row) : null;
}

/**
 * List all assets for a tenant, optionally filtered by tag.
 * @param tenant_id Tenant identifier.
 * @param tag Optional tag filter.
 */
export async function listAssets(
  tenant_id: string,
  tag?: AssetTag,
): Promise<AssetRecord[]> {
  const rows = await prisma.assetRegistry.findMany({
    where: tag ? { tenant_id, tag } : { tenant_id },
    orderBy: { asset_id: 'asc' },
  });
  return rows.map(rowToRecord);
}
