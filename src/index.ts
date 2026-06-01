import {
  TrimmerConfig, LLMRequest, LLMResponse,
  CostReport, WasteReport, ProviderName,
  AgentPlan, AgentStep, AttributionBreakdown,
} from './types/index.js';
import { CostEngine, generateRequestId } from './core/CostEngine.js';
import { ResponseCache } from './cache/ResponseCache.js';
import { SemanticCache } from './cache/SemanticCache.js';
import { AgentPlanCache } from './cache/AgentPlanCache.js';
import { PromptCacheOptimizer } from './cache/PromptCacheOptimizer.js';
import { ContextPruner } from './optimization/ContextPruner.js';
import { ModelRouter } from './optimization/ModelRouter.js';
import { WasteReporter } from './reporting/WasteReport.js';
import { TokenAttributor } from './attribution/TokenAttributor.js';
import { SessionLog } from './telemetry/SessionLog.js';
import { printReport } from './cli/analyze.js';
import { BaseProvider } from './providers/BaseProvider.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';

export { OpenAIProvider }    from './providers/OpenAIProvider.js';
export { AnthropicProvider } from './providers/AnthropicProvider.js';
export { GeminiProvider }    from './providers/GeminiProvider.js';
export { GroqProvider }      from './providers/GroqProvider.js';
export { OllamaProvider }    from './providers/OllamaProvider.js';
export { BaseProvider }      from './providers/BaseProvider.js';
export * from './types/index.js';

/**
 * LLMCostTrimmer — the thing you install before your AI costs spiral.
 *
 * Zero-config. No prompt content stored. Drop-in wrapper around any LLM provider.
 *
 * @example
 * ```ts
 * import OpenAI from 'openai';
 * import { LLMCostTrimmer, OpenAIProvider } from '@tthbfo2/llm-cost-trimmer';
 *
 * const trimmer = new LLMCostTrimmer(new OpenAIProvider(new OpenAI()));
 * const response = await trimmer.chat({ messages: [{ role: 'user', content: 'Hello' }] });
 * trimmer.printReport();  // see exactly where your tokens went
 * ```
 */
export class LLMCostTrimmer {
  private provider: BaseProvider;
  private config: Required<TrimmerConfig>;

  private responseCache: ResponseCache;
  private semanticCache: SemanticCache;
  private planCache: AgentPlanCache;
  private nativeCacheOptimizer: PromptCacheOptimizer;
  private costEngine: CostEngine;
  private pruner: ContextPruner;
  private router: ModelRouter;
  private wasteReporter: WasteReporter;
  private attributor: TokenAttributor;
  private sessionLog: SessionLog;

  constructor(provider: BaseProvider, config: TrimmerConfig = {}) {
    this.provider = provider;

    this.config = {
      provider: config.provider ?? provider.name,
      defaultModel: config.defaultModel ?? provider.defaultModel,
      cache: {
        response:  { enabled: true,  ttlMs: 5 * 60 * 1000,  maxEntries: 2_000, ...(config.cache?.response  ?? {}) },
        semantic:  { enabled: true,  ttlMs: 10 * 60 * 1000, maxEntries: 500, similarityThreshold: 0.92, ...(config.cache?.semantic ?? {}) },
        plan:      { enabled: true,  ttlMs: 30 * 60 * 1000, maxEntries: 200, ...(config.cache?.plan      ?? {}) },
      },
      optimization: {
        compressPrompts:      config.optimization?.compressPrompts      ?? false, // moved to v0.2
        pruneContext:         config.optimization?.pruneContext          ?? false,
        routeToCheapestModel: config.optimization?.routeToCheapestModel ?? false,
      },
      pricing: config.pricing ?? {},
    };

    this.responseCache      = new ResponseCache({ ttlMs: this.config.cache.response.ttlMs, maxEntries: this.config.cache.response.maxEntries });
    this.semanticCache      = new SemanticCache({ ttlMs: this.config.cache.semantic.ttlMs, maxEntries: this.config.cache.semantic.maxEntries, similarityThreshold: (this.config.cache.semantic as { similarityThreshold?: number }).similarityThreshold });
    this.planCache          = new AgentPlanCache({ ttlMs: this.config.cache.plan.ttlMs, maxEntries: this.config.cache.plan.maxEntries });
    this.nativeCacheOptimizer = new PromptCacheOptimizer(this.config.provider);
    this.costEngine         = new CostEngine(this.config.pricing, this.config.provider);
    this.pruner             = new ContextPruner({ provider: this.config.provider as string });
    this.router             = new ModelRouter();
    this.wasteReporter      = new WasteReporter();
    this.attributor         = new TokenAttributor(this.config.provider as string);
    this.sessionLog         = new SessionLog();
  }

  // ─── Main API ──────────────────────────────────────────────────────────────

  async chat(request: LLMRequest): Promise<LLMResponse> {
    let req = { ...request };
    const model    = req.model ?? this.config.defaultModel;
    const provider = this.config.provider;
    const requestId = generateRequestId();
    const startMs   = Date.now();

    // 1. Exact response cache
    if (this.config.cache.response.enabled !== false) {
      const cached = this.responseCache.get(req);
      if (cached) {
        const savings = cached.cost;
        this.recordToLog(requestId, provider, cached.model, cached.usage.inputTokens, cached.usage.outputTokens, req, true, 'response', Date.now() - startMs, false);
        return { ...cached, requestId, cached: true, cacheType: 'response', savings, cost: 0, latencyMs: Date.now() - startMs };
      }
    }

    // 2. Semantic cache
    if (this.config.cache.semantic.enabled !== false) {
      const cached = this.semanticCache.get(req);
      if (cached) {
        const savings = cached.cost;
        this.recordToLog(requestId, provider, cached.model, cached.usage.inputTokens, cached.usage.outputTokens, req, true, 'semantic', Date.now() - startMs, false);
        return { ...cached, requestId, cached: true, cacheType: 'semantic', savings, cost: 0, latencyMs: Date.now() - startMs };
      }
    }

    // 3. Optional: context pruning
    if (this.config.optimization.pruneContext) {
      const result = this.pruner.prune(req.messages);
      req = { ...req, messages: result.messages };
    }

    // 4. Optional: model routing
    let resolvedModel    = model;
    let resolvedProvider: ProviderName = provider;
    if (this.config.optimization.routeToCheapestModel) {
      const decision = this.router.route(req, model, provider);
      resolvedModel    = decision.model;
      resolvedProvider = decision.provider;
      req = { ...req, model: resolvedModel };
    }

    // 5. Provider-native prompt caching (v0.1 headline feature)
    const cacheOptResult = this.nativeCacheOptimizer.optimize(req, resolvedProvider);
    const nativeCacheApplied = cacheOptResult.cacheableTokens > 0;

    // 6. Live call — pass optimized request + Anthropic system blocks if applicable
    let raw;
    if (resolvedProvider === 'anthropic' && cacheOptResult.anthropicSystemBlocks && this.provider instanceof AnthropicProvider) {
      const optimizedReq = { ...req, messages: cacheOptResult.messages, tools: cacheOptResult.tools };
      raw = await (this.provider as AnthropicProvider).send(optimizedReq, cacheOptResult.anthropicSystemBlocks);
    } else {
      raw = await this.provider.send({ ...req, messages: cacheOptResult.messages, tools: cacheOptResult.tools });
    }

    const latencyMs = Date.now() - startMs;
    const pricing   = this.costEngine.getPricing(raw.model);
    const cost      = this.costEngine.computeCost(raw.inputTokens, raw.outputTokens, pricing);

    const response = this.provider.buildResponse(raw, requestId, latencyMs, cost, 0, false, 'none');
    response.provider = resolvedProvider;
    response.usage.cachedTokens = raw.cachedTokens ?? 0;

    // 7. Store in caches
    this.responseCache.set(request, response);
    this.semanticCache.set(request, response);

    // 8. Record cost entry
    this.costEngine.record({
      requestId, provider: resolvedProvider, model: raw.model,
      inputTokens: raw.inputTokens, outputTokens: raw.outputTokens,
      cached: false, cacheType: 'none', latencyMs, request, savings: 0,
    });

    // 9. Log to session file (metadata only — no content)
    this.recordToLog(requestId, resolvedProvider, raw.model, raw.inputTokens, raw.outputTokens, request, false, 'none', latencyMs, nativeCacheApplied);

    return response;
  }

  // ─── Reporting (v0.1 core) ─────────────────────────────────────────────────

  getCostReport(): CostReport {
    return this.costEngine.getCostReport();
  }

  getWasteReport(): WasteReport {
    return this.wasteReporter.buildReport(this.costEngine.getEntries());
  }

  /** Print the full attribution report to stdout. */
  printReport(): void {
    printReport({ entries: this.sessionLog.getBuffer() });
  }

  // ─── Agentic Plan Cache ────────────────────────────────────────────────────

  getPlan(taskDescription: string): AgentPlan | null {
    if (this.config.cache.plan.enabled === false) return null;
    return this.planCache.getPlan(taskDescription);
  }

  recordPlan(params: { taskDescription: string; steps: AgentStep[]; inputTokensUsed: number; outputTokensUsed: number; model?: string }): AgentPlan {
    return this.planCache.storePlan({
      taskDescription:  params.taskDescription,
      steps:            params.steps,
      provider:         this.config.provider,
      model:            params.model ?? this.config.defaultModel,
      inputTokensUsed:  params.inputTokensUsed,
      outputTokensUsed: params.outputTokensUsed,
    });
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  resetStats(): void {
    this.costEngine.reset();
    this.responseCache.clear();
    this.semanticCache.clear();
    this.planCache.clear();
    this.sessionLog.clear();
  }

  destroy(): void {
    this.responseCache.destroy();
    this.planCache.destroy();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private recordToLog(
    requestId: string, provider: ProviderName, model: string,
    inputTokens: number, outputTokens: number,
    request: LLMRequest, cached: boolean, cacheType: string,
    latencyMs: number, nativeCache: boolean
  ): void {
    const pricing     = this.costEngine.getPricing(model);
    const attribution = this.attributor.attribute(request, outputTokens, pricing);
    this.sessionLog.write({
      timestamp: Date.now(), requestId, provider, model,
      attribution, cached, cacheType, latencyMs, nativeCache,
    });
  }
}
