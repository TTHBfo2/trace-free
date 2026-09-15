import { ResponseCache } from '../../src/cache/ResponseCache.js';
import { LLMRequest, LLMResponse } from '../../src/types/index.js';

function makeRequest(content: string): LLMRequest {
  return { messages: [{ role: 'user', content }] };
}

function makeResponse(content: string): LLMResponse {
  return {
    content,
    model: 'gpt-4o-mini',
    provider: 'openai',
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
    cost: 0.001,
    savings: 0,
    cached: false,
    cacheType: 'none',
    requestId: 'test',
    latencyMs: 100,
  };
}

describe('ResponseCache', () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache({ ttlMs: 5000, maxEntries: 10 });
  });

  afterEach(() => {
    cache.destroy();
  });

  it('returns null for a miss', () => {
    expect(cache.get(makeRequest('hello'))).toBeNull();
  });

  it('stores and retrieves a response', () => {
    const req = makeRequest('What is 2+2?');
    const res = makeResponse('4');
    cache.set(req, res);
    const hit = cache.get(req);
    expect(hit).not.toBeNull();
    expect(hit?.content).toBe('4');
  });

  it('treats different messages as different keys', () => {
    cache.set(makeRequest('hello'), makeResponse('hi'));
    expect(cache.get(makeRequest('world'))).toBeNull();
  });

  it('respects TTL expiry', async () => {
    cache = new ResponseCache({ ttlMs: 10, maxEntries: 10 });
    cache.set(makeRequest('expire me'), makeResponse('soon'));
    await new Promise(r => setTimeout(r, 20));
    expect(cache.get(makeRequest('expire me'))).toBeNull();
    cache.destroy();
  });

  it('tracks hit rate in stats', () => {
    const req = makeRequest('stats test');
    cache.set(req, makeResponse('ok'));
    cache.get(makeRequest('miss'));  // miss
    cache.get(req);                 // hit

    const stats = cache.stats();
    expect(stats.hitCount).toBe(1);
    expect(stats.missCount).toBe(1);
    expect(stats.hitRate).toBe(50);
  });
});
