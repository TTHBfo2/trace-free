'use client';

import { useState, useEffect, useCallback } from 'react';
import { useProject } from './useProject';

export interface SetupDetect {
  compatible: boolean;
  providers: string[];      // LLM packages found in package.json
  hasExistingData: boolean;
  hasPackageJson: boolean;  // false = not a code project at all
}

export interface DashboardApiResponse {
  hasData: boolean;
  entryCount: number;
  projectPath?: string;
  setup: SetupDetect | null; // non-null only when hasData is false
  optimizationScore: number | null;
  waste: {
    totalGrossSpend: number;
    alreadySaved: number;
    currentSpend: number;
    recoverableSpend: number;
    recoverablePercent: number;
    sessionRequests: number;
    topFix: {
      label: string;
      cost: number;
      percentOfSpend: number;
      severity: string;
      fixDescription?: string;
      projectedMonthlySaving?: number;
    } | null;
    categories: Array<{
      label: string;
      cost: number;
      percentOfSpend: number;
      severity: 'critical' | 'warning' | 'info' | 'good';
      fixDescription?: string;
      projectedMonthlySaving?: number;
    }>;
  };
  attribution: {
    sessionAgg: {
      systemPrompt: number;
      toolSchemas: number;
      ragChunks: number;
      conversationHistory: number;
      userQuery: number;
      outputTokens: number;
      total: number;
    };
    sessionCost: {
      totalCost: number;
      totalSaved: number;
      cacheHitRate: number;
      nativeCacheHitRate: number;
      byModel: Record<string, number>;
      byProvider: Record<string, number>;
    };
    scenarios: Array<{
      name: string;
      description: string;
      totalRequests: number;
      cacheHitRate: number;
      totalCostUsd: number;
      totalSavingsUsd: number;
      savingsPercent: number;
      avgLatencyMs: number;
      providerCallCount: number;
      nativeCacheApplied: boolean;
      attributionBreakdown: {
        systemPrompt:        { tokens: number; percentOfTotal: number };
        toolSchemas:         { tokens: number; percentOfTotal: number };
        ragChunks:           { tokens: number; percentOfTotal: number };
        conversationHistory: { tokens: number; percentOfTotal: number };
        userQuery:           { tokens: number; percentOfTotal: number };
        outputTokens:        { tokens: number; percentOfTotal: number };
      };
    }> | null;
  };
  sessionLog: Array<{
    timestamp: number;
    requestId: string;
    provider: string;
    model: string;
    cost: number;
    saved: number;
    cached: boolean;
    cacheType: string;
    nativeCache: boolean;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export function useDashboardData(pollMs = 2500) {
  const { project, projectPath } = useProject();
  const [data, setData]       = useState<DashboardApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  const fetchData = useCallback(() => {
    const params = new URLSearchParams();
    if (projectPath) params.set('projectPath', projectPath);
    else if (project) params.set('project', project);
    const url = `/api/data${params.toString() ? '?' + params : ''}`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d: DashboardApiResponse) => { setData(d); setLoading(false); setError(false); })
      .catch(() => { setLoading(false); setError(true); });
  }, [project, projectPath]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, pollMs);
    return () => clearInterval(id);
  }, [fetchData, pollMs]);

  return { data, loading, error };
}
