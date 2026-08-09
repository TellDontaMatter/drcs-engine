/**
 * C4 (Caption-First Resolution) — Section 17 contract + supporting cases.
 *
 * Covers the STRICT, never-skipped 3-step ladder:
 *  - Step 1 existing-as-is: reuse an asset whose current caption already matches
 *  - Step 2 recaption: reuse an asset with the needed caption when no as-is match
 *  - Step 3 escalate to C5: no reusable asset in the category
 *  - ordering guarantees (as-is beats recaption; recaption beats escalate)
 *  - determinism (asset_list order), case/whitespace-insensitive caption match
 *  - required_tag and exclude_asset_ids filters
 *  - invalid content need + missing category throw
 *  - tenant isolation
 *  - updateCaption persistence (applying a recaption)
 */
import * as c4 from '../src/gates/c4';
import { CategoryNotFoundError, InvalidContentNeedError } from '../src/gates/c4';
import * as assetRegistry from '../src/persistence/repositories/assetRegistry';
import * as categorySchema from '../src/persistence/repositories/categorySchema';
import { AssetTag, C4ResolutionStep } from '../src/types';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';

/** Create a category listing the given asset ids. */
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

/** Create an asset with an optional caption/tag. */
async function seedAsset(
  tenant_id: string,
  asset_id: string,
  caption: string | null,
  tag: AssetTag = AssetTag.CANONICAL,
): Promise<void> {
  await assetRegistry.createAsset({ tenant_id, asset_id, tag, caption });
}

describe('C4 — Caption-First Resolution', () => {
  describe('Step 1 — existing-as-is', () => {
    it('reuses an existing asset whose caption already satisfies the need', async () => {
      await seedAsset(TENANT_A, 'clip_1', 'We did it!');
      await seedCategory(TENANT_A, 'victory', ['clip_1']);

      const res = await c4.resolve('victory', { caption: 'We did it!' }, TENANT_A);

      expect(res.resolved).toBe(true);
      expect(res.escalate).toBe(false);
      expect(res.resolution_step).toBe(C4ResolutionStep.EXISTING_AS_IS);
      expect(res.asset_id).toBe('clip_1');
      expect(res.caption).toBe('We did it!');
    });

    it('matches captions case- and whitespace-insensitively (returns stored caption)', async () => {
      await seedAsset(TENANT_A, 'clip_1', 'We   Did It!');
      await seedCategory(TENANT_A, 'victory', ['clip_1']);

      const res = await c4.resolve('victory', { caption: 'we did it!' }, TENANT_A);

      expect(res.resolution_step).toBe(C4ResolutionStep.EXISTING_AS_IS);
      // as-is returns the asset's OWN stored caption, not the needed string
      expect(res.caption).toBe('We   Did It!');
    });

    it('prefers as-is over recaption even when a recaption candidate comes first', async () => {
      // clip_a has no matching caption (recaption candidate, listed first),
      // clip_b already matches (as-is). As-is must win regardless of order.
      await seedAsset(TENANT_A, 'clip_a', 'Something else');
      await seedAsset(TENANT_A, 'clip_b', 'Exact match');
      await seedCategory(TENANT_A, 'victory', ['clip_a', 'clip_b']);

      const res = await c4.resolve('victory', { caption: 'Exact match' }, TENANT_A);

      expect(res.resolution_step).toBe(C4ResolutionStep.EXISTING_AS_IS);
      expect(res.asset_id).toBe('clip_b');
    });
  });

  describe('Step 2 — recaption', () => {
    it('reuses the first eligible asset with the needed caption when no as-is match', async () => {
      await seedAsset(TENANT_A, 'clip_1', 'Old caption');
      await seedAsset(TENANT_A, 'clip_2', 'Another caption');
      await seedCategory(TENANT_A, 'victory', ['clip_1', 'clip_2']);

      const res = await c4.resolve('victory', { caption: 'Brand new words' }, TENANT_A);

      expect(res.resolved).toBe(true);
      expect(res.escalate).toBe(false);
      expect(res.resolution_step).toBe(C4ResolutionStep.RECAPTION);
      expect(res.asset_id).toBe('clip_1'); // deterministic: first in asset_list
      expect(res.caption).toBe('Brand new words'); // recaption returns the needed caption
    });

    it('recaptions an asset that has no caption at all (null caption)', async () => {
      await seedAsset(TENANT_A, 'clip_1', null);
      await seedCategory(TENANT_A, 'victory', ['clip_1']);

      const res = await c4.resolve('victory', { caption: 'Give it a caption' }, TENANT_A);

      expect(res.resolution_step).toBe(C4ResolutionStep.RECAPTION);
      expect(res.asset_id).toBe('clip_1');
      expect(res.caption).toBe('Give it a caption');
    });
  });

  describe('Step 3 — escalate to C5', () => {
    it('escalates when the category has no assets', async () => {
      await seedCategory(TENANT_A, 'adversity', []);

      const res = await c4.resolve('adversity', { caption: 'Anything' }, TENANT_A);

      expect(res.resolved).toBe(false);
      expect(res.escalate).toBe(true);
      expect(res.resolution_step).toBe(C4ResolutionStep.ESCALATE_TO_C5);
      expect(res.asset_id).toBeNull();
      expect(res.caption).toBeNull();
    });

    it('escalates when every listed asset id is absent from the registry', async () => {
      await seedCategory(TENANT_A, 'victory', ['ghost_1', 'ghost_2']);

      const res = await c4.resolve('victory', { caption: 'Anything' }, TENANT_A);

      expect(res.escalate).toBe(true);
      expect(res.resolution_step).toBe(C4ResolutionStep.ESCALATE_TO_C5);
    });

    it('escalates when all candidates are excluded/filtered out (never skips to reuse)', async () => {
      await seedAsset(TENANT_A, 'clip_1', 'x');
      await seedCategory(TENANT_A, 'victory', ['clip_1']);

      const res = await c4.resolve(
        'victory',
        { caption: 'Need', exclude_asset_ids: ['clip_1'] },
        TENANT_A,
      );

      expect(res.escalate).toBe(true);
      expect(res.resolution_step).toBe(C4ResolutionStep.ESCALATE_TO_C5);
    });
  });

  describe('Filters', () => {
    it('respects required_tag when selecting a recaption candidate', async () => {
      await seedAsset(TENANT_A, 'edit_1', 'no match', AssetTag.DERIVATIVE_EDIT);
      await seedAsset(TENANT_A, 'canon_1', 'no match', AssetTag.CANONICAL);
      await seedCategory(TENANT_A, 'victory', ['edit_1', 'canon_1']);

      const res = await c4.resolve(
        'victory',
        { caption: 'Need', required_tag: AssetTag.CANONICAL },
        TENANT_A,
      );

      expect(res.resolution_step).toBe(C4ResolutionStep.RECAPTION);
      expect(res.asset_id).toBe('canon_1'); // the edit was filtered out
    });

    it('excludes specified asset ids from the as-is match', async () => {
      await seedAsset(TENANT_A, 'clip_1', 'Match');
      await seedAsset(TENANT_A, 'clip_2', 'Match');
      await seedCategory(TENANT_A, 'victory', ['clip_1', 'clip_2']);

      const res = await c4.resolve(
        'victory',
        { caption: 'Match', exclude_asset_ids: ['clip_1'] },
        TENANT_A,
      );

      expect(res.resolution_step).toBe(C4ResolutionStep.EXISTING_AS_IS);
      expect(res.asset_id).toBe('clip_2');
    });
  });

  describe('Input validation', () => {
    it('throws InvalidContentNeedError on an empty caption', async () => {
      await seedCategory(TENANT_A, 'victory', []);
      await expect(
        c4.resolve('victory', { caption: '   ' }, TENANT_A),
      ).rejects.toBeInstanceOf(InvalidContentNeedError);
    });

    it('throws CategoryNotFoundError when the category is not configured', async () => {
      await expect(
        c4.resolve('does_not_exist', { caption: 'x' }, TENANT_A),
      ).rejects.toBeInstanceOf(CategoryNotFoundError);
    });
  });

  describe('Tenant isolation', () => {
    it('resolves only against the calling tenant assets', async () => {
      // Tenant B has a perfect as-is match; tenant A has only a recaption candidate.
      await seedAsset(TENANT_B, 'shared_id', 'Exact');
      await seedCategory(TENANT_B, 'victory', ['shared_id']);
      await seedAsset(TENANT_A, 'shared_id', 'Different');
      await seedCategory(TENANT_A, 'victory', ['shared_id']);

      const res = await c4.resolve('victory', { caption: 'Exact' }, TENANT_A);

      // For tenant A, 'shared_id' does not match as-is -> recaption, not as-is.
      expect(res.resolution_step).toBe(C4ResolutionStep.RECAPTION);
      expect(res.caption).toBe('Exact');
    });
  });

  describe('Applying a recaption (persistence)', () => {
    it('updateCaption persists the new caption so a later resolve matches as-is', async () => {
      await seedAsset(TENANT_A, 'clip_1', 'Old');
      await seedCategory(TENANT_A, 'victory', ['clip_1']);

      const first = await c4.resolve('victory', { caption: 'Fresh' }, TENANT_A);
      expect(first.resolution_step).toBe(C4ResolutionStep.RECAPTION);

      // Downstream accepts the recaption and persists it.
      await assetRegistry.updateCaption(TENANT_A, 'clip_1', first.caption as string);

      const second = await c4.resolve('victory', { caption: 'Fresh' }, TENANT_A);
      expect(second.resolution_step).toBe(C4ResolutionStep.EXISTING_AS_IS);
      expect(second.asset_id).toBe('clip_1');
      expect(second.caption).toBe('Fresh');
    });
  });
});
