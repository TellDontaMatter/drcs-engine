/**
 * C1 (Source of Truth Lock) — Section 19 acceptance tests + supporting cases.
 */
import * as c1 from '../src/gates/c1';
import { AssetTag } from '../src/types';
import * as assetRegistry from '../src/persistence/repositories/assetRegistry';
import * as tenantConfig from '../src/persistence/repositories/tenantConfig';
import * as gateState from '../src/persistence/repositories/gateState';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';

/** Register a tenant with a quarantine list. */
async function setupTenant(tenant_id: string, quarantine: string[] = []): Promise<void> {
  await tenantConfig.upsertTenantConfig(tenant_id, tenant_id, quarantine);
}

describe('C1 — Source of Truth Lock', () => {
  describe('Acceptance: "Canonical lock holds"', () => {
    it('a derivative_edit asset cannot validate as canonical', async () => {
      await setupTenant(TENANT_A);
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: 'clip_edit',
        tag: AssetTag.DERIVATIVE_EDIT,
        parent_asset_id: '01_double_bounce_launch',
      });

      const res = await c1.validate('clip_edit', AssetTag.CANONICAL, TENANT_A);
      expect(res.valid).toBe(false);
      expect(res.reason.toLowerCase()).toContain('canonical lock');
    });

    it('a derivative_new asset cannot validate as canonical', async () => {
      await setupTenant(TENANT_A);
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: 'clip_new',
        tag: AssetTag.DERIVATIVE_NEW,
      });

      const res = await c1.validate('clip_new', AssetTag.CANONICAL, TENANT_A);
      expect(res.valid).toBe(false);
    });

    it('a genuinely canonical asset validates as canonical', async () => {
      await setupTenant(TENANT_A);
      const hash = 'sha256:canon';
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: '01_double_bounce_launch',
        tag: AssetTag.CANONICAL,
        content_hash: hash,
        sealed_hash: hash,
      });

      const res = await c1.validate('01_double_bounce_launch', AssetTag.CANONICAL, TENANT_A);
      expect(res.valid).toBe(true);
      expect(res.tag).toBe(AssetTag.CANONICAL);
    });
  });

  describe('Acceptance: "Quarantine enforced"', () => {
    it('auto-rejects an asset directly derived from a quarantined source', async () => {
      await setupTenant(TENANT_A, ['CapyCardioRef', '002', '003']);
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: 'capy_derivative',
        tag: AssetTag.DERIVATIVE_EDIT,
        parent_asset_id: 'CapyCardioRef',
      });

      const res = await c1.validate('capy_derivative', AssetTag.DERIVATIVE_EDIT, TENANT_A);
      expect(res.valid).toBe(false);
      expect(res.reason.toLowerCase()).toContain('quarantin');
    });

    it('enforces quarantine even when claimed as derivative_new', async () => {
      await setupTenant(TENANT_A, ['002']);
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: 'from_002',
        tag: AssetTag.DERIVATIVE_NEW,
        parent_asset_id: '002',
      });

      const res = await c1.validate('from_002', AssetTag.DERIVATIVE_NEW, TENANT_A);
      expect(res.valid).toBe(false);
      expect(res.reason.toLowerCase()).toContain('quarantin');
    });

    it('rejects assets that TRANSITIVELY trace back to a quarantined source', async () => {
      await setupTenant(TENANT_A, ['009']);
      // grandparent (009, quarantined) <- parent (registered) <- child
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: 'parent_edit',
        tag: AssetTag.DERIVATIVE_EDIT,
        parent_asset_id: '009',
      });
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: 'child_edit',
        tag: AssetTag.DERIVATIVE_EDIT,
        parent_asset_id: 'parent_edit',
      });

      const res = await c1.validate('child_edit', AssetTag.DERIVATIVE_EDIT, TENANT_A);
      expect(res.valid).toBe(false);
      expect(res.reason.toLowerCase()).toContain('quarantin');
    });
  });

  describe('Freeze behavior', () => {
    it('blocks ALL validate() calls while the gate is frozen', async () => {
      await setupTenant(TENANT_A);
      const hash = 'sha256:canon';
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: '01_double_bounce_launch',
        tag: AssetTag.CANONICAL,
        content_hash: hash,
        sealed_hash: hash,
      });

      await gateState.freezeGate(TENANT_A, c1.GATE_ID, 'manual freeze for test');

      const res = await c1.validate('01_double_bounce_launch', AssetTag.CANONICAL, TENANT_A);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe(c1.FROZEN_REASON);
      expect(res.tag).toBeNull();
    });

    it('canonical audit freezes the gate when a canonical asset was modified', async () => {
      await setupTenant(TENANT_A);
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: '01_double_bounce_launch',
        tag: AssetTag.CANONICAL,
        content_hash: 'sha256:TAMPERED',
        sealed_hash: 'sha256:original',
      });

      const audit = await c1.auditCanonicalIntegrity(TENANT_A);
      expect(audit.ok).toBe(false);
      expect(audit.frozen).toBe(true);
      expect(audit.findings.some((f) => f.issue === 'modified')).toBe(true);

      // The freeze now blocks validate().
      const res = await c1.validate('01_double_bounce_launch', AssetTag.CANONICAL, TENANT_A);
      expect(res.reason).toBe(c1.FROZEN_REASON);

      // A human clears the freeze -> validate() resumes.
      await c1.clearFreeze(TENANT_A);
      expect(await c1.isFrozen(TENANT_A)).toBe(false);
    });

    it('audit passes and does not freeze when canonical assets are intact', async () => {
      await setupTenant(TENANT_A);
      const hash = 'sha256:ok';
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: '01_double_bounce_launch',
        tag: AssetTag.CANONICAL,
        content_hash: hash,
        sealed_hash: hash,
      });

      const audit = await c1.auditCanonicalIntegrity(TENANT_A);
      expect(audit.ok).toBe(true);
      expect(audit.frozen).toBe(false);
      expect(audit.scanned).toBe(1);
    });
  });

  describe('Tenant isolation', () => {
    it("tenant A's asset is NOT accessible via tenant B's validate() call", async () => {
      await setupTenant(TENANT_A);
      await setupTenant(TENANT_B);
      const hash = 'sha256:canon';
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: '01_double_bounce_launch',
        tag: AssetTag.CANONICAL,
        content_hash: hash,
        sealed_hash: hash,
      });

      // Tenant A can validate its own asset.
      const a = await c1.validate('01_double_bounce_launch', AssetTag.CANONICAL, TENANT_A);
      expect(a.valid).toBe(true);

      // Tenant B cannot see it.
      const b = await c1.validate('01_double_bounce_launch', AssetTag.CANONICAL, TENANT_B);
      expect(b.valid).toBe(false);
      expect(b.reason.toLowerCase()).toContain('not registered');
    });

    it("a freeze on tenant A does NOT affect tenant B", async () => {
      await setupTenant(TENANT_A);
      await setupTenant(TENANT_B);
      const hash = 'sha256:canon';
      await assetRegistry.createAsset({
        tenant_id: TENANT_B,
        asset_id: '01_double_bounce_launch',
        tag: AssetTag.CANONICAL,
        content_hash: hash,
        sealed_hash: hash,
      });

      await gateState.freezeGate(TENANT_A, c1.GATE_ID, 'freeze A only');

      const b = await c1.validate('01_double_bounce_launch', AssetTag.CANONICAL, TENANT_B);
      expect(b.valid).toBe(true);
    });
  });

  describe('Tag consistency', () => {
    it('rejects a claim that does not match the source-of-truth tag', async () => {
      await setupTenant(TENANT_A);
      await assetRegistry.createAsset({
        tenant_id: TENANT_A,
        asset_id: 'clip_new',
        tag: AssetTag.DERIVATIVE_NEW,
      });

      const res = await c1.validate('clip_new', AssetTag.DERIVATIVE_EDIT, TENANT_A);
      expect(res.valid).toBe(false);
      expect(res.reason.toLowerCase()).toContain('does not match');
    });

    it('rejects an unregistered asset', async () => {
      await setupTenant(TENANT_A);
      const res = await c1.validate('ghost', AssetTag.CANONICAL, TENANT_A);
      expect(res.valid).toBe(false);
      expect(res.reason.toLowerCase()).toContain('not registered');
    });
  });
});
