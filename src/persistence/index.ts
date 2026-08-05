/**
 * Persistence layer barrel (Blueprint Section 14 / 20 step 2).
 * Re-exports the tenant-scoped repositories and the Prisma client.
 */
export { prisma } from './client';
export * as assetRegistry from './repositories/assetRegistry';
export * as tenantConfig from './repositories/tenantConfig';
export * as gateState from './repositories/gateState';
export * as proposalApprovalLog from './repositories/proposalApprovalLog';
