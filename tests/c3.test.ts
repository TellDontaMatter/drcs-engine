/**
 * C3 (Repetition Governor) — acceptance tests + supporting cases.
 *
 * Covers:
 *  - Locked params: max_count=3, rolling_window=30 days, per deployment instance
 *  - allowed while under the cap; blocked at the cap
 *  - counting is per deployment instance REGARDLESS of category
 *  - rolling window: deployments older than the window do not count
 *  - window_remaining_ms reports time until the next slot frees up
 *  - FAIL CLOSED on log integrity issues (future-dated row) — never fails open
 *  - tenant isolation of the usage log
 */
import * as c3 from '../src/gates/c3';
import { C3_LOCKED_PARAMS } from '../src/types';
import * as usageLog from '../src/persistence/repositories/usageLog';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';
const ASSET = '01_double_bounce_launch';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A fixed reference "now" so the rolling window is deterministic. */
const NOW = new Date('2026-08-05T12:00:00.000Z');

/** Log a deployment `daysAgo` before NOW. */
async function logDaysAgo(
  tenant_id: string,
  asset_id: string,
  daysAgo: number,
  context?: string,
): Promise<void> {
  await usageLog.logDeployment({
    tenant_id,
    asset_id,
    deployed_at: new Date(NOW.getTime() - daysAgo * MS_PER_DAY),
    deployment_context: context ?? null,
  });
}

describe('C3 — Repetition Governor', () => {
  describe('Locked parameters', () => {
    it('exposes the blueprint-locked defaults', () => {
      expect(C3_LOCKED_PARAMS.max_count).toBe(3);
      expect(C3_LOCKED_PARAMS.rolling_window_days).toBe(30);
      expect(C3_LOCKED_PARAMS.counting_unit).toBe('per_deployment_instance');
    });
  });

  describe('Acceptance: max_count within rolling_window', () => {
    it('allows when under the cap (0,1,2 in window)', async () => {
      await logDaysAgo(TENANT_A, ASSET, 1);
      await logDaysAgo(TENANT_A, ASSET, 2);
      const res = await c3.checkRepetition(ASSET, { tenant_id: TENANT_A, now: NOW });
      expect(res.current_count).toBe(2);
      expect(res.allowed).toBe(true);
      expect(res.window_remaining_ms).toBe(0);
      expect(res.failed_closed).toBe(false);
    });

    it('blocks at the cap (3 in window)', async () => {
      await logDaysAgo(TENANT_A, ASSET, 1);
      await logDaysAgo(TENANT_A, ASSET, 2);
      await logDaysAgo(TENANT_A, ASSET, 3);
      const res = await c3.checkRepetition(ASSET, { tenant_id: TENANT_A, now: NOW });
      expect(res.current_count).toBe(3);
      expect(res.allowed).toBe(false);
      expect(res.failed_closed).toBe(false);
    });

    it('allows the very first deployment (empty log)', async () => {
      const res = await c3.checkRepetition(ASSET, { tenant_id: TENANT_A, now: NOW });
      expect(res.current_count).toBe(0);
      expect(res.allowed).toBe(true);
    });
  });

  describe('Acceptance: counting is per deployment instance, regardless of category', () => {
    it('counts every instance even when deployed in different categories', async () => {
      // Same asset deployed under different category contexts still counts as
      // repetition of that asset instance.
      await logDaysAgo(TENANT_A, ASSET, 1, 'category:victory');
      await logDaysAgo(TENANT_A, ASSET, 2, 'category:friday');
      await logDaysAgo(TENANT_A, ASSET, 3, 'category:chaos');
      const res = await c3.checkRepetition(ASSET, { tenant_id: TENANT_A, now: NOW });
      expect(res.current_count).toBe(3);
      expect(res.allowed).toBe(false);
    });
  });

  describe('Acceptance: rolling window', () => {
    it('excludes deployments older than the 30-day window', async () => {
      await logDaysAgo(TENANT_A, ASSET, 40); // outside window
      await logDaysAgo(TENANT_A, ASSET, 35); // outside window
      await logDaysAgo(TENANT_A, ASSET, 5); // inside
      const res = await c3.checkRepetition(ASSET, { tenant_id: TENANT_A, now: NOW });
      expect(res.current_count).toBe(1);
      expect(res.allowed).toBe(true);
    });

    it('window_remaining_ms reports time until the oldest in-window instance ages out', async () => {
      // 3 in-window (at cap). Oldest is 10 days ago -> it exits the window in
      // (30 - 10) = 20 days, at which point count drops to 2 and is allowed again.
      await logDaysAgo(TENANT_A, ASSET, 10);
      await logDaysAgo(TENANT_A, ASSET, 5);
      await logDaysAgo(TENANT_A, ASSET, 2);
      const res = await c3.checkRepetition(ASSET, { tenant_id: TENANT_A, now: NOW });
      expect(res.allowed).toBe(false);
      expect(res.window_remaining_ms).toBe(20 * MS_PER_DAY);
    });
  });

  describe('Acceptance: FAIL CLOSED on log integrity issues', () => {
    it('denies (fails closed) when a usage-log row is future-dated', async () => {
      await logDaysAgo(TENANT_A, ASSET, 1);
      // A future-dated row relative to NOW — tampering / clock skew signal.
      await usageLog.logDeployment({
        tenant_id: TENANT_A,
        asset_id: ASSET,
        deployed_at: new Date(NOW.getTime() + 2 * MS_PER_DAY),
      });
      const res = await c3.checkRepetition(ASSET, { tenant_id: TENANT_A, now: NOW });
      expect(res.allowed).toBe(false);
      expect(res.failed_closed).toBe(true);
      expect(res.reason.toLowerCase()).toContain('failed closed');
    });

    it('denies (fails closed) on invalid parameters rather than failing open', async () => {
      const res = await c3.checkRepetition(ASSET, {
        tenant_id: TENANT_A,
        rolling_window_days: 0,
        now: NOW,
      });
      expect(res.allowed).toBe(false);
      expect(res.failed_closed).toBe(true);
    });
  });

  describe('Acceptance: tenant isolation', () => {
    it("one tenant's deployments do not count against another tenant", async () => {
      await logDaysAgo(TENANT_A, ASSET, 1);
      await logDaysAgo(TENANT_A, ASSET, 2);
      await logDaysAgo(TENANT_A, ASSET, 3); // A is at the cap
      const b = await c3.checkRepetition(ASSET, { tenant_id: TENANT_B, now: NOW });
      expect(b.current_count).toBe(0);
      expect(b.allowed).toBe(true);
    });
  });
});
