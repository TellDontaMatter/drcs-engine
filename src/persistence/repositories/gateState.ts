/**
 * GateState repository (Blueprint Section 20 step 2 — freeze mechanism support).
 *
 * Tracks per-tenant, per-gate freeze state. C1 freezes itself when its canonical
 * audit detects corruption; validate() then blocks until a human clears the freeze.
 */
import { prisma } from '../client';

export interface GateStateData {
  tenant_id: string;
  gate_id: string;
  frozen: boolean;
  frozen_reason: string | null;
  frozen_at: Date | null;
}

/**
 * Read a gate's freeze state for a tenant. Returns an unfrozen default when no
 * row exists yet.
 * @param tenant_id Tenant identifier.
 * @param gate_id Gate identifier, e.g. "C1".
 */
export async function getGateState(
  tenant_id: string,
  gate_id: string,
): Promise<GateStateData> {
  const row = await prisma.gateState.findUnique({
    where: { tenant_id_gate_id: { tenant_id, gate_id } },
  });
  if (!row) {
    return { tenant_id, gate_id, frozen: false, frozen_reason: null, frozen_at: null };
  }
  return row;
}

/**
 * Freeze a gate for a tenant (pending human review).
 * @param tenant_id Tenant identifier.
 * @param gate_id Gate identifier.
 * @param reason Why the gate was frozen.
 */
export async function freezeGate(
  tenant_id: string,
  gate_id: string,
  reason: string,
): Promise<GateStateData> {
  return prisma.gateState.upsert({
    where: { tenant_id_gate_id: { tenant_id, gate_id } },
    create: { tenant_id, gate_id, frozen: true, frozen_reason: reason, frozen_at: new Date() },
    update: { frozen: true, frozen_reason: reason, frozen_at: new Date() },
  });
}

/**
 * Clear a gate's freeze (human-confirmed correction).
 * @param tenant_id Tenant identifier.
 * @param gate_id Gate identifier.
 */
export async function unfreezeGate(
  tenant_id: string,
  gate_id: string,
): Promise<GateStateData> {
  return prisma.gateState.upsert({
    where: { tenant_id_gate_id: { tenant_id, gate_id } },
    create: { tenant_id, gate_id, frozen: false, frozen_reason: null, frozen_at: null },
    update: { frozen: false, frozen_reason: null, frozen_at: null },
  });
}
