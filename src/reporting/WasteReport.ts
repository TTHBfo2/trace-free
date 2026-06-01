import {
  CostEntry,
  WasteReport,
  WasteEntry,
  WasteFlag,
  WasteSummaryByType,
} from '../types/index.js';

const WASTE_LABELS: Record<WasteFlag, string> = {
  redundant_request:  'Duplicate or near-duplicate requests sent within 60s',
  stale_context:      'Conversation history is large but output is tiny — old messages may not matter',
  oversized_context:  'Context exceeded 8,000 tokens — consider pruning earlier messages',
  premium_for_simple: 'Expensive model used for a short, simple request',
  missed_cache_hit:   'Small request that a cache layer could have served for free',
};

const RECOMMENDATIONS: Record<WasteFlag, string> = {
  redundant_request:  'Enable ResponseCache or SemanticCache to intercept duplicate prompts.',
  stale_context:      'Use ContextPruner to drop low-relevance messages before sending.',
  oversized_context:  'Use ContextPruner with maxTokens to cap context size automatically.',
  premium_for_simple: 'Enable ModelRouter to auto-route short requests to a budget model.',
  missed_cache_hit:   'Lower SemanticCache threshold or increase ResponseCache TTL.',
};

export class WasteReporter {
  buildReport(entries: CostEntry[]): WasteReport {
    const now = Date.now();
    const flaggedEntries = entries.filter(e => e.wasteFlags.length > 0);

    const byType: Partial<Record<WasteFlag, WasteSummaryByType>> = {};
    const wasteEntries: WasteEntry[] = [];
    let totalWaste = 0;

    for (const entry of flaggedEntries) {
      const waste = entry.cost * 0.7; // conservative: 70% of flagged cost is recoverable
      totalWaste += waste;

      wasteEntries.push({
        requestId: entry.requestId,
        timestamp: entry.timestamp,
        flags: entry.wasteFlags,
        estimatedWaste: waste,
        model: entry.model,
        provider: entry.provider,
      });

      for (const flag of entry.wasteFlags) {
        if (!byType[flag]) {
          byType[flag] = { count: 0, estimatedCost: 0, examples: [] };
        }
        const summary = byType[flag];
        summary.count++;
        summary.estimatedCost += waste / entry.wasteFlags.length;
        if (summary.examples.length < 3) {
          summary.examples.push(entry.requestId);
        }
      }
    }

    const topWasteDrivers = wasteEntries
      .sort((a, b) => b.estimatedWaste - a.estimatedWaste)
      .slice(0, 10);

    const activeFlags = Object.keys(byType) as WasteFlag[];
    const recommendations = activeFlags
      .sort((a, b) => (byType[b]?.estimatedCost ?? 0) - (byType[a]?.estimatedCost ?? 0))
      .map(flag => `[${WASTE_LABELS[flag]}] → ${RECOMMENDATIONS[flag]}`);

    const timeRange = entries.length > 0
      ? { start: Math.min(...entries.map(e => e.timestamp)), end: Math.max(...entries.map(e => e.timestamp)) }
      : { start: now, end: now };

    const wastePercent = entries.length > 0
      ? parseFloat(((flaggedEntries.length / entries.length) * 100).toFixed(1))
      : 0;

    return {
      totalWaste,
      totalRequests: entries.length,
      wastePercent,
      byType,
      topWasteDrivers,
      recommendations,
      timeRange,
      generatedAt: now,
    };
  }
}
