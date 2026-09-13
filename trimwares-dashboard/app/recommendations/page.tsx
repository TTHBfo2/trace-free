'use client';

import { useState } from 'react';
import { useRecommendationsData, Recommendation } from '@/hooks/useRecommendationsData';
import { ChevronRight, Loader2, Lightbulb, Lock } from 'lucide-react';
import { clsx } from 'clsx';
import { usd } from '@/lib/format';


function confidenceLabel(pct: number): string {
  if (pct >= 95) return 'Seen on every request';
  if (pct >= 88) return 'Seen on most requests';
  if (pct >= 75) return 'Seen frequently';
  return 'Seen occasionally';
}

const DIFFICULTY: Record<string, { label: string; cls: string }> = {
  easy:   { label: 'Easy',   cls: 'text-green-500 bg-[#0c1e10] border-[#1a3820]' },
  medium: { label: 'Medium', cls: 'text-amber-400 bg-[#16100a] border-[#2a1e0a]' },
  hard:   { label: 'Hard',   cls: 'text-red-400   bg-[#1a0b0b] border-[#2e1212]' },
};

/* ─── Hero card (rank 1) ───────────────────────────────────────────────────── */
function HeroCard({ rec }: { rec: Recommendation }) {
  const [expanded, setExpanded] = useState(false);
  const diff = DIFFICULTY[rec.difficulty];

  return (
    <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] overflow-hidden">

      {/* Priority stripe */}
      <div className="px-6 py-2.5 bg-[#0a0a0a] border-b border-[#181818] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        <span className="text-[11px] text-[#7c7c7c] uppercase tracking-widest font-medium">
          Top priority
        </span>
      </div>

      <div className="p-6">
        {/* Title row + savings */}
        <div className="flex items-start justify-between gap-6 mb-5">
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-lg leading-snug">{rec.title}</p>
          </div>
          <div className="text-right flex-shrink-0">
            {rec.savingsPct != null && (
              <p className="text-3xl font-bold text-green-400 leading-none">
                ↓{rec.savingsPct}%
              </p>
            )}
            <p className="text-xs text-[#7c7c7c] mt-1">per request</p>
            <p className="text-sm font-mono text-[#9a9a9a] mt-1.5">{usd(rec.estimatedMonthlySavings)}<span className="text-xs text-[#7c7c7c]">/mo</span></p>
          </div>
        </div>

        {/* Why this matters */}
        <div className="rounded-lg border border-[#181818] bg-[#0a0a0a] px-4 py-3.5 mb-5">
          <p className="text-[11px] text-[#7c7c7c] uppercase tracking-widest mb-2 font-medium">
            Why this matters
          </p>
          <p className="text-sm text-[#9a9a9a] leading-relaxed">
            {rec.description}
          </p>
          {rec.tokensPerRequest != null && rec.tokensPerRequest > 0 && rec.observedCount != null && rec.observedCount > 0 && (
            <p className="text-xs text-[#7c7c7c] mt-2 leading-relaxed">
              Observed{' '}
              <span className="text-[#aaa] font-medium">{rec.tokensPerRequest.toLocaleString()} tokens/request</span>
              {' '}across{' '}
              <span className="text-[#aaa] font-medium">{rec.observedCount} request{rec.observedCount !== 1 ? 's' : ''}</span>
              {' '}this session.
            </p>
          )}
        </div>

        {/* Meta chips */}
        <div className="flex items-center gap-2 flex-wrap mb-5">
          <span className="text-[11px] text-[#7c7c7c]">
            {confidenceLabel(rec.confidence)}
          </span>
          <span className="text-[#707070]">·</span>
          <span className={clsx('text-[11px] font-medium px-2 py-0.5 rounded border', diff.cls)}>
            {diff.label}
          </span>
          <span className="text-[#707070]">·</span>
          <span className="text-[11px] text-[#7c7c7c]">⏱ {rec.timeToImplement}</span>
        </div>

        {/* Implementation */}
        {rec.codeSnippet && (
          <div>
            <button
              onClick={() => setExpanded(e => !e)}
              className="flex items-center gap-1.5 text-[12px] text-[#9a9a9a] hover:text-white transition mb-2"
            >
              <ChevronRight className={clsx('w-3.5 h-3.5 transition-transform', expanded && 'rotate-90')} />
              {expanded ? 'Hide implementation' : 'Show implementation'}
            </button>

            {expanded && (
              <div>
                <pre className="text-xs font-mono text-[#9a9a9a] bg-[#090909] border border-[#1c1c1c] rounded-lg px-4 py-3.5 overflow-x-auto whitespace-pre leading-relaxed">
                  {rec.codeSnippet}
                </pre>
                {/* Inline Developer nudge */}
                <div className="mt-2.5 flex items-center justify-between px-1">
                  <p className="text-[11px] text-[#7c7c7c]">
                    CI gates verify this stays active in production
                  </p>
                  <a
                    href="https://www.trimwares.com/trace"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-green-500 border border-[#1a3820] px-2.5 py-1 rounded-md hover:border-[#2a5030] hover:text-green-400 transition whitespace-nowrap ml-3"
                  >
                    View Developer pricing →
                  </a>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Secondary card (rank 2) ──────────────────────────────────────────────── */
function SecondaryCard({ rec, rank }: { rec: Recommendation; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const diff = DIFFICULTY[rec.difficulty];

  return (
    <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] p-6">
      <div className="flex items-start gap-4">
        {/* Rank */}
        <span className="w-6 h-6 rounded-full bg-[#0a0a0a] border border-[#1c1c1c] text-[#7c7c7c] text-[11px] font-mono flex items-center justify-center flex-shrink-0 mt-0.5">
          {rank}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4 mb-2">
            <p className="text-sm font-semibold text-white">{rec.title}</p>
            <div className="text-right flex-shrink-0">
              {rec.savingsPct != null && (
                <p className="text-xl font-bold text-green-400 leading-none">↓{rec.savingsPct}%</p>
              )}
              <p className="text-xs font-mono text-[#7c7c7c] mt-1">
                {usd(rec.estimatedMonthlySavings)}<span className="text-[#7c7c7c]">/mo</span>
              </p>
            </div>
          </div>

          <p className="text-xs text-[#9a9a9a] leading-relaxed mb-4">{rec.description}</p>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-[#7c7c7c]">{confidenceLabel(rec.confidence)}</span>
            <span className="text-[#3a3a3a]">·</span>
            <span className={clsx('text-[11px] font-medium px-2 py-0.5 rounded border', diff.cls)}>
              {diff.label}
            </span>
            <span className="text-[#3a3a3a]">·</span>
            <span className="text-[11px] text-[#7c7c7c]">⏱ {rec.timeToImplement}</span>
          </div>

          {rec.codeSnippet && (
            <div className="mt-3.5">
              <button
                onClick={() => setExpanded(e => !e)}
                className="flex items-center gap-1.5 text-[11px] text-[#7c7c7c] hover:text-white transition"
              >
                <ChevronRight className={clsx('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
                {expanded ? 'Hide implementation' : 'Show implementation'}
              </button>
              {expanded && (
                <pre className="mt-2 text-xs font-mono text-[#9a9a9a] bg-[#090909] border border-[#1c1c1c] rounded-lg px-4 py-3 overflow-x-auto whitespace-pre leading-relaxed">
                  {rec.codeSnippet}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Compact row (rank 3+) ────────────────────────────────────────────────── */
function CompactRow({ rec, rank, last }: { rec: Recommendation; rank: number; last?: boolean }) {
  const diff = DIFFICULTY[rec.difficulty];

  return (
    <div className={clsx(
      'flex items-center gap-4 px-6 py-4',
      !last && 'border-b border-[#181818]',
    )}>
      <span className="text-[11px] font-mono text-[#707070] w-5 flex-shrink-0">{rank}</span>
      <span className="text-sm text-[#9a9a9a] flex-1 min-w-0 truncate">{rec.title}</span>
      <div className="flex items-center gap-3 flex-shrink-0">
        {rec.savingsPct != null && (
          <span className="text-sm font-semibold text-green-500">↓{rec.savingsPct}%</span>
        )}
        <span className="text-xs font-mono text-[#7c7c7c]">{usd(rec.estimatedMonthlySavings)}/mo</span>
        <span className={clsx('text-[11px] font-medium px-1.5 py-0.5 rounded border hidden sm:block', diff.cls)}>
          {diff.label}
        </span>
      </div>
    </div>
  );
}

/* ─── Page ─────────────────────────────────────────────────────────────────── */
export default function RecommendationsPage() {
  const { data, loading, error } = useRecommendationsData();

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="w-6 h-6 text-[#707070] animate-spin" />
    </div>
  );

  if (error) return (
    <div className="p-6 flex flex-col items-center justify-center py-24 text-center">
      <Lightbulb className="w-8 h-8 text-[#707070] mb-4" />
      <p className="text-[#7c7c7c] text-sm">Dashboard server not running.</p>
      <code className="text-xs text-[#9a9a9a] bg-[#0e0e0e] border border-[#1c1c1c] px-4 py-2 rounded-lg font-mono mt-4">
        npx trimwares serve
      </code>
    </div>
  );

  const { recommendations: recs, totalPotentialSavings } = data!;

  // Free tier: top 3 only
  const visible  = recs.slice(0, 3);
  const hero     = visible[0];
  const second   = visible[1];
  const compact  = visible.slice(2);

  if (!hero) return <AllClear />;

  return (
    <div className="p-8 max-w-[900px] mx-auto space-y-5">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-white">Recommendations</h1>
        <p className="text-[#7c7c7c] text-sm mt-0.5">
          {recs.length} optimization{recs.length !== 1 ? 's' : ''} found
          {totalPotentialSavings > 0 && (
            <> · <span className="text-[#9a9a9a]">{usd(totalPotentialSavings)}/mo total potential</span></>
          )}
        </p>
      </div>

      {/* Hero */}
      <HeroCard rec={hero} />

      {/* Secondary */}
      {second && <SecondaryCard rec={second} rank={2} />}

      {/* Compact list */}
      {compact.length > 0 && (
        <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] overflow-hidden">
          {compact.map((rec, i) => (
            <CompactRow
              key={rec.id}
              rec={rec}
              rank={i + 3}
              last={i === compact.length - 1}
            />
          ))}
        </div>
      )}

      {/* Developer CTA */}
      <div className="rounded-xl border border-[#202020] bg-[#090909] p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="text-white font-semibold text-sm mb-1">
              Don&apos;t let these optimizations regress in production
            </p>
            <p className="text-[#9a9a9a] text-xs leading-relaxed">
              The free tier tracks your current session only. Developer adds CI regression
              gates, 30-day tracking, and auto-validation — so a fix you make today stays fixed.
            </p>
          </div>
          <a
            href="https://www.creem.io/payment/prod_7kmfXSlzBxzWMl3zfjc9wk"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-black bg-green-400 hover:bg-green-300 transition px-3 py-2 rounded-lg flex-shrink-0 whitespace-nowrap"
          >
            Get Developer — $79 once →
          </a>
        </div>

        {/* Locked depth features */}
        <div className="mt-5 pt-4 border-t border-[#181818] grid grid-cols-2 gap-y-2.5 gap-x-6">
          {[
            'Historical recommendation tracking',
            '"Ignored for 45 days" alerts',
            'Cost replay — before vs after',
            'CI check: PR increased prompt cost',
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

function AllClear() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-12 h-12 rounded-full bg-[#0b1a0e] border border-[#1a3020] flex items-center justify-center mb-5">
        <span className="text-green-400 text-xl">✓</span>
      </div>
      <p className="text-white font-semibold text-base mb-2">Looking good</p>
      <p className="text-[#7c7c7c] text-sm max-w-sm leading-relaxed">
        No high-impact optimizations detected. Keep running requests and Trace will surface
        recommendations as your usage patterns develop.
      </p>
    </div>
  );
}
