# DRCS Engine

**Dynamic Response Content System** — one canonical codebase, eight gates (**C1–C8**),
fully multi-tenant. Every gate is a standalone, independently-invocable, pure-ish
function whose behavior is driven by per-tenant **configuration**, never by hardcoded
tenant/asset identifiers.

This repository currently implements **Section 20, steps 1–3** of the approved
blueprint:

1. **C1 — Source of Truth Lock** (the foundation gate)
2. **The tenant-scoped persistence layer** (all six Section 14 data schemas)
3. **C6 — Message-Idea Governance** (the runtime entry point; produces a disposition + record)

The remaining gates (C2, C3, C4, C5, C7, C8) are intentionally not yet implemented —
they come later in the blueprint implementation sequence.

---

## Architecture overview

```
src/
├── types/                     # Shared domain types (AssetTag taxonomy, result shapes)
├── persistence/               # Section 14 persistence layer (tenant-scoped)
│   ├── client.ts              # PrismaClient singleton
│   └── repositories/
│       ├── assetRegistry.ts       # Asset Registry (C1, C2, C4, C5)
│       ├── tenantConfig.ts        # Per-tenant config incl. quarantine list
│       ├── gateState.ts           # Per-tenant/per-gate freeze state
│       ├── proposalApprovalLog.ts # Proposal/Approval log (C7) — APPEND-ONLY
│       └── governanceRecord.ts    # Governance Record (C6) — historically queryable
├── gates/
│   ├── c1/                    # C1 — Source of Truth Lock
│   └── c6/                    # C6 — Message-Idea Governance
├── seeds/
│   └── zilly.ts               # Zilly reference-deployment seed (first tenant)
└── index.ts                   # Public entry point
prisma/
├── schema.prisma              # All six Section 14 schemas + foundation tables
└── migrations/0_init/         # Migration baseline
tests/                         # Jest tests (Section 19 acceptance tests for C1)
```

### Key design principles

- **Multi-tenancy is a security boundary.** `tenant_id` is threaded through every
  function and is part of the composite primary key of every table. No query can
  return another tenant's rows; cross-tenant access is a failure condition.
- **Gates are pure w.r.t. their inputs + the tenant's stored state.** No hidden
  module-level mutable state, no hardcoded tenant/asset ids in gate logic.
- **Configuration over code.** The quarantine list, freeze state, and canonical set
  are all stored per tenant — the same code serves every deployment.
- **TypeScript strict mode** across the whole project; every public function has a
  JSDoc comment referencing the blueprint section it implements.

### Database

Prisma-based and **database-agnostic**:

| Environment        | Provider   |
|--------------------|------------|
| Local dev / tests  | SQLite (no external services needed) |
| Production         | PostgreSQL (set `DATABASE_URL` to a `postgresql://` URL and change `provider` in `prisma/schema.prisma`) |

List-valued columns are stored as JSON-encoded `String` (serialized/parsed in the
repository layer) so the identical schema compiles on both SQLite and PostgreSQL.

---

## C1 — Source of Truth Lock

```ts
validate(asset_id: string, claimed_tag: AssetTag, tenant_id: string)
  => Promise<{ valid: boolean; tag: AssetTag | null; reason: string }>
```

Three-tag taxonomy: `canonical` | `derivative_edit` | `derivative_new`.

Enforcement order inside `validate()`:

1. **Freeze check** — while the gate is frozen for the tenant, every call returns
   `{ valid: false, reason: "C1 frozen pending human review" }`.
2. **Unknown-tag guard.**
3. **Source of truth** — the asset must be registered for the tenant.
4. **Quarantine** — any asset whose lineage traces (directly *or transitively*) back
   to a quarantined source is auto-rejected, **even when claimed as `derivative_edit`
   / `derivative_new`**. The quarantine list is per-tenant configuration.
5. **Canonical lock** — a derivative (by tag *or* by having a parent) can **never**
   validate as `canonical` under any claim.
6. **Tag consistency** — the claim must match the source-of-truth tag.

Supporting operations:

- `auditCanonicalIntegrity(tenant_id)` — scans all `canonical` assets and flags any
  that were modified (`content_hash != sealed_hash`) or whose parent chain is
  inconsistent. On any finding it **freezes** the gate for that tenant.
- `isFrozen(tenant_id)` / `clearFreeze(tenant_id)` — inspect / clear the freeze after
  human-confirmed correction.

---

## C6 — Message-Idea Governance

```ts
govern(trigger: SituationalTrigger, tenant_id: string)
  => Promise<{ disposition: Disposition; record: GovernanceRecordData }>
```

C6 **runs first**, upstream of all selection. It takes a raw situational trigger and
produces both a structured governance **record** and one of **four explicit
dispositions** (a four-state model, *not* pass/fail):

| Disposition | Meaning |
|-------------|---------|
| `PUBLISH` | Governance passed — proceed downstream (to C2). |
| `REJECT_AND_RECORD` | Definite no — logged with rationale, loop exits, no substitute generated. |
| `REROUTE_FOR_RECLASSIFICATION` | Situational read likely wrong — needs a corrected C6 pass before re-entry. |
| `HOLD_FOR_HUMAN_REVIEW` | Genuine ambiguity — loop pauses; never silently proceeds or rejects. |

Disposition precedence inside `decideDisposition()` (pure, exported for testing):

1. **REJECT** — explicit reviewer reject directive, or `appropriate === false`.
2. **HOLD** — explicit hold directive, `confidence_tag === 'ambiguous'`, or
   high-stakes + low-confidence.
3. **REROUTE** — `belongs_here === false`.
4. **PUBLISH** — otherwise.

**Binding constraint (Section 7 — no silent downgrade):** steps 1–2 (the two
*protected* dispositions) are evaluated first and return immediately, so cadence
pressure can never turn a `REJECT`/`HOLD` into a `PUBLISH`/`REROUTE`. Silence is an
acceptable outcome.

The two Section 6 descriptive fields — `allowed_to_acknowledge` (what the message may
acknowledge, e.g. *"it's late; the deadline is close"*) and `must_not_presume` (what it
must not assume, e.g. *"that the student is panicking"*) — are stored as **text and are
never null**. A record is written for **every** trigger, making governance decisions
historically queryable per tenant via `governanceRecord.listRecords(tenant_id, filter?)`.

---

## Persistence — Section 14 schemas

All six schemas are defined in `prisma/schema.prisma`, each carrying `tenant_id`:

| Schema | Used by | Notes |
|--------|---------|-------|
| `AssetRegistry` | C1, C2, C4, C5 | canonical/derivative taxonomy, parent lineage, integrity hashes |
| `CategorySchema` | C2 | |
| `UsageLog` | C3 | |
| `GovernanceRecord` | C6 | tenant-approver scoped |
| `ProposalApprovalLog` | C7 | **append-only** — repo exposes only create + read |
| `AgentConfiguration` | C8 | |

Plus two foundation tables required to run C1 in a config-driven way:
`TenantConfig` (holds the quarantine list) and `GateState` (freeze state).

---

## Zilly reference deployment (first tenant)

`src/seeds/zilly.ts` establishes the first tenant:

- Creates the **Zilly** tenant and its quarantine list
  `["CapyCardioRef", "002", ... "009"]`.
- Loads the **8 confirmed-exported canonical clips**
  (`01_double_bounce_launch` … `08_victory_jump`) as `canonical` assets.
- **Does not** register `CapyCardioRef` or Drive files `002–009` — they are
  quarantined, not registered.

---

## Getting started

```bash
# 1. Install
npm install

# 2. Generate the Prisma client
npm run prisma:generate

# 3. Create the local SQLite dev DB from the schema
npm run db:push          # uses DATABASE_URL from .env (file:./dev.db)

# 4. Seed the Zilly reference deployment
npm run seed:zilly

# 5. Run the tests (Section 19 acceptance tests). Uses an isolated SQLite test DB —
#    no external database required.
npm test

# Type-check / build
npm run lint
npm run build
```

### Tests

`npm test` provisions a throwaway SQLite database (`prisma/test.db`), applies the
schema, and runs the Jest suites covering the Section 19 acceptance tests for C1:

- **Canonical lock holds** — a derivative cannot validate as canonical under any claim.
- **Quarantine enforced** — assets deriving from a quarantined source (direct or
  transitive) are auto-rejected, even under a derivative claim.
- **Freeze behavior** — a frozen gate blocks all `validate()` calls; the canonical
  audit freezes the gate on detected corruption.
- **Tenant isolation** — tenant A's assets are not accessible via tenant B's
  `validate()` call, and a freeze on one tenant does not affect another.

---

## Production (PostgreSQL)

1. In `prisma/schema.prisma`, set `datasource db { provider = "postgresql" }`.
2. Set `DATABASE_URL` to your `postgresql://…` connection string.
3. `npx prisma migrate deploy` to apply migrations.
