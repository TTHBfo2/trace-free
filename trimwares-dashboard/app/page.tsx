'use client';

import { useDashboardData, SetupDetect } from '@/hooks/useDashboardData';
import { clsx } from 'clsx';
import { TrendingDown, Zap, Loader2, Check, Circle, Lock } from 'lucide-react';

function usd(n: number): string {
  if (n === 0)    return '$0.00';
  if (n >= 1000)  return `$${(n / 1000).toFixed(1)}K`;
  if (n >= 1)     return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

export default function OverviewPage() {
  const { data, loading, error } = useDashboardData();

  if (loading) return <LoadingState />;
  if (error)   return <ErrorState />;

  const { waste, hasData, entryCount, setup, projectPath, sessionLog } = data!;

  if (!hasData) {
    return (
      <div className="p-6 max-w-[900px] mx-auto">
        <NoDataState setup={setup} projectPath={projectPath} />
      </div>
    );
  }

  const { currentSpend, alreadySaved, totalGrossSpend, recoverableSpend, topFix, categories } = waste;

  const savedPct    = totalGrossSpend > 0 ? Math.round((alreadySaved / totalGrossSpend) * 100) : 0;
  const cacheHits   = sessionLog?.filter(e => e.cached).length ?? 0;
  const nativeHits  = sessionLog?.filter(e => e.nativeCache && !e.cached).length ?? 0;

  const grossForBar = totalGrossSpend || 1;
  const savedBarPct = (alreadySaved     / grossForBar) * 100;
  const recBarPct   = (recoverableSpend / grossForBar) * 100;
  const baseBarPct  = Math.max(0, 100 - savedBarPct - recBarPct);

  const wasteOpportunities = categories.filter(c => c.severity !== 'good' && c.cost > 0).length;
  const sessionRequests    = waste.sessionRequests ?? entryCount;

  return (
    <div className="p-8 max-w-[900px] mx-auto space-y-5">

      {/* ─── S1 + S2: Spend & Saved ── */}
      <div className="grid grid-cols-2 gap-4">

        {/* AI Spend */}
        <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] p-6">
          <p className="text-[#7c7c7c] text-xs uppercase tracking-widest font-medium mb-3">
            AI Spend — This Session
          </p>
          <p className="text-4xl font-bold font-mono text-white leading-none">{usd(currentSpend)}</p>
          <p className="text-[#7c7c7c] text-sm mt-3">
            {sessionRequests} request{sessionRequests !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Already Saved */}
        <div className={clsx(
          'rounded-xl border p-6',
          alreadySaved > 0
            ? 'border-[#1e3828] bg-[#0b1610]'
            : 'border-[#1c1c1c] bg-[#0e0e0e]',
        )}>
          <p className={clsx(
            'text-xs uppercase tracking-widest font-medium mb-3',
            alreadySaved > 0 ? 'text-green-600' : 'text-[#7c7c7c]',
          )}>
            Already Saved
          </p>
          <p className={clsx(
            'text-4xl font-bold font-mono leading-none',
            alreadySaved > 0 ? 'text-green-400' : 'text-[#707070]',
          )}>
            {usd(alreadySaved)}
          </p>
          <p className={clsx('text-sm mt-3', alreadySaved > 0 ? 'text-green-700' : 'text-[#7c7c7c]')}>
            {alreadySaved > 0
              ? `${savedPct}% of gross spend`
              : 'Enable caching to start saving'}
          </p>
          {alreadySaved > 0 && (cacheHits > 0 || nativeHits > 0) && (
            <div className="mt-3 pt-3 border-t border-green-900/40 space-y-1.5">
              {cacheHits > 0 && (
                <p className="text-xs text-green-800">
                  ↳ {cacheHits} response cache hit{cacheHits !== 1 ? 's' : ''}
                </p>
              )}
              {nativeHits > 0 && (
                <p className="text-xs text-green-800">
                  ↳ {nativeHits} native cache request{nativeHits !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ─── Thick Stacked Bar ── */}
      <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] p-6">
        <div className="flex justify-between text-xs text-[#7c7c7c] mb-4">
          <span className="font-medium tracking-wide">Spend breakdown</span>
          <div className="flex items-center gap-4">
            {alreadySaved > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Saved
              </span>
            )}
            {recoverableSpend > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> Recoverable
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#303030] inline-block" /> Efficient
            </span>
          </div>
        </div>

        <div className="h-6 bg-[#141414] rounded-lg overflow-hidden flex gap-px">
          {totalGrossSpend === 0 ? (
            <div className="h-full w-full bg-[#181818] rounded-lg" />
          ) : (
            <>
              {savedBarPct > 0 && (
                <div
                  className="h-full bg-green-500"
                  style={{ width: `${savedBarPct}%` }}
                />
              )}
              {recBarPct > 0 && (
                <div
                  className="h-full bg-amber-500"
                  style={{ width: `${recBarPct}%` }}
                />
              )}
              {baseBarPct > 0 && (
                <div
                  className="h-full bg-[#242424]"
                  style={{ width: `${baseBarPct}%` }}
                />
              )}
            </>
          )}
        </div>

        <div className="flex justify-between text-xs text-[#7c7c7c] mt-2.5">
          <span>{totalGrossSpend > 0 ? `${usd(totalGrossSpend)} gross` : 'No spend yet'}</span>
          {currentSpend > 0 && <span>{usd(currentSpend)} net</span>}
        </div>
      </div>

      {/* ─── S3: Still Recoverable ── */}
      {recoverableSpend > 0 && (
        <div className="rounded-xl border border-[#2a1e0a] bg-[#100c04] p-6 flex items-center justify-between">
          <div>
            <p className="text-xs text-[#d4a04a] uppercase tracking-widest font-medium mb-2">
              Still Recoverable
            </p>
            <p className="text-3xl font-bold font-mono text-amber-400 leading-none">
              {usd(recoverableSpend)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-5xl font-black text-amber-500/[0.15] leading-none tabular-nums">
              {wasteOpportunities}
            </p>
            <p className="text-xs text-[#7c7c7c] mt-1">
              {wasteOpportunities === 1 ? 'opportunity' : 'opportunities'} found
            </p>
          </div>
        </div>
      )}

      {/* ─── S4: Top Recommendation ── */}
      {topFix && (
        <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] p-6">
          <div className="flex items-center gap-2 mb-5">
            <Zap className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
            <p className="text-xs text-[#7c7c7c] uppercase tracking-widest font-medium">
              Top Recommendation
            </p>
          </div>
          <p className="text-white font-semibold text-base mb-1.5">{topFix.label}</p>
          <p className="text-[#9a9a9a] text-sm leading-relaxed mb-4">{topFix.fixDescription}</p>
          <div className="flex items-center justify-between pt-3 border-t border-[#181818]">
            <span className="text-xs text-[#7c7c7c]">Estimated saving</span>
            <span className="text-green-400 font-mono font-semibold text-sm">
              {topFix.projectedMonthlySaving != null && topFix.projectedMonthlySaving > 0
                ? `${usd(topFix.projectedMonthlySaving)}/mo est.`
                : `${usd(topFix.cost)} recoverable`}
            </span>
          </div>
        </div>
      )}

      {/* ─── S5a: History Tease ── */}
      <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] overflow-hidden">
        <div className="px-6 py-4 border-b border-[#181818] flex items-center justify-between">
          <p className="text-xs text-[#7c7c7c] uppercase tracking-widest font-medium">
            Session History
          </p>
          <span className="text-[10px] text-[#707070]">current session only</span>
        </div>

        {/* Today — live */}
        <div className="px-6 py-4 flex items-center justify-between border-b border-[#181818]">
          <div className="flex items-center gap-3">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span className="text-sm text-white">Today</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-mono text-white">{usd(currentSpend)}</span>
            <span className="text-[10px] text-green-500 bg-[#0d1e12] border border-[#1a3020] px-2 py-0.5 rounded-full font-medium">
              live
            </span>
          </div>
        </div>

        <LockedHistoryRow label="Yesterday" />
        <LockedHistoryRow label="Last 7 days" />
        <LockedHistoryRow label="Last 30 days" last />
      </div>

      {/* ─── S5b: Developer CTA ── */}
      <div className="rounded-xl border border-[#202020] bg-[#090909] p-6">
        <div className="flex items-start justify-between mb-5">
          <div>
            <p className="text-white font-semibold text-base mb-1">Unlock Developer</p>
            <p className="text-[#9a9a9a] text-sm">Keep your history. See where costs are going.</p>
          </div>
          <a
            href="https://www.creem.io/payment/prod_7kmfXSlzBxzWMl3zfjc9wk"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-black bg-green-400 hover:bg-green-300 transition px-4 py-2 rounded-lg flex-shrink-0 ml-4 whitespace-nowrap"
          >
            Get Developer — $79 once →
          </a>
        </div>

        <div className="grid grid-cols-2 gap-y-2.5 gap-x-4">
          {[
            'Unlimited history — no reset',
            '30-day spend trends + forecasting',
            'Daily spend chart with replay',
            'Spend alerts + threshold gates',
          ].map(feat => (
            <div key={feat} className="flex items-center gap-2">
              <div className="w-1 h-1 rounded-full bg-[#383838] flex-shrink-0" />
              <span className="text-xs text-[#9a9a9a]">{feat}</span>
            </div>
          ))}
        </div>

        <p className="text-[10px] text-[#707070] mt-4">
          No renewal. No expiration. Your history stays on this machine.
        </p>
        <p className="text-[10px] text-[#707070] mt-1.5">
          Built by one person — tell me what Trace got wrong:{' '}
          <a
            href="mailto:hello@trimwares.com"
            className="underline hover:text-[#9a9a9a] transition"
          >
            hello@trimwares.com
          </a>
        </p>
      </div>

    </div>
  );
}

function LockedHistoryRow({ label, last }: { label: string; last?: boolean }) {
  return (
    <div className={clsx(
      'px-6 py-4 flex items-center justify-between',
      !last && 'border-b border-[#181818]',
    )}>
      <div className="flex items-center gap-3">
        <div className="w-1.5 h-1.5 rounded-full bg-[#1e1e1e]" />
        <span className="text-sm text-[#707070]">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-[#707070]">—</span>
        <Lock className="w-3 h-3 text-[#707070]" />
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Loader2 className="w-8 h-8 text-[#3a3a3a] mb-4 animate-spin" />
      <p className="text-[#7c7c7c] text-sm">Loading session data…</p>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <TrendingDown className="w-8 h-8 text-[#3a3a3a] mb-4" />
      <p className="text-white font-medium mb-2">Dashboard server not running</p>
      <p className="text-[#7c7c7c] text-sm mb-4">Start it with:</p>
      <code className="text-xs text-[#9a9a9a] bg-[#0e0e0e] border border-[#1c1c1c] px-4 py-2.5 rounded-lg font-mono">
        npx trimwares serve
      </code>
    </div>
  );
}

function Step({ done, label, children }: { done: boolean; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className={`w-6 h-6 rounded-full border flex items-center justify-center flex-shrink-0 text-xs font-semibold
          ${done ? 'border-green-800 bg-[#0c1e10] text-green-400' : 'border-[#242424] text-[#7c7c7c]'}`}>
          {done ? <Check className="w-3.5 h-3.5" /> : <Circle className="w-2 h-2 fill-current" />}
        </div>
        <div className="w-px flex-1 bg-[#181818] mt-1" />
      </div>
      <div className="pb-6 flex-1 min-w-0">
        <p className={`text-sm font-medium mb-2 ${done ? 'text-green-400' : 'text-white'}`}>{label}</p>
        {!done && children}
      </div>
    </div>
  );
}

function NoDataState({ setup, projectPath }: { setup: SetupDetect | null; projectPath?: string }) {
  const sdkInstalled   = setup?.providers.includes('@trimwares/trace') ?? false;
  const llmProvider    = setup?.providers.find(p => p !== '@trimwares/trace');
  const hasLLMDeps     = !!llmProvider;
  const hasPkg         = setup?.hasPackageJson ?? true;
  const looksUnrelated = setup != null && !hasPkg && !sdkInstalled;

  const wrapSnippet = `import { trimwares } from '@trimwares/trace';
${llmProvider?.includes('anthropic')
  ? "import Anthropic from '@anthropic-ai/sdk';\n\nconst anthropic = trimwares.anthropic(new Anthropic());"
  : "import OpenAI from 'openai';\n\nconst openai = trimwares.openai(new OpenAI());"}`;

  return (
    <div className="max-w-lg mx-auto py-12">
      <div className="flex items-center gap-3 mb-8">
        <Zap className="w-5 h-5 text-green-500" />
        <div>
          <p className="text-white font-medium">Set up Trimwares Trace</p>
          {projectPath && (
            <p className="text-[11px] text-[#7c7c7c] font-mono mt-0.5 truncate">{projectPath}</p>
          )}
        </div>
      </div>

      {looksUnrelated && (
        <div className="mb-6 rounded-lg border border-[#2a2010] bg-[#130f05] px-4 py-3">
          <p className="text-xs text-amber-500 font-medium mb-0.5">Folder may not be a code project</p>
          <p className="text-[11px] text-[#9a9a9a] leading-relaxed">
            No <code className="font-mono">package.json</code> detected here. If you added this folder by mistake, switch projects in the sidebar.
            Otherwise, initialize your project first (<code className="font-mono">npm init</code>) then come back.
          </p>
        </div>
      )}

      <div>
        <Step done label="Register this project"><></></Step>

        <Step done={sdkInstalled} label="Install the SDK">
          <div className="space-y-2">
            {!hasPkg && (
              <>
                <p className="text-[11px] text-[#7c7c7c] mb-1">Initialize your project first:</p>
                <code className="block text-xs font-mono text-[#9a9a9a] bg-[#090909] border border-[#1c1c1c] rounded-lg px-4 py-2.5 mb-2">
                  npm init -y
                </code>
              </>
            )}
            <code className="block text-xs font-mono text-[#9a9a9a] bg-[#090909] border border-[#1c1c1c] rounded-lg px-4 py-2.5">
              npm install @trimwares/trace
            </code>
          </div>
        </Step>

        <Step done={false} label="Wrap your LLM client">
          <div className="space-y-2">
            {!hasLLMDeps && hasPkg && (
              <p className="text-[11px] text-[#7c7c7c] mb-1">
                No LLM SDK detected yet — install one alongside Trace (<code className="font-mono">openai</code>, <code className="font-mono">@anthropic-ai/sdk</code>, etc.)
              </p>
            )}
            <pre className="text-xs font-mono text-[#9a9a9a] bg-[#090909] border border-[#1c1c1c] rounded-lg px-4 py-3 overflow-x-auto whitespace-pre">
              {wrapSnippet}
            </pre>
            <p className="text-[11px] text-[#7c7c7c]">
              Run your app — data appears here within seconds. Nothing is blocked or rate-limited.
            </p>
          </div>
        </Step>
      </div>
    </div>
  );
}
