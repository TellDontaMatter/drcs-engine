/**
 * C4 — CAPTION-FIRST RESOLUTION (Blueprint Section 20 step 6).
 *
 * Given a category and a content need, C4 decides how to satisfy that need by
 * walking a STRICT, never-skipped 3-step ladder and stopping at the first step
 * that yields a usable asset:
 *
 *   1. existing-as-is — an asset already in the category whose CURRENT caption
 *                       already satisfies the need. Reuse it verbatim.
 *   2. recaption      — an asset in the category is reusable, but its caption
 *                       must be replaced with the needed caption. Reuse the
 *                       asset, apply the new caption.
 *   3. escalate to C5 — no reusable asset exists in the category. Hand off to
 *                       the Misalignment Protocol (C5).
 *
 * "Caption-first" = prefer changing words over creating new content: a recaption
 * is always preferred to an escalation, and an as-is reuse is always preferred to
 * a recaption. The gate NEVER skips a step — recaption is only considered after
 * the as-is scan finds nothing, and escalation is only returned after both prior
 * steps produce nothing.
 *
 * Contract (Section 17): resolve(category_id, content_need)
 *   -> { resolved, asset_id, caption } OR { escalate: true }.
 *
 * `tenant_id` is threaded as the standard tenant-isolation argument (identical to
 * C2.selectCategory(signal, tenant_id)); the blueprint's two-argument contract is
 * about the resolution inputs, and every gate in this engine is tenant-scoped.
 */
import {
  ContentNeed,
  ResolveResult,
  C4ResolutionStep,
} from '../../types';
import * as assetRegistry from '../../persistence/repositories/assetRegistry';
import * as categorySchema from '../../persistence/repositories/categorySchema';
import type { AssetRecord } from '../../persistence/repositories/assetRegistry';

/** Identifier used for this gate. */
export const GATE_ID = 'C4' as const;

/** Raised when the target category does not exist for the tenant. */
export class CategoryNotFoundError extends Error {
  constructor(tenant_id: string, category_id: string) {
    super(
      `C4: category "${category_id}" is not configured for tenant "${tenant_id}".`,
    );
    this.name = 'CategoryNotFoundError';
  }
}

/** Raised when the content need does not carry a usable caption. */
export class InvalidContentNeedError extends Error {
  constructor(detail: string) {
    super(`C4: invalid content need — ${detail}`);
    this.name = 'InvalidContentNeedError';
  }
}

/**
 * Normalize a caption for equality comparison: trim, lowercase, and collapse
 * internal whitespace. Two captions that differ only in casing/spacing are
 * treated as the same caption for the existing-as-is step.
 */
function normalizeCaption(caption: string): string {
  return caption.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve a content need within a category using caption-first resolution.
 *
 * @param category_id Target category (already resolved upstream, e.g. by C2).
 * @param content_need The caption the deployment needs (+ optional filters).
 * @param tenant_id Tenant identifier (tenant-isolation argument).
 * @returns A resolution (existing-as-is or recaption) or an escalation to C5.
 * @throws InvalidContentNeedError when `content_need.caption` is empty.
 * @throws CategoryNotFoundError when the category is not configured for the tenant.
 */
export async function resolve(
  category_id: string,
  content_need: ContentNeed,
  tenant_id: string,
): Promise<ResolveResult> {
  const neededCaption = content_need.caption;
  if (typeof neededCaption !== 'string' || neededCaption.trim().length === 0) {
    throw new InvalidContentNeedError('caption is required and must be non-empty.');
  }

  const category = await categorySchema.getCategory(tenant_id, category_id);
  if (!category) {
    throw new CategoryNotFoundError(tenant_id, category_id);
  }

  const excluded = new Set(content_need.exclude_asset_ids ?? []);
  const requiredTag = content_need.required_tag;

  // Load the category's assets from the registry, preserving asset_list order so
  // resolution is deterministic. Skip ids absent from the registry (integrity
  // gaps do not by themselves force an escalation — remaining assets may resolve).
  const eligible: AssetRecord[] = [];
  for (const asset_id of category.asset_list) {
    if (excluded.has(asset_id)) continue;
    const asset = await assetRegistry.getAsset(tenant_id, asset_id);
    if (!asset) continue;
    if (requiredTag && asset.tag !== requiredTag) continue;
    eligible.push(asset);
  }

  const needNorm = normalizeCaption(neededCaption);

  // STEP 1 — existing-as-is: first eligible asset whose current caption already
  // satisfies the need. Reuse verbatim (return the asset's own caption).
  for (const asset of eligible) {
    if (asset.caption != null && normalizeCaption(asset.caption) === needNorm) {
      return {
        resolved: true,
        escalate: false,
        asset_id: asset.asset_id,
        caption: asset.caption,
        resolution_step: C4ResolutionStep.EXISTING_AS_IS,
        reason:
          `Existing asset "${asset.asset_id}" already carries a caption satisfying ` +
          `the need; reused as-is in category "${category_id}".`,
      };
    }
  }

  // STEP 2 — recaption: no as-is match, but an eligible asset exists. Reuse the
  // first eligible asset and apply the needed caption.
  if (eligible.length > 0) {
    const asset = eligible[0];
    return {
      resolved: true,
      escalate: false,
      asset_id: asset.asset_id,
      caption: neededCaption,
      resolution_step: C4ResolutionStep.RECAPTION,
      reason:
        `No existing caption matched; reusing asset "${asset.asset_id}" from ` +
        `category "${category_id}" with the needed caption (recaption).`,
    };
  }

  // STEP 3 — escalate to C5: no reusable asset in the category.
  return {
    resolved: false,
    escalate: true,
    asset_id: null,
    caption: null,
    resolution_step: C4ResolutionStep.ESCALATE_TO_C5,
    reason:
      `No reusable asset available in category "${category_id}" ` +
      `(after applying tag/exclusion filters); escalating to C5.`,
  };
}
