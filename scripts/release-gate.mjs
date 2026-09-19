#!/usr/bin/env node
/**
 * release-gate.mjs — the last step of `prepublishOnly`. Proves the tarball
 * that is about to be published actually works for a stranger, by doing
 * exactly what a stranger does: pack it, install it into an empty folder,
 * run `trimwares serve`, and hit it.
 *
 * Runs AFTER lint → test → build → build:ui, so the ui/ it packs is the one
 * just generated from trimwares-dashboard/ source — never a stale bundle.
 *
 * Every check here is a regression test for a bug that actually shipped or
 * nearly shipped:
 *   - stale JS chunk must 404 (was: index.html with 200 → blank dashboard
 *     after every upgrade, until a hard refresh)
 *   - HTML must be no-cache, chunks immutable (was: no headers at all)
 *   - POST /api/clear must exist and return JSON (was: didn't exist; UI
 *     showed "Cleared" on the HTML fallback)
 *   - unknown /api/* must be a JSON 404 (was: HTML 200)
 *   - shipped ui/ must carry the live checkout CTA, not "Coming soon"
 *   - the install must add only the expected packages
 *
 * Exit 0 = safe to publish. Exit 1 = do not publish; the reason is printed.
 * Usage: node scripts/release-gate.mjs   (or: npm run release:gate)
 */

import { execSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const pkg  = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let failures = 0;
const ok   = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { failures++; console.error(`  FAIL ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });

async function freePort() {
  return new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function waitFor(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.ok) return true; } catch {} await new Promise(r => setTimeout(r, 250)); }
  return false;
}

// ── 1. Pack ──────────────────────────────────────────────────────────────────
console.log('\nrelease-gate: packing', pkg.name, pkg.version);
const packDir = mkdtempSync(join(tmpdir(), 'trimwares-gate-'));
const packOut = sh(`npm pack --pack-destination "${packDir}" --json`, { cwd: ROOT });
const tarball = join(packDir, JSON.parse(packOut)[0].filename);
check(existsSync(tarball), `tarball produced: ${tarball}`);

// ── 2. Clean install, as a stranger ──────────────────────────────────────────
const app = join(packDir, 'app');
mkdirSync(app);
sh('npm init -y', { cwd: app });
const installOut = sh(`npm install "${tarball}" --no-audit --no-fund --loglevel=error`, { cwd: app });
const installed = readdirSync(join(app, 'node_modules')).filter(d => !d.startsWith('.'));
console.log('  installed top-level:', installed.join(', '));
// tiktoken is the only hard dependency; anything else appearing here means
// a dependency leaked back into `dependencies`.
const expected = new Set(['@trimwares', 'tiktoken']);
check(installed.every(d => expected.has(d)), `only expected packages installed (${installed.length})`);
const audit = JSON.parse(sh('npm audit --omit=dev --json || true', { cwd: app }));
const vulnTotal = audit?.metadata?.vulnerabilities?.total ?? -1;
check(vulnTotal === 0, `npm audit --omit=dev on the installed package: ${vulnTotal} vulnerabilities`);

// ── 3. Seed a tiny session so /api/data and /api/clear have something real ───
mkdirSync(join(app, '.trimwares'));
const entry = (i) => JSON.stringify({
  timestamp: Date.now() - i * 1000, requestId: `gate_${i}`, provider: 'openai', model: 'gpt-4o-mini',
  attribution: { systemPrompt: { tokens: 100, estimatedCost: 0.000015, percentOfTotal: 50 }, toolSchemas: { tokens: 0, estimatedCost: 0, percentOfTotal: 0 },
    ragChunks: { tokens: 0, estimatedCost: 0, percentOfTotal: 0 }, conversationHistory: { tokens: 0, estimatedCost: 0, percentOfTotal: 0 },
    userQuery: { tokens: 50, estimatedCost: 0.0000075, percentOfTotal: 25 }, outputTokens: { tokens: 50, estimatedCost: 0.00003, percentOfTotal: 25 },
    totalInputTokens: 150, totalOutputTokens: 50, totalCost: 0.0000525 },
  cached: false, cacheType: 'none', latencyMs: 300, nativeCache: false, realInputTokens: 150, realOutputTokens: 50,
  nativeCachedTokens: 0, realCost: 0.0000525, realSavings: 0, labels: { project: 'gate' },
});
writeFileSync(join(app, '.trimwares', 'session.jsonl'), [entry(1), entry(2), entry(3)].join('\n') + '\n');

// ── 4. Serve from the INSTALLED package, exactly like `npx trimwares serve` ──
const port = await freePort();
const bin  = join(app, 'node_modules', '@trimwares', 'trace', 'bin', 'trimwares.js');
// TRIMWARES_NO_AUTO_REGISTER: don't let this throwaway folder into the user's global project registry.
const server = spawn(process.execPath, [bin, 'serve', '--port', String(port)], { cwd: app, stdio: 'pipe', env: { ...process.env, TRIMWARES_NO_AUTO_REGISTER: '1' } });
let serverLog = ''; server.stdout.on('data', d => serverLog += d); server.stderr.on('data', d => serverLog += d);
const base = `http://localhost:${port}`;
const up = await waitFor(`${base}/api/data`);
check(up, `serve started on :${port}`);

if (up) {
  // 4a. HTML shell: 200, html, must revalidate
  const html = await fetch(`${base}/`);
  const htmlText = await html.text();
  check(html.status === 200 && /text\/html/.test(html.headers.get('content-type') || ''), 'GET / → 200 text/html');
  check(html.headers.get('cache-control') === 'no-cache', 'GET / → Cache-Control: no-cache');

  // 4b. A real chunk referenced by that HTML: 200, JS, immutable
  const chunk = (htmlText.match(/\/_next\/static\/chunks\/[^"']+\.js/) || [])[0];
  check(!!chunk, `HTML references a JS chunk (${chunk})`);
  if (chunk) {
    const c = await fetch(base + chunk);
    check(c.status === 200 && /javascript/.test(c.headers.get('content-type') || ''), 'chunk → 200 application/javascript');
    check(/immutable/.test(c.headers.get('cache-control') || ''), 'chunk → Cache-Control immutable');
  }

  // 4c. A chunk that no longer exists (the post-upgrade failure mode): 404, NOT html
  const stale = await fetch(`${base}/_next/static/chunks/app/page-0000000000000000.js`);
  check(stale.status === 404, `stale chunk → 404 (got ${stale.status})`);
  check(!/text\/html/.test(stale.headers.get('content-type') || ''), 'stale chunk → not served as HTML');

  // 4d. SPA route still resolves
  const spa = await fetch(`${base}/attribution`);
  check(spa.status === 200 && /text\/html/.test(spa.headers.get('content-type') || ''), 'GET /attribution → 200 html (SPA route)');

  // 4e. Data API sees the seed
  const d1 = await (await fetch(`${base}/api/data`)).json();
  check(d1.hasData === true && d1.entryCount === 3, `GET /api/data → hasData, entryCount=3 (got ${d1.entryCount})`);

  // 4f. Unknown API route: JSON 404, never the dashboard
  const nope = await fetch(`${base}/api/definitely-not-a-route`);
  check(nope.status === 404 && /json/.test(nope.headers.get('content-type') || ''), `unknown /api/* → 404 JSON (got ${nope.status} ${nope.headers.get('content-type')})`);

  // 4g. Clear session: must exist, return JSON, and actually clear
  const clr = await fetch(`${base}/api/clear`, { method: 'POST' });
  const clrBody = await clr.json().catch(() => null);
  check(clr.status === 200 && clrBody?.ok === true && clrBody?.cleared === true, `POST /api/clear → 200 {ok,cleared} (got ${clr.status} ${JSON.stringify(clrBody)})`);
  const d2 = await (await fetch(`${base}/api/data`)).json();
  check(d2.hasData === false || d2.entryCount === 0, `GET /api/data after clear → empty (entryCount=${d2.entryCount})`);
  check(existsSync(join(app, '.trimwares', '.sessions')), 'cleared session was archived to .trimwares/.sessions/, not deleted');

  // 4h. Shipped UI carries the live CTA and none of the pre-1.5.4 copy.
  // Search every JS file under _next/static — do NOT assume a folder layout.
  // Next 14 nested route chunks under chunks/app/; Next 16 (Turbopack) emits
  // flat hashed names directly in chunks/. The gate must survive that.
  const uiDir  = join(app, 'node_modules', '@trimwares', 'trace', 'ui');
  const stat   = join(uiDir, '_next', 'static');
  const jsFiles = readdirSync(stat, { recursive: true }).map(String).filter(f => f.endsWith('.js'));
  check(jsFiles.length > 0, `shipped ui/ contains JS chunks (${jsFiles.length})`);
  const allJs = jsFiles.map(f => readFileSync(join(stat, f), 'utf8')).join('\n');
  check(/creem\.io\/payment/.test(allJs), 'shipped ui/ links to the live Creem checkout');
  check(!/Coming soon|Get notified/i.test(allJs), 'shipped ui/ has no "Coming soon" / "Get notified" copy');
  check(/Built by one person/.test(allJs), 'shipped ui/ carries the founder contact line');
}

// ── 5. Teardown ──────────────────────────────────────────────────────────────
server.kill();
await new Promise(r => setTimeout(r, 500));
try { rmSync(packDir, { recursive: true, force: true }); } catch {}

if (failures) {
  console.error(`\nrelease-gate: ${failures} check(s) FAILED — do not publish.`);
  if (serverLog) console.error('\n--- serve output ---\n' + serverLog.slice(-2000));
  process.exit(1);
}
console.log(`\nrelease-gate: all checks passed — ${pkg.name}@${pkg.version} is safe to publish.\n`);
