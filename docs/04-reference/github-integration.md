# GitHub Integration History

**Repository:** https://github.com/TellDontaMatter/drcs-engine  
**Primary Branch:** `master`  
**Integration Branch:** `feat/orchestrator-and-ui`

---

## Pull Request History

### PR #6 — Orchestrator & UI Integration
**Branch:** `feat/orchestrator-and-ui` → `master`  
**Status:** Merged  
**Scope:** Combined C3, C4, C5, orchestrator, natural language entry, and UI surfaces

**What Changed:**
- Added C5 (Generation / Misalignment Protocol)
- Added orchestrator layer running C6→C2→C4→C5→C3 sequence
- Added `evaluatePrompt(tenant_id, prompt)` natural language entry point
- Added content retrieval layer (`src/assets`)
- Added LLM integration (`src/llm`)
- Updated web console with prompt-first UI
- Updated CLI with `--prompt` mode

**Why Combined:**
These components were interdependent — the orchestrator needed C5 for escalation handling, C5 needed the LLM layer, and the natural language entry needed both the orchestrator and the LLM. Splitting into separate PRs would have created non-functional intermediate states.

**Merge Conflicts:**
- `README.md` — resolved by rewriting intro to reflect new orchestrator architecture
- `src/index.ts` — resolved by consolidating all exports (gates + orchestrator + assets + LLM)

---

## Key Commits

### Latest: `fix: map prompt to category name; seed asset file paths` (5107751)
**Date:** 2026-08-05  
**Changes:**
- Redesigned `extractPromptFields` to load tenant's category names from DB
- LLM now picks from a closed list of real category names (verbatim)
- Updated `seedZilly()` to populate `file_path` for all 8 assets
- Added `updateFilePath()` and back-fill logic to asset registry

**Why:** Original LLM prompt generated free-form "situation" text that never matched category names. This fix ensures the LLM maps user intent → exact category name → C2 can resolve it.

---

### `feat: pluggable media generator provider + real demo asset wiring` (263f481)
**Changes:**
- Added pluggable media generator provider pattern
- Wired real demo assets to categories
- Verified end-to-end media retrieval flow

---

### `feat: C5 generation, asset retrieval, simplified prompt input` (3d46e4d)
**Changes:**
- Implemented C5 (Misalignment Protocol) gate
- Added `src/assets` content retrieval layer
- Added `src/llm` integration layer
- Added `evaluatePrompt()` simplified entry point
- Updated orchestrator to run full gate sequence

**Why:** This was the "gears → machine" transition. Before this commit, the engine had gates but no way to actually retrieve content or generate fresh captions.

---

## Git Workflow

**Branch Strategy:**
- One gate per branch (e.g., `feat/c1-lock`, `feat/c2-bank`)
- Each PR targets `master` directly (no stacking)
- **Exception:** PR #6 combined multiple interdependent components

**Commit Message Pattern:**
- `feat:` — new feature or gate
- `fix:` — bug fix or correction
- `chore:` — maintenance, deps, cleanup

**Auto-Generated Commits:**
- `deepagent-snapshot` — automatic snapshots from the dev environment (can be ignored for release history)

---

## Remote Status

**Origin:** https://github.com/TellDontaMatter/drcs-engine.git  
**Latest Push:** 2026-08-05 (commit 5107751)  
**Branch State:** `feat/orchestrator-and-ui` merged into `master` via PR #6

---

## Next Integration Steps

1. **C7 Gate PR** (when designed) — `feat/c7-compliance` → `master`
2. **C8 Gate PR** (when designed) — `feat/c8-distribution` → `master`
3. **Production Deploy PR** — migrate from SQLite to PostgreSQL, update deployment docs

**Rule:** One gate = one branch = one PR targeting `master` directly.
