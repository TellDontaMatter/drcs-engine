/**
 * C5 — MISALIGNMENT PROTOCOL (Blueprint Section 20 step 7).
 *
 * C5 fires ONLY when C4 escalates: no asset already in the category could
 * satisfy the need, either as-is or by recaptioning. The blueprint's caption-
 * first philosophy prefers reusing existing content, but when there is nothing
 * to reuse the request must not simply die — C5 GENERATES fresh content.
 *
 * What it produces:
 *   - a brand-new caption tailored to the situation + resolved category, and
 *   - a short recommendation describing the clip/image that would pair with it.
 *
 * How it produces it: a single LLM call (via the shared `src/llm` module, so
 * tests mock it by spying on `llm.callLLM`). We ask the model to return a small
 * JSON object; we parse it defensively and, if JSON parsing fails, fall back to
 * treating the whole reply as the caption. If the LLM cannot be reached at all,
 * C5 returns ESCALATE_FAILED rather than inventing a silent fallback — a failure
 * is surfaced explicitly to the caller.
 *
 * Contract: generate({ tenant_id, situation, category, content_type })
 *   -> { action: 'GENERATED', caption, asset_recommendation }
 *   OR { action: 'ESCALATE_FAILED', reason }.
 */
import { C5Request, C5Result } from '../../types';
import * as llm from '../../llm';

/** Identifier used for this gate. */
export const GATE_ID = 'C5' as const;

/**
 * Build the generation prompt. Kept pure and exported so it is unit-testable and
 * so the exact instruction the model sees is inspectable.
 */
export function buildPrompt(request: C5Request): string {
  return (
    `You are a social media content writer for tenant "${request.tenant_id}". ` +
    `The content category is "${request.category}". ` +
    `The situation is: ${request.situation}. ` +
    `The desired content type is "${request.content_type}". ` +
    `Write a short, punchy social media caption (max 3 sentences) that fits this situation, ` +
    `and briefly describe the kind of ${request.content_type} that would pair well with it.\n\n` +
    `Respond ONLY with a compact JSON object of the exact shape ` +
    `{"caption": string, "asset_recommendation": string} and nothing else.`
  );
}

/**
 * Parse the model's reply into { caption, asset_recommendation }. Defensive:
 * accepts a bare JSON object, JSON embedded in prose/code fences, or — as a last
 * resort — treats the whole reply as the caption with a generic recommendation.
 */
export function parseGeneration(raw: string): {
  caption: string;
  asset_recommendation: string;
} {
  const fallbackRec = 'A clip or image that visually matches the situation.';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const caption =
        typeof obj.caption === 'string' && obj.caption.trim().length > 0
          ? obj.caption.trim()
          : '';
      const rec =
        typeof obj.asset_recommendation === 'string' &&
        obj.asset_recommendation.trim().length > 0
          ? obj.asset_recommendation.trim()
          : fallbackRec;
      if (caption) return { caption, asset_recommendation: rec };
    } catch {
      // fall through to plain-text handling
    }
  }
  // No usable JSON — treat the whole reply as the caption.
  return { caption: raw.trim(), asset_recommendation: fallbackRec };
}

/**
 * Generate fresh content for an escalated request.
 *
 * @param request Situation + resolved category + content type + tenant.
 * @returns GENERATED (with caption + asset recommendation) or ESCALATE_FAILED.
 */
export async function generate(request: C5Request): Promise<C5Result> {
  if (!request.situation || request.situation.trim().length === 0) {
    return {
      action: 'ESCALATE_FAILED',
      reason: 'C5: cannot generate — the situation is empty.',
    };
  }

  let raw: string;
  try {
    raw = await llm.callLLM(buildPrompt(request), {
      system:
        'You are a concise, on-brand social media copywriter. ' +
        'You always answer with the exact JSON object requested.',
      temperature: 0.5,
    });
  } catch (err) {
    return {
      action: 'ESCALATE_FAILED',
      reason: `C5: content generation failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const { caption, asset_recommendation } = parseGeneration(raw);
  if (!caption) {
    return {
      action: 'ESCALATE_FAILED',
      reason: 'C5: the model returned no usable caption.',
    };
  }

  return { action: 'GENERATED', caption, asset_recommendation };
}
