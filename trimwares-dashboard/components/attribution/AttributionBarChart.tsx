'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { SimScenarioResult } from '@/lib/simData';

interface Props { scenarios: SimScenarioResult[] }

const CATEGORIES = [
  { key: 'systemPrompt',        label: 'System prompt', color: '#eab308' },
  { key: 'toolSchemas',         label: 'Tool schemas',  color: '#f97316' },
  { key: 'ragChunks',           label: 'RAG chunks',    color: '#8b5cf6' },
  { key: 'conversationHistory', label: 'History',       color: '#3b82f6' },
  { key: 'userQuery',           label: 'User query',    color: '#22c55e' },
  { key: 'outputTokens',        label: 'Output',        color: '#64748b' },
] as const;

export function AttributionBarChart({ scenarios }: Props) {
  // Build chart data — one entry per scenario
  const data = scenarios.map(s => ({
    name:       s.name.split(' (')[0].replace('AI Agent', 'Agent'),
    systemPrompt:        s.attributionBreakdown.systemPrompt.percentOfTotal,
    toolSchemas:         s.attributionBreakdown.toolSchemas.percentOfTotal,
    ragChunks:           s.attributionBreakdown.ragChunks.percentOfTotal,
    conversationHistory: s.attributionBreakdown.conversationHistory.percentOfTotal,
    userQuery:           s.attributionBreakdown.userQuery.percentOfTotal,
    outputTokens:        s.attributionBreakdown.outputTokens.percentOfTotal,
  }));

  return (
    <div className="bg-[#111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="mb-5">
        <p className="text-sm font-medium text-white">Token attribution by scenario</p>
        <p className="text-xs text-[#7c7c7c] mt-0.5">% of total tokens per workload type — based on actual test runs</p>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -15, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ fill: '#8a8a8a', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#8a8a8a', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${v}%`}
            domain={[0, 100]}
          />
          <Tooltip
            contentStyle={{ background: '#161616', border: '1px solid #1f1f1f', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#aaa', marginBottom: 6 }}
            formatter={(val: number, name: string) => {
              const cat = CATEGORIES.find(c => c.key === name);
              return [`${val.toFixed(1)}%`, cat?.label ?? name];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: '#8a8a8a', paddingTop: 12 }}
            formatter={(value) => CATEGORIES.find(c => c.key === value)?.label ?? value}
          />
          {CATEGORIES.map(cat => (
            <Bar key={cat.key} dataKey={cat.key} stackId="a" fill={cat.color} radius={cat.key === 'outputTokens' ? [2, 2, 0, 0] : [0, 0, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <p className="text-[10px] text-[#707070] mt-3 text-center">
        Data from: npm run simulate · token counts via tiktoken cl100k_base
      </p>
    </div>
  );
}
