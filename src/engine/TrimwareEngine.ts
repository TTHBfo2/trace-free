import { createHash } from 'crypto';
import {
  TrimmerConfig, LLMRequest, CostReport, WasteReport,
  ProviderName, CacheType,
} from '../types/index.js';
import { CostEngine, generateRequestId } from '../core/CostEngine.js';
import { buildEnrichedWasteReport } from '../reporting/EnrichedWasteReport.js';
import { EnrichedWasteReport } from '../types/index.js';
import { ResponseCache } from '../cache/ResponseCache.js';
import { SemanticCache } from '../cache/SemanticCache.js';
import { AgentPlanCache } from '../cache/AgentPlanCache.js';
import { PromptCacheOptimizer } from '../cache/PromptCacheOptimizer.js';
import { ModelRouter } from '../optimization/ModelRouter.js';
import { ToolSchemaFilter } from '../optimization/ToolSchemaFilter.js';
import { ContextPruner } from '../optimization/ContextPruner.js';
import { TokenAttributor } from '../attribution/TokenAttributor.js';
import { WasteReporter } from '../reporting/WasteReport.js';
import { SessionLog } from '../telemetry/SessionLog.js';
import { printReport } from '../cli/analyze.js';

/**
 * Shared optimization core used by all provider proxy wrappers.
 * Holds all caches, attributors, and cost tracking state.
 * One instance per trimwares.provider() call.
 */
export class TrimwareEngine {
  readonly provider: ProviderName;
  private config: Required<TrimmerConfig>;

  readonly responseCache:  ResponseCache;
  readonly semanticCache:  SemanticCache;
  readonly planCache:      AgentPlanCache;
  readonly cacheOptimizer: PromptCacheOptimizer;
  readonly costEngine:     CostEngine;
  readonly router:         ModelRouter;
  readonly toolFilter:     ToolSchemaFilter;
  readonly pruner:         ContextPruner;
  readonly attributor:     TokenAttributor;
  readonly sessionLog:     SessionLog;
  readonly wasteReporter:  WasteReporter;

  constructor(provider: ProviderName, config: TrimmerConfig = {}) {
    this.provider = provider;

    const rc = config.cache?.response  ?? {};
    const sc = config.cache?.semantic  ?? {};
    const pc = config.cache?.plan      ?? {};

    // Fail fast on bad config — silent misconfiguration is worse than an error.
    const threshold = (sc as { similarityThreshold?: number }).similarityThreshold;
    if (threshold !== undefined && (threshold < 0 || threshold > 1)) {
      throw new Error(`[trimwares] cache.semantic.similarityThreshold must be between 0 and 1, got ${threshold}`);
    }
    if (rc.ttlMs !== undefined && rc.ttlMs < 0) {
      throw new Error(`[trimwares] cache.response.ttlMs must be >= 0, got ${rc.ttlMs}`);
    }
    if (sc.ttlMs !== undefined && sc.ttlMs < 0) {
      throw new Error(`[trimwares] cache.semantic.ttlMs must be >= 0, got ${sc.ttlMs}`);
    }
    if (pc.ttlMs !== undefined && pc.ttlMs < 0) {
      throw new Error(`[trimwares] cache.plan.ttlMs must be >= 0, got ${pc.ttlMs}`);
    }

    this.config = {
      provider,
      defaultModel: config.defaultModel ?? '',
      cache: {
        response: { enabled: true, ttlMs: rc.ttlMs ?? 5 * 60_000, maxEntries: rc.maxEntries ?? 2_000 },
        // Heuristic cache DISABLED by default after stress testing confirmed false positives.
        // Trigram similarity matches same-structure/different-entity questions at any threshold.
        // E.g. "Does TechFlow integrate with GitHub?" matches "Does TechFlow integrate with Jira?"
        // Safe to enable ONLY for near-identical text (copy-paste paraphrases).
        // True semantic caching (all-MiniLM-L6-v2 local embeddings) is planned for v0.2.
        semantic: { enabled: false, ttlMs: sc.ttlMs ?? 10 * 60_000, maxEntries: sc.maxEntries ?? 500, similarityThreshold: (sc as { similarityThreshold?: number }).similarityThreshold ?? 0.97 },
        plan:     { enabled: true, ttlMs: pc.ttlMs ?? 30 * 60_000, maxEntries: pc.maxEntries ?? 200 },
      },
      optimization: {
        compressPrompts:      false,
        pruneContext:         config.optimization?.pruneContext          ?? false,
        routeToCheapestModel: config.optimization?.routeToCheapestModel ?? false, // opt-in only
        filterToolSchemas:    (config.optimization as { filterToolSchemas?: boolean })?.filterToolSchemas ?? true,
      },
      pricing: config.pricing ?? {},
      labels:  config.labels  ?? {},
    };

    const rcf = this.config.cache.response as { ttlMs: number; maxEntries: number };
    const scf = this.config.cache.semantic as { ttlMs: number; maxEntries: number; similarityThreshold: number };
    const pcf = this.config.cache.plan     as { ttlMs: number; maxEntries: number };

    this.responseCache  = new ResponseCache({ ttlMs: rcf.ttlMs, maxEntries: rcf.maxEntries });
    this.semanticCache  = new SemanticCache({ ttlMs: scf.ttlMs, maxEntries: scf.maxEntries, similarityThreshold: scf.similarityThreshold });
    this.planCache      = new AgentPlanCache({ ttlMs: pcf.ttlMs, maxEntries: pcf.maxEntries });
    this.cacheOptimizer = new PromptCacheOptimizer(provider);
    this.costEngine     = new CostEngine(this.config.pricing, provider);
    this.router         = new ModelRouter();
    this.toolFilter     = new ToolSchemaFilter();
    this.pruner         = new ContextPruner({ provider: provider as string });
    this.attributor     = new TokenAttributor(provider as string);
    this.sessionLog     = new SessionLog();
    this.wasteReporter  = new WasteReporter();
  }

  // ─── Core intercept logic ─────────────────────────────────────────────────

  /**
   * Central intercept method called by every provider proxy.
   * request = our normalized LLMRequest
   * callFn  = the original provider SDK call (already bound, with optimized params)
   * Returns whatever the provider returns (raw SDK response).
   */
  async intercept(
    request: LLMRequest,
    callFn: (optimizedRequest: LLMRequest) => Promise<RawSdkResult>,
    isStreaming: boolean,
  ): Promise<RawSdkResult> {
    const requestId = generateRequestId();
    const startMs   = Date.now();

    // 1. Response cache check
    const cacheHit = this.responseCache.get(request);
    if (cacheHit) {
      const latencyMs = Date.now() - startMs;
      const entry = this.costEngine.record({ requestId, provider: this.provider, model: cacheHit.model, inputTokens: cacheHit.usage.inputTokens, outputTokens: cacheHit.usage.outputTokens, cached: true, cacheType: 'response', latencyMs, request, savings: cacheHit.cost });
      this.logSession(requestId, cacheHit.model, cacheHit.usage.inputTokens, cacheHit.usage.outputTokens, request, true, 'response', latencyMs, false, entry, 0);
      return (cacheHit as unknown as { _rawResponse: RawSdkResult })._rawResponse;
    }

    // 2. Semantic cache check — only when explicitly enabled
    const heuristicEnabled = (this.config.cache.semantic as { enabled?: boolean }).enabled === true;
    if (heuristicEnabled) {
      const semanticHit = await this.semanticCache.get(request);
      if (semanticHit) {
        const latencyMs = Date.now() - startMs;
        const entry = this.costEngine.record({ requestId, provider: this.provider, model: semanticHit.model, inputTokens: semanticHit.usage.inputTokens, outputTokens: semanticHit.usage.outputTokens, cached: true, cacheType: 'semantic', latencyMs, request, savings: semanticHit.cost });
        this.logSession(requestId, semanticHit.model, semanticHit.usage.inputTokens, semanticHit.usage.outputTokens, request, true, 'semantic', latencyMs, false, entry, 0);
        return (semanticHit as unknown as { _rawResponse: RawSdkResult })._rawResponse;
      }
    }

    // 3. Context management — rolling window capper + keyword pruner
    let optimized = { ...request };

    // Rolling window: keep only the last N non-system turns.
    // Simple, predictable, prevents O(N²) cost growth in agent loops.
    const maxTurns = (this.config.optimization as { maxHistoryTurns?: number }).maxHistoryTurns;
    if (maxTurns && maxTurns > 0) {
      const system    = optimized.messages.filter(m => m.role === 'system');
      const nonSystem = optimized.messages.filter(m => m.role !== 'system');
      const windowed  = nonSystem.slice(-maxTurns); // keep last N turns
      optimized = { ...optimized, messages: [...system, ...windowed] };
    }

    // Keyword-relevance pruner (off by default — opt-in for long conversations)
    if (this.config.optimization.pruneContext) {
      optimized = { ...optimized, messages: this.pruner.prune(optimized.messages).messages };
    }

    // 4. Tool schema filtering
    const filterTools = (this.config.optimization as { filterToolSchemas?: boolean }).filterToolSchemas !== false;
    if (filterTools && optimized.tools && optimized.tools.length >= 3) {
      const filtered = this.toolFilter.filter(optimized.tools, optimized.messages);
      if (filtered.tokensSaved > 0) optimized = { ...optimized, tools: filtered.tools };
    }

    // 5. Model routing
    let resolvedModel = optimized.model ?? this.config.defaultModel;
    if ((this.config.optimization as { routeToCheapestModel?: boolean }).routeToCheapestModel !== false) {
      const decision = this.router.route(optimized, resolvedModel, this.provider);
      if (decision.wasRouted) resolvedModel = decision.model;
    }
    // Always resolve the model that will actually be used — the cache
    // optimizer needs it (Claude Haiku 4.5 has a different cache threshold).
    optimized = { ...optimized, model: resolvedModel };

    // 6. Provider-native prompt caching
    const cacheOpt     = this.cacheOptimizer.optimize(optimized, this.provider);
    const nativeCache  = cacheOpt.cacheableTokens > 0;

    // 7. Live call
    const rawResponse = await callFn({ ...optimized, ...cacheOpt });
    const latencyMs   = Date.now() - startMs;

    // 8. Extract usage from raw response
    const usage = extractUsage(rawResponse, request, this);
    const pricing = this.costEngine.getPricing(resolvedModel);
    const cost    = this.costEngine.computeCost(usage.inputTokens, usage.outputTokens, pricing, usage.nativeCachedTokens);

    // 9. Store in caches (only if not streaming — streaming responses are cached post-completion)
    if (!isStreaming) {
      const cacheEntry = buildCacheEntry(rawResponse, resolvedModel, this.provider, requestId, latencyMs, cost, usage);
      this.responseCache.set(request, cacheEntry as unknown as import('../types/index.js').LLMResponse);
      await this.semanticCache.set(request, cacheEntry as unknown as import('../types/index.js').LLMResponse);
    }

    // 10. Record cost + attribution
    const entry = this.costEngine.record({ requestId, provider: this.provider, model: resolvedModel, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cached: false, cacheType: 'none', latencyMs, request, savings: 0, nativeCachedTokens: usage.nativeCachedTokens });
    this.logSession(requestId, resolvedModel, usage.inputTokens, usage.outputTokens, request, false, 'none', latencyMs, nativeCache, entry, usage.nativeCachedTokens);

    return rawResponse;
  }

  // ─── Pre-call optimization for streaming path ─────────────────────────────
  // Non-streaming calls get steps 3-6 via intercept(). The streaming path
  // calls cacheOptimizer.optimize() directly (step 6), so it was silently
  // skipping tool filtering (step 4) and model routing (step 5). Call this
  // before cacheOptimizer.optimize() in the streaming path to fill the gap.

  optimizePreCall(request: LLMRequest): LLMRequest {
    let optimized = { ...request };

    const maxTurns = (this.config.optimization as { maxHistoryTurns?: number }).maxHistoryTurns;
    if (maxTurns && maxTurns > 0) {
      const system    = optimized.messages.filter(m => m.role === 'system');
      const nonSystem = optimized.messages.filter(m => m.role !== 'system');
      optimized = { ...optimized, messages: [...system, ...nonSystem.slice(-maxTurns)] };
    }

    if (this.config.optimization.pruneContext) {
      optimized = { ...optimized, messages: this.pruner.prune(optimized.messages).messages };
    }

    const filterTools = (this.config.optimization as { filterToolSchemas?: boolean }).filterToolSchemas !== false;
    if (filterTools && optimized.tools && optimized.tools.length >= 3) {
      const filtered = this.toolFilter.filter(optimized.tools, optimized.messages);
      if (filtered.tokensSaved > 0) optimized = { ...optimized, tools: filtered.tools };
    }

    let resolvedModel = optimized.model ?? this.config.defaultModel;
    if ((this.config.optimization as { routeToCheapestModel?: boolean }).routeToCheapestModel !== false) {
      const decision = this.router.route(optimized, resolvedModel, this.provider);
      if (decision.wasRouted) resolvedModel = decision.model;
    }
    return { ...optimized, model: resolvedModel };
  }

  // ─── Streaming intercept ──────────────────────────────────────────────────

  async interceptStream(
    request: LLMRequest,
    callFn: (optimizedRequest: LLMRequest) => Promise<RawSdkResult>,
  ): Promise<RawSdkResult> {
    // For streaming: check cache first — if hit, caller handles the fake stream
    const cacheHit = this.responseCache.get(request);
    if (cacheHit) {
      return (cacheHit as unknown as { _rawResponse: RawSdkResult })._rawResponse;
    }

    // Cache miss: call through normally, collect content for future caching
    const stream = await this.intercept(request, callFn, true);
    return stream;
  }

  // ─── Reporting API ────────────────────────────────────────────────────────

  getCostReport(): CostReport     { return this.costEngine.getCostReport(); }
  getWasteReport(): WasteReport   { return this.wasteReporter.buildReport(this.costEngine.getEntries()); }
  getEnrichedWasteReport(): EnrichedWasteReport {
    return buildEnrichedWasteReport(
      this.sessionLog.getBuffer() as import('../types/index.js').SessionLogEntry[],
      this.costEngine.getCostReport(),
    );
  }
  printReport(): void             { printReport({ entries: this.sessionLog.getBuffer() }); }
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

  // ─── Cache key ────────────────────────────────────────────────────────────

  cacheKey(request: LLMRequest): string {
    return createHash('sha256')
      .update(JSON.stringify({ messages: request.messages, model: request.model ?? '', tools: request.tools ?? [] }))
      .digest('hex');
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private logSession(
    requestId: string, model: string,
    inputTokens: number, outputTokens: number,
    request: LLMRequest, cached: boolean, cacheType: string,
    latencyMs: number, nativeCache: boolean,
    costEntry: import('../types/index.js').CostEntry, nativeCachedTokens: number
  ): void {
    const pricing     = this.costEngine.getPricing(model);
    // Pass provider-reported inputTokens so attribution categories are rescaled to
    // match the real total rather than the 4-char/token heuristic estimate.
    const attribution = this.attributor.attribute(request, outputTokens, pricing, inputTokens > 0 ? inputTokens : undefined);
    const labels = (this.config as { labels?: Record<string, string> }).labels;
    this.sessionLog.write({
      timestamp: Date.now(), requestId, provider: this.provider, model, attribution,
      cached, cacheType, latencyMs, nativeCache,
      realInputTokens: inputTokens, realOutputTokens: outputTokens,
      nativeCachedTokens, realCost: costEntry.cost, realSavings: costEntry.savings,
      ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
    });
  }
}

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface RawSdkResult {
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractUsage(raw: RawSdkResult, request: LLMRequest, engine: TrimwareEngine): { inputTokens: number; outputTokens: number; nativeCachedTokens: number } {
  // OpenAI / Groq format
  const usage = raw['usage'] as Record<string, number> | undefined;
  if (usage?.['prompt_tokens']) {
    return { inputTokens: usage['prompt_tokens'], outputTokens: usage['completion_tokens'] ?? 0, nativeCachedTokens: 0 };
  }
  // Anthropic format — cache_creation_input_tokens are billed at full input
  // rate (folded into inputTokens); cache_read_input_tokens are billed at the
  // discounted cachedInputPerMillion rate.
  if (usage?.['input_tokens']) {
    const cacheWriteTokens = usage['cache_creation_input_tokens'] ?? 0;
    const cacheReadTokens  = usage['cache_read_input_tokens'] ?? 0;
    return {
      inputTokens: usage['input_tokens'] + cacheWriteTokens,
      outputTokens: usage['output_tokens'] ?? 0,
      nativeCachedTokens: cacheReadTokens,
    };
  }
  // Gemini / unknown: estimate
  const counter = engine.attributor;
  const inputTokens  = (counter as unknown as { counter: { countMessages: (m: LLMRequest['messages']) => number } }).counter?.countMessages?.(request.messages) ?? 100;
  const outputTokens = Math.ceil(inputTokens * 0.2);
  return { inputTokens, outputTokens, nativeCachedTokens: 0 };
}

function buildCacheEntry(
  raw: RawSdkResult, model: string, provider: ProviderName,
  requestId: string, latencyMs: number, cost: number,
  usage: { inputTokens: number; outputTokens: number; nativeCachedTokens: number }
): Record<string, unknown> {
  return {
    content: extractContent(raw),
    model,
    provider,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.nativeCachedTokens, totalTokens: usage.inputTokens + usage.outputTokens },
    cost, savings: 0, cached: false, cacheType: 'none' as CacheType,
    requestId, latencyMs,
    _rawResponse: raw, // stored so cache hits can return the original format
  };
}

function extractContent(raw: RawSdkResult): string {
  // OpenAI
  const choices = raw['choices'] as Array<{ message?: { content?: string } }> | undefined;
  if (choices?.[0]?.message?.content) return choices[0].message.content;
  // Anthropic
  const content = raw['content'] as Array<{ type: string; text?: string }> | undefined;
  if (Array.isArray(content)) return content.find(b => b.type === 'text')?.text ?? '';
  return '';
}
