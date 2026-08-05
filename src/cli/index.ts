#!/usr/bin/env node
/**
 * DRCS ENGINE — command-line surface.
 *
 * Run a single content request through the full gate pipeline and print the
 * verdict + trail. Same engine as the web console (calls orchestrator.evaluate).
 *
 * Two ways to call it:
 *
 *   1. Simplified — one free-form idea (the LLM derives the rest, C5 can generate):
 *        npm run evaluate -- --tenant zilly --prompt "we just hit a huge milestone"
 *
 *   2. Structured — supply the gate fields yourself:
 *        npm run evaluate -- --tenant zilly \
 *          --condition "gentle morning session" \
 *          --category gentle_start \
 *          --caption "Ease into it — double bounce to start." \
 *          [--situation "Gentle Start"] [--reviewer reject|hold] [--dry-run]
 */
import { evaluate, evaluatePrompt, EvaluationRequest } from '../orchestrator';
import { AssetTag } from '../types';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenant_id = String(args.tenant || 'zilly');

  // Simplified path: a single free-form idea. The LLM derives the situation +
  // content type, then the exact same pipeline runs (and C5 can generate).
  const promptMode = typeof args.prompt === 'string' && args.prompt.trim().length > 0;

  if (!promptMode && (!args.condition || !args.caption)) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage:\n' +
        '  npm run evaluate -- --tenant <id> --prompt "<your idea>"\n' +
        '  npm run evaluate -- --tenant <id> --condition "<text>" ' +
        '--caption "<text>" [--category <id> | --situation "<label>"] ' +
        '[--reviewer reject|hold] [--required-tag canonical] [--dry-run]',
    );
    process.exit(2);
  }

  const v = promptMode
    ? await evaluatePrompt(tenant_id, String(args.prompt))
    : await evaluate(
        {
          trigger: {
            condition: String(args.condition),
            reviewer_directive: (args.reviewer as EvaluationRequest['trigger']['reviewer_directive']) || null,
          },
          condition_signal: {
            category_id: args.category ? String(args.category) : undefined,
            situation: args.situation ? String(args.situation) : undefined,
          },
          content_need: {
            caption: String(args.caption),
            required_tag: args['required-tag'] ? (String(args['required-tag']) as AssetTag) : undefined,
          },
          commit: !args['dry-run'],
          deployment_context: 'cli',
        },
        tenant_id,
      );

  const line = (s: string) => process.stdout.write(s + '\n');
  line('');
  line(`  DECISION : ${v.decision}   (${v.outcome})`);
  line(`  REASON   : ${v.reason}`);
  if (v.asset_id) line(`  ASSET    : ${v.asset_id}  [${v.resolution_step}]`);
  if (v.file_path) line(`  FILE     : ${v.file_path}`);
  if (v.source) line(`  SOURCE   : ${v.source}`);
  if (v.asset_recommendation) line(`  SUGGESTED: ${v.asset_recommendation}`);
  if (v.caption) line(`  CAPTION  : ${v.caption}`);
  line(`  COMMITTED: ${v.committed ? 'yes (deployment logged: ' + v.deployment_id + ')' : 'no'}`);
  line('');
  line('  Gate trail:');
  for (const t of v.trail) {
    line(`    ${t.passed ? '✓' : '✕'} ${t.gate}  ${t.name} — ${t.summary}`);
  }
  line('');
  process.exit(v.decision === 'PUBLISH' ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('evaluate failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
