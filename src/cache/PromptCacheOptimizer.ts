import { createHash } from 'crypto';
import {
  LLMRequest, LLMMessage, LLMTool,
  ProviderName, CacheOptimizationResult, AnthropicSystemBlock,
} from '../types/index.js';
import { TokenCounter } from '../core/TokenCounter.js';

// Anthropic requires >= 1024 tokens in a block to be cache-eligible
const ANTHROPIC_CACHE_MIN_TOKENS = 1024;
// OpenAI auto-caches prefixes >= 1024 tokens — we reorder to maximise the cacheable prefix
const OPENAI_CACHE_MIN_TOKENS = 1024;

export class PromptCacheOptimizer {
  private counter: TokenCounter;

  constructor(provider: ProviderName = 'openai') {
    this.counter = new TokenCounter(provider as string);
  }

  optimize(request: LLMRequest, provider: ProviderName): CacheOptimizationResult {
    switch (provider) {
      case 'anthropic': return this.optimizeAnthropic(request);
      case 'openai':
      case 'groq':      return this.optimizeOpenAI(request, provider);
      default:          return { messages: request.messages, tools: request.tools, cacheableTokens: 0, provider };
    }
  }

  // ─── Anthropic ──────────────────────────────────────────────────────────────
  // Injects cache_control: { type: 'ephemeral' } on stable content blocks.
  // Up to 4 breakpoints allowed. We use: system prompt, tool schemas, large RAG blocks.

  private optimizeAnthropic(request: LLMRequest): CacheOptimizationResult {
    const systemMsgs = request.messages.filter(m => m.role === 'system');
    const nonSystem  = request.messages.filter(m => m.role !== 'system');
    let cacheableTokens = 0;
    let breakpoints = 0;

    // Build system blocks with cache_control
    const systemBlocks: AnthropicSystemBlock[] = [];
    for (const msg of systemMsgs) {
      const t = this.counter.countText(msg.content);
      const eligible = t >= ANTHROPIC_CACHE_MIN_TOKENS && breakpoints < 4;
      systemBlocks.push({
        type: 'text',
        text: msg.content,
        ...(eligible ? { cache_control: { type: 'ephemeral' } } : {}),
      });
      if (eligible) { cacheableTokens += t; breakpoints++; }
    }

    // Cache tool schemas if large enough
    let cachedTools: LLMTool[] | undefined = request.tools;
    if (request.tools && request.tools.length > 0 && breakpoints < 4) {
      const toolTokens = this.counter.countText(JSON.stringify(request.tools));
      if (toolTokens >= ANTHROPIC_CACHE_MIN_TOKENS) {
        // Signal to AnthropicProvider to add cache_control on last tool definition
        cachedTools = request.tools.map((t, i) => ({
          ...t,
          ...(i === request.tools!.length - 1 ? { _cache: true } : {}),
        })) as LLMTool[];
        cacheableTokens += toolTokens;
        breakpoints++;
      }
    }

    return {
      messages: nonSystem,
      tools: cachedTools,
      anthropicSystemBlocks: systemBlocks.length > 0 ? systemBlocks : undefined,
      cacheableTokens,
      provider: 'anthropic',
    };
  }

  // ─── OpenAI ─────────────────────────────────────────────────────────────────
  // OpenAI auto-caches any prompt prefix >= 1024 tokens.
  // Strategy: ensure stable content (system, tools, RAG) comes first so the
  // cacheable prefix is as long as possible across requests.

  private optimizeOpenAI(request: LLMRequest, provider: ProviderName): CacheOptimizationResult {
    const system  = request.messages.filter(m => m.role === 'system');
    const history = request.messages.filter(m => m.role !== 'system').slice(0, -1);
    const last    = request.messages.filter(m => m.role !== 'system').slice(-1);

    // Canonical order: system → history → current user message
    // (tools are passed separately in the API call, already optimal)
    const reordered: LLMMessage[] = [...system, ...history, ...last];

    // Estimate cacheable prefix (system + history if stable)
    const prefixTokens = [...system, ...history]
      .reduce((s, m) => s + this.counter.countText(m.content), 0);
    const cacheableTokens = prefixTokens >= OPENAI_CACHE_MIN_TOKENS ? prefixTokens : 0;

    return { messages: reordered, tools: request.tools, cacheableTokens, provider };
  }

  // ─── Utility ────────────────────────────────────────────────────────────────

  fingerprintStableContent(request: LLMRequest): string {
    const stable = request.messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n');
    return createHash('sha256').update(stable).digest('hex').slice(0, 16);
  }
}
