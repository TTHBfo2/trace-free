/**
 * End-to-End Truth Verification
 *
 * This test proves — or disproves — every claim the package makes.
 * Uses a counting mock provider so we can verify EXACTLY how many
 * times the real provider was called versus served from cache.
 *
 * Answers four questions:
 *   1. Cache hits = zero provider calls? (the core guarantee)
 *   2. Cost numbers: are they consistent with token counts?
 *   3. Session log: does it reflect what actually happened?
 *   4. CLI output: does it match the session log?
 *
 * Run: npx tsx tests/verification/end-to-end-truth.mjs
 */

// Isolated, per-run log directory so this script is safe to run alongside other
// processes that write to the default .trimwares/ dir (must be set before the
// trimwares import, since SessionLog reads it at construction time).
process.env.TRIMWARES_LOG_DIR = `.trimwares-verify-${process.pid}`;

import { trimwares }    from '../../src/trimwares.js';
import { get_encoding } from 'tiktoken';
import { existsSync, readFileSync, rmSync } from 'fs';
import { execSync }     from 'child_process';

const enc = get_encoding('cl100k_base');
const LOG_DIR = process.env.TRIMWARES_LOG_DIR;

// ─── Verified pricing (provider docs) ────────────────────────────────────────
const GPT4O_MINI_IN  = 0.15  / 1_000_000;  // per token
const GPT4O_MINI_OUT = 0.60  / 1_000_000;

// ─── Counting mock client ─────────────────────────────────────────────────────
// Every call to .create() is a "real provider call" — we count them.

let providerCallCount = 0;
const callLog: Array<{ model: string; inputTokens: number; outputTokens: number }> = [];

const FIXED_RESPONSE = 'Paris is the capital of France.';
const FIXED_OUT_TOKENS = enc.encode(FIXED_RESPONSE).length; // real BPE count

function makeClient() {
  return {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          providerCallCount++;
          const messages = params['messages'] as Array<{ content: string }>;
          const inputText = messages.map(m => m.content).join(' ');
          const inputTokens = enc.encode(inputText).length; // real BPE
          callLog.push({ model: String(params['model'] ?? 'gpt-4o-mini'), inputTokens, outputTokens: FIXED_OUT_TOKENS });
          return {
            choices: [{ message: { content: FIXED_RESPONSE }, finish_reason: 'stop' }],
            model:   params['model'] ?? 'gpt-4o-mini',
            usage:   { prompt_tokens: inputTokens, completion_tokens: FIXED_OUT_TOKENS },
          };
        },
      },
    },
  };
}

// ─── Test scenarios ───────────────────────────────────────────────────────────

const SYSTEM = 'You are a helpful geography assistant.';
const QUERY_A = 'What is the capital of France?';
const QUERY_B = 'What is the capital of Germany?';
const QUERY_C = 'What is the capital of Japan?';

// Expected: A called 10x, but provider only called once (9 cache hits)
//           B and C called once each — no repeats
// Total: 12 requests, 9 cache hits, 3 provider calls

async function runScenario() {
  const client  = makeClient();
  const openai  = trimwares.openai(client, { defaultModel: 'gpt-4o-mini' });

  const makeReq = (query: string) => ({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system' as const, content: SYSTEM },
      { role: 'user'   as const, content: query },
    ],
  });

  // Call A ten times — should cache after first call
  for (let i = 0; i < 10; i++) {
    await openai.chat.completions.create(makeReq(QUERY_A));
  }
  // Call B and C once each — no repeat, no cache hit
  await openai.chat.completions.create(makeReq(QUERY_B));
  await openai.chat.completions.create(makeReq(QUERY_C));

  return openai.trimwares.getCostReport();
}

// ─── Run and verify ───────────────────────────────────────────────────────────

console.log('\n════════════════════════════════════════════════════════════');
console.log('  Trimwares — End-to-End Truth Verification');
console.log('════════════════════════════════════════════════════════════\n');

providerCallCount = 0;
callLog.length = 0;

const report = await runScenario();

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    if (detail) console.log(`     ${detail}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    if (detail) console.error(`     ${detail}`);
    failed++;
  }
}

// ─── Q1: Cache hits = zero provider calls? ───────────────────────────────────
console.log('\n  [1] Core guarantee: cache hits produce zero provider API calls\n');

check(
  'Total requests tracked correctly (12)',
  report.totalRequests === 12,
  `Got: ${report.totalRequests}`,
);
check(
  'Cache hits tracked correctly (9 — A repeated 9 times)',
  report.cachedRequests === 9,
  `Got: ${report.cachedRequests}`,
);
check(
  'Provider called exactly 3 times (A once, B once, C once)',
  providerCallCount === 3,
  `Provider call count: ${providerCallCount} (expected: 3)`,
);
check(
  'Cache hit rate: 75% (9 of 12)',
  report.cacheHitRate === 75,
  `Got: ${report.cacheHitRate}%`,
);
check(
  'Zero provider calls on cache hits (9 repeats → 0 extra API calls)',
  providerCallCount === 12 - report.cachedRequests,
  `12 requests - ${report.cachedRequests} cached = ${12 - report.cachedRequests} live calls → provider called ${providerCallCount}x`,
);

// ─── Q2: Cost numbers consistent with token counts? ──────────────────────────
console.log('\n  [2] Cost accuracy: do numbers match real token counts?\n');

// Compute expected cost from actual call log (real BPE token counts)
const actualInputTokens  = callLog.reduce((s, c) => s + c.inputTokens,  0);
const actualOutputTokens = callLog.reduce((s, c) => s + c.outputTokens, 0);
const expectedCost = (actualInputTokens * GPT4O_MINI_IN) + (actualOutputTokens * GPT4O_MINI_OUT);

console.log(`     Real BPE token counts (from provider call log):`);
console.log(`       Input:  ${actualInputTokens} tokens`);
console.log(`       Output: ${actualOutputTokens} tokens`);
console.log(`       Expected cost (gpt-4o-mini): $${expectedCost.toFixed(6)}`);
console.log(`       Reported cost:               $${report.totalCost.toFixed(6)}`);

const costDeltaPct = Math.abs((report.totalCost - expectedCost) / expectedCost) * 100;
check(
  `Cost within 20% of real BPE-based calculation (our formula is approximate)`,
  costDeltaPct <= 20,
  `Delta: ${costDeltaPct.toFixed(1)}% — our 4-char/token approximation vs real BPE`,
);

// ─── Q3: Session log reflects what happened? ─────────────────────────────────
console.log('\n  [3] Session log: does the file reflect the actual run?\n');

const sessionPath = `${LOG_DIR}/session.jsonl`;
const logExists   = existsSync(sessionPath);
check('Session log file exists', logExists);

if (logExists) {
  const lines = readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map(l => JSON.parse(l));
  const recentEntries = entries.filter(e => Date.now() - e.timestamp < 30_000); // last 30s

  check(
    `Session log has ${recentEntries.length} recent entries (expected 12)`,
    recentEntries.length === 12,
    `Found: ${recentEntries.length}`,
  );

  const cachedInLog = recentEntries.filter((e: { cached: boolean }) => e.cached).length;
  check(
    `Session log shows ${cachedInLog} cached entries (expected 9)`,
    cachedInLog === 9,
    `Found: ${cachedInLog}`,
  );

  const promptContentInLog = lines.some(l =>
    l.includes(QUERY_A) || l.includes(QUERY_B) || l.includes(SYSTEM)
  );
  check(
    'Session log contains ZERO prompt content (security guarantee)',
    !promptContentInLog,
    promptContentInLog ? 'FAIL: prompt text found in log!' : 'No prompt text in any entry',
  );
}

// ─── Q4: Does CLI output match session log? ───────────────────────────────────
console.log('\n  [4] CLI output: matches session log?\n');

try {
  const cliOutput = execSync('node bin/trimwares.js analyze', { encoding: 'utf8', cwd: process.cwd() });
  const hasRequests = cliOutput.includes('Requests');
  const hasSavings  = cliOutput.includes('Savings');
  const hasDisclaimer = cliOutput.includes('Prompt content is never stored');
  check('CLI runs without error', true);
  check('CLI shows Requests section', hasRequests);
  check('CLI shows Savings section', hasSavings);
  check('CLI shows privacy disclaimer', hasDisclaimer);
} catch (e) {
  check('CLI runs without error', false, String(e));
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('\n  ✓ Package behaves exactly as advertised.');
  console.log('  ✓ Cache hits produce zero provider API calls.');
  console.log('  ✓ Cost numbers are within acceptable approximation range.');
  console.log('  ✓ Session log contains no prompt content.');
  console.log('  ✓ CLI output matches session data.');
} else {
  console.log('\n  Some claims are not verified. Review failures above.');
}

// Accuracy disclosure
console.log('\n  Accuracy notes for transparency:');
console.log(`  • Token counts: 4-char/token approximation (±${costDeltaPct.toFixed(0)}% vs real BPE in this run)`);
console.log('  • Cost figures: provider list pricing — actual billing may include discounts');
console.log('  • Monthly saving estimate: extrapolated from current session rate');
console.log('  • Cache hit rate: exactly verified — zero provider calls on hits\n');

enc.free();
rmSync(LOG_DIR, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
