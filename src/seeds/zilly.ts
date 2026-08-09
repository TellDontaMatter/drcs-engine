/**
 * Zilly reference deployment seed (Blueprint: "Zilly Reference Deployment").
 *
 * Establishes the first tenant:
 *  - Creates the Zilly tenant + its C1 quarantine list.
 *  - Loads the 8 confirmed-exported canonical clips
 *    (01_double_bounce_launch … 08_victory_jump) as canonical assets.
 *  - Does NOT register CapyCardioRef or Drive files 002–009 — those are QUARANTINED
 *    (auto-rejected by C1), never registered as assets.
 *
 * Idempotent: re-running upserts the tenant config and skips already-registered clips.
 *
 * NOTE: The tenant id and asset ids live here in seed data — never inside gate logic.
 */
import { prisma } from '../persistence/client';
import * as tenantConfig from '../persistence/repositories/tenantConfig';
import * as assetRegistry from '../persistence/repositories/assetRegistry';
import * as categorySchema from '../persistence/repositories/categorySchema';
import { AssetTag } from '../types';

/** The Zilly tenant identifier. */
export const ZILLY_TENANT_ID = 'zilly';

/**
 * Zilly's 9 situational categories (Blueprint Section 11, verbatim), used by C2.
 * Seeded as a Section 5A prerequisite — C2.selectCategory() cannot function until
 * this taxonomy exists.
 *
 * Two categories carry blueprint-mandated flags:
 *  - "Adversity" is empty by design: prestocked_flag=false, never pre-stocked.
 *  - "Friday" is protected: protected_flag=true, never downgraded/substituted.
 *
 * `asset_list` is intentionally empty here — content assignment to situational
 * categories is a separate, later step; the flags and taxonomy are what C2 needs.
 */
export interface ZillyCategorySeed {
  category_id: string;
  name: string;
  protected_flag: boolean;
  prestocked_flag: boolean;
}

export const ZILLY_CATEGORIES: readonly ZillyCategorySeed[] = [
  { category_id: 'gentle_start', name: 'Gentle Start', protected_flag: false, prestocked_flag: true },
  { category_id: 'building_momentum', name: 'Building Momentum', protected_flag: false, prestocked_flag: true },
  { category_id: 'chaos', name: 'Chaos', protected_flag: false, prestocked_flag: true },
  { category_id: 'comic_relief', name: 'Comic Relief', protected_flag: false, prestocked_flag: true },
  // Empty by design — never pre-stocked.
  { category_id: 'adversity', name: 'Adversity', protected_flag: false, prestocked_flag: false },
  { category_id: 'victory', name: 'Victory', protected_flag: false, prestocked_flag: true },
  { category_id: 'transition_pivot', name: 'Transition/Pivot', protected_flag: false, prestocked_flag: true },
  { category_id: 'weather_specific', name: 'Weather-Specific', protected_flag: false, prestocked_flag: true },
  // Protected — never downgraded.
  { category_id: 'friday', name: 'Friday', protected_flag: true, prestocked_flag: true },
];

/**
 * A canonical clip plus its attached media file and caption.
 *
 * `file_path` is repo-relative so it resolves from the project root. Only
 * `08_victory_jump` points at a real bundled media file
 * (media/assets/zilly_mascot.png). Every other clip points at a per-asset
 * placeholder path (media/assets/zilly_<asset_id>.png) — the SLOT where that
 * clip's real media will live once mapped in. Every clip carries a simple,
 * situation-appropriate caption so the Content Retrieval layer always returns a
 * usable (file_path + caption) pair.
 */
export interface ZillyClipSeed {
  asset_id: string;
  file_path: string;
  caption: string;
}

/** The single bundled real media file (the Zilly mascot image). */
const ZILLY_MASCOT_FILE = 'media/assets/zilly_mascot.png';

/** The 8 confirmed-exported canonical clips for Zilly, with media + captions. */
export const ZILLY_CANONICAL_CLIPS: readonly ZillyClipSeed[] = [
  { asset_id: '01_double_bounce_launch', file_path: 'media/assets/zilly_01_double_bounce_launch.png', caption: 'Ease into it — double bounce to start.' },
  { asset_id: '02_side_shuffle', file_path: 'media/assets/zilly_02_side_shuffle.png', caption: 'Side to side — shuffle it out.' },
  { asset_id: '03_high_knees', file_path: 'media/assets/zilly_03_high_knees.png', caption: 'Pick up the pace with high knees.' },
  { asset_id: '04_squat_pulse', file_path: 'media/assets/zilly_04_squat_pulse.png', caption: 'Feel the burn — squat pulses.' },
  { asset_id: '05_arm_circles', file_path: 'media/assets/zilly_05_arm_circles.png', caption: 'Loosen up with big arm circles.' },
  { asset_id: '06_jump_rope', file_path: 'media/assets/zilly_06_jump_rope.png', caption: 'All-out jump rope scramble!' },
  { asset_id: '07_cooldown_stretch', file_path: 'media/assets/zilly_07_cooldown_stretch.png', caption: 'Wind it down — cooldown stretch.' },
  { asset_id: '08_victory_jump', file_path: ZILLY_MASCOT_FILE, caption: 'You made it — victory jump!' },
];

/**
 * Zilly's quarantine list: CapyCardioRef + Drive file ids 002–009. C1 must
 * auto-reject any asset claiming derivation from these until a human resolves them.
 */
export const ZILLY_QUARANTINE_LIST: readonly string[] = [
  'CapyCardioRef',
  '002',
  '003',
  '004',
  '005',
  '006',
  '007',
  '008',
  '009',
];

/**
 * Seed (or re-seed) the Zilly tenant. Safe to run multiple times.
 * @returns Summary counts for logging.
 */
export async function seedZilly(): Promise<{
  tenant_id: string;
  canonical_loaded: number;
  quarantine_size: number;
  categories_loaded: number;
}> {
  // 1. Tenant + quarantine configuration.
  await tenantConfig.upsertTenantConfig(
    ZILLY_TENANT_ID,
    'Zilly',
    [...ZILLY_QUARANTINE_LIST],
  );

  // 1b. Situational taxonomy (Section 5A prerequisite for C2). Idempotent upsert;
  // asset_list starts empty (content assignment is a separate step). Re-seeding
  // preserves flags but does NOT clobber any assets later assigned to a category.
  for (const cat of ZILLY_CATEGORIES) {
    const existing = await categorySchema.getCategory(ZILLY_TENANT_ID, cat.category_id);
    await categorySchema.upsertCategory({
      tenant_id: ZILLY_TENANT_ID,
      category_id: cat.category_id,
      name: cat.name,
      protected_flag: cat.protected_flag,
      prestocked_flag: cat.prestocked_flag,
      asset_list: existing?.asset_list ?? [],
    });
  }

  // 2. Load the 8 canonical clips. New clips are created with their media file
  //    and caption; already-registered clips have their file_path and caption
  //    back-filled so re-seeding an existing DB attaches the media slots too
  //    (idempotent, and never touches hashes/tags/parent).
  let loaded = 0;
  for (const clip of ZILLY_CANONICAL_CLIPS) {
    const existing = await assetRegistry.getAsset(ZILLY_TENANT_ID, clip.asset_id);
    if (existing) {
      // Back-fill the media file path and caption onto an already-seeded asset.
      if (existing.file_path !== clip.file_path) {
        await assetRegistry.updateFilePath(ZILLY_TENANT_ID, clip.asset_id, clip.file_path);
      }
      if (existing.caption !== clip.caption) {
        await assetRegistry.updateCaption(ZILLY_TENANT_ID, clip.asset_id, clip.caption);
      }
      continue;
    }
    // A canonical clip has no parent; its sealed_hash == content_hash at lock time.
    const hash = `sha256:${clip.asset_id}`;
    await assetRegistry.createAsset({
      tenant_id: ZILLY_TENANT_ID,
      asset_id: clip.asset_id,
      tag: AssetTag.CANONICAL,
      category: 'zilly_cardio',
      caption: clip.caption,
      file_path: clip.file_path,
      parent_asset_id: null,
      content_hash: hash,
      sealed_hash: hash,
    });
    loaded += 1;
  }

  // 3. CapyCardioRef and files 002–009 are intentionally NOT registered.

  return {
    tenant_id: ZILLY_TENANT_ID,
    canonical_loaded: loaded,
    quarantine_size: ZILLY_QUARANTINE_LIST.length,
    categories_loaded: ZILLY_CATEGORIES.length,
  };
}

// Allow `ts-node src/seeds/zilly.ts` / `prisma db seed`.
if (require.main === module) {
  seedZilly()
    .then((summary) => {
      // eslint-disable-next-line no-console
      console.log('Zilly seed complete:', summary);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Zilly seed failed:', err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
