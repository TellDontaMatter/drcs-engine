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
  CaptionSource,
} from '../types';
import { govern } from '../gates/c6';
import { selectCategory } from '../gates/c2';
import { resolve } from '../gates/c4';
import { checkRepetition } from '../gates/c3';
import { generate as generateC5 } from '../gates/c5';
import * as usageLog from '../persistence/repositories/usageLog';
import * as assetRegistry from '../persistence/repositories/assetRegistry';
import * as assets from '../assets';
import * as llm from '../llm';

/** The gates the orchestrator runs, in order. */
export type GateId = 'C6' | 'C2' | 'C4' | 'C5' | 'C3';

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
  /**
   * C4 found no reusable asset and C5 generated a fresh caption instead
   * (published; paired with a category asset/file when one exists).
   */
  GENERATED: 'GENERATED',
  /** C4 escalated but C5 could not generate (e.g. the LLM was unreachable). */
  ESCALATE_FAILED: 'ESCALATE_FAILED',
  /**
   * C4 found no reusable asset and handed off to C5. Retained for backward
   * compatibility; the pipeline now proceeds to C5 rather than stopping here.
   */
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
   * The kind of content requested (e.g. "clip", "image", "post"). Passed to C5
   * if C4 escalates. Default: "post".
   */
  content_type?: string;
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
  /** The caption to deploy with (present once C4 resolves or C5 generates). */
  caption: string | null;
  /** Path/URL to the underlying media file, when known (may be null). */
  file_path: string | null;
  /** Where the final caption came from: AS_IS / RECAPTIONED (C4) or GENERATED (C5). */
  source: CaptionSource | null;
  /** C5's recommendation of the clip/image to pair with a generated caption. */
  asset_recommendation: string | null;
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
  C5: 'Misalignment Protocol',
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
    file_path: null,
    source: null,
    asset_recommendation: null,
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

  // Resolved-so-far state that BOTH the C4 happy path and the C5 generation
  // path feed into, so C3 + PUBLISH are written once for either source.
  let resolvedAssetId: string | null = null;
  let finalCaption: string | null = null;
  let isRecaption = false;
  let generated = false;

  if (resolveResult.resolved) {
    // C4 produced a reusable asset (existing-as-is or recaption).
    resolvedAssetId = resolveResult.asset_id;
    finalCaption = resolveResult.caption;
    isRecaption = resolveResult.resolution_step === 'recaption';
    base.asset_id = resolveResult.asset_id;
    base.caption = resolveResult.caption;
    base.resolution_step = resolveResult.resolution_step;
    base.source = isRecaption ? CaptionSource.RECAPTIONED : CaptionSource.AS_IS;
    // Attach the media file for the resolved asset (may be null — not uploaded yet).
    const retrieved = await assets.resolveAsset(tenant_id, resolveResult.asset_id);
    base.file_path = retrieved?.file_path ?? null;
  } else {
    // ── GATE 3b: C5 — Misalignment Protocol (generate fresh content) ────────
    // C4 found nothing to reuse; rather than stop, C5 generates a new caption.
    const c5 = await generateC5({
      tenant_id,
      situation: request.trigger.condition,
      category: categoryResult.category_id,
      content_type: request.content_type ?? 'post',
    });
    trail.push({
      gate: 'C5',
      name: GATE_NAMES.C5,
      passed: c5.action === 'GENERATED',
      summary:
        c5.action === 'GENERATED'
          ? `Generated a fresh caption — recommends: ${c5.asset_recommendation}`
          : `Generation failed: ${c5.reason}`,
      data: c5,
    });

    if (c5.action !== 'GENERATED') {
      return {
        ...base,
        decision: 'BLOCKED',
        outcome: EvaluationOutcome.ESCALATE_FAILED,
        stopped_at_gate: 'C5',
        reason: c5.reason,
      };
    }

    generated = true;
    finalCaption = c5.caption;
    base.caption = c5.caption;
    base.source = CaptionSource.GENERATED;
    base.resolution_step = 'generated';
    base.asset_recommendation = c5.asset_recommendation;

    // Pair the generated caption with a real category asset/file, if one exists.
    // When the category has no assets yet, the generated caption is returned on
    // its own (asset_id + file_path stay null) — the caller handles gracefully.
    const paired = await assets.findAssetByCategory(tenant_id, categoryResult.category_id);
    if (paired) {
      resolvedAssetId = paired.asset_id;
      base.asset_id = paired.asset_id;
      base.file_path = paired.file_path;
    }
  }

  // ── GATE 4: C3 — Repetition Governor ────────────────────────────────────
  // Only counts when an actual asset is involved. A purely-generated caption
  // with no paired asset has nothing to rate-limit, so C3 is skipped.
  if (resolvedAssetId != null) {
    const repetitionResult = await checkRepetition(resolvedAssetId, {
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
  }

  // ── PUBLISH: all gates cleared. Commit side effects unless dry-run. ──────
  if (commit) {
    // Persist a C4 recaption so future runs see the new caption (existing-as-is
    // reuse and C5 generation write nothing back to the registry here).
    if (isRecaption && resolvedAssetId != null && finalCaption != null) {
      await assetRegistry.updateCaption(tenant_id, resolvedAssetId, finalCaption);
    }
    // Append the deployment instance that C3 will count next time (only when a
    // real asset backs the deployment).
    if (resolvedAssetId != null) {
      const logged = await usageLog.logDeployment({
        tenant_id,
        asset_id: resolvedAssetId,
        deployed_at: request.now,
        deployment_context: request.deployment_context ?? null,
      });
      base.committed = true;
      base.deployment_id = logged.id;
    }
  }

  const outcome = generated
    ? EvaluationOutcome.GENERATED
    : EvaluationOutcome.PUBLISHED;
  const assetLabel = resolvedAssetId ?? '(no paired asset yet)';
  const genPrefix = generated ? 'C5 generated a fresh caption. ' : '';
  return {
    ...base,
    decision: 'PUBLISH',
    outcome,
    stopped_at_gate: null,
    reason: base.committed
      ? `${genPrefix}Cleared all gates. Asset "${assetLabel}" deployed (logged) with caption "${finalCaption}".`
      : `${genPrefix}Cleared all gates${commit ? '' : ' (dry-run)'}. Asset "${assetLabel}" ${
          commit ? 'ready' : 'would deploy'
        } with caption "${finalCaption}".`,
  };
}


/**
 * Extract the two structured fields the engine needs — `situation` and
 * `content_type` — from a free-form idea, using the LLM. Kept exported so the
 * mapping is testable and observable.
 *
 * Degrades gracefully: if the LLM is unreachable or returns nothing usable, the
 * raw prompt becomes the situation and `content_type` defaults to "post" — the
 * pipeline still runs (C5 can generate from the raw idea).
 *
 * @param prompt A free-form content idea.
 * @returns `{ situation, content_type }`.
 */
export async function extractPromptFields(
  prompt: string,
): Promise<{ situation: string; content_type: string }> {
  const trimmed = prompt.trim();
  const fallback = { situation: trimmed, content_type: 'post' };
  if (trimmed.length === 0) return fallback;

  let raw: string;
  try {
    raw = await llm.callLLM(
      `A user gave this free-form content idea: "${trimmed}".\n` +
        `Extract two things:\n` +
        `1. "situation": a one-sentence description of the situation/moment behind the idea.\n` +
        `2. "content_type": the kind of content wanted — one short word like "clip", "image", "video", or "post".\n\n` +
        `Respond ONLY with a compact JSON object of the exact shape ` +
        `{"situation": string, "content_type": string} and nothing else.`,
      {
        system:
          'You extract structured fields from a content idea and always answer ' +
          'with the exact JSON object requested.',
        temperature: 0.2,
      },
    );
  } catch {
    return fallback;
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const situation =
      typeof obj.situation === 'string' && obj.situation.trim().length > 0
        ? obj.situation.trim()
        : trimmed;
    const content_type =
      typeof obj.content_type === 'string' && obj.content_type.trim().length > 0
        ? obj.content_type.trim()
        : 'post';
    return { situation, content_type };
  } catch {
    return fallback;
  }
}

/**
 * SIMPLIFIED INPUT LAYER — turn one free-form idea into a full evaluation.
 *
 * This is the "make content out of any idea" entry point: the caller supplies a
 * tenant and a single prompt; the orchestrator uses the LLM to derive the
 * structured fields the gates need (situation + content type), then runs the
 * exact same {@link evaluate} pipeline (C6 → C2 → C4 → C5 → C3). The derived
 * situation drives C6 (governance) and C2 (category), and doubles as the C4
 * caption need so a matching clip is reused when one exists — otherwise C5
 * generates a fresh caption for the idea.
 *
 * @param tenant_id Tenant identifier (scopes every gate).
 * @param prompt A free-form content idea.
 * @returns The same {@link EvaluationVerdict} as {@link evaluate}.
 */
export async function evaluatePrompt(
  tenant_id: string,
  prompt: string,
): Promise<EvaluationVerdict> {
  const { situation, content_type } = await extractPromptFields(prompt);

  const request: EvaluationRequest = {
    trigger: { condition: situation },
    condition_signal: { situation },
    content_need: { caption: situation },
    content_type,
    deployment_context: 'simplified prompt input',
  };
  return evaluate(request, tenant_id);
}
