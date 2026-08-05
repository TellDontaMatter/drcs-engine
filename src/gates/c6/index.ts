/**
 * C6 — MESSAGE-IDEA GOVERNANCE (Blueprint Section 6 record model, Section 7
 * disposition state model, Section 20 step 3).
 *
 * C6 runs FIRST, upstream of all selection. It takes a raw situational trigger
 * and produces both a structured governance record AND one of four explicit
 * dispositions (Section 7):
 *
 *   PUBLISH                        → proceed downstream (to C2)
 *   REJECT_AND_RECORD              → logged with rationale, loop exits, no substitute
 *   REROUTE_FOR_RECLASSIFICATION   → situational read likely wrong, corrected pass needed
 *   HOLD_FOR_HUMAN_REVIEW          → genuine ambiguity, loop pauses
 *
 * BINDING CONSTRAINT (Section 7): the gate must NEVER automatically downgrade a
 * REJECT/HOLD to a lower-intensity disposition to preserve cadence. Silence is an
 * acceptable outcome. This is enforced structurally: decideDisposition() returns
 * exactly one disposition via short-circuit precedence, and there is no branch
 * anywhere that re-maps a protected disposition to PUBLISH/REROUTE.
 *
 * Contract (Section 17): govern(situational_trigger) -> {disposition, record}.
 *
 * The decision function is pure and exported so all four dispositions are
 * independently unit-testable (Section 19: "All four C6 dispositions reachable").
 * govern() has no dependency on C2–C5; it depends only on its own record schema.
 */
import {
  ConfidenceTag,
  Disposition,
  GovernResult,
  ReviewerDirective,
  SituationalTrigger,
  Stakes,
} from '../../types';
import * as governanceRecord from '../../persistence/repositories/governanceRecord';

/** Identifier used for this gate. */
export const GATE_ID = 'C6' as const;

/** Conservative defaults for optional trigger signals. */
const DEFAULTS = {
  confidence_tag: ConfidenceTag.MEDIUM as ConfidenceTag,
  belongs_here: true,
  appropriate: true,
  stakes: Stakes.LOW as Stakes,
} as const;

/**
 * Decide the single disposition for a trigger (pure — no I/O).
 *
 * Precedence is deliberate and short-circuiting so a higher-intensity outcome is
 * never overridden by a lower-intensity one:
 *
 *   1. REJECT_AND_RECORD           — explicit reject directive, or inappropriate to act
 *   2. HOLD_FOR_HUMAN_REVIEW       — explicit hold directive, ambiguous read, or
 *                                    high-stakes + low-confidence (genuine uncertainty)
 *   3. REROUTE_FOR_RECLASSIFICATION— read does not belong in this category
 *   4. PUBLISH                     — governance passed
 *
 * Steps 1–2 (the protected dispositions) are evaluated before 3–4 and return
 * immediately, so cadence pressure can never turn a reject/hold into a publish.
 *
 * @param trigger Raw situational trigger.
 */
export function decideDisposition(trigger: SituationalTrigger): Disposition {
  const confidence = trigger.confidence_tag ?? DEFAULTS.confidence_tag;
  const belongsHere = trigger.belongs_here ?? DEFAULTS.belongs_here;
  const appropriate = trigger.appropriate ?? DEFAULTS.appropriate;
  const stakes = trigger.stakes ?? DEFAULTS.stakes;
  const directive = trigger.reviewer_directive ?? null;

  // 1. Definite "no" — explicit human reject, or content deemed inappropriate.
  if (directive === ReviewerDirective.REJECT || appropriate === false) {
    return Disposition.REJECT_AND_RECORD;
  }

  // 2. Genuine uncertainty — pause for a human. Never silently resolved.
  if (
    directive === ReviewerDirective.HOLD ||
    confidence === ConfidenceTag.AMBIGUOUS ||
    (stakes === Stakes.HIGH && confidence === ConfidenceTag.LOW)
  ) {
    return Disposition.HOLD_FOR_HUMAN_REVIEW;
  }

  // 3. Misclassification — the situational read likely landed in the wrong place.
  if (belongsHere === false) {
    return Disposition.REROUTE_FOR_RECLASSIFICATION;
  }

  // 4. Governance passed.
  return Disposition.PUBLISH;
}

/**
 * Compose the descriptive "allowed to acknowledge" text (Blueprint Section 6 —
 * this is content, not a flag). Always returns non-empty text so the persisted
 * field is never null.
 * @param phrases Optional descriptive phrases.
 */
export function composeAllowedToAcknowledge(phrases?: string[]): string {
  const clean = (phrases ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if (clean.length === 0) {
    return 'Nothing specific is authorized to be acknowledged for this condition.';
  }
  return clean.join('; ');
}

/**
 * Compose the descriptive "must not presume" text (Blueprint Section 6 — content,
 * not a flag). Always returns non-empty text so the persisted field is never null.
 * @param phrases Optional descriptive phrases.
 */
export function composeMustNotPresume(phrases?: string[]): string {
  const clean = (phrases ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if (clean.length === 0) {
    return 'No presumptions have been flagged as forbidden for this condition.';
  }
  return clean.join('; ');
}

/**
 * Govern a situational trigger: decide its disposition and persist the structured
 * governance record. Runs first in the loop, upstream of all selection.
 *
 * A record is written for EVERY trigger regardless of disposition (Section 6:
 * disposition AND record), making governance decisions historically queryable
 * per tenant (Section 14). The returned `record` echoes exactly what was stored.
 *
 * @param trigger Raw situational trigger (only `condition` is required).
 * @param tenant_id Tenant identifier (scopes the persisted record).
 */
export async function govern(
  trigger: SituationalTrigger,
  tenant_id: string,
): Promise<GovernResult> {
  const disposition = decideDisposition(trigger);

  const allowed = composeAllowedToAcknowledge(trigger.allowed_to_acknowledge);
  const mustNot = composeMustNotPresume(trigger.must_not_presume);
  const belongsHere = trigger.belongs_here ?? DEFAULTS.belongs_here;

  const record = await governanceRecord.createRecord({
    tenant_id,
    condition: trigger.condition,
    confidence_tag: trigger.confidence_tag ?? null,
    register: trigger.register ?? null,
    shift_strength: trigger.shift_strength ?? null,
    allowed_to_acknowledge: allowed,
    must_not_presume: mustNot,
    belongs_here: belongsHere,
    disposition,
  });

  return { disposition, record };
}
