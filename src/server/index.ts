/**
 * DRCS ENGINE — local web console.
 *
 * This is the human-usable surface: a single-page form where you submit a real
 * content request and watch it flow through the gate pipeline (C6 → C2 → C4 →
 * C3), gate by gate, ending in ONE verdict. It calls the orchestrator's
 * `evaluate()` — the same engine an upstream system would call in code.
 *
 * No build step required — run with ts-node (see `npm run serve`).
 * Uses only the Node standard library (no web framework dependency).
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { evaluate, evaluatePrompt, EvaluationRequest } from '../orchestrator';
import * as categorySchema from '../persistence/repositories/categorySchema';
import { AssetTag } from '../types';

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_TENANT = process.env.DRCS_TENANT ?? 'zilly';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Content-Type for a served media file, by extension. */
function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Map the flat form payload into a structured EvaluationRequest. */
function toRequest(body: Record<string, unknown>): {
  request: EvaluationRequest;
  tenant_id: string;
} {
  const tenant_id = String(body.tenant_id || DEFAULT_TENANT);

  const allowed = String(body.allowed_to_acknowledge || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const mustNot = String(body.must_not_presume || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const request: EvaluationRequest = {
    trigger: {
      condition: String(body.condition || ''),
      confidence_tag: (body.confidence_tag as EvaluationRequest['trigger']['confidence_tag']) || undefined,
      stakes: (body.stakes as EvaluationRequest['trigger']['stakes']) || undefined,
      reviewer_directive: (body.reviewer_directive as EvaluationRequest['trigger']['reviewer_directive']) || null,
      belongs_here: body.belongs_here === undefined ? undefined : Boolean(body.belongs_here),
      appropriate: body.appropriate === undefined ? undefined : Boolean(body.appropriate),
      allowed_to_acknowledge: allowed.length ? allowed : undefined,
      must_not_presume: mustNot.length ? mustNot : undefined,
    },
    condition_signal: {
      category_id: body.category_id ? String(body.category_id) : undefined,
      situation: body.situation ? String(body.situation) : undefined,
    },
    content_need: {
      caption: String(body.caption || ''),
      required_tag: (body.required_tag as AssetTag) || undefined,
    },
    commit: body.commit === undefined ? true : Boolean(body.commit),
    deployment_context: 'local web console',
  };
  return { request, tenant_id };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = PAGE_HTML;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // List categories for the tenant (populates the dropdown).
    if (req.method === 'GET' && req.url?.startsWith('/api/categories')) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const tenant_id = url.searchParams.get('tenant_id') || DEFAULT_TENANT;
      const cats = await categorySchema.listCategories(tenant_id);
      sendJson(res, 200, {
        tenant_id,
        categories: cats.map((c) => ({
          category_id: c.category_id,
          name: c.name,
          protected: c.protected_flag,
          assets: c.asset_list.length,
        })),
      });
      return;
    }

    // Simplified single-prompt entry point: { tenant_id, prompt } -> verdict.
    if (req.method === 'POST' && req.url === '/api/evaluate-prompt') {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const tenant_id = String(body.tenant_id || DEFAULT_TENANT);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) {
        sendJson(res, 400, { error: 'prompt is required' });
        return;
      }
      try {
        const verdict = await evaluatePrompt(tenant_id, prompt);
        sendJson(res, 200, verdict);
      } catch (err) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : 'evaluation failed',
        });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/evaluate') {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const { request, tenant_id } = toRequest(body);
      if (!request.trigger.condition.trim()) {
        sendJson(res, 400, { error: 'condition is required' });
        return;
      }
      if (!request.content_need.caption.trim()) {
        sendJson(res, 400, { error: 'caption is required' });
        return;
      }
      try {
        const verdict = await evaluate(request, tenant_id);
        sendJson(res, 200, verdict);
      } catch (err) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : 'evaluation failed',
        });
      }
      return;
    }

    // Serve a generated/registered media file for inline preview. Only files
    // under the repo's media/ directory are served; the path is normalised and
    // checked to stay inside that root (guards against path traversal).
    if (req.method === 'GET' && req.url?.startsWith('/media/')) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const rel = decodeURIComponent(url.pathname.replace(/^\/media\//, ''));
      const mediaRoot = path.resolve(process.cwd(), 'media');
      const abs = path.resolve(mediaRoot, rel);
      if (!abs.startsWith(mediaRoot + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      fs.readFile(abs, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': contentTypeFor(abs),
          'Content-Length': data.length,
        });
        res.end(data);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'server error' });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`DRCS console running:  http://localhost:${PORT}  (tenant: ${DEFAULT_TENANT})`);
});

/** The single-page console. Kept inline so the server has zero asset deps. */
const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DRCS Engine — Console</title>
<style>
  :root { --bg:#0f1220; --panel:#181c2e; --line:#2a3050; --txt:#e7e9f3; --muted:#9aa0c0;
          --ok:#37d67a; --block:#ff5c73; --hold:#ffb23e; --accent:#6c7bff; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt); }
  header { padding:20px 28px; border-bottom:1px solid var(--line); }
  header h1 { margin:0; font-size:20px; } header p { margin:4px 0 0; color:var(--muted); font-size:13px; }
  .wrap { display:grid; grid-template-columns:400px 1fr; gap:0; min-height:calc(100vh - 78px); }
  .form { padding:22px 28px; border-right:1px solid var(--line); }
  .result { padding:22px 28px; }
  label { display:block; margin:14px 0 4px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  input, select, textarea { width:100%; background:var(--panel); border:1px solid var(--line); color:var(--txt);
    border-radius:8px; padding:9px 10px; font:inherit; }
  textarea { resize:vertical; min-height:52px; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  button { margin-top:20px; width:100%; background:var(--accent); color:#fff; border:0; border-radius:8px;
    padding:12px; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  .verdict { border-radius:10px; padding:16px 18px; margin-bottom:18px; border:1px solid var(--line); background:var(--panel); }
  .badge { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:700; font-size:13px; }
  .badge.PUBLISH { background:rgba(55,214,122,.16); color:var(--ok); }
  .badge.BLOCKED { background:rgba(255,92,115,.16); color:var(--block); }
  .verdict h2 { margin:10px 0 6px; font-size:17px; }
  .verdict .reason { color:var(--muted); }
  .kv { margin-top:10px; font-size:13px; color:var(--muted); }
  .kv b { color:var(--txt); font-weight:600; }
  .trail { margin-top:6px; }
  .step { display:flex; gap:12px; align-items:flex-start; padding:12px 14px; border:1px solid var(--line);
    border-radius:10px; margin-bottom:10px; background:var(--panel); }
  .dot { flex:0 0 auto; width:26px; height:26px; border-radius:50%; display:grid; place-items:center; font-size:13px; font-weight:700; }
  .dot.pass { background:rgba(55,214,122,.16); color:var(--ok); }
  .dot.stop { background:rgba(255,92,115,.16); color:var(--block); }
  .dot.skip { background:#20263f; color:var(--muted); }
  .step .g { font-weight:700; } .step .n { color:var(--muted); font-size:12px; }
  .step .s { margin-top:3px; font-size:13px; }
  .muted { color:var(--muted); } .empty { color:var(--muted); margin-top:40px; text-align:center; }
  details { margin-top:6px; } summary { cursor:pointer; color:var(--accent); font-size:12px; }
  pre { background:#0b0e1a; border:1px solid var(--line); border-radius:8px; padding:10px; overflow:auto; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>DRCS Engine — Console</h1>
  <p>Give the engine an idea and watch it flow through the gate pipeline: C6 → C2 → C4 → C5 → C3 → verdict.</p>
</header>
<div class="wrap">
  <div class="form">
    <form id="pf">
      <label>Tenant</label>
      <input id="p_tenant_id" value="zilly" />

      <label>What's your idea?</label>
      <textarea id="prompt" style="min-height:120px" placeholder="e.g. We just smashed our biggest milestone ever — hype clip!">We just smashed our biggest milestone ever — let's celebrate!</textarea>

      <button type="submit">Make content from this idea</button>
      <p class="muted" style="font-size:12px;margin-top:10px">
        The engine reads your idea, governs it (C6), picks a situational bank (C2),
        reuses a matching clip (C4) or generates a fresh caption (C5), and checks
        repetition (C3) — ending in one verdict.
      </p>
    </form>

    <details style="margin-top:22px">
      <summary>Advanced — supply the gate fields manually</summary>
      <form id="f" style="margin-top:12px">
        <label>Tenant</label>
        <input id="tenant_id" value="zilly" />

        <label>Situational condition (C6) *</label>
        <textarea id="condition" placeholder="e.g. It's a chaotic Monday launch morning">It's the start of a gentle morning session</textarea>

        <div class="row">
          <div><label>Confidence</label>
            <select id="confidence_tag"><option value="">(default: medium)</option>
              <option>high</option><option>medium</option><option>low</option><option>ambiguous</option></select></div>
          <div><label>Stakes</label>
            <select id="stakes"><option value="">(default: low)</option><option>low</option><option>high</option></select></div>
        </div>
        <div class="row">
          <div><label>Reviewer directive</label>
            <select id="reviewer_directive"><option value="">(none)</option><option value="reject">reject</option><option value="hold">hold</option></select></div>
          <div><label>Belongs here?</label>
            <select id="belongs_here"><option value="">(default: yes)</option><option value="true">yes</option><option value="false">no</option></select></div>
        </div>

        <label>Category (C2)</label>
        <select id="category_id"><option value="">— pick a category —</option></select>
        <label>…or situation label (if no category picked)</label>
        <input id="situation" placeholder="e.g. Gentle Start" />

        <label>Caption needed (C4) *</label>
        <textarea id="caption" placeholder="The caption this deployment needs">Ease into it — double bounce to start.</textarea>

        <div class="row">
          <div><label>Required tag</label>
            <select id="required_tag"><option value="">(any)</option><option value="canonical">canonical</option>
              <option value="derivative_edit">derivative_edit</option><option value="derivative_new">derivative_new</option></select></div>
          <div><label>Commit deployment?</label>
            <select id="commit"><option value="true">yes (log it — counts toward C3)</option><option value="false">no (dry run)</option></select></div>
        </div>

        <button type="submit">Run through the engine</button>
      </form>
    </details>
  </div>

  <div class="result" id="result">
    <div class="empty">Submit a request to see the verdict and the gate-by-gate trail.</div>
  </div>
</div>

<script>
const GATES = ['C6','C2','C4','C5','C3'];
async function loadCategories() {
  const t = document.getElementById('tenant_id').value || 'zilly';
  try {
    const r = await fetch('/api/categories?tenant_id='+encodeURIComponent(t));
    const d = await r.json();
    const sel = document.getElementById('category_id');
    sel.innerHTML = '<option value="">— pick a category —</option>' +
      (d.categories||[]).map(c => '<option value="'+c.category_id+'">'+c.name+' ('+c.assets+' assets'+(c.protected?', protected':'')+')</option>').join('');
  } catch(e) {}
}
document.getElementById('tenant_id').addEventListener('change', loadCategories);
loadCategories();

function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// Simplified single-prompt submit → /api/evaluate-prompt.
document.getElementById('pf').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    tenant_id: document.getElementById('p_tenant_id').value || 'zilly',
    prompt: document.getElementById('prompt').value,
  };
  const res = document.getElementById('result');
  res.innerHTML = '<div class="empty">Reading your idea and running the engine…</div>';
  const r = await fetch('/api/evaluate-prompt', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const v = await r.json();
  if (v.error) { res.innerHTML = '<div class="verdict"><span class="badge BLOCKED">ERROR</span><p class="reason">'+esc(v.error)+'</p></div>'; return; }
  render(v);
});

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const g = id => document.getElementById(id).value;
  const body = {
    tenant_id: g('tenant_id'), condition: g('condition'),
    confidence_tag: g('confidence_tag'), stakes: g('stakes'),
    reviewer_directive: g('reviewer_directive'),
    belongs_here: g('belongs_here')==='' ? undefined : g('belongs_here')==='true',
    category_id: g('category_id'), situation: g('situation'),
    caption: g('caption'), required_tag: g('required_tag'),
    commit: g('commit')==='true',
  };
  const res = document.getElementById('result');
  res.innerHTML = '<div class="empty">Running…</div>';
  const r = await fetch('/api/evaluate', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const v = await r.json();
  if (v.error) { res.innerHTML = '<div class="verdict"><span class="badge BLOCKED">ERROR</span><p class="reason">'+esc(v.error)+'</p></div>'; return; }
  render(v);
});

function render(v) {
  const stoppedIdx = v.stopped_at_gate ? GATES.indexOf(v.stopped_at_gate) : GATES.length;
  const byGate = {}; (v.trail||[]).forEach(t => byGate[t.gate]=t);
  let steps = '';
  GATES.forEach((gid, i) => {
    const t = byGate[gid];
    let cls, mark, name, summ;
    if (t) { cls = t.passed ? 'pass' : 'stop'; mark = t.passed ? '✓' : '✕'; name = t.name; summ = t.summary; }
    else { cls='skip'; mark='–'; name=({C6:'Message-Idea Governance',C2:'Situational Bank',C4:'Caption-First Resolution',C5:'Misalignment Protocol',C3:'Repetition Governor'})[gid]; summ = i>stoppedIdx ? 'not reached (pipeline already stopped)' : ''; }
    steps += '<div class="step"><div class="dot '+cls+'">'+mark+'</div><div><div class="g">'+gid+' <span class="n">'+esc(name)+'</span></div><div class="s">'+esc(summ)+'</div></div></div>';
  });
  const kv = [];
  if (v.caption) kv.push('<b>Final caption:</b> '+esc(v.caption));
  if (v.source) kv.push('<b>Source:</b> '+esc(v.source));
  if (v.asset_id) kv.push('<b>Asset:</b> '+esc(v.asset_id));
  if (v.file_path) kv.push('<b>File:</b> '+esc(v.file_path));
  else if (v.asset_id) kv.push('<b>File:</b> <span class="muted">(no media file attached yet)</span>');
  if (v.asset_recommendation) kv.push('<b>Suggested asset:</b> '+esc(v.asset_recommendation));
  if (v.resolution_step) kv.push('<b>Step:</b> '+esc(v.resolution_step));
  kv.push('<b>Committed:</b> '+(v.committed?'yes (deployment logged)':'no'));
  if (v.deployment_id) kv.push('<b>Deployment id:</b> '+esc(v.deployment_id));
  if (v.governance_record_id) kv.push('<b>Governance record:</b> '+esc(v.governance_record_id));

  // Inline preview when the file is an image the server can serve from media/.
  let preview = '';
  if (v.file_path) {
    const fp = String(v.file_path);
    const m = fp.match(/\\.([a-z0-9]+)$/i);
    const ext = m ? m[1].toLowerCase() : '';
    const isImg = ['png','jpg','jpeg','gif','webp'].indexOf(ext) !== -1;
    if (isImg && fp.indexOf('media/') !== -1) {
      const rel = fp.slice(fp.indexOf('media/') + 'media/'.length);
      preview = '<div class="preview"><img alt="generated media preview" src="/media/'+
        rel.split('/').map(encodeURIComponent).join('/')+'"/></div>';
    }
  }

  document.getElementById('result').innerHTML =
    '<div class="verdict"><span class="badge '+v.decision+'">'+v.decision+'</span>'+
    '<h2>'+esc(v.outcome)+'</h2><div class="reason">'+esc(v.reason)+'</div>'+
    '<div class="kv">'+kv.join(' &nbsp;·&nbsp; ')+'</div>'+preview+'</div>'+
    '<div class="trail">'+steps+'</div>'+
    '<details><summary>Raw verdict JSON</summary><pre>'+esc(JSON.stringify(v,null,2))+'</pre></details>';
}
</script>
</body>
</html>`;
