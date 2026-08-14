# DRCS Engine — Quick Start

**Get the engine running in under 5 minutes.**

---

## 1. Clone & Install

```bash
git clone https://github.com/TellDontaMatter/drcs-engine.git
cd drcs-engine
npm install
```

---

## 2. Set Up Environment

Create `.env` file:

```bash
DATABASE_URL="file:./dev.db"
ABACUS_API_KEY="your-key-here"  # Get from https://apps.abacus.ai/chatllm/admin/profile
PORT=3000
DRCS_TENANT="zilly"
```

---

## 3. Initialize Database

```bash
npx prisma generate
npx prisma migrate dev
npm run seed:zilly
```

**What this does:**
- Generates Prisma client
- Creates SQLite database (`prisma/dev.db`)
- Applies all migrations (AssetRegistry, CategorySchema, UsageLog, etc.)
- Seeds Zilly tenant data (8 categories + canonical assets)

---

## 4. Run Tests

```bash
npm test
```

**Expected output:**
```
Test Suites: 10 passed, 10 total
Tests:       107 passed, 107 total
```

If all tests pass, the engine is working.

---

## 5. Try It Out

### Web Console (Easiest)
```bash
npm run serve
# Opens at http://localhost:3000
```

**Type a prompt:**
```
make a hype post about hitting 10k followers
```

**You'll get back:**
```json
{
  "decision": "PUBLISH",
  "file_path": "media/assets/zilly_mascot.png",
  "caption": "Victory",
  "source": "AS_IS"
}
```

---

### CLI
```bash
npm run evaluate -- --prompt "create some chaos content"
```

**Output:**
```
DECISION: PUBLISH
FILE:     media/assets/zilly_06_jump_rope.png
CAPTION:  Chaos
SOURCE:   AS_IS
```

---

### Programmatic (In Your Code)
```typescript
import { evaluatePrompt } from 'drcs-engine';

const verdict = await evaluatePrompt('zilly', 'make a hype post');
console.log(verdict.file_path);  // "media/assets/zilly_mascot.png"
console.log(verdict.caption);    // "Victory"
```

---

## 6. What Just Happened?

1. **Your prompt** → `evaluatePrompt()` entry point
2. **LLM extracted intent** → mapped "hype post about 10k followers" to category "Victory"
3. **C6 (Governance)** → disposition: PUBLISH
4. **C2 (Situational Bank)** → resolved category "Victory" → found asset `08_victory_jump`
5. **C4 (Resolution)** → exact caption match "Victory" → EXISTING_AS_IS
6. **C3 (Governor)** → usage count within 30-day window: 0/3 → allowed
7. **Content Retrieval** → `resolveAsset("08_victory_jump")` → file_path + caption
8. **Verdict returned** → `{ decision: "PUBLISH", file_path: "...", caption: "Victory" }`

**Total latency:** ~2 seconds (includes one LLM call for prompt extraction).

---

## 7. Explore the Docs

| Document | What It Covers |
|---|---|
| `README.md` | Master index, gate status, architecture overview |
| `00-design-principles/vision-and-constraints.md` | Locked principles governing every design decision |
| `01-gates/*/` | Per-gate docs (purpose, contract, acceptance criteria) |
| `02-architecture/systems-ladder.md` | How the engine is built, layer by layer |
| `03-operating-rules/deployment-and-usage.md` | Deployment, API reference, multi-tenant config |
| `04-reference/handoff-capsule.md` | Multi-LLM continuity package (full project transfer) |

---

## 8. Common Next Steps

### Add a New Tenant
See `03-operating-rules/deployment-and-usage.md` → "Multi-Tenant Configuration"

### Deploy to Production
See `03-operating-rules/deployment-and-usage.md` → "Production Checklist"

### Understand a Specific Gate
See `01-gates/C*-*/` for detailed gate documentation

### Modify the Prompt Extraction Logic
See `src/orchestrator/index.ts` → `extractPromptFields()`

### Add Real Media Files
Update `src/seeds/zilly.ts` with actual file paths, re-run `npm run seed:zilly`

---

## 9. Troubleshooting

**"LLM returned HTTP 401"**
→ `ABACUS_API_KEY` missing or invalid. Check `.env`.

**"No category matches situation X"**
→ C2 couldn't resolve the category. Either seed it in CategorySchema, or the LLM picked a name that doesn't exist.

**"`file_path` is null"**
→ Asset exists but `file_path` not populated. Run `assetRegistry.updateFilePath(tenant_id, asset_id, path)` or re-seed with updated data.

**"Tests fail with 'Cannot find module @prisma/client'"**
→ Run `npx prisma generate`.

---

## 10. Need Help?

- **Handoff Capsule:** `04-reference/handoff-capsule.md` (complete project context)
- **API Reference:** `03-operating-rules/deployment-and-usage.md`
- **Gate Contracts:** `01-gates/*/` (one folder per gate)
- **GitHub Issues:** https://github.com/TellDontaMatter/drcs-engine/issues

---

**You're now running the DRCS engine. Ship something.**
