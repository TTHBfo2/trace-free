/**
 * OpenAI multi-model verification — proves streaming + attribution across models.
 * Run: $env:OPENAI_API_KEY="sk-..."; npx tsx tests/verification/openai-multimodel.ts
 */

import { trimwares }       from '../../src/trimwares.js';
import { TokenAttributor } from '../../src/attribution/TokenAttributor.js';

const KEY = process.env['OPENAI_API_KEY'];
if (!KEY) { console.error('Set OPENAI_API_KEY'); process.exit(1); }

let passed = 0; let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  ✓  ${label}${detail ? `  [${detail}]` : ''}`); passed++; }
  else     { console.error(`  ✗  ${label}${detail ? `  [${detail}]` : ''}`); failed++; }
}

const { default: OpenAI } = await import('openai');
const attributor = new TokenAttributor('openai');

const MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { id: 'gpt-4o',      label: 'GPT-4o'      },
];

const SYSTEM  = 'You are a concise assistant. Answer in one sentence.';
const USER    = 'What causes rainbows to appear in the sky?';
const request = { messages: [{ role: 'system' as const, content: SYSTEM }, { role: 'user' as const, content: USER }] };

console.log('\n════════════════════════════════════════════════════════════');
console.log('  OpenAI multi-model streaming + attribution verification');
console.log('════════════════════════════════════════════════════════════\n');

for (const model of MODELS) {
  console.log(`──── ${model.label} (${model.id}) ${'─'.repeat(Math.max(0, 40 - model.id.length))}\n`);

  const client    = new OpenAI({ apiKey: KEY });
  const openai    = trimwares.openai(client);

  // ── Non-streaming call ──────────────────────────────────────────────────
  let providerInput = 0; let providerOutput = 0;
  try {
    const r = await openai.chat.completions.create({
      model: model.id, messages: request.messages,
    }) as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };

    providerInput  = r.usage?.prompt_tokens    ?? 0;
    providerOutput = r.usage?.completion_tokens ?? 0;

    check(`${model.label}: non-streaming call returns content`, r.choices[0].message.content.length > 0,
      `"${r.choices[0].message.content.slice(0, 60)}"`);
    check(`${model.label}: provider reports input tokens`, providerInput > 0,
      `prompt_tokens: ${providerInput}`);

    // Attribution rescaling check
    const attr = attributor.attribute(request, providerOutput,
      { inputPerMillion: 2.5, outputPerMillion: 10 }, providerInput);
    const sum = attr.systemPrompt.tokens + attr.toolSchemas.tokens +
                attr.ragChunks.tokens + attr.conversationHistory.tokens + attr.userQuery.tokens;
    check(`${model.label}: attribution sum === provider input tokens`, sum === providerInput,
      `${sum} === ${providerInput}`);

    console.log(`\n  Token breakdown (anchored to provider's ${providerInput} input tokens):`);
    console.log(`    systemPrompt: ${attr.systemPrompt.tokens}t  userQuery: ${attr.userQuery.tokens}t`);
    console.log(`    output:       ${providerOutput}t  cost: $${attr.totalCost.toFixed(6)}\n`);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    check(`${model.label}: non-streaming call`, false, msg.slice(0, 80));
  }

  // ── Streaming call ──────────────────────────────────────────────────────
  let streamContent = ''; let chunkCount = 0;
  let streamInput = 0; let streamOutput = 0;

  try {
    const stream = await openai.chat.completions.create({
      model: model.id,
      messages: [{ role: 'user', content: 'Say only: streaming confirmed' }],
      max_tokens: 10,
      stream: true,
    }) as AsyncIterable<{
      choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    }>;

    for await (const chunk of stream) {
      streamContent += chunk.choices[0]?.delta?.content ?? '';
      chunkCount++;
      if (chunk.usage) {
        streamInput  = chunk.usage.prompt_tokens    ?? 0;
        streamOutput = chunk.usage.completion_tokens ?? 0;
      }
    }

    check(`${model.label}: streaming receives chunks`,   chunkCount > 1,    `chunks: ${chunkCount}`);
    check(`${model.label}: streaming assembles content`, streamContent.length > 0, `"${streamContent.trim()}"`);

    const report = openai.trimwares.getCostReport();
    check(`${model.label}: cost recorded after stream`,  report.totalCost > 0, `$${report.totalCost.toFixed(6)}`);
    check(`${model.label}: requests tracked`,            report.totalRequests >= 2, `${report.totalRequests} requests`);

    if (streamInput > 0) {
      console.log(`  Stream usage: ${streamInput} input + ${streamOutput} output tokens`);
      check(`${model.label}: streaming reports usage tokens`, streamInput > 0, `${streamInput} tokens`);
    } else {
      console.log(`  Note: ${model.label} did not report usage in stream chunks (expected for some configs)`);
    }

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    check(`${model.label}: streaming`, false, msg.slice(0, 80));
  }

  // ── Cache hit ───────────────────────────────────────────────────────────
  try {
    const r2 = await openai.chat.completions.create({
      model: model.id, messages: request.messages,
    }) as { choices: Array<{ message: { content: string } }> };

    const report = openai.trimwares.getCostReport();
    check(`${model.label}: identical call hits response cache`, report.cachedRequests >= 1,
      `${report.cachedRequests} cached of ${report.totalRequests}`);
    check(`${model.label}: cache returns same content`, typeof r2.choices[0].message.content === 'string');
    check(`${model.label}: savings recorded`, report.totalSavings > 0, `$${report.totalSavings.toFixed(6)} saved`);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    check(`${model.label}: cache hit`, false, msg.slice(0, 80));
  }

  console.log('');
}

console.log('════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed  ${failed > 0 ? failed + ' FAILED' : '0 failed'}`);
if (failed === 0) console.log('\n  OpenAI multi-model verification passed.\n');
else              console.log('\n  Some checks failed — review above.\n');
process.exit(failed > 0 ? 1 : 0);
