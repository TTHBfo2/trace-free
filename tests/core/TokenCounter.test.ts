import { TokenCounter } from '../../src/core/TokenCounter.js';

describe('TokenCounter', () => {
  const counter = new TokenCounter('openai');

  it('returns 0 for empty text', () => {
    expect(counter.countText('')).toBe(0);
  });

  it('approximates token count for short text', () => {
    const count = counter.countText('Hello world'); // 11 chars → ceil(11/4) = 3
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(20);
  });

  it('counts messages with overhead', () => {
    const messages = [
      { role: 'system' as const, content: 'You are a helpful assistant.' },
      { role: 'user'   as const, content: 'What is 2+2?' },
    ];
    const count = counter.countMessages(messages);
    expect(count).toBeGreaterThan(10);
  });

  it('estimates cost correctly', () => {
    const cost = counter.estimateCost(1_000_000, 500_000, 2.50, 10.00);
    expect(cost).toBeCloseTo(2.50 + 5.00);
  });
});
