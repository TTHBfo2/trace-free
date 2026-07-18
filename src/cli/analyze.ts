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
    return `\n${yellow('No session data found.')} Run your app with Trimwares Trace first.\n`;
  }

  const lines: string[] = [];
  const sep = gray('─'.repeat(60));

  // ── Aggregate ──────────────────────────────────────────────────
  let totalCost = 0;
  let totalRequests = 0;
  let cachedRequests = 0;
  let nativeCacheRequests = 0;
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

  for (const e of entries) {
    totalCost += e.attribution.totalCost;
    totalRequests++;
    if (e.cached)       cachedRequests++;
    if (e.nativeCache)  nativeCacheRequests++;
    totalInputTokens  += e.attribution.totalInputTokens;
    totalOutputTokens += e.attribution.totalOutputTokens;

    const a = e.attribution;
    cats.systemPrompt.tokens        += a.systemPrompt.tokens;
    cats.systemPrompt.cost          += a.systemPrompt.estimatedCost;
    cats.toolSchemas.tokens         += a.toolSchemas.tokens;
    cats.toolSchemas.cost           += a.toolSchemas.estimatedCost;
    cats.ragChunks.tokens           += a.ragChunks.tokens;
    cats.ragChunks.cost             += a.ragChunks.estimatedCost;
    cats.conversationHistory.tokens += a.conversationHistory.tokens;
    cats.conversationHistory.cost   += a.conversationHistory.estimatedCost;
    cats.userQuery.tokens           += a.userQuery.tokens;
    cats.userQuery.cost             += a.userQuery.estimatedCost;
    cats.outputTokens.tokens        += a.outputTokens.tokens;
    cats.outputTokens.cost          += a.outputTokens.estimatedCost;

    if (!byModel[e.model]) byModel[e.model] = { cost: 0, requests: 0 };
    byModel[e.model].cost     += e.attribution.totalCost;
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
    lines.push(sep);
    lines.push(`  ${bold('Savings opportunities')}`);
    lines.push('');

    if (cats.systemPrompt.cost > totalCost * 0.25) {
      const saving = cats.systemPrompt.cost * 0.90;
      lines.push(`  ${green('✓')} Provider-native caching on system prompt  → save ${green(bold(usd(saving)))} (90% reduction)`);
    }
    if (cats.toolSchemas.cost > totalCost * 0.08) {
      const saving = cats.toolSchemas.cost * 0.90;
      lines.push(`  ${green('✓')} Cache tool schema prefix                  → save ${green(bold(usd(saving)))} (90% reduction)`);
    }
    if (cats.ragChunks.cost > totalCost * 0.15) {
      const saving = cats.ragChunks.cost * 0.90;
      lines.push(`  ${green('✓')} Cache RAG document prefix                 → save ${green(bold(usd(saving)))} (90% reduction)`);
    }
    if (cats.conversationHistory.cost > totalCost * 0.20) {
      lines.push(`  ${yellow('!')} Conversation history is large — enable ContextPruner`);
    }

    const totalSavingEst = potentialSaving * 0.90;
    lines.push('');
    lines.push(`  ${bold('Estimated monthly saving')}  ${bold(green(usd(totalSavingEst * 30)))}  ${gray('(if request volume stays constant)')}`);
    lines.push('');
  }

  // ── Enriched waste intelligence ───────────────────────────────────────────
  const costEngine = new CostEngine();
  for (const e of entries) {
    costEngine.record({
      requestId:    e.requestId,
      provider:     e.provider,
      model:        e.model,
      inputTokens:  e.attribution.totalInputTokens,
      outputTokens: e.attribution.totalOutputTokens,
      cached:       e.cached,
      cacheType:    e.cacheType as import('../types/index.js').CacheType,
      latencyMs:    e.latencyMs,
      request:      { messages: [{ role: 'user', content: '' }] },
      savings:      e.cached ? e.attribution.totalCost : 0,
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

    for (const cat of wasteCats) {
      const icon    = SEVERITY_ICON[cat.severity] ?? '⚪';
      const monthly = isPro && cat.projectedMonthlySaving && cat.projectedMonthlySaving > 0
        ? `  ${gray('→ fix saves ' + usd(cat.projectedMonthlySaving) + '/mo')}`
        : '';
      lines.push(`  ${icon} ${cat.label.padEnd(26)} ${bold(yellow(usd(cat.cost)))}${monthly}`);
    }

    lines.push('');
    lines.push(`  ${cats.genuineWork.label.padEnd(28)} ${gray(usd(cats.genuineWork.cost))}  ${dim('(necessary spend)')}`);

    if (isPro && enriched.recoverableSpend > 0) {
      lines.push('');
      lines.push(`  ${bold('Recoverable this session')}  ${bold(green(usd(enriched.recoverableSpend)))}  ${dim(`(${enriched.recoverablePercent}% of current spend)`)}`);
      if (enriched.topFix) {
        lines.push(`  ${bold('Top action')}  ${enriched.topFix.fix ?? ''}  ${dim('→ ' + (enriched.topFix.fixDescription ?? ''))}`);
      }
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
