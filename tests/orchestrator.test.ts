/**
 * ORCHESTRATOR — end-to-end pipeline tests.
 *
 * Proves the engine (not just the individual gates) works: it runs the gates in
 * blueprint order (C6 → C2 → C4 → C3), SHORT-CIRCUITS at the first gate that
 * stops the request, ENFORCES each decision (no silent downgrade), commits side
 * effects only on PUBLISH, and returns one verdict + a gate-by-gate trail.
 */
import { evaluate, EvaluationOutcome } from '../src/orchestrator';
import * as assetRegistry from '../src/persistence/repositories/assetRegistry';
import * as categorySchema from '../src/persistence/repositories/categorySchema';
import * as usageLog from '../src/persistence/repositories/usageLog';
import { AssetTag, ReviewerDirective } from '../src/types';

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

  it('ESCALATES to C5 at C4 when the category has no reusable asset', async () => {
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
    expect(v.decision).toBe('BLOCKED');
    expect(v.outcome).toBe(EvaluationOutcome.ESCALATED_TO_C5);
    expect(v.stopped_at_gate).toBe('C4');
    expect(v.trail.map((t) => t.gate)).toEqual(['C6', 'C2', 'C4']);
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
    expect(v.outcome).toBe(EvaluationOutcome.ESCALATED_TO_C5);
  });
});
