// Alert detection engine — reads history data and compares against user-defined thresholds.
// All computation is local; no network calls.

export interface AlertConfig {
  maxDailySpend?:       number;   // USD — fire if today's spend exceeds this
  spendSpikePercent?:   number;   // % — fire if today > (7-day avg * (1 + pct/100))
  minCacheHitRate?:     number;   // 0–1 — fire if hit rate falls below this
  maxToolSchemaPct?:    number;   // 0–1 — fire if tool schema % of spend exceeds this
}

export interface AlertRule {
  id:          string;
  type:        'spend_threshold' | 'spend_spike' | 'cache_rate_drop' | 'tool_schema_pct';
  label:       string;
  description: string;
  threshold:   number;
  unit:        string;
}

export interface TriggeredAlert {
  ruleId:    string;
  type:      AlertRule['type'];
  label:     string;
  message:   string;
  value:     number;
  threshold: number;
  unit:      string;
  timestamp: number;
}

export interface DayEntry {
  date:     string;
  spend:    number;
  saved:    number;
  requests: number;
  cached:   number;
  toolCost: number;
}

export function buildRules(config: AlertConfig): AlertRule[] {
  const rules: AlertRule[] = [];

  if (config.maxDailySpend !== undefined) {
    rules.push({
      id: 'spend_threshold', type: 'spend_threshold',
      label: 'Daily spend limit',
      description: `Alert when today's spend exceeds $${config.maxDailySpend.toFixed(2)}`,
      threshold: config.maxDailySpend, unit: 'USD/day',
    });
  }
  if (config.spendSpikePercent !== undefined) {
    rules.push({
      id: 'spend_spike', type: 'spend_spike',
      label: 'Spend spike',
      description: `Alert when today's spend is more than ${config.spendSpikePercent}% above the 7-day average`,
      threshold: config.spendSpikePercent, unit: '%',
    });
  }
  if (config.minCacheHitRate !== undefined) {
    rules.push({
      id: 'cache_rate_drop', type: 'cache_rate_drop',
      label: 'Cache hit rate drop',
      description: `Alert when cache hit rate falls below ${(config.minCacheHitRate * 100).toFixed(0)}%`,
      threshold: config.minCacheHitRate, unit: '%',
    });
  }
  if (config.maxToolSchemaPct !== undefined) {
    rules.push({
      id: 'tool_schema_pct', type: 'tool_schema_pct',
      label: 'Tool schema overhead',
      description: `Alert when tool schemas exceed ${(config.maxToolSchemaPct * 100).toFixed(0)}% of spend`,
      threshold: config.maxToolSchemaPct, unit: '%',
    });
  }

  return rules;
}

export function evaluateAlerts(days: DayEntry[], config: AlertConfig): TriggeredAlert[] {
  if (days.length === 0) return [];

  const triggered: TriggeredAlert[] = [];
  const now = Date.now();

  // Today = most recent day entry
  const today = days[days.length - 1];
  if (!today) return [];

  // 7-day average (excluding today)
  const prior7 = days.slice(-8, -1);
  const avg7spend = prior7.length > 0
    ? prior7.reduce((s, d) => s + d.spend, 0) / prior7.length
    : 0;

  // Total requests and cached requests across all days for cache hit rate
  const totalRequests = days.reduce((s, d) => s + d.requests, 0);
  const totalCached   = days.reduce((s, d) => s + d.cached,   0);
  const cacheRate     = totalRequests > 0 ? totalCached / totalRequests : 0;

  // Tool schema pct of today's spend
  const toolPct = today.spend > 0 ? today.toolCost / today.spend : 0;

  if (config.maxDailySpend !== undefined && today.spend > config.maxDailySpend) {
    triggered.push({
      ruleId: 'spend_threshold', type: 'spend_threshold',
      label: 'Daily spend limit exceeded',
      message: `Today's spend ($${today.spend.toFixed(4)}) exceeded your $${config.maxDailySpend.toFixed(2)} daily limit`,
      value: today.spend, threshold: config.maxDailySpend, unit: 'USD', timestamp: now,
    });
  }

  if (config.spendSpikePercent !== undefined && avg7spend > 0) {
    const spike = ((today.spend - avg7spend) / avg7spend) * 100;
    if (spike > config.spendSpikePercent) {
      triggered.push({
        ruleId: 'spend_spike', type: 'spend_spike',
        label: 'Spend spike detected',
        message: `Today's spend is ${spike.toFixed(0)}% above your 7-day average ($${avg7spend.toFixed(4)} → $${today.spend.toFixed(4)})`,
        value: spike, threshold: config.spendSpikePercent, unit: '%', timestamp: now,
      });
    }
  }

  if (config.minCacheHitRate !== undefined && totalRequests >= 10 && cacheRate < config.minCacheHitRate) {
    triggered.push({
      ruleId: 'cache_rate_drop', type: 'cache_rate_drop',
      label: 'Cache hit rate dropped',
      message: `Cache hit rate is ${(cacheRate * 100).toFixed(1)}% — below your ${(config.minCacheHitRate * 100).toFixed(0)}% threshold`,
      value: cacheRate, threshold: config.minCacheHitRate, unit: '%', timestamp: now,
    });
  }

  if (config.maxToolSchemaPct !== undefined && today.spend > 0 && toolPct > config.maxToolSchemaPct) {
    triggered.push({
      ruleId: 'tool_schema_pct', type: 'tool_schema_pct',
      label: 'Tool schema overhead high',
      message: `Tool schemas are ${(toolPct * 100).toFixed(1)}% of today's spend — above your ${(config.maxToolSchemaPct * 100).toFixed(0)}% threshold`,
      value: toolPct, threshold: config.maxToolSchemaPct, unit: '%', timestamp: now,
    });
  }

  return triggered;
}
