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
});
