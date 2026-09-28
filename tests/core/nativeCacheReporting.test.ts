import { CostEngine } from '../../src/core/CostEngine.js';

/**
 * Provider-native prompt caching: capture, pricing, and honest reporting.
 *
 * Every fixture below is a REAL provider response shape, captured 2026-09-28
 * against gpt-4o-mini with a ~4,900-token system prompt. Before this suite,
 * OpenAI's cached tokens were hardcoded to 0: cached tokens were billed at the
 * full input rate, `realSavings` was always 0, and the CLI reported "100% of
 * requests had provider cache applied" from a pre-call eligibility guess.
 *
 * The two providers scope these fields DIFFERENTLY, which is the trap:
 *   OpenAI    prompt_tokens INCLUDES cached_tokens (cached is a subset)
 *   Anthropic input_tokens  EXCLUDES cache_read_input_tokens (disjoint)
 * CostEngine.computeCost() adds inputTokens + cachedTokens, so callers must
 * hand it the NON-cached portion. Getting this wrong double-bills the cache.
 */

const REQ = { messages: [{ role: 'user' as const, content: 'Hello world' }] };

// Real captured response, call 2 of 4. prompt_tokens 4902 total, 4736 of them cached.
const OPENAI_CACHED = { promptTokens: 4902, cachedTokens: 4736, completionTokens: 30 };

describe('OpenAI cached-input pricing', () => {
  const engine = new CostEngine();

  it('prices cached tokens at the cached rate, not the full input rate', () => {
    const uncached = OPENAI_CACHED.promptTokens - OPENAI_CACHED.cachedTokens; // 166
    const entry = engine.record({
      requestId: 'oai-cached', provider: 'openai', model: 'gpt-4o-mini',
      inputTokens: uncached, outputTokens: OPENAI_CACHED.completionTokens,
      cached: false, cacheType: 'none', latencyMs: 300, request: REQ,
      nativeCachedTokens: OPENAI_CACHED.cachedTokens,
    });

    // gpt-4o-mini: input $0.15/M, cached input $0.075/M, output $0.60/M
    const expected =
      (166 / 1_000_000) * 0.15 + (4736 / 1_000_000) * 0.075 + (30 / 1_000_000) * 0.60;
    expect(entry.cost).toBeCloseTo(expected, 10);
  });

  it('is materially cheaper than pricing the same prompt with no cache credit', () => {
    // The regression this suite exists for: the old code passed the full
    // prompt as inputTokens with nativeCachedTokens 0.
    const buggy = engine.computeCost(4902, 30, engine.getPricing('gpt-4o-mini'), 0);
    const fixed = engine.computeCost(166, 30, engine.getPricing('gpt-4o-mini'), 4736);
    expect(fixed).toBeLessThan(buggy);
    expect(buggy / fixed).toBeGreaterThan(1.5); // measured ~1.9x over-report
  });

  it('records the discount as realized savings instead of zero', () => {
    const entry = engine.record({
      requestId: 'oai-savings', provider: 'openai', model: 'gpt-4o-mini',
      inputTokens: 166, outputTokens: 30, cached: false, cacheType: 'none',
      latencyMs: 300, request: REQ, nativeCachedTokens: 4736,
    });
    // 4736 tokens × ($0.15 - $0.075)/M
    expect(entry.savings).toBeCloseTo((4736 / 1_000_000) * 0.075, 10);
    expect(entry.savings).toBeGreaterThan(0);
  });

  it('never double-bills: cached tokens are not also charged as input', () => {
    const pricing = engine.getPricing('gpt-4o-mini');
    const correct = engine.computeCost(166, 30, pricing, 4736);
    const doubled = engine.computeCost(4902, 30, pricing, 4736); // the mistake
    expect(correct).toBeLessThan(doubled);
  });

  it('applies the 4.1 family rate, which is a different discount from 4o', () => {
    // 75% off on 4.1 vs 50% off on 4o — a blanket rate would be wrong.
    expect(engine.getPricing('gpt-4.1').cachedInputPerMillion).toBe(0.50);
    expect(engine.getPricing('gpt-4.1-mini').cachedInputPerMillion).toBe(0.10);
    expect(engine.getPricing('gpt-4o').cachedInputPerMillion).toBe(1.25);
    expect(engine.getPricing('gpt-4o-mini').cachedInputPerMillion).toBe(0.075);
  });

  it('falls back to the full input rate on models with no cached pricing', () => {
    const p = engine.getPricing('gpt-3.5-turbo');
    expect(p.cachedInputPerMillion).toBeUndefined();
    // No cached rate: cached tokens cost the same as input, so no phantom saving.
    const entry = engine.record({
      requestId: 'oai-nocache-rate', provider: 'openai', model: 'gpt-3.5-turbo',
      inputTokens: 100, outputTokens: 10, cached: false, cacheType: 'none',
      latencyMs: 100, request: REQ, nativeCachedTokens: 500,
    });
    expect(entry.savings).toBe(0);
  });
});

describe('Groq shares the OpenAI response branch but has no prompt cache', () => {
  const engine = new CostEngine();

  it('reports no cached tokens and therefore no native-cache savings', () => {
    const entry = engine.record({
      requestId: 'groq-1', provider: 'groq', model: 'llama-3.3-70b-versatile',
      inputTokens: 4902, outputTokens: 30, cached: false, cacheType: 'none',
      latencyMs: 300, request: REQ, nativeCachedTokens: 0,
    });
    expect(entry.savings).toBe(0);
    // Whole prompt at full input rate — correct, because nothing was cached.
    expect(entry.cost).toBeCloseTo((4902 / 1_000_000) * 0.59 + (30 / 1_000_000) * 0.79, 10);
  });
});

describe('Anthropic keeps working — its fields are scoped differently', () => {
  const engine = new CostEngine();

  it('treats cache_read tokens as disjoint from input_tokens', () => {
    // Real shape: input_tokens excludes the 4652 cache reads.
    const entry = engine.record({
      requestId: 'ant-1', provider: 'anthropic', model: 'claude-haiku-4-5',
      inputTokens: 249, outputTokens: 40, cached: false, cacheType: 'none',
      latencyMs: 300, request: REQ, nativeCachedTokens: 4652,
    });
    const expected =
      (249 / 1_000_000) * 1.00 + (4652 / 1_000_000) * 0.10 + (40 / 1_000_000) * 5.00;
    expect(entry.cost).toBeCloseTo(expected, 10);
    expect(entry.savings).toBeCloseTo((4652 / 1_000_000) * 0.90, 10);
  });
});

describe('reporting honesty', () => {
  const engine = new CostEngine();

  it('a response-cache hit costs nothing and claims no native-cache saving', () => {
    const entry = engine.record({
      requestId: 'hit-1', provider: 'openai', model: 'gpt-4o-mini',
      inputTokens: 166, outputTokens: 30, cached: true, cacheType: 'response',
      latencyMs: 2, request: REQ, nativeCachedTokens: 4736,
    });
    expect(entry.cost).toBe(0);
    // Nothing was sent, so no provider discount was earned on this request.
    expect(entry.savings).toBe(0);
  });

  it('zero cached tokens yields zero savings — the honest zero case', () => {
    const entry = engine.record({
      requestId: 'cold-1', provider: 'openai', model: 'gpt-4o-mini',
      inputTokens: 4901, outputTokens: 30, cached: false, cacheType: 'none',
      latencyMs: 900, request: REQ, nativeCachedTokens: 0,
    });
    expect(entry.savings).toBe(0);
  });
});
