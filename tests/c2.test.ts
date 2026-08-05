/**
 * C2 (Situational Bank) — Section 19 acceptance tests + supporting cases.
 *
 * Covers:
 *  - Section 5A: taxonomy must be seeded before selectCategory() functions
 *  - Selection by real-time condition signal (explicit id AND situational name)
 *  - "No date/calendar selection path exists in code" — behavioral + a static
 *    source scan asserting the gate uses no date/clock APIs
 *  - Adversity empty by design; Friday protected & never downgraded
 *  - available_assets surfaced from the category asset_list
 *  - tenant isolation of the taxonomy
 *  - the Zilly Section 11 taxonomy seeds with the correct flags
 */
import fs from 'fs';
import path from 'path';
import * as c2 from '../src/gates/c2';
import { TaxonomyNotSeededError } from '../src/gates/c2';
import * as categorySchema from '../src/persistence/repositories/categorySchema';
import { seedZilly, ZILLY_TENANT_ID, ZILLY_CATEGORIES } from '../src/seeds/zilly';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';

/** Seed a minimal taxonomy for a tenant. */
async function seedTaxonomy(tenant_id: string): Promise<void> {
  await categorySchema.upsertCategory({
    tenant_id,
    category_id: 'victory',
    name: 'Victory',
    prestocked_flag: true,
    asset_list: ['08_victory_jump'],
  });
  await categorySchema.upsertCategory({
    tenant_id,
    category_id: 'adversity',
    name: 'Adversity',
    prestocked_flag: false,
    asset_list: [], // empty by design
  });
  await categorySchema.upsertCategory({
    tenant_id,
    category_id: 'friday',
    name: 'Friday',
    protected_flag: true,
    prestocked_flag: true,
    asset_list: ['friday_special'],
  });
}

describe('C2 — Situational Bank', () => {
  describe('Acceptance: Section 5A — seed before select', () => {
    it('throws TaxonomyNotSeededError when the tenant has no taxonomy', async () => {
      await expect(c2.selectCategory({ category_id: 'victory' }, TENANT_A)).rejects.toBeInstanceOf(
        TaxonomyNotSeededError,
      );
    });

    it('functions once the taxonomy is seeded', async () => {
      await seedTaxonomy(TENANT_A);
      const res = await c2.selectCategory({ category_id: 'victory' }, TENANT_A);
      expect(res.matched).toBe(true);
      expect(res.category_id).toBe('victory');
    });
  });

  describe('Acceptance: selection by real-time condition signal', () => {
    beforeEach(async () => {
      await seedTaxonomy(TENANT_A);
    });

    it('resolves a category from an explicit category_id signal', async () => {
      const res = await c2.selectCategory({ category_id: 'victory' }, TENANT_A);
      expect(res.category_id).toBe('victory');
      expect(res.available_assets).toEqual(['08_victory_jump']);
      expect(res.matched).toBe(true);
    });

    it('resolves a category from a situational label (case-insensitive)', async () => {
      const res = await c2.selectCategory({ situation: 'victory' }, TENANT_A);
      expect(res.category_id).toBe('victory');
      const res2 = await c2.selectCategory({ situation: 'VICTORY' }, TENANT_A);
      expect(res2.category_id).toBe('victory');
    });

    it('returns a no-match result (never a date fallback) when no signal is supplied', async () => {
      const res = await c2.selectCategory({}, TENANT_A);
      expect(res.matched).toBe(false);
      expect(res.category_id).toBeNull();
      expect(res.available_assets).toEqual([]);
    });

    it('returns a no-match result when the signal matches nothing', async () => {
      const res = await c2.selectCategory({ situation: 'nonexistent-vibe' }, TENANT_A);
      expect(res.matched).toBe(false);
      expect(res.category_id).toBeNull();
    });
  });

  describe('Acceptance: "no date/time-only selection path exists in code"', () => {
    it('the C2 gate source contains no date/clock APIs (static scan)', () => {
      const srcPath = path.join(__dirname, '..', 'src', 'gates', 'c2', 'index.ts');
      const raw = fs.readFileSync(srcPath, 'utf8');

      // Strip comments so prose mentioning "date/calendar" cannot cause a false
      // positive; we are asserting the *executable* code has no clock lookup.
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (leave URLs like http:// alone)

      const forbidden = [
        /\bnew Date\b/,
        /\bDate\.now\b/,
        /\bDate\.UTC\b/,
        /\bDate\.parse\b/,
        /\.getDay\s*\(/,
        /\.getDate\s*\(/,
        /\.getMonth\s*\(/,
        /\.getFullYear\s*\(/,
        /\.getHours\s*\(/,
        /\bperformance\.now\b/,
      ];
      for (const pattern of forbidden) {
        expect(code).not.toMatch(pattern);
      }
    });

    it('identical signals resolve deterministically regardless of when called', async () => {
      await seedTaxonomy(TENANT_A);
      const a = await c2.selectCategory({ situation: 'victory' }, TENANT_A);
      const b = await c2.selectCategory({ situation: 'victory' }, TENANT_A);
      expect(a.category_id).toBe(b.category_id);
      expect(a.available_assets).toEqual(b.available_assets);
    });
  });

  describe('Acceptance: Adversity empty by design; Friday protected', () => {
    beforeEach(async () => {
      await seedTaxonomy(TENANT_A);
    });

    it('Adversity resolves but yields no assets (not pre-stocked, empty by design)', async () => {
      const res = await c2.selectCategory({ category_id: 'adversity' }, TENANT_A);
      expect(res.matched).toBe(true);
      expect(res.prestocked).toBe(false);
      expect(res.available_assets).toEqual([]);
    });

    it('Friday resolves as protected and is returned as-is (never downgraded)', async () => {
      const res = await c2.selectCategory({ situation: 'Friday' }, TENANT_A);
      expect(res.matched).toBe(true);
      expect(res.category_id).toBe('friday');
      expect(res.protected).toBe(true);
      // A protected category is returned exactly as resolved — not swapped for another.
      expect(res.available_assets).toEqual(['friday_special']);
    });
  });

  describe('Acceptance: tenant isolation', () => {
    it("a tenant's taxonomy is not visible to another tenant", async () => {
      await seedTaxonomy(TENANT_A);
      // Tenant B has no taxonomy at all -> Section 5A guard fires for B.
      await expect(c2.selectCategory({ category_id: 'victory' }, TENANT_B)).rejects.toBeInstanceOf(
        TaxonomyNotSeededError,
      );
    });

    it('a situational label resolves only within the calling tenant', async () => {
      await seedTaxonomy(TENANT_A);
      await categorySchema.upsertCategory({
        tenant_id: TENANT_B,
        category_id: 'chaos',
        name: 'Chaos',
        prestocked_flag: true,
        asset_list: ['b_only'],
      });
      // "victory" exists for A but not B.
      const bMiss = await c2.selectCategory({ situation: 'victory' }, TENANT_B);
      expect(bMiss.matched).toBe(false);
      // "chaos" exists for B but not A.
      const aMiss = await c2.selectCategory({ situation: 'chaos' }, TENANT_A);
      expect(aMiss.matched).toBe(false);
    });
  });

  describe('Zilly Section 11 taxonomy seed', () => {
    it('seeds all 9 categories with the mandated flags', async () => {
      const summary = await seedZilly();
      expect(summary.categories_loaded).toBe(9);

      const cats = await categorySchema.listCategories(ZILLY_TENANT_ID);
      expect(cats.length).toBe(9);
      expect(ZILLY_CATEGORIES.length).toBe(9);

      const adversity = cats.find((c) => c.category_id === 'adversity');
      const friday = cats.find((c) => c.category_id === 'friday');
      expect(adversity?.prestocked_flag).toBe(false); // empty by design
      expect(friday?.protected_flag).toBe(true); // protected — never downgraded
    });

    it('C2 can select a Zilly category once seeded', async () => {
      await seedZilly();
      const res = await c2.selectCategory({ situation: 'Gentle Start' }, ZILLY_TENANT_ID);
      expect(res.matched).toBe(true);
      expect(res.category_id).toBe('gentle_start');
    });
  });
});
