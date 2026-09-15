/**
 * OpenAI reasoning model test — o1-mini and o3-mini.
 * Checks if our wrapper handles reasoning models without crashing,
 * and whether reasoning_tokens are visible/tracked.
 *
 * Run: $env:OPENAI_API_KEY="sk-..."; npx tsx tests/verification/openai-reasoning.ts
 */

import { trimwares } from '../../src/trimwares.js';

const KEY = process.env['OPENAI_API_KEY'];
if (!KEY) { console.error('Set OPENAI_API_KEY'); process.exit(1); }

let passed = 0; let failed = 0; let warned = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  ✓  ${label}${detail ? `  [${detail}]` : ''}`); passed++; }
  else     { console.error(`  ✗  ${label}${detail ? `  [${detail}]` : ''}`); failed++; }
}
function warn(label: string, detail = '') {
  console.log(`  ⚠  ${label}${detail ? `  [${detail}]` : ''}`); warned++;
}

const { default: OpenAI } = await import('openai');

const MODELS = ['o1-mini', 'o3-mini'];
const USER   = 'What is 12 times 13? Just give the number, nothing else.';

console.log('\n════════════════════════════════════════════════════════════');
console.log('  OpenAI reasoning model verification (o1-mini, o3-mini)');
console.log('════════════════════════════════════════════════════════════\n');

for (const model of MODELS) {
  console.log(`──── ${model} ${'─'.repeat(Math.max(0, 50 - model.length))}\n`);

  const client = new OpenAI({ apiKey: KEY });
  const openai = trimwares.openai(client);

  // ── Non-streaming ────────────────────────────────────────────────────────
  try {
    const r = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: USER }],
      max_completion_tokens: 500,
    }) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };

    const content        = r.choices[0].message.content ?? '';
    const promptTokens   = r.usage?.prompt_tokens    ?? 0;
    const outputTokens   = r.usage?.completion_tokens ?? 0;
    const reasoningTokens = r.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

    check(`${model}: call succeeds and returns content`, content.length > 0, `"${content.trim()}"` );
    check(`${model}: finish_reason is stop`, r.choices[0].finish_reason === 'stop', r.choices[0].finish_reason);
    check(`${model}: provider reports input tokens`, promptTokens > 0, `prompt_tokens: ${promptTokens}`);

    if (reasoningTokens > 0) {
      warn(`${model}: reasoning_tokens present but NOT tracked separately`, `${reasoningTokens} reasoning tokens (counted inside completion_tokens)`);
    } else {
      console.log(`  ℹ  ${model}: no reasoning_tokens in this response (short query)`);
    }

    const report = openai.trimwares.getCostReport();
    check(`${model}: cost recorded`, report.totalCost > 0, `$${report.totalCost.toFixed(6)}`);
    check(`${model}: tokens tracked`, (report.byProvider?.['openai']?.inputTokens ?? 0) > 0);

    console.log(`\n  Usage: ${promptTokens} input + ${outputTokens} output${reasoningTokens ? ` (${reasoningTokens} reasoning)` : ''} tokens`);
    console.log(`  Cost:  $${report.totalCost.toFixed(6)}\n`);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Model might not be available on this tier
    if (msg.includes('model') || msg.includes('404') || msg.includes('access')) {
      warn(`${model}: not available on this account tier`, msg.slice(0, 100));
    } else {
      check(`${model}: call succeeds`, false, msg.slice(0, 100));
    }
    console.log('');
    continue;
  }

  // ── Streaming ────────────────────────────────────────────────────────────
  try {
    const client2 = new OpenAI({ apiKey: KEY });
    const openai2 = trimwares.openai(client2);

    let content = ''; let chunks = 0; let streamUsageInput = 0;

    const stream = await openai2.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_completion_tokens: 500,
      stream: true,
    }) as AsyncIterable<{
      choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    }>;

    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta?.content ?? '';
      chunks++;
      if (chunk.usage?.prompt_tokens) streamUsageInput = chunk.usage.prompt_tokens;
    }

    check(`${model}: streaming works`, chunks > 0,       `${chunks} chunks`);
    check(`${model}: stream assembles content`, content.length > 0, `"${content.trim()}"`);

    const report2 = openai2.trimwares.getCostReport();
    check(`${model}: streaming cost recorded`, report2.totalCost > 0, `$${report2.totalCost.toFixed(6)}`);

    if (streamUsageInput > 0) {
      check(`${model}: streaming reports usage tokens`, true, `${streamUsageInput} input tokens`);
    } else {
      warn(`${model}: streaming did not report usage tokens in chunks (fallback to heuristic)`);
    }

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('stream') || msg.includes('not supported')) {
      warn(`${model}: streaming not supported`, msg.slice(0, 100));
    } else {
      check(`${model}: streaming`, false, msg.slice(0, 100));
    }
  }

  console.log('');
}

console.log('════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed  ${failed > 0 ? failed + ' FAILED' : '0 failed'}  ${warned > 0 ? warned + ' warnings' : ''}`);
if (failed === 0) console.log('\n  Reasoning model test complete.\n');
else              console.log('\n  Some checks failed — review above.\n');
process.exit(failed > 0 ? 1 : 0);
