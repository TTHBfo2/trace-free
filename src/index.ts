import {
  TrimmerConfig, LLMRequest, LLMResponse,
  CostReport, WasteReport, ProviderName,
  AgentPlan, AgentStep,
} from './types/index.js';
import { CostEngine, generateRequestId } from './core/CostEngine.js';
import { ResponseCache } from './cache/ResponseCache.js';
import { SemanticCache } from './cache/SemanticCache.js';
import { AgentPlanCache } from './cache/AgentPlanCache.js';
import { PromptCacheOptimizer } from './cache/PromptCacheOptimizer.js';
import { ContextPruner } from './optimization/ContextPruner.js';
import { ModelRouter } from './optimization/ModelRouter.js';
import { ToolSchemaFilter } from './optimization/ToolSchemaFilter.js';
import { WasteReporter } from './reporting/WasteReport.js';
import { TokenAttributor } from './attribution/TokenAttributor.js';
import { SessionLog } from './telemetry/SessionLog.js';
import { printReport } from './cli/analyze.js';
import { BaseProvider } from './providers/BaseProvider.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';

// ─── One-liner API (recommended) ─────────────────────────────────────────────
export { trimwares } from './trimwares.js';
export type { Wrapped, TrimwaresReporting, OllamaClient } from './trimwares.js';

// ─── Class-based API (advanced / existing code) ───────────────────────────────
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
 * trimmer.printReport();
 * ```
 */
export class LLMCostTrimmer {
  private provider: BaseProvider;
  private config: Required<TrimmerConfig>;

  private responseCache:       ResponseCache;
  private semanticCache:       SemanticCache;
  private planCache:           AgentPlanCache;
  private nativeCacheOptimizer: PromptCacheOptimizer;
  private costEngine:          CostEngine;
  private pruner:              ContextPruner;
  private router:              ModelRouter;
  private toolFilter:          ToolSchemaFilter;
  private wasteReporter:       WasteReporter;
  private attributor:          TokenAttributor;
  private sessionLog:          SessionLog;

  constructor(provider: BaseProvider, config: TrimmerConfig = {}) {
    this.provider = provider;

    // Build fully-resolved config with no undefined values
    const responseCfg  = config.cache?.response  ?? {};
    const semanticCfg  = config.cache?.semantic   ?? {};
    const planCfg      = config.cache?.plan       ?? {};

    this.config = {
      provider:     config.provider     ?? provider.name,
      defaultModel: config.defaultModel ?? provider.defaultModel,
      cache: {
        response: { enabled: true,  ttlMs: responseCfg.ttlMs  ?? 5  * 60 * 1000, maxEntries: responseCfg.maxEntries ?? 2_000 },
        semantic: { enabled: false, ttlMs: semanticCfg.ttlMs  ?? 10 * 60 * 1000, maxEntries: semanticCfg.maxEntries ?? 500,
                    similarityThreshold: (semanticCfg as { similarityThreshold?: number }).similarityThreshold ?? 0.97 },
        // Heuristic cache disabled by default — stress test confirmed false positives at 0.97.
        plan:     { enabled: true,  ttlMs: planCfg.ttlMs      ?? 30 * 60 * 1000, maxEntries: planCfg.maxEntries     ?? 200 },
      },
      optimization: {
        compressPrompts:      config.optimization?.compressPrompts      ?? false,
        pruneContext:         config.optimization?.pruneContext          ?? false,
        routeToCheapestModel: config.optimization?.routeToCheapestModel ?? false, // opt-in — dev chose their model intentionally
        filterToolSchemas:    config.optimization?.filterToolSchemas    ?? true,  // on by default — conservative fallback
      },
      pricing: config.pricing ?? {},
    };

    const rc = this.config.cache.response as { ttlMs: number; maxEntries: number };
    const sc = this.config.cache.semantic as { ttlMs: number; maxEntries: number; similarityThreshold: number };
    const pc = this.config.cache.plan     as { ttlMs: number; maxEntries: number };

    this.responseCache        = new ResponseCache({ ttlMs: rc.ttlMs, maxEntries: rc.maxEntries });
    this.semanticCache        = new SemanticCache({ ttlMs: sc.ttlMs, maxEntries: sc.maxEntries, similarityThreshold: sc.similarityThreshold });
    this.planCache            = new AgentPlanCache({ ttlMs: pc.ttlMs, maxEntries: pc.maxEntries });
    this.nativeCacheOptimizer = new PromptCacheOptimizer(this.config.provider);
    this.costEngine           = new CostEngine(this.config.pricing, this.config.provider);
    this.pruner               = new ContextPruner({ provider: this.config.provider as string });
    this.router               = new ModelRouter();
    this.toolFilter           = new ToolSchemaFilter();
    this.wasteReporter        = new WasteReporter();
    this.attributor           = new TokenAttributor(this.config.provider as string);
    this.sessionLog           = new SessionLog();
  }

  // ─── Main API ──────────────────────────────────────────────────────────────

  async chat(request: LLMRequest): Promise<LLMResponse> {
    let req             = { ...request };
    const model         = req.model ?? this.config.defaultModel;
    const provider      = this.config.provider;
    const requestId     = generateRequestId();
    const startMs       = Date.now();

    // 1. Exact response cache
    const responseCacheEnabled = (this.config.cache.response as { enabled?: boolean }).enabled !== false;
    if (responseCacheEnabled) {
      const hit = this.responseCache.get(req);
      if (hit) {
        const latencyMs = Date.now() - startMs;
        this.costEngine.record({ requestId, provider, model: hit.model, inputTokens: hit.usage.inputTokens, outputTokens: hit.usage.outputTokens, cached: true, cacheType: 'response', latencyMs, request, savings: hit.cost });
        this.recordToLog(requestId, provider, hit.model, hit.usage.inputTokens, hit.usage.outputTokens, req, true, 'response', latencyMs, false);
        return { ...hit, requestId, cached: true, cacheType: 'response', savings: hit.cost, cost: 0, latencyMs };
      }
    }

    // 2. Semantic cache
    const semanticCacheEnabled = (this.config.cache.semantic as { enabled?: boolean }).enabled !== false;
    if (semanticCacheEnabled) {
      const hit = this.semanticCache.get(req);
      if (hit) {
        const latencyMs = Date.now() - startMs;
        this.costEngine.record({ requestId, provider, model: hit.model, inputTokens: hit.usage.inputTokens, outputTokens: hit.usage.outputTokens, cached: true, cacheType: 'semantic', latencyMs, request, savings: hit.cost });
        this.recordToLog(requestId, provider, hit.model, hit.usage.inputTokens, hit.usage.outputTokens, req, true, 'semantic', latencyMs, false);
        return { ...hit, requestId, cached: true, cacheType: 'semantic', savings: hit.cost, cost: 0, latencyMs };
      }
    }

    // 3. Optional: context pruning
    if (this.config.optimization.pruneContext) {
      req = { ...req, messages: this.pruner.prune(req.messages).messages };
    }

    // 4. Tool schema filtering — only send tools relevant to the current step
    //    Conservative: falls back to full schema if fewer than 2 tools match
    const filterToolSchemas = (this.config.optimization as { filterToolSchemas?: boolean }).filterToolSchemas !== false;
    if (filterToolSchemas && req.tools && req.tools.length >= 3) {
      const filtered = this.toolFilter.filter(req.tools, req.messages);
      if (filtered.tokensSaved > 0) {
        req = { ...req, tools: filtered.tools };
      }
    }

    // 5. Model routing — conservative, same-provider only
    let resolvedModel:    string       = model;
    let resolvedProvider: ProviderName = provider;
    if ((this.config.optimization as { routeToCheapestModel?: boolean }).routeToCheapestModel !== false) {
      const decision = this.router.route(req, model, provider);
      if (decision.wasRouted) {
        resolvedModel    = decision.model;
        resolvedProvider = decision.provider;
        req = { ...req, model: resolvedModel };
      }
    }

    // 6. Provider-native prompt caching
    const cacheOpt           = this.nativeCacheOptimizer.optimize(req, resolvedProvider);
    const nativeCacheApplied = cacheOpt.cacheableTokens > 0;
    const optimizedReq: LLMRequest = {
      ...req,
      messages: cacheOpt.messages,
      ...(cacheOpt.tools ? { tools: cacheOpt.tools } : {}),
    };

    // 7. Live call
    let raw;
    if (resolvedProvider === 'anthropic' && cacheOpt.anthropicSystemBlocks && this.provider instanceof AnthropicProvider) {
      raw = await (this.provider as AnthropicProvider).send(optimizedReq, cacheOpt.anthropicSystemBlocks);
    } else {
      raw = await this.provider.send(optimizedReq);
    }

    const latencyMs = Date.now() - startMs;
    const pricing   = this.costEngine.getPricing(raw.model);
    const cost      = this.costEngine.computeCost(raw.inputTokens, raw.outputTokens, pricing);

    const response        = this.provider.buildResponse(raw, requestId, latencyMs, cost, 0, false, 'none');
    response.provider     = resolvedProvider;
    response.usage.cachedTokens = raw.cachedTokens ?? 0;

    // 7. Store in caches
    this.responseCache.set(request, response);
    this.semanticCache.set(request, response);

    // 8. Record cost
    this.costEngine.record({ requestId, provider: resolvedProvider, model: raw.model, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, cached: false, cacheType: 'none', latencyMs, request, savings: 0 });

    // 9. Log session entry (metadata only)
    this.recordToLog(requestId, resolvedProvider, raw.model, raw.inputTokens, raw.outputTokens, request, false, 'none', latencyMs, nativeCacheApplied);

    return response;
  }

  // ─── Reporting ─────────────────────────────────────────────────────────────

  getCostReport(): CostReport { return this.costEngine.getCostReport(); }

  getWasteReport(): WasteReport { return this.wasteReporter.buildReport(this.costEngine.getEntries()); }

  printReport(): void { printReport({ entries: this.sessionLog.getBuffer() }); }

  // ─── Agentic Plan Cache ────────────────────────────────────────────────────

  getPlan(taskDescription: string): AgentPlan | null {
    if ((this.config.cache.plan as { enabled?: boolean }).enabled === false) return null;
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
    _inputTokens: number, outputTokens: number,
    request: LLMRequest, cached: boolean, cacheType: string,
    latencyMs: number, nativeCache: boolean
  ): void {
    const pricing     = this.costEngine.getPricing(model);
    const attribution = this.attributor.attribute(request, outputTokens, pricing);
    this.sessionLog.write({ timestamp: Date.now(), requestId, provider, model, attribution, cached, cacheType, latencyMs, nativeCache });
  }
}
