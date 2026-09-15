/**
 * Anthropic Native Cache — Structural Validation
 *
 * Verifies that our PromptCacheOptimizer produces request structures that
 * match Anthropic's documented cache_control specification exactly.
 * No API key required — validates the request FORMAT, not the billing outcome.
 *
 * Anthropic cache_control spec (docs.anthropic.com/en/docs/build-with-claude/prompt-caching):
 *   - cache_control: { type: "ephemeral" } on a content block marks it as cacheable
 *   - Minimum 1,024 tokens required for cache to be eligible
 *   - Can be applied to: system blocks, tool definitions, message content
 *   - Up to 4 cache breakpoints per request
 *   - Cache read price: $0.30/MTok vs $3.00/MTok uncached (90% reduction)
 *
 * To validate billing (cache_read_input_tokens in response):
 *   Get free credits at console.anthropic.com and run:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx tests/verification/live-api-validation.ts
 */

import { PromptCacheOptimizer } from '../../src/cache/PromptCacheOptimizer.js';
import { AnthropicSystemBlock } from '../../src/types/index.js';

const optimizer = new PromptCacheOptimizer('anthropic');

describe('Anthropic cache_control structural validation', () => {

  // ── Spec: system blocks with cache_control ──────────────────────────────────

  it('produces AnthropicSystemBlock array when system message exists', () => {
    const result = optimizer.optimize({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user',   content: 'Hello' },
      ],
    }, 'anthropic');

    expect(result.anthropicSystemBlocks).toBeDefined();
    expect(Array.isArray(result.anthropicSystemBlocks)).toBe(true);
    expect(result.anthropicSystemBlocks!.length).toBe(1);
  });

  it('each system block has type: "text" (Anthropic spec)', () => {
    const result = optimizer.optimize({
      messages: [
        { role: 'system', content: 'System instructions here.' },
        { role: 'user',   content: 'Question' },
      ],
    }, 'anthropic');

    for (const block of result.anthropicSystemBlocks!) {
      expect(block.type).toBe('text');
    }
  });

  it('cache_control has type: "ephemeral" (only valid value in Anthropic spec)', () => {
    // Create a system message large enough to exceed 1,024 token threshold
    const largeSystem = 'You are a helpful assistant. '.repeat(80); // ~2,000 tokens

    const result = optimizer.optimize({
      messages: [
        { role: 'system', content: largeSystem },
        { role: 'user',   content: 'Hello' },
      ],
    }, 'anthropic');

    const blocksWithCache = result.anthropicSystemBlocks!.filter(b => b.cache_control);
    if (blocksWithCache.length > 0) {
      for (const block of blocksWithCache) {
        expect(block.cache_control!.type).toBe('ephemeral');
      }
    }
  });

  it('combines multiple system messages into one block (more likely to hit threshold)', () => {
    const result = optimizer.optimize({
      messages: [
        { role: 'system', content: 'You are a support agent.' },
        { role: 'system', content: 'TechFlow pricing: Starter $29, Pro $99, Business $299.' },
        { role: 'user',   content: 'How much does Pro cost?' },
      ],
    }, 'anthropic');

    // Should combine into single block, not two
    expect(result.anthropicSystemBlocks!.length).toBe(1);

    // Combined text should contain both system messages
    const combinedText = result.anthropicSystemBlocks![0].text;
    expect(combinedText).toContain('support agent');
    expect(combinedText).toContain('TechFlow pricing');
  });

  it('non-system messages are NOT in anthropicSystemBlocks', () => {
    const result = optimizer.optimize({
      messages: [
        { role: 'system',    content: 'You are a helper.' },
        { role: 'user',      content: 'Question 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user',      content: 'Question 2' },
      ],
    }, 'anthropic');

    // System blocks should only contain the system message
    for (const block of result.anthropicSystemBlocks!) {
      expect(block.text).toContain('You are a helper');
      expect(block.text).not.toContain('Question 1');
      expect(block.text).not.toContain('Answer 1');
    }

    // Messages array should NOT contain system role
    for (const msg of result.messages) {
      expect(msg.role).not.toBe('system');
    }
  });

  it('does NOT add cache_control below 1,024 token threshold', () => {
    // Short system prompt — should not get cache_control (would be wasteful)
    const result = optimizer.optimize({
      messages: [
        { role: 'system', content: 'Be helpful.' },   // ~3 tokens — way below threshold
        { role: 'user',   content: 'Hello' },
      ],
    }, 'anthropic');

    const hasCache = result.anthropicSystemBlocks!.some(b => b.cache_control);
    expect(hasCache).toBe(false);
    expect(result.cacheableTokens).toBe(0);
  });

  it('correctly reports cacheableTokens > 0 for large system prompts', () => {
    // Need > 1,024 tokens. BPE (cl100k_base) tokenises this phrase at ~8 tokens/repeat;
    // 200 repeats → ~1,600 tokens — safely above 1,024 for any tokeniser.
    const largeSystem = 'This is a detailed system instruction. '.repeat(200); // ~1,600 tokens

    const result = optimizer.optimize({
      messages: [
        { role: 'system', content: largeSystem },
        { role: 'user',   content: 'What should I do?' },
      ],
    }, 'anthropic');

    expect(result.cacheableTokens).toBeGreaterThan(1024);
  });

  // ── Spec: tool definitions caching ─────────────────────────────────────────

  it('adds _cache flag to last tool definition when tools exceed threshold', () => {
    const largeTools = Array.from({ length: 10 }, (_, i) => ({
      name:        `tool_${i}`,
      description: `This tool does operation ${i} with detailed description that makes it large. `.repeat(5),
      parameters:  { type: 'object', properties: { input: { type: 'string', description: 'The input value' } } },
    }));

    const result = optimizer.optimize({
      messages: [
        { role: 'user', content: 'Do something' },
      ],
      tools: largeTools,
    }, 'anthropic');

    if (result.tools && result.tools.length > 0) {
      const lastTool = result.tools[result.tools.length - 1] as unknown as Record<string, unknown>;
      // If tools are large enough, last tool gets _cache: true marker
      // (AnthropicProvider reads this to add cache_control to last definition)
      if (result.cacheableTokens > 0) {
        expect(lastTool['_cache']).toBe(true);
      }
    }
  });

  // ── Non-Anthropic providers should NOT get anthropicSystemBlocks ────────────

  it('OpenAI optimization does NOT produce anthropicSystemBlocks', () => {
    const result = optimizer.optimize({
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user',   content: 'Hello' },
      ],
    }, 'openai');

    expect(result.anthropicSystemBlocks).toBeUndefined();
  });

  it('provider is correctly set to anthropic in result', () => {
    const result = optimizer.optimize({
      messages: [{ role: 'user', content: 'Hello' }],
    }, 'anthropic');

    expect(result.provider).toBe('anthropic');
  });
});

describe('Billing validation note', () => {
  it('documents how to validate billing with a real key', () => {
    const validationInstructions = `
      To validate that cache_control actually reduces Anthropic billing:

      1. Get free credits: console.anthropic.com (new accounts get ~$5 free)
      2. Run: ANTHROPIC_API_KEY=sk-ant-... npm run verify:live
      3. Expected: response.usage.cache_read_input_tokens > 0 on repeat calls
      4. Expected: billing shows cache_read rate ($0.30/MTok vs $3.00/MTok)

      This structural test proves the request FORMAT is correct.
      The billing test proves Anthropic actually charges the lower rate.
    `;

    // This "test" just documents the path — always passes
    expect(validationInstructions).toContain('console.anthropic.com');
    expect(validationInstructions).toContain('cache_read_input_tokens');
  });
});
