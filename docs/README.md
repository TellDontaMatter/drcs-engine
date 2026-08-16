# DRCS Engine — Master Documentation Index

> **Dynamic Response Content System (DRCS):** A content generation and governance engine that operates as eight configurable components serving as gates. Single canonical codebase with deployment-specific behavior via configuration only.

**Repo:** https://github.com/TellDontaMatter/drcs-engine  
**Current Phase:** Production Transition — core gates built, orchestrator operational, natural language entry point live.

---

## Core Principle

**One engine, eight configurable components, serving as gates.** No hardcoded tenant logic. Behavior is entirely driven by per-tenant configuration loaded from persistence.

---

## Library Structure

| Path | Contents | Status |
|---|---|---|
| `00-design-principles/` | Vision, constraints, locked parameters, architecture decisions | 🔒 Locked |
| `01-gates/` | C1–C6 individual gate docs: purpose, contract, acceptance, implementation | See table |
| `02-architecture/` | Systems ladder, integration map, what's built vs. what remains | ✅ |
| `03-operating-rules/` | Deployment, testing strategy, deployment runbooks | ✅ Complete |
| `04-reference/` | GitHub integration notes, PR history, handoff capsule | — |

---

## Gate Index

| Gate | Name | Purpose | Status |
|---|---|---|---|
| **C1** | Lock | Single-use content enforcement | ✅ Built & Tested |
| **C2** | Situational Bank | Real-time category resolution (signal-only, no calendar) | ✅ Built & Tested |
| **C3** | Governor | Rolling frequency cap (3/30-day per deployment instance) | ✅ Built & Tested |
| **C4** | Resolution | Caption-first 3-step ladder (as-is → recaption → escalate) | ✅ Built & Tested |
| **C5** | Generation | LLM-based fresh caption generation (Misalignment Protocol) | ✅ Built & Tested |
| **C6** | Governance | Message-Idea disposition (PUBLISH/REJECT/HOLD/REROUTE) | ✅ Built & Tested |
| **C7** | *(pending)* | Compliance gate (not yet designed) | 🔴 Not Implemented |
| **C8** | *(pending)* | Distribution gate (not yet designed) | 🔴 Not Implemented |

**Build Status:** 107 tests passing across 10 test suites. TypeScript build clean. All C1–C6 acceptance criteria verified.

---

## Architecture Ladder

The DRCS engine is built in layers, from persistence up to the orchestrator:

```
Natural Language Entry (evaluatePrompt)
   ↓
Orchestrator (C6 → C2 → C4 → C5 → C3)
   ↓
Six Gates (C1–C6) — each pure, testable, isolated
   ↓
Content Retrieval Layer (assets → file_path + caption)
   ↓
LLM Integration (Abacus routeLLM, gpt-4o-mini)
   ↓
Persistence (Prisma ORM, SQLite dev / PostgreSQL prod)
```

**Current Capability:** User submits natural language prompt → engine returns `file_path` + `caption` + audit trail. Categories WITH assets return real files; categories WITHOUT assets generate fresh captions via LLM.

---

## Deployment-Specific Behavior

Every gate is deployment-agnostic. Behavior is configured via:
- **Tenant Config** — default rolling caps, protected categories, policy overrides
- **Category Schema** — situational taxonomy, asset lists, protected/prestocked flags
- **Asset Registry** — canonical clips, captions, file paths, content hashes
- **Gate State** — locked assets (C1), usage history (C3), governance records (C6)

Zero hardcoded tenant IDs in gate logic. Example: Zilly is one tenant; adding a second tenant requires only seeding its config/categories/assets — no code changes.

---

## Key Design Decisions

### Rejected: Raw Gates Alone
**Problem:** The original vision was eight pure gates. It shipped as gears with no machine — gates returned *decisions* but didn't retrieve content or call the LLM.  
**Fix:** Added the **Orchestrator** layer (runs C6→C2→C4→C5→C3 sequence with short-circuiting) and **C5** (LLM generation so the pipeline doesn't dead-end at escalation).

### Added: Natural Language Entry Point
**Problem:** The multi-field form was unusable for non-technical users.  
**Fix:** Added `evaluatePrompt(tenant_id, prompt)` — one text input, LLM maps it to a category name from the tenant's taxonomy, engine handles the rest.

### Locked: C3 Parameters
- `max_count = 3`
- `rolling_window = 30 days`
- `counting_unit = per deployment instance`

Not configurable per request — enforcement is uniform across all tenants. Overrides require explicit tenant-config flags.

### Strict: 3-Step Resolution Before New Generation
C4 always checks:
1. **Existing-as-is** — exact caption match
2. **Recaption** — reuse asset, new caption
3. **Escalate to C5** — only if steps 1 & 2 fail

Never generates fresh content if existing content can be reused or recaptioned.

### Verified: No Calendar/Date Selection Path
C2 (Situational Bank) has **zero** date/time/weekday logic. Category resolution is driven exclusively by real-time condition signals. Static source scan test confirms no `Date()`, `getDay()`, calendar APIs in the compiled C2 output.

---

## Surfaces

| Surface | Path | Purpose |
|---|---|---|
| **Web Console** | `src/server` → http://localhost:3000 | Human-usable single-page form; prompt input + structured fallback |
| **CLI** | `src/cli` → `npm run evaluate` | Command-line evaluation; `--prompt` mode for natural language |
| **Programmatic API** | `src/index.ts` exports | `evaluate()`, `evaluatePrompt()` for upstream integrations |

---

## Multi-LLM Handoff Context

**ChatLLM (this engine):** Built the canonical codebase, orchestrator, gates C1–C6, natural language entry, end-to-end tests.  
**Next AI recipient:** See `04-reference/handoff-capsule.md` for continuity package.

Nothing becomes canon automatically: **Build → Review → Freeze → Promote.** The project owner decides what becomes SSOT.
