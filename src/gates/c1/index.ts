/**
 * C1 — SOURCE OF TRUTH LOCK (Blueprint Section: "C1 — Source of Truth Lock",
 * Section 19 acceptance tests, Section 20 step 1).
 *
 * Responsibilities:
 *  - Validate new assets against an immutable canonical reference set (never against
 *    the most recent derivative). Three-tag taxonomy: canonical / derivative_edit /
 *    derivative_new.
 *  - A derivative asset can NEVER validate as canonical under any claim.
 *  - Auto-reject any asset whose lineage traces back to a quarantined source
 *    (per-tenant configurable quarantine list).
 *  - Periodic canonical-integrity audit; on corruption, freeze the gate for the
 *    tenant until a human clears it. While frozen, validate() blocks all calls.
 *
 * Every function is tenant-scoped and pure w.r.t. its inputs + the tenant's stored
 * state (no hidden module-level mutable state, no hardcoded tenant/asset ids).
 */
import { AssetTag, isAssetTag, isDerivativeTag, ValidateResult, AuditResult, AuditFinding } from '../../types';
import * as assetRegistry from '../../persistence/repositories/assetRegistry';
import * as tenantConfig from '../../persistence/repositories/tenantConfig';
import * as gateState from '../../persistence/repositories/gateState';
import type { AssetRecord } from '../../persistence/repositories/assetRegistry';

/** Identifier used for this gate in the GateState table. */
export const GATE_ID = 'C1' as const;

/** Message returned by validate() for every call while the gate is frozen. */
export const FROZEN_REASON = 'C1 frozen pending human review';

/** Guard against pathological / cyclic parent chains. */
const MAX_PARENT_DEPTH = 256;

/**
 * Trace an asset's parent lineage looking for a quarantined source.
 *
 * Quarantined sources (e.g. CapyCardioRef, Drive files 002–009) are intentionally
 * NOT registered as assets, so a match may occur on a `parent_asset_id` that has no
 * registry row. Any hit — direct or transitive — means the asset is derived from a
 * quarantined source and must be rejected, regardless of the claimed tag.
 *
 * @param start The asset whose lineage is being traced.
 * @param tenant_id Tenant identifier (scopes all registry lookups).
 * @param quarantineList Source ids that are quarantined for this tenant.
 * @returns The quarantined ancestor id if found, otherwise null.
 */
async function findQuarantinedAncestor(
  start: AssetRecord,
  tenant_id: string,
  quarantineList: readonly string[],
): Promise<string | null> {
  const quarantined = new Set(quarantineList);
  const visited = new Set<string>();
  let current: AssetRecord | null = start;
  let depth = 0;

  while (current && current.parent_asset_id && depth < MAX_PARENT_DEPTH) {
    const parentId: string = current.parent_asset_id;

    if (quarantined.has(parentId)) {
      return parentId;
    }
    if (visited.has(parentId)) {
      // Cycle — stop tracing.
      break;
    }
    visited.add(parentId);

    // The parent may be a quarantined (unregistered) source; if so we already
    // returned above. Otherwise attempt to continue up the chain.
    current = await assetRegistry.getAsset(tenant_id, parentId);
    depth += 1;
  }
  return null;
}

/**
 * Validate a claim about an asset against the tenant's source-of-truth registry.
 *
 * Blueprint contract: validate(asset_id, claimed_tag) -> { valid, tag, reason }.
 * Order of enforcement:
 *   1. If the gate is frozen for the tenant -> block with {@link FROZEN_REASON}.
 *   2. Reject an unknown claimed tag.
 *   3. The asset must be registered for the tenant (source of truth).
 *   4. Quarantine: reject if lineage traces to a quarantined source (even for
 *      derivative_edit / derivative_new claims).
 *   5. Canonical lock: a derivative (by authoritative tag OR by having a parent)
 *      can never validate as canonical.
 *   6. The claimed tag must match the authoritative registry tag.
 *
 * @param asset_id Asset identifier to validate.
 * @param claimed_tag The tag the caller claims for the asset.
 * @param tenant_id Tenant identifier (scopes all data access).
 */
export async function validate(
  asset_id: string,
  claimed_tag: AssetTag,
  tenant_id: string,
): Promise<ValidateResult> {
  // 1. Freeze check — blocks ALL calls while frozen.
  const state = await gateState.getGateState(tenant_id, GATE_ID);
  if (state.frozen) {
    return { valid: false, tag: null, reason: FROZEN_REASON };
  }

  // 2. Input guard.
  if (!isAssetTag(claimed_tag)) {
    return { valid: false, tag: null, reason: `Unknown claimed tag "${String(claimed_tag)}"` };
  }

  // 3. Source of truth: the asset must exist in this tenant's registry.
  const asset = await assetRegistry.getAsset(tenant_id, asset_id);
  if (!asset) {
    return {
      valid: false,
      tag: null,
      reason: `Asset "${asset_id}" is not registered for tenant "${tenant_id}"`,
    };
  }

  // 4. Quarantine enforcement (independent of the claimed tag).
  const quarantineList = await tenantConfig.getQuarantineList(tenant_id);
  const quarantinedAncestor = await findQuarantinedAncestor(asset, tenant_id, quarantineList);
  if (quarantinedAncestor) {
    return {
      valid: false,
      tag: null,
      reason:
        `Asset "${asset_id}" is auto-rejected: it derives from quarantined source ` +
        `"${quarantinedAncestor}", which is quarantined for tenant "${tenant_id}" pending human review`,
    };
  }

  // 5. Canonical lock — a derivative can NEVER validate as canonical.
  if (claimed_tag === AssetTag.CANONICAL) {
    if (isDerivativeTag(asset.tag)) {
      return {
        valid: false,
        tag: asset.tag,
        reason:
          `Canonical lock: asset "${asset_id}" is registered as "${asset.tag}" and ` +
          `can never validate as canonical`,
      };
    }
    if (asset.parent_asset_id) {
      return {
        valid: false,
        tag: asset.tag,
        reason:
          `Canonical lock: asset "${asset_id}" has parent "${asset.parent_asset_id}" ` +
          `(derivative lineage) and can never validate as canonical`,
      };
    }
  }

  // 6. The claim must match the source-of-truth tag.
  if (claimed_tag !== asset.tag) {
    return {
      valid: false,
      tag: asset.tag,
      reason:
        `Claimed tag "${claimed_tag}" does not match source-of-truth tag ` +
        `"${asset.tag}" for asset "${asset_id}"`,
    };
  }

  return {
    valid: true,
    tag: asset.tag,
    reason: `Asset "${asset_id}" validated as "${asset.tag}"`,
  };
}

/**
 * Scan every canonical asset for a tenant and report integrity anomalies.
 *
 * Flags:
 *  - "modified": recorded `content_hash` differs from the sealed `sealed_hash`.
 *  - "canonical_has_parent": a canonical asset has a parent (canonical assets must
 *    have no derivative lineage).
 *  - "broken_parent_chain": a referenced parent cannot be resolved consistently.
 *
 * When any finding is present the gate is FROZEN for the tenant (Blueprint failure
 * behavior: freeze C1-dependent gates until human-confirmed correction).
 *
 * @param tenant_id Tenant identifier (scopes the scan).
 */
export async function auditCanonicalIntegrity(tenant_id: string): Promise<AuditResult> {
  const canonicals = await assetRegistry.listAssets(tenant_id, AssetTag.CANONICAL);
  const findings: AuditFinding[] = [];

  for (const asset of canonicals) {
    if (
      asset.sealed_hash !== null &&
      asset.content_hash !== null &&
      asset.sealed_hash !== asset.content_hash
    ) {
      findings.push({
        asset_id: asset.asset_id,
        issue: 'modified',
        detail: `content_hash "${asset.content_hash}" != sealed_hash "${asset.sealed_hash}"`,
      });
    }

    if (asset.parent_asset_id) {
      findings.push({
        asset_id: asset.asset_id,
        issue: 'canonical_has_parent',
        detail: `canonical asset must have no parent, found "${asset.parent_asset_id}"`,
      });

      const parent = await assetRegistry.getAsset(tenant_id, asset.parent_asset_id);
      if (!parent) {
        findings.push({
          asset_id: asset.asset_id,
          issue: 'broken_parent_chain',
          detail: `parent "${asset.parent_asset_id}" is not resolvable in the registry`,
        });
      }
    }
  }

  const ok = findings.length === 0;
  if (!ok) {
    await gateState.freezeGate(
      tenant_id,
      GATE_ID,
      `Canonical integrity audit found ${findings.length} issue(s)`,
    );
  }

  return {
    tenant_id,
    ok,
    scanned: canonicals.length,
    findings,
    frozen: !ok,
  };
}

/**
 * Report whether C1 is currently frozen for a tenant.
 * @param tenant_id Tenant identifier.
 */
export async function isFrozen(tenant_id: string): Promise<boolean> {
  const state = await gateState.getGateState(tenant_id, GATE_ID);
  return state.frozen;
}

/**
 * Clear a C1 freeze after a human has confirmed the correction.
 * @param tenant_id Tenant identifier.
 */
export async function clearFreeze(tenant_id: string): Promise<void> {
  await gateState.unfreezeGate(tenant_id, GATE_ID);
}
