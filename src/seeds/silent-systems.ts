/**
 * Silent Systems deployment seed.
 *
 * Silent Systems is a SEPARATE tenant from Zilly — an infrastructure-documentary
 * content library, not a fitness deployment — running on the same generic engine.
 *
 * Unlike the Zilly seed (which seeds the situational taxonomy with EMPTY
 * asset_lists and defers content assignment), Silent Systems is a fully-defined
 * library, so this seed stands up the complete CONTENT POOL:
 *  - Registers the 8 locked episodes (E01–E08) as canonical assets.
 *  - Seeds the 3 situational categories (the show's category buckets) as the
 *    Section 5A prerequisite for C2.selectCategory(), each PRESTOCKED with its
 *    episodes (a populated asset_list) and PROTECTED (the library is locked and
 *    must never be silently downgraded/substituted).
 *
 * After this runs, C2.selectCategory({ situation: 'Transmission' }, 'silent-systems')
 * resolves to the Transmission category and its available episode assets.
 *
 * Idempotent: re-running upserts the tenant/categories and skips already-registered
 * episodes. All ids live here in seed data — never inside gate logic.
 *
 * Source of truth: silent-systems library README + per-episode metadata.md
 * (Category / Ladder Position copied verbatim from those files).
 */
import { prisma } from '../persistence/client';
import * as tenantConfig from '../persistence/repositories/tenantConfig';
import * as assetRegistry from '../persistence/repositories/assetRegistry';
import * as categorySchema from '../persistence/repositories/categorySchema';
import { AssetTag } from '../types';

/** The Silent Systems tenant identifier. */
export const SILENT_SYSTEMS_TENANT_ID = 'silent-systems';

/** One locked episode = one canonical asset in the pool. */
export interface EpisodeSeed {
  asset_id: string;
  title: string;
  category_id: string;
  ladder_position: string;
}

/** Situational category = one of the show's three category buckets. */
export interface CategorySeed {
  category_id: string;
  name: string;
}

/** The three situational categories (Blueprint Section 11 taxonomy for this tenant). */
export const SILENT_SYSTEMS_CATEGORIES: readonly CategorySeed[] = [
  { category_id: 'water_and_waste', name: 'Water & Waste' },
  { category_id: 'transmission', name: 'Transmission' },
  { category_id: 'communications', name: 'Communications' },
];

/** The 8 locked episodes (E01–E08), verbatim from per-episode metadata. */
export const SILENT_SYSTEMS_EPISODES: readonly EpisodeSeed[] = [
  {
    asset_id: 'E01_water_became_safe',
    title: 'How Water Became Safe (And Why No One Noticed)',
    category_id: 'water_and_waste',
    ladder_position: 'Water Safety',
  },
  {
    asset_id: 'E02_carries_everything_away',
    title: 'The System That Carries Everything Away',
    category_id: 'water_and_waste',
    ladder_position: 'Waste Removal',
  },
  {
    asset_id: 'E03_where_away_is',
    title: 'Where "Away" Actually Is',
    category_id: 'water_and_waste',
    ladder_position: 'Waste Treatment',
  },
  {
    asset_id: 'E04_power_not_local',
    title: 'How Power Stopped Being Local',
    category_id: 'transmission',
    ladder_position: 'Power Interconnection',
  },
  {
    asset_id: 'E05_power_in_sync',
    title: 'How Power Plants Stay in Sync',
    category_id: 'transmission',
    ladder_position: 'Power Synchronization',
  },
  {
    asset_id: 'E06_time_not_local',
    title: 'Time Stopped Being Local',
    category_id: 'transmission',
    ladder_position: 'Standardized Time',
  },
  {
    asset_id: 'E07_addressing',
    title: 'How Addressing Made the World Smaller',
    category_id: 'communications',
    ladder_position: 'Standardized Addressing',
  },
  {
    asset_id: 'E08_routing',
    title: 'How Messages Found Their Own Way',
    category_id: 'communications',
    ladder_position: 'Routing',
  },
];

/**
 * Seed (or re-seed) the Silent Systems tenant. Safe to run multiple times.
 * @returns Summary counts for logging.
 */
export async function seedSilentSystems(): Promise<{
  tenant_id: string;
  episodes_loaded: number;
  categories: number;
}> {
  // 1. Tenant config (no C1 quarantine list for this deployment).
  await tenantConfig.upsertTenantConfig(SILENT_SYSTEMS_TENANT_ID, 'Silent Systems', []);

  // 2. Register the 8 locked episodes as canonical assets (skip existing).
  let loaded = 0;
  for (const ep of SILENT_SYSTEMS_EPISODES) {
    const existing = await assetRegistry.getAsset(SILENT_SYSTEMS_TENANT_ID, ep.asset_id);
    if (existing) continue;
    // A canonical episode has no parent; sealed_hash == content_hash at lock time.
    const hash = `sha256:${ep.asset_id}`;
    await assetRegistry.createAsset({
      tenant_id: SILENT_SYSTEMS_TENANT_ID,
      asset_id: ep.asset_id,
      tag: AssetTag.CANONICAL,
      category: ep.category_id,
      parent_asset_id: null,
      content_hash: hash,
      sealed_hash: hash,
    });
    loaded += 1;
  }

  // 3. Seed the 3 situational categories as the C2 Section 5A prerequisite,
  //    prestocked with their episodes (the content pool) and protected.
  for (const cat of SILENT_SYSTEMS_CATEGORIES) {
    const members = SILENT_SYSTEMS_EPISODES.filter(
      (ep) => ep.category_id === cat.category_id,
    ).map((ep) => ep.asset_id);

    await categorySchema.upsertCategory({
      tenant_id: SILENT_SYSTEMS_TENANT_ID,
      category_id: cat.category_id,
      name: cat.name,
      protected_flag: true,
      prestocked_flag: true,
      asset_list: members,
    });
  }

  return {
    tenant_id: SILENT_SYSTEMS_TENANT_ID,
    episodes_loaded: loaded,
    categories: SILENT_SYSTEMS_CATEGORIES.length,
  };
}

// Allow `ts-node src/seeds/silent-systems.ts`.
if (require.main === module) {
  seedSilentSystems()
    .then((summary) => {
      // eslint-disable-next-line no-console
      console.log('Silent Systems seed complete:', summary);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Silent Systems seed failed:', err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
