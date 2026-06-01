import {
  TrimmerConfig,
  LLMRequest,
  LLMResponse,
  CostReport,
  WasteReport,
  ProviderName,
  AgentPlan,
  AgentStep,
} from './types/index.js';
import { CostEngine, generateRequestId } from './core/CostEngine.js';
import { ResponseCache } from './cache/ResponseCache.js';
import { SemanticCache } from './cache/SemanticCache.js';
import { AgentPlanCache } from './cache/AgentPlanCache.js';
import { PromptCompressor } from './optimization/PromptCompressor.js';
import { ContextPruner } from './optimization/ContextPruner.js';
import { ModelRouter } from './optimization/ModelRouter.js';
import { WasteReporter } from './reporting/WasteReport.js';
import { BaseProvider } from './providers/BaseProvider.js';

export { OpenAIProvider } from './providers/OpenAIProvider.js';
export { AnthropicProvider } from './providers/AnthropicProvider.js';
export { GeminiProvider } from './providers/GeminiProvider.js';
export { GroqProvider } from './providers/GroqProvider.js';
export { OllamaProvider } from './providers/OllamaProvider.js';
export { BaseProvider } from './providers/BaseProvider.js';
export * from './types/index.js';

/**
 * LLMCostTrimmer — the thing you install before your AI costs spiral.
 *
 * Zero-config. No extra AI calls. Drop-in wrapper around any LLM provider.
 *
 * @example
 * ```ts
 * import OpenAI from 'openai';
 * import { LLMCostTrimmer, OpenAIProvider } from '@tthbfo2/llm-cost-trimmer';
 *
 * const trimmer = new LLMCostTrimmer(new OpenAIProvider(new OpenAI()));
 * const response = await trimmer.chat({ messages: [{ role: 'user', content: 'Hello' }] });
 * console.log(trimmer.getCostReport());
 * ```
 */
export class LLMCostTrimmer {
  private provider: BaseProvider;
  private config: Required<TrimmerConfig>;

  private responseCache: ResponseCache;
  private semanticCache: SemanticCache;
  private planCache: AgentPlanCache;
  private costEngine: CostEngine;
  private compressor: PromptCompressor;
  private pruner: ContextPruner;
  private router: ModelRouter;
  private wasteReporter: WasteReporter;

  constructor(provider: BaseProvider, config: TrimmerConfig = {}) {
    this.provider = provider;

    this.config = {
      provider: config.provider ?? provider.name,
      defaultModel: config.defaultModel ?? provider.defaultModel,
      cache: {
        response:  { enabled: true,  ttlMs: 5 * 60 * 1000,  maxEntries: 2_000, ...(config.cache?.response  ?? {}) },
        semantic:  { enabled: true,  ttlMs: 10 * 60 * 1000, maxEntries: 500,   similarityThreshold: 0.92, ...(config.cache?.semantic  ?? {}) },
        plan:      { enabled: true,  ttlMs: 30 * 60 * 1000, maxEntries: 200,   ...(config.cache?.plan     ?? {}) },
      },
      optimization: {
        compressPrompts:       config.optimization?.compressPrompts       ?? true,
        pruneContext:          config.optimization?.pruneContext           ?? false,
        routeToCheapestModel:  config.optimization?.routeToCheapestModel  ?? false,
      },
      pricing: config.pricing ?? {},
    };

    this.responseCache = new ResponseCache({
      ttlMs: this.config.cache.response.ttlMs,
      maxEntries: this.config.cache.response.maxEntries,
    });
    this.semanticCache = new SemanticCache({
      ttlMs: this.config.cache.semantic.ttlMs,
      maxEntries: this.config.cache.semantic.maxEntries,
      similarityThreshold: (this.config.cache.semantic as { similarityThreshold?: number }).similarityThreshold,
    });
    this.planCache = new AgentPlanCache({
      ttlMs: this.config.cache.plan.ttlMs,
      maxEntries: this.config.cache.plan.maxEntries,
    });
    this.costEngine = new CostEngine(this.config.pricing, this.config.provider);
    this.compressor = new PromptCompressor();
    this.pruner = new ContextPruner({ provider: this.config.provider as string });
    this.router = new ModelRouter();
    this.wasteReporter = new WasteReporter();
  }

  // ─── Main API ──────────────────────────────────────────────────────────────

  async chat(request: LLMRequest): Promise<LLMResponse> {
    let req = { ...request };
    const model = req.model ?? this.config.defaultModel;
    const provider = this.config.provider;
    const requestId = generateRequestId();
    const startMs = Date.now();

    // 1. Exact response cache
    if (this.config.cache.response.enabled !== false) {
      const cached = this.responseCache.get(req);
      if (cached) {
        this.costEngine.record({ requestId, provider, model: cached.model, inputTokens: cached.usage.inputTokens, outputTokens: cached.usage.outputTokens, cached: true, cacheType: 'response', latencyMs: Date.now() - startMs, request: req, savings: cached.cost });
        return { ...cached, requestId, cached: true, cacheType: 'response', savings: cached.cost, cost: 0, latencyMs: Date.now() - startMs };
      }
    }

    // 2. Semantic cache
    if (this.config.cache.semantic.enabled !== false) {
      const cached = this.semanticCache.get(req);
      if (cached) {
        this.costEngine.record({ requestId, provider, model: cached.model, inputTokens: cached.usage.inputTokens, outputTokens: cached.usage.outputTokens, cached: true, cacheType: 'semantic', latencyMs: Date.now() - startMs, request: req, savings: cached.cost });
        return { ...cached, requestId, cached: true, cacheType: 'semantic', savings: cached.cost, cost: 0, latencyMs: Date.now() - startMs };
      }
    }

    // 3. Optimizations (applied to the live request)
    if (this.config.optimization.compressPrompts) {
      const result = this.compressor.compress(req.messages);
      req = { ...req, messages: result.messages };
    }

    if (this.config.optimization.pruneContext) {
      const result = this.pruner.prune(req.messages);
      req = { ...req, messages: result.messages };
    }

    let resolvedModel = model;
    let resolvedProvider: ProviderName = provider;
    if (this.config.optimization.routeToCheapestModel) {
      const decision = this.router.route(req, model, provider);
      resolvedModel = decision.model;
      resolvedProvider = decision.provider;
      req = { ...req, model: resolvedModel };
    }

    // 4. Live call
    const raw = await this.provider.send(req);
    const latencyMs = Date.now() - startMs;
    const cost = this.costEngine.computeCost(raw.inputTokens, raw.outputTokens, this.costEngine.getPricing(raw.model));
    const savings = 0;

    const response = this.provider.buildResponse(raw, requestId, latencyMs, cost, savings, false, 'none');
    response.provider = resolvedProvider;

    // 5. Store in caches
    this.responseCache.set(request, response);
    this.semanticCache.set(request, response);

    // 6. Record cost
    this.costEngine.record({ requestId, provider: resolvedProvider, model: raw.model, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, cached: false, cacheType: 'none', latencyMs, request, savings: 0 });

    return response;
  }

  // ─── Agentic Plan Cache ────────────────────────────────────────────────────

  getPlan(taskDescription: string): AgentPlan | null {
    if (this.config.cache.plan.enabled === false) return null;
    return this.planCache.getPlan(taskDescription);
  }

  recordPlan(params: {
    taskDescription: string;
    steps: AgentStep[];
    inputTokensUsed: number;
    outputTokensUsed: number;
    model?: string;
  }): AgentPlan {
    return this.planCache.storePlan({
      taskDescription: params.taskDescription,
      steps: params.steps,
      provider: this.config.provider,
      model: params.model ?? this.config.defaultModel,
      inputTokensUsed: params.inputTokensUsed,
      outputTokensUsed: params.outputTokensUsed,
    });
  }

  // ─── Reporting ─────────────────────────────────────────────────────────────

  getCostReport(): CostReport {
    return this.costEngine.getCostReport();
  }

  getWasteReport(): WasteReport {
    return this.wasteReporter.buildReport(this.costEngine.getEntries());
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  resetStats(): void {
    this.costEngine.reset();
    this.responseCache.clear();
    this.semanticCache.clear();
    this.planCache.clear();
  }

  destroy(): void {
    this.responseCache.destroy();
    this.planCache.destroy();
  }
}
