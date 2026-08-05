/**
 * DRCS ORCHESTRATOR — the "engine" that turns the individual gates into one
 * usable pipeline (Blueprint Section 20: "one engine, eight configurable
 * components"; Section 2 loop order).
 *
 * A gate on its own only returns a decision; nobody acts on it. The orchestrator
 * is what a human (or an upstream system) actually calls to run a real content
 * request end-to-end. It runs the gates in the blueprint's binding order,
 * SHORT-CIRCUITS on the first gate that stops the request, ENFORCES each gate's
 * decision (a REJECT/HOLD/escalation/cap-hit ends the request — no silent
 * downgrade), and returns ONE structured verdict plus a gate-by-gate audit trail.
 *
 * Order (Blueprint Section 2 loop):
 *   1. C6  govern(trigger)                     — is this idea allowed to run at all?
 *   2. C2  selectCategory(condition_signal)    — which situational bank?
 *   3. C4  resolve(category, content_need)      — reuse existing content (caption-first)
 *   4. C3  checkRepetition(asset)               — under the rolling frequency cap?
 *   → PUBLISH: optionally persist the recaption and log the deployment instance.
 *
 * C5 (Misalignment Protocol) is not yet implemented; a C4 escalation therefore
 * stops the pipeline with outcome ESCALATED_TO_C5 rather than proceeding.
 *
 * `evaluate()` is the single public entry point. It is deployment-agnostic:
 * behavior is entirely driven by the per-tenant configuration the gates load.
 */
import {
  SituationalTrigger,
  ConditionSignal,
  ContentNeed,
  Disposition,
} from '../types';
import { govern } from '../gates/c6';
import { selectCategory } from '../gates/c2';
import { resolve } from '../gates/c4';
import { checkRepetition } from '../gates/c3';
import * as usageLog from '../persistence/repositories/usageLog';
import * as assetRegistry from '../persistence/repositories/assetRegistry';

/** The gates the orchestrator runs, in order. */
export type GateId = 'C6' | 'C2' | 'C4' | 'C3';

/** Terminal outcome of a full evaluation. */
export const EvaluationOutcome = {
  /** All gates passed; content is cleared to deploy (and was logged if committed). */
  PUBLISHED: 'PUBLISHED',
  /** C6 rejected the idea (logged, no substitute). */
  GOVERNANCE_REJECTED: 'GOVERNANCE_REJECTED',
  /** C6 held the idea for human review. */
  GOVERNANCE_HELD: 'GOVERNANCE_HELD',
  /** C6 rerouted for reclassification. */
  GOVERNANCE_REROUTED: 'GOVERNANCE_REROUTED',
  /** C2 could not resolve a category from the signal. */
  NO_CATEGORY: 'NO_CATEGORY',
  /** C4 found no reusable asset — would hand off to C5 (not yet implemented). */
  ESCALATED_TO_C5: 'ESCALATED_TO_C5',
  /** C3 rolling-window cap reached for the resolved asset. */
  REPETITION_BLOCKED: 'REPETITION_BLOCKED',
  /** C3 failed closed on a usage-log integrity issue. */
  REPETITION_FAILED_CLOSED: 'REPETITION_FAILED_CLOSED',
} as const;

export type EvaluationOutcome =
  (typeof EvaluationOutcome)[keyof typeof EvaluationOutcome];

/** One entry in the gate-by-gate audit trail. */
export interface TrailEntry {
  gate: GateId;
  /** Human-readable gate name. */
  name: string;
  /** Did the request pass this gate and continue? */
  passed: boolean;
  /** One-line human-readable summary of what the gate decided. */
  summary: string;
  /** The raw gate result, for inspection/debugging. */
  data: unknown;
}

/** Input to {@link evaluate}. */
export interface EvaluationRequest {
  /** C6 input — the situational trigger (only `condition` is required). */
  trigger: SituationalTrigger;
  /** C2 input — the real-time situational signal (category_id or situation). */
  condition_signal: ConditionSignal;
  /** C4 input — the caption the deployment needs (+ optional filters). */
  content_need: ContentNeed;
  /**
   * Optional C3 overrides. Blueprint values are locked by default (max_count=3,
   * rolling_window_days=30); overrides exist mainly for testing.
   */
  repetition?: {
    max_count?: number;
    rolling_window_days?: number;
  };
  /**
   * Injectable "now" — flows to C3's rolling window and to the deployment log
   * timestamp so a full run is deterministic in tests.
   */
  now?: Date;
  /**
   * Whether to COMMIT side effects on PUBLISH: persist a C4 recaption and append
   * the deployment instance to the usage log (which C3 counts). Default: true.
   * Set false for a dry-run preview that changes nothing.
   */
  commit?: boolean;
  /** Optional free-form context stored on the deployment log row. */
  deployment_context?: string;
}

/** The single structured verdict returned by {@link evaluate}. */
export interface EvaluationVerdict {
  tenant_id: string;
  /** Top-level decision: did the request clear every gate? */
  decision: 'PUBLISH' | 'BLOCKED';
  /** Specific terminal outcome. */
  outcome: EvaluationOutcome;
  /** The gate that stopped the request, or null when it published. */
  stopped_at_gate: GateId | null;
  /** The resolved asset (present once C4 resolves). */
  asset_id: string | null;
  /** The caption to deploy with (present once C4 resolves). */
  caption: string | null;
  /** Which C4 step resolved it, if reached. */
  resolution_step: string | null;
  /** The C6 governance record id (always present — every request is governed). */
  governance_record_id: string | null;
  /** Whether side effects were committed (recaption persisted + deployment logged). */
  committed: boolean;
  /** The deployment-log row id, when a deployment was logged. */
  deployment_id: string | null;
  /** Human-readable one-line verdict. */
  reason: string;
  /** Gate-by-gate audit trail, in execution order. */
  trail: TrailEntry[];
}

const GATE_NAMES: Record<GateId, string> = {
  C6: 'Message-Idea Governance',
  C2: 'Situational Bank',
  C4: 'Caption-First Resolution',
  C3: 'Repetition Governor',
};

/**
 * Run a content request through the full DRCS gate pipeline for a tenant.
 *
 * @param request The situational trigger + signal + content need.
 * @param tenant_id Tenant identifier (scopes every gate).
 * @returns One verdict with a gate-by-gate audit trail.
 */
export async function evaluate(
  request: EvaluationRequest,
  tenant_id: string,
): Promise<EvaluationVerdict> {
  const trail: TrailEntry[] = [];
  const commit = request.commit ?? true;

  const base: Omit<
    EvaluationVerdict,
    'decision' | 'outcome' | 'stopped_at_gate' | 'reason'
  > = {
    tenant_id,
    asset_id: null,
    caption: null,
    resolution_step: null,
    governance_record_id: null,
    committed: false,
    deployment_id: null,
    trail,
  };

  // ── GATE 1: C6 — Message-Idea Governance ────────────────────────────────
  const governResult = await govern(request.trigger, tenant_id);
  base.governance_record_id = governResult.record.id ?? null;
  const c6Passed = governResult.disposition === Disposition.PUBLISH;
  trail.push({
    gate: 'C6',
    name: GATE_NAMES.C6,
    passed: c6Passed,
    summary: `Disposition: ${governResult.disposition}`,
    data: governResult,
  });

  if (!c6Passed) {
    const outcome =
      governResult.disposition === Disposition.REJECT_AND_RECORD
        ? EvaluationOutcome.GOVERNANCE_REJECTED
        : governResult.disposition === Disposition.HOLD_FOR_HUMAN_REVIEW
          ? EvaluationOutcome.GOVERNANCE_HELD
          : EvaluationOutcome.GOVERNANCE_REROUTED;
    return {
      ...base,
      decision: 'BLOCKED',
      outcome,
      stopped_at_gate: 'C6',
      reason: `C6 governance returned ${governResult.disposition}; the request does not proceed.`,
    };
  }

  // ── GATE 2: C2 — Situational Bank ───────────────────────────────────────
  const categoryResult = await selectCategory(request.condition_signal, tenant_id);
  trail.push({
    gate: 'C2',
    name: GATE_NAMES.C2,
    passed: categoryResult.matched,
    summary: categoryResult.matched
      ? `Category "${categoryResult.category_id}" (${categoryResult.available_assets.length} asset(s))`
      : 'No category matched the signal',
    data: categoryResult,
  });

  if (!categoryResult.matched || categoryResult.category_id == null) {
    return {
      ...base,
      decision: 'BLOCKED',
      outcome: EvaluationOutcome.NO_CATEGORY,
      stopped_at_gate: 'C2',
      reason: categoryResult.reason,
    };
  }

  // ── GATE 3: C4 — Caption-First Resolution ───────────────────────────────
  const resolveResult = await resolve(
    categoryResult.category_id,
    request.content_need,
    tenant_id,
  );
  trail.push({
    gate: 'C4',
    name: GATE_NAMES.C4,
    passed: resolveResult.resolved,
    summary: resolveResult.resolved
      ? `Resolved asset "${resolveResult.asset_id}" via ${resolveResult.resolution_step}`
      : 'No reusable asset — escalate to C5',
    data: resolveResult,
  });

  if (!resolveResult.resolved) {
    return {
      ...base,
      decision: 'BLOCKED',
      outcome: EvaluationOutcome.ESCALATED_TO_C5,
      stopped_at_gate: 'C4',
      reason: resolveResult.reason,
    };
  }

  base.asset_id = resolveResult.asset_id;
  base.caption = resolveResult.caption;
  base.resolution_step = resolveResult.resolution_step;

  // ── GATE 4: C3 — Repetition Governor ────────────────────────────────────
  const repetitionResult = await checkRepetition(resolveResult.asset_id, {
    tenant_id,
    max_count: request.repetition?.max_count,
    rolling_window_days: request.repetition?.rolling_window_days,
    now: request.now,
  });
  trail.push({
    gate: 'C3',
    name: GATE_NAMES.C3,
    passed: repetitionResult.allowed,
    summary: repetitionResult.failed_closed
      ? `Failed closed: ${repetitionResult.reason}`
      : `count ${repetitionResult.current_count} — ${repetitionResult.allowed ? 'under cap' : 'cap reached'}`,
    data: repetitionResult,
  });

  if (!repetitionResult.allowed) {
    return {
      ...base,
      decision: 'BLOCKED',
      outcome: repetitionResult.failed_closed
        ? EvaluationOutcome.REPETITION_FAILED_CLOSED
        : EvaluationOutcome.REPETITION_BLOCKED,
      stopped_at_gate: 'C3',
      reason: repetitionResult.reason,
    };
  }

  // ── PUBLISH: all gates cleared. Commit side effects unless dry-run. ──────
  if (commit) {
    // Persist a C4 recaption so future runs see the new caption (existing-as-is
    // reuse writes nothing).
    if (resolveResult.resolution_step === 'recaption') {
      await assetRegistry.updateCaption(
        tenant_id,
        resolveResult.asset_id,
        resolveResult.caption,
      );
    }
    // Append the deployment instance that C3 will count next time.
    const logged = await usageLog.logDeployment({
      tenant_id,
      asset_id: resolveResult.asset_id,
      deployed_at: request.now,
      deployment_context: request.deployment_context ?? null,
    });
    base.committed = true;
    base.deployment_id = logged.id;
  }

  return {
    ...base,
    decision: 'PUBLISH',
    outcome: EvaluationOutcome.PUBLISHED,
    stopped_at_gate: null,
    reason: base.committed
      ? `Cleared all gates. Asset "${resolveResult.asset_id}" deployed (logged) with caption "${resolveResult.caption}".`
      : `Cleared all gates (dry-run). Asset "${resolveResult.asset_id}" would deploy with caption "${resolveResult.caption}".`,
  };
}
