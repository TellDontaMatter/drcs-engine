/**
 * Shared DRCS domain types.
 *
 * Blueprint references:
 *  - C1 three-tag taxonomy (canonical / derivative_edit / derivative_new)
 *  - Gate contract: validate(asset_id, claimed_tag) -> { valid, tag, reason }
 */

/**
 * The three-tag asset taxonomy defined by C1 (Source of Truth Lock).
 * Modeled as a const object + union type so it is both a runtime value and a
 * strict compile-time type under `strict` mode.
 */
export const AssetTag = {
  CANONICAL: 'canonical',
  DERIVATIVE_EDIT: 'derivative_edit',
  DERIVATIVE_NEW: 'derivative_new',
} as const;

export type AssetTag = (typeof AssetTag)[keyof typeof AssetTag];

/** Runtime type guard for {@link AssetTag}. */
export function isAssetTag(value: unknown): value is AssetTag {
  return (
    value === AssetTag.CANONICAL ||
    value === AssetTag.DERIVATIVE_EDIT ||
    value === AssetTag.DERIVATIVE_NEW
  );
}

/** Convenience: is this tag a derivative (edit or new)? */
export function isDerivativeTag(tag: AssetTag): boolean {
  return tag === AssetTag.DERIVATIVE_EDIT || tag === AssetTag.DERIVATIVE_NEW;
}

/**
 * Result of C1.validate().
 * Blueprint: validate(asset_id, claimed_tag) -> { valid, tag, reason }.
 */
export interface ValidateResult {
  /** Whether the claim is accepted. */
  valid: boolean;
  /** The authoritative tag for the asset, or null when validation fails. */
  tag: AssetTag | null;
  /** Human-readable explanation (always populated). */
  reason: string;
}

/** A single anomaly discovered by the canonical integrity audit. */
export interface AuditFinding {
  asset_id: string;
  /** Machine-readable code, e.g. "modified" | "canonical_has_parent" | "broken_parent_chain". */
  issue: string;
  detail: string;
}

/**
 * Result of C1.auditCanonicalIntegrity().
 * When `ok` is false the gate is frozen for the tenant pending human review.
 */
export interface AuditResult {
  tenant_id: string;
  ok: boolean;
  scanned: number;
  findings: AuditFinding[];
  frozen: boolean;
}
