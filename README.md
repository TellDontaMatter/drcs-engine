# DRCS Engine

**Dynamic Response Content System** — one canonical codebase, eight gates (**C1–C8**),
fully multi-tenant. Every gate is a standalone, independently-invocable, pure-ish
function whose behavior is driven by per-tenant **configuration**, never by hardcoded
tenant/asset identifiers.

This repository currently implements **Section 20, steps 1–5** of the approved
blueprint:This repository currently implements **Section 20, steps 1–4 + step 6** of the
approved blueprint:
1. **C1 — Source of Truth Lock** (the foundation gate)
2. **The tenant-scoped persistence layer** (all six Section 14 data schemas)
3. **C6 — Message-Idea Governance** (the runtime entry point; produces a disposition + record)
4. **C2 — Situational Bank** (resolves a situational category from a real-time signal)
5. **C3 — Repetition Governor** (enforces per-asset deployment frequency caps over a rolling window)

The remaining gates (C4, C5, C7, C8) are intentionally not yet implemented —
they come later in the blueprint implementation sequence.6. **C4 — Caption-First Resolution** (reuses existing content via a strict 3-step ladder)

Step 5 (**C3 — Repetition Governor**) is delivered on its own branch/PR. The
remaining gates (C5, C7, C8) are intentionally not yet implemented — they come
later in the blueprint implementation sequence.
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
│       ├── categorySchema.ts      # Situational taxonomy (C2)
│       ├── proposalApprovalLog.ts # Proposal/Approval log (C7) — APPEND-ONLY
│       ├── governanceRecord.ts    # Governance Record (C6) — historically queryable
│       └── usageLog.ts            # Deployment usage log (C3) — append-only, tenant-scoped
├── gates/
│   ├── c1/                    # C1 — Source of Truth Lock
│   ├── c2/                    # C2 — Situational Bank
│   ├── c3/                    # C3 — Repetition Governor│   ├── c4/                    # C4 — Caption-First Resolution│   └── c6/                    # C6 — Message-Idea Governance
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

## C2 — Situational Bank

```ts
selectCategory(condition_signal: ConditionSignal, tenant_id: string)
  => Promise<{ category_id: string | null; available_assets: string[]; matched: boolean;
               protected: boolean; prestocked: boolean; reason: string }>
```

C2 organizes content by situational category and resolves the correct category from
a **real-time condition signal**.

**Hard constraint (Section 19 — no calendar selection):** selection is driven *only*
by the situational signal. There is deliberately **no** date/time/weekday/calendar
field on `ConditionSignal`, and the gate contains no clock lookup. A dedicated test
**statically scans the compiled gate source** and asserts it is free of date/clock
APIs (`new Date`, `Date.now`, `.getDay()`, …). Even the **Friday** category is chosen
because an upstream signal reports the Friday *situation*, never because the engine
read the calendar.

**Section 5A prerequisite (seed before select):** a tenant's taxonomy must be seeded
before `selectCategory()` can function. Calling it for a tenant with no categories
throws `TaxonomyNotSeededError` rather than silently returning nothing.

Resolution order (signal-only): explicit `category_id` → `situation` matched against
category names (case-insensitive) → otherwise a no-match result (never a date
fallback; returning no category is a valid outcome).

**Zilly taxonomy (Blueprint Section 11 — 9 categories):** Gentle Start, Building
Momentum, Chaos, Comic Relief, **Adversity** (empty by design — `prestocked_flag:
false`), Victory, Transition/Pivot, Weather-Specific, **Friday** (`protected_flag:
true` — never downgraded/substituted). A resolved protected category is returned
exactly as-is; the gate performs no downgrade of a resolved category.

---

## C3 — Repetition Governor

```ts
checkRepetition(asset_id: string, tenant_params: RepetitionParams)
  => Promise<{ allowed: boolean; current_count: number; window_remaining_ms: number;
               failed_closed: boolean; reason: string }>
```

C3 enforces how often a single asset may be deployed inside a rolling time window.
It reads the append-only `UsageLog` and decides whether one more deployment of
`asset_id` is permitted right now.

**Locked parameters (per the C3 contract):**

| Param | Value | Meaning |
|-------|-------|---------|
| `max_count` | `3` | at most 3 deployments per asset within the window |
| `rolling_window_days` | `30` | window is the trailing 30 days from *now* |
| `counting_unit` | `per_deployment_instance` | **every** deployment counts, regardless of situational category |

`C3_LOCKED_PARAMS` is exported from `src/types` so the contract values live in exactly
one place. `counting_unit` being *per deployment instance* means the same asset
deployed into two different categories still consumes two of its three slots — the
governor counts raw deployments, not distinct categories.

- `current_count` = deployments of the asset in the trailing window.
- `allowed` = `current_count < max_count`.
- `window_remaining_ms` = time until the engine would next permit a deployment; i.e.
  how long until enough of the oldest in-window deployments age past the window to
  drop the count below `max_count`. It is `0` whenever `allowed` is `true`.

**Fail-closed (binding):** any log-integrity problem returns `allowed: false` with
`failed_closed: true` rather than risking an over-deployment. The gate fails closed on
a query error, a missing or unparseable `deployed_at`, a **future-dated** row
(clock/tamper signal), or invalid parameters. Fail-closed results carry a `reason`
explaining the trip.

`now` is injectable via `tenant_params.now` purely so tests are deterministic; in
production it defaults to the real clock.## C4 — Caption-First Resolution

```ts
resolve(category_id: string, content_need: ContentNeed, tenant_id: string)
  => Promise<
       | { resolved: true;  escalate: false; asset_id: string; caption: string;
           resolution_step: 'existing_as_is' | 'recaption'; reason: string }
       | { resolved: false; escalate: true;  asset_id: null;   caption: null;
           resolution_step: 'escalate_to_c5'; reason: string }
     >
```

C4 satisfies a **content need** inside a category by *preferring reuse over
creation*. It walks a **strict, never-skipped 3-step ladder** and stops at the
first step that yields a usable asset:

1. **existing-as-is** — an asset already in the category whose **current caption**
   already satisfies the need → reuse it verbatim (returns the asset's own caption).
2. **recaption** — an asset in the category is reusable but its caption does not
   match → reuse the asset with the **needed** caption.
3. **escalate to C5** — no reusable asset in the category → `{ escalate: true }`.

**Never skip a step (binding):** recaption is only considered after the as-is scan
finds nothing; escalation is only returned after both prior steps produce nothing.
As-is always beats recaption, recaption always beats escalation — verified by
ordering tests (an as-is match wins even when a recaption candidate is listed first).

`content_need` carries the required `caption` plus optional `required_tag` and
`exclude_asset_ids` filters (e.g. to drop assets an upstream gate like C3 already
ruled out). Caption matching for the as-is step is case- and whitespace-insensitive.
Resolution is deterministic: assets are considered in `asset_list` order.

Invalid input throws rather than silently escalating: an empty `caption` throws
`InvalidContentNeedError`, and an unknown category throws `CategoryNotFoundError`
(distinct from a *known but empty* category, which legitimately escalates).

**Caption storage (design decision — flagged for review):** the blueprint's
caption-first contract implies a per-asset caption, but the Section 14 baseline had
no caption field. C4 adds a nullable `caption` column to `AssetRegistry` (migration
`20260805130000_c4_asset_caption`) and an `assetRegistry.updateCaption()` helper to
persist an accepted recaption. `resolve()` itself is a **pure decision** (it does
not mutate) — persisting a recaption is a downstream step.
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
