import { clsx } from 'clsx';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface MetricCardProps {
  label:     string;
  value:     string;
  delta?:    number;    // positive = good for savings, negative = good for spend
  deltaGoodWhenPositive?: boolean;
  sub?:      string;
  accent?:   'green' | 'blue' | 'default';
}

export function MetricCard({ label, value, delta, deltaGoodWhenPositive = true, sub, accent = 'default' }: MetricCardProps) {
  const isPositive = delta !== undefined && delta > 0;
  const isGood     = delta !== undefined && (deltaGoodWhenPositive ? isPositive : !isPositive);

  return (
    <div className="bg-[#111] border border-[#1f1f1f] rounded-xl p-5">
      <p className="text-xs text-[#7c7c7c] uppercase tracking-wider mb-3">{label}</p>
      <p className={clsx(
        'text-3xl font-semibold tracking-tight mb-2',
        accent === 'green' && 'text-green-400',
        accent === 'blue'  && 'text-blue-400',
        accent === 'default' && 'text-white',
      )}>
        {value}
      </p>
      {(delta !== undefined || sub) && (
        <div className="flex items-center gap-2">
          {delta !== undefined && (
            <span className={clsx(
              'flex items-center gap-1 text-xs font-medium',
              isGood ? 'text-green-400' : 'text-red-400',
            )}>
              {isPositive
                ? <TrendingUp className="w-3 h-3" />
                : <TrendingDown className="w-3 h-3" />}
              {Math.abs(delta).toFixed(1)}% vs last week
            </span>
          )}
          {sub && !delta && <span className="text-xs text-[#7c7c7c]">{sub}</span>}
        </div>
      )}
    </div>
  );
}
