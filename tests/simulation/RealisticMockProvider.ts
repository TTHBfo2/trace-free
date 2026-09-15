import { LLMRequest, ProviderName } from '../../src/types/index.js';
import { BaseProvider, RawProviderResponse } from '../../src/providers/BaseProvider.js';
import { AnthropicSystemBlock } from '../../src/types/index.js';

// 4 chars ≈ 1 token (GPT-style BPE approximation)
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateRequestTokens(request: LLMRequest): number {
  const messageTokens = request.messages.reduce((s, m) => s + estimateTokens(m.content), 0);
  const toolTokens = request.tools
    ? estimateTokens(JSON.stringify(request.tools))
    : 0;
  return messageTokens + toolTokens + 3; // baseline overhead
}

/**
 * A mock provider that derives token counts from actual content length —
 * not fixed numbers. This makes simulation data meaningful and comparable
 * to what a real provider would charge.
 *
 * Also simulates provider-native cache behavior: on the second call with
 * the same stable prefix, it returns cache_read_input_tokens at 10% cost.
 */
export class RealisticMockProvider extends BaseProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;

  private callLog: Array<{ inputTokens: number; outputTokens: number; cachedTokens: number; latencyMs: number }> = [];
  private stablePrefixHashes = new Map<string, number>(); // hash → write count
  private outputVariance: number;

  constructor(options: {
    name?: ProviderName;
    model?: string;
    outputVariance?: number; // 0-1, fraction of input tokens to use as output estimate
  } = {}) {
    super();
    this.name           = options.name   ?? 'openai';
    this.defaultModel   = options.model  ?? 'gpt-4o-mini';
    this.outputVariance = options.outputVariance ?? 0.25;
  }

  async send(
    request: LLMRequest,
    systemBlocks?: AnthropicSystemBlock[]
  ): Promise<RawProviderResponse> {
    const totalInputTokens = estimateRequestTokens(request);

    // Simulate Anthropic prompt cache: stable prefix (system + tools) charged once,
    // then at 10% on repeat calls
    const stablePrefix = this.extractStablePrefix(request);
    const prefixHash   = simpleHash(stablePrefix);
    const prefixTokens = estimateTokens(stablePrefix);
    const writeCount   = this.stablePrefixHashes.get(prefixHash) ?? 0;

    let cachedTokens  = 0;
    let billedInput   = totalInputTokens;

    const nativeCacheApplied =
      this.name === 'anthropic' &&
      systemBlocks?.some(b => b.cache_control) &&
      prefixTokens >= 1024;

    if (nativeCacheApplied && writeCount > 0) {
      // Cache hit: prefix charged at 10% (Anthropic cache_read price)
      cachedTokens = prefixTokens;
      billedInput  = totalInputTokens - prefixTokens + Math.ceil(prefixTokens * 0.1);
    }
    this.stablePrefixHashes.set(prefixHash, writeCount + 1);

    // Output tokens: realistic fraction of input (varies by scenario type)
    const baseOutput  = Math.ceil(totalInputTokens * this.outputVariance);
    const outputJitter = Math.floor(Math.random() * 20) - 10;
    const outputTokens = Math.max(10, baseOutput + outputJitter);

    // Simulate realistic latency (50-800ms based on token count)
    const latencyMs = nativeCacheApplied && writeCount > 0
      ? 5 + Math.floor(Math.random() * 15)      // cache hit: ~5-20ms
      : 80 + Math.ceil(totalInputTokens * 0.04); // live call scales with tokens

    this.callLog.push({ inputTokens: billedInput, outputTokens, cachedTokens, latencyMs });

    await simulateLatency(latencyMs);

    return {
      content:      generateRealisticOutput(request, outputTokens),
      model:        this.defaultModel,
      inputTokens:  billedInput,
      outputTokens,
      cachedTokens,
    };
  }

  getCallLog() { return [...this.callLog]; }

  getSummary() {
    const totalInput    = this.callLog.reduce((s, e) => s + e.inputTokens, 0);
    const totalOutput   = this.callLog.reduce((s, e) => s + e.outputTokens, 0);
    const totalCached   = this.callLog.reduce((s, e) => s + e.cachedTokens, 0);
    const avgLatencyMs  = this.callLog.length > 0
      ? Math.round(this.callLog.reduce((s, e) => s + e.latencyMs, 0) / this.callLog.length)
      : 0;
    return { calls: this.callLog.length, totalInput, totalOutput, totalCached, avgLatencyMs };
  }

  private extractStablePrefix(request: LLMRequest): string {
    const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const tools  = request.tools ? JSON.stringify(request.tools) : '';
    return system + tools;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function simpleHash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < Math.min(str.length, 2000); i++) {
    h = ((h ^ str.charCodeAt(i)) * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function generateRealisticOutput(request: LLMRequest, targetTokens: number): string {
  // Generate placeholder output of roughly the right token length
  const lastUser = [...request.messages].reverse().find(m => m.role === 'user');
  const base     = lastUser?.content.slice(0, 50) ?? 'response';
  const padding  = 'This is a simulated response that approximates realistic output length. '.repeat(
    Math.ceil((targetTokens * CHARS_PER_TOKEN) / 72)
  );
  return `[${base}] ${padding}`.slice(0, targetTokens * CHARS_PER_TOKEN);
}

function simulateLatency(ms: number): Promise<void> {
  // Don't actually sleep in tests — just resolve immediately.
  // The latency number is recorded but not waited on.
  void ms;
  return Promise.resolve();
}
