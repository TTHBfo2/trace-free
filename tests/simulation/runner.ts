import { LLMCostTrimmer } from '../../src/index.js';
import { RealisticMockProvider } from './RealisticMockProvider.js';
import { renderReport } from '../../src/cli/analyze.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface ScenarioMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Conversation {
  id: string;
  turns: ScenarioMessage[][];  // each turn = full message array for that call
  label?: string;
}

export interface ScenarioDefinition {
  name: string;
  description: string;
  provider: 'openai' | 'anthropic' | 'groq';
  model: string;
  outputVariance?: number;
  conversations: Conversation[];
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

export interface ScenarioResult {
  name: string;
  description: string;
  totalRequests: number;
  cacheHitRate: number;
  totalCostUsd: number;
  totalSavingsUsd: number;
  savingsPercent: number;
  avgLatencyMs: number;
  attributionBreakdown: Record<string, { tokens: number; percentOfTotal: number }>;
  providerCallCount: number;
  nativeCacheApplied: boolean;
}

export async function runScenario(scenario: ScenarioDefinition): Promise<ScenarioResult> {
  const provider = new RealisticMockProvider({
    name:            scenario.provider,
    model:           scenario.model,
    outputVariance:  scenario.outputVariance ?? 0.2,
  });

  const trimmer = new LLMCostTrimmer(provider, {
    provider:     scenario.provider,
    defaultModel: scenario.model,
    cache: {
      response: { ttlMs: 10 * 60 * 1000 },
      semantic: { similarityThreshold: 0.88 },
    },
  });

  // Run all conversations
  for (const convo of scenario.conversations) {
    for (const turn of convo.turns) {
      await trimmer.chat({
        messages: turn as import('../../src/types/index.js').LLMMessage[],
        tools: scenario.tools,
      });
    }
  }

  const report = trimmer.getCostReport();
  const log    = (trimmer as unknown as { sessionLog: { getBuffer: () => unknown[] } }).sessionLog.getBuffer() as import('../../src/types/index.js').SessionLogEntry[];
  const pSummary = provider.getSummary();

  // Aggregate attribution across all calls
  const agg = {
    systemPrompt:        { tokens: 0, percentOfTotal: 0 },
    toolSchemas:         { tokens: 0, percentOfTotal: 0 },
    ragChunks:           { tokens: 0, percentOfTotal: 0 },
    conversationHistory: { tokens: 0, percentOfTotal: 0 },
    userQuery:           { tokens: 0, percentOfTotal: 0 },
    outputTokens:        { tokens: 0, percentOfTotal: 0 },
  };
  let totalAllTokens = 0;

  for (const entry of log) {
    const a = entry.attribution;
    agg.systemPrompt.tokens        += a.systemPrompt.tokens;
    agg.toolSchemas.tokens         += a.toolSchemas.tokens;
    agg.ragChunks.tokens           += a.ragChunks.tokens;
    agg.conversationHistory.tokens += a.conversationHistory.tokens;
    agg.userQuery.tokens           += a.userQuery.tokens;
    agg.outputTokens.tokens        += a.outputTokens.tokens;
    totalAllTokens += a.totalInputTokens + a.totalOutputTokens;
  }

  for (const [key, val] of Object.entries(agg)) {
    (agg as Record<string, { tokens: number; percentOfTotal: number }>)[key].percentOfTotal =
      totalAllTokens > 0 ? parseFloat(((val.tokens / totalAllTokens) * 100).toFixed(1)) : 0;
  }

  const avgLatency = log.length > 0
    ? Math.round(log.reduce((s, e) => s + e.latencyMs, 0) / log.length)
    : 0;

  const nativeCacheApplied = log.some(e => e.nativeCache);

  return {
    name:                 scenario.name,
    description:          scenario.description,
    totalRequests:        report.totalRequests,
    cacheHitRate:         report.cacheHitRate,
    totalCostUsd:         report.totalCost,
    totalSavingsUsd:      report.totalSavings,
    savingsPercent:       report.savingsPercent,
    avgLatencyMs:         avgLatency,
    attributionBreakdown: agg,
    providerCallCount:    pSummary.calls,
    nativeCacheApplied,
  };
}

export async function runAllScenarios(
  scenarios: ScenarioDefinition[],
  outputDir = 'simulation-results'
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Trimwares — Real-World Simulation Suite');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const scenario of scenarios) {
    process.stdout.write(`  Running: ${scenario.name}...`);
    const result = await runScenario(scenario);
    results.push(result);
    process.stdout.write(` done\n`);
  }

  console.log('\n');
  printSummaryTable(results);
  saveResults(results, outputDir);
  return results;
}

function printSummaryTable(results: ScenarioResult[]): void {
  const C = { bold: '\x1b[1m', reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m' };

  console.log(`${C.bold}  Scenario Results${C.reset}`);
  console.log('  ' + '─'.repeat(90));
  console.log(
    `  ${'Scenario'.padEnd(28)} ${'Requests'.padStart(9)} ${'Hit Rate'.padStart(10)} ${'Cost'.padStart(10)} ${'Savings'.padStart(10)} ${'Avg ms'.padStart(8)}`
  );
  console.log('  ' + '─'.repeat(90));

  for (const r of results) {
    const savings = r.savingsPercent > 30
      ? `${C.green}${r.savingsPercent}%${C.reset}`
      : `${r.savingsPercent}%`;
    console.log(
      `  ${r.name.padEnd(28)} ${String(r.totalRequests).padStart(9)} ${String(r.cacheHitRate + '%').padStart(10)} ` +
      `${'$' + r.totalCostUsd.toFixed(4)}`.padStart(10) + ` ${savings.padStart(10)} ${String(r.avgLatencyMs + 'ms').padStart(8)}`
    );
  }
  console.log('  ' + '─'.repeat(90));

  for (const r of results) {
    console.log(`\n  ${C.bold}${r.name}${C.reset}  —  ${r.description}`);
    for (const [cat, data] of Object.entries(r.attributionBreakdown)) {
      const pct = data.percentOfTotal;
      if (pct < 1) continue;
      const bar = '█'.repeat(Math.round(pct / 4)).padEnd(25, '░');
      const flag = cat === 'toolSchemas' && pct > 10 ? ' ⚠ cacheable'
        : cat === 'systemPrompt' && pct > 20        ? ' ⚠ cacheable'
        : cat === 'ragChunks'    && pct > 15        ? ' ⚠ high'
        : '';
      console.log(`    ${cat.padEnd(22)} ${C.gray}${bar}${C.reset} ${String(pct + '%').padStart(6)}${flag}`);
    }
  }
  console.log('');
}

function saveResults(results: ScenarioResult[], outputDir: string): void {
  try {
    mkdirSync(outputDir, { recursive: true });
    const path = join(outputDir, `simulation-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(results, null, 2));
    console.log(`  Results saved to ${path}\n`);
  } catch {
    // non-fatal
  }
}
