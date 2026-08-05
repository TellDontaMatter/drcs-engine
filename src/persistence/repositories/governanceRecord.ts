/**
 * GovernanceRecord repository (Blueprint Section 14 — used by C6).
 *
 * C6 produces a structured governance record for EVERY situational trigger it
 * governs (Section 6: "Produces a disposition, not just a record"). Records are
 * historically queryable per tenant (Section 14) and access is restricted to a
 * tenant's own approvers (Section 18) — enforced here by threading `tenant_id`
 * through every query so there is no cross-tenant visibility.
 *
 * Records are append-and-read from the engine's perspective (a governance
 * decision is a historical fact); this module exposes create + read only.
 */
import { prisma } from '../client';
import { Disposition, GovernanceRecordData, isDisposition } from '../../types';

export interface CreateGovernanceInput {
  tenant_id: string;
  condition: string;
  confidence_tag?: string | null;
  register?: string | null;
  shift_strength?: string | null;
  allowed_to_acknowledge: string;
  must_not_presume: string;
  belongs_here: boolean;
  disposition: Disposition;
}

function rowToRecord(row: {
  id: string;
  tenant_id: string;
  condition: string;
  confidence_tag: string | null;
  register: string | null;
  shift_strength: string | null;
  allowed_to_acknowledge: string | null;
  must_not_presume: string | null;
  belongs_here: boolean;
  disposition: string | null;
  created_at: Date;
}): GovernanceRecordData {
  // The stored disposition is written only via this repository from a strict
  // Disposition union, so it is always valid; guard defensively regardless.
  const disposition: Disposition = isDisposition(row.disposition)
    ? row.disposition
    : Disposition.HOLD_FOR_HUMAN_REVIEW;

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    condition: row.condition,
    confidence_tag: row.confidence_tag,
    register: row.register,
    shift_strength: row.shift_strength,
    allowed_to_acknowledge: row.allowed_to_acknowledge,
    must_not_presume: row.must_not_presume,
    belongs_here: row.belongs_here,
    disposition,
    created_at: row.created_at,
  };
}

/**
 * Persist a governance record. Called once per governed trigger.
 * @param input Fully-resolved governance fields (descriptive text already composed).
 */
export async function createRecord(
  input: CreateGovernanceInput,
): Promise<GovernanceRecordData> {
  const row = await prisma.governanceRecord.create({
    data: {
      tenant_id: input.tenant_id,
      condition: input.condition,
      confidence_tag: input.confidence_tag ?? null,
      register: input.register ?? null,
      shift_strength: input.shift_strength ?? null,
      allowed_to_acknowledge: input.allowed_to_acknowledge,
      must_not_presume: input.must_not_presume,
      belongs_here: input.belongs_here,
      disposition: input.disposition,
    },
  });
  return rowToRecord(row);
}

/**
 * Read a single governance record by id within a tenant, or null if absent.
 * Tenant-scoped: a record belonging to another tenant is never returned.
 * @param tenant_id Tenant identifier.
 * @param id Governance record identifier.
 */
export async function getRecord(
  tenant_id: string,
  id: string,
): Promise<GovernanceRecordData | null> {
  const row = await prisma.governanceRecord.findFirst({
    where: { tenant_id, id },
  });
  return row ? rowToRecord(row) : null;
}

/**
 * List governance records for a tenant (chronological), optionally filtered by
 * disposition. Supports the Section 14 "historically queryable per tenant"
 * requirement.
 * @param tenant_id Tenant identifier.
 * @param filter Optional disposition filter.
 */
export async function listRecords(
  tenant_id: string,
  filter?: { disposition?: Disposition },
): Promise<GovernanceRecordData[]> {
  const rows = await prisma.governanceRecord.findMany({
    where: {
      tenant_id,
      ...(filter?.disposition ? { disposition: filter.disposition } : {}),
    },
    orderBy: { created_at: 'asc' },
  });
  return rows.map(rowToRecord);
}
