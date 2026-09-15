import { CostEngine } from '../../src/core/CostEngine.js';

const MOCK_REQUEST = {
  messages: [{ role: 'user' as const, content: 'Hello world' }],
};

describe('CostEngine', () => {
  let engine: CostEngine;

  beforeEach(() => {
    engine = new CostEngine();
  });

  it('records a live request with correct cost', () => {
    const entry = engine.record({
      requestId: 'test-1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 50,
      cached: false,
      cacheType: 'none',
      latencyMs: 200,
      request: MOCK_REQUEST,
    });

    expect(entry.cost).toBeGreaterThan(0);
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(50);
    expect(entry.cached).toBe(false);
  });

  it('records a cached request with zero cost', () => {
    const entry = engine.record({
      requestId: 'test-2',
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 50,
      cached: true,
      cacheType: 'response',
      latencyMs: 1,
      request: MOCK_REQUEST,
      savings: 0.0001,
    });

    expect(entry.cost).toBe(0);
    expect(entry.cached).toBe(true);
  });

  it('getCostReport reflects recorded entries', () => {
    engine.record({ requestId: 'r1', provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 200, cached: false, cacheType: 'none', latencyMs: 300, request: MOCK_REQUEST });
    engine.record({ requestId: 'r2', provider: 'openai', model: 'gpt-4o', inputTokens: 500,  outputTokens: 100, cached: true,  cacheType: 'response', latencyMs: 1, request: MOCK_REQUEST, savings: 0.005 });

    const report = engine.getCostReport();

    expect(report.totalRequests).toBe(2);
    expect(report.cachedRequests).toBe(1);
    expect(report.cacheHitRate).toBe(50);
    expect(report.totalCost).toBeGreaterThan(0);
    expect(report.byProvider['openai']).toBeDefined();
  });

  it('getPricing fuzzy-matches model names', () => {
    const pricing = engine.getPricing('openai/gpt-4o-mini');
    expect(pricing.inputPerMillion).toBeLessThan(1); // budget model
  });

  it('reset clears all entries', () => {
    engine.record({ requestId: 'r1', provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 50, cached: false, cacheType: 'none', latencyMs: 100, request: MOCK_REQUEST });
    engine.reset();
    expect(engine.getCostReport().totalRequests).toBe(0);
  });
});
