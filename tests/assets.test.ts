/**
 * CONTENT RETRIEVAL LAYER tests.
 *
 * Covers `resolveAsset` (asset -> file_path + caption) and
 * `findAssetByCategory` (category -> first resolvable asset). Every case is
 * tenant-scoped; no test makes a network or LLM call.
 */
import { resolveAsset, findAssetByCategory } from '../src/assets';
import * as assetRegistry from '../src/persistence/repositories/assetRegistry';
import * as categorySchema from '../src/persistence/repositories/categorySchema';

const TENANT = 'zilly';

describe('Content Retrieval — resolveAsset', () => {
  it('returns file_path + caption for an asset that has a file attached', async () => {
    await assetRegistry.createAsset({
      tenant_id: TENANT,
      asset_id: 'a1',
      tag: 'canonical',
      category: 'victory',
      caption: 'We did it!',
      file_path: '/media/zilly/a1.mp4',
    });

    const resolved = await resolveAsset(TENANT, 'a1');
    expect(resolved).not.toBeNull();
    expect(resolved?.file_path).toBe('/media/zilly/a1.mp4');
    expect(resolved?.caption).toBe('We did it!');
  });

  it('returns a null file_path (but still the caption) when no file is attached yet', async () => {
    await assetRegistry.createAsset({
      tenant_id: TENANT,
      asset_id: 'a2',
      tag: 'canonical',
      category: 'victory',
      caption: 'Not uploaded yet',
    });

    const resolved = await resolveAsset(TENANT, 'a2');
    expect(resolved).not.toBeNull();
    expect(resolved?.file_path).toBeNull();
    expect(resolved?.caption).toBe('Not uploaded yet');
  });

  it('returns null for an asset that does not exist', async () => {
    const resolved = await resolveAsset(TENANT, 'missing');
    expect(resolved).toBeNull();
  });

  it('does not cross tenants', async () => {
    await assetRegistry.createAsset({
      tenant_id: 'other',
      asset_id: 'a3',
      tag: 'canonical',
      caption: 'other tenant asset',
      file_path: '/media/other/a3.mp4',
    });

    // Same asset id, different tenant -> not visible.
    const resolved = await resolveAsset(TENANT, 'a3');
    expect(resolved).toBeNull();
  });
});

describe('Content Retrieval — findAssetByCategory', () => {
  it('returns the first asset in the category asset order', async () => {
    await assetRegistry.createAsset({
      tenant_id: TENANT,
      asset_id: 'first',
      tag: 'canonical',
      caption: 'First clip',
      file_path: '/media/zilly/first.mp4',
    });
    await assetRegistry.createAsset({
      tenant_id: TENANT,
      asset_id: 'second',
      tag: 'canonical',
      caption: 'Second clip',
      file_path: '/media/zilly/second.mp4',
    });
    await categorySchema.upsertCategory({
      tenant_id: TENANT,
      category_id: 'victory',
      name: 'Victory',
      asset_list: ['first', 'second'],
    });

    const resolved = await findAssetByCategory(TENANT, 'victory');
    expect(resolved).not.toBeNull();
    expect(resolved?.asset_id).toBe('first');
    expect(resolved?.file_path).toBe('/media/zilly/first.mp4');
    expect(resolved?.caption).toBe('First clip');
  });

  it('skips asset ids that are listed but not registered', async () => {
    await assetRegistry.createAsset({
      tenant_id: TENANT,
      asset_id: 'real',
      tag: 'canonical',
      caption: 'Real clip',
      file_path: '/media/zilly/real.mp4',
    });
    await categorySchema.upsertCategory({
      tenant_id: TENANT,
      category_id: 'victory',
      name: 'Victory',
      // 'ghost' is declared first but never registered -> skipped.
      asset_list: ['ghost', 'real'],
    });

    const resolved = await findAssetByCategory(TENANT, 'victory');
    expect(resolved?.asset_id).toBe('real');
  });

  it('returns null for an unknown category', async () => {
    const resolved = await findAssetByCategory(TENANT, 'nope');
    expect(resolved).toBeNull();
  });

  it('returns null for a category with an empty asset list', async () => {
    await categorySchema.upsertCategory({
      tenant_id: TENANT,
      category_id: 'empty',
      name: 'Empty',
      asset_list: [],
    });
    const resolved = await findAssetByCategory(TENANT, 'empty');
    expect(resolved).toBeNull();
  });

  it('returns null when none of the listed assets are registered', async () => {
    await categorySchema.upsertCategory({
      tenant_id: TENANT,
      category_id: 'victory',
      name: 'Victory',
      asset_list: ['ghost1', 'ghost2'],
    });
    const resolved = await findAssetByCategory(TENANT, 'victory');
    expect(resolved).toBeNull();
  });

  it('does not cross tenants', async () => {
    await assetRegistry.createAsset({
      tenant_id: 'other',
      asset_id: 'x1',
      tag: 'canonical',
      caption: 'other tenant',
      file_path: '/media/other/x1.mp4',
    });
    await categorySchema.upsertCategory({
      tenant_id: 'other',
      category_id: 'victory',
      name: 'Victory',
      asset_list: ['x1'],
    });

    // The category only exists for 'other' -> not visible to TENANT.
    const resolved = await findAssetByCategory(TENANT, 'victory');
    expect(resolved).toBeNull();
  });
});
