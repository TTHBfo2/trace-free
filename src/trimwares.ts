import { TrimwareEngine, RawSdkResult } from './engine/TrimwareEngine.js';
import { TrimmerConfig, LLMRequest, CostReport, WasteReport, ProviderName, LLMResponse } from './types/index.js';
import { generateRequestId } from './core/CostEngine.js';

// ─── Reporting namespace attached to every wrapped client ─────────────────────

export interface TrimwaresReporting {
  getCostReport(): CostReport;
  getWasteReport(): WasteReport;
  getEnrichedWasteReport(): import('./types/index.js').EnrichedWasteReport;
  printReport(): void;
  resetStats(): void;
}

/** Any wrapped client gets the original type PLUS a .trimwares reporting namespace */
export type Wrapped<T> = T & { trimwares: TrimwaresReporting };

/** A proxied SDK method retrieved via Reflect.get -- shape is unknown until called */
type ProxiedMethod = (...args: unknown[]) => unknown;

function makeReporting(engine: TrimwareEngine): TrimwaresReporting {
  return {
    getCostReport:          () => engine.getCostReport(),
    getWasteReport:         () => engine.getWasteReport(),
    getEnrichedWasteReport: () => engine.getEnrichedWasteReport(),
    printReport:            () => engine.printReport(),
    resetStats:             () => engine.resetStats(),
  };
}

// ─── Normalizers: SDK params → our LLMRequest ─────────────────────────────────

function normalizeOpenAIParams(params: Record<string, unknown>): LLMRequest {
  const tools = params['tools'] as Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }> | undefined;
  const model = params['model'] as string | undefined;
  const maxTokens = params['max_tokens'] as number | undefined;
  const temperature = params['temperature'] as number | undefined;
  return {
    messages: params['messages'] as LLMRequest['messages'],
    ...(model       ? { model }       : {}),
    ...(maxTokens   ? { maxTokens }   : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(tools ? {
      tools: tools.map(t => ({
        name:        t.function.name,
        description: t.function.description,
        parameters:  t.function.parameters,
      })),
    } : {}),
  };
}

function normalizeAnthropicParams(params: Record<string, unknown>): LLMRequest {
  const system = params['system'];
  const systemContent = typeof system === 'string'
    ? system
    : Array.isArray(system)
      ? (system as Array<{ text?: string }>).map(b => b.text ?? '').join('\n')
      : undefined;

  const messages: LLMRequest['messages'] = [];
  if (systemContent) messages.push({ role: 'system', content: systemContent });
  messages.push(...(params['messages'] as LLMRequest['messages']));

  const tools = params['tools'] as Array<{ name: string; description: string; input_schema: Record<string, unknown> }> | undefined;
  const model = params['model'] as string | undefined;
  const maxTokens = params['max_tokens'] as number | undefined;
  const temperature = params['temperature'] as number | undefined;
  return {
    messages,
    ...(model       ? { model }       : {}),
    ...(maxTokens   ? { maxTokens }   : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(tools ? {
      tools: tools.map(t => ({
        name:        t.name,
        description: t.description,
        parameters:  t.input_schema,
      })),
    } : {}),
  };
}

function normalizeGeminiParams(content: unknown, modelName: string): LLMRequest {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return {
    messages: [{ role: 'user', content: text }],
    model:    modelName,
  };
}

// ─── OpenAI-compatible proxy ───────────────────────────────────────────────────
// Covers: OpenAI, Groq, Azure OpenAI, DeepSeek, Together AI, Perplexity,
//         Fireworks, Mistral, Cerebras, OpenRouter, any OpenAI-compat API.

function wrapOpenAICompatible<T extends object>(
  client: T,
  providerName: ProviderName,
  config?: TrimmerConfig,
): Wrapped<T> {
  const engine = new TrimwareEngine(providerName, config);

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'trimwares') return makeReporting(engine);

      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'chat') return value;

      // Wrap client.chat
      return new Proxy(value as object, {
        get(chatTarget, chatProp, chatReceiver) {
          const chatValue = Reflect.get(chatTarget, chatProp, chatReceiver);
          if (chatProp !== 'completions') return chatValue;

          // Wrap client.chat.completions
          return new Proxy(chatValue as object, {
            get(compTarget, compProp, compReceiver) {
              const compValue = Reflect.get(compTarget, compProp, compReceiver);
              if (compProp !== 'create') return compValue;

              // Intercept client.chat.completions.create(params)
              return async (params: Record<string, unknown>) => {
                const isStreaming = params['stream'] === true;
                const request     = normalizeOpenAIParams(params);

                if (isStreaming) {
                  const streamStart = Date.now();
                  const cacheHit    = engine.responseCache.get(request);
                  if (cacheHit) {
                    // Record cache hit BEFORE returning fake stream
                    recordStreamingCacheHit(engine, request, cacheHit, streamStart);
                    return buildFakeOpenAIStream(extractCachedContent(cacheHit));
                  }
                  // Apply the same optimizations (tool filtering, model routing) that
                  // non-streaming calls get via engine.intercept().
                  const cacheOpt     = engine.cacheOptimizer.optimize(request, engine.provider);
                  const sdkParams    = denormalizeOpenAIParams(params, { ...request, ...cacheOpt });
                  const streamParams = { ...sdkParams, stream_options: { include_usage: true } };
                  const stream = await (compValue as ProxiedMethod).call(compTarget, streamParams) as AsyncIterable<unknown>;
                  // Pass original `request` (not optimized) so response-cache key stays consistent
                  // with what engine.responseCache.get(request) looks up on the next call.
                  return wrapOpenAIStream(stream, request, engine, streamStart);
                }

                // Non-streaming: full intercept
                return engine.intercept(request, async (optimized) => {
                  const sdkParams = denormalizeOpenAIParams(params, optimized);
                  return (compValue as ProxiedMethod).call(compTarget, sdkParams) as Promise<RawSdkResult>;
                }, false);
              };
            },
          });
        },
      });
    },
  });

  return proxy as Wrapped<T>;
}

// ─── Anthropic proxy ──────────────────────────────────────────────────────────

function wrapAnthropic<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
  const engine = new TrimwareEngine('anthropic', config);

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'trimwares') return makeReporting(engine);

      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'messages') return value;

      // Wrap client.messages
      return new Proxy(value as object, {
        get(msgTarget, msgProp, msgReceiver) {
          const msgValue = Reflect.get(msgTarget, msgProp, msgReceiver);
          if (msgProp !== 'create') return msgValue;

          // Intercept client.messages.create(params)
          return async (params: Record<string, unknown>) => {
            const isStreaming = params['stream'] === true;
            const request     = normalizeAnthropicParams(params);

            if (isStreaming) {
              const streamStart = Date.now();
              const cacheHit    = engine.responseCache.get(request);
              if (cacheHit) {
                recordStreamingCacheHit(engine, request, cacheHit, streamStart);
                return buildFakeAnthropicStream(extractCachedContent(cacheHit));
              }
              // Apply cache_control injection (and any other pre-call optimizations) that
              // non-streaming calls get via engine.intercept() / denormalizeAnthropicParams().
              // Without this, Anthropic never sees cache_control blocks in streaming mode
              // and cache_creation/read tokens are always 0.
              const cacheOpt  = engine.cacheOptimizer.optimize(request, 'anthropic');
              const sdkParams = denormalizeAnthropicParams(params, { ...request, ...cacheOpt }, engine);
              const stream = await (msgValue as ProxiedMethod).call(msgTarget, sdkParams) as AsyncIterable<unknown>;
              // Pass original `request` (not optimized) so response-cache key stays consistent
              // with what engine.responseCache.get(request) looks up on the next call.
              return wrapAnthropicStream(stream, request, engine, streamStart);
            }

            return engine.intercept(request, async (optimized) => {
              const sdkParams = denormalizeAnthropicParams(params, optimized, engine);
              return (msgValue as ProxiedMethod).call(msgTarget, sdkParams) as Promise<RawSdkResult>;
            }, false);
          };
        },
      });
    },
  });

  return proxy as Wrapped<T>;
}

// ─── Gemini proxy ─────────────────────────────────────────────────────────────

function wrapGemini<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
  const engine = new TrimwareEngine('gemini', config);

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'trimwares') return makeReporting(engine);

      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'getGenerativeModel') return value;

      // Wrap getGenerativeModel to return a proxied model
      return (modelParams: Record<string, unknown>) => {
        const model = (value as ProxiedMethod).call(target, modelParams) as object;
        const modelName = modelParams['model'] as string ?? 'gemini-1.5-flash';
        return wrapGeminiModel(model, modelName, engine);
      };
    },
  });

  return proxy as Wrapped<T>;
}

function wrapGeminiModel(model: object, modelName: string, engine: TrimwareEngine): object {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Wrap generateContent (non-chat usage)
      if (prop === 'generateContent') {
        return async (content: unknown) => {
          const request = normalizeGeminiParams(content, modelName);
          return engine.intercept(request, async () => {
            return (value as ProxiedMethod).call(target, content) as Promise<RawSdkResult>;
          }, false);
        };
      }

      // Wrap startChat to intercept sendMessage
      if (prop === 'startChat') {
        return (chatParams: unknown) => {
          const chat = (value as ProxiedMethod).call(target, chatParams) as object;
          return wrapGeminiChat(chat, modelName, engine);
        };
      }

      return value;
    },
  });
}

function wrapGeminiChat(chat: object, modelName: string, engine: TrimwareEngine): object {
  return new Proxy(chat, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'sendMessage') return value;

      return async (content: unknown) => {
        const request = normalizeGeminiParams(content, modelName);
        return engine.intercept(request, async () => {
          return (value as ProxiedMethod).call(target, content) as Promise<RawSdkResult>;
        }, false);
      };
    },
  });
}

// ─── Ollama wrapper ───────────────────────────────────────────────────────────
// Ollama doesn't have a standard SDK — we provide a thin fetch-based client
// that matches the OpenAI-compatible chat interface.

export interface OllamaClient {
  chat: {
    completions: {
      create(params: {
        model?: string;
        messages: LLMRequest['messages'];
        stream?: boolean;
        options?: { num_predict?: number; temperature?: number };
      }): Promise<{ choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } }>;
    };
  };
  trimwares: TrimwaresReporting;
}

function createOllamaWrapper(
  options: { baseUrl?: string; model?: string } = {},
  config?: TrimmerConfig,
): OllamaClient {
  const baseUrl = options.baseUrl ?? 'http://localhost:11434';
  const engine  = new TrimwareEngine('ollama', config);

  const create = async (params: Record<string, unknown>) => {
    const request = normalizeOpenAIParams({ ...params, model: params['model'] ?? options.model ?? 'llama3' });

    return engine.intercept(request, async (optimized) => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:    optimized.model ?? 'llama3',
          messages: optimized.messages,
          stream:   false,
          options:  { num_predict: optimized.maxTokens, temperature: optimized.temperature },
        }),
      });
      if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
      const data = await res.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
      return {
        choices: [{ message: { content: data.message?.content ?? '' } }],
        usage:   { prompt_tokens: data.prompt_eval_count ?? 0, completion_tokens: data.eval_count ?? 0 },
      } as RawSdkResult;
    }, false) as Promise<OllamaClient['chat']['completions']['create'] extends (...args: unknown[]) => Promise<infer R> ? R : never>;
  };

  return {
    chat: { completions: { create } },
    trimwares: makeReporting(engine),
  };
}

// ─── Streaming helpers ────────────────────────────────────────────────────────

async function* buildFakeOpenAIStream(content: string): AsyncIterable<unknown> {
  yield { choices: [{ delta: { content }, finish_reason: null }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

async function* buildFakeAnthropicStream(content: string): AsyncIterable<unknown> {
  yield { type: 'content_block_delta', delta: { type: 'text_delta', text: content } };
  yield { type: 'message_stop' };
}

async function* wrapOpenAIStream(
  stream: AsyncIterable<unknown>,
  request: LLMRequest,
  engine: TrimwareEngine,
  startMs: number,
): AsyncIterable<unknown> {
  let fullContent = '';
  let model = request.model ?? '';
  let inputTokens = 0;
  let outputTokens = 0;
  const requestId = generateRequestId();

  for await (const chunk of stream) {
    const c = chunk as Record<string, unknown>;
    const delta = (c['choices'] as Array<{ delta?: { content?: string } }>)?.[0]?.delta?.content ?? '';
    fullContent += delta;
    if (c['model']) model = c['model'] as string;
    const usage = c['usage'] as Record<string, number> | undefined;
    if (usage) { inputTokens = usage['prompt_tokens'] ?? 0; outputTokens = usage['completion_tokens'] ?? 0; }
    yield chunk;
  }

  const latencyMs  = Date.now() - startMs;
  const pricing    = engine.costEngine.getPricing(model);
  const attribution = engine.attributor.attribute(request, outputTokens, pricing);

  // Fall back to attributor counts if provider didn't send usage in stream
  if (inputTokens === 0) inputTokens   = attribution.totalInputTokens;
  if (outputTokens === 0) outputTokens = attribution.totalOutputTokens;

  const cost = engine.costEngine.computeCost(inputTokens, outputTokens, pricing);
  const responseForCache = {
    content: fullContent, model, provider: engine.provider,
    usage: { inputTokens, outputTokens, cachedTokens: 0, totalTokens: inputTokens + outputTokens },
    cost, savings: 0, cached: false, cacheType: 'none' as const,
    requestId, latencyMs,
    _rawResponse: { choices: [{ message: { content: fullContent } }] },
  };
  engine.responseCache.set(request, responseForCache as unknown as import('./types/index.js').LLMResponse);
  const entry = engine.costEngine.record({ requestId, provider: engine.provider, model, inputTokens, outputTokens, cached: false, cacheType: 'none', latencyMs, request, savings: 0 });
  engine.sessionLog.write({
    timestamp: Date.now(), requestId, provider: engine.provider, model,
    attribution, cached: false, cacheType: 'none', latencyMs, nativeCache: false,
    realInputTokens: inputTokens, realOutputTokens: outputTokens,
    nativeCachedTokens: 0, realCost: entry.cost, realSavings: entry.savings,
  });
}

async function* wrapAnthropicStream(
  stream: AsyncIterable<unknown>,
  request: LLMRequest,
  engine: TrimwareEngine,
  startMs: number,
): AsyncIterable<unknown> {
  let fullContent = '';
  let model = request.model ?? '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const requestId = generateRequestId();

  for await (const chunk of stream) {
    const c = chunk as Record<string, unknown>;
    if (c['type'] === 'content_block_delta') {
      const delta = (c['delta'] as Record<string, string>)?.['text'] ?? '';
      fullContent += delta;
    }
    if (c['type'] === 'message_start') {
      const msg = c['message'] as Record<string, unknown>;
      model = msg?.['model'] as string ?? model;
      const usage = msg?.['usage'] as Record<string, number>;
      if (usage) {
        inputTokens      = usage['input_tokens'] ?? 0;
        cacheReadTokens  = usage['cache_read_input_tokens'] ?? 0;
        cacheWriteTokens = usage['cache_creation_input_tokens'] ?? 0;
      }
    }
    if (c['type'] === 'message_delta') {
      const usage = c['usage'] as Record<string, number>;
      if (usage) { outputTokens = usage['output_tokens'] ?? 0; }
    }
    yield chunk;
  }

  const latencyMs   = Date.now() - startMs;
  const pricing     = engine.costEngine.getPricing(model);
  const attribution = engine.attributor.attribute(request, outputTokens, pricing);

  // Anthropic always sends usage in message_start/message_delta — fallback just in case
  if (inputTokens === 0) inputTokens   = attribution.totalInputTokens;
  if (outputTokens === 0) outputTokens = attribution.totalOutputTokens;

  // cache_creation_input_tokens are billed at the full input rate (folded into
  // inputTokens); cache_read_input_tokens get the discounted cachedInputPerMillion rate.
  const totalInputTokens = inputTokens + cacheWriteTokens;
  const cost = engine.costEngine.computeCost(totalInputTokens, outputTokens, pricing, cacheReadTokens);
  const responseForCache = {
    content: fullContent, model, provider: engine.provider,
    usage: { inputTokens: totalInputTokens, outputTokens, cachedTokens: cacheReadTokens, totalTokens: totalInputTokens + outputTokens },
    cost, savings: 0, cached: false, cacheType: 'none' as const,
    requestId, latencyMs,
    _rawResponse: { content: [{ type: 'text', text: fullContent }] },
  };
  engine.responseCache.set(request, responseForCache as unknown as import('./types/index.js').LLMResponse);
  const entry = engine.costEngine.record({ requestId, provider: engine.provider, model, inputTokens: totalInputTokens, outputTokens, cached: false, cacheType: 'none', latencyMs, request, savings: 0, nativeCachedTokens: cacheReadTokens });
  engine.sessionLog.write({
    timestamp: Date.now(), requestId, provider: engine.provider, model,
    attribution, cached: false, cacheType: 'none', latencyMs, nativeCache: cacheReadTokens > 0 || cacheWriteTokens > 0,
    realInputTokens: totalInputTokens, realOutputTokens: outputTokens,
    nativeCachedTokens: cacheReadTokens, realCost: entry.cost, realSavings: entry.savings,
  });
}

// ─── Denormalizers: our optimized LLMRequest → back to SDK format ─────────────

function denormalizeOpenAIParams(original: Record<string, unknown>, optimized: LLMRequest): Record<string, unknown> {
  const result: Record<string, unknown> = { ...original, messages: optimized.messages };
  if (optimized.model)        result['model']       = optimized.model;
  if (optimized.maxTokens)    result['max_tokens']   = optimized.maxTokens;
  if (optimized.temperature !== undefined) result['temperature'] = optimized.temperature;
  if (optimized.tools && optimized.tools.length > 0) {
    result['tools'] = optimized.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  } else if (optimized.tools !== undefined && optimized.tools.length === 0) {
    delete result['tools'];
  }
  return result;
}

function denormalizeAnthropicParams(
  original: Record<string, unknown>,
  optimized: LLMRequest,
  engine: TrimwareEngine,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...original };

  // `optimized` may already have system stripped into anthropicSystemBlocks
  // (when intercept() spread cacheOpt into it). Check for pre-computed blocks first.
  const precomputedBlocks = (optimized as unknown as Record<string, unknown>)['anthropicSystemBlocks'] as import('./types/index.js').AnthropicSystemBlock[] | undefined;

  if (precomputedBlocks && precomputedBlocks.length > 0) {
    // System was already extracted and cache_control applied — use as-is
    result['system'] = precomputedBlocks;
  } else {
    // System still in messages — extract, optimize, and convert
    const systemMsgs = optimized.messages.filter(m => m.role === 'system');
    if (systemMsgs.length > 0) {
      const cacheOpt = engine.cacheOptimizer.optimize(optimized, 'anthropic');
      result['system'] = cacheOpt.anthropicSystemBlocks && cacheOpt.anthropicSystemBlocks.length > 0
        ? cacheOpt.anthropicSystemBlocks
        : systemMsgs.map(m => m.content).join('\n\n');
    } else if (original['system']) {
      // Fallback: preserve original system if we somehow lost it
      result['system'] = original['system'];
    } else {
      delete result['system'];
    }
  }

  // Non-system messages only
  const nonSystem = optimized.messages.filter(m => m.role !== 'system');
  result['messages'] = nonSystem.map(m => ({ role: m.role, content: m.content }));
  if (optimized.model) result['model'] = optimized.model;

  if (optimized.tools && optimized.tools.length > 0) {
    result['tools'] = optimized.tools.map(t => ({
      name: t.name, description: t.description, input_schema: t.parameters,
    }));
  }

  return result;
}

function extractCachedContent(cached: LLMResponse): string {
  return cached.content ?? '';
}

/** Record a streaming cache hit in the cost engine and session log. */
function recordStreamingCacheHit(
  engine: TrimwareEngine,
  request: LLMRequest,
  cacheHit: LLMResponse,
  startMs: number,
): void {
  const requestId = generateRequestId();
  const latencyMs = Date.now() - startMs;
  const entry = engine.costEngine.record({
    requestId, provider: engine.provider, model: cacheHit.model,
    inputTokens: cacheHit.usage.inputTokens, outputTokens: cacheHit.usage.outputTokens,
    cached: true, cacheType: 'response', latencyMs, request, savings: cacheHit.cost,
  });
  engine.sessionLog.write({
    timestamp: Date.now(), requestId, provider: engine.provider, model: cacheHit.model,
    attribution: engine.attributor.attribute(request, cacheHit.usage.outputTokens, engine.costEngine.getPricing(cacheHit.model)),
    cached: true, cacheType: 'response', latencyMs, nativeCache: false,
    realInputTokens: cacheHit.usage.inputTokens, realOutputTokens: cacheHit.usage.outputTokens,
    nativeCachedTokens: 0, realCost: entry.cost, realSavings: entry.savings,
  });
}

// ─── THE TRIMWARES OBJECT ─────────────────────────────────────────────────────

/**
 * trimwares — one-liner provider wrappers.
 *
 * Each function wraps your existing provider client with zero API changes.
 * Caching, routing, tool filtering, attribution and cost reporting all happen
 * automatically. The wrapped client has the same type as the original.
 *
 * @example
 * ```ts
 * import { trimwares } from '@trimwares/trace';
 * import OpenAI from 'openai';
 *
 * const openai = trimwares.openai(new OpenAI());
 * await openai.chat.completions.create({ model: 'gpt-4o-mini', messages });
 * openai.trimwares.printReport();
 * ```
 */
export const trimwares = {
  /** OpenAI — GPT-4o, GPT-4o-mini, GPT-4-turbo, etc. */
  openai<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
    return wrapOpenAICompatible(client, 'openai', config);
  },

  /** Anthropic — Claude Opus, Sonnet, Haiku */
  anthropic<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
    return wrapAnthropic(client, config);
  },

  /** Google Gemini — Gemini 1.5 Pro, 1.5 Flash, 2.0 Flash */
  gemini<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
    return wrapGemini(client, config);
  },

  /** Groq — LLaMA 3.3 70B, LLaMA 3.1 8B, Mixtral */
  groq<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
    return wrapOpenAICompatible(client, 'groq', config);
  },

  /** Ollama — local models (Llama3, Mistral, Phi, etc.). No client needed. */
  ollama(options?: { baseUrl?: string; model?: string }, config?: TrimmerConfig): OllamaClient {
    return createOllamaWrapper(options, config);
  },

  /** Azure OpenAI — pass an OpenAI client configured with Azure baseURL */
  azure<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
    return wrapOpenAICompatible(client, 'openai', config);
  },

  /** DeepSeek — OpenAI-compatible. Pass new OpenAI({ baseURL: 'https://api.deepseek.com' }) */
  deepseek<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
    return wrapOpenAICompatible(client, 'openai', config);
  },

  /** OpenRouter — routes to 100+ models. Pass new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' }) */
  openrouter<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
    return wrapOpenAICompatible(client, 'openai', config);
  },

  /** Mistral — OpenAI-compatible mode */
  mistral<T extends object>(client: T, config?: TrimmerConfig): Wrapped<T> {
    return wrapOpenAICompatible(client, 'openai', config);
  },

  /** Any OpenAI-compatible API — Together AI, Perplexity, Fireworks, Cerebras, etc. */
  openaiCompatible<T extends object>(client: T, providerName: string, config?: TrimmerConfig): Wrapped<T> {
    return wrapOpenAICompatible(client, (providerName as ProviderName) || 'custom', config);
  },
};
