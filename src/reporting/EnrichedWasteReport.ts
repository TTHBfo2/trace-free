import {
  EnrichedWasteReport, WasteCategory,
  CostReport,
} from '../types/index.js';
import { SessionLogEntry } from '../types/index.js';

// Conservative recovery rates — what we can realistically save with each fix
const RECOVERY = {
  toolSchemas:  0.90,   // Anthropic cache_control or per-step filtering
  ragChunks:    0.90,   // Provider-native prefix caching on stable docs
  history:      0.65,   // Context pruning / rolling window cap
  systemPrompt: 0.85,   // Provider-native caching (when >= 1024 tokens)
};

export function buildEnrichedWasteReport(
  entries: SessionLogEntry[],
  costReport: CostReport,
): EnrichedWasteReport {

  if (entries.length === 0) return emptyReport();

  // ── Aggregate attribution from live (non-cached) requests ─────────────────
  let toolSchemaCost    = 0; let toolSchemaTokens    = 0;
  let ragChunkCost      = 0; let ragChunkTokens      = 0;
  let historyCost       = 0; let historyTokens       = 0;
  let systemPromptCost  = 0;
  let userQueryCost     = 0; let userQueryTokens     = 0;
  let outputCost        = 0; let outputTokens        = 0;

  for (const e of entries) {
    if (e.cached) continue;  // cached entries already at $0, skip for waste calc
    const a = e.attribution;
    toolSchemaCost   += a.toolSchemas.estimatedCost;   toolSchemaTokens   += a.toolSchemas.tokens;
    ragChunkCost     += a.ragChunks.estimatedCost;     ragChunkTokens     += a.ragChunks.tokens;
    historyCost      += a.conversationHistory.estimatedCost; historyTokens += a.conversationHistory.tokens;
    systemPromptCost += a.systemPrompt.estimatedCost;
    userQueryCost    += a.userQuery.estimatedCost;     userQueryTokens    += a.userQuery.tokens;
    outputCost       += a.outputTokens.estimatedCost;  outputTokens       += a.outputTokens.tokens;
  }

  // ── Overpowered model heuristic ───────────────────────────────────────────
  // Count requests flagged as premium_for_simple by WasteDetector
  const overpoweredRequests = entries.filter(
    e => !e.cached && (e as unknown as { wasteFlags?: string[] }).wasteFlags?.includes('premium_for_simple')
  ).length;
  const overpoweredModelCost = overpoweredRequests > 0
    ? costReport.totalCost * (overpoweredRequests / Math.max(costReport.totalRequests - costReport.cachedRequests, 1)) * 0.80
    : 0;

  // ── Build totals ──────────────────────────────────────────────────────────
  const alreadySaved      = costReport.totalSavings;
  const currentSpend      = costReport.totalCost;
  const totalGrossSpend   = currentSpend + alreadySaved;
  const totalAllCost      = toolSchemaCost + ragChunkCost + historyCost + systemPromptCost
                           + userQueryCost + outputCost + overpoweredModelCost;

  const pct = (cost: number) => totalAllCost > 0
    ? parseFloat(((cost / totalAllCost) * 100).toFixed(1))
    : 0;

  // ── Recoverable amounts ───────────────────────────────────────────────────
  const recoverableTool    = toolSchemaCost    * RECOVERY.toolSchemas;
  const recoverableRAG     = ragChunkCost      * RECOVERY.ragChunks;
  const recoverableHistory = historyCost       * RECOVERY.history;
  const recoverableSystem  = systemPromptCost  * RECOVERY.systemPrompt;
  const totalRecoverable   = recoverableTool + recoverableRAG + recoverableHistory + recoverableSystem;

  const genuineWork: WasteCategory = {
    label:          'Genuine work',
    tokens:         userQueryTokens + outputTokens,
    cost:           userQueryCost + outputCost,
    percentOfSpend: pct(userQueryCost + outputCost),
    severity:       'good',
  };

  const unusedToolSchemas: WasteCategory = {
    label:          'Unused tool schemas',
    tokens:         toolSchemaTokens,
    cost:           toolSchemaCost,
    percentOfSpend: pct(toolSchemaCost),
    severity:       toolSchemaCost > currentSpend * 0.10 ? 'critical' : 'warning',
    fix:            'filterToolSchemas: true  +  Anthropic cache_control',
    fixDescription: 'Only send tools relevant to current step, then cache the schema prefix',
    projectedMonthlySaving: recoverableTool * 30,
  };

  const redundantRAGChunks: WasteCategory = {
    label:          'Redundant RAG chunks',
    tokens:         ragChunkTokens,
    cost:           ragChunkCost,
    percentOfSpend: pct(ragChunkCost),
    severity:       ragChunkCost > currentSpend * 0.15 ? 'critical' : ragChunkCost > 0 ? 'warning' : 'info',
    fix:            'Provider-native prompt caching on stable documents',
    fixDescription: 'Cache stable document prefixes — same docs retrieved repeatedly cost 90% less',
    projectedMonthlySaving: recoverableRAG * 30,
  };

  const staleContext: WasteCategory = {
    label:          'Stale conversation history',
    tokens:         historyTokens,
    cost:           historyCost,
    percentOfSpend: pct(historyCost),
    severity:       historyCost > currentSpend * 0.15 ? 'warning' : 'info',
    fix:            'maxHistoryTurns: 10',
    fixDescription: 'Rolling window keeps last 10 turns — older context stops accumulating',
    projectedMonthlySaving: recoverableHistory * 30,
  };

  const repeatedPrompts: WasteCategory = {
    label:          'Repeated prompts (already saved)',
    tokens:         0,
    cost:           alreadySaved,
    percentOfSpend: totalGrossSpend > 0 ? parseFloat(((alreadySaved / totalGrossSpend) * 100).toFixed(1)) : 0,
    severity:       'good',
    fixDescription: 'Response cache is active — identical questions served at $0',
  };

  const overpoweredModel: WasteCategory = {
    label:          'Overpowered model',
    tokens:         0,
    cost:           overpoweredModelCost,
    percentOfSpend: pct(overpoweredModelCost),
    severity:       overpoweredModelCost > currentSpend * 0.10 ? 'warning' : 'info',
    fix:            'routeToCheapestModel: true',
    fixDescription: 'Route simple requests to GPT-4o-mini or Claude Haiku — 94% cheaper per call',
    projectedMonthlySaving: overpoweredModelCost * 0.90 * 30,
  };

  // ── Top fix = highest projected monthly saving ────────────────────────────
  const fixable = [unusedToolSchemas, redundantRAGChunks, staleContext, overpoweredModel]
    .filter(c => (c.projectedMonthlySaving ?? 0) > 0)
    .sort((a, b) => (b.projectedMonthlySaving ?? 0) - (a.projectedMonthlySaving ?? 0));

  return {
    totalGrossSpend,
    alreadySaved,
    currentSpend,
    recoverableSpend:    totalRecoverable,
    recoverablePercent:  currentSpend > 0
      ? parseFloat(((totalRecoverable / currentSpend) * 100).toFixed(1))
      : 0,
    categories: {
      unusedToolSchemas,
      redundantRAGChunks,
      staleContext,
      repeatedPrompts,
      overpoweredModel,
      genuineWork,
    },
    topFix:          fixable[0] ?? null,
    sessionRequests: entries.length,
    generatedAt:     Date.now(),
  };
}

function emptyReport(): EnrichedWasteReport {
  const empty: WasteCategory = { label: '', tokens: 0, cost: 0, percentOfSpend: 0, severity: 'info' };
  return {
    totalGrossSpend: 0, alreadySaved: 0, currentSpend: 0,
    recoverableSpend: 0, recoverablePercent: 0,
    categories: {
      unusedToolSchemas: empty, redundantRAGChunks: empty, staleContext: empty,
      repeatedPrompts: empty, overpoweredModel: empty, genuineWork: empty,
    },
    topFix: null, sessionRequests: 0, generatedAt: Date.now(),
  };
}
