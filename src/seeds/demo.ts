/**
 * DEMO ASSIGNMENT — illustrative only, NOT the canonical clip→category mapping.
 *
 * The real Zilly mapping (which canonical clip belongs in which situational
 * category, and each clip's caption) is a pending human decision and is NOT
 * encoded here. This seed exists purely so the engine can be exercised
 * end-to-end from the UI (so a PUBLISH outcome is reachable, not only
 * escalate-to-C5). It layers on top of the canonical Zilly seed and only
 * writes captions + category asset_lists; it never changes the canonical set,
 * hashes, tags, or quarantine list.
 *
 * Run:  npm run seed:zilly  &&  npm run seed:demo
 */
import { seedZilly, ZILLY_TENANT_ID } from './zilly';
import * as categorySchema from '../persistence/repositories/categorySchema';
import * as assetRegistry from '../persistence/repositories/assetRegistry';

/** Illustrative clip → (category, caption) assignments. NOT canonical. */
const DEMO_ASSIGNMENTS: ReadonlyArray<{
  asset_id: string;
  category_id: string;
  caption: string;
}> = [
  { asset_id: '01_double_bounce_launch', category_id: 'gentle_start', caption: 'Ease into it — double bounce to start.' },
  { asset_id: '03_high_knees', category_id: 'building_momentum', caption: 'Pick up the pace with high knees.' },
  { asset_id: '06_jump_rope', category_id: 'chaos', caption: 'All-out jump rope scramble!' },
  { asset_id: '08_victory_jump', category_id: 'victory', caption: 'You made it — victory jump!' },
];

export async function seedDemo(): Promise<void> {
  // Ensure the canonical tenant/taxonomy/clips exist first.
  await seedZilly();

  // Group assignments by category so each category's asset_list is set once.
  const byCategory = new Map<string, string[]>();
  for (const a of DEMO_ASSIGNMENTS) {
    await assetRegistry.updateCaption(ZILLY_TENANT_ID, a.asset_id, a.caption);
    const list = byCategory.get(a.category_id) ?? [];
    list.push(a.asset_id);
    byCategory.set(a.category_id, list);
  }

  for (const [category_id, asset_list] of byCategory) {
    const existing = await categorySchema.getCategory(ZILLY_TENANT_ID, category_id);
    if (!existing) continue;
    // Merge (idempotent) — preserve any assets already assigned.
    const merged = Array.from(new Set([...existing.asset_list, ...asset_list]));
    await categorySchema.upsertCategory({
      tenant_id: ZILLY_TENANT_ID,
      category_id,
      name: existing.name,
      protected_flag: existing.protected_flag,
      prestocked_flag: existing.prestocked_flag,
      asset_list: merged,
    });
  }

  // Attach ONE real media file so the end-to-end file-retrieval path can be
  // demonstrated with an actual file on disk (not just a null placeholder).
  // The victory clip points at the bundled zilly mascot image. This is the only
  // asset with a real file; all others keep file_path null until real clips are
  // mapped in. Path is repo-relative so it resolves from the project root.
  await assetRegistry.updateFilePath(
    ZILLY_TENANT_ID,
    '08_victory_jump',
    'media/assets/zilly_mascot.png',
  );
}

if (require.main === module) {
  seedDemo()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[seed:demo] Illustrative clip→category assignments applied for tenant', ZILLY_TENANT_ID);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[seed:demo] failed:', err);
      process.exit(1);
    });
}
