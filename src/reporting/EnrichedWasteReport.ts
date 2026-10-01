import {
  EnrichedWasteReport, WasteCategory,
  CostReport,
} from '../types/index.js';
import { SessionLogEntry } from '../types/index.js';

// Conservative recovery rates — what we can realistically save with each fix
// WITHHELD. These flat rates predate per-model cached-input pricing, and a 90%
// tool-schema rate is not evidence those schemas are unnecessary. They are kept
// only because the severity thresholds below were calibrated against them; no
// dollar figure derived from them is published any more. See
// UNAVAILABLE_REASON and the omitted recoverableSpend / projectedMonthlySaving.
const RECOVERY = {
  toolSchemas:  0.90,   // Anthropic cache_control or per-step filtering
  ragChunks:    0.90,   // Provider-native prefix caching on stable docs
  history:      0.65,   // Context pruning / rolling window cap
  systemPrompt: 0.85,   // Provider-native caching (when >= 1024 tokens)
};

const UNAVAILABLE_REASON =
  'Recovery amounts are withheld: the per-category recovery rates predate ' +
  'per-model cached-input pricing, and category costs are estimated ' +
  'allocations of the calculated request cost rather than independent ' +
  'measurements. Treat the category costs as "worth reviewing", not as a quote.';

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
  // Same costs again, but only for models NOT already receiving a provider
  // cache discount. The two recovery rates below that depend on provider-native
  // caching (systemPrompt, ragChunks) are applied to these instead of the
  // totals — otherwise this report claimed a share of spend as "recoverable by
  // enabling caching" on requests that were already being cached. OpenAI caches
  // automatically, so that was the common case, not an edge one.
  let cacheableSystemCost = 0;
  let cacheableRagCost    = 0;

  // Models observed actually receiving a discount somewhere in this data. A
  // cold miss on such a model is the cache being populated, not an untapped
  // opportunity, so its spend is excluded too.
  const cachingModels = new Set(
    entries.filter(e => (e.nativeCachedTokens ?? 0) > 0).map(e => e.model),
  );

  for (const e of entries) {
    if (e.cached) continue;  // cached entries already at $0, skip for waste calc
    const a = e.attribution;
    // Rescale to what was actually billed. `attribution.estimatedCost` prices
    // every token at the full input rate, so on a provider-cached request the
    // category costs summed here exceeded the real spend — the report showed
    // "Unused tool schemas $0.0021" next to "Total Spend $0.0012", and a
    // "recoverable" figure larger than the bill. Same `k` the CLI breakdown and
    // bin/trimwares.js already use.
    const realCost = typeof e.realCost === 'number' ? e.realCost : a.totalCost;
    const k = a.totalCost > 0 ? realCost / a.totalCost : 1;
    toolSchemaCost   += a.toolSchemas.estimatedCost * k;   toolSchemaTokens   += a.toolSchemas.tokens;
    ragChunkCost     += a.ragChunks.estimatedCost * k;     ragChunkTokens     += a.ragChunks.tokens;
    historyCost      += a.conversationHistory.estimatedCost * k; historyTokens += a.conversationHistory.tokens;
    systemPromptCost += a.systemPrompt.estimatedCost * k;
    userQueryCost    += a.userQuery.estimatedCost * k;     userQueryTokens    += a.userQuery.tokens;
    outputCost       += a.outputTokens.estimatedCost * k;  outputTokens       += a.outputTokens.tokens;
    if (!cachingModels.has(e.model)) {
      cacheableSystemCost += a.systemPrompt.estimatedCost * k;
      cacheableRagCost    += a.ragChunks.estimatedCost * k;
    }
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

  // ── Recoverable amounts: NOT PUBLISHED ────────────────────────────────────
  // Nothing derived from RECOVERY leaves this function any more. The rates are
  // flat assumptions predating per-model cached-input pricing, and the category
  // costs they multiply are estimated allocations of the request cost, not
  // independent measurements — so the product of the two is not a figure to put
  // in front of someone spending real money. `recoveryEstimatesUnavailable`
  // carries the reason instead; see UNAVAILABLE_REASON.
  //
  // `cacheableSystemCost` / `cacheableRagCost` are still computed above because
  // the CLI's Savings section needs the same "not already discounted" split,
  // and keeping the definition in one place stops the two drifting apart.
  void cacheableSystemCost; void cacheableRagCost; void RECOVERY;

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
  };

  const redundantRAGChunks: WasteCategory = {
    label:          'Redundant RAG chunks',
    tokens:         ragChunkTokens,
    cost:           ragChunkCost,
    percentOfSpend: pct(ragChunkCost),
    severity:       ragChunkCost > currentSpend * 0.15 ? 'critical' : ragChunkCost > 0 ? 'warning' : 'info',
    fix:            'Provider-native prompt caching on stable documents',
    fixDescription: 'Cache stable document prefixes — providers discount repeated prefixes, by an amount that varies with provider and model',
  };

  const staleContext: WasteCategory = {
    label:          'Stale conversation history',
    tokens:         historyTokens,
    cost:           historyCost,
    percentOfSpend: pct(historyCost),
    severity:       historyCost > currentSpend * 0.15 ? 'warning' : 'info',
    fix:            'maxHistoryTurns: 10',
    fixDescription: 'Rolling window keeps last 10 turns — older context stops accumulating',
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
    fixDescription: 'Route simple requests to a smaller model — per-call price differs by model; compare against your current one',
  };

  // ── Top fix = highest projected monthly saving ────────────────────────────
  const fixable = [unusedToolSchemas, redundantRAGChunks, staleContext, overpoweredModel]
    // Ordered by measured cost. It used to sort by projectedMonthlySaving,
    // which is no longer published — and since that was cost x a constant, the
    // ordering is unchanged for any single-rate comparison anyway.
    .filter(c => c.cost > 0)
    .sort((a, b) => b.cost - a.cost);

  return {
    totalGrossSpend,
    alreadySaved,
    currentSpend,
    // recoverableSpend / recoverablePercent deliberately ABSENT — see
    // UNAVAILABLE_REASON. Consumers must render this as unavailable, not zero.
    recoveryEstimatesUnavailable: UNAVAILABLE_REASON,
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
    recoveryEstimatesUnavailable: UNAVAILABLE_REASON,
    categories: {
      unusedToolSchemas: empty, redundantRAGChunks: empty, staleContext: empty,
      repeatedPrompts: empty, overpoweredModel: empty, genuineWork: empty,
    },
    topFix: null, sessionRequests: 0, generatedAt: Date.now(),
  };
}
