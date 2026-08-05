/**
 * ProposalApprovalLog repository (Blueprint Section 14 — used by C7).
 *
 * APPEND-ONLY by design (Security: "C7 Approval Log must be immutable once
 * approved"). This module intentionally exposes ONLY create + read operations —
 * there is no update and no delete. Do not add mutating operations here.
 */
import { prisma } from '../client';

export interface ProposalApprovalRecord {
  proposal_id: string;
  tenant_id: string;
  items: unknown[];
  confidence: unknown[];
  rationale: unknown[];
  approval_status: string;
  approved_items: unknown[];
  approved_by: string | null;
  approved_at: Date | null;
  mode: string | null;
  created_at: Date;
}

export interface AppendProposalInput {
  tenant_id: string;
  items: unknown[];
  confidence: unknown[];
  rationale: unknown[];
  approval_status: string;
  approved_items?: unknown[];
  approved_by?: string | null;
  approved_at?: Date | null;
  mode?: string | null;
}

/** Parse a JSON-encoded array column into an array (defensively). */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: {
  proposal_id: string;
  tenant_id: string;
  items: unknown;
  confidence: unknown;
  rationale: unknown;
  approval_status: string;
  approved_items: unknown;
  approved_by: string | null;
  approved_at: Date | null;
  mode: string | null;
  created_at: Date;
}): ProposalApprovalRecord {
  return {
    ...row,
    items: toArray(row.items),
    confidence: toArray(row.confidence),
    rationale: toArray(row.rationale),
    approved_items: toArray(row.approved_items),
  };
}

/**
 * Append a new proposal/approval entry. This is the ONLY write operation — once
 * written, an entry can never be updated or deleted through this repository.
 * @param input Proposal fields.
 */
export async function appendProposal(
  input: AppendProposalInput,
): Promise<ProposalApprovalRecord> {
  const row = await prisma.proposalApprovalLog.create({
    data: {
      tenant_id: input.tenant_id,
      items: JSON.stringify(input.items),
      confidence: JSON.stringify(input.confidence),
      rationale: JSON.stringify(input.rationale),
      approval_status: input.approval_status,
      approved_items: JSON.stringify(input.approved_items ?? []),
      approved_by: input.approved_by ?? null,
      approved_at: input.approved_at ?? null,
      mode: input.mode ?? null,
    },
  });
  return rowToRecord(row);
}

/**
 * Read one proposal by id within a tenant, or null if absent.
 * @param tenant_id Tenant identifier.
 * @param proposal_id Proposal identifier.
 */
export async function getProposal(
  tenant_id: string,
  proposal_id: string,
): Promise<ProposalApprovalRecord | null> {
  const row = await prisma.proposalApprovalLog.findFirst({
    where: { tenant_id, proposal_id },
  });
  return row ? rowToRecord(row) : null;
}

/**
 * List all proposals for a tenant (append order).
 * @param tenant_id Tenant identifier.
 */
export async function listProposals(
  tenant_id: string,
): Promise<ProposalApprovalRecord[]> {
  const rows = await prisma.proposalApprovalLog.findMany({
    where: { tenant_id },
    orderBy: { created_at: 'asc' },
  });
  return rows.map(rowToRecord);
}
