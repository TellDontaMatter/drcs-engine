/**
 * ORCHESTRATOR — end-to-end pipeline tests.
 *
 * Proves the engine (not just the individual gates) works: it runs the gates in
 * blueprint order (C6 → C2 → C4 → C3), SHORT-CIRCUITS at the first gate that
 * stops the request, ENFORCES each decision (no silent downgrade), commits side
 * effects only on PUBLISH, and returns one verdict + a gate-by-gate trail.
 */
import { evaluate, evaluatePrompt, EvaluationOutcome } from '../src/orchestrator';
import * as assetRegistry from '../src/persistence/repositories/assetRegistry';
import * as categorySchema from '../src/persistence/repositories/categorySchema';
import * as usageLog from '../src/persistence/repositories/usageLog';
import * as llm from '../src/llm';
import { AssetTag, ReviewerDirective } from '../src/types';

/**
 * Deterministically stub the LLM so no test makes a real network call. C5 and
 * the prompt-extraction layer both go through `llm.callLLM`.
 */
function mockLLM(response: string): jest.SpyInstance {
  return jest.spyOn(llm, 'callLLM').mockResolvedValue(response);
}

const TENANT = 'zilly';
const OTHER = 'other_tenant';

async function seedAsset(
  tenant_id: string,
  asset_id: string,
  caption: string | null,
  tag: AssetTag = AssetTag.CANONICAL,
): Promise<void> {
  await assetRegistry.createAsset({ tenant_id, asset_id, tag, caption });
}
async function seedCategory(
  tenant_id: string,
  category_id: string,
  asset_list: string[],
): Promise<void> {
  await categorySchema.upsertCategory({
    tenant_id,
    category_id,
    name: category_id,
    prestocked_flag: true,
    asset_list,
  });
}

/** A minimal category so C2 has something to resolve. */
async function seedGentleStart(tenant_id = TENANT): Promise<void> {
  await seedAsset(tenant_id, 'clip_a', 'Ease into it.');
  await seedCategory(tenant_id, 'gentle_start', ['clip_a']);
}

describe('Orchestrator — full pipeline', () => {
  it('PUBLISHES when every gate passes, and logs the deployment', async () => {
    await seedGentleStart();

    const v = await evaluate(
      {
        trigger: { condition: 'gentle morning' },
        condition_signal: { category_id: 'gentle_start' },
        content_need: { caption: 'Ease into it.' },
      },
      TENANT,
    );

    expect(v.decision).toBe('PUBLISH');
    expect(v.outcome).toBe(EvaluationOutcome.PUBLISHED);
    expect(v.stopped_at_gate).toBeNull();
    expect(v.asset_id).toBe('clip_a');
    expect(v.committed).toBe(true);
    expect(v.deployment_id).toBeTruthy();
    // trail ran all four gates, all passed
    expect(v.trail.map((t) => t.gate)).toEqual(['C6', 'C2', 'C4', 'C3']);
    expect(v.trail.every((t) => t.passed)).toBe(true);
    // the deployment was actually appended to the usage log
    const deployments = await usageLog.listAllDeployments(TENANT, 'clip_a');
    expect(deployments.length).toBe(1);
  });

  it('does NOT log a deployment on a dry run (commit=false)', async () => {
    await seedGentleStart();
    const v = await evaluate(
      {
        trigger: { condition: 'gentle morning' },
        condition_signal: { category_id: 'gentle_start' },
        content_need: { caption: 'Ease into it.' },
        commit: false,
      },
      TENANT,
    );
    expect(v.decision).toBe('PUBLISH');
    expect(v.committed).toBe(false);
    const deployments = await usageLog.listAllDeployments(TENANT, 'clip_a');
    expect(deployments.length).toBe(0);
  });

  it('SHORT-CIRCUITS at C6 on a reviewer reject — C2/C4/C3 never run', async () => {
    await seedGentleStart();
    const v = await evaluate(
      {
        trigger: { condition: 'bad idea', reviewer_directive: ReviewerDirective.REJECT },
        condition_signal: { category_id: 'gentle_start' },
        content_need: { caption: 'Ease into it.' },
      },
      TENANT,
    );
    expect(v.decision).toBe('BLOCKED');
    expect(v.outcome).toBe(EvaluationOutcome.GOVERNANCE_REJECTED);
    expect(v.stopped_at_gate).toBe('C6');
    // only C6 ran
    expect(v.trail.map((t) => t.gate)).toEqual(['C6']);
    // nothing was logged
    const deployments = await usageLog.listAllDeployments(TENANT, 'clip_a');
    expect(deployments.length).toBe(0);
  });

  it('HOLDS at C6 on a reviewer hold (protected disposition, no downgrade)', async () => {
    await seedGentleStart();
    const v = await evaluate(
      {
        trigger: { condition: 'ambiguous', reviewer_directive: ReviewerDirective.HOLD },
        condition_signal: { category_id: 'gentle_start' },
        content_need: { caption: 'Ease into it.' },
      },
      TENANT,
    );
    expect(v.decision).toBe('BLOCKED');
    expect(v.outcome).toBe(EvaluationOutcome.GOVERNANCE_HELD);
    expect(v.stopped_at_gate).toBe('C6');
  });

  it('stops at C2 (NO_CATEGORY) when the signal resolves no category', async () => {
    await seedGentleStart();
    const v = await evaluate(
      {
        trigger: { condition: 'gentle morning' },
        condition_signal: { category_id: 'does_not_exist' },
        content_need: { caption: 'Ease into it.' },
      },
      TENANT,
    );
    expect(v.decision).toBe('BLOCKED');
    expect(v.outcome).toBe(EvaluationOutcome.NO_CATEGORY);
    expect(v.stopped_at_gate).toBe('C2');
    expect(v.trail.map((t) => t.gate)).toEqual(['C6', 'C2']);
  });

  it('escalates to C5 at C4 and C5 GENERATES a fresh caption (no reusable asset)', async () => {
    mockLLM(
      JSON.stringify({
        caption: 'Push through — every rep counts.',
        asset_recommendation: 'A gritty training montage clip.',
      }),
    );
    // category exists but is empty
    await seedCategory(TENANT, 'adversity', []);
    const v = await evaluate(
      {
        trigger: { condition: 'tough day' },
        condition_signal: { category_id: 'adversity' },
        content_need: { caption: 'Push through.' },
      },
      TENANT,
    );
    expect(v.decision).toBe('PUBLISH');
    expect(v.outcome).toBe(EvaluationOutcome.GENERATED);
    expect(v.stopped_at_gate).toBeNull();
    expect(v.source).toBe('GENERATED');
    expect(v.caption).toBe('Push through — every rep counts.');
    expect(v.asset_recommendation).toBe('A gritty training montage clip.');
    // no reusable asset in the empty category, so nothing is paired/logged
    expect(v.asset_id).toBeNull();
    expect(v.file_path).toBeNull();
    expect(v.committed).toBe(false);
    // C4 then C5 ran; C3 is skipped (no asset to rate-limit)
    expect(v.trail.map((t) => t.gate)).toEqual(['C6', 'C2', 'C4', 'C5']);
  });

  it('C5 FAILS (ESCALATE_FAILED) and blocks when the LLM is unreachable', async () => {
    jest.spyOn(llm, 'callLLM').mockRejectedValue(new llm.LlmError('network down'));
    await seedCategory(TENANT, 'adversity', []);
    const v = await evaluate(
      {
        trigger: { condition: 'tough day' },
        condition_signal: { category_id: 'adversity' },
        content_need: { caption: 'Push through.' },
      },
      TENANT,
    );
    expect(v.decision).toBe('BLOCKED');
    expect(v.outcome).toBe(EvaluationOutcome.ESCALATE_FAILED);
    expect(v.stopped_at_gate).toBe('C5');
    expect(v.trail.map((t) => t.gate)).toEqual(['C6', 'C2', 'C4', 'C5']);
  });

  it('C5 pairs the generated caption with an existing category asset + file', async () => {
    mockLLM(
      JSON.stringify({
        caption: 'Brand new hype line!',
        asset_recommendation: 'An energetic celebration clip.',
      }),
    );
    // An asset exists in the category but its caption cannot satisfy the need
    // via as-is; C4 would recaption it. To force escalation-to-C5 while still
    // having a pairable asset, require a tag no asset carries so C4 escalates,
    // then C5 pairs by category (which ignores the tag filter).
    await assetRegistry.createAsset({
      tenant_id: TENANT,
      asset_id: 'clip_v',
      tag: AssetTag.DERIVATIVE_NEW,
      caption: 'old victory caption',
      file_path: '/media/zilly/clip_v.mp4',
    });
    await seedCategory(TENANT, 'victory', ['clip_v']);
    const v = await evaluate(
      {
        trigger: { condition: 'huge win' },
        condition_signal: { category_id: 'victory' },
        content_need: { caption: 'We won!', required_tag: AssetTag.CANONICAL },
      },
      TENANT,
    );
    expect(v.outcome).toBe(EvaluationOutcome.GENERATED);
    expect(v.source).toBe('GENERATED');
    expect(v.caption).toBe('Brand new hype line!');
    // C5 paired the generated caption with the real clip + its media file
    expect(v.asset_id).toBe('clip_v');
    expect(v.file_path).toBe('/media/zilly/clip_v.mp4');
    // a real asset backs it, so C3 ran and the deployment was logged
    expect(v.trail.map((t) => t.gate)).toEqual(['C6', 'C2', 'C4', 'C5', 'C3']);
    expect(v.committed).toBe(true);
    const deployments = await usageLog.listAllDeployments(TENANT, 'clip_v');
    expect(deployments.length).toBe(1);
  });

  it('blocks at C3 once the rolling cap (3) is reached', async () => {
    await seedGentleStart();
    // three prior deployments of clip_a
    for (let i = 0; i < 3; i++) {
      await usageLog.logDeployment({ tenant_id: TENANT, asset_id: 'clip_a' });
    }
    const v = await evaluate(
      {
        trigger: { condition: 'gentle morning' },
        condition_signal: { category_id: 'gentle_start' },
        content_need: { caption: 'Ease into it.' },
      },
      TENANT,
    );
    expect(v.decision).toBe('BLOCKED');
    expect(v.outcome).toBe(EvaluationOutcome.REPETITION_BLOCKED);
    expect(v.stopped_at_gate).toBe('C3');
    // resolved asset is still surfaced even though it was blocked
    expect(v.asset_id).toBe('clip_a');
    expect(v.committed).toBe(false);
  });

  it('persists a recaption on PUBLISH so the asset carries the new caption', async () => {
    await seedAsset(TENANT, 'clip_a', 'old caption');
    await seedCategory(TENANT, 'gentle_start', ['clip_a']);
    const v = await evaluate(
      {
        trigger: { condition: 'gentle morning' },
        condition_signal: { category_id: 'gentle_start' },
        content_need: { caption: 'brand new caption' },
      },
      TENANT,
    );
    expect(v.decision).toBe('PUBLISH');
    expect(v.resolution_step).toBe('recaption');
    const asset = await assetRegistry.getAsset(TENANT, 'clip_a');
    expect(asset?.caption).toBe('brand new caption');
  });

  it('is tenant-isolated — one tenant cannot borrow another tenant\'s assets', async () => {
    mockLLM(
      JSON.stringify({ caption: 'fresh', asset_recommendation: 'a clip' }),
    );
    // TENANT has a stocked gentle_start; OTHER has an identically-named but EMPTY one.
    await seedGentleStart(TENANT);
    await seedCategory(OTHER, 'gentle_start', []);
    const v = await evaluate(
      {
        trigger: { condition: 'gentle morning' },
        condition_signal: { category_id: 'gentle_start' },
        content_need: { caption: 'Ease into it.' },
      },
      OTHER,
    );
    // OTHER cannot reuse TENANT's clip_a, so C4 escalates and C5 generates
    // instead — but it did NOT borrow the other tenant's asset.
    expect(v.outcome).toBe(EvaluationOutcome.GENERATED);
    expect(v.asset_id).toBeNull();
  });
});

describe('Orchestrator — simplified prompt input (evaluatePrompt)', () => {
  it('derives situation + content type from a free-form idea, then reuses a matching clip', async () => {
    // First (and only) LLM call = field extraction; the derived situation both
    // resolves the category (C2 matches by name) and drives the caption need so
    // C4 reuses the seeded clip as-is (no C5 needed). For that to line up the
    // category NAME and the asset caption both equal the extracted situation.
    jest
      .spyOn(llm, 'callLLM')
      .mockResolvedValue(
        JSON.stringify({ situation: 'Ease into it.', content_type: 'clip' }),
      );
    await seedAsset(TENANT, 'clip_a', 'Ease into it.');
    await categorySchema.upsertCategory({
      tenant_id: TENANT,
      category_id: 'gentle_start',
      name: 'Ease into it.',
      prestocked_flag: true,
      asset_list: ['clip_a'],
    });

    const v = await evaluatePrompt(TENANT, 'a chill morning warm-up idea');
    expect(v.decision).toBe('PUBLISH');
    expect(v.asset_id).toBe('clip_a');
    expect(v.source).toBe('AS_IS');
    expect(v.caption).toBe('Ease into it.');
  });

  it('falls back to the raw prompt as the situation when extraction fails', async () => {
    // extraction call rejects -> raw prompt used; category matches by situation,
    // recaption applies the prompt text as the caption.
    jest.spyOn(llm, 'callLLM').mockRejectedValue(new llm.LlmError('down'));
    await seedAsset(TENANT, 'clip_a', 'old');
    await categorySchema.upsertCategory({
      tenant_id: TENANT,
      category_id: 'gentle_start',
      name: 'Gentle Start',
      prestocked_flag: true,
      asset_list: ['clip_a'],
    });

    const v = await evaluatePrompt(TENANT, 'Gentle Start');
    // situation "Gentle Start" resolves the gentle_start category by name
    expect(v.trail[1].gate).toBe('C2');
    expect(v.trail[1].passed).toBe(true);
    expect(v.decision).toBe('PUBLISH');
    expect(v.source).toBe('RECAPTIONED');
    expect(v.caption).toBe('Gentle Start');
  });
});
