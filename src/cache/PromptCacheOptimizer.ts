import { createHash } from 'crypto';
import {
  LLMRequest, LLMMessage, LLMTool,
  ProviderName, CacheOptimizationResult, AnthropicSystemBlock,
} from '../types/index.js';
import { TokenCounter } from '../core/TokenCounter.js';

// Anthropic's hard minimum: the combined cached content must meet this many
// tokens or the cache write silently does nothing. Most Claude models require
// 1,024 tokens, but Claude Haiku 4.5 requires 4,096 — see
// https://docs.claude.com/en/docs/build-with-claude/prompt-caching
const ANTHROPIC_CACHE_MIN_TOKENS        = 1024;
const ANTHROPIC_CACHE_MIN_TOKENS_HAIKU45 = 4096;
const OPENAI_CACHE_MIN_TOKENS    = 1024;

function anthropicCacheMinTokens(model?: string): number {
  return model?.startsWith('claude-haiku-4-5') ? ANTHROPIC_CACHE_MIN_TOKENS_HAIKU45 : ANTHROPIC_CACHE_MIN_TOKENS;
}

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
      default:          return {
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        cacheableTokens: 0,
        provider,
      };
    }
  }

  // ─── Anthropic ──────────────────────────────────────────────────────────────
  // Key change from v0.1: instead of checking each system message individually
  // (which means < 1,024 token system prompts never got cached), we now combine
  // all system messages into a single block. If the combined size meets the
  // threshold, the whole thing gets one cache_control breakpoint.
  //
  // This means a 400-token + 300-token system message pair (700 tokens combined)
  // that previously got zero caching now gets cached as a single 700-token block
  // — still below 1,024, so no cache. But a 600 + 500 pair → 1,100 tokens → cached.
  // More importantly, a single 1,200-token system prompt now always caches,
  // whereas before it only cached if it was exactly one message.

  private optimizeAnthropic(request: LLMRequest): CacheOptimizationResult {
    const systemMsgs  = request.messages.filter(m => m.role === 'system');
    const nonSystem   = request.messages.filter(m => m.role !== 'system');
    let cacheableTokens = 0;
    let breakpoints     = 0;

    const minTokens = anthropicCacheMinTokens(request.model);

    // Combine all system messages into one consolidated block
    const combinedSystem = systemMsgs.map(m => m.content).join('\n\n');
    const combinedTokens = this.counter.countText(combinedSystem);

    const systemBlocks: AnthropicSystemBlock[] = [];

    if (combinedSystem) {
      const eligible = combinedTokens >= minTokens && breakpoints < 4;
      systemBlocks.push({
        type: 'text',
        text: combinedSystem,
        ...(eligible ? { cache_control: { type: 'ephemeral' as const } } : {}),
      });
      if (eligible) { cacheableTokens += combinedTokens; breakpoints++; }
    }

    // Cache tool schemas if they're large enough — now as a second breakpoint
    let cachedTools: LLMTool[] | undefined;
    if (request.tools && request.tools.length > 0 && breakpoints < 4) {
      const toolTokens = this.counter.countText(JSON.stringify(request.tools));

      // Try combining tools + system if neither alone hits the threshold
      const combinedWithTools = combinedTokens + toolTokens;
      if (toolTokens >= minTokens) {
        // Tools alone are large enough — cache them separately
        cachedTools = request.tools.map((t, i) => ({
          ...t,
          ...(i === request.tools!.length - 1 ? { _cache: true } : {}),
        })) as LLMTool[];
        cacheableTokens += toolTokens;
        breakpoints++;
      } else if (combinedWithTools >= minTokens && systemBlocks.length > 0 && !systemBlocks[0].cache_control) {
        // System alone was < 1024, tools alone < 1024, but TOGETHER they exceed it.
        // Combine system+tools into the system block to hit the threshold.
        const merged = combinedSystem + '\n\n' + JSON.stringify(request.tools, null, 2);
        systemBlocks[0] = { type: 'text', text: merged, cache_control: { type: 'ephemeral' as const } };
        cacheableTokens += combinedWithTools;
        breakpoints++;
        // Don't pass tools separately — they're now in the system block
        cachedTools = undefined;
      } else {
        cachedTools = request.tools;
      }
    }
    if (!cachedTools && request.tools) cachedTools = request.tools;

    return {
      messages: nonSystem,
      ...(cachedTools        ? { tools: cachedTools }                  : {}),
      ...(systemBlocks.length > 0 ? { anthropicSystemBlocks: systemBlocks } : {}),
      cacheableTokens,
      provider: 'anthropic',
    };
  }

  // ─── OpenAI ─────────────────────────────────────────────────────────────────
  // OpenAI auto-caches any prompt prefix ≥ 1,024 tokens.
  // We ensure stable content (system + tools) is always at the front and
  // consistent across requests so the cached prefix is as long as possible.

  private optimizeOpenAI(request: LLMRequest, provider: ProviderName): CacheOptimizationResult {
    const system  = request.messages.filter(m => m.role === 'system');
    const history = request.messages.filter(m => m.role !== 'system').slice(0, -1);
    const last    = request.messages.filter(m => m.role !== 'system').slice(-1);
    const reordered: LLMMessage[] = [...system, ...history, ...last];

    const toolTokens   = request.tools ? this.counter.countText(JSON.stringify(request.tools)) : 0;
    const prefixTokens = [...system, ...history].reduce((s, m) => s + this.counter.countText(m.content), 0) + toolTokens;
    const cacheableTokens = prefixTokens >= OPENAI_CACHE_MIN_TOKENS ? prefixTokens : 0;

    return {
      messages: reordered,
      ...(request.tools ? { tools: request.tools } : {}),
      cacheableTokens,
      provider,
    };
  }

  fingerprintStableContent(request: LLMRequest): string {
    const stable = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    return createHash('sha256').update(stable).digest('hex').slice(0, 16);
  }
}
