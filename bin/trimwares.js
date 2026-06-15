#!/usr/bin/env node
// CLI entry point — npx trimwares analyze | serve | login | clear

import { SessionLog }   from '../dist/telemetry/index.js';
import { renderReport } from '../dist/cli/analyze.js';

const [,, command = 'analyze', ...rest] = process.argv;

// ─── License verification ─────────────────────────────────────────────────────

const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEA+WiFm3fBMP/eHXnHqNN2aEXTlMbJLq51We0DcAN2nL8=';

async function verifyLicenseKey(keyStr) {
  if (!keyStr || typeof keyStr !== 'string') return null;
  const parts = keyStr.trim().split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const { verify, createPublicKey } = await import('crypto');
    const payloadBytes = Buffer.from(payloadB64, 'base64url');
    const sigBytes     = Buffer.from(sigB64,     'base64url');
    const pubKey = createPublicKey({
      key:    Buffer.from(PUBLIC_KEY_B64, 'base64'),
      format: 'der',
      type:   'spki',
    });
    const valid = verify(null, payloadBytes, pubKey, sigBytes);
    if (!valid) return null;
    return JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return null;
  }
}

async function loadStoredLicense() {
  const { existsSync, readFileSync } = await import('fs');
  const { join }    = await import('path');
  const { homedir } = await import('os');
  const configPath  = join(homedir(), '.trimwares', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { return null; }
}

async function requireProLicense() {
  const config = await loadStoredLicense();

  if (!config?.licenseKey) {
    console.error('\n  \x1b[31m✗ Pro license required\x1b[0m');
    console.error('  \x1b[90m──────────────────────────────────────────\x1b[0m');
    console.error('  The dashboard is a Pro feature.');
    console.error('  Get a license at \x1b[36mtrimwares.com/pro\x1b[0m');
    console.error('  Then activate it:\n');
    console.error('    \x1b[33mnpx trimwares login --key YOUR_LICENSE_KEY\x1b[0m\n');
    process.exit(1);
  }

  const payload = await verifyLicenseKey(config.licenseKey);

  if (!payload) {
    console.error('\n  \x1b[31m✗ Invalid license key\x1b[0m');
    console.error('  Your key could not be verified. It may have been tampered with.');
    console.error('  Re-run: \x1b[33mnpx trimwares login --key YOUR_LICENSE_KEY\x1b[0m');
    console.error('  Or contact support at \x1b[36mtrimwares.com/support\x1b[0m\n');
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    const expired = new Date(payload.exp * 1000).toISOString().split('T')[0];
    console.error(`\n  \x1b[31m✗ License expired on ${expired}\x1b[0m`);
    console.error('  Renew at \x1b[36mtrimwares.com/pro\x1b[0m');
    console.error('  Then: \x1b[33mnpx trimwares login --key YOUR_NEW_KEY\x1b[0m\n');
    process.exit(1);
  }

  const validTiers = ['pro', 'team', 'enterprise'];
  if (!validTiers.includes(payload.tier)) {
    console.error('\n  \x1b[31m✗ This license does not include the dashboard\x1b[0m');
    console.error('  Upgrade at \x1b[36mtrimwares.com/pro\x1b[0m\n');
    process.exit(1);
  }

  return payload;
}

// ─── analyze ─────────────────────────────────────────────────────────────────

if (command === 'analyze') {
  const log     = new SessionLog();
  const entries = log.readAll();
  process.stdout.write(renderReport({ entries }));
  process.exit(0);
}

// ─── login ───────────────────────────────────────────────────────────────────

if (command === 'login') {
  const keyFlag = rest.indexOf('--key');
  if (keyFlag === -1 || !rest[keyFlag + 1]) {
    console.error('\n  Usage: npx trimwares login --key YOUR_LICENSE_KEY\n');
    process.exit(1);
  }
  const keyStr = rest[keyFlag + 1];

  console.log('\n  Verifying license key…');

  const payload = await verifyLicenseKey(keyStr);

  if (!payload) {
    console.error('\n  \x1b[31m✗ Invalid license key\x1b[0m');
    console.error('  The key signature could not be verified. Check that you copied it correctly.');
    console.error('  If this keeps happening, contact \x1b[36mtrimwares.com/support\x1b[0m\n');
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    const expired = new Date(payload.exp * 1000).toISOString().split('T')[0];
    console.error(`\n  \x1b[31m✗ This key expired on ${expired}\x1b[0m`);
    console.error('  Get a new one at \x1b[36mtrimwares.com/pro\x1b[0m\n');
    process.exit(1);
  }

  const { mkdirSync, writeFileSync } = await import('fs');
  const { join }    = await import('path');
  const { homedir } = await import('os');
  const configDir  = join(homedir(), '.trimwares');
  const configPath = join(configDir, 'config.json');
  mkdirSync(configDir, { recursive: true });

  const expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString().split('T')[0] : 'never';
  writeFileSync(configPath, JSON.stringify({
    licenseKey:  keyStr,
    tier:        payload.tier,
    email:       payload.email ?? null,
    customerId:  payload.customerId ?? null,
    expiresAt,
  }, null, 2));

  console.log(`\n  \x1b[32m✓ License activated\x1b[0m`);
  console.log(`  \x1b[90m─────────────────────────────────\x1b[0m`);
  console.log(`  Tier:    \x1b[36m${payload.tier}\x1b[0m`);
  if (payload.email) console.log(`  Email:   ${payload.email}`);
  console.log(`  Expires: ${expiresAt}`);
  console.log(`\n  Run \x1b[33mnpx trimwares serve\x1b[0m to open the dashboard.\n`);
  process.exit(0);
}

// ─── clear ───────────────────────────────────────────────────────────────────

if (command === 'clear') {
  const { unlinkSync, existsSync } = await import('fs');
  const path = `${process.env.TRIMWARES_LOG_DIR ?? '.trimwares'}/session.jsonl`;
  if (existsSync(path)) { unlinkSync(path); console.log('Session log cleared.'); }
  else { console.log('No session log found.'); }
  process.exit(0);
}

// ─── serve ───────────────────────────────────────────────────────────────────

if (command === 'serve') {

  // ── HARD GATE — nothing runs below this without a valid Pro license ─────────
  const license = await requireProLicense();

  const { createServer }                          = await import('http');
  const { readFileSync, existsSync, readdirSync } = await import('fs');
  const { join, resolve, extname }                = await import('path');
  const { fileURLToPath }                         = await import('url');
  const { exec }                                  = await import('child_process');

  const PORT   = 7777;
  const __dir  = fileURLToPath(new URL('.', import.meta.url));
  const UI_DIR = resolve(__dir, '../ui');

  // ── data helpers ─────────────────────────────────────────────────────────────

  function loadSessionEntries() {
    const sessionPath = resolve(process.cwd(), '.trimwares/session.jsonl');
    if (!existsSync(sessionPath)) return [];
    try {
      return readFileSync(sessionPath, 'utf8')
        .split('\n').filter(Boolean).slice(-500)
        .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    } catch { return []; }
  }

  function loadHistoryEntries() {
    const histPath = resolve(process.cwd(), '.trimwares/history.jsonl');
    if (!existsSync(histPath)) return [];
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    try {
      return readFileSync(histPath, 'utf8')
        .split('\n').filter(Boolean)
        .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
        .filter(e => e.timestamp && new Date(e.timestamp).getTime() >= cutoff);
    } catch { return []; }
  }

  function groupHistoryByDay(entries) {
    const byDay = {};
    for (const e of entries) {
      const day = new Date(e.timestamp).toISOString().split('T')[0];
      if (!day) continue;
      if (!byDay[day]) byDay[day] = { date: day, spend: 0, requests: 0, saved: 0 };
      byDay[day].spend    += realCostOf(e);
      byDay[day].requests += 1;
      byDay[day].saved    += realSavingsOf(e);
    }
    const days = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
    const spend30d    = days.reduce((s, d) => s + d.spend, 0);
    const requests30d = days.reduce((s, d) => s + d.requests, 0);
    return {
      days,
      totals: {
        spend30d,
        requests30d,
        avgDailySpend: days.length > 0 ? spend30d / days.length : 0,
      },
    };
  }

  function loadLatestSimulation() {
    const simDir = resolve(process.cwd(), 'simulation-results');
    if (!existsSync(simDir)) return null;
    try {
      const files = readdirSync(simDir)
        .filter(f => f.startsWith('simulation-') && f.endsWith('.json'))
        .sort().reverse();
      if (!files.length) return null;
      return JSON.parse(readFileSync(join(simDir, files[0]), 'utf8'));
    } catch { return null; }
  }

  // realCost/realSavings come from CostEngine (actual provider usage tokens).
  // Older log entries written before this field existed fall back to the
  // heuristic attribution.totalCost so the dashboard doesn't break on stale data.
  function realCostOf(e)    { return e.realCost    ?? e.attribution.totalCost; }
  function realSavingsOf(e) { return e.realSavings ?? (e.cached ? e.attribution.totalCost : 0); }

  function deriveWasteReport(entries) {
    if (!entries.length) return {
      totalGrossSpend: 0, alreadySaved: 0, currentSpend: 0,
      recoverableSpend: 0, recoverablePercent: 0, categories: [], topFix: null, sessionRequests: 0,
    };
    let toolSchemaCost = 0, ragChunkCost = 0, historyCost = 0;
    let systemPromptCost = 0, userQueryCost = 0, outputCost = 0;
    let systemPromptCostUncached = 0;
    let responseCacheSavings = 0, nativeCacheSavings = 0;
    for (const e of entries) {
      if (e.cached) { responseCacheSavings += realSavingsOf(e); continue; }
      const a = e.attribution;
      const heuristicTotal = a.totalCost || 1;
      // Scale the heuristic per-category split onto the real billed cost for
      // this request, so category dollar amounts sum to actual spend.
      const k = realCostOf(e) / heuristicTotal;
      toolSchemaCost   += a.toolSchemas.estimatedCost * k;
      ragChunkCost     += a.ragChunks.estimatedCost * k;
      historyCost      += a.conversationHistory.estimatedCost * k;
      systemPromptCost += a.systemPrompt.estimatedCost * k;
      userQueryCost    += a.userQuery.estimatedCost * k;
      outputCost       += a.outputTokens.estimatedCost * k;
      if (!e.nativeCache) systemPromptCostUncached += a.systemPrompt.estimatedCost * k;
      nativeCacheSavings += realSavingsOf(e);
    }
    const currentSpend    = toolSchemaCost + ragChunkCost + historyCost + systemPromptCost + userQueryCost + outputCost;
    const alreadySaved    = responseCacheSavings + nativeCacheSavings;
    const totalGrossSpend = currentSpend + alreadySaved;
    const gross           = totalGrossSpend || 1;
    const pct             = c => parseFloat(((c / gross) * 100).toFixed(1));
    const rTool    = toolSchemaCost   * 0.90;
    const rRAG     = ragChunkCost     * 0.90;
    const rHistory = historyCost      * 0.65;
    // Only the portion of system-prompt spend NOT already covered by
    // provider-native caching is "recoverable" — the rest is already saved
    // and reflected in nativeCacheSavings below.
    const rSystem  = systemPromptCostUncached * 0.85;
    const cats = [
      { label: 'Unused tool schemas',        cost: toolSchemaCost,   percentOfSpend: pct(toolSchemaCost),   severity: toolSchemaCost > currentSpend * 0.10 ? 'critical' : 'warning', fixDescription: 'Cache tool schema prefix or filter per-step',            projectedMonthlySaving: rTool    * 30 },
      { label: 'Redundant RAG chunks',       cost: ragChunkCost,     percentOfSpend: pct(ragChunkCost),     severity: ragChunkCost > currentSpend * 0.15 ? 'critical' : ragChunkCost > 0 ? 'warning' : 'info', fixDescription: 'Provider-native prefix caching on stable docs', projectedMonthlySaving: rRAG     * 30 },
      { label: 'Stale conversation history', cost: historyCost,      percentOfSpend: pct(historyCost),      severity: historyCost > currentSpend * 0.15 ? 'warning' : 'info',     fixDescription: 'maxHistoryTurns: 10 rolling window',                     projectedMonthlySaving: rHistory * 30 },
      { label: 'System prompts', cost: systemPromptCost, percentOfSpend: pct(systemPromptCost), severity: systemPromptCostUncached > currentSpend * 0.20 ? 'warning' : systemPromptCostUncached > 0 ? 'info' : 'good', fixDescription: systemPromptCostUncached > 0 ? 'Anthropic cache_control on stable instructions' : 'Already covered by provider-native caching', projectedMonthlySaving: rSystem  * 30 },
      { label: 'Repeated prompts ✓ saved',   cost: responseCacheSavings, percentOfSpend: pct(responseCacheSavings), severity: 'good', fixDescription: 'Response cache active — identical questions at $0' },
      { label: 'Native prompt caching ✓ active', cost: nativeCacheSavings, percentOfSpend: pct(nativeCacheSavings), severity: 'good', fixDescription: 'Provider-side prompt cache is discounting repeated context' },
      { label: 'Genuine work',               cost: userQueryCost + outputCost, percentOfSpend: pct(userQueryCost + outputCost), severity: 'good', fixDescription: 'User queries + output — cannot be reduced' },
    ].filter(c => c.cost > 0);
    const topFix = [...cats]
      .filter(c => c.severity !== 'good' && (c.projectedMonthlySaving ?? 0) > 0)
      .sort((a, b) => (b.projectedMonthlySaving ?? 0) - (a.projectedMonthlySaving ?? 0))[0] ?? null;
    return { totalGrossSpend, alreadySaved, currentSpend,
      recoverableSpend: rTool + rRAG + rHistory + rSystem,
      recoverablePercent: currentSpend > 0 ? parseFloat((((rTool + rRAG + rHistory + rSystem) / currentSpend) * 100).toFixed(1)) : 0,
      categories: cats, topFix, sessionRequests: entries.length };
  }

  function aggregateSessionAttribution(entries) {
    const agg = { systemPrompt: 0, toolSchemas: 0, ragChunks: 0, conversationHistory: 0, userQuery: 0, outputTokens: 0, total: 0 };
    for (const e of entries) {
      agg.systemPrompt        += e.attribution.systemPrompt.tokens;
      agg.toolSchemas         += e.attribution.toolSchemas.tokens;
      agg.ragChunks           += e.attribution.ragChunks.tokens;
      agg.conversationHistory += e.attribution.conversationHistory.tokens;
      agg.userQuery           += e.attribution.userQuery.tokens;
      agg.outputTokens        += e.attribution.outputTokens.tokens;
      agg.total               += e.attribution.totalInputTokens + e.attribution.totalOutputTokens;
    }
    return agg;
  }

  function aggregateSessionCost(entries) {
    let totalCost = 0, totalSaved = 0;
    let responseCacheHits = 0, nativeCacheHits = 0;
    const byModel = {};
    const byProvider = {};
    for (const e of entries) {
      const cost = realCostOf(e);
      totalCost  += cost;
      totalSaved += realSavingsOf(e);
      if (e.cached) responseCacheHits++;
      // Count only requests where the provider actually reported discounted
      // cache-read tokens — not just "this prompt was large enough to be
      // cacheable" (that's `e.nativeCache`, a predictive signal used for
      // recommending cache_control, not a record of a discount applied).
      if (e.nativeCachedTokens > 0) nativeCacheHits++;
      byModel[e.model] = (byModel[e.model] ?? 0) + cost;
      byProvider[e.provider] = (byProvider[e.provider] ?? 0) + cost;
    }
    return {
      totalCost, totalSaved,
      cacheHitRate: entries.length > 0 ? (responseCacheHits / entries.length) * 100 : 0,
      nativeCacheHitRate: entries.length > 0 ? (nativeCacheHits / entries.length) * 100 : 0,
      byModel,
      byProvider,
    };
  }

  function buildSessionLog(entries, limit = 50) {
    return entries.slice(-limit).reverse().map(e => ({
      timestamp:    e.timestamp,
      requestId:    e.requestId,
      provider:     e.provider,
      model:        e.model,
      cost:         realCostOf(e),
      saved:        realSavingsOf(e),
      cached:       e.cached,
      cacheType:    e.cacheType,
      nativeCache:  e.nativeCache,
      latencyMs:    e.latencyMs,
      inputTokens:  e.realInputTokens,
      outputTokens: e.realOutputTokens,
    }));
  }

  // ── MIME types ────────────────────────────────────────────────────────────────

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.woff2':'font/woff2',
  };

  // ── HTTP server ───────────────────────────────────────────────────────────────

  const server = createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      console.error('Request handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
      }
    }
  });

  function handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:7777');

    if (req.url === '/api/data') {
      const entries     = loadSessionEntries();
      const waste       = deriveWasteReport(entries);
      const sessionAgg  = aggregateSessionAttribution(entries);
      const sessionCost = aggregateSessionCost(entries);
      const sessionLog  = buildSessionLog(entries);
      const scenarios   = loadLatestSimulation();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        hasData:    entries.length > 0,
        entryCount: entries.length,
        waste,
        attribution: { sessionAgg, sessionCost, scenarios },
        sessionLog,
      }));
      return;
    }

    if (req.url === '/api/history') {
      const entries = loadHistoryEntries();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(groupHistoryByDay(entries)));
      return;
    }

    if (!existsSync(UI_DIR)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Dashboard UI not bundled. Run: npm run build in trimwares-dashboard.');
      return;
    }

    const urlPath  = req.url.split('?')[0];
    let   filePath = join(UI_DIR, urlPath);
    // No file extension → could be a directory route (e.g. /attribution/)
    // Always resolve to index.html for extensionless paths
    if (!extname(urlPath) || urlPath === '/') {
      const idx = join(UI_DIR, urlPath.replace(/\/?$/, ''), 'index.html');
      filePath = existsSync(idx) ? idx : join(UI_DIR, 'index.html');
    }
    if (!existsSync(filePath)) filePath = join(UI_DIR, 'index.html');

    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    const expires = license.exp ? new Date(license.exp * 1000).toISOString().split('T')[0] : 'n/a';
    console.log(`\n  \x1b[32m⚡ Trimwares Trace\x1b[0m  \x1b[90m(${license.tier} · expires ${expires})\x1b[0m`);
    console.log(`  \x1b[90mLocal:\x1b[0m   ${url}`);
    console.log(`  \x1b[90mData:\x1b[0m    ${resolve(process.cwd(), '.trimwares/session.jsonl')}`);
    console.log(`  \x1b[90mPolling every 2.5s — live as your app runs. Ctrl+C to stop.\x1b[0m\n`);
    const opener = process.platform === 'win32' ? `start ${url}`
                 : process.platform === 'darwin' ? `open ${url}`
                 : `xdg-open ${url}`;
    exec(opener);
  });

  process.on('SIGINT', () => { server.close(); process.exit(0); });
}

// ─── unknown ──────────────────────────────────────────────────────────────────

else {
  console.error(`\n  Unknown command: ${command}`);
  console.error('  Usage: npx trimwares analyze | serve | login --key KEY | clear\n');
  process.exit(1);
}
