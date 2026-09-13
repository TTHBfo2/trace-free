'use client';

import { useModelsData, ModelRow } from '@/hooks/useModelsData';
import { Cpu, Loader2, Lock, TrendingUp } from 'lucide-react';
import { clsx } from 'clsx';
import { usd, providerLabel } from '@/lib/format';

// Direct checkout — same destination as the Overview and Recommendations
// cards. "Get Developer" is reserved for links that actually go to checkout;
// links to the pricing page say "View Developer pricing" instead.
const DEV_CTA_URL = 'https://www.creem.io/payment/prod_7kmfXSlzBxzWMl3zfjc9wk';


const PROVIDER_COLOR: Record<string, string> = {
  openai:    '#10b981',
  anthropic: '#a78bfa',
  gemini:    '#60a5fa',
  groq:      '#f59e0b',
  ollama:    '#94a3b8',
};

function providerBadge(provider: string) {
  const color = PROVIDER_COLOR[provider.toLowerCase()] ?? '#555';
  return (
    <span
      style={{ color, border: `1px solid ${color}33`, background: `${color}11` }}
      className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-full flex-shrink-0"
    >
      {providerLabel(provider)}
    </span>
  );
}

function shortName(model: string): string {
  return model.split('/').pop() ?? model;
}

/* ─── Efficiency score (0–100) derived from observed data ──────────────────── */
function efficiencyScore(m: ModelRow, totalCost: number, totalRequests: number): number {
  const spendPct   = totalCost     > 0 ? (m.totalCost / totalCost)     * 100 : 0;
  const requestPct = totalRequests > 0 ? (m.requests  / totalRequests) * 100 : 0;
  const ratio      = requestPct   > 0 ? spendPct / requestPct : 1;

  let score = 100;
  // Caching: up to -25 for zero cache rate
  score -= (1 - m.cacheRate / 100) * 25;
  // Spend vs traffic alignment penalty
  if (ratio > 4)        score -= 25;
  else if (ratio > 2)   score -= 15;
  else if (ratio > 1.5) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreStatus(score: number): { label: string; cls: string } {
  if (score >= 85) return { label: 'Excellent',         cls: 'text-green-400 bg-[#0b1c0e] border-[#1a3820]' };
  if (score >= 65) return { label: 'Optimize caching',  cls: 'text-amber-400 bg-[#16100a] border-[#2a1e0a]' };
  if (score >= 45) return { label: 'Review routing',    cls: 'text-amber-500 bg-[#16100a] border-[#2a1e0a]' };
  return                  { label: 'Consider cheaper',  cls: 'text-red-400   bg-[#1a0b0b] border-[#2e1212]' };
}

function scoreRec(m: ModelRow, score: number): string | null {
  if (score >= 85) return null;
  if (m.cacheRate === 0) return 'Enable caching';
  if (score < 45)        return 'Route simple tasks to a cheaper model';
  if (score < 65)        return 'Improve cache hit rate';
  return 'Review routing logic';
}

/* ─── Page ─────────────────────────────────────────────────────────────────── */
export default function ModelsPage() {
  const { data, loading, error } = useModelsData();

  if (loading) return <Spinner />;
  if (error)   return <ServerDown />;

  const models = [...(data?.models ?? [])].sort((a, b) => b.totalCost - a.totalCost);
  if (models.length === 0) return <Empty />;

  const totalCost     = models.reduce((s, m) => s + m.totalCost, 0);
  const totalRequests = models.reduce((s, m) => s + m.requests,  0);
  const maxCost       = Math.max(...models.map(m => m.totalCost));
  const maxRequests   = Math.max(...models.map(m => m.requests));

  const topSpender = models[0];
  const topVolume  = [...models].sort((a, b) => b.requests  - a.requests)[0];
  const bestCache  = [...models].filter(m => m.cacheRate > 0)
                                .sort((a, b) => b.cacheRate - a.cacheRate)[0] ?? null;

  // Model arbitrage: spend % is 2.5× traffic % and represents >30% of budget
  const arbitrage = models.length > 1
    ? models.find(m => {
        const sp = totalCost     > 0 ? (m.totalCost / totalCost)     * 100 : 0;
        const rp = totalRequests > 0 ? (m.requests  / totalRequests) * 100 : 0;
        return rp > 0 && sp / rp > 2.5 && sp > 30;
      }) ?? null
    : null;

  return (
    <div className="p-8 max-w-[960px] mx-auto space-y-5">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-white">Model Efficiency</h1>
        <p className="text-[#7c7c7c] text-sm mt-0.5">
          {models.length} model{models.length !== 1 ? 's' : ''} · {totalRequests.toLocaleString()} requests · are you using the right models?
        </p>
      </div>

      {/* Three insight cards */}
      <div className="grid grid-cols-3 gap-4">
        <InsightCard
          label="Top Spender"
          value={shortName(topSpender.model)}
          sub={`${totalCost > 0 ? Math.round((topSpender.totalCost / totalCost) * 100) : 0}% of budget`}
          provider={topSpender.provider}
        />
        <InsightCard
          label="Highest Volume"
          value={shortName(topVolume.model)}
          sub={`${totalRequests > 0 ? Math.round((topVolume.requests / totalRequests) * 100) : 0}% of traffic`}
          provider={topVolume.provider}
        />
        {bestCache ? (
          <InsightCard
            label="Best Cache Rate"
            value={`${bestCache.cacheRate}%`}
            sub={shortName(bestCache.model)}
            provider={bestCache.provider}
            valueGreen
          />
        ) : (
          <InsightCard
            label="Best Cache Rate"
            value="—"
            sub="No caching active yet"
          />
        )}
      </div>

      {/* Model arbitrage callout */}
      {arbitrage && (() => {
        const sp = totalCost     > 0 ? Math.round((arbitrage.totalCost / totalCost)     * 100) : 0;
        const rp = totalRequests > 0 ? Math.round((arbitrage.requests  / totalRequests) * 100) : 0;
        return (
          <div className="rounded-xl border border-[#2a1e0a] bg-[#100c04] px-6 py-5">
            <p className="text-xs text-[#d4a04a] uppercase tracking-widest font-medium mb-2">Cost Imbalance Detected</p>
            <p className="text-sm text-[#9a9a9a] leading-relaxed">
              <span className="text-white font-medium">{shortName(arbitrage.model)}</span>
              {' '}handles{' '}
              <span className="text-white font-medium">{rp}% of requests</span>
              {' '}but accounts for{' '}
              <span className="text-amber-400 font-semibold">{sp}% of spend</span>.
              {' '}Routing some tasks to a cheaper model could meaningfully reduce this gap.
            </p>
          </div>
        );
      })()}

      {/* Model table */}
      <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] overflow-hidden">

        {/* Column headers */}
        <div className="px-6 py-3 border-b border-[#181818] grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1.2fr] gap-4">
          <span className="text-[10px] text-[#707070] uppercase tracking-widest">Model</span>
          <span className="text-[10px] text-[#707070] uppercase tracking-widest text-right">Requests</span>
          <span className="text-[10px] text-[#707070] uppercase tracking-widest text-right">Spend</span>
          <span className="text-[10px] text-[#707070] uppercase tracking-widest text-right">Cost / 1k req</span>
          <span className="text-[10px] text-[#707070] uppercase tracking-widest text-right">Cache</span>
          <span className="text-[10px] text-[#707070] uppercase tracking-widest text-right">Status</span>
        </div>

        {models.map((m, i) => {
          const score      = efficiencyScore(m, totalCost, totalRequests);
          const status     = scoreStatus(score);
          const rec        = scoreRec(m, score);
          const spendPct   = totalCost     > 0 ? Math.round((m.totalCost / totalCost)     * 100) : 0;
          const reqPct     = totalRequests > 0 ? Math.round((m.requests  / totalRequests) * 100) : 0;
          const spendBarW  = maxCost       > 0 ? (m.totalCost / maxCost)     * 100 : 0;
          const reqBarW    = maxRequests   > 0 ? (m.requests  / maxRequests) * 100 : 0;
          const costPer1k  = m.requests   > 0 ? (m.totalCost / m.requests)  * 1000 : 0;
          const imbalanced = reqPct > 0 && spendPct / reqPct > 2;

          return (
            <div
              key={`${m.provider}::${m.model}`}
              className={clsx(
                'px-6 py-4 grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1.2fr] gap-4 items-start',
                i < models.length - 1 && 'border-b border-[#141414]',
              )}
            >
              {/* Model name + provider + score */}
              <div className="min-w-0">
                <p className="text-sm text-white font-mono truncate leading-tight">{shortName(m.model)}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  {providerBadge(m.provider)}
                  <span className="text-[10px] text-[#7c7c7c]">
                    score{' '}
                    <span className={score >= 75 ? 'text-green-500' : score >= 50 ? 'text-amber-400' : 'text-red-400'}>
                      {score}
                    </span>
                    /100
                  </span>
                </div>
              </div>

              {/* Requests + bar */}
              <div className="text-right">
                <p className="text-sm text-[#9a9a9a] font-mono">{m.requests.toLocaleString()}</p>
                <div className="mt-1.5 h-1 bg-[#141414] rounded-full overflow-hidden">
                  <div className="h-full bg-[#383838] rounded-full" style={{ width: `${reqBarW}%` }} />
                </div>
                <p className="text-[10px] text-[#707070] mt-0.5">{reqPct}% of traffic</p>
              </div>

              {/* Spend + bar */}
              <div className="text-right">
                <p className="text-sm text-white font-mono">{usd(m.totalCost)}</p>
                <div className="mt-1.5 h-1 bg-[#141414] rounded-full overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full', imbalanced ? 'bg-amber-500' : 'bg-[#383838]')}
                    style={{ width: `${spendBarW}%` }}
                  />
                </div>
                <p className="text-[10px] text-[#707070] mt-0.5">{spendPct}% of budget</p>
              </div>

              {/* Cost per 1k requests */}
              <div className="text-right">
                <p className="text-sm text-[#9a9a9a] font-mono">{usd(costPer1k)}</p>
                <p className="text-[10px] text-[#707070] mt-0.5">per 1k req</p>
              </div>

              {/* Cache rate */}
              <div className="text-right">
                <p className={clsx(
                  'text-sm font-mono',
                  m.cacheRate >= 50 ? 'text-green-400' : m.cacheRate > 0 ? 'text-amber-400' : 'text-[#707070]',
                )}>
                  {m.cacheRate > 0 ? `${m.cacheRate}%` : '—'}
                </p>
                {m.saved > 0 && (
                  <p className="text-[10px] text-green-700 mt-0.5">{usd(m.saved)} saved</p>
                )}
              </div>

              {/* Status + recommendation */}
              <div className="text-right">
                <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded border', status.cls)}>
                  {status.label}
                </span>
                {rec && (
                  <p className="text-[10px] text-[#7c7c7c] mt-1.5 leading-tight">{rec}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Developer CTA */}
      <div className="rounded-xl border border-[#202020] bg-[#090909] p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="text-white font-semibold text-sm mb-1">
              Migrating models or A/B testing prompts?
            </p>
            <p className="text-[#9a9a9a] text-xs leading-relaxed">
              The free tier shows this session only. Developer overlays model costs over 30 days —
              so you can prove your migration ROI before committing to a change.
            </p>
          </div>
          <a
            href={DEV_CTA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-black bg-green-400 hover:bg-green-300 transition px-3 py-2 rounded-lg flex-shrink-0 whitespace-nowrap"
          >
            Get Developer — $79 once →
          </a>
        </div>
        <div className="mt-5 pt-4 border-t border-[#181818] grid grid-cols-2 gap-y-2.5 gap-x-6">
          {[
            '30-day per-model cost trends',
            '"This model got 27% more expensive" alerts',
            'Model migration history + ROI proof',
            'What-if calculator: route all calls to mini',
          ].map(feat => (
            <div key={feat} className="flex items-center gap-2">
              <Lock className="w-2.5 h-2.5 text-[#707070] flex-shrink-0" />
              <span className="text-[11px] text-[#7c7c7c]">{feat}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────────────── */
function InsightCard({
  label, value, sub, provider, valueGreen,
}: {
  label: string; value: string; sub: string; provider?: string; valueGreen?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] p-6">
      <p className="text-[11px] text-[#7c7c7c] uppercase tracking-wider mb-3">{label}</p>
      <p className={clsx(
        'text-base font-semibold font-mono leading-tight truncate',
        valueGreen ? 'text-green-400' : 'text-white',
      )}>
        {value}
      </p>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        {provider && providerBadge(provider)}
        <p className="text-xs text-[#7c7c7c]">{sub}</p>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="w-6 h-6 text-[#707070] animate-spin" />
    </div>
  );
}

function ServerDown() {
  return (
    <div className="p-6 flex flex-col items-center justify-center py-24 text-center">
      <Cpu className="w-8 h-8 text-[#707070] mb-4" />
      <p className="text-white font-medium mb-2">Dashboard server not running</p>
      <p className="text-[#7c7c7c] text-sm mb-4">Start it with:</p>
      <code className="text-xs text-[#9a9a9a] bg-[#0e0e0e] border border-[#1c1c1c] px-4 py-2.5 rounded-lg font-mono">
        npx trimwares serve
      </code>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <TrendingUp className="w-10 h-10 text-[#3a3a3a] mb-5" />
      <p className="text-white font-medium text-base mb-2">No model data yet</p>
      <p className="text-[#7c7c7c] text-sm max-w-sm leading-relaxed">
        Model usage appears here as you make LLM calls through Trimwares Trace.
      </p>
    </div>
  );
}
