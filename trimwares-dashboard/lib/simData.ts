import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// Path to the llm-cost-trimmer package simulation results
// Adjust TRIMWARES_PKG_PATH if your folder structure differs
const TRIMWARES_PKG_PATH = resolve(process.cwd(), '../llm-cost-trimmer');
const SIM_DIR            = join(TRIMWARES_PKG_PATH, 'simulation-results');
const SESSION_LOG        = join(TRIMWARES_PKG_PATH, '.trimwares', 'session.jsonl');

// ─── Simulation result types (matches runner.ts output) ──────────────────────

export interface SimAttributionBreakdown {
  tokens:         number;
  percentOfTotal: number;
}

export interface SimScenarioResult {
  name:                string;
  description:         string;
  totalRequests:       number;
  cacheHitRate:        number;
  totalCostUsd:        number;
  totalSavingsUsd:     number;
  savingsPercent:      number;
  avgLatencyMs:        number;
  attributionBreakdown: {
    systemPrompt:        SimAttributionBreakdown;
    toolSchemas:         SimAttributionBreakdown;
    ragChunks:           SimAttributionBreakdown;
    conversationHistory: SimAttributionBreakdown;
    userQuery:           SimAttributionBreakdown;
    outputTokens:        SimAttributionBreakdown;
  };
  providerCallCount: number;
  nativeCacheApplied: boolean;
}

// ─── Session log entry type (matches SessionLog output) ──────────────────────

export interface SessionEntry {
  timestamp:   number;
  requestId:   string;
  provider:    string;
  model:       string;
  cached:      boolean;
  cacheType:   string;
  latencyMs:   number;
  nativeCache: boolean;
  attribution: {
    systemPrompt:        { tokens: number; estimatedCost: number; percentOfTotal: number };
    toolSchemas:         { tokens: number; estimatedCost: number; percentOfTotal: number };
    ragChunks:           { tokens: number; estimatedCost: number; percentOfTotal: number };
    conversationHistory: { tokens: number; estimatedCost: number; percentOfTotal: number };
    userQuery:           { tokens: number; estimatedCost: number; percentOfTotal: number };
    outputTokens:        { tokens: number; estimatedCost: number; percentOfTotal: number };
    totalInputTokens:    number;
    totalOutputTokens:   number;
    totalCost:           number;
  };
}

// ─── Data loaders ─────────────────────────────────────────────────────────────

export function loadLatestSimulation(): SimScenarioResult[] | null {
  if (!existsSync(SIM_DIR)) return null;
  try {
    const files = readdirSync(SIM_DIR)
      .filter(f => f.startsWith('simulation-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const raw = readFileSync(join(SIM_DIR, files[0]), 'utf8');
    return JSON.parse(raw) as SimScenarioResult[];
  } catch { return null; }
}

export function loadSessionEntries(limit = 500): SessionEntry[] {
  if (!existsSync(SESSION_LOG)) return [];
  try {
    return readFileSync(SESSION_LOG, 'utf8')
      .split('\n').filter(Boolean).slice(-limit)
      .flatMap(l => { try { return [JSON.parse(l) as SessionEntry]; } catch { return []; } });
  } catch { return []; }
}

// ─── Enriched waste report ────────────────────────────────────────────────────

export interface WasteCategoryData {
  label:                  string;
  cost:                   number;
  percentOfSpend:         number;
  severity:               'critical' | 'warning' | 'info' | 'good';
  fixDescription?:        string;
  projectedMonthlySaving?: number;
}

export interface DerivedWasteReport {
  totalGrossSpend:    number;
  alreadySaved:       number;
  currentSpend:       number;
  recoverableSpend:   number;
  recoverablePercent: number;
  categories:         WasteCategoryData[];
  topFix:             WasteCategoryData | null;
  sessionRequests:    number;
}

export function deriveWasteReport(entries: SessionEntry[]): DerivedWasteReport {
  if (entries.length === 0) {
    return { totalGrossSpend: 0, alreadySaved: 0, currentSpend: 0, recoverableSpend: 0, recoverablePercent: 0, categories: [], topFix: null, sessionRequests: 0 };
  }
  let toolSchemaCost = 0, ragChunkCost = 0, historyCost = 0;
  let systemPromptCost = 0, userQueryCost = 0, outputCost = 0, alreadySaved = 0;
  for (const e of entries) {
    if (e.cached) { alreadySaved += e.attribution.totalCost; continue; }
    const a = e.attribution;
    toolSchemaCost   += a.toolSchemas.estimatedCost;
    ragChunkCost     += a.ragChunks.estimatedCost;
    historyCost      += a.conversationHistory.estimatedCost;
    systemPromptCost += a.systemPrompt.estimatedCost;
    userQueryCost    += a.userQuery.estimatedCost;
    outputCost       += a.outputTokens.estimatedCost;
  }
  const currentSpend    = toolSchemaCost + ragChunkCost + historyCost + systemPromptCost + userQueryCost + outputCost;
  const totalGrossSpend = currentSpend + alreadySaved;
  const gross           = totalGrossSpend || 1;
  const pct             = (c: number) => parseFloat(((c / gross) * 100).toFixed(1));
  const recoverableTool = toolSchemaCost * 0.90, recoverableRAG = ragChunkCost * 0.90;
  const recoverableHistory = historyCost * 0.65, recoverableSystem = systemPromptCost * 0.85;
  const totalRecoverable = recoverableTool + recoverableRAG + recoverableHistory + recoverableSystem;
  type Sev = WasteCategoryData['severity'];
  const cats: WasteCategoryData[] = [
    { label: 'Unused tool schemas',         cost: toolSchemaCost,  percentOfSpend: pct(toolSchemaCost),  severity: (toolSchemaCost > currentSpend * 0.10 ? 'critical' : 'warning') as Sev, fixDescription: 'Cache tool schema prefix or filter per-step', projectedMonthlySaving: recoverableTool * 30 },
    { label: 'Redundant RAG chunks',         cost: ragChunkCost,    percentOfSpend: pct(ragChunkCost),    severity: (ragChunkCost > currentSpend * 0.15 ? 'critical' : ragChunkCost > 0 ? 'warning' : 'info') as Sev, fixDescription: 'Provider-native prefix caching on stable docs', projectedMonthlySaving: recoverableRAG * 30 },
    { label: 'Stale conversation history',   cost: historyCost,     percentOfSpend: pct(historyCost),     severity: (historyCost > currentSpend * 0.15 ? 'warning' : 'info') as Sev, fixDescription: 'maxHistoryTurns: 10 rolling window', projectedMonthlySaving: recoverableHistory * 30 },
    { label: 'System prompts (cacheable)',   cost: systemPromptCost, percentOfSpend: pct(systemPromptCost), severity: (systemPromptCost > currentSpend * 0.20 ? 'warning' : 'info') as Sev, fixDescription: 'Anthropic cache_control on stable instructions', projectedMonthlySaving: recoverableSystem * 30 },
    { label: 'Repeated prompts ✓ saved',     cost: alreadySaved,    percentOfSpend: pct(alreadySaved),    severity: 'good' as Sev, fixDescription: 'Response cache active — identical questions at $0' },
    { label: 'Genuine work',                 cost: userQueryCost + outputCost, percentOfSpend: pct(userQueryCost + outputCost), severity: 'good' as Sev, fixDescription: 'User queries + output — cannot be reduced' },
  ].filter(c => c.cost > 0);
  const topFix = [...cats].filter(c => c.severity !== 'good' && (c.projectedMonthlySaving ?? 0) > 0).sort((a, b) => (b.projectedMonthlySaving ?? 0) - (a.projectedMonthlySaving ?? 0))[0] ?? null;
  return { totalGrossSpend, alreadySaved, currentSpend, recoverableSpend: totalRecoverable, recoverablePercent: currentSpend > 0 ? parseFloat(((totalRecoverable / currentSpend) * 100).toFixed(1)) : 0, categories: cats, topFix, sessionRequests: entries.length };
}

// ─── Derived aggregates ───────────────────────────────────────────────────────

export interface AggregatedAttribution {
  systemPrompt:        number;
  toolSchemas:         number;
  ragChunks:           number;
  conversationHistory: number;
  userQuery:           number;
  outputTokens:        number;
  total:               number;
}

export function aggregateSessionAttribution(entries: SessionEntry[]): AggregatedAttribution {
  const agg: AggregatedAttribution = { systemPrompt: 0, toolSchemas: 0, ragChunks: 0, conversationHistory: 0, userQuery: 0, outputTokens: 0, total: 0 };
  for (const e of entries) {
    agg.systemPrompt        += e.attribution.systemPrompt.tokens;
    agg.toolSchemas         += e.attribution.toolSchemas.tokens;
    agg.ragChunks           += e.attribution.ragChunks.tokens;
    agg.conversationHistory += e.attribution.conversationHistory.tokens;
    agg.userQuery           += e.attribution.userQuery.tokens;
    agg.outputTokens        += e.attribution.outputTokens.tokens;
    agg.total               += e.attribution.totalInputTokens + e.attribution.totalOutputTokens;
  }
  return agg;
}

export function aggregateSessionCost(entries: SessionEntry[]): {
  totalCost: number; totalSaved: number; cacheHitRate: number; byModel: Record<string, number>;
} {
  let totalCost = 0; let cached = 0;
  const byModel: Record<string, number> = {};
  for (const e of entries) {
    totalCost += e.attribution.totalCost;
    if (e.cached) cached++;
    byModel[e.model] = (byModel[e.model] ?? 0) + e.attribution.totalCost;
  }
  return {
    totalCost,
    totalSaved:    0, // session log doesn't track savings directly
    cacheHitRate:  entries.length > 0 ? (cached / entries.length) * 100 : 0,
    byModel,
  };
}
