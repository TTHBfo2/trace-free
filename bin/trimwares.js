#!/usr/bin/env node
// CLI entry point — npx trimwares analyze | serve | login | clear

import { SessionLog }   from '../dist/telemetry/index.js';
import { renderReport } from '../dist/cli/analyze.js';
import { fileURLToPath } from 'node:url';

const _iconPath = (() => {
  try { return fileURLToPath(new URL('../assets/icon.png', import.meta.url)); } catch { return undefined; }
})();

const [,, command = 'analyze', ...rest] = process.argv;

// ─── License verification ─────────────────────────────────────────────────────

const PUBLIC_KEY_B64  = 'MCowBQYDK2VwAyEA+WiFm3fBMP/eHXnHqNN2aEXTlMbJLq51We0DcAN2nL8=';
const WORKER_URL      = process.env.TRIMWARES_WORKER_URL ?? 'https://license.trimwares.com';
const TOKEN_GRACE_SEC = 7 * 86400; // 7 days grace after token expiry

async function verifySignedToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const parts = tokenStr.trim().split('.');
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

async function getMachineId() {
  const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('fs');
  const { join }    = await import('path');
  const { homedir } = await import('os');
  const dir  = join(homedir(), '.trimwares');
  const path = join(dir, 'machine-id');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const { randomUUID } = await import('crypto');
  const id = randomUUID();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, id, 'utf8');
  return id;
}

async function loadConfig() {
  const { existsSync, readFileSync } = await import('fs');
  const { join }    = await import('path');
  const { homedir } = await import('os');
  const configPath  = join(homedir(), '.trimwares', 'config.json');
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, 'utf8')); } catch { return null; }
}

async function saveConfig(data) {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join }    = await import('path');
  const { homedir } = await import('os');
  const dir  = join(homedir(), '.trimwares');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(data, null, 2));
}

// ─── Project registry ─────────────────────────────────────────────────────────

async function loadProjectRegistry() {
  const { existsSync, readFileSync } = await import('fs');
  const { join }    = await import('path');
  const { homedir } = await import('os');
  const p = join(homedir(), '.trimwares', 'projects.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

async function saveProjectRegistry(projects) {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join }    = await import('path');
  const { homedir } = await import('os');
  const dir = join(homedir(), '.trimwares');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'projects.json'), JSON.stringify(projects, null, 2));
}

// Returns: new token string on success, 'server_rejected' if Worker explicitly denied (4xx), null if offline/unreachable
async function tryRefreshToken(activationToken, machineId) {
  try {
    const res = await fetch(`${WORKER_URL}/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token: activationToken, machineId }),
      signal:  AbortSignal.timeout(8000),
    });
    if (res.status >= 400 && res.status < 500) return 'server_rejected';
    if (!res.ok) return null;
    const data = await res.json();
    return data.token ?? null;
  } catch {
    return null;
  }
}

async function requireProLicense(feature = 'This feature') {
  const config = await loadConfig();

  // ── New flow: check activation token ────────────────────────────────────────
  if (config?.activationToken) {
    const payload = await verifySignedToken(config.activationToken);

    if (!payload) {
      console.error('\n  \x1b[31m✗ Activation token is invalid\x1b[0m');
      console.error('  Re-run: \x1b[33mnpx trimwares login --key YOUR_LICENSE_KEY\x1b[0m\n');
      process.exit(1);
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = payload.tokenExpires ?? 0;

    if (exp < now) {
      // Within grace period — try to refresh silently
      if (now - exp < TOKEN_GRACE_SEC) {
        const machineId = await getMachineId();
        const newToken  = await tryRefreshToken(config.activationToken, machineId);
        if (newToken === 'server_rejected') {
          console.error('\n  \x1b[31m✗ License expired or revoked\x1b[0m');
          console.error('  Renew at \x1b[36mtrimwares.com/pro\x1b[0m\n');
          process.exit(1);
        } else if (newToken) {
          await saveConfig({ ...config, activationToken: newToken });
        } else {
          console.error('\n  \x1b[33m⚠  Could not refresh license token (offline?)\x1b[0m');
          console.error('  Running on grace period. Connect to the internet and restart.\n');
        }
      } else {
        // Beyond grace — try one final refresh before blocking
        const machineIdFinal = await getMachineId();
        const finalToken     = await tryRefreshToken(config.activationToken, machineIdFinal);
        if (finalToken === 'server_rejected') {
          console.error('\n  \x1b[31m✗ License expired or revoked\x1b[0m');
          console.error('  Renew at \x1b[36mtrimwares.com/pro\x1b[0m\n');
          process.exit(1);
        } else if (finalToken) {
          await saveConfig({ ...config, activationToken: finalToken });
        } else {
          // Truly offline and beyond grace — fail open to avoid locking out users with no internet
          console.error('\n  \x1b[33m⚠  License token expired and could not be refreshed (offline?)\x1b[0m');
          console.error('  Dashboard starting in limited mode. Reconnect to the internet to renew.\n');
          return payload;
        }
      }
    } else if (exp - now < 7 * 86400) {
      // Near expiry — refresh silently in background (only save if not rejected)
      getMachineId().then(machineId =>
        tryRefreshToken(config.activationToken, machineId).then(newToken => {
          if (newToken && newToken !== 'server_rejected') saveConfig({ ...config, activationToken: newToken });
        }),
      ).catch(() => {});
    }

    const validTiers = ['pro', 'team', 'enterprise'];
    if (!validTiers.includes(payload.tier)) {
      console.error('\n  \x1b[31m✗ This license does not include the dashboard\x1b[0m');
      console.error('  Upgrade at \x1b[36mtrimwares.com/pro\x1b[0m\n');
      process.exit(1);
    }

    return payload;
  }

  // ── Legacy fallback: bare license key (pre-Worker) ──────────────────────────
  if (config?.licenseKey) {
    const payload = await verifySignedToken(config.licenseKey);
    if (payload) {
      const now = Math.floor(Date.now() / 1000);
      if (!payload.exp || payload.exp > now) {
        console.error('\n  \x1b[33m⚠  Please re-activate your license to continue\x1b[0m');
        console.error('  Run: \x1b[33mnpx trimwares login --key YOUR_LICENSE_KEY\x1b[0m\n');
        process.exit(1);
      }
    }
  }

  console.error('\n  \x1b[31m✗ Pro license required\x1b[0m');
  console.error('  \x1b[90m──────────────────────────────────────────\x1b[0m');
  console.error(`  ${feature} is a Pro feature.`);
  console.error('  Get a license at \x1b[36mtrimwares.com/pro\x1b[0m');
  console.error('  Then activate it:\n');
  console.error('    \x1b[33mnpx trimwares login --key YOUR_LICENSE_KEY\x1b[0m\n');
  process.exit(1);
}

// ─── analyze ─────────────────────────────────────────────────────────────────

if (command === 'analyze') {
  const log     = new SessionLog();
  const entries = log.readAll();

  // Silently check Pro status — free users see attribution data, Pro sees recommendations
  let isPro = false;
  try {
    const cfg = await loadConfig();
    if (cfg?.activationToken) {
      const payload = await verifySignedToken(cfg.activationToken);
      if (payload) {
        const now = Math.floor(Date.now() / 1000);
        const exp = payload.tokenExpires ?? payload.exp ?? 0;
        const validTiers = ['pro', 'team', 'enterprise'];
        isPro = validTiers.includes(payload.tier) && (exp === 0 || exp > now - TOKEN_GRACE_SEC);
      }
    }
  } catch { /* silent — always show free output on any error */ }

  process.stdout.write(renderReport({ entries, isPro }));
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

  // Step 1: verify signature locally before hitting the network
  process.stdout.write('\n  Verifying license key… ');
  const localPayload = await verifySignedToken(keyStr);
  if (!localPayload) {
    console.error('\n  \x1b[31m✗ Invalid license key\x1b[0m');
    console.error('  The signature could not be verified. Check that you copied it correctly.');
    console.error('  Contact \x1b[36mtrimwares.com/support\x1b[0m if this keeps happening.\n');
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  if (localPayload.exp && localPayload.exp < now) {
    const expired = new Date(localPayload.exp * 1000).toISOString().split('T')[0];
    console.error(`\n  \x1b[31m✗ This key expired on ${expired}\x1b[0m`);
    console.error('  Renew at \x1b[36mtrimwares.com/pro\x1b[0m\n');
    process.exit(1);
  }
  console.log('✓');

  // Step 2: register machine with Cloudflare Worker to get activation token
  process.stdout.write('  Activating on this machine… ');
  const machineId = await getMachineId();
  let activationToken = null;
  let workerTier      = localPayload.tier;
  let workerEmail     = localPayload.email ?? null;
  let workerExpires   = localPayload.exp
    ? new Date(localPayload.exp * 1000).toISOString().split('T')[0]
    : 'never';

  try {
    const res = await fetch(`${WORKER_URL}/activate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: keyStr, machineId }),
      signal:  AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`\n  \x1b[31m✗ ${data.error ?? 'Activation failed'}\x1b[0m\n`);
      process.exit(1);
    }
    activationToken = data.token;
    workerTier      = data.tier      ?? workerTier;
    workerEmail     = data.email     ?? workerEmail;
    workerExpires   = data.expires   ?? workerExpires;
    console.log('✓');
  } catch (e) {
    console.error(`\n  \x1b[31m✗ Could not reach activation server: ${e.message}\x1b[0m`);
    console.error('  Check your internet connection and try again.\n');
    process.exit(1);
  }

  // Step 3: store activation token
  await saveConfig({
    licenseKey:      keyStr,
    activationToken,
    tier:            workerTier,
    email:           workerEmail,
    customerId:      localPayload.customerId ?? null,
    expiresAt:       workerExpires,
  });

  console.log(`\n  \x1b[32m✓ License activated\x1b[0m`);
  console.log(`  \x1b[90m─────────────────────────────────\x1b[0m`);
  console.log(`  Tier:    \x1b[36m${workerTier}\x1b[0m`);
  if (workerEmail) console.log(`  Email:   ${workerEmail}`);
  console.log(`  Expires: ${workerExpires}`);
  console.log(`\n  Run \x1b[33mnpx trimwares serve\x1b[0m to open the dashboard.\n`);
  process.exit(0);
}

// ─── clear ───────────────────────────────────────────────────────────────────

if (command === 'clear') {
  const { unlinkSync, existsSync, readFileSync, appendFileSync, mkdirSync } = await import('fs');
  const dir      = process.env.TRIMWARES_LOG_DIR ?? '.trimwares';
  const sessPath = `${dir}/session.jsonl`;
  const histPath = `${dir}/history.jsonl`;
  if (existsSync(sessPath)) {
    // Flush session entries into history before clearing so long-running
    // apps don't lose data when the log is rotated.
    try {
      mkdirSync(dir, { recursive: true });
      const lines = readFileSync(sessPath, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 0) {
        appendFileSync(histPath, lines.join('\n') + '\n', 'utf8');
        console.log(`  Archived ${lines.length} entries to history.`);
      }
    } catch { /* non-fatal — still clear the session */ }
    unlinkSync(sessPath);
    console.log('  Session log cleared.');
  } else {
    console.log('  No session log found.');
  }
  process.exit(0);
}

// ─── deactivate ──────────────────────────────────────────────────────────────

if (command === 'deactivate') {
  const cfg = await loadConfig();
  if (!cfg?.activationToken) {
    console.error('\n  \x1b[31m✗ No active license found on this machine\x1b[0m');
    console.error('  Run \x1b[33mnpx trimwares login --key YOUR_KEY\x1b[0m to activate first.\n');
    process.exit(1);
  }

  const machineId = await getMachineId();
  process.stdout.write('\n  Deactivating this machine… ');

  try {
    const res = await fetch(`${WORKER_URL}/deactivate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token: cfg.activationToken, machineId }),
      signal:  AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`\n  \x1b[31m✗ ${data.error ?? 'Deactivation failed'}\x1b[0m\n`);
      process.exit(1);
    }
    console.log('✓');
    console.log(`  \x1b[90mSlots available: ${data.slotsAvailable ?? '?'} of 3\x1b[0m`);
  } catch (e) {
    console.error(`\n  \x1b[31m✗ Could not reach server: ${e.message}\x1b[0m`);
    console.error('  Your local license has been removed anyway.\n');
  }

  // Always clear local config regardless of network outcome
  const { existsSync, unlinkSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const configPath = join(homedir(), '.trimwares', 'config.json');
  if (existsSync(configPath)) unlinkSync(configPath);

  console.log('\n  \x1b[32m✓ License removed from this machine\x1b[0m');
  console.log('  Re-activate any time with \x1b[33mnpx trimwares login --key YOUR_KEY\x1b[0m\n');
  process.exit(0);
}

// ─── check (CI gate) ─────────────────────────────────────────────────────────

if (command === 'check') {
  // CI gate is a Pro feature — team/professional workflows only
  await requireProLicense('The CI gate (npx trimwares check)');

  const { readFileSync, existsSync } = await import('fs');
  const { resolve } = await import('path');

  const flags = Object.fromEntries(
    rest.reduce((acc, arg, i, arr) => {
      if (arg.startsWith('--')) acc.push([arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), arr[i + 1]]);
      return acc;
    }, [])
  );

  const maxDailyCost    = flags.maxDailyCost    ? parseFloat(flags.maxDailyCost)    : null;
  const minCacheRate    = flags.minCacheRate     ? parseFloat(flags.minCacheRate)    : null;
  const maxToolPct      = flags.maxToolPct       ? parseFloat(flags.maxToolPct)      : null;
  const maxMonthlySpend = flags.maxMonthlySpend  ? parseFloat(flags.maxMonthlySpend) : null;

  const histPath = resolve(process.cwd(), '.trimwares/history.jsonl');
  if (!existsSync(histPath)) {
    console.log('\n  \x1b[33m⚠ No history data found — nothing to check.\x1b[0m\n');
    process.exit(0);
  }

  const entries = readFileSync(histPath, 'utf8')
    .split('\n').filter(Boolean)
    .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });

  // Aggregate by day
  const byDay = {};
  let totalCached = 0, totalRequests = 0, totalMonthSpend = 0, totalToolCost = 0, totalSpend = 0;
  for (const e of entries) {
    const day = new Date(e.timestamp).toISOString().split('T')[0];
    if (!byDay[day]) byDay[day] = { spend: 0, requests: 0 };
    const cost = e.realCost ?? e.attribution?.totalCost ?? 0;
    const savings = e.realSavings ?? (e.cached ? cost : 0);
    byDay[day].spend    += cost;
    byDay[day].requests += 1;
    totalRequests++;
    if (e.cached) totalCached++;
    totalMonthSpend += cost;
    totalSpend      += cost;
    totalToolCost   += (e.attribution?.toolSchemas?.estimatedCost ?? 0) * (cost / (e.attribution?.totalCost || 1));
  }

  const days        = Object.values(byDay).sort((a, b) => a.date < b.date ? -1 : 1);
  const todaySpend  = days[days.length - 1]?.spend ?? 0;
  const cacheRate   = totalRequests > 0 ? totalCached / totalRequests : 0;
  const toolPct     = totalSpend > 0 ? totalToolCost / totalSpend : 0;

  let passed = 0; let failed = 0;
  const W = 38;
  console.log('\n  \x1b[1m⚡ Trimwares CI Check\x1b[0m\n');

  function checkLine(label, pass, actual, limit, unit) {
    const icon = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const val  = `${actual} ${unit}`;
    const lim  = `(limit: ${limit} ${unit})`;
    console.log(`  ${icon}  ${label.padEnd(W)} ${pass ? '\x1b[32m' : '\x1b[31m'}${val}\x1b[0m  \x1b[90m${lim}\x1b[0m`);
    if (pass) passed++; else failed++;
  }

  if (maxDailyCost !== null)    checkLine('Today\'s spend',       todaySpend  <= maxDailyCost,  `$${todaySpend.toFixed(6)}`,       `$${maxDailyCost.toFixed(2)}`,     '');
  if (maxMonthlySpend !== null) checkLine('30-day total spend',   totalMonthSpend <= maxMonthlySpend, `$${totalMonthSpend.toFixed(4)}`, `$${maxMonthlySpend.toFixed(2)}`, '');
  if (minCacheRate !== null)    checkLine('Cache hit rate',       cacheRate   >= minCacheRate,  `${(cacheRate * 100).toFixed(1)}%`, `${(minCacheRate * 100).toFixed(0)}%`, '');
  if (maxToolPct !== null)      checkLine('Tool schema overhead', toolPct     <= maxToolPct,    `${(toolPct * 100).toFixed(1)}%`,   `${(maxToolPct * 100).toFixed(0)}%`,  '');

  if (passed + failed === 0) {
    console.log('  No thresholds specified. Use --max-daily-cost, --min-cache-rate, --max-tool-pct, --max-monthly-spend\n');
    process.exit(0);
  }

  console.log(`\n  ${passed} passed  ${failed > 0 ? '\x1b[31m' + failed + ' FAILED\x1b[0m' : '0 failed'}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── add ─────────────────────────────────────────────────────────────────────

if (command === 'add') {
  const { resolve: resolvePath, basename } = await import('path');
  const { existsSync, readFileSync }       = await import('fs');
  const targetPath = rest[0] ? resolvePath(rest[0]) : resolvePath(process.cwd());

  if (!existsSync(targetPath)) {
    console.error(`\n  \x1b[31m✗ Path not found: ${targetPath}\x1b[0m\n`);
    process.exit(1);
  }

  const LLM_DEPS = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'groq-sdk',
    'langchain', '@langchain/openai', 'ollama', 'cohere-ai', 'mistralai', '@trimwares/trace'];
  const pkgPath = resolvePath(targetPath, 'package.json');
  const hasData = existsSync(resolvePath(targetPath, '.trimwares', 'session.jsonl'));
  let providers = [];
  if (existsSync(pkgPath)) {
    try {
      const pkg  = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      providers  = LLM_DEPS.filter(d => deps[d]);
    } catch { /* ignore */ }
  }

  const registry = await loadProjectRegistry();
  const alreadyAdded = registry.find(p => p.path === targetPath);
  if (alreadyAdded) {
    console.log(`\n  \x1b[33m⚠  Already registered:\x1b[0m ${alreadyAdded.name} (${targetPath})\n`);
    process.exit(0);
  }

  const name = basename(targetPath);
  registry.push({ path: targetPath, name, addedAt: Date.now(), providers, hasExistingData: hasData });
  await saveProjectRegistry(registry);

  console.log(`\n  \x1b[32m✓ Project added:\x1b[0m ${name}`);
  console.log(`  \x1b[90mPath:\x1b[0m ${targetPath}`);
  if (providers.length > 0) console.log(`  \x1b[90mLLM providers:\x1b[0m ${providers.join(', ')}`);
  if (hasData) console.log(`  \x1b[32m⚡ Existing session data found\x1b[0m`);
  console.log(`\n  Start the dashboard: \x1b[33mnpx trimwares serve\x1b[0m\n`);
  process.exit(0);
}

// ─── daemon ───────────────────────────────────────────────────────────────────

if (command === 'daemon') {
  const subcommand = rest[0] ?? 'status';
  const { fileURLToPath } = await import('url');
  const { join: pathJoin } = await import('path');
  const { homedir }       = await import('os');
  const { exec: execCmd } = await import('child_process');
  const { existsSync: fsExists } = await import('fs');
  const { writeFileSync: fsWrite, mkdirSync: fsMkdir } = await import('fs');

  const scriptPath = fileURLToPath(import.meta.url);
  const nodePath   = process.execPath;
  const logDir     = pathJoin(homedir(), '.trimwares');
  fsMkdir(logDir, { recursive: true });

  const run = (cmd) => new Promise((ok, fail) =>
    execCmd(cmd, (err, stdout, stderr) => err ? fail(err) : ok((stdout + stderr).trim()))
  );

  if (process.platform === 'darwin') {
    const plistPath = pathJoin(homedir(), 'Library', 'LaunchAgents', 'com.trimwares.trace.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.trimwares.trace</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${pathJoin(logDir, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${pathJoin(logDir, 'daemon-error.log')}</string>
</dict>
</plist>`;

    if (subcommand === 'start') {
      fsWrite(plistPath, plist, 'utf8');
      try { await run(`launchctl unload "${plistPath}" 2>/dev/null`); } catch { /* ok */ }
      await run(`launchctl load -w "${plistPath}"`);
      console.log('\n  \x1b[32m✓ Daemon started\x1b[0m — Trimwares Trace runs at boot');
      console.log(`  Dashboard: \x1b[36mhttp://localhost:7778\x1b[0m`);
      console.log(`  Logs: ${pathJoin(logDir, 'daemon.log')}\n`);
    } else if (subcommand === 'stop') {
      try { await run(`launchctl unload "${plistPath}"`); console.log('\n  \x1b[32m✓ Daemon stopped\x1b[0m\n'); }
      catch { console.error('\n  \x1b[31m✗ Daemon not running\x1b[0m\n'); }
    } else {
      const running = fsExists(plistPath);
      console.log(`\n  Daemon: ${running ? '\x1b[32minstalled\x1b[0m' : '\x1b[90mnot installed\x1b[0m'}`);
      console.log(`  Start: \x1b[33mnpx trimwares daemon start\x1b[0m\n`);
    }

  } else if (process.platform === 'win32') {
    const taskName   = 'TrimwaresTrace';
    const startupDir = pathJoin(process.env.APPDATA ?? pathJoin(homedir(), 'AppData', 'Roaming'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const startupCmd = pathJoin(startupDir, 'TrimwaresTrace.cmd');
    // Escape inner quotes for schtasks /tr — cmd.exe needs \" inside the outer quotes
    const safeNode   = nodePath.replace(/"/g, '\\"');
    const safeScript = scriptPath.replace(/"/g, '\\"');
    const taskCmd    = `\\"${safeNode}\\" \\"${safeScript}\\" serve`;

    if (subcommand === 'start') {
      // Try Task Scheduler first (no /ru — avoids elevation requirement).
      // Fall back to Startup folder if schtasks is still denied.
      let usedStartup = false;
      try {
        try { await run(`schtasks /delete /tn "${taskName}" /f`); } catch { /* ok */ }
        await run(`schtasks /create /tn "${taskName}" /tr "${taskCmd}" /sc onlogon /f`);
      } catch {
        // Startup-folder fallback — always writable without admin
        fsMkdir(startupDir, { recursive: true });
        fsWrite(startupCmd, `@echo off\nstart "" "${nodePath}" "${scriptPath}" serve\n`, 'utf8');
        usedStartup = true;
      }
      // Kill any stale serve already holding the port before spawning fresh
      try { await run(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :7778') do taskkill /PID %a /F`); } catch { /* ok — port was free */ }
      await new Promise(r => setTimeout(r, 500)); // let OS release the port
      // Launch serve in a detached background process
      const { spawn } = await import('child_process');
      spawn(nodePath, [scriptPath, 'serve'], {
        detached: true, stdio: 'ignore',
        env: { ...process.env },
      }).unref();
      console.log('\n  \x1b[32m✓ Daemon started\x1b[0m — Trimwares Trace runs at login');
      if (usedStartup) console.log('  \x1b[90m(registered via Startup folder — Task Scheduler unavailable)\x1b[0m');
      console.log(`  Dashboard: \x1b[36mhttp://localhost:7778\x1b[0m\n`);
    } else if (subcommand === 'stop') {
      let stopped = false;
      try { await run(`schtasks /end /tn "${taskName}"`); stopped = true; } catch { /* ok */ }
      // Also kill any detached node process serving on 7778
      try { await run(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :7778') do taskkill /PID %a /F`); stopped = true; } catch { /* ok */ }
      if (stopped) console.log('\n  \x1b[32m✓ Daemon stopped\x1b[0m\n');
      else console.error('\n  \x1b[31m✗ Could not stop daemon\x1b[0m\n');
    } else {
      let installed = false;
      try {
        const out = await run(`schtasks /query /tn "${taskName}" /fo LIST`);
        installed = out.includes(taskName);
      } catch { /* not in task scheduler */ }
      if (!installed) installed = fsExists(startupCmd);
      console.log(`\n  Daemon: ${installed ? '\x1b[32minstalled\x1b[0m' : '\x1b[90mnot installed\x1b[0m'}`);
      // Check if serve is actually listening
      try {
        const net = await import('net');
        await new Promise((ok, fail) => {
          const s = net.createConnection(7778, '127.0.0.1');
          s.on('connect', () => { s.destroy(); ok(); });
          s.on('error',   () => { s.destroy(); fail(); });
        });
        console.log('  Server:  \x1b[32mlistening on :7778\x1b[0m');
      } catch { console.log('  Server:  \x1b[90mnot running\x1b[0m'); }
      console.log(`  Start:   \x1b[33mnpx trimwares daemon start\x1b[0m\n`);
    }

  } else {
    // Linux — systemd user service
    const serviceDir  = pathJoin(homedir(), '.config', 'systemd', 'user');
    const servicePath = pathJoin(serviceDir, 'trimwares.service');
    const unit = `[Unit]
Description=Trimwares Trace Dashboard
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} serve
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

    if (subcommand === 'start') {
      fsMkdir(serviceDir, { recursive: true });
      fsWrite(servicePath, unit, 'utf8');
      await run('systemctl --user daemon-reload');
      await run('systemctl --user enable trimwares');
      await run('systemctl --user start trimwares');
      console.log('\n  \x1b[32m✓ Daemon started\x1b[0m — Trimwares Trace runs at login');
      console.log(`  Dashboard: \x1b[36mhttp://localhost:7778\x1b[0m`);
      console.log(`  Status: \x1b[33msystemctl --user status trimwares\x1b[0m\n`);
    } else if (subcommand === 'stop') {
      try { await run('systemctl --user stop trimwares'); console.log('\n  \x1b[32m✓ Daemon stopped\x1b[0m\n'); }
      catch { console.error('\n  \x1b[31m✗ Daemon not running\x1b[0m\n'); }
    } else {
      try {
        const out = await run('systemctl --user is-active trimwares');
        const active = out.trim() === 'active';
        console.log(`\n  Daemon: ${active ? '\x1b[32mactive\x1b[0m' : '\x1b[90minactive\x1b[0m'}`);
      } catch {
        console.log('\n  Daemon: \x1b[90mnot installed\x1b[0m');
      }
      console.log(`  Start: \x1b[33mnpx trimwares daemon start\x1b[0m\n`);
    }
  }

  process.exit(0);
}

// ─── serve ───────────────────────────────────────────────────────────────────

if (command === 'serve') {

  // ── HARD GATE — nothing runs below this without a valid Pro license ─────────
  const license = await requireProLicense('The dashboard');

  const { createServer }                          = await import('http');
  const { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } = await import('fs');
  const { join, resolve, extname, basename }      = await import('path');
  const { homedir }                               = await import('os');
  const { fileURLToPath }                         = await import('url');
  const { exec }                                  = await import('child_process');
  const { buildRules, evaluateAlerts }            = await import('../dist/telemetry/AlertEngine.js').catch(() => ({ buildRules: () => [], evaluateAlerts: () => [] }));

  const portFlag = rest.indexOf('--port');
  const PORT     = portFlag !== -1 && rest[portFlag + 1] ? parseInt(rest[portFlag + 1], 10) : 7778;
  const __dir  = fileURLToPath(new URL('.', import.meta.url));
  const UI_DIR = resolve(__dir, '../ui');

  // ── data helpers ─────────────────────────────────────────────────────────────

  // ── project registry (sync wrappers for serve context) ───────────────────────

  const REGISTRY_PATH = join(homedir(), '.trimwares', 'projects.json');

  function readProjectRegistry() {
    if (!existsSync(REGISTRY_PATH)) return [];
    try { return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')); } catch { return []; }
  }

  function writeProjectRegistry(reg) {
    mkdirSync(join(homedir(), '.trimwares'), { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
  }

  const LLM_DEPS = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'groq-sdk',
    'langchain', '@langchain/openai', 'ollama', 'cohere-ai', 'mistralai', '@trimwares/trace'];

  function detectLLMProjectSync(absPath) {
    const pkgPath = join(absPath, 'package.json');
    const hasData = existsSync(join(absPath, '.trimwares', 'session.jsonl'));
    if (!existsSync(pkgPath)) return { compatible: hasData, providers: [], hasExistingData: hasData, hasPackageJson: false };
    try {
      const pkg  = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const found = LLM_DEPS.filter(d => deps[d]);
      return { compatible: found.length > 0 || hasData, providers: found, hasExistingData: hasData, hasPackageJson: true };
    } catch { return { compatible: hasData, providers: [], hasExistingData: hasData, hasPackageJson: false }; }
  }

  // ── per-path data loaders ─────────────────────────────────────────────────────

  // Normalizes any entry — old or new — into a consistent shape so downstream
  // code never needs to guard against missing attribution sub-fields.
  function normalizeEntry(raw, projectPath) {
    const a = raw.attribution ?? {};
    const safe = (sub) => ({ tokens: sub?.tokens ?? 0, estimatedCost: sub?.estimatedCost ?? 0 });
    const attr = {
      totalCost:           a.totalCost           ?? 0,
      totalInputTokens:    a.totalInputTokens     ?? 0,
      totalOutputTokens:   a.totalOutputTokens    ?? 0,
      systemPrompt:        safe(a.systemPrompt),
      toolSchemas:         safe(a.toolSchemas),
      ragChunks:           safe(a.ragChunks),
      conversationHistory: safe(a.conversationHistory),
      userQuery:           safe(a.userQuery),
      outputTokens:        safe(a.outputTokens),
    };
    return {
      ...raw,
      _projectPath: projectPath,
      attribution:  attr,
      realCost:     raw.realCost    ?? attr.totalCost,
      realSavings:  raw.realSavings ?? (raw.cached ? attr.totalCost : 0),
    };
  }

  function loadSessionEntriesFrom(absPath) {
    const p = join(absPath, '.trimwares', 'session.jsonl');
    if (!existsSync(p)) return [];
    try {
      return readFileSync(p, 'utf8')
        .split('\n').filter(Boolean).slice(-500)
        .flatMap(l => { try { return [normalizeEntry(JSON.parse(l), absPath)]; } catch { return []; } });
    } catch { return []; }
  }

  function loadHistoryEntriesFrom(absPath) {
    const p = join(absPath, '.trimwares', 'history.jsonl');
    if (!existsSync(p)) return [];
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    try {
      return readFileSync(p, 'utf8')
        .split('\n').filter(Boolean)
        .flatMap(l => { try { return [normalizeEntry(JSON.parse(l), absPath)]; } catch { return []; } })
        .filter(e => e.timestamp && new Date(e.timestamp).getTime() >= cutoff);
    } catch { return []; }
  }

  // ── multi-project-aware loaders ───────────────────────────────────────────────

  function loadSessionEntries(projectPath) {
    const registry = readProjectRegistry();
    if (projectPath && projectPath !== 'all') return loadSessionEntriesFrom(projectPath);
    if (registry.length > 0) return registry.flatMap(p => loadSessionEntriesFrom(p.path));
    return loadSessionEntriesFrom(process.cwd());
  }

  function loadHistoryEntries(projectPath) {
    const registry = readProjectRegistry();
    if (projectPath && projectPath !== 'all') return loadHistoryEntriesFrom(projectPath);
    if (registry.length > 0) return registry.flatMap(p => loadHistoryEntriesFrom(p.path));
    return loadHistoryEntriesFrom(process.cwd());
  }

  function groupHistoryByDay(entries) {
    const byDay = {};
    for (const e of entries) {
      const day = new Date(e.timestamp).toISOString().split('T')[0];
      if (!day) continue;
      if (!byDay[day]) byDay[day] = { date: day, spend: 0, requests: 0, saved: 0, cached: 0, toolCost: 0 };
      const cost = realCostOf(e);
      byDay[day].spend    += cost;
      byDay[day].requests += 1;
      byDay[day].saved    += realSavingsOf(e);
      if (e.cached) byDay[day].cached += 1;
      // Scale heuristic tool-schema cost to actual billed cost so the ratio is accurate
      const heuristic = e.attribution?.totalCost || 1;
      byDay[day].toolCost += (e.attribution?.toolSchemas?.estimatedCost ?? 0) * (cost / heuristic);
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

  // Merges live session entries for today into the history days array so that
  // alert thresholds see current-day spend even before history.jsonl is written.
  function mergeSessionToday(days, sessionEntries) {
    const today = new Date().toISOString().split('T')[0];
    const todayE = sessionEntries.filter(e => e.timestamp && new Date(e.timestamp).toISOString().split('T')[0] === today);
    if (todayE.length === 0) return days;

    let spend = 0, saved = 0, cached = 0, toolCost = 0;
    for (const e of todayE) {
      const cost = realCostOf(e);
      spend    += cost;
      saved    += realSavingsOf(e);
      if (e.cached) cached++;
      const h = e.attribution.totalCost || 1;
      toolCost += (e.attribution.toolSchemas.estimatedCost * cost / h);
    }

    const idx = days.findIndex(d => d.date === today);
    const base = idx >= 0 ? days[idx] : { date: today, spend: 0, saved: 0, requests: 0, cached: 0, toolCost: 0 };
    const merged = {
      date: today,
      spend:    base.spend    + spend,
      saved:    base.saved    + saved,
      requests: base.requests + todayE.length,
      cached:   base.cached   + cached,
      toolCost: base.toolCost + toolCost,
    };

    if (idx >= 0) {
      return [...days.slice(0, idx), merged, ...days.slice(idx + 1)];
    }
    return [...days, merged].sort((a, b) => a.date.localeCompare(b.date));
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

  const ALERTS_CONFIG_PATH = resolve(process.cwd(), '.trimwares/alerts.json');

  function loadAlertsConfig() {
    if (!existsSync(ALERTS_CONFIG_PATH)) return {};
    try {
      const cfg = JSON.parse(readFileSync(ALERTS_CONFIG_PATH, 'utf8'));
      // Migrate old single maxDailySpend → spendThresholds array
      if (cfg.maxDailySpend != null && cfg.spendThresholds == null) {
        cfg.spendThresholds = [cfg.maxDailySpend];
        delete cfg.maxDailySpend;
      }
      return cfg;
    } catch { return {}; }
  }

  function saveAlertsConfig(cfg) {
    try {
      mkdirSync(resolve(process.cwd(), '.trimwares'), { recursive: true });
      writeFileSync(ALERTS_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  // Fields guaranteed by normalizeEntry — always numbers, never undefined.
  function realCostOf(e)    { return e.realCost    ?? 0; }
  function realSavingsOf(e) { return e.realSavings ?? 0; }

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

  function computeOptimizationScore(waste) {
    if (!waste || (waste.currentSpend === 0 && waste.alreadySaved === 0)) return null;
    const recov = waste.recoverablePercent ?? 0;
    let score = 95 - recov * 0.75;
    if (waste.alreadySaved > 0 && waste.totalGrossSpend > 0) {
      score += Math.min(15, (waste.alreadySaved / waste.totalGrossSpend) * 25);
    }
    return Math.round(Math.max(10, Math.min(100, score)));
  }

  function buildRecommendations(waste, entries) {
    const recs = [];
    const cats = waste.categories ?? [];
    function monthly(cat) { return cat?.projectedMonthlySaving ?? 0; }

    const sysCat  = cats.find(c => c.label === 'System prompts');
    const toolCat = cats.find(c => c.label === 'Unused tool schemas');
    const ragCat  = cats.find(c => c.label === 'Redundant RAG chunks');
    const histCat = cats.find(c => c.label === 'Stale conversation history');

    if (sysCat && sysCat.cost > 0 && sysCat.severity !== 'good') {
      recs.push({
        id: 'cache_system_prompt',
        title: 'Cache your system prompt',
        description: `Your system prompt is ${sysCat.percentOfSpend}% of spend and re-sent on every request. Adding Anthropic's cache_control cuts this cost by ~85%.`,
        estimatedMonthlySavings: monthly(sysCat),
        confidence: 96,
        difficulty: 'easy',
        timeToImplement: '5 min',
        category: 'caching',
        codeSnippet: `// Add cache_control to your system prompt message block\nconst response = await anthropic.messages.create({\n  system: [{\n    type: "text",\n    text: "You are a helpful assistant...",\n    cache_control: { type: "ephemeral" }  // ← add this line\n  }],\n  messages: [{ role: "user", content: userMessage }]\n});`,
      });
    }

    if (toolCat && toolCat.cost > 0) {
      recs.push({
        id: 'cache_tool_schemas',
        title: 'Cache tool schema definitions',
        description: `Tool definitions are ${toolCat.percentOfSpend}% of spend — re-sent on every agent step even when unchanged. Cache the schema prefix once.`,
        estimatedMonthlySavings: monthly(toolCat),
        confidence: 93,
        difficulty: 'easy',
        timeToImplement: '5 min',
        category: 'caching',
        codeSnippet: `// Add cache_control to the last tool in your tools array\nconst tools = [\n  { name: "search_web",  description: "...", input_schema: { ... } },\n  { name: "run_code",    description: "...", input_schema: { ... },\n    cache_control: { type: "ephemeral" } }  // ← last tool only\n];`,
      });
    }

    if (ragCat && ragCat.cost > 0) {
      recs.push({
        id: 'cache_rag_context',
        title: 'Cache stable document context',
        description: `Retrieved documents are ${ragCat.percentOfSpend}% of spend. If your knowledge base is stable, mark the document block cacheable to avoid re-billing it each request.`,
        estimatedMonthlySavings: monthly(ragCat),
        confidence: 85,
        difficulty: 'medium',
        timeToImplement: '20 min',
        category: 'caching',
        codeSnippet: `// Mark the last document block as cacheable\nconst docBlocks = retrievedDocs.map((doc, i) => ({\n  type: "text",\n  text: doc.content,\n  ...(i === retrievedDocs.length - 1\n    ? { cache_control: { type: "ephemeral" } }\n    : {}),\n}));`,
      });
    }

    if (histCat && histCat.cost > 0) {
      recs.push({
        id: 'trim_conversation_history',
        title: 'Limit conversation history window',
        description: `Conversation history is ${histCat.percentOfSpend}% of spend. Keeping only the last 10 turns reduces context size with minimal impact on quality.`,
        estimatedMonthlySavings: monthly(histCat),
        confidence: 88,
        difficulty: 'easy',
        timeToImplement: '10 min',
        category: 'pruning',
        codeSnippet: `// Trim history before each API call (user+assistant = 2 entries per turn)\nconst MAX_TURNS = 10;\nconst trimmedMessages = conversationHistory.slice(-(MAX_TURNS * 2));`,
      });
    }

    if (entries.length >= 5) {
      const expensive = entries.filter(e =>
        /gpt-4o(?!-mini)/i.test(e.model ?? '') ||
        /claude-3-5-sonnet|claude-3-opus|claude-opus/i.test(e.model ?? '')
      );
      if (expensive.length > entries.length * 0.3) {
        const potentialSavings = expensive.reduce((s, e) => s + realCostOf(e), 0) * 0.60 * 30;
        if (potentialSavings > 0.01) {
          recs.push({
            id: 'route_to_cheaper_models',
            title: 'Route simple tasks to smaller models',
            description: `${expensive.length} of ${entries.length} requests use premium models. Routing straightforward queries to GPT-4o Mini or Claude Haiku could cut those costs by ~60%.`,
            estimatedMonthlySavings: potentialSavings,
            confidence: 72,
            difficulty: 'medium',
            timeToImplement: '1-2 hrs',
            category: 'routing',
            codeSnippet: `// Pick model based on task complexity\nfunction selectModel(task) {\n  const needsReasoning = task.isMultiStep || task.requiresAnalysis;\n  return needsReasoning ? "gpt-4o" : "gpt-4o-mini";\n}`,
          });
        }
      }
    }

    return recs.sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings);
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
    // Compute session average cost (non-cached calls only) to detect outliers.
    const billable  = entries.filter(e => !e.cached).map(e => realCostOf(e)).filter(c => c > 0);
    const avgCost   = billable.length >= 5 ? billable.reduce((s, c) => s + c, 0) / billable.length : 0;

    return entries.slice(-limit).reverse().map(e => {
      const cost    = realCostOf(e);
      // Flag non-cached requests costing >3× the session average as anomalies.
      const anomaly = avgCost > 0 && !e.cached && cost > avgCost * 3;
      return {
        timestamp:    e.timestamp,
        requestId:    e.requestId,
        provider:     e.provider,
        model:        e.model,
        cost,
        saved:        realSavingsOf(e),
        cached:       e.cached,
        cacheType:    e.cacheType,
        nativeCache:  e.nativeCache,
        latencyMs:    e.latencyMs,
        inputTokens:  e.realInputTokens,
        outputTokens: e.realOutputTokens,
        anomaly,
      };
    });
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

  function filterByProject(entries, project) {
    if (!project) return entries;
    return entries.filter(e => e.labels?.project === project);
  }

  function handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', `http://localhost:${PORT}`);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const qs          = new URL(req.url, 'http://localhost').searchParams;
    const project     = qs.get('project')     || null;
    const projectPath = qs.get('projectPath') || null;
    const urlPath     = req.url.split('?')[0];

    // ── Projects list (registry-aware) ──────────────────────────────────────────
    if (urlPath === '/api/projects') {
      const registry = readProjectRegistry();
      if (registry.length > 0) {
        const projects = registry.map(p => {
          const entries  = loadSessionEntriesFrom(p.path);
          const history  = loadHistoryEntriesFrom(p.path);
          const allE     = [...entries, ...history];
          const spend    = allE.reduce((s, e) => s + realCostOf(e), 0);
          return { name: p.name, path: p.path, spend, requests: entries.length, providers: p.providers ?? [], addedAt: p.addedAt };
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ projects, mode: 'registry' }));
      } else {
        const all  = [...loadSessionEntriesFrom(process.cwd()), ...loadHistoryEntriesFrom(process.cwd())];
        const seen = new Set();
        for (const e of all) if (e.labels?.project) seen.add(e.labels.project);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ projects: [...seen].sort().map(n => ({ name: n, path: null })), mode: 'labels' }));
      }
      return;
    }

    // ── Add project ──────────────────────────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/api/projects/add') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { path: rawPath, name: rawName } = JSON.parse(body);
          const abs  = resolve(rawPath);
          const reg  = readProjectRegistry();
          if (!reg.find(p => p.path === abs)) {
            const det = detectLLMProjectSync(abs);
            reg.push({ path: abs, name: rawName || basename(abs), addedAt: Date.now(), providers: det.providers, hasExistingData: det.hasExistingData });
            writeProjectRegistry(reg);
          }
          const project = reg.find(p => p.path === abs);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, project }));
        } catch { res.writeHead(400); res.end('Bad request'); }
      });
      return;
    }

    // ── Remove project ───────────────────────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/api/projects/remove') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { path: rawPath } = JSON.parse(body);
          const abs = resolve(rawPath);
          writeProjectRegistry(readProjectRegistry().filter(p => p.path !== abs));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('Bad request'); }
      });
      return;
    }

    // ── File browser ─────────────────────────────────────────────────────────────
    if (urlPath === '/api/browse') {
      const rawPath = qs.get('path');

      // Special root sentinel — show drives on Windows, / on Unix
      if (!rawPath || rawPath === '__root__') {
        if (process.platform === 'win32') {
          // Enumerate drive letters A–Z
          const drives = [];
          for (let c = 65; c <= 90; c++) {
            const d = String.fromCharCode(c) + ':\\';
            try { readdirSync(d); drives.push({ name: d, path: d, hasPackageJson: false, hasData: existsSync(join(d, '.trimwares', 'session.jsonl')) }); } catch { /* not mounted */ }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ path: '__root__', parent: null, dirs: drives, isRoot: true }));
        } else {
          // Unix: start at home, allow going up to /
          const abs   = homedir();
          const items = readdirSync(abs, { withFileTypes: true });
          const dirs  = items
            .filter(i => i.isDirectory() && !i.name.startsWith('.') && i.name !== 'node_modules')
            .map(i => { const full = join(abs, i.name); return { name: i.name, path: full, hasPackageJson: existsSync(join(full, 'package.json')), hasData: existsSync(join(full, '.trimwares', 'session.jsonl')) }; })
            .sort((a, b) => a.name.localeCompare(b.name));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ path: abs, parent: abs !== '/' ? resolve(abs, '..') : '__root__', dirs }));
        }
        return;
      }

      try {
        const abs   = resolve(rawPath);
        const items = readdirSync(abs, { withFileTypes: true });
        const dirs  = items
          .filter(i => i.isDirectory() && !i.name.startsWith('.') && i.name !== 'node_modules')
          .map(i => {
            const full = join(abs, i.name);
            return { name: i.name, path: full, hasPackageJson: existsSync(join(full, 'package.json')), hasData: existsSync(join(full, '.trimwares', 'session.jsonl')) };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        // Parent: go up one level; if we'd hit the drive root on Windows, go to __root__ instead
        const up = resolve(abs, '..');
        const atDriveRoot = process.platform === 'win32' && up === abs;
        const parent = atDriveRoot ? '__root__' : (up !== abs ? up : null);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ path: abs, parent, dirs }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Cannot read directory' }));
      }
      return;
    }

    // ── LLM project detection ─────────────────────────────────────────────────────
    if (urlPath === '/api/detect') {
      const detPath = qs.get('path');
      if (!detPath) { res.writeHead(400); res.end('path required'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(detectLLMProjectSync(resolve(detPath))));
      return;
    }

    if (urlPath === '/api/data') {
      const entries     = filterByProject(loadSessionEntries(projectPath), project);
      const waste       = deriveWasteReport(entries);
      const sessionAgg  = aggregateSessionAttribution(entries);
      const sessionCost = aggregateSessionCost(entries);
      const sessionLog  = buildSessionLog(entries);
      const scenarios   = loadLatestSimulation();
      // Include detection info so the frontend can show precise setup steps
      const detectPath  = projectPath ?? process.cwd();
      const setup       = entries.length === 0 ? detectLLMProjectSync(detectPath) : null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        hasData:           entries.length > 0,
        entryCount:        entries.length,
        projectPath:       detectPath,
        setup,
        waste,
        optimizationScore: computeOptimizationScore(waste),
        attribution:       { sessionAgg, sessionCost, scenarios },
        sessionLog,
      }));
      return;
    }

    if (urlPath === '/api/history') {
      const histEntries    = filterByProject(loadHistoryEntries(projectPath), project);
      const sessionEntries = filterByProject(loadSessionEntries(projectPath), project);
      const { days }       = groupHistoryByDay(histEntries);
      const merged         = mergeSessionToday(days, sessionEntries);
      const spend30d       = merged.reduce((s, d) => s + d.spend, 0);
      const requests30d    = merged.reduce((s, d) => s + d.requests, 0);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        days: merged,
        totals: { spend30d, requests30d, avgDailySpend: merged.length > 0 ? spend30d / merged.length : 0 },
      }));
      return;
    }

    // ── Error log ────────────────────────────────────────────────────────────────
    if (urlPath === '/api/errors') {
      const dir      = process.env.TRIMWARES_LOG_DIR ?? '.trimwares';
      const errPath  = resolve(process.cwd(), dir, 'errors.jsonl');
      const errors   = existsSync(errPath)
        ? readFileSync(errPath, 'utf8').split('\n').filter(Boolean)
            .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
            .slice(-50).reverse()
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ errors, count: errors.length }));
      return;
    }

    // ── Models breakdown ────────────────────────────────────────────────────────
    if (urlPath === '/api/models') {
      const entries = filterByProject(loadSessionEntries(projectPath), project);
      const byModel = {};
      for (const e of entries) {
        const key = `${e.provider ?? 'unknown'}::${e.model ?? 'unknown'}`;
        if (!byModel[key]) byModel[key] = {
          model: e.model ?? 'unknown', provider: e.provider ?? 'unknown',
          requests: 0, totalCost: 0, saved: 0, cachedRequests: 0,
          inputTokens: 0, outputTokens: 0,
        };
        const m = byModel[key];
        m.requests      += 1;
        m.totalCost     += realCostOf(e);
        m.saved         += realSavingsOf(e);
        m.inputTokens   += e.realInputTokens  ?? 0;
        m.outputTokens  += e.realOutputTokens ?? 0;
        if (e.cached) m.cachedRequests += 1;
      }
      const models = Object.values(byModel)
        .map(m => ({ ...m, cacheRate: m.requests > 0 ? Math.round(m.cachedRequests / m.requests * 100) : 0 }))
        .sort((a, b) => b.totalCost - a.totalCost);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ models }));
      return;
    }

    // ── Recommendations ──────────────────────────────────────────────────────────
    if (urlPath === '/api/recommendations') {
      const entries      = filterByProject(loadSessionEntries(projectPath), project);
      const waste        = deriveWasteReport(entries);
      const recs         = buildRecommendations(waste, entries);
      const score        = computeOptimizationScore(waste);
      const totalSavings = recs.reduce((s, r) => s + r.estimatedMonthlySavings, 0);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ recommendations: recs, optimizationScore: score, totalPotentialSavings: totalSavings }));
      return;
    }

    // ── License info ────────────────────────────────────────────────────────────
    if (urlPath === '/api/license') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const expTs2 = license.tokenExpires ?? license.exp ?? 0;
      const expires = expTs2 ? new Date(expTs2 * 1000).toISOString().split('T')[0] : null;
      res.end(JSON.stringify({ tier: license.tier ?? 'pro', email: license.email ?? '', expires }));
      return;
    }

    // ── Alert config GET ────────────────────────────────────────────────────────
    if (req.method === 'GET' && urlPath === '/api/alerts/config') {
      const cfg = loadAlertsConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(cfg));
      return;
    }

    // ── Alert config POST (save thresholds) ─────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/api/alerts/config') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const cfg = JSON.parse(body);
          saveAlertsConfig(cfg);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end('Bad JSON');
        }
      });
      return;
    }

    // ── Fire a test notification immediately ────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/api/alerts/test') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const cfg = loadAlertsConfig();
          const { title = 'Trimwares Trace', message = 'Test alert — notifications are working!' } = body ? JSON.parse(body) : {};
          sendDesktopNotification(title, message, { sound: cfg.sound ?? false });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end('Bad JSON');
        }
      });
      return;
    }

    // ── Alerts evaluation ───────────────────────────────────────────────────────
    if (urlPath === '/api/alerts') {
      const cfg       = loadAlertsConfig();
      const history   = groupHistoryByDay(loadHistoryEntries(projectPath));
      const days      = mergeSessionToday(history.days, loadSessionEntries(projectPath));
      const rules     = buildRules(cfg);
      const state     = loadAlertState();
      // Replace generated timestamps with persisted first-triggered times so the
      // UI shows when the alert actually crossed the threshold, not when the page loaded.
      const triggered = evaluateAlerts(days, cfg).map(a => ({
        ...a,
        timestamp: state[a.ruleId] ?? a.timestamp,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ rules, triggered, config: cfg }));
      return;
    }

    // ── Export ──────────────────────────────────────────────────────────────────
    if (urlPath.startsWith('/api/export')) {
      const fmt = new URL(req.url, 'http://localhost').searchParams.get('format') ?? 'json';
      const entries = loadSessionEntries();
      const history = groupHistoryByDay(loadHistoryEntries());
      const waste   = deriveWasteReport(entries);

      if (fmt === 'csv') {
        const header = 'timestamp,requestId,provider,model,inputTokens,outputTokens,cost,savings,cached,latencyMs\n';
        const rows = entries.map(e =>
          [e.timestamp, e.requestId, e.provider, e.model,
           e.realInputTokens ?? 0, e.realOutputTokens ?? 0,
           (e.realCost ?? 0).toFixed(6), (e.realSavings ?? 0).toFixed(6),
           e.cached ? 'true' : 'false', e.latencyMs ?? 0].join(',')
        ).join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="trimwares-export.csv"',
        });
        res.end(header + rows);
        return;
      }

      if (fmt === 'md') {
        const totalSpend = waste.currentSpend;
        const saved      = waste.alreadySaved;
        const md = [
          '# Trimwares Trace — Cost Report',
          '',
          `**Generated:** ${new Date().toISOString().split('T')[0]}`,
          `**Requests:** ${entries.length}  |  **Spend:** $${totalSpend.toFixed(6)}  |  **Saved:** $${saved.toFixed(6)}`,
          '',
          '## 30-Day History',
          '',
          '| Date | Spend | Saved | Requests |',
          '|------|-------|-------|----------|',
          ...(history.days.slice().reverse().map(d =>
            `| ${d.date} | $${d.spend.toFixed(6)} | $${d.saved.toFixed(6)} | ${d.requests} |`
          )),
          '',
          '## Spend by Category',
          '',
          ...waste.categories.map(c =>
            `- **${c.label}**: $${c.cost.toFixed(6)} (${c.percentOfSpend}% of spend)`
          ),
        ].join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="trimwares-report.md"',
        });
        res.end(md);
        return;
      }

      // Default: JSON
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="trimwares-export.json"',
      });
      res.end(JSON.stringify({ exportedAt: new Date().toISOString(), waste, history, entries }, null, 2));
      return;
    }

    if (!existsSync(UI_DIR)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Dashboard UI not bundled. Run: npm run build in trimwares-dashboard.');
      return;
    }

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

  // ── Cross-platform desktop notification via node-notifier ────────────────────
  // Windows → Snoretoast (bundled) — proper Action Center registration
  // macOS   → terminal-notifier / osascript — native Notification Center
  // Linux   → notify-send / notifu — GNOME, KDE, XFCE

  let _notifier = null;
  async function getNotifier() {
    if (_notifier) return _notifier;
    const mod = await import('node-notifier');
    _notifier = mod.default ?? mod;
    return _notifier;
  }

  function sendDesktopNotification(title, message, { sound = false } = {}) {
    getNotifier().then(notifier => {
      notifier.notify({
        title,
        message,
        sound,
        wait: false,
        appID: 'Trimwares.Trace',
        icon: _iconPath,
      }, (err) => {
        if (err) {
          // Fallback for Linux environments where node-notifier may not work
          const safe = s => s.replace(/"/g, '\\"');
          exec(`notify-send "${safe(title)}" "${safe(message)}" 2>/dev/null`);
        }
      });
    }).catch(() => { /* non-fatal */ });
  }

  // ── Alert state tracking ──────────────────────────────────────────────────────
  // once       → notify once per crossing; re-arms when condition clears
  // moderate   → notify, then re-notify after intervalMinutes while still active
  // persistent → notify every poll cycle while active

  const notifiedAlerts   = new Set();        // 'once' mode: ruleIds already fired this crossing
  const lastNotifiedTime = new Map();        // 'moderate' mode: ruleId → ms timestamp of last notify
  let alertPollTimer     = null;

  // Persist when each alert FIRST fired so the UI shows the real event time,
  // not the time the dashboard last polled.
  const ALERT_STATE_PATH = resolve(process.cwd(), '.trimwares/alert-state.json');
  function loadAlertState() {
    try { return JSON.parse(readFileSync(ALERT_STATE_PATH, 'utf8')); } catch { return {}; }
  }
  function saveAlertState(state) {
    try {
      mkdirSync(resolve(process.cwd(), '.trimwares'), { recursive: true });
      writeFileSync(ALERT_STATE_PATH, JSON.stringify(state), 'utf8');
    } catch { /* non-fatal */ }
  }
  let alertState = loadAlertState(); // { ruleId: firstTriggeredMs }

  function pollAlerts() {
    try {
      const cfg = loadAlertsConfig();
      if (Object.keys(cfg).length === 0) return;
      const history  = groupHistoryByDay(loadHistoryEntries());
      const days     = mergeSessionToday(history.days, loadSessionEntries());
      const fired    = evaluateAlerts(days, cfg);
      const firedIds = new Set(fired.map(a => a.ruleId));
      const now      = Date.now();
      const useSound = cfg.sound ?? false;

      let stateChanged = false;
      for (const alert of fired) {
        // Record the real event time on first crossing — persisted so dashboard
        // shows when it happened, not when the user next opened the page.
        if (!alertState[alert.ruleId]) {
          alertState[alert.ruleId] = now;
          stateChanged = true;
        }

        // Dynamic spend_at_X.XX ruleIds all share the 'spend_threshold' notification config
        const notifKey   = alert.type === 'spend_threshold' ? 'spend_threshold' : alert.ruleId;
        const notifCfg   = cfg.notifications?.[notifKey] ?? {};
        const mode       = notifCfg.mode ?? 'once';
        const intervalMs = (notifCfg.intervalMinutes ?? 5) * 60 * 1000;

        let shouldNotify = false;
        if (mode === 'persistent') {
          shouldNotify = true;
        } else if (mode === 'moderate') {
          const last = lastNotifiedTime.get(alert.ruleId) ?? 0;
          if (now - last >= intervalMs) { shouldNotify = true; lastNotifiedTime.set(alert.ruleId, now); }
        } else {
          // 'once' (default)
          if (!notifiedAlerts.has(alert.ruleId)) { shouldNotify = true; notifiedAlerts.add(alert.ruleId); }
        }

        if (shouldNotify) {
          sendDesktopNotification('Trimwares Trace', alert.message, { sound: useSound });
          console.log(`\n  \x1b[33m⚠  Alert: ${alert.label}\x1b[0m`);
          console.log(`  ${alert.message}`);
          console.log(`  \x1b[90mView: http://localhost:${PORT}/alerts\x1b[0m\n`);
        }
      }
      // Clear state for resolved alerts
      for (const id of notifiedAlerts)   { if (!firedIds.has(id)) notifiedAlerts.delete(id); }
      for (const id of lastNotifiedTime.keys()) { if (!firedIds.has(id)) lastNotifiedTime.delete(id); }
      for (const id of Object.keys(alertState)) {
        if (!firedIds.has(id)) { delete alertState[id]; stateChanged = true; }
      }
      if (stateChanged) saveAlertState(alertState);
    } catch { /* non-fatal */ }
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  \x1b[31m✗ Port ${PORT} is already in use\x1b[0m`);
      console.error(`  Another process is running on that port.`);
      console.error(`  Run on a different port: \x1b[33mnpx trimwares serve --port 7779\x1b[0m\n`);
    } else {
      console.error(`\n  \x1b[31m✗ Server error: ${err.message}\x1b[0m\n`);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    const expTs = license.tokenExpires ?? license.exp ?? 0;
    const expires = expTs ? new Date(expTs * 1000).toISOString().split('T')[0] : 'n/a';

    // Auto-register cwd if no projects in registry yet
    const reg = readProjectRegistry();
    if (reg.length === 0) {
      const cwd = process.cwd();
      const det = detectLLMProjectSync(cwd);
      if (det.compatible || det.hasExistingData) {
        reg.push({ path: cwd, name: basename(cwd), addedAt: Date.now(), providers: det.providers, hasExistingData: det.hasExistingData });
        writeProjectRegistry(reg);
      }
    }

    console.log(`\n  \x1b[32m⚡ Trimwares Trace\x1b[0m  \x1b[90m(${license.tier} · expires ${expires})\x1b[0m`);
    console.log(`  \x1b[90mLocal:\x1b[0m    ${url}`);
    if (reg.length > 0) {
      console.log(`  \x1b[90mProjects:\x1b[0m ${reg.length} registered  \x1b[90m(npx trimwares add <path> to add more)\x1b[0m`);
    } else {
      console.log(`  \x1b[90mData:\x1b[0m     ${resolve(process.cwd(), '.trimwares/session.jsonl')}`);
    }
    console.log(`  \x1b[90mPolling every 2.5s · alerts every 30s — live as your app runs. Ctrl+C to stop.\x1b[0m\n`);
    const opener = process.platform === 'win32' ? `start ${url}`
                 : process.platform === 'darwin' ? `open ${url}`
                 : `xdg-open ${url}`;
    exec(opener);

    // Start background alert polling — fires desktop notifications independently of dashboard
    alertPollTimer = setInterval(pollAlerts, 30_000);
  });

  process.on('SIGINT', () => {
    if (alertPollTimer) clearInterval(alertPollTimer);
    server.close();
    process.exit(0);
  });
}

// ─── unknown ──────────────────────────────────────────────────────────────────

else {
  console.error(`\n  Unknown command: ${command}`);
  console.error('  Usage: npx trimwares analyze | serve | add [path] | daemon start|stop|status | login --key KEY | clear\n');
  process.exit(1);
}
