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

/* ────────────────────────────────────────────────────────────────────────
 * C6 — MESSAGE-IDEA GOVERNANCE
 * Blueprint Section 6 (structured record), Section 7 (four-disposition state
 * model), Section 17 contract: govern(situational_trigger) -> {disposition, record}.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The four explicit C6 dispositions (Blueprint Section 7). This is a
 * four-state model, NOT pass/fail. A non-PUBLISH disposition must never be
 * silently downgraded to a lower-intensity one to preserve cadence.
 */
export const Disposition = {
  /** Proceed downstream (to C2). */
  PUBLISH: 'PUBLISH',
  /** Logged with rationale; loop exits; no substitute generated. */
  REJECT_AND_RECORD: 'REJECT_AND_RECORD',
  /** Situational read likely wrong; requires a corrected C6 pass before re-entry. */
  REROUTE_FOR_RECLASSIFICATION: 'REROUTE_FOR_RECLASSIFICATION',
  /** Genuine ambiguity; loop pauses; never silently proceeds or rejects. */
  HOLD_FOR_HUMAN_REVIEW: 'HOLD_FOR_HUMAN_REVIEW',
} as const;

export type Disposition = (typeof Disposition)[keyof typeof Disposition];

/** Runtime type guard for {@link Disposition}. */
export function isDisposition(value: unknown): value is Disposition {
  return (
    value === Disposition.PUBLISH ||
    value === Disposition.REJECT_AND_RECORD ||
    value === Disposition.REROUTE_FOR_RECLASSIFICATION ||
    value === Disposition.HOLD_FOR_HUMAN_REVIEW
  );
}

/** Is this a non-PUBLISH disposition (i.e. the loop does not proceed to C2)? */
export function isNonPublish(disposition: Disposition): boolean {
  return disposition !== Disposition.PUBLISH;
}

/**
 * Is this one of the two "high-intensity" dispositions that must never be
 * auto-downgraded to preserve cadence (Blueprint Section 7 binding constraint)?
 */
export function isProtectedDisposition(disposition: Disposition): boolean {
  return (
    disposition === Disposition.REJECT_AND_RECORD ||
    disposition === Disposition.HOLD_FOR_HUMAN_REVIEW
  );
}

/** Confidence in the situational read (Blueprint Section 6 confidence tag). */
export const ConfidenceTag = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  AMBIGUOUS: 'ambiguous',
} as const;

export type ConfidenceTag = (typeof ConfidenceTag)[keyof typeof ConfidenceTag];

/** Sensitivity/stakes of acting on the trigger. */
export const Stakes = {
  LOW: 'low',
  HIGH: 'high',
} as const;

export type Stakes = (typeof Stakes)[keyof typeof Stakes];

/**
 * An optional explicit reviewer directive attached to a trigger. When present
 * it is authoritative for the corresponding disposition (a human decision the
 * gate must honor, never override).
 */
export const ReviewerDirective = {
  REJECT: 'reject',
  HOLD: 'hold',
} as const;

export type ReviewerDirective = (typeof ReviewerDirective)[keyof typeof ReviewerDirective];

/**
 * Raw situational trigger — the input to C6.govern().
 *
 * Only `condition` is required; every other signal is optional and has a
 * documented, conservative default (see decideDisposition). The two descriptive
 * fields carry the actual content the governed message is allowed to acknowledge
 * and must not presume (Blueprint Section 6 — these are text, not flags).
 */
export interface SituationalTrigger {
  /** Raw situational description (required). */
  condition: string;
  /** Confidence in the situational read. Default: 'medium'. */
  confidence_tag?: ConfidenceTag;
  /** Tone register the message would adopt. */
  register?: string;
  /** Strength of the situational shift ('none' | 'slight' | 'strong', free-form). */
  shift_strength?: string;
  /** Whether the situational read belongs in this bank/category. Default: true. */
  belongs_here?: boolean;
  /** Whether it is appropriate to act on this trigger at all. Default: true. */
  appropriate?: boolean;
  /** Sensitivity of acting. Default: 'low'. */
  stakes?: Stakes;
  /** Authoritative human directive, if any. Honored over derived signals. */
  reviewer_directive?: ReviewerDirective | null;
  /** Descriptive phrases the message is explicitly allowed to acknowledge. */
  allowed_to_acknowledge?: string[];
  /** Descriptive phrases the message must NOT presume. */
  must_not_presume?: string[];
}

/**
 * The structured governance record C6 produces for every trigger (Blueprint
 * Section 6 / Section 14 GovernanceRecord schema). Persisted and historically
 * queryable per tenant.
 */
export interface GovernanceRecordData {
  id?: string;
  tenant_id: string;
  condition: string;
  confidence_tag: string | null;
  register: string | null;
  shift_strength: string | null;
  /** Descriptive text (never null once governed). */
  allowed_to_acknowledge: string | null;
  /** Descriptive text (never null once governed). */
  must_not_presume: string | null;
  belongs_here: boolean;
  disposition: Disposition;
  created_at?: Date;
}

/**
 * Result of C6.govern().
 * Blueprint Section 17: govern(situational_trigger) -> {disposition, record}.
 */
export interface GovernResult {
  disposition: Disposition;
  record: GovernanceRecordData;
}

/* ────────────────────────────────────────────────────────────────────────
 * C2 — SITUATIONAL BANK
 * Blueprint Section 11 (Zilly taxonomy), Section 5A (seed-before-select
 * prerequisite), Section 19 acceptance test (selection by real-time condition
 * signal only — NO date/calendar selection path).
 * Contract (Section 17): select_category(condition_signal, tenant_config)
 *   -> { category_id, available_assets[] }.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A real-time situational condition signal — the input to C2.selectCategory().
 *
 * IMPORTANT (Section 19): selection is driven ONLY by the situational read carried
 * here. There is deliberately NO date, time, weekday, or calendar field on this
 * type, and the gate must never resolve a category from wall-clock information.
 * Even the "Friday" category is chosen because an upstream signal reports the
 * Friday *situation*, never because the engine inspected the calendar.
 */
export interface ConditionSignal {
  /** Explicit target category id (already resolved upstream), if known. */
  category_id?: string;
  /**
   * Situational label to resolve against the tenant's category names
   * (case-insensitive). Used when an explicit category_id is not supplied.
   */
  situation?: string;
}

/**
 * A situational category as configured for a tenant (Blueprint Section 11 /
 * Section 14 CategorySchema).
 */
export interface CategoryRecordData {
  tenant_id: string;
  category_id: string;
  name: string;
  /** Protected categories must never be silently downgraded/substituted. */
  protected_flag: boolean;
  /** Whether the category is pre-stocked with content. */
  prestocked_flag: boolean;
  /** Asset ids available in this category (may be empty by design, e.g. Adversity). */
  asset_list: string[];
  created_at?: Date;
}

/**
 * Result of C2.selectCategory().
 * Blueprint Section 17: -> { category_id, available_assets[] }. Extra fields
 * surface protection/pre-stock status and a human-readable reason so downstream
 * gates never have to re-derive them (and never silently downgrade a protected
 * category).
 */
export interface SelectCategoryResult {
  /** The resolved category id, or null when no category matched the signal. */
  category_id: string | null;
  /** Asset ids available in the resolved category (empty when none / no match). */
  available_assets: string[];
  /** Whether a category was resolved from the signal. */
  matched: boolean;
  /** Whether the resolved category is protected (never to be downgraded). */
  protected: boolean;
  /** Whether the resolved category is pre-stocked. */
  prestocked: boolean;
  /** Human-readable explanation (always populated). */
  reason: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * C3 — REPETITION GOVERNOR
 * Enforces max_count within a rolling_window, counted per deployment instance
 * (regardless of category). Blueprint locked params: max_count=3,
 * rolling_window=30 days, counting_unit=per deployment instance.
 * Contract (Section 17): check_repetition(asset_id, tenant_params)
 *   -> { allowed, current_count, window_remaining }.
 * Fails CLOSED on any usage-log integrity issue.
 * ──────────────────────────────────────────────────────────────────────── */

/** The counting unit for repetition. Locked to per-deployment-instance. */
export const CountingUnit = {
  /** Every deployment instance of the asset counts, regardless of category. */
  PER_DEPLOYMENT_INSTANCE: 'per_deployment_instance',
} as const;

export type CountingUnit = (typeof CountingUnit)[keyof typeof CountingUnit];

/** Blueprint-locked C3 parameters (the defaults applied when omitted). */
export const C3_LOCKED_PARAMS = {
  max_count: 3,
  rolling_window_days: 30,
  counting_unit: CountingUnit.PER_DEPLOYMENT_INSTANCE,
} as const;

/**
 * Tenant parameters for C3.checkRepetition() (the `tenant_params` contract arg).
 * `tenant_id` scopes the usage log. The numeric params default to the blueprint
 * locked values; `now` is injectable purely so the rolling window is testable
 * (it defaults to the real wall clock — unlike C2, C3 legitimately uses time).
 */
export interface RepetitionParams {
  tenant_id: string;
  /** Max deployments permitted within the window. Default: 3. */
  max_count?: number;
  /** Rolling window length in days. Default: 30. */
  rolling_window_days?: number;
  /** Injectable "now" for deterministic tests. Default: new Date(). */
  now?: Date;
}

/**
 * Result of C3.checkRepetition().
 * Blueprint Section 17: -> { allowed, current_count, window_remaining }.
 */
export interface RepetitionResult {
  /** Whether one more deployment is permitted (current_count < max_count). */
  allowed: boolean;
  /** Number of in-window deployment instances counted for this asset. */
  current_count: number;
  /**
   * Milliseconds the caller must wait before a deployment would be allowed
   * again. 0 when already allowed; when blocked, the time until enough of the
   * oldest in-window deployments age out of the window to drop below max_count.
   */
  window_remaining_ms: number;
  /** Whether the gate failed closed due to a usage-log integrity issue. */
  failed_closed: boolean;
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

/* ────────────────────────────────────────────────────────────────────────
 * C4 — CAPTION-FIRST RESOLUTION
 * Blueprint Section 20 step 6. Contract (Section 17):
 *   resolve(category_id, content_need) -> { resolved, asset_id, caption }
 *                                        OR { escalate: true }.
 *
 * Philosophy: prefer reusing existing content over creating new content. The
 * gate walks a STRICT, never-skipped 3-step ladder and stops at the first step
 * that yields a usable asset:
 *   1. existing-as-is  — an asset already in the category whose current caption
 *                        already satisfies the need.
 *   2. recaption       — an asset in the category is reusable, but its caption
 *                        must be replaced with the needed caption.
 *   3. escalate to C5  — no reusable asset exists in the category.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The three ordered C4 resolution steps. A resolution NEVER skips a step: the
 * recaption step is only reached when no existing-as-is match exists, and
 * escalation is only reached when neither of the first two steps can produce an
 * asset.
 */
export const C4ResolutionStep = {
  /** An existing asset's current caption already satisfies the need. */
  EXISTING_AS_IS: 'existing_as_is',
  /** An existing asset is reused with a newly-applied caption. */
  RECAPTION: 'recaption',
  /** No reusable asset in the category — hand off to C5 (Misalignment Protocol). */
  ESCALATE_TO_C5: 'escalate_to_c5',
} as const;

export type C4ResolutionStep =
  (typeof C4ResolutionStep)[keyof typeof C4ResolutionStep];

/**
 * The content need C4 must satisfy within a category.
 *
 * `caption` is the caption the deployment requires; it drives both the
 * existing-as-is match (does any asset already carry this caption?) and the
 * recaption step (apply this caption to a reusable asset).
 */
export interface ContentNeed {
  /** The caption text the deployment needs (required, non-empty). */
  caption: string;
  /**
   * Optional tag restriction (e.g. only resolve against canonical assets).
   * When omitted, assets of any tag in the category are eligible.
   */
  required_tag?: AssetTag;
  /**
   * Optional asset ids to exclude from resolution — e.g. assets an upstream
   * gate (such as C3) has already ruled out for this deployment.
   */
  exclude_asset_ids?: string[];
}

/** Successful C4 resolution (steps 1–2). */
export interface ResolveResolved {
  resolved: true;
  escalate: false;
  /** The asset selected for the deployment. */
  asset_id: string;
  /**
   * The caption to deploy with. For `existing_as_is` this is the asset's own
   * current caption; for `recaption` this is the needed caption.
   */
  caption: string;
  /** Which step produced the resolution (never `escalate_to_c5` here). */
  resolution_step: 'existing_as_is' | 'recaption';
  /** Human-readable explanation (always populated). */
  reason: string;
}

/** Escalated C4 result (step 3) — control passes to C5. */
export interface ResolveEscalated {
  resolved: false;
  escalate: true;
  asset_id: null;
  caption: null;
  resolution_step: 'escalate_to_c5';
  /** Human-readable explanation (always populated). */
  reason: string;
}

/**
 * Result of C4.resolve(). A discriminated union on `resolved`/`escalate`. The
 * blueprint's two shapes ({resolved, asset_id, caption} OR {escalate:true}) are
 * both present as a superset with `resolution_step` + `reason` for observability.
 */
export type ResolveResult = ResolveResolved | ResolveEscalated;
