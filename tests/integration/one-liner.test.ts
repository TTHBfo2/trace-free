/**
 * One-liner API tests — proves trimwares.openai(), trimwares.anthropic(), etc.
 * work correctly with zero API changes to existing code.
 *
 * Uses minimal fake clients — no real SDK needed, just objects with the right shape.
 */

import { trimwares } from '../../src/trimwares.js';

// ─── Fake clients — mimic the shape each SDK exposes ─────────────────────────

function makeOpenAIClient(responses: string[] = ['Test response']) {
  let callCount = 0;
  const capturedParams: unknown[] = [];
  return {
    chat: {
      completions: {
        create: async (params: unknown) => {
          capturedParams.push(params);
          const content = responses[callCount % responses.length];
          callCount++;
          return {
            choices:  [{ message: { content }, finish_reason: 'stop' }],
            model:    (params as Record<string, unknown>)['model'] ?? 'gpt-4o-mini',
            usage:    { prompt_tokens: 42, completion_tokens: 10 },
          };
        },
      },
    },
    _callCount:      () => callCount,
    _capturedParams: () => capturedParams,
  };
}

function makeAnthropicClient(response = 'Anthropic response') {
  let callCount = 0;
  const capturedParams: unknown[] = [];
  return {
    messages: {
      create: async (params: unknown) => {
        capturedParams.push(params);
        callCount++;
        return {
          content: [{ type: 'text', text: response }],
          model:   'claude-haiku-4-5',
          usage:   { input_tokens: 55, output_tokens: 12 },
        };
      },
    },
    _callCount:      () => callCount,
    _capturedParams: () => capturedParams,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const MESSAGES = [
  { role: 'system'  as const, content: 'You are a helpful assistant.' },
  { role: 'user'    as const, content: 'What is the capital of France?' },
];

describe('trimwares.openai()', () => {
  it('wraps the client and preserves the original API shape', () => {
    const client  = makeOpenAIClient();
    const wrapped = trimwares.openai(client);

    expect(typeof wrapped.chat.completions.create).toBe('function');
    expect(typeof wrapped.trimwares.getCostReport).toBe('function');
    expect(typeof wrapped.trimwares.printReport).toBe('function');
    expect(typeof wrapped.trimwares.resetStats).toBe('function');
  });

  it('passes the request through to the original client', async () => {
    const client  = makeOpenAIClient(['Paris.']);
    const wrapped = trimwares.openai(client);

    const result = await wrapped.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES }) as { choices: Array<{ message: { content: string } }> };

    expect(result.choices[0].message.content).toBe('Paris.');
    expect(client._callCount()).toBe(1);
  });

  it('serves second identical request from cache — zero client calls', async () => {
    const client  = makeOpenAIClient(['Paris.']);
    const wrapped = trimwares.openai(client);

    await wrapped.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    const second = await wrapped.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });

    expect(client._callCount()).toBe(1); // only one real call
    expect((second as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe('Paris.');
  });

  it('getCostReport shows real call tracked', async () => {
    const client  = makeOpenAIClient();
    const wrapped = trimwares.openai(client);

    await wrapped.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    const report = wrapped.trimwares.getCostReport();

    expect(report.totalRequests).toBe(1);
    expect(report.totalCost).toBeGreaterThan(0);
  });

  it('getCostReport tracks both live and cached requests', async () => {
    const client  = makeOpenAIClient();
    const wrapped = trimwares.openai(client);
    const params  = { model: 'gpt-4o-mini', messages: MESSAGES };

    await wrapped.chat.completions.create(params);
    await wrapped.chat.completions.create(params); // cache hit

    const report = wrapped.trimwares.getCostReport();
    expect(report.totalRequests).toBe(2);
    expect(report.cachedRequests).toBe(1);
    expect(report.cacheHitRate).toBe(50);
  });

  it('resetStats clears all state', async () => {
    const client  = makeOpenAIClient();
    const wrapped = trimwares.openai(client);

    await wrapped.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    wrapped.trimwares.resetStats();

    const report = wrapped.trimwares.getCostReport();
    expect(report.totalRequests).toBe(0);
  });

  it('different messages produce different cache keys — no false hits', async () => {
    const client  = makeOpenAIClient(['Answer A', 'Answer B']);
    const wrapped = trimwares.openai(client);

    await wrapped.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Question A?' }] });
    await wrapped.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Question B?' }] });

    expect(client._callCount()).toBe(2); // two distinct calls
  });
});

describe('trimwares.anthropic()', () => {
  it('wraps client.messages.create transparently', async () => {
    const client  = makeAnthropicClient('Paris.');
    const wrapped = trimwares.anthropic(client);

    expect(typeof wrapped.messages.create).toBe('function');
    expect(typeof wrapped.trimwares.getCostReport).toBe('function');

    const result = await wrapped.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 100,
      messages:   [{ role: 'user', content: 'Capital of France?' }],
    }) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toBe('Paris.');
  });

  it('caches Anthropic responses on repeat calls', async () => {
    const client  = makeAnthropicClient('Paris.');
    const wrapped = trimwares.anthropic(client);
    const params  = { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user' as const, content: 'Capital of France?' }] };

    await wrapped.messages.create(params);
    await wrapped.messages.create(params);

    expect(client._callCount()).toBe(1);
  });

  it('extracts system prompt from params correctly', async () => {
    const client  = makeAnthropicClient();
    const wrapped = trimwares.anthropic(client);

    await wrapped.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 100,
      system:     'You are a geography expert.',
      messages:   [{ role: 'user', content: 'Capital of France?' }],
    });

    const captured = client._capturedParams()[0] as { system?: string };
    // System should be passed through (potentially with cache_control added)
    expect(captured.system).toBeDefined();
  });
});

describe('trimwares.groq() — OpenAI-compatible', () => {
  it('wraps Groq client the same as OpenAI', async () => {
    const client  = makeOpenAIClient(['LLaMA answer.']);
    const wrapped = trimwares.groq(client);

    const result = await wrapped.chat.completions.create({
      model:    'llama-3.3-70b-versatile',
      messages: MESSAGES,
    }) as { choices: Array<{ message: { content: string } }> };

    expect(result.choices[0].message.content).toBe('LLaMA answer.');
    expect(wrapped.trimwares.getCostReport().totalRequests).toBe(1);
  });
});

describe('trimwares.ollama()', () => {
  it('returns a client with the correct shape', () => {
    const client = trimwares.ollama({ baseUrl: 'http://localhost:11434', model: 'llama3' });

    expect(typeof client.chat.completions.create).toBe('function');
    expect(typeof client.trimwares.getCostReport).toBe('function');
  });
});

describe('trimwares.openaiCompatible()', () => {
  it('wraps any OpenAI-compatible client with a custom provider name', async () => {
    const client  = makeOpenAIClient(['DeepSeek answer.']);
    const wrapped = trimwares.openaiCompatible(client, 'deepseek');

    const result = await wrapped.chat.completions.create({
      model:    'deepseek-chat',
      messages: MESSAGES,
    }) as { choices: Array<{ message: { content: string } }> };

    expect(result.choices[0].message.content).toBe('DeepSeek answer.');
  });
});

describe('All wrappers — .trimwares namespace', () => {
  it('every provider exposes the same reporting API', () => {
    const openai    = trimwares.openai(makeOpenAIClient());
    const anthropic = trimwares.anthropic(makeAnthropicClient());
    const groq      = trimwares.groq(makeOpenAIClient());
    const ollama    = trimwares.ollama();

    const providers = [openai, anthropic, groq, ollama];
    for (const p of providers) {
      expect(typeof p.trimwares.getCostReport).toBe('function');
      expect(typeof p.trimwares.getWasteReport).toBe('function');
      expect(typeof p.trimwares.printReport).toBe('function');
      expect(typeof p.trimwares.resetStats).toBe('function');
    }
  });
});
