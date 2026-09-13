import { clsx } from 'clsx';
import type { SimScenarioResult } from '@/lib/simData';

interface Props { scenarios: SimScenarioResult[] }

const CATEGORY_CONFIG = [
  { key: 'systemPrompt',        label: 'System',  color: 'bg-yellow-500/70',  flagAt: 20 },
  { key: 'toolSchemas',         label: 'Tools',   color: 'bg-orange-500/70',  flagAt: 10 },
  { key: 'ragChunks',           label: 'RAG',     color: 'bg-purple-500/70',  flagAt: 15 },
  { key: 'conversationHistory', label: 'History', color: 'bg-blue-500/50',    flagAt: 20 },
  { key: 'userQuery',           label: 'Query',   color: 'bg-green-500/50',   flagAt: 0  },
  { key: 'outputTokens',        label: 'Output',  color: 'bg-slate-500/50',   flagAt: 0  },
] as const;

const ICON_MAP: Record<string, string> = {
  'Customer Support Bot':              '💬',
  'RAG Knowledge Base':                '📄',
  'AI Agent (Competitive Research)':   '🤖',
  'Coding Assistant (Codebase Context)': '💻',
};

export function ScenarioGrid({ scenarios }: Props) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {scenarios.map(s => {
        const agg = s.attributionBreakdown;

        return (
          <div key={s.name} className="bg-[#111] border border-[#1f1f1f] rounded-xl p-5">
            {/* Card header */}
            <div className="flex items-start gap-3 mb-4">
              <span className="text-xl">{ICON_MAP[s.name] ?? '⚡'}</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{s.name}</p>
                <p className="text-[11px] text-[#7c7c7c] mt-0.5 leading-relaxed">{s.description.split('·')[0].trim()}</p>
              </div>
            </div>

            {/* Stacked bar */}
            <div className="h-2 rounded-full overflow-hidden flex mb-4">
              {CATEGORY_CONFIG.map(cat => {
                const val = (agg as Record<string, { tokens: number; percentOfTotal: number }>)[cat.key];
                if (!val || val.percentOfTotal < 1) return null;
                return (
                  <div
                    key={cat.key}
                    className={clsx('h-full', cat.color)}
                    style={{ width: `${val.percentOfTotal}%` }}
                    title={`${cat.label}: ${val.percentOfTotal.toFixed(1)}%`}
                  />
                );
              })}
            </div>

            {/* Category rows */}
            <div className="space-y-2 mb-4">
              {CATEGORY_CONFIG.map(cat => {
                const val = (agg as Record<string, { tokens: number; percentOfTotal: number }>)[cat.key];
                if (!val || val.tokens === 0) return null;
                const isFlagged = cat.flagAt > 0 && val.percentOfTotal >= cat.flagAt;
                return (
                  <div key={cat.key} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={clsx('w-2 h-2 rounded-sm flex-shrink-0', cat.color)} />
                      <span className="text-xs text-[#9a9a9a]">{cat.label}</span>
                      {isFlagged && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-500 font-medium">
                          ⚠ high
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-[#7c7c7c] font-mono">
                        {val.tokens.toLocaleString()}t
                      </span>
                      <span className="text-xs text-[#9a9a9a] font-mono w-10 text-right">
                        {val.percentOfTotal.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[#1a1a1a]">
              <div>
                <p className="text-[10px] text-[#7c7c7c] mb-0.5">Requests</p>
                <p className="text-sm font-mono text-white">{s.totalRequests}</p>
              </div>
              <div>
                <p className="text-[10px] text-[#7c7c7c] mb-0.5">Cache hit</p>
                <p className="text-sm font-mono text-green-400">{s.cacheHitRate}%</p>
              </div>
              <div>
                <p className="text-[10px] text-[#7c7c7c] mb-0.5">Savings</p>
                <p className="text-sm font-mono text-green-400">{s.savingsPercent}%</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
