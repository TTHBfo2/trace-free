// ─── Token Attribution ────────────────────────────────────────────────────────

export interface TokenCategory {
  tokens: number;
  estimatedCost: number;
  percentOfTotal: number;
}

export interface AttributionBreakdown {
  systemPrompt: TokenCategory;
  toolSchemas: TokenCategory;
  ragChunks: TokenCategory;
  conversationHistory: TokenCategory;
  userQuery: TokenCategory;
  outputTokens: TokenCategory;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export interface AttributedRequest {
  attribution: AttributionBreakdown;
  cacheableTokens: number;        // tokens that can be provider-cached
  cacheableCostSaving: number;    // estimated savings if cached (90% of cacheable cost)
}

// ─── Provider-Native Cache ────────────────────────────────────────────────────

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface CacheOptimizationResult {
  messages: LLMMessage[];
  tools?: LLMTool[];
  anthropicSystemBlocks?: AnthropicSystemBlock[];  // replaces system string for Anthropic
  cacheableTokens: number;
  provider: ProviderName;
}

// ─── Session Log Entry (metadata only — no prompt content ever) ───────────────

export interface SessionLogEntry {
  timestamp: number;
  requestId: string;
  provider: ProviderName;
  model: string;
  attribution: AttributionBreakdown;
  cached: boolean;
  cacheType: string;
  latencyMs: number;
  nativeCache: boolean;          // whether provider-native caching was applied
  // Real billed numbers from CostEngine — derived from actual provider
  // usage tokens, not the heuristic character-count attribution above.
  realInputTokens: number;
  realOutputTokens: number;
  nativeCachedTokens: number;    // cache_read_input_tokens (or equivalent), billed at the discounted rate
  realCost: number;              // actual cost of this request (0 if served from response cache)
  realSavings: number;           // cost avoided: full cost if response-cache hit, else native-cache discount
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'ollama' | 'azure' | 'deepseek' | 'openrouter' | 'mistral' | 'custom';

// ─── Messages & Requests ──────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: LLMTool[];
  agentPlanId?: string;
  metadata?: Record<string, unknown>;
}

// ─── Responses ────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export type CacheType = 'response' | 'semantic' | 'plan' | 'none';

export interface LLMResponse {
  content: string;
  model: string;
  provider: ProviderName;
  usage: TokenUsage;
  cost: number;
  savings: number;
  cached: boolean;
  cacheType: CacheType;
  requestId: string;
  latencyMs: number;
  toolCalls?: LLMToolCall[];
}

// ─── Cost Tracking ────────────────────────────────────────────────────────────

export type WasteFlag =
  | 'redundant_request'
  | 'stale_context'
  | 'oversized_context'
  | 'premium_for_simple'
  | 'missed_cache_hit';

export interface CostEntry {
  timestamp: number;
  requestId: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  savings: number;
  cached: boolean;
  cacheType: CacheType;
  wasteFlags: WasteFlag[];
  latencyMs: number;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

export interface ProviderCostSummary {
  totalCost: number;
  totalSavings: number;
  requestCount: number;
  cachedCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelCostSummary extends ProviderCostSummary {
  provider: ProviderName;
}

// ─── Enriched Waste Intelligence ─────────────────────────────────────────────

export interface WasteCategory {
  label:                  string;
  tokens:                 number;
  cost:                   number;
  percentOfSpend:         number;
  severity:               'critical' | 'warning' | 'info' | 'good';
  fix?:                   string;          // config key to apply
  fixDescription?:        string;          // what applying the fix does
  projectedMonthlySaving?: number;         // estimated if fix applied
}

/**
 * Enriched waste report — dollar-denominated breakdown by waste category.
 * This is what the CLI and dashboard both consume.
 * Free tier: current session data.
 * Pro tier: 30/90-day history of the same structure.
 */
export interface EnrichedWasteReport {
  totalGrossSpend:     number;   // what you would have spent without any optimization
  alreadySaved:        number;   // what response cache already saved this session
  currentSpend:        number;   // what you actually spent
  recoverableSpend:    number;   // additional recoverable with further optimization
  recoverablePercent:  number;   // recoverableSpend / currentSpend

  categories: {
    unusedToolSchemas:  WasteCategory;  // tool defs sent when not used
    redundantRAGChunks: WasteCategory;  // retrieved docs sent repeatedly
    staleContext:       WasteCategory;  // old conversation history
    repeatedPrompts:    WasteCategory;  // already-seen questions (cache hits)
    overpoweredModel:   WasteCategory;  // expensive model on simple tasks
    genuineWork:        WasteCategory;  // tokens that had to be sent — not waste
  };

  topFix:          WasteCategory | null;  // highest-ROI action right now
  sessionRequests: number;
  generatedAt:     number;
}

// ─── Reports ──────────────────────────────────────────────────────────────────

export interface CostReport {
  totalCost: number;
  totalSavings: number;
  savingsPercent: number;
  totalRequests: number;
  cachedRequests: number;
  cacheHitRate: number;
  byProvider: Record<string, ProviderCostSummary>;
  byModel: Record<string, ModelCostSummary>;
  timeRange: { start: number; end: number };
  generatedAt: number;
  dashboardHint?: string;
}

export interface WasteSummaryByType {
  count: number;
  estimatedCost: number;
  examples: string[];
}

export interface WasteEntry {
  requestId: string;
  timestamp: number;
  flags: WasteFlag[];
  estimatedWaste: number;
  model: string;
  provider: ProviderName;
}

export interface WasteReport {
  totalWaste: number;
  totalRequests: number;
  wastePercent: number;
  byType: Partial<Record<WasteFlag, WasteSummaryByType>>;
  topWasteDrivers: WasteEntry[];
  recommendations: string[];
  timeRange: { start: number; end: number };
  generatedAt: number;
}

// ─── Agentic Plan Cache ───────────────────────────────────────────────────────

export interface AgentStep {
  stepIndex: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reasoning?: string;
}

export interface AgentPlan {
  planId: string;
  taskHash: string;
  steps: AgentStep[];
  createdAt: number;
  hitCount: number;
  lastUsedAt: number;
  provider: ProviderName;
  model: string;
  estimatedTokensSaved: number;
}

// ─── Cache Stats ──────────────────────────────────────────────────────────────

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  sizeBytes: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface CacheLayerConfig {
  enabled?: boolean;
  ttlMs?: number;
  maxEntries?: number;
}

export interface SemanticCacheConfig extends CacheLayerConfig {
  similarityThreshold?: number;
}

export interface TrimmerConfig {
  provider?: ProviderName;
  defaultModel?: string;
  cache?: {
    response?: CacheLayerConfig;
    semantic?: SemanticCacheConfig;
    plan?: CacheLayerConfig;
  };
  optimization?: {
    compressPrompts?: boolean;
    pruneContext?: boolean;
    /**
     * Rolling window: keep only the last N conversation turns (non-system messages).
     * Simple and predictable — prevents O(N²) context cost growth in agent loops.
     * Keeps system message + last N turns. Default: undefined (off).
     * Recommended for agent workflows: maxHistoryTurns: 10
     */
    maxHistoryTurns?: number;
    /**
     * Automatically route simple requests (< 400 tokens, no tools, no complex keywords)
     * to the cheapest capable model on the same provider.
     * Conservative: only routes when confident the request is simple.
     * Default: false (opt-in — developer chose their model intentionally)
     */
    routeToCheapestModel?: boolean;
    /**
     * Filter tool schemas to only include tools relevant to the current agent step.
     * Only activates when a request has ≥ 3 tools. Conservative: falls back to full
     * schema if fewer than 2 tools match.
     * Default: true
     */
    filterToolSchemas?: boolean;
  };
  pricing?: Partial<Record<string, ModelPricing>>;
}
