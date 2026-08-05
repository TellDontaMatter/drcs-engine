/**
 * C2 — SITUATIONAL BANK (Blueprint Section 11 taxonomy, Section 5A seed
 * prerequisite, Section 19 acceptance test, Section 20 step 4).
 *
 * C2 organizes content by situational category and resolves the correct category
 * from a REAL-TIME condition signal.
 *
 * HARD CONSTRAINT (Section 19): selection is driven exclusively by the situational
 * condition signal. There is deliberately NO selection path that reads a date, a
 * time, a weekday, or any calendar/wall-clock source. This gate contains no such
 * lookup, and the acceptance tests statically assert the compiled source is free
 * of date/clock APIs. Even the "Friday" category is resolved because an upstream
 * signal reports the Friday *situation*, never because the engine checked the day.
 *
 * SECTION 5A PREREQUISITE: the tenant's taxonomy must be seeded before
 * selectCategory() can function. If a tenant has no categories, selectCategory()
 * throws {@link TaxonomyNotSeededError} rather than silently returning nothing.
 *
 * Contract (Section 17): select_category(condition_signal, tenant_config)
 *   -> { category_id, available_assets[] }.
 *
 * The second contract argument (tenant_config) is realized here as `tenant_id`:
 * the tenant's configured taxonomy is loaded from tenant-scoped persistence,
 * consistent with every other gate (no hardcoded tenant/category ids in logic).
 */
import { ConditionSignal, SelectCategoryResult } from '../../types';
import * as categorySchema from '../../persistence/repositories/categorySchema';
import type { CategoryRecordData } from '../../types';

/** Identifier used for this gate. */
export const GATE_ID = 'C2' as const;

/**
 * Thrown when selectCategory() is called for a tenant whose situational taxonomy
 * has not been seeded (Blueprint Section 5A build-order prerequisite).
 */
export class TaxonomyNotSeededError extends Error {
  public readonly tenant_id: string;
  constructor(tenant_id: string) {
    super(
      `C2 taxonomy not seeded for tenant "${tenant_id}": the situational bank must ` +
        `be seeded before select_category() can function (Blueprint Section 5A)`,
    );
    this.name = 'TaxonomyNotSeededError';
    this.tenant_id = tenant_id;
  }
}

/** Build a result object from a resolved category. */
function toResult(category: CategoryRecordData, reason: string): SelectCategoryResult {
  return {
    category_id: category.category_id,
    available_assets: [...category.asset_list],
    matched: true,
    protected: category.protected_flag,
    prestocked: category.prestocked_flag,
    reason,
  };
}

/** Build the "no match" result (never falls back to a date-based selection). */
function noMatch(reason: string): SelectCategoryResult {
  return {
    category_id: null,
    available_assets: [],
    matched: false,
    protected: false,
    prestocked: false,
    reason,
  };
}

/**
 * Resolve a situational category from a real-time condition signal and return the
 * category id plus the assets available within it.
 *
 * Resolution order (signal-only — there is no date/calendar branch):
 *   1. Section 5A guard — the tenant's taxonomy must be seeded, else throw.
 *   2. Explicit `signal.category_id` (exact id match).
 *   3. `signal.situation` matched against category names (case-insensitive).
 *   4. Neither supplied, or no match -> a "no match" result. Selection NEVER falls
 *      back to the calendar to preserve cadence; returning no category is valid.
 *
 * A protected category (e.g. "Friday") that resolves from the signal is returned
 * exactly as-is, with `protected: true`; the gate performs no substitution or
 * downgrade of a resolved category under any circumstances.
 *
 * @param condition_signal The real-time situational signal.
 * @param tenant_id Tenant identifier (loads the tenant's configured taxonomy).
 */
export async function selectCategory(
  condition_signal: ConditionSignal,
  tenant_id: string,
): Promise<SelectCategoryResult> {
  // 1. Section 5A prerequisite — taxonomy must be seeded.
  const categoryCount = await categorySchema.countCategories(tenant_id);
  if (categoryCount === 0) {
    throw new TaxonomyNotSeededError(tenant_id);
  }

  // 2. Explicit category id wins.
  if (condition_signal.category_id) {
    const byId = await categorySchema.getCategory(tenant_id, condition_signal.category_id);
    if (byId) {
      return toResult(
        byId,
        `Resolved category "${byId.category_id}" from explicit signal.category_id`,
      );
    }
    return noMatch(
      `No category "${condition_signal.category_id}" configured for tenant "${tenant_id}"`,
    );
  }

  // 3. Situational label -> category name (case-insensitive).
  if (condition_signal.situation) {
    const byName = await categorySchema.getCategoryByName(tenant_id, condition_signal.situation);
    if (byName) {
      return toResult(
        byName,
        `Resolved category "${byName.category_id}" from situational signal "${condition_signal.situation}"`,
      );
    }
    return noMatch(
      `No category matches situation "${condition_signal.situation}" for tenant "${tenant_id}"`,
    );
  }

  // 4. No usable signal — do NOT fall back to any calendar/clock source.
  return noMatch(
    'No condition signal supplied (category_id or situation required); ' +
      'C2 never selects from a date/calendar source',
  );
}
