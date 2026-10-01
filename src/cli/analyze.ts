import { SessionLogEntry, EnrichedWasteReport } from '../types/index.js';
import { buildEnrichedWasteReport } from '../reporting/EnrichedWasteReport.js';
import { CostEngine } from '../core/CostEngine.js';

// Terminal color codes
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m',
};

function bold(s: string)   { return `${C.bold}${s}${C.reset}`; }
function dim(s: string)    { return `${C.dim}${s}${C.reset}`; }
function green(s: string)  { return `${C.green}${s}${C.reset}`; }
function yellow(s: string) { return `${C.yellow}${s}${C.reset}`; }
function cyan(s: string)   { return `${C.cyan}${s}${C.reset}`; }
function gray(s: string)   { return `${C.gray}${s}${C.reset}`; }

function bar(percent: number, width = 24): string {
  const filled = Math.round((percent / 100) * width);
  const empty  = width - filled;
  const color  = percent > 30 ? C.yellow : percent > 15 ? C.cyan : C.green;
  return `${color}${'█'.repeat(filled)}${C.gray}${'░'.repeat(empty)}${C.reset}`;
}

function usd(n: number): string {
  if (n === 0)   return '$0.00';
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 0.1)   return `$${n.toFixed(4)}`;
  if (n < 10)    return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90)      return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90)      return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48)      return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export interface AnalyzeOptions {
  entries: SessionLogEntry[];
  verbose?: boolean;
  isPro?: boolean;
}

export function renderReport(options: AnalyzeOptions): string {
  const { entries, isPro = false } = options;
  if (entries.length === 0) {
    return `\n${yellow('No session data found.')} Run your app with Trimwares Trace first.\n` +
      `${gray('Built by one person — tell me what Trace got wrong: hello@trimwares.com')}\n`;
  }

  const lines: string[] = [];
  const sep = gray('─'.repeat(60));

  // ── Aggregate ──────────────────────────────────────────────────
  let totalCost = 0;
  let totalRequests = 0;
  let cachedRequests = 0;
  // Needed inside the aggregation loop for per-model cached-input rates.
  const costEngine = new CostEngine();
  let nativeCacheRequests = 0;
  // Per-category spend that received NO provider cache discount, and the saving
  // this user's own models would really give on it.
  const uncached = {
    systemPrompt: { cost: 0, saving: 0 },
    toolSchemas:  { cost: 0, saving: 0 },
    ragChunks:    { cost: 0, saving: 0 },
  };
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const cats = {
    systemPrompt:        { tokens: 0, cost: 0 },
    toolSchemas:         { tokens: 0, cost: 0 },
    ragChunks:           { tokens: 0, cost: 0 },
    conversationHistory: { tokens: 0, cost: 0 },
    userQuery:           { tokens: 0, cost: 0 },
    outputTokens:        { tokens: 0, cost: 0 },
  };

  const byModel: Record<string, { cost: number; requests: number }> = {};

  // Models that demonstrably received a provider cache discount somewhere in
  // this data. For those, an undiscounted request is not an untapped
  // opportunity — it is almost always the cold miss that POPULATES the cache,
  // which is a necessary cost of caching working correctly. Recommending
  // "enable caching" on the back of a cold miss, while the very next request
  // proves caching is already on, is advice a user would rightly distrust.
  const cachingModels = new Set(
    entries.filter(e => (e.nativeCachedTokens ?? 0) > 0).map(e => e.model),
  );

  for (const e of entries) {
    // Spend is the REAL billed cost, not the heuristic attribution total.
    // attribution prices every token at the full input rate, so once provider
    // caching applies it overstates — it reported $0.0030 for calls that
    // actually cost $0.0019. `k` rescales the per-category breakdown to the
    // real figure, the same way bin/trimwares.js does for the dashboard.
    const realCost = typeof e.realCost === 'number' ? e.realCost : e.attribution.totalCost;
    const k = e.attribution.totalCost > 0 ? realCost / e.attribution.totalCost : 1;
    totalCost += realCost;
    totalRequests++;
    if (e.cached)       cachedRequests++;
    // Count only requests the provider actually discounted. This used to read
    // e.nativeCache when that flag held a pre-call eligibility guess, so the
    // CLI reported "100% of requests had provider cache applied" for prompts
    // that were merely large enough to be cacheable — including on Groq, which
    // has no prompt cache at all. The dashboard aggregate was fixed in
    // bin/trimwares.js; this call site was missed.
    if ((e.nativeCachedTokens ?? 0) > 0) nativeCacheRequests++;

    // Evidence for the recommendations further down. A locally-cached hit is
    // skipped entirely: it never reached the provider, so it can neither earn
    // nor miss a discount, and counting it either way distorts the answer. A category is only "worth
    // caching" to the extent it was NOT already discounted, so accumulate spend
    // on requests that reached the provider and got no cache discount — plus
    // the saving THIS model's own cached rate would give on it. A model with no
    // cached rate (Groq, gpt-3.5-turbo) contributes spend but zero saving,
    // which is the honest answer: caching it saves nothing. Previously every
    // category was quoted at a flat 90%, Anthropic's rate, for every provider.
    const mp = costEngine.getPricing(e.model);
    const modelDiscount = mp.cachedInputPerMillion !== undefined && mp.inputPerMillion > 0
      ? 1 - mp.cachedInputPerMillion / mp.inputPerMillion
      : 0;
    if (!e.cached && (e.nativeCachedTokens ?? 0) === 0 && !cachingModels.has(e.model)) {
      const add = (acc: { cost: number; saving: number }, v: number) => {
        acc.cost   += v * k;
        acc.saving += v * k * modelDiscount;
      };
      add(uncached.systemPrompt, e.attribution.systemPrompt.estimatedCost);
      add(uncached.toolSchemas,  e.attribution.toolSchemas.estimatedCost);
      add(uncached.ragChunks,    e.attribution.ragChunks.estimatedCost);
    }
    totalInputTokens  += e.attribution.totalInputTokens;
    totalOutputTokens += e.attribution.totalOutputTokens;

    const a = e.attribution;
    cats.systemPrompt.tokens        += a.systemPrompt.tokens;
    cats.systemPrompt.cost          += a.systemPrompt.estimatedCost * k;
    cats.toolSchemas.tokens         += a.toolSchemas.tokens;
    cats.toolSchemas.cost           += a.toolSchemas.estimatedCost * k;
    cats.ragChunks.tokens           += a.ragChunks.tokens;
    cats.ragChunks.cost             += a.ragChunks.estimatedCost * k;
    cats.conversationHistory.tokens += a.conversationHistory.tokens;
    cats.conversationHistory.cost   += a.conversationHistory.estimatedCost * k;
    cats.userQuery.tokens           += a.userQuery.tokens;
    cats.userQuery.cost             += a.userQuery.estimatedCost * k;
    cats.outputTokens.tokens        += a.outputTokens.tokens;
    cats.outputTokens.cost          += a.outputTokens.estimatedCost * k;

    if (!byModel[e.model]) byModel[e.model] = { cost: 0, requests: 0 };
    byModel[e.model].cost     += realCost;
    byModel[e.model].requests++;
  }

  const cacheHitRate    = totalRequests > 0 ? ((cachedRequests / totalRequests) * 100).toFixed(1) : '0';
  const nativeCacheRate = totalRequests > 0 ? ((nativeCacheRequests / totalRequests) * 100).toFixed(1) : '0';
  const totalTokens     = totalInputTokens + totalOutputTokens;
  const potentialSaving = cats.systemPrompt.cost + cats.toolSchemas.cost + cats.ragChunks.cost;

  // ── Header ────────────────────────────────────────────────────
  lines.push('');
  lines.push(bold(`  ⚡ Trimwares Trace — Cost Report`));
  lines.push(sep);

  // ── Summary ───────────────────────────────────────────────────
  lines.push('');
  lines.push(`  ${bold('Total Spend')}      ${bold(cyan(usd(totalCost)))}`);
  lines.push(`  ${bold('Total Tokens')}     ${fmtTokens(totalTokens)} ${gray(`(${fmtTokens(totalInputTokens)} in / ${fmtTokens(totalOutputTokens)} out)`)}`);
  lines.push(`  ${bold('Requests')}         ${totalRequests}  ${gray(`(${cachedRequests} cache hits · ${cacheHitRate}% hit rate)`)}`);
  lines.push(`  ${bold('Native Caching')}   ${nativeCacheRate}% of requests had provider cache applied`);
  lines.push('');

  // ── Token breakdown ───────────────────────────────────────────
  lines.push(sep);
  lines.push(`  ${bold('Where your tokens went')}`);
  lines.push('');

  const breakdown: Array<{ label: string; tokens: number; cost: number; flag?: string }> = [
    { label: 'System prompts',   ...cats.systemPrompt,        flag: cats.systemPrompt.cost        > totalCost * 0.25 ? '⚠ cacheable'  : '' },
    { label: 'Tool schemas',     ...cats.toolSchemas,         flag: cats.toolSchemas.cost         > totalCost * 0.08 ? '⚠ cacheable'  : '' },
    { label: 'RAG chunks',       ...cats.ragChunks,           flag: cats.ragChunks.cost           > totalCost * 0.15 ? '⚠ high'       : '' },
    { label: 'Conv. history',    ...cats.conversationHistory, flag: cats.conversationHistory.cost > totalCost * 0.20 ? '⚠ prunable'   : '' },
    { label: 'User queries',     ...cats.userQuery },
    { label: 'Output tokens',    ...cats.outputTokens },
  ];

  for (const row of breakdown) {
    const pct = totalTokens > 0 ? (row.tokens / totalTokens) * 100 : 0;
    const flagStr = row.flag ? ` ${yellow(row.flag)}` : '';
    lines.push(
      `  ${row.label.padEnd(18)} ${bar(pct)} ${String(pct.toFixed(1) + '%').padStart(6)}  ${gray(usd(row.cost))}${flagStr}`
    );
  }

  lines.push('');

  // ── By model ──────────────────────────────────────────────────
  const modelEntries = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);
  if (modelEntries.length > 1) {
    lines.push(sep);
    lines.push(`  ${bold('By model')}`);
    lines.push('');
    for (const [model, data] of modelEntries) {
      const pct = totalCost > 0 ? ((data.cost / totalCost) * 100).toFixed(1) : '0';
      lines.push(`  ${model.padEnd(28)} ${usd(data.cost).padStart(10)}  ${gray(pct + '%')}  ${gray(data.requests + ' req')}`);
    }
    lines.push('');
  }

  // ── Savings potential (Pro only) ──────────────────────────────
  if (isPro && potentialSaving > 0) {
    // Header is emitted only if something actually qualifies — an empty
    // "Savings opportunities" block reads as a failure to find anything when it
    // is really the correct answer that nothing is outstanding.
    const recLines: string[] = [];

    // Every line below is priced from the SAME evidence: spend that reached the
    // provider and was NOT discounted, times the cached rate that user's own
    // model actually offers. Three things were wrong before:
    //   - only the system-prompt line was suppressed when caching was already
    //     working, and only when more than half of live requests were cached,
    //     so the tool-schema and RAG lines kept recommending caching that was
    //     already on;
    //   - the quoted percentage was the weakest rate across all observed models
    //     rather than each category's own realizable saving;
    //   - the monthly total ignored both and multiplied by a flat 0.90.
    // A category now disappears on its own once its spend is being discounted,
    // because the accumulator stops growing for it — no extra heuristic.
    const rec = (label: string, u: { cost: number; saving: number }, threshold: number): number => {
      if (!(u.cost > totalCost * threshold) || u.saving <= 0) return 0;
      const pct = Math.round((u.saving / u.cost) * 100);
      recLines.push(`  ${green('✓')} ${label.padEnd(41)} → up to ${green(bold(usd(u.saving)))} (${pct}% if cacheable)`);
      return u.saving;
    };

    let realizable = 0;
    realizable += rec('Provider-native caching on system prompt', uncached.systemPrompt, 0.25);
    realizable += rec('Cache tool schema prefix',                 uncached.toolSchemas,  0.08);
    realizable += rec('Cache RAG document prefix',                uncached.ragChunks,    0.15);
    if (cats.conversationHistory.cost > totalCost * 0.20) {
      recLines.push(`  ${yellow('!')} Conversation history is large — enable ContextPruner`);
    }

    // No monthly projection. This used to be `saving * 30`, which silently
    // assumed the session was exactly one day of traffic — it might be ten
    // minutes or a fortnight, and nothing here knows which. Report what was
    // actually observed, say over how long, and leave the extrapolation to
    // someone who knows their own volume.
    if (realizable > 0) {
      const stamps = entries.map(e => e.timestamp).filter(t => typeof t === 'number');
      const spanMs = stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : 0;
      recLines.push('');
      recLines.push(
        `  ${bold('If fully cacheable')}  ${bold(green(usd(realizable)))}  ` +
        gray(`(across ${totalRequests} request${totalRequests === 1 ? '' : 's'}${spanMs > 0 ? ` over ${fmtDuration(spanMs)}` : ''} — not projected)`),
      );
    }

    if (recLines.length > 0) {
      lines.push(sep);
      lines.push(`  ${bold('Savings opportunities')}`);
      lines.push('');
      lines.push(...recLines);
      lines.push('');
    }
  }

  // ── Enriched waste intelligence ───────────────────────────────────────────
  for (const e of entries) {
    costEngine.record({
      requestId:    e.requestId,
      provider:     e.provider,
      model:        e.model,
      // attribution.totalInputTokens is the WHOLE prompt; CostEngine adds
      // inputTokens + nativeCachedTokens, so hand it the uncached remainder or
      // the cached portion gets billed twice.
      inputTokens:  Math.max(0, e.attribution.totalInputTokens - (e.nativeCachedTokens ?? 0)),
      outputTokens: e.attribution.totalOutputTokens,
      cached:       e.cached,
      cacheType:    e.cacheType as import('../types/index.js').CacheType,
      latencyMs:    e.latencyMs,
      request:      { messages: [{ role: 'user', content: '' }] },
      savings:      e.cached ? e.attribution.totalCost : 0,
      // Without this the rebuilt cost report priced every token at the full
      // input rate, so `currentSpend` — the denominator behind every percentage
      // in the enriched section — disagreed with the Total Spend printed at the
      // top of the same report.
      nativeCachedTokens: e.nativeCachedTokens ?? 0,
    });
  }

  const enriched: EnrichedWasteReport = buildEnrichedWasteReport(entries, costEngine.getCostReport());

  if (enriched.sessionRequests > 0) {
    lines.push(sep);
    lines.push(`  ${bold('Where your money is going')}  ${dim('(current session)')}`);
    lines.push('');

    // The aha-moment: what you spent vs what was recoverable
    if (enriched.alreadySaved > 0) {
      lines.push(`  ${green('✓')} Already saved  ${bold(green(usd(enriched.alreadySaved)))}  ${gray('(response cache)')}`);
    }

    const SEVERITY_ICON: Record<string, string> = {
      critical: '🔴',
      warning:  '🟡',
      info:     '⚪',
      good:     '🟢',
    };

    const cats = enriched.categories;
    const wasteCats = [
      cats.unusedToolSchemas,
      cats.redundantRAGChunks,
      cats.staleContext,
      cats.overpoweredModel,
    ].filter(c => c.cost > 0);

    // What each category COST is measured. How much of it is recoverable is
    // not: `RECOVERY` holds flat assumptions (tool schemas 0.90, history 0.65)
    // that predate per-model cached-input rates, and a 90% tool-schema figure
    // is not evidence those schemas are unnecessary. Those dollar estimates are
    // withheld rather than shown as a number nobody can stand behind — and
    // withheld is stated, not silently rendered as zero opportunity. The
    // Savings section above still quotes caching, because that one is derived
    // from the provider's own published rate on spend it did not discount.
    for (const cat of wasteCats) {
      const icon = SEVERITY_ICON[cat.severity] ?? '⚪';
      const action = cat.fixDescription ? `  ${gray('→ ' + cat.fixDescription)}` : '';
      lines.push(`  ${icon} ${cat.label.padEnd(26)} ${bold(yellow(usd(cat.cost)))}${action}`);
    }

    lines.push('');
    lines.push(`  ${cats.genuineWork.label.padEnd(28)} ${gray(usd(cats.genuineWork.cost))}  ${dim('(necessary spend)')}`);

    if (isPro && wasteCats.length > 0) {
      lines.push('');
      lines.push(`  ${dim('Category costs are estimated allocations of the calculated request')}`);
      lines.push(`  ${dim('cost. Recovery amounts are withheld pending sufficient evidence.')}`);
    }
    lines.push('');
  }

  lines.push(sep);
  lines.push(dim('  No proxy · no cloud · no account — npm install is the entire infrastructure.'));
  lines.push(dim('  Prompt content is never stored. Token counts only (BPE cl100k_base, ±2%).'));
  lines.push(dim('  Costs: provider list pricing — verify exact amounts against your invoice.'));
  if (!isPro) {
    lines.push(dim('  Developer: unlimited history · spend alerts · multi-project · export'));
    lines.push(dim('  → trimwares.com/trace'));
  } else {
    lines.push(dim('  Dashboard: npx trimwares serve  →  http://localhost:7778'));
  }
  lines.push('');

  return lines.join('\n');
}

export function printReport(options: AnalyzeOptions): void {
  process.stdout.write(renderReport(options));
}
