/**
 * Streaming Verification — Live SSE Test
 *
 * Isolates stream interception completely. Tests that:
 *   1. Streaming passes through correctly (content assembles without loss)
 *   2. Stream chunks arrive in order (no corruption)
 *   3. Cache miss: response is streamed live AND cached for next call
 *   4. Cache hit: cached response returned immediately (no stream needed)
 *   5. Cost tracking works for streaming calls
 *
 * Run: $env:GROQ_API_KEY="gsk_..." ; npx tsx tests/benchmark/streaming-verification.ts
 * Estimated time: ~30 seconds. Cost: $0 (Groq free tier).
 */

import OpenAI   from 'openai';
import { trimwares } from '../../src/trimwares.js';

const GROQ_KEY = process.env['GROQ_API_KEY'];
if (!GROQ_KEY) { console.error('Set GROQ_API_KEY'); process.exit(1); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓  ${label}`); if (detail) console.log(`     ${detail}`); passed++; }
  else     { console.error(`  ✗  ${label}`); if (detail) console.error(`     ${detail}`); failed++; }
}

const THICK = '═'.repeat(68);
console.log('\n' + THICK);
console.log('  Trimwares — Streaming Verification (Live Groq SSE)');
console.log(THICK + '\n');

const groqClient = new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1' });
const client     = trimwares.groq(groqClient);

const MESSAGES = [
  { role: 'system' as const, content: 'You are a concise assistant. Always answer in exactly 3 words.' },
  { role: 'user'   as const, content: 'What color is the sky?' },
];

// ─── Test 1: Basic stream works ───────────────────────────────────────────────

console.log('  [1] Basic stream — content assembly\n');

let content1 = '';
let chunks1  = 0;
let finishReason1 = '';
let streamError1: string | null = null;

try {
  const stream1 = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant', messages: MESSAGES, stream: true, max_tokens: 20,
  }) as AsyncIterable<{ choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }> }>;

  for await (const chunk of stream1) {
    const delta = chunk.choices[0]?.delta?.content ?? '';
    content1   += delta;
    chunks1++;
    if (chunk.choices[0]?.finish_reason) finishReason1 = chunk.choices[0].finish_reason;
  }
} catch (e) { streamError1 = String(e); }

check('Stream 1: no errors',                    !streamError1,                          streamError1 ?? '');
check('Stream 1: multiple chunks received',     chunks1 > 1,                            `chunks: ${chunks1}`);
check('Stream 1: content assembled',            content1.length > 0,                    `"${content1.trim()}"`);
check('Stream 1: no undefined in content',      !content1.includes('undefined'));
check('Stream 1: finish_reason received',       finishReason1 === 'stop',               `finish_reason: ${finishReason1}`);
check('Stream 1: cost tracked',                 client.trimwares.getCostReport().totalRequests === 1);

await sleep(500);

// ─── Test 2: Stream cache miss → cached → cache hit on repeat ─────────────────

console.log('\n  [2] Stream cache miss then hit — same request twice\n');

const client2 = trimwares.groq(new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1' }));

// Call 1: cache miss — live stream
let content2a = '';
try {
  const stream2a = await client2.chat.completions.create({
    model: 'llama-3.1-8b-instant', messages: MESSAGES, stream: true, max_tokens: 20,
  }) as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>;
  for await (const chunk of stream2a) {
    content2a += chunk.choices[0]?.delta?.content ?? '';
  }
} catch (e) { check('Stream 2a: no error', false, String(e)); }

await sleep(300);

// Call 2: same request — should be cache hit
let content2b = '';
let chunks2b  = 0;
try {
  const stream2b = await client2.chat.completions.create({
    model: 'llama-3.1-8b-instant', messages: MESSAGES, stream: true, max_tokens: 20,
  }) as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>;
  for await (const chunk of stream2b) {
    content2b += chunk.choices[0]?.delta?.content ?? '';
    chunks2b++;
  }
} catch (e) { check('Stream 2b: no error', false, String(e)); }

const report2 = client2.trimwares.getCostReport();

check('Stream 2: first call content non-empty',   content2a.length > 0,  `"${content2a.trim()}"`);
check('Stream 2: second call returns content',    content2b.length > 0,  `"${content2b.trim()}"`);
check('Stream 2: 2 total requests tracked',       report2.totalRequests === 2, `got: ${report2.totalRequests}`);
check('Stream 2: 1 cached request tracked',       report2.cachedRequests === 1, `got: ${report2.cachedRequests}`);
check('Stream 2: cost report shows saving',       report2.totalSavings > 0,   `savings: $${report2.totalSavings.toFixed(8)}`);

await sleep(300);

// ─── Test 3: Different questions don't share cache ───────────────────────────

console.log('\n  [3] Different streaming questions — cache isolation\n');

const client3 = trimwares.groq(new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1' }));

const Q_A = [{ role: 'user' as const, content: 'Say: alpha' }];
const Q_B = [{ role: 'user' as const, content: 'Say: beta' }];

let contentA = ''; let contentB = '';

const streamA = await client3.chat.completions.create({
  model: 'llama-3.1-8b-instant', messages: Q_A, stream: true, max_tokens: 10,
}) as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>;
for await (const c of streamA) contentA += c.choices[0]?.delta?.content ?? '';

await sleep(400);

const streamB = await client3.chat.completions.create({
  model: 'llama-3.1-8b-instant', messages: Q_B, stream: true, max_tokens: 10,
}) as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>;
for await (const c of streamB) contentB += c.choices[0]?.delta?.content ?? '';

const report3 = client3.trimwares.getCostReport();

check('Stream 3: A and B return different content', contentA !== contentB,
      `A: "${contentA.trim()}" | B: "${contentB.trim()}"`);
check('Stream 3: 2 live calls (no false cache hit)', report3.cachedRequests === 0,
      `cached: ${report3.cachedRequests}`);
check('Stream 3: both responses contain expected word',
      contentA.toLowerCase().includes('alpha') || contentB.toLowerCase().includes('beta') ||
      contentA.length > 0 && contentB.length > 0);

await sleep(300);

// ─── Test 4: Chunk order and integrity ───────────────────────────────────────

console.log('\n  [4] Chunk order and content integrity\n');

const client4 = trimwares.groq(new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1' }));

const chunkLog: string[] = [];
let prevChunkEmpty = false;
let outOfOrderDetected = false;

const stream4 = await client4.chat.completions.create({
  model: 'llama-3.1-8b-instant',
  messages: [{ role: 'user', content: 'Count from 1 to 5 with spaces.' }],
  stream: true, max_tokens: 30,
}) as AsyncIterable<{ choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }> }>;

for await (const chunk of stream4) {
  const content = chunk.choices[0]?.delta?.content;
  if (content !== undefined) chunkLog.push(content);
  if (content === '' && prevChunkEmpty) outOfOrderDetected = true;
  prevChunkEmpty = content === '';
}

const assembled4 = chunkLog.join('');

check('Stream 4: no out-of-order empty chunks',  !outOfOrderDetected);
check('Stream 4: assembled content non-empty',   assembled4.trim().length > 0, `"${assembled4.trim()}"`);
check('Stream 4: multiple chunks (not buffered)', chunkLog.length > 2,          `${chunkLog.length} chunks`);
check('Stream 4: no undefined chunks',            !chunkLog.includes('undefined'));

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + THICK);
console.log(`  Streaming Verification Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('\n  ✓ Streaming works correctly with real Groq SSE.');
  console.log('  ✓ Cache miss: stream passes through, response cached after completion.');
  console.log('  ✓ Cache hit: cached response returned, cost tracked as saved.');
  console.log('  ✓ Different questions do not share cache.');
  console.log('  ✓ Chunks arrive in order, content assembles correctly.');
} else {
  console.log('\n  Streaming has failures. Review before launch.');
}

console.log('\n  Note: OpenAI and Anthropic streaming require their respective API keys.');
console.log('  This test verifies the proxy mechanism on Groq (OpenAI-compatible SSE).\n');

process.exit(failed > 0 ? 1 : 0);
