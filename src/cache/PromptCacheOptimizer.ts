import { createHash } from 'crypto';
import {
  LLMRequest, LLMMessage, LLMTool,
  ProviderName, CacheOptimizationResult, AnthropicSystemBlock,
} from '../types/index.js';
import { TokenCounter } from '../core/TokenCounter.js';

const ANTHROPIC_CACHE_MIN_TOKENS = 1024;
const OPENAI_CACHE_MIN_TOKENS    = 1024;

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

  private optimizeAnthropic(request: LLMRequest): CacheOptimizationResult {
    const systemMsgs = request.messages.filter(m => m.role === 'system');
    const nonSystem  = request.messages.filter(m => m.role !== 'system');
    let cacheableTokens = 0;
    let breakpoints = 0;

    const systemBlocks: AnthropicSystemBlock[] = [];
    for (const msg of systemMsgs) {
      const t        = this.counter.countText(msg.content);
      const eligible = t >= ANTHROPIC_CACHE_MIN_TOKENS && breakpoints < 4;
      systemBlocks.push({
        type: 'text',
        text: msg.content,
        ...(eligible ? { cache_control: { type: 'ephemeral' as const } } : {}),
      });
      if (eligible) { cacheableTokens += t; breakpoints++; }
    }

    let cachedTools: LLMTool[] | undefined;
    if (request.tools && request.tools.length > 0 && breakpoints < 4) {
      const toolTokens = this.counter.countText(JSON.stringify(request.tools));
      if (toolTokens >= ANTHROPIC_CACHE_MIN_TOKENS) {
        cachedTools = request.tools.map((t, i) => ({
          ...t,
          ...(i === request.tools!.length - 1 ? { _cache: true } : {}),
        })) as LLMTool[];
        cacheableTokens += toolTokens;
        breakpoints++;
      }
    }
    if (!cachedTools && request.tools) cachedTools = request.tools;

    return {
      messages: nonSystem,
      ...(cachedTools                          ? { tools: cachedTools }                         : {}),
      ...(systemBlocks.length > 0              ? { anthropicSystemBlocks: systemBlocks }        : {}),
      cacheableTokens,
      provider: 'anthropic',
    };
  }

  private optimizeOpenAI(request: LLMRequest, provider: ProviderName): CacheOptimizationResult {
    const system  = request.messages.filter(m => m.role === 'system');
    const history = request.messages.filter(m => m.role !== 'system').slice(0, -1);
    const last    = request.messages.filter(m => m.role !== 'system').slice(-1);
    const reordered: LLMMessage[] = [...system, ...history, ...last];

    const prefixTokens    = [...system, ...history].reduce((s, m) => s + this.counter.countText(m.content), 0);
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
