/**
 * C3 — REPETITION GOVERNOR (Blueprint Section 20 step 5; locked params:
 * max_count=3, rolling_window=30 days, counting_unit=per deployment instance).
 *
 * C3 enforces that an asset is not deployed more than `max_count` times within a
 * rolling window of `rolling_window_days`. Counting is PER DEPLOYMENT INSTANCE,
 * regardless of category — every row in the usage log counts.
 *
 * FAIL CLOSED (Blueprint): on ANY usage-log integrity issue — a query error, a
 * row with a missing/invalid timestamp, or a future-dated deployment (a sign of
 * tampering or clock skew) — the gate denies (`allowed: false`) and sets
 * `failed_closed: true`. It never fails open to preserve cadence.
 *
 * Contract (Section 17): check_repetition(asset_id, tenant_params)
 *   -> { allowed, current_count, window_remaining }.
 *
 * Unlike C2, C3 legitimately uses time (the rolling window). `now` is injectable
 * through the params purely for deterministic testing; it defaults to the real
 * wall clock.
 */
import {
  C3_LOCKED_PARAMS,
  RepetitionParams,
  RepetitionResult,
} from '../../types';
import * as usageLog from '../../persistence/repositories/usageLog';

/** Identifier used for this gate. */
export const GATE_ID = 'C3' as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Build a fail-closed result (deny), used for every integrity issue. */
function failClosed(current_count: number, reason: string): RepetitionResult {
  return {
    allowed: false,
    current_count,
    window_remaining_ms: 0,
    failed_closed: true,
    reason: `C3 failed closed: ${reason}`,
  };
}

/**
 * Check whether one more deployment of an asset is permitted under the rolling
 * repetition cap.
 *
 * @param asset_id Asset identifier to check.
 * @param tenant_params Tenant id + optional param overrides (default to locked
 *   blueprint values) + optional injectable `now`.
 */
export async function checkRepetition(
  asset_id: string,
  tenant_params: RepetitionParams,
): Promise<RepetitionResult> {
  const maxCount = tenant_params.max_count ?? C3_LOCKED_PARAMS.max_count;
  const windowDays = tenant_params.rolling_window_days ?? C3_LOCKED_PARAMS.rolling_window_days;
  const now = tenant_params.now ?? new Date();

  // Guard against nonsensical params (treat as an integrity issue → fail closed).
  if (
    !Number.isFinite(maxCount) ||
    maxCount < 0 ||
    !Number.isFinite(windowDays) ||
    windowDays <= 0 ||
    isNaN(now.getTime())
  ) {
    return failClosed(0, `invalid parameters (max_count=${maxCount}, window_days=${windowDays})`);
  }

  const windowMs = windowDays * MS_PER_DAY;
  const windowStart = new Date(now.getTime() - windowMs);

  let deployments;
  try {
    deployments = await usageLog.listDeploymentsSince(
      tenant_params.tenant_id,
      asset_id,
      windowStart,
    );
  } catch (err) {
    // Any log read failure → fail closed (never assume zero usage).
    return failClosed(0, `usage-log read error (${err instanceof Error ? err.message : 'unknown'})`);
  }

  // Integrity validation on every in-window row.
  for (const d of deployments) {
    if (!(d.deployed_at instanceof Date) || isNaN(d.deployed_at.getTime())) {
      return failClosed(
        deployments.length,
        `usage-log row "${d.id}" has an invalid deployed_at timestamp`,
      );
    }
    if (d.deployed_at.getTime() > now.getTime()) {
      return failClosed(
        deployments.length,
        `usage-log row "${d.id}" is future-dated (${d.deployed_at.toISOString()} > now); possible tampering or clock skew`,
      );
    }
  }

  const currentCount = deployments.length;
  const allowed = currentCount < maxCount;

  if (allowed) {
    return {
      allowed: true,
      current_count: currentCount,
      window_remaining_ms: 0,
      failed_closed: false,
      reason:
        `${currentCount}/${maxCount} deployments in the last ${windowDays} day(s); ` +
        `one more is permitted`,
    };
  }

  // Blocked: compute how long until enough of the oldest in-window deployments
  // age out of the window to drop the count below max_count.
  // Need (currentCount - maxCount + 1) of the oldest to expire; `deployments` is
  // ordered oldest-first, so that is the element at index (currentCount - maxCount).
  const kthOldestIndex = currentCount - maxCount; // >= 0 when blocked
  const kthOldest = deployments[kthOldestIndex];
  const expiresAt = kthOldest.deployed_at.getTime() + windowMs;
  const windowRemainingMs = Math.max(0, expiresAt - now.getTime());

  return {
    allowed: false,
    current_count: currentCount,
    window_remaining_ms: windowRemainingMs,
    failed_closed: false,
    reason:
      `${currentCount}/${maxCount} deployments in the last ${windowDays} day(s); ` +
      `cap reached — next allowed in ${windowRemainingMs} ms`,
  };
}
