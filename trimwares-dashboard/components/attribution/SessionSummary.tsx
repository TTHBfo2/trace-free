import type { AggregatedAttribution } from '@/lib/simData';
import { clsx } from 'clsx';
import { Lock } from 'lucide-react';

interface Props {
  agg:        AggregatedAttribution;
  entryCount: number;
}

const CATS = [
  {
    key:          'systemPrompt',
    label:        'System prompts',
    barColor:     'bg-yellow-500/70',
    dotColor:     'bg-yellow-400',
    context:      'Sent on every request · Cacheable — ~85% reducible',
    contextCls:   'text-amber-600',
    cacheable:    true,
  },
  {
    key:          'toolSchemas',
    label:        'Tool schemas',
    barColor:     'bg-orange-500/70',
    dotColor:     'bg-orange-400',
    context:      'Sent on every agent step · Cacheable',
    contextCls:   'text-amber-600',
    cacheable:    true,
  },
  {
    key:          'ragChunks',
    label:        'RAG chunks',
    barColor:     'bg-purple-500/70',
    dotColor:     'bg-purple-400',
    context:      'Retrieved context · Cacheable',
    contextCls:   'text-amber-600',
    cacheable:    true,
  },
  {
    key:          'conversationHistory',
    label:        'Conversation history',
    barColor:     'bg-blue-500/50',
    dotColor:     'bg-blue-400',
    context:      'Grows with conversation · Trimmable',
    contextCls:   'text-[#7c7c7c]',
    cacheable:    false,
  },
  {
    key:          'userQuery',
    label:        'User queries',
    barColor:     'bg-green-500/50',
    dotColor:     'bg-green-400',
    context:      'Essential · Cannot reduce',
    contextCls:   'text-[#7c7c7c]',
    cacheable:    false,
  },
  {
    key:          'outputTokens',
    label:        'Output tokens',
    barColor:     'bg-slate-500/50',
    dotColor:     'bg-slate-400',
    context:      'Model response · Irreducible',
    contextCls:   'text-[#7c7c7c]',
    cacheable:    false,
  },
] as const;

export function SessionSummary({ agg, entryCount }: Props) {
  const cacheableTotal = agg.systemPrompt + agg.toolSchemas + agg.ragChunks;
  const cacheablePct   = agg.total > 0 ? (cacheableTotal / agg.total) * 100 : 0;

  const rows = CATS
    .map(cat => ({
      ...cat,
      tokens: agg[cat.key as keyof AggregatedAttribution] as number,
      pct:    agg.total > 0 ? ((agg[cat.key as keyof AggregatedAttribution] as number) / agg.total) * 100 : 0,
    }))
    .filter(r => r.tokens > 0)
    .sort((a, b) => b.pct - a.pct);

  return (
    <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] overflow-hidden">

      {/* Header */}
      <div className="px-6 py-4 border-b border-[#181818] flex items-center justify-between">
        <p className="text-xs text-[#7c7c7c] uppercase tracking-widest font-medium">Token breakdown</p>
        <span className="text-xs text-[#7c7c7c] font-mono">{agg.total.toLocaleString()} tokens · {entryCount} requests</span>
      </div>

      {/* Category rows */}
      <div className="divide-y divide-[#141414]">
        {rows.map(r => (
          <div key={r.key} className="px-6 py-5">
            {/* Label + stats */}
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <span className={clsx('w-2 h-2 rounded-sm flex-shrink-0', r.dotColor)} />
                <span className="text-sm text-white font-medium">{r.label}</span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-xs text-[#7c7c7c] font-mono">{r.tokens.toLocaleString()}t</span>
                <span className="text-sm font-semibold font-mono text-white w-12 text-right">
                  {r.pct.toFixed(1)}%
                </span>
              </div>
            </div>
            {/* Inline progress bar */}
            <div className="h-1.5 bg-[#141414] rounded-full overflow-hidden mb-1.5">
              <div
                className={clsx('h-full rounded-full', r.barColor)}
                style={{ width: `${Math.min(r.pct, 100)}%` }}
              />
            </div>
            {/* Context line */}
            <p className={clsx('text-[11px] leading-relaxed', r.contextCls)}>
              {r.context}
            </p>
          </div>
        ))}
      </div>

      {/* Cacheable insight panel */}
      {cacheablePct > 5 && (
        <div className="mx-6 mb-6 mt-2 rounded-lg border border-[#2a1e0a] bg-[#100c04] px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-amber-400 mb-1">
                {cacheablePct.toFixed(0)}% of your tokens are cacheable
              </p>
              <p className="text-xs text-[#9a9a9a] leading-relaxed">
                These tokens never changed between requests. Provider-native caching bills them
                once, then reuses them — every subsequent request reads from cache at ~85–90% lower cost.
              </p>
            </div>
            <a
              href="https://www.trimwares.com/trace"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[11px] text-[#707070] hover:text-[#7c7c7c] transition flex-shrink-0 mt-0.5 whitespace-nowrap"
            >
              <Lock className="w-2.5 h-2.5" />
              <span>30-day trend</span>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
