import { PromptCompressor } from '../../src/optimization/PromptCompressor.js';

describe('PromptCompressor', () => {
  const compressor = new PromptCompressor();

  it('returns the same message count', () => {
    const messages = [
      { role: 'system' as const, content: 'You are a helper.' },
      { role: 'user'   as const, content: 'Tell me about AI.' },
    ];
    const result = compressor.compress(messages);
    expect(result.messages).toHaveLength(2);
  });

  it('reduces token count for verbose text', () => {
    const messages = [{
      role: 'user' as const,
      content: 'Certainly! As an AI language model, I want to say that    this has    lots of   extra spaces.\n\n\n\nAnd many blank lines.\n\n\n\nPlease note that this is test content.',
    }];
    const result = compressor.compress(messages);
    expect(result.compressedTokenEstimate).toBeLessThan(result.originalTokenEstimate);
    expect(result.reductionPercent).toBeGreaterThan(0);
  });

  it('strips HTML comments', () => {
    const messages = [{ role: 'user' as const, content: 'Hello <!-- this is a comment --> world' }];
    const result = compressor.compress(messages);
    expect(result.messages[0].content).not.toContain('<!--');
  });

  it('handles empty content gracefully', () => {
    const messages = [{ role: 'user' as const, content: '' }];
    const result = compressor.compress(messages);
    expect(result.messages[0].content).toBe('');
    expect(result.reductionPercent).toBe(0);
  });
});
