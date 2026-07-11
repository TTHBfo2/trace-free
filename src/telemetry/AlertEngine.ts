// Alert detection engine — reads history data and compares against user-defined thresholds.
// All computation is local; no network calls. Nothing is blocked — thresholds only trigger notifications.

export type NotificationMode = 'once' | 'moderate' | 'persistent';

export interface AlertNotification {
  mode:             NotificationMode; // once = first crossing only; moderate = every N min; persistent = every poll
  intervalMinutes?: number;           // for 'moderate', default 5
}

export interface AlertConfig {
  // Multiple spend notification amounts (e.g. [5, 8] → notify at $5 and again at $8).
  // Replaces the old single maxDailySpend field. Migration: if maxDailySpend exists and
  // spendThresholds is absent, it is normalised to [maxDailySpend] at load time.
  spendThresholds?:   number[];  // USD amounts — fire when today's spend crosses each one
  spendSpikePercent?: number;    // % — fire if today > (7-day avg * (1 + pct/100))
  minCacheHitRate?:   number;    // 0–1 — fire if hit rate falls below this
  maxToolSchemaPct?:  number;    // 0–1 — fire if tool schema % of spend exceeds this
  sound?:             boolean;   // play a system sound with each notification
  notifications?: {
    spend_threshold?: AlertNotification;  // shared mode for all spend threshold alerts
    spend_spike?:     AlertNotification;
    cache_rate_drop?: AlertNotification;
    tool_schema_pct?: AlertNotification;
  };
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

  for (const amt of config.spendThresholds ?? []) {
    rules.push({
      id: `spend_at_${amt.toFixed(2)}`, type: 'spend_threshold',
      label: `Spend reaches $${amt.toFixed(2)}`,
      description: `Notify when today's spend crosses $${amt.toFixed(2)} — no API calls are blocked`,
      threshold: amt, unit: 'USD/day',
    });
  }

  if (config.spendSpikePercent !== undefined) {
    rules.push({
      id: 'spend_spike', type: 'spend_spike',
      label: 'Spend spike',
      description: `Notify when today's spend is more than ${config.spendSpikePercent}% above the 7-day average`,
      threshold: config.spendSpikePercent, unit: '%',
    });
  }
  if (config.minCacheHitRate !== undefined) {
    rules.push({
      id: 'cache_rate_drop', type: 'cache_rate_drop',
      label: 'Cache hit rate drop',
      description: `Notify when cache hit rate falls below ${(config.minCacheHitRate * 100).toFixed(0)}%`,
      threshold: config.minCacheHitRate, unit: '%',
    });
  }
  if (config.maxToolSchemaPct !== undefined) {
    rules.push({
      id: 'tool_schema_pct', type: 'tool_schema_pct',
      label: 'Tool schema overhead',
      description: `Notify when tool schemas exceed ${(config.maxToolSchemaPct * 100).toFixed(0)}% of spend`,
      threshold: config.maxToolSchemaPct, unit: '%',
    });
  }

  return rules;
}

export function evaluateAlerts(days: DayEntry[], config: AlertConfig): TriggeredAlert[] {
  if (days.length === 0) return [];

  const triggered: TriggeredAlert[] = [];
  const now = Date.now();

  const today = days[days.length - 1];
  if (!today) return [];

  // 7-day average (excluding today)
  const prior7 = days.slice(-8, -1);
  const avg7spend = prior7.length > 0
    ? prior7.reduce((s, d) => s + d.spend, 0) / prior7.length
    : 0;

  const totalRequests = days.reduce((s, d) => s + d.requests, 0);
  const totalCached   = days.reduce((s, d) => s + d.cached,   0);
  const cacheRate     = totalRequests > 0 ? totalCached / totalRequests : 0;

  const toolPct = today.spend > 0 ? today.toolCost / today.spend : 0;

  // One triggered alert per crossed spend threshold (sorted ascending so cheaper ones fire first)
  for (const amt of (config.spendThresholds ?? []).slice().sort((a, b) => a - b)) {
    if (today.spend > amt) {
      triggered.push({
        ruleId: `spend_at_${amt.toFixed(2)}`, type: 'spend_threshold',
        label: `Spend reached $${amt.toFixed(2)}`,
        message: `Today's spend ($${today.spend.toFixed(4)}) has crossed your $${amt.toFixed(2)} notification`,
        value: today.spend, threshold: amt, unit: 'USD', timestamp: now,
      });
    }
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
