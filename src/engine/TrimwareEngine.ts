import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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
import { ErrorLog }   from '../telemetry/ErrorLog.js';
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
  readonly errorLog:       ErrorLog;
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

    // Pro feature soft gate: Router and Pruner require an active Pro license.
    // Reads ~/.trimwares/config.json synchronously (small file, one-time per engine).
    const opt = this.config.optimization as Record<string, unknown>;
    if (opt['routeToCheapestModel'] === true || opt['pruneContext'] === true) {
      if (!checkProLicense()) {
        if (opt['routeToCheapestModel']) {
          console.warn('\n  \x1b[33m⚠  [trimwares] Model Router requires a Pro license — routing disabled.\x1b[0m');
          console.warn('  Upgrade at \x1b[36mtrimwares.com/pro\x1b[0m\n');
          opt['routeToCheapestModel'] = false;
        }
        if (opt['pruneContext']) {
          console.warn('\n  \x1b[33m⚠  [trimwares] Context Pruner requires a Pro license — pruning disabled.\x1b[0m');
          console.warn('  Upgrade at \x1b[36mtrimwares.com/pro\x1b[0m\n');
          opt['pruneContext'] = false;
        }
      }
    }

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
    this.errorLog       = new ErrorLog();
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
      // The prompt this hit avoided sending is the WHOLE original prompt:
      // usage.inputTokens is only its uncached remainder, usage.cachedTokens
      // the rest. Attributing the remainder alone under-reported a replayed
      // hit of a mostly-cached request to a fraction of its real size.
      // nativeCachedTokens stays 0: nothing reached the provider, so no
      // provider discount was earned on THIS request.
      const hitPrompt = cacheHit.usage.inputTokens + (cacheHit.usage.cachedTokens ?? 0);
      const entry = this.costEngine.record({ requestId, provider: this.provider, model: cacheHit.model, inputTokens: hitPrompt, outputTokens: cacheHit.usage.outputTokens, cached: true, cacheType: 'response', latencyMs, request, savings: cacheHit.cost });
      this.logSession(requestId, cacheHit.model, hitPrompt, cacheHit.usage.outputTokens, request, true, 'response', latencyMs, false, entry, 0);
      return (cacheHit as unknown as { _rawResponse: RawSdkResult })._rawResponse;
    }

    // 2. Semantic cache check — only when explicitly enabled
    const heuristicEnabled = (this.config.cache.semantic as { enabled?: boolean }).enabled === true;
    if (heuristicEnabled) {
      const semanticHit = await this.semanticCache.get(request);
      if (semanticHit) {
        const latencyMs = Date.now() - startMs;
        const hitPrompt = semanticHit.usage.inputTokens + (semanticHit.usage.cachedTokens ?? 0);
        const entry = this.costEngine.record({ requestId, provider: this.provider, model: semanticHit.model, inputTokens: hitPrompt, outputTokens: semanticHit.usage.outputTokens, cached: true, cacheType: 'semantic', latencyMs, request, savings: semanticHit.cost });
        this.logSession(requestId, semanticHit.model, hitPrompt, semanticHit.usage.outputTokens, request, true, 'semantic', latencyMs, false, entry, 0);
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
    const cacheOpt = this.cacheOptimizer.optimize(optimized, this.provider);
    // ELIGIBILITY only — "this prompt is big enough to be worth caching". It is
    // a prediction made before the call, not a record of a discount. It drives
    // recommendations ("you could enable caching"); it must never be used to
    // claim caching happened. Whether it actually happened is known only after
    // the response comes back, as usage.nativeCachedTokens > 0 below.
    const nativeCacheEligible = cacheOpt.cacheableTokens > 0;

    // 7. Live call
    let rawResponse: RawSdkResult;
    try {
      rawResponse = await callFn({ ...optimized, ...cacheOpt });
    } catch (err) {
      this.errorLog.write({
        timestamp: Date.now(),
        provider:  this.provider,
        model:     resolvedModel,
        error:     err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startMs,
      });
      throw err;
    }
    const latencyMs = Date.now() - startMs;

    // 8. Extract usage from raw response
    const usage = extractUsage(rawResponse, request, this);
    const pricing = this.costEngine.getPricing(resolvedModel);
    const cost    = this.costEngine.computeCost(usage.inputTokens, usage.outputTokens, pricing, usage.nativeCachedTokens);

    // 9. Store in caches (only if not streaming — streaming responses are cached post-completion)
    if (!isStreaming) {
      const cacheEntry = buildCacheEntry(rawResponse, resolvedModel, this.provider, requestId, latencyMs, cost, usage);
      this.responseCache.set(request, cacheEntry as unknown as import('../types/index.js').LLMResponse);
      if (this.config.cache.semantic?.enabled) {
        await this.semanticCache.set(request, cacheEntry as unknown as import('../types/index.js').LLMResponse);
      }
    }

    // 10. Record cost + attribution
    const entry = this.costEngine.record({ requestId, provider: this.provider, model: resolvedModel, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cached: false, cacheType: 'none', latencyMs, request, savings: 0, nativeCachedTokens: usage.nativeCachedTokens });
    // nativeCache records what the PROVIDER did, never what we predicted.
    // `nativeCacheEligible` is kept separately for the recommendation engine.
    this.logSession(requestId, resolvedModel, usage.inputTokens, usage.outputTokens, request, false, 'none', latencyMs, usage.nativeCachedTokens > 0, entry, usage.nativeCachedTokens, nativeCacheEligible);

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
    costEntry: import('../types/index.js').CostEntry, nativeCachedTokens: number,
    nativeCacheEligible = false
  ): void {
    const pricing     = this.costEngine.getPricing(model);
    // Pass provider-reported inputTokens so attribution categories are rescaled to
    // match the real total rather than the 4-char/token heuristic estimate.
    //
    // This must be the WHOLE prompt the provider processed — cached tokens
    // included. `inputTokens` here is only the uncached remainder (see
    // extractUsage), so the cached portion is added back. Without this the
    // breakdown is scaled to a fraction of the prompt: after the cache warmed,
    // a 4,902-token request rescaled to 166 and under-reported every category.
    const promptTokens = inputTokens + nativeCachedTokens;
    const attribution = this.attributor.attribute(request, outputTokens, pricing, promptTokens > 0 ? promptTokens : undefined);
    const labels = (this.config as { labels?: Record<string, string> }).labels;
    this.sessionLog.write({
      timestamp: Date.now(), requestId, provider: this.provider, model, attribution,
      cached, cacheType, latencyMs, nativeCache, nativeCacheEligible,
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
  // OpenAI / Groq format.
  //
  // `prompt_tokens_details.cached_tokens` is OpenAI's automatic prompt cache:
  // any prefix over ~1024 tokens is cached without opt-in, and those tokens are
  // billed at a discount (50% on the 4o family, 75% on 4.1). This used to be
  // hardcoded to 0, which meant every OpenAI user's cached tokens were priced at
  // the full input rate and `realSavings` was always 0 — Trace over-reported
  // their spend. Measured 2026-09-28: a 4,901-token prompt came back with 4,736
  // cached tokens, ~97% of the prompt, and Trace recorded none of it.
  //
  // Groq shares this branch and has no prompt cache, so it never sends the
  // field; the ?? 0 covers that without needing to branch on provider.
  // CAREFUL — the two providers scope these differently, and conflating them
  // double-bills. OpenAI's `prompt_tokens` is the TOTAL prompt and
  // `cached_tokens` is a SUBSET of it. Anthropic's `input_tokens` EXCLUDES
  // `cache_read_input_tokens`. CostEngine.computeCost() adds the two together
  // (uncached at full rate + cached at the discounted rate), so this function's
  // contract is Anthropic-shaped: `inputTokens` must be the NON-cached portion.
  // Hence the subtraction here. Passing OpenAI's raw prompt_tokens alongside
  // cached_tokens would charge the cached tokens twice.
  const usage = raw['usage'] as Record<string, unknown> | undefined;
  if (typeof usage?.['prompt_tokens'] === 'number') {
    const promptTokens = usage['prompt_tokens'] as number;
    const details      = usage['prompt_tokens_details'] as { cached_tokens?: number } | undefined;
    const cached       = Math.min(details?.cached_tokens ?? 0, promptTokens); // clamp: never negative input
    return {
      inputTokens: promptTokens - cached,
      outputTokens: (usage['completion_tokens'] as number) ?? 0,
      nativeCachedTokens: cached,
    };
  }
  // Anthropic format — cache_creation_input_tokens are billed at full input
  // rate (folded into inputTokens); cache_read_input_tokens are billed at the
  // discounted cachedInputPerMillion rate.
  if (typeof usage?.['input_tokens'] === 'number') {
    const num = (k: string): number => (typeof usage[k] === 'number' ? usage[k] as number : 0);
    const cacheWriteTokens = num('cache_creation_input_tokens');
    const cacheReadTokens  = num('cache_read_input_tokens');
    return {
      inputTokens: (usage['input_tokens'] as number) + cacheWriteTokens,
      outputTokens: num('output_tokens'),
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

function checkProLicense(): boolean {
  try {
    const cfgPath = join(homedir(), '.trimwares', 'config.json');
    if (!existsSync(cfgPath)) return false;
    const data = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    return ['pro', 'team', 'enterprise'].includes(data['tier'] as string);
  } catch { return false; }
}
