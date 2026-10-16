import { createHash } from 'crypto';
import {
  CostEntry,
  CostReport,
  LLMRequest,
  ModelPricing,
  ProviderCostSummary,
  ProviderName,
  WasteFlag,
  CacheType,
} from '../types/index.js';
import { WasteDetector } from './WasteDetector.js';

// Current market pricing per 1M tokens (input / output)
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // OpenAI — cachedInputPerMillion is the automatic prompt-cache rate. Unlike
  // Anthropic, no opt-in is needed: OpenAI caches any prompt prefix over 1024
  // tokens by itself. The discount is NOT uniform (50% on the 4o family, 75%
  // on 4.1), so it is stated per model rather than derived.
  // Verified against https://developers.openai.com/api/docs/pricing 2026-09-28.
  'gpt-4.1':              { inputPerMillion: 2.00,  outputPerMillion: 8.00,  cachedInputPerMillion: 0.50  },
  'gpt-4.1-mini':         { inputPerMillion: 0.40,  outputPerMillion: 1.60,  cachedInputPerMillion: 0.10  },
  'gpt-4o':               { inputPerMillion: 2.50,  outputPerMillion: 10.00, cachedInputPerMillion: 1.25  },
  'gpt-4o-mini':          { inputPerMillion: 0.15,  outputPerMillion: 0.60,  cachedInputPerMillion: 0.075 },
  // No cachedInputPerMillion: these predate automatic prompt caching, so cached
  // tokens are billed at the full input rate (the ?? fallback handles it).
  'gpt-4-turbo':          { inputPerMillion: 10.00, outputPerMillion: 30.00 },
  'gpt-3.5-turbo':        { inputPerMillion: 0.50,  outputPerMillion: 1.50  },
  // Anthropic — cachedInputPerMillion is the cache-read rate (10% of input price)
  'claude-opus-4-7':      { inputPerMillion: 5.00,  outputPerMillion: 25.00, cachedInputPerMillion: 0.50 },
  'claude-sonnet-4-6':    { inputPerMillion: 3.00,  outputPerMillion: 15.00, cachedInputPerMillion: 0.30 },
  'claude-haiku-4-5':     { inputPerMillion: 1.00,  outputPerMillion: 5.00,  cachedInputPerMillion: 0.10 },
  'claude-3-5-sonnet':    { inputPerMillion: 3.00,  outputPerMillion: 15.00, cachedInputPerMillion: 0.30 },
  'claude-3-5-haiku':     { inputPerMillion: 0.80,  outputPerMillion: 4.00,  cachedInputPerMillion: 0.08 },
  // Gemini
  'gemini-1.5-pro':       { inputPerMillion: 1.25,  outputPerMillion: 5.00  },
  'gemini-1.5-flash':     { inputPerMillion: 0.075, outputPerMillion: 0.30  },
  'gemini-2.0-flash':     { inputPerMillion: 0.10,  outputPerMillion: 0.40  },
  // Groq. Verified against https://console.groq.com/docs/model/<id> 2026-10-14.
  //
  // Groq DOES have a prompt cache: automatic, no code changes, no extra fee,
  // 50% off cached input, minimum cacheable prefix 128–1024 tokens depending on
  // the model, reported in the OpenAI-compatible
  // `usage.prompt_tokens_details.cached_tokens`. It is currently limited to the
  // GPT-OSS family, which is why only those carry a cachedInputPerMillion.
  // See https://console.groq.com/docs/prompt-caching — an earlier changelog of
  // ours claimed Groq had no prompt cache at all. That was wrong.
  //
  // Keys are the bare model id; Groq reports these prefixed, as
  // `openai/gpt-oss-20b`, which getPricing's substring match resolves. Longest
  // key wins, so `gpt-oss-120b` is matched before `gpt-oss-20b`.
  'gpt-oss-safeguard-20b':   { inputPerMillion: 0.075, outputPerMillion: 0.30, cachedInputPerMillion: 0.037 },
  'gpt-oss-120b':            { inputPerMillion: 0.15,  outputPerMillion: 0.60, cachedInputPerMillion: 0.075 },
  'gpt-oss-20b':             { inputPerMillion: 0.075, outputPerMillion: 0.30, cachedInputPerMillion: 0.037 },
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  'llama-3.1-8b-instant':    { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  'mixtral-8x7b-32768':      { inputPerMillion: 0.24, outputPerMillion: 0.24 },
  // Ollama: free
  'ollama':               { inputPerMillion: 0, outputPerMillion: 0 },
};

export class CostEngine {
  private entries: CostEntry[] = [];
  private pricing: Record<string, ModelPricing>;
  private wasteDetector: WasteDetector;
  private sessionStart = Date.now();
  private unpriced = new Set<string>();

  constructor(
    pricingOverrides: Partial<Record<string, ModelPricing>> = {},
    provider: ProviderName = 'openai'
  ) {
    const overrides = Object.fromEntries(
      Object.entries(pricingOverrides).filter(([, v]) => v !== undefined)
    ) as Record<string, ModelPricing>;
    this.pricing = { ...DEFAULT_PRICING, ...overrides };
    void provider; // provider stored in config; WasteDetector is provider-agnostic
    this.wasteDetector = new WasteDetector();
  }

  record(params: {
    requestId: string;
    provider: ProviderName;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cached: boolean;
    cacheType: CacheType;
    latencyMs: number;
    request: LLMRequest;
    savings?: number;
    nativeCachedTokens?: number;
  }): CostEntry {
    const { requestId, provider, model, inputTokens, outputTokens, cached, cacheType, latencyMs, request, savings = 0, nativeCachedTokens = 0 } = params;

    const pricing = this.getPricing(model);
    const cost = cached ? 0 : this.computeCost(inputTokens, outputTokens, pricing, nativeCachedTokens);

    // Provider-native prompt caching (e.g. Anthropic cache_control) bills cache
    // reads at a fraction of the normal input rate — the difference is savings
    // already realized on this live call.
    const cachedRate    = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
    const nativeCacheSavings = cached ? 0 : (nativeCachedTokens / 1_000_000) * (pricing.inputPerMillion - cachedRate);
    const totalSavings = savings + nativeCacheSavings;

    const cheapestPerToken = this.cheapestInputCostPerToken();

    const partial: Omit<CostEntry, 'wasteFlags'> = {
      timestamp: Date.now(),
      requestId,
      provider,
      model,
      inputTokens,
      outputTokens,
      cost,
      savings: totalSavings,
      cached,
      cacheType,
      latencyMs,
    };

    const wasteFlags: WasteFlag[] = cached
      ? []
      : this.wasteDetector.detectFlags(request, partial, cheapestPerToken);

    const entry: CostEntry = { ...partial, wasteFlags };
    this.entries.push(entry);
    return entry;
  }

  getPricing(model: string): ModelPricing {
    const normalized = model.toLowerCase();
    if (this.pricing[normalized]) return this.pricing[normalized];

    // Fuzzy match: sort keys longest-first so 'gpt-4o-mini' wins over 'gpt-4o'
    const sortedKeys = Object.keys(this.pricing).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
      if (normalized.includes(key) || key.includes(normalized)) return this.pricing[key];
    }

    // Unknown model. The rate below is GPT-4o's and is almost certainly wrong
    // for whatever this is, so mark it and remember the model name: callers
    // that display money are expected to disclose both. Silently presenting
    // this as the model's rate is how a Groq session came out 33x high.
    this.unpriced.add(model);
    const base = this.pricing['gpt-4o'] ?? { inputPerMillion: 2.50, outputPerMillion: 10.00 };
    return { ...base, estimated: true };
  }

  /**
   * Models seen this session that have no published rate, so their costs came
   * from the fallback. Empty is the normal case.
   */
  getUnpricedModels(): string[] {
    return [...this.unpriced];
  }

  computeCost(inputTokens: number, outputTokens: number, pricing: ModelPricing, cachedTokens = 0): number {
    const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
    return (
      (inputTokens / 1_000_000) * pricing.inputPerMillion +
      (cachedTokens / 1_000_000) * cachedRate +
      (outputTokens / 1_000_000) * pricing.outputPerMillion
    );
  }

  getCostReport(): CostReport {
    const now = Date.now();
    const byProvider: Record<string, ProviderCostSummary> = {};
    const byModel: Record<string, { provider: ProviderName; totalCost: number; totalSavings: number; requestCount: number; cachedCount: number; inputTokens: number; outputTokens: number }> = {};

    let totalCost = 0;
    let totalSavings = 0;
    let cachedRequests = 0;

    for (const e of this.entries) {
      totalCost += e.cost;
      totalSavings += e.savings;
      if (e.cached) cachedRequests++;

      // By provider
      if (!byProvider[e.provider]) {
        byProvider[e.provider] = { totalCost: 0, totalSavings: 0, requestCount: 0, cachedCount: 0, inputTokens: 0, outputTokens: 0 };
      }
      const p = byProvider[e.provider];
      p.totalCost += e.cost;
      p.totalSavings += e.savings;
      p.requestCount++;
      if (e.cached) p.cachedCount++;
      p.inputTokens += e.inputTokens;
      p.outputTokens += e.outputTokens;

      // By model
      if (!byModel[e.model]) {
        byModel[e.model] = { provider: e.provider, totalCost: 0, totalSavings: 0, requestCount: 0, cachedCount: 0, inputTokens: 0, outputTokens: 0 };
      }
      const m = byModel[e.model];
      m.totalCost += e.cost;
      m.totalSavings += e.savings;
      m.requestCount++;
      if (e.cached) m.cachedCount++;
      m.inputTokens += e.inputTokens;
      m.outputTokens += e.outputTokens;
    }

    const totalRequests = this.entries.length;
    const grandTotal = totalCost + totalSavings;
    const savingsPercent = grandTotal > 0 ? (totalSavings / grandTotal) * 100 : 0;

    return {
      totalCost,
      totalSavings,
      savingsPercent: parseFloat(savingsPercent.toFixed(1)),
      totalRequests,
      cachedRequests,
      cacheHitRate: totalRequests > 0 ? parseFloat(((cachedRequests / totalRequests) * 100).toFixed(1)) : 0,
      byProvider,
      byModel,
      timeRange: { start: this.sessionStart, end: now },
      generatedAt: now,
      dashboardHint: 'Track spend over time at trimwares.com/dashboard',
    };
  }

  getEntries(): CostEntry[] {
    return [...this.entries];
  }

  reset(): void {
    this.entries = [];
    this.sessionStart = Date.now();
  }

  private computeCostForSaving(inputTokens: number, outputTokens: number, model: string): number {
    return this.computeCost(inputTokens, outputTokens, this.getPricing(model));
  }

  computeSavings(inputTokens: number, outputTokens: number, model: string): number {
    return this.computeCostForSaving(inputTokens, outputTokens, model);
  }

  private cheapestInputCostPerToken(): number {
    let cheapest = Infinity;
    for (const p of Object.values(this.pricing)) {
      if (p.inputPerMillion > 0) {
        cheapest = Math.min(cheapest, p.inputPerMillion / 1_000_000);
      }
    }
    return cheapest === Infinity ? 0 : cheapest;
  }
}

export function generateRequestId(): string {
  return createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
}
