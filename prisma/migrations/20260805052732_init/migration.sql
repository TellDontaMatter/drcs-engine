-- CreateTable
CREATE TABLE "TenantConfig" (
    "tenant_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "quarantine_list" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GateState" (
    "tenant_id" TEXT NOT NULL,
    "gate_id" TEXT NOT NULL,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "frozen_reason" TEXT,
    "frozen_at" DATETIME,

    PRIMARY KEY ("tenant_id", "gate_id")
);

-- CreateTable
CREATE TABLE "AssetRegistry" (
    "tenant_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "category" TEXT,
    "parent_asset_id" TEXT,
    "content_hash" TEXT,
    "sealed_hash" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("tenant_id", "asset_id")
);

-- CreateTable
CREATE TABLE "CategorySchema" (
    "tenant_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protected_flag" BOOLEAN NOT NULL DEFAULT false,
    "prestocked_flag" BOOLEAN NOT NULL DEFAULT false,
    "asset_list" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("tenant_id", "category_id")
);

-- CreateTable
CREATE TABLE "UsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "deployed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deployment_context" TEXT
);

-- CreateTable
CREATE TABLE "GovernanceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "confidence_tag" TEXT,
    "register" TEXT,
    "shift_strength" TEXT,
    "allowed_to_acknowledge" TEXT,
    "must_not_presume" TEXT,
    "belongs_here" BOOLEAN NOT NULL DEFAULT false,
    "disposition" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProposalApprovalLog" (
    "proposal_id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "items" TEXT NOT NULL DEFAULT '[]',
    "confidence" TEXT NOT NULL DEFAULT '[]',
    "rationale" TEXT NOT NULL DEFAULT '[]',
    "approval_status" TEXT NOT NULL,
    "approved_items" TEXT NOT NULL DEFAULT '[]',
    "approved_by" TEXT,
    "approved_at" DATETIME,
    "mode" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentConfiguration" (
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "role_scope" TEXT,
    "ground_truth_version" TEXT,
    "scoped_instruction_version" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("tenant_id", "agent_id")
);

-- CreateIndex
CREATE INDEX "AssetRegistry_tenant_id_idx" ON "AssetRegistry"("tenant_id");

-- CreateIndex
CREATE INDEX "AssetRegistry_tenant_id_tag_idx" ON "AssetRegistry"("tenant_id", "tag");

-- CreateIndex
CREATE INDEX "AssetRegistry_tenant_id_parent_asset_id_idx" ON "AssetRegistry"("tenant_id", "parent_asset_id");

-- CreateIndex
CREATE INDEX "CategorySchema_tenant_id_idx" ON "CategorySchema"("tenant_id");

-- CreateIndex
CREATE INDEX "UsageLog_tenant_id_idx" ON "UsageLog"("tenant_id");

-- CreateIndex
CREATE INDEX "UsageLog_tenant_id_asset_id_idx" ON "UsageLog"("tenant_id", "asset_id");

-- CreateIndex
CREATE INDEX "GovernanceRecord_tenant_id_idx" ON "GovernanceRecord"("tenant_id");

-- CreateIndex
CREATE INDEX "ProposalApprovalLog_tenant_id_idx" ON "ProposalApprovalLog"("tenant_id");

-- CreateIndex
CREATE INDEX "AgentConfiguration_tenant_id_idx" ON "AgentConfiguration"("tenant_id");
