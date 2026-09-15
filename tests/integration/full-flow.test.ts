/**
 * Full flow integration tests — proves the complete chat() pipeline works.
 * No API calls. Uses MockProvider.
 */

import { LLMCostTrimmer } from '../../src/index.js';
import { MockProvider } from '../helpers/MockProvider.js';

const SYSTEM = 'You are a helpful assistant.';
const USER   = 'What is 2 + 2?';

function makeTrimmer(options?: ConstructorParameters<typeof MockProvider>[0]) {
  const provider = new MockProvider(options);
  const trimmer  = new LLMCostTrimmer(provider);
  return { trimmer, provider };
}

afterEach(() => {
  // Destroy any trimmer created in tests to stop background timers
});

describe('Full chat() flow', () => {

  it('returns a response with all required fields', async () => {
    const { trimmer } = makeTrimmer();
    const res = await trimmer.chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: USER },
      ],
    });

    expect(res.content).toBe('Mock response.');
    expect(res.provider).toBe('openai');
    expect(res.requestId).toHaveLength(12);
    expect(res.cached).toBe(false);
    expect(res.cacheType).toBe('none');
    expect(res.cost).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.usage.inputTokens).toBe(100);
    expect(res.usage.outputTokens).toBe(20);
  });

  it('hits response cache on second identical request — zero cost, zero provider calls', async () => {
    const { trimmer, provider } = makeTrimmer();
    const req = { messages: [{ role: 'user' as const, content: USER }] };

    const first  = await trimmer.chat(req);
    const second = await trimmer.chat(req);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.cacheType).toBe('response');
    expect(second.cost).toBe(0);
    expect(second.savings).toBeGreaterThan(0);
    expect(provider.callCount).toBe(1); // provider only called once
  });

  it('misses cache on different request', async () => {
    const { trimmer, provider } = makeTrimmer();

    await trimmer.chat({ messages: [{ role: 'user', content: 'Hello' }] });
    const res = await trimmer.chat({ messages: [{ role: 'user', content: 'Goodbye' }] });

    expect(res.cached).toBe(false);
    expect(provider.callCount).toBe(2);
  });

  it('cost report reflects both calls correctly', async () => {
    const { trimmer } = makeTrimmer();
    const req = { messages: [{ role: 'user' as const, content: USER }] };

    await trimmer.chat(req);
    await trimmer.chat(req); // cache hit

    const report = trimmer.getCostReport();
    expect(report.totalRequests).toBe(2);
    expect(report.cachedRequests).toBe(1);
    expect(report.cacheHitRate).toBe(50);
    expect(report.totalCost).toBeGreaterThan(0);
  });

  it('resetStats clears everything', async () => {
    const { trimmer } = makeTrimmer();
    await trimmer.chat({ messages: [{ role: 'user', content: USER }] });
    trimmer.resetStats();

    const report = trimmer.getCostReport();
    expect(report.totalRequests).toBe(0);
    expect(report.totalCost).toBe(0);
  });

  it('handles requests with tools', async () => {
    const { trimmer } = makeTrimmer();
    const res = await trimmer.chat({
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [
        { name: 'get_weather', description: 'Get weather data', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
      ],
    });
    expect(res.content).toBeTruthy();
    expect(res.cost).toBeGreaterThan(0);
  });
});
