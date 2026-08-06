/**
 * Silent Systems content pool — seed + C2 resolution.
 *
 * Verifies that seeding the Silent Systems tenant produces a working content pool:
 *  - the 3 situational categories exist as the C2 Section 5A taxonomy
 *  - each category is protected + prestocked with its episodes (populated pool)
 *  - all 8 episodes are registered as canonical assets
 *  - C2.selectCategory() resolves each category (by explicit id AND by situational
 *    name) and surfaces the correct available episode assets
 *  - the pool is tenant-isolated (invisible to another tenant)
 *  - the seed is idempotent
 */
import * as c2 from '../src/gates/c2';
import { TaxonomyNotSeededError } from '../src/gates/c2';
import * as assetRegistry from '../src/persistence/repositories/assetRegistry';
import { AssetTag } from '../src/types';
import {
  seedSilentSystems,
  SILENT_SYSTEMS_TENANT_ID,
  SILENT_SYSTEMS_EPISODES,
  SILENT_SYSTEMS_CATEGORIES,
} from '../src/seeds/silent-systems';

const OTHER_TENANT = 'some_other_tenant';

describe('Silent Systems content pool', () => {
  describe('seed', () => {
    it('loads 8 episodes and 3 categories', async () => {
      const summary = await seedSilentSystems();
      expect(summary.tenant_id).toBe(SILENT_SYSTEMS_TENANT_ID);
      expect(summary.episodes_loaded).toBe(8);
      expect(summary.categories).toBe(3);
    });

    it('registers every episode as a canonical asset', async () => {
      await seedSilentSystems();
      const canon = await assetRegistry.listAssets(SILENT_SYSTEMS_TENANT_ID, AssetTag.CANONICAL);
      expect(canon.length).toBe(SILENT_SYSTEMS_EPISODES.length);
    });

    it('is idempotent (second run loads nothing new, pool unchanged)', async () => {
      await seedSilentSystems();
      const summary = await seedSilentSystems();
      expect(summary.episodes_loaded).toBe(0);
      const canon = await assetRegistry.listAssets(SILENT_SYSTEMS_TENANT_ID, AssetTag.CANONICAL);
      expect(canon.length).toBe(8);
    });
  });

  describe('C2 resolution over the pool', () => {
    beforeEach(async () => {
      await seedSilentSystems();
    });

    it('resolves each category by explicit id with the right episode pool', async () => {
      const expectedCounts: Record<string, number> = {
        water_and_waste: 3,
        transmission: 3,
        communications: 2,
      };
      for (const cat of SILENT_SYSTEMS_CATEGORIES) {
        const res = await c2.selectCategory(
          { category_id: cat.category_id },
          SILENT_SYSTEMS_TENANT_ID,
        );
        expect(res.matched).toBe(true);
        expect(res.category_id).toBe(cat.category_id);
        expect(res.protected).toBe(true);
        expect(res.prestocked).toBe(true);
        expect(res.available_assets.length).toBe(expectedCounts[cat.category_id]);
      }
    });

    it('resolves by situational name (case-insensitive) — "Transmission"', async () => {
      const res = await c2.selectCategory(
        { situation: 'transmission' },
        SILENT_SYSTEMS_TENANT_ID,
      );
      expect(res.matched).toBe(true);
      expect(res.category_id).toBe('transmission');
      expect(res.available_assets.sort()).toEqual([
        'E04_power_not_local',
        'E05_power_in_sync',
        'E06_time_not_local',
      ]);
    });

    it('surfaces the Communications pool (E07, E08)', async () => {
      const res = await c2.selectCategory(
        { situation: 'Communications' },
        SILENT_SYSTEMS_TENANT_ID,
      );
      expect(res.available_assets.sort()).toEqual(['E07_addressing', 'E08_routing']);
    });
  });

  describe('isolation & prerequisites', () => {
    it('pool is invisible to another tenant (taxonomy not seeded there)', async () => {
      await seedSilentSystems();
      await expect(
        c2.selectCategory({ situation: 'Transmission' }, OTHER_TENANT),
      ).rejects.toThrow(TaxonomyNotSeededError);
    });
  });
});
