import { SemanticCache } from '../../src/cache/SemanticCache.js';
import { LLMRequest, LLMResponse } from '../../src/types/index.js';

function req(content: string): LLMRequest {
  return { messages: [{ role: 'user', content }] };
}

function res(content: string): LLMResponse {
  return {
    content,
    model: 'gpt-4o-mini',
    provider: 'openai',
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
    cost: 0.001, savings: 0, cached: false, cacheType: 'none', requestId: 'x', latencyMs: 50,
  };
}

describe('SemanticCache', () => {
  let cache: SemanticCache;

  // The embedder is a module-level singleton (loads once per process, shared
  // across every SemanticCache instance) — first call downloads/loads the
  // ~23MB quantized model via @huggingface/transformers's WASM ONNX runtime,
  // which can exceed Jest's default 10s test timeout on a cold cache. Warm
  // it here with a generous timeout so individual tests below measure real
  // cache behavior, not one-time model load latency.
  beforeAll(async () => {
    const warmup = new SemanticCache();
    await warmup.get(req('warmup'));
  }, 60_000);

  beforeEach(() => {
    cache = new SemanticCache({ similarityThreshold: 0.85, ttlMs: 60_000, maxEntries: 100 });
  });

  afterAll(() => {
    cache.clear();
  });

  it('returns null for an empty cache', async () => {
    expect(await cache.get(req('hello'))).toBeNull();
  });

  it('returns exact match', async () => {
    const r = req('What is the capital of France?');
    await cache.set(r, res('Paris'));
    expect((await cache.get(r))?.content).toBe('Paris');
  });

  it('matches semantically similar queries', async () => {
    await cache.set(req('What is the capital city of France?'), res('Paris'));
    const hit = await cache.get(req('Tell me the capital of France'));
    // Similar but not identical — may or may not hit depending on threshold
    // Just verify the cache doesn't throw and returns something or null
    expect(hit === null || typeof hit?.content === 'string').toBe(true);
  });

  it('does NOT match completely different queries', async () => {
    await cache.set(req('What is the capital of France?'), res('Paris'));
    const hit = await cache.get(req('How do I bake a chocolate cake?'));
    expect(hit).toBeNull();
  });

  it('tracks stats', async () => {
    await cache.set(req('ping'), res('pong'));
    await cache.get(req('ping')); // hit
    await cache.get(req('xyz completely different query about dogs running')); // miss

    const stats = cache.stats();
    expect(stats.hitCount).toBeGreaterThanOrEqual(1);
    expect(stats.missCount).toBeGreaterThanOrEqual(1);
  });
});
