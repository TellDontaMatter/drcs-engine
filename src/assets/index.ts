/**
 * CONTENT RETRIEVAL LAYER.
 *
 * The gates decide WHICH asset and WHAT caption; this layer answers "where is
 * the actual media file?". It maps an asset (by id, or by category) to its
 * `file_path` in the Asset Registry so the orchestrator can hand back something
 * a human can actually post — not just a decision.
 *
 * `file_path` is nullable by design: the canonical Zilly clips are registered
 * before any real media file is attached. When it is null the caller still gets
 * the asset record (caption included) and degrades gracefully rather than
 * failing — a missing file is a "not yet uploaded" state, not an error.
 *
 * Every function is tenant-scoped (tenant_id is required and never crosses
 * tenants — it is part of the Asset Registry composite key).
 */
import * as assetRegistry from '../persistence/repositories/assetRegistry';
import * as categorySchema from '../persistence/repositories/categorySchema';

/** A resolved asset's retrievable content. */
export interface ResolvedAsset {
  asset_id: string;
  file_path: string | null;
  caption: string | null;
}

/**
 * Resolve a specific asset to its media file + current caption.
 *
 * @param tenant_id Tenant identifier.
 * @param asset_id Asset identifier.
 * @returns The asset's file_path + caption, or null if the asset does not exist.
 */
export async function resolveAsset(
  tenant_id: string,
  asset_id: string,
): Promise<{ file_path: string | null; caption: string | null } | null> {
  const asset = await assetRegistry.getAsset(tenant_id, asset_id);
  if (!asset) return null;
  return { file_path: asset.file_path, caption: asset.caption };
}

/**
 * Find the first asset in a category (in the category's declared asset order)
 * and return its id, file path, and caption. Useful after C5 generates a fresh
 * caption for a category so the caller can still pair it with a real clip.
 *
 * @param tenant_id Tenant identifier.
 * @param category Category id.
 * @returns The first matching asset (file_path may be null), or null if the
 *   category is unknown or empty.
 */
export async function findAssetByCategory(
  tenant_id: string,
  category: string,
): Promise<ResolvedAsset | null> {
  const schema = await categorySchema.getCategory(tenant_id, category);
  if (!schema || schema.asset_list.length === 0) return null;

  // Walk the declared order; return the first id that actually resolves to a
  // registered asset (an id present in the list but missing from the registry
  // is skipped rather than treated as a hard failure).
  for (const asset_id of schema.asset_list) {
    const asset = await assetRegistry.getAsset(tenant_id, asset_id);
    if (asset) {
      return {
        asset_id: asset.asset_id,
        file_path: asset.file_path,
        caption: asset.caption,
      };
    }
  }
  return null;
}
