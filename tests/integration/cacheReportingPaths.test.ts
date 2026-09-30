/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { trimwares } from '../../src/trimwares.js';
import { renderReport } from '../../src/cli/analyze.js';
import { SessionLogEntry } from '../../src/types/index.js';

/**
 * Cache reporting through the REAL code paths, not the cost calculator.
 *
 * The unit suite (tests/core/nativeCacheReporting.test.ts) feeds CostEngine
 * inputs that are already normalized, so it cannot see the paths where the
 * normalization itself is wrong. Each case here is a bug that survived that
 * suite: streaming, the class-based API, cache replay, and the CLI.
 *
 * Provider responses are mocked with real captured shapes — no network, no key.
 */

// SessionLog does join(process.cwd(), dir), so the dir must be RELATIVE to cwd.
// .trimwares-test-* is already gitignored.
function tempLogDir(): string {
  const d = `.trimwares-test-cachepaths-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(process.cwd(), d), { recursive: true });
  process.env.TRIMWARES_LOG_DIR = d;
  made.push(d);
  return d;
}
function readEntries(dir: string): SessionLogEntry[] {
  const f = join(process.cwd(), dir, 'session.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as SessionLogEntry);
}
const strip = (s: string) => s.replace(/[[0-9;]*m/g, '');
const made: string[] = [];
afterAll(() => { for (const d of made) { try { rmSync(join(process.cwd(), d), { recursive: true, force: true }); } catch { /* best effort */ } } });
const wait = (ms = 150) => new Promise(r => setTimeout(r, ms));

const SYSTEM = 'x'.repeat(20000); // large enough to be cache-eligible
const REQ = (q: string) => ({
  model: 'gpt-4o-mini',
  messages: [{ role: 'system' as const, content: SYSTEM }, { role: 'user' as const, content: q }],
});

// A real captured OpenAI usage block: prompt_tokens includes cached_tokens.
const usageBlock = (prompt: number, cached: number, completion = 30) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: cached },
});

function fakeOpenAI(usage: ReturnType<typeof usageBlock>) {
  return {
    chat: {
      completions: {
        create: async () => ({
          model: 'gpt-4o-mini',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage,
        }),
      },
    },
  };
}

function fakeOpenAIStream(usage: ReturnType<typeof usageBlock> | null) {
  return {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { model: 'gpt-4o-mini', choices: [{ delta: { content: 'ok' } }] };
            if (usage) yield { model: 'gpt-4o-mini', choices: [{ delta: {} }], usage };
          },
        }),
      },
    },
  };
}

describe('non-streaming wrapper', () => {
  it('records the provider-reported cached tokens and the discounted cost', async () => {
    const dir = tempLogDir();
    const client = trimwares.openai(fakeOpenAI(usageBlock(4902, 4736)) as never) as any;
    await client.chat.completions.create(REQ('q1') as never);
    await wait();
    const [e] = readEntries(dir);
    expect(e.nativeCachedTokens).toBe(4736);
    expect(e.realInputTokens).toBe(166);     // uncached remainder only
    expect(e.nativeCache).toBe(true);
    expect(e.realSavings).toBeGreaterThan(0);
    // Attribution covers the WHOLE prompt, not just the uncached sliver.
    expect(e.attribution.totalInputTokens).toBe(4902);
  });
});

describe('streaming wrapper', () => {
  it('a FULLY cached response does not fall back to an estimated prompt', async () => {
    // The regression: uncached input of 0 is legitimate once the cache is warm,
    // but the code read `inputTokens === 0` as "usage missing" and substituted
    // an estimate, then billed it on top of the cached tokens (~3x over-report).
    const dir = tempLogDir();
    const client = trimwares.openai(fakeOpenAIStream(usageBlock(4902, 4902)) as never) as any;
    const stream = await client.chat.completions.create({ ...REQ('q2'), stream: true } as never);
    for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
    await wait();
    const [e] = readEntries(dir);
    expect(e.nativeCachedTokens).toBe(4902);
    expect(e.realInputTokens).toBe(0);               // genuinely zero uncached
    expect(e.attribution.totalInputTokens).toBe(4902); // still the whole prompt
    // Entire prompt at the cached rate, nothing invented.
    const expected = (4902 / 1_000_000) * 0.075 + (30 / 1_000_000) * 0.60;
    expect(e.realCost).toBeCloseTo(expected, 10);
  });

  it('a partially cached response attributes the whole prompt', async () => {
    const dir = tempLogDir();
    const client = trimwares.openai(fakeOpenAIStream(usageBlock(4902, 4736)) as never) as any;
    const stream = await client.chat.completions.create({ ...REQ('q3'), stream: true } as never);
    for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
    await wait();
    const [e] = readEntries(dir);
    expect(e.realInputTokens).toBe(166);
    expect(e.attribution.totalInputTokens).toBe(4902);
  });

  it('still estimates when the provider reports no usage at all', async () => {
    // The fallback must survive: absent usage is a different thing from
    // usage that legitimately reports zero uncached tokens.
    const dir = tempLogDir();
    const client = trimwares.openai(fakeOpenAIStream(null) as never) as any;
    const stream = await client.chat.completions.create({ ...REQ('q4'), stream: true } as never);
    for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
    await wait();
    const [e] = readEntries(dir);
    expect(e.realInputTokens).toBeGreaterThan(0);
    expect(e.nativeCachedTokens).toBe(0);
  });
});

describe('local response-cache replay', () => {
  it('attributes the original prompt, not just its uncached remainder', async () => {
    const dir = tempLogDir();
    const client = trimwares.openai(fakeOpenAI(usageBlock(4902, 4736)) as never) as any;
    await client.chat.completions.create(REQ('same') as never);
    await client.chat.completions.create(REQ('same') as never); // served locally
    await wait();
    const entries = readEntries(dir);
    expect(entries).toHaveLength(2);
    const replay = entries[1];
    expect(replay.cached).toBe(true);
    expect(replay.realCost).toBe(0);
    expect(replay.attribution.totalInputTokens).toBe(4902);
    // A local hit never reached the provider, so it earned no provider discount.
    expect(replay.nativeCache).toBe(false);
  });
});

describe('CLI reporting', () => {
  const entry = (over: Partial<SessionLogEntry>): SessionLogEntry => ({
    timestamp: Date.now(), requestId: Math.random().toString(36).slice(2),
    provider: 'openai', model: 'gpt-4o-mini',
    attribution: {
      systemPrompt: { tokens: 4800, estimatedCost: 0.0007, percentOfTotal: 95 },
      toolSchemas: { tokens: 0, estimatedCost: 0, percentOfTotal: 0 },
      ragChunks: { tokens: 0, estimatedCost: 0, percentOfTotal: 0 },
      conversationHistory: { tokens: 0, estimatedCost: 0, percentOfTotal: 0 },
      userQuery: { tokens: 100, estimatedCost: 0.00002, percentOfTotal: 3 },
      outputTokens: { tokens: 30, estimatedCost: 0.00002, percentOfTotal: 2 },
      totalInputTokens: 4900, totalOutputTokens: 30, totalCost: 0.00074,
    },
    cached: false, cacheType: 'none', latencyMs: 500, nativeCache: false,
    realInputTokens: 4900, realOutputTokens: 30,
    nativeCachedTokens: 0, realCost: 0.00074, realSavings: 0,
    ...over,
  } as SessionLogEntry);

  it('does not re-recommend caching when local hits dominate the request count', () => {
    // One real provider-cache hit, then three LOCAL hits. Counting local hits
    // in the denominator read as 25% cached and re-recommended caching.
    const entries = [
      entry({ nativeCachedTokens: 4736, nativeCache: true, realInputTokens: 166, realSavings: 0.00035 }),
      entry({ cached: true, cacheType: 'response', realCost: 0, realSavings: 0.00074 }),
      entry({ cached: true, cacheType: 'response', realCost: 0, realSavings: 0.00074 }),
      entry({ cached: true, cacheType: 'response', realCost: 0, realSavings: 0.00074 }),
    ];
    const out = strip(renderReport({ entries, isPro: true }));
    expect(out).not.toMatch(/Provider-native caching on system prompt/);
  });

  it('quotes OpenAI\'s real discount, not Anthropic\'s 90%', () => {
    const entries = [entry({}), entry({}), entry({})]; // no caching anywhere
    const out = strip(renderReport({ entries, isPro: true }));
    expect(out).toMatch(/Provider-native caching on system prompt/);
    expect(out).toMatch(/50% reduction/);   // gpt-4o-mini: $0.15 → $0.075
    expect(out).not.toMatch(/90% reduction/);
  });

  it('reports native caching from real discounts, never from eligibility', () => {
    const entries = [
      entry({ nativeCacheEligible: true, nativeCachedTokens: 0 }),
      entry({ nativeCacheEligible: true, nativeCachedTokens: 0 }),
    ];
    expect(strip(renderReport({ entries, isPro: true }))).toMatch(/Native Caching\s+0\.0%/);
  });

  // The >50%-of-live-requests suppression passed the "1 hit + 3 local hits"
  // case by luck. These are the cases it still got wrong.
  it('a cold miss followed by a cached hit is not an untapped opportunity', () => {
    // Exactly 50% cached: the old `> 0.5` suppression failed open here. Then
    // the evidence-based version still counted the cold request as recoverable
    // — but a cold miss on a model that demonstrably caches is the cache being
    // POPULATED, a necessary cost of caching working, not money left on the
    // table. Recommending "enable caching" while the next request proves it is
    // already enabled is exactly the advice a user would distrust.
    const entries = [
      entry({}),
      entry({ nativeCachedTokens: 4736, nativeCache: true, realInputTokens: 166, realCost: 0.0004 }),
    ];
    const out = strip(renderReport({ entries, isPro: true }));
    expect(out).not.toMatch(/Provider-native caching on system prompt/);
    expect(out).not.toMatch(/Recoverable here/);
  });

  it('still recommends caching for a model that never once received a discount', () => {
    // The other side of the same rule: no discount anywhere for this model
    // means the opportunity is real and must still be reported.
    const entries = [entry({}), entry({}), entry({})];
    const out = strip(renderReport({ entries, isPro: true }));
    expect(out).toMatch(/Provider-native caching on system prompt/);
    expect(out).toMatch(/Recoverable here/);
  });

  it('never projects a session forward to a month', () => {
    // Was `saving * 30`, which assumed the session was exactly one day of
    // traffic. It might be ten minutes. Report the observed window instead.
    const entries = [entry({}), entry({})];
    const out = strip(renderReport({ entries, isPro: true }));
    expect(out).not.toMatch(/monthly/i);
    expect(out).toMatch(/Recoverable here/);
    expect(out).toMatch(/across 2 requests/);
    expect(out).toMatch(/not projected/);
  });

  it('does not recommend caching tool schemas when every request is already cached', () => {
    // Tool- and RAG-line suppression did not exist at all.
    const toolHeavy = (over: Partial<SessionLogEntry> = {}) => entry({
      attribution: {
        systemPrompt: { tokens: 100, estimatedCost: 0.00002, percentOfTotal: 3 },
        toolSchemas: { tokens: 4600, estimatedCost: 0.0007, percentOfTotal: 92 },
        ragChunks: { tokens: 0, estimatedCost: 0, percentOfTotal: 0 },
        conversationHistory: { tokens: 0, estimatedCost: 0, percentOfTotal: 0 },
        userQuery: { tokens: 100, estimatedCost: 0.00002, percentOfTotal: 3 },
        outputTokens: { tokens: 30, estimatedCost: 0.00002, percentOfTotal: 2 },
        totalInputTokens: 4800, totalOutputTokens: 30, totalCost: 0.00074,
      },
      nativeCachedTokens: 4736, nativeCache: true, realInputTokens: 166, realCost: 0.0004,
      ...over,
    } as Partial<SessionLogEntry>);
    const out = strip(renderReport({ entries: [toolHeavy(), toolHeavy(), toolHeavy()], isPro: true }));
    expect(out).not.toMatch(/Cache tool schema prefix/);
  });

  it('shows no savings figure at all when nothing is recommended', () => {
    // The old total was potentialSaving * 0.90 regardless of which lines were
    // shown, so it printed a number with nothing behind it.
    const allCached = entry({ nativeCachedTokens: 4736, nativeCache: true, realInputTokens: 166, realCost: 0.0004 });
    const out = strip(renderReport({ entries: [allCached, allCached, allCached], isPro: true }));
    expect(out).not.toMatch(/Provider-native caching on system prompt/);
    expect(out).not.toMatch(/Recoverable here/);
    expect(out).not.toMatch(/monthly/i);
  });

  it('claims no caching saving for a provider that has no prompt cache', () => {
    // Groq has no cached-input rate, so caching it saves nothing — quoting
    // Anthropic's 90% against Groq spend was pure fiction.
    const groq = entry({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    const out = strip(renderReport({ entries: [groq, groq, groq], isPro: true }));
    expect(out).not.toMatch(/Provider-native caching on system prompt/);
  });
});

describe('class-based API (LLMCostTrimmer)', () => {
  // A separate public entry point from the trimwares.* wrappers, and it had
  // the identical bug. Covered here so it cannot regress independently.
  it('captures and prices OpenAI cached tokens, and logs the real signal', async () => {
    const dir = tempLogDir();
    const { LLMCostTrimmer } = await import('../../src/index.js');
    const { OpenAIProvider } = await import('../../src/providers/OpenAIProvider.js');
    // The REAL provider against a mocked SDK response — a stub handing over
    // already-normalized numbers would skip OpenAIProvider.send(), which is
    // exactly where the extraction bug lived.
    const provider = new OpenAIProvider(fakeOpenAI(usageBlock(4902, 4736)));
    const trimmer = new LLMCostTrimmer(provider) as any;
    await trimmer.chat({ messages: [{ role: 'user', content: 'hello' }], model: 'gpt-4o-mini' });
    await wait();
    const [e] = readEntries(dir);
    expect(e.nativeCachedTokens).toBe(4736);
    expect(e.nativeCache).toBe(true);
    expect(e.realInputTokens).toBe(166);               // prompt minus cached
    expect(e.attribution.totalInputTokens).toBe(4902); // whole prompt, not 166
    // Exact recorded cost: 166 uncached @ $0.15/M + 4736 cached @ $0.075/M
    // + 30 output @ $0.60/M. A regression in the extraction changes this.
    const expected = (166 / 1_000_000) * 0.15 + (4736 / 1_000_000) * 0.075 + (30 / 1_000_000) * 0.60;
    expect(e.realCost).toBeCloseTo(expected, 10);
    expect(e.realSavings).toBeCloseTo((4736 / 1_000_000) * 0.075, 10);
  });
});

describe('Anthropic streaming', () => {
  function fakeAnthropicStream(usage: Record<string, number>) {
    return {
      messages: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { model: 'claude-haiku-4-5', usage } };
            yield { type: 'content_block_delta', delta: { text: 'ok' } };
            yield { type: 'message_delta', usage: { output_tokens: 30 } };
          },
        }),
      },
    };
  }

  it('a cache WRITE alone is not reported as a cache discount', async () => {
    // Anthropic charges a premium to create a cache entry. Reporting that as
    // "cached" told users they were saving money on the request that cost the
    // most. Only cache_read_input_tokens is a discount.
    const dir = tempLogDir();
    const client = trimwares.anthropic(fakeAnthropicStream({
      input_tokens: 200, cache_creation_input_tokens: 4700, cache_read_input_tokens: 0,
    }) as never) as any;
    const stream = await client.messages.create({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'q' }], stream: true });
    for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
    await wait();
    const [e] = readEntries(dir);
    expect(e.nativeCachedTokens).toBe(0);
    expect(e.nativeCache).toBe(false);
    expect(e.realSavings).toBe(0);
  });

  it('a cache READ is reported as a discount, and attributes the whole prompt', async () => {
    const dir = tempLogDir();
    const client = trimwares.anthropic(fakeAnthropicStream({
      input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 4700,
    }) as never) as any;
    const stream = await client.messages.create({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'q' }], stream: true });
    for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
    await wait();
    const [e] = readEntries(dir);
    expect(e.nativeCachedTokens).toBe(4700);
    expect(e.nativeCache).toBe(true);
    expect(e.realSavings).toBeGreaterThan(0);
    expect(e.attribution.totalInputTokens).toBe(4900); // 200 + 4700 cache reads
  });
});
