'use client';

import { useDashboardData } from '@/hooks/useDashboardData';
import { SessionSummary }   from '@/components/attribution/SessionSummary';
import { SessionLogTable }  from '@/components/attribution/SessionLogTable';
import { AlertCircle, Loader2, Lock } from 'lucide-react';
import { clsx } from 'clsx';
import type { DashboardApiResponse } from '@/hooks/useDashboardData';

type Scenarios = NonNullable<DashboardApiResponse['attribution']['scenarios']>;

function usd(n: number): string {
  if (n === 0)    return '$0.00';
  if (n >= 1)     return `$${n.toFixed(3)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(5)}`;
}

function cacheRateLabel(rate: number): { text: string; cls: string } {
  if (rate >= 50) return { text: 'Highly optimized', cls: 'text-green-500 bg-[#0b1c0e] border-[#1a3820]' };
  if (rate >= 25) return { text: 'Average',           cls: 'text-amber-400  bg-[#16100a] border-[#2a1e0a]' };
  if (rate > 0)   return { text: 'Needs work',        cls: 'text-amber-500  bg-[#16100a] border-[#2a1e0a]' };
  return               { text: 'Not caching',         cls: 'text-[#7c7c7c]  bg-[#0e0e0e] border-[#1c1c1c]' };
}

/* ─── Before / After hero ────────────────────────────────────────────────── */
function BeforeAfter({
  gross, net, saved, cacheHitRate, nativeCacheHitRate,
}: {
  gross: number; net: number; saved: number;
  cacheHitRate: number; nativeCacheHitRate: number;
}) {
  const savedPct = gross > 0 ? Math.round((saved / gross) * 100) : 0;
  const badge    = cacheRateLabel(cacheHitRate);

  return (
    <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] overflow-hidden">
      <div className="px-6 py-4 border-b border-[#181818]">
        <p className="text-xs text-[#7c7c7c] uppercase tracking-widest font-medium">Session overview</p>
      </div>

      <div className="grid grid-cols-3 divide-x divide-[#181818]">
        {/* Without Trimwares */}
        <div className="px-7 py-6">
          <p className="text-[11px] text-[#7c7c7c] uppercase tracking-wider mb-3">Without Trimwares</p>
          <p className="text-3xl font-bold font-mono text-[#9a9a9a] leading-none">{usd(gross)}</p>
          <p className="text-[11px] text-[#7c7c7c] mt-2">gross spend</p>
        </div>

        {/* With Trimwares */}
        <div className="px-7 py-6">
          <p className="text-[11px] text-[#7c7c7c] uppercase tracking-wider mb-3">With Trimwares</p>
          <p className="text-3xl font-bold font-mono text-white leading-none">{usd(net)}</p>
          <p className="text-[11px] text-[#7c7c7c] mt-2">net spend</p>
        </div>

        {/* Saved */}
        <div className="px-7 py-6">
          <p className="text-[11px] text-[#7c7c7c] uppercase tracking-wider mb-3">Saved</p>
          <p className={clsx('text-3xl font-bold font-mono leading-none', saved > 0 ? 'text-green-400' : 'text-[#707070]')}>
            {saved > 0 ? `${savedPct}%` : '—'}
          </p>
          <p className="text-[11px] text-[#7c7c7c] mt-2">
            {saved > 0 ? `${usd(saved)} by caching` : 'enable caching to save'}
          </p>
        </div>
      </div>

      {/* Cache stats row */}
      <div className="px-7 py-4 border-t border-[#181818] flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[#7c7c7c]">Response cache</span>
          <span className="text-[11px] font-mono font-semibold text-white">{cacheHitRate.toFixed(1)}%</span>
          <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded border', badge.cls)}>
            {badge.text}
          </span>
        </div>
        {nativeCacheHitRate > 0 && (
          <>
            <span className="text-[#3a3a3a]">·</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[#7c7c7c]">Prompt cache</span>
              <span className="text-[11px] font-mono font-semibold text-cyan-400">{nativeCacheHitRate.toFixed(1)}%</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Benchmark section ──────────────────────────────────────────────────── */
function BenchmarkSection({
  scenarios,
  sessionAgg,
  sessionCost,
}: {
  scenarios: Scenarios;
  sessionAgg: DashboardApiResponse['attribution']['sessionAgg'];
  sessionCost: DashboardApiResponse['attribution']['sessionCost'];
}) {
  const userCacheablePct = sessionAgg.total > 0
    ? ((sessionAgg.systemPrompt + sessionAgg.toolSchemas + sessionAgg.ragChunks) / sessionAgg.total) * 100
    : 0;
  const userSavedPct = (sessionCost.totalCost + sessionCost.totalSaved) > 0
    ? (sessionCost.totalSaved / (sessionCost.totalCost + sessionCost.totalSaved)) * 100
    : 0;

  const first  = scenarios[0];
  const locked = scenarios.slice(1);

  const firstCacheablePct = first
    ? first.attributionBreakdown.systemPrompt.percentOfTotal
      + first.attributionBreakdown.toolSchemas.percentOfTotal
      + first.attributionBreakdown.ragChunks.percentOfTotal
    : 0;

  return (
    <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-[#181818] flex items-center justify-between">
        <p className="text-xs text-[#7c7c7c] uppercase tracking-widest font-medium">Industry benchmarks</p>
        <span className="text-[11px] text-[#707070]">based on real production test runs</span>
      </div>

      {/* Column headers */}
      <div className="px-6 py-3 border-b border-[#141414] grid grid-cols-4 gap-4">
        <span className="text-[10px] text-[#707070] uppercase tracking-wider">Workload</span>
        <span className="text-[10px] text-[#707070] uppercase tracking-wider text-right">Cacheable %</span>
        <span className="text-[10px] text-[#707070] uppercase tracking-wider text-right">Cache rate</span>
        <span className="text-[10px] text-[#707070] uppercase tracking-wider text-right">Savings</span>
      </div>

      {/* Your session */}
      <div className="px-6 py-4 border-b border-[#141414] grid grid-cols-4 gap-4 items-center">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-sm text-white">Your session</span>
          <span className="text-[10px] text-green-600 bg-[#0d1e12] border border-[#1a3020] px-1.5 py-0.5 rounded-full font-medium">
            live
          </span>
        </div>
        <span className="text-sm font-mono text-white text-right">{userCacheablePct.toFixed(0)}%</span>
        <span className="text-sm font-mono text-green-400 text-right">{sessionCost.cacheHitRate.toFixed(1)}%</span>
        <span className="text-sm font-mono text-white text-right">
          {userSavedPct > 0 ? `${userSavedPct.toFixed(0)}%` : '—'}
        </span>
      </div>

      {/* First scenario — free */}
      {first && (
        <div className="px-6 py-4 border-b border-[#141414] grid grid-cols-4 gap-4 items-center">
          <span className="text-sm text-[#9a9a9a]">{first.name.split(' (')[0]}</span>
          <span className="text-sm font-mono text-[#9a9a9a] text-right">{firstCacheablePct.toFixed(0)}%</span>
          <span className="text-sm font-mono text-[#9a9a9a] text-right">{first.cacheHitRate}%</span>
          <span className="text-sm font-mono text-[#9a9a9a] text-right">{first.savingsPercent}%</span>
        </div>
      )}

      {/* Locked rows */}
      {locked.map((s, i) => (
        <div
          key={s.name}
          className={clsx('px-6 py-4 grid grid-cols-4 gap-4 items-center', i < locked.length - 1 && 'border-b border-[#141414]')}
        >
          <span className="text-sm text-[#707070]">{s.name.split(' (')[0].replace('AI Agent', 'AI Agent')}</span>
          <span className="text-sm font-mono text-[#3a3a3a] text-right">—</span>
          <span className="text-sm font-mono text-[#3a3a3a] text-right">—</span>
          <div className="flex items-center justify-end gap-1.5">
            <Lock className="w-2.5 h-2.5 text-[#707070]" />
            <span className="text-[11px] text-[#707070]">Developer</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */
export default function AttributionPage() {
  const { data, loading, error } = useDashboardData();

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="w-6 h-6 text-[#707070] animate-spin" />
    </div>
  );

  if (error) return (
    <div className="p-6 flex flex-col items-center justify-center py-24 text-center">
      <AlertCircle className="w-8 h-8 text-[#707070] mb-4" />
      <p className="text-[#7c7c7c] text-sm">Could not reach dashboard server.</p>
      <code className="text-xs text-[#9a9a9a] bg-[#0e0e0e] border border-[#1c1c1c] px-4 py-2.5 rounded-lg font-mono mt-4">
        npx trimwares serve
      </code>
    </div>
  );

  const { attribution, entryCount, sessionLog, waste } = data!;
  const { scenarios, sessionAgg, sessionCost } = attribution;
  const hasData     = entryCount > 0;
  const hasScenarios = scenarios !== null && scenarios.length > 0;

  if (!hasData) {
    return (
      <div className="p-6 max-w-[960px] mx-auto flex flex-col items-center justify-center py-24 text-center">
        <p className="text-white font-medium mb-2">No session data yet</p>
        <p className="text-[#7c7c7c] text-sm max-w-sm leading-relaxed">
          Wrap your LLM client with Trimwares and run a request — attribution data appears here within seconds.
        </p>
      </div>
    );
  }

  const gross = waste.totalGrossSpend;
  const net   = waste.currentSpend;
  const saved = waste.alreadySaved;

  return (
    <div className="p-8 max-w-[1000px] mx-auto space-y-5">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-white">Attribution</h1>
        <p className="text-[#7c7c7c] text-sm mt-0.5">
          {entryCount} requests · where every token went
        </p>
      </div>

      {/* Before / After */}
      <BeforeAfter
        gross={gross}
        net={net}
        saved={saved}
        cacheHitRate={sessionCost.cacheHitRate}
        nativeCacheHitRate={sessionCost.nativeCacheHitRate}
      />

      {/* Token breakdown */}
      <SessionSummary agg={sessionAgg} entryCount={entryCount} />

      {/* Benchmarks */}
      {hasScenarios && (
        <BenchmarkSection
          scenarios={scenarios!}
          sessionAgg={sessionAgg}
          sessionCost={sessionCost}
        />
      )}

      {/* Request log */}
      <SessionLogTable entries={sessionLog} />

    </div>
  );
}
