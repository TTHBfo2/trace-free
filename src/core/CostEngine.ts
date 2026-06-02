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
  // OpenAI
  'gpt-4o':               { inputPerMillion: 2.50,  outputPerMillion: 10.00 },
  'gpt-4o-mini':          { inputPerMillion: 0.15,  outputPerMillion: 0.60  },
  'gpt-4-turbo':          { inputPerMillion: 10.00, outputPerMillion: 30.00 },
  'gpt-3.5-turbo':        { inputPerMillion: 0.50,  outputPerMillion: 1.50  },
  // Anthropic
  'claude-opus-4-7':      { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-sonnet-4-6':    { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-haiku-4-5':     { inputPerMillion: 0.80,  outputPerMillion: 4.00  },
  'claude-3-5-sonnet':    { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-3-5-haiku':     { inputPerMillion: 0.80,  outputPerMillion: 4.00  },
  // Gemini
  'gemini-1.5-pro':       { inputPerMillion: 1.25,  outputPerMillion: 5.00  },
  'gemini-1.5-flash':     { inputPerMillion: 0.075, outputPerMillion: 0.30  },
  'gemini-2.0-flash':     { inputPerMillion: 0.10,  outputPerMillion: 0.40  },
  // Groq
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
  }): CostEntry {
    const { requestId, provider, model, inputTokens, outputTokens, cached, cacheType, latencyMs, request, savings = 0 } = params;

    const pricing = this.getPricing(model);
    const cost = cached ? 0 : this.computeCost(inputTokens, outputTokens, pricing);
    const cheapestPerToken = this.cheapestInputCostPerToken();

    const partial: Omit<CostEntry, 'wasteFlags'> = {
      timestamp: Date.now(),
      requestId,
      provider,
      model,
      inputTokens,
      outputTokens,
      cost,
      savings,
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

    return this.pricing['gpt-4o'] ?? { inputPerMillion: 2.50, outputPerMillion: 10.00 };
  }

  computeCost(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
    return (
      (inputTokens / 1_000_000) * pricing.inputPerMillion +
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
