import { clsx } from 'clsx';

interface LogEntry {
  timestamp:   number;
  requestId:   string;
  provider:    string;
  model:       string;
  cost:        number;
  saved:       number;
  cached:      boolean;
  cacheType:   string;
  nativeCache: boolean;
  latencyMs:   number;
  inputTokens: number;
  outputTokens: number;
}

interface Props {
  entries: LogEntry[];
}

function getStatus(e: LogEntry): { label: string; labelCls: string; rowBorder: string } {
  if (e.cached)
    return {
      label:     'CACHE HIT',
      labelCls:  'text-green-500 bg-[#0b1c0e] border border-[#1a3a20]',
      rowBorder: 'border-l-2 border-l-green-600/50',
    };
  if (e.nativeCache)
    return {
      label:     'PROMPT CACHED',
      labelCls:  'text-cyan-400 bg-[#071a1f] border border-[#0e2d35]',
      rowBorder: 'border-l-2 border-l-cyan-600/40',
    };
  if (e.cost > 0.02)
    return {
      label:     'EXPENSIVE',
      labelCls:  'text-red-400 bg-[#1a0c0c] border border-[#2e1414]',
      rowBorder: '',
    };
  if (e.inputTokens > 3000)
    return {
      label:     'LARGE',
      labelCls:  'text-amber-400 bg-[#16100a] border border-[#2a1e0a]',
      rowBorder: '',
    };
  return { label: '', labelCls: '', rowBorder: '' };
}

function formatCost(n: number): string {
  if (n === 0)    return '$0.00';
  if (n >= 0.01)  return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function SessionLogTable({ entries }: Props) {
  if (entries.length === 0) return null;

  return (
    <div className="rounded-xl border border-[#1c1c1c] bg-[#0e0e0e] overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-[#181818] flex items-center justify-between">
        <p className="text-xs text-[#7c7c7c] uppercase tracking-widest font-medium">Request log</p>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#7c7c7c] font-mono">
            most recent {entries.length}
          </span>
          <span className="text-[#707070]">·</span>
          <span className="text-[11px] text-[#707070] font-mono">.trimwares/session.jsonl</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[#181818]">
              {['Time', 'Provider', 'Model', 'Tokens in/out', 'Cost', 'Saved', 'Status', 'Latency'].map(h => (
                <th
                  key={h}
                  className={clsx(
                    'py-3 px-4 font-medium text-[10px] text-[#7c7c7c] uppercase tracking-widest',
                    h === 'Time' || h === 'Provider' || h === 'Model' || h === 'Status'
                      ? 'text-left'
                      : 'text-right',
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const status = getStatus(e);
              return (
                <tr
                  key={e.requestId}
                  className={clsx(
                    'border-b border-[#141414] last:border-0 hover:bg-[#0a0a0a] transition-colors',
                    status.rowBorder,
                  )}
                >
                  <td className="py-3 px-4 text-[#9a9a9a] font-mono whitespace-nowrap">
                    {formatTime(e.timestamp)}
                  </td>
                  <td className="py-3 px-4 text-[#9a9a9a] capitalize">{e.provider}</td>
                  <td className="py-3 px-4 text-[#9a9a9a] font-mono truncate max-w-[160px]">{e.model}</td>
                  <td className="py-3 px-4 text-right text-[#9a9a9a] font-mono whitespace-nowrap">
                    {e.inputTokens.toLocaleString()} / {e.outputTokens.toLocaleString()}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-[#ccc] whitespace-nowrap">
                    {formatCost(e.cost)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono whitespace-nowrap">
                    {e.saved > 0
                      ? <span className="text-green-400">{formatCost(e.saved)}</span>
                      : <span className="text-[#707070]">—</span>}
                  </td>
                  <td className="py-3 px-4">
                    {status.label
                      ? <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded', status.labelCls)}>{status.label}</span>
                      : <span className="text-[#707070]">—</span>}
                  </td>
                  <td className="py-3 px-4 text-right text-[#9a9a9a] font-mono whitespace-nowrap">
                    {e.latencyMs}ms
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer note */}
      <div className="px-6 py-4 border-t border-[#141414] flex items-center justify-between">
        <span className="text-[11px] text-[#707070]">
          Showing last {entries.length} requests from current session
        </span>
        <a
          href="https://www.trimwares.com/trace"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-[#707070] hover:text-[#7c7c7c] transition flex items-center gap-1"
        >
          <span className="text-[#707070]">🔒</span> Unlimited history in Developer
        </a>
      </div>
    </div>
  );
}
