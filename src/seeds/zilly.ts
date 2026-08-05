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
import { AssetTag } from '../types';

/** The Zilly tenant identifier. */
export const ZILLY_TENANT_ID = 'zilly';

/** The 8 confirmed-exported canonical clips for Zilly. */
export const ZILLY_CANONICAL_CLIPS: readonly string[] = [
  '01_double_bounce_launch',
  '02_side_shuffle',
  '03_high_knees',
  '04_squat_pulse',
  '05_arm_circles',
  '06_jump_rope',
  '07_cooldown_stretch',
  '08_victory_jump',
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
}> {
  // 1. Tenant + quarantine configuration.
  await tenantConfig.upsertTenantConfig(
    ZILLY_TENANT_ID,
    'Zilly',
    [...ZILLY_QUARANTINE_LIST],
  );

  // 2. Load the 8 canonical clips (skip any already registered).
  let loaded = 0;
  for (const clip of ZILLY_CANONICAL_CLIPS) {
    const existing = await assetRegistry.getAsset(ZILLY_TENANT_ID, clip);
    if (existing) continue;
    // A canonical clip has no parent; its sealed_hash == content_hash at lock time.
    const hash = `sha256:${clip}`;
    await assetRegistry.createAsset({
      tenant_id: ZILLY_TENANT_ID,
      asset_id: clip,
      tag: AssetTag.CANONICAL,
      category: 'zilly_cardio',
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
