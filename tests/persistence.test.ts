/**
 * Persistence + Zilly seed tests.
 * Verifies append-only proposal log, tenant-scoped reads, and the Zilly seed.
 */
import * as proposalApprovalLog from '../src/persistence/repositories/proposalApprovalLog';
import * as assetRegistry from '../src/persistence/repositories/assetRegistry';
import * as tenantConfig from '../src/persistence/repositories/tenantConfig';
import * as c1 from '../src/gates/c1';
import { AssetTag } from '../src/types';
import {
  seedZilly,
  ZILLY_TENANT_ID,
  ZILLY_CANONICAL_CLIPS,
  ZILLY_QUARANTINE_LIST,
} from '../src/seeds/zilly';

describe('ProposalApprovalLog (append-only, C7)', () => {
  it('exposes create + read only — no update/delete operations exist', () => {
    // Static guarantee: the module surface contains no mutating operations.
    const surface = Object.keys(proposalApprovalLog);
    expect(surface).toEqual(
      expect.arrayContaining(['appendProposal', 'getProposal', 'listProposals']),
    );
    expect(surface.some((k) => /update|delete|remove|edit/i.test(k))).toBe(false);
  });

  it('appends and reads back entries, scoped by tenant', async () => {
    const rec = await proposalApprovalLog.appendProposal({
      tenant_id: 't1',
      items: ['a', 'b'],
      confidence: [0.9, 0.8],
      rationale: ['r1', 'r2'],
      approval_status: 'approved',
      approved_items: ['a'],
      approved_by: 'human',
      approved_at: new Date(),
      mode: 'manual',
    });
    const fetched = await proposalApprovalLog.getProposal('t1', rec.proposal_id);
    expect(fetched?.approval_status).toBe('approved');
    // Not visible to another tenant.
    expect(await proposalApprovalLog.getProposal('t2', rec.proposal_id)).toBeNull();
  });
});

describe('Zilly seed', () => {
  it('creates the tenant, loads 8 canonical clips, sets quarantine, omits quarantined files', async () => {
    const summary = await seedZilly();
    expect(summary.tenant_id).toBe(ZILLY_TENANT_ID);
    expect(summary.canonical_loaded).toBe(8);

    // 8 canonical clips are registered and validate as canonical.
    const canonicals = await assetRegistry.listAssets(ZILLY_TENANT_ID, AssetTag.CANONICAL);
    expect(canonicals).toHaveLength(8);
    for (const clip of ZILLY_CANONICAL_CLIPS) {
      const res = await c1.validate(clip.asset_id, AssetTag.CANONICAL, ZILLY_TENANT_ID);
      expect(res.valid).toBe(true);
    }

    // Quarantine list is stored in config.
    const q = await tenantConfig.getQuarantineList(ZILLY_TENANT_ID);
    expect(q).toEqual([...ZILLY_QUARANTINE_LIST]);

    // Quarantined sources are NOT registered as assets.
    for (const src of ZILLY_QUARANTINE_LIST) {
      expect(await assetRegistry.getAsset(ZILLY_TENANT_ID, src)).toBeNull();
    }

    // An asset derived from CapyCardioRef is auto-rejected under Zilly.
    await assetRegistry.createAsset({
      tenant_id: ZILLY_TENANT_ID,
      asset_id: 'bad_derivative',
      tag: AssetTag.DERIVATIVE_EDIT,
      parent_asset_id: 'CapyCardioRef',
    });
    const rejected = await c1.validate('bad_derivative', AssetTag.DERIVATIVE_EDIT, ZILLY_TENANT_ID);
    expect(rejected.valid).toBe(false);
    expect(rejected.reason.toLowerCase()).toContain('quarantin');
  });

  it('is idempotent (re-seeding loads 0 additional clips)', async () => {
    await seedZilly();
    const second = await seedZilly();
    expect(second.canonical_loaded).toBe(0);
  });
});
