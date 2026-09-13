'use client';

import { useState, useEffect, useCallback } from 'react';
import { useProject } from './useProject';

export interface Recommendation {
  id: string;
  title: string;
  description: string;
  estimatedMonthlySavings: number;
  confidence: number;
  difficulty: 'easy' | 'medium' | 'hard';
  timeToImplement: string;
  category: 'caching' | 'routing' | 'pruning' | 'schema';
  codeSnippet?: string;
  savingsPct?: number;
  observedCount?: number;
  tokensPerRequest?: number | null;
  percentOfSpend?: number | null;
}

export interface RecommendationsApiResponse {
  recommendations: Recommendation[];
  optimizationScore: number | null;
  totalPotentialSavings: number;
}

export function useRecommendationsData(pollMs = 30000) {
  const { project, projectPath } = useProject();
  const [data, setData]       = useState<RecommendationsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  const fetchData = useCallback(() => {
    const params = new URLSearchParams();
    if (projectPath) params.set('projectPath', projectPath);
    else if (project) params.set('project', project);
    const url = `/api/recommendations${params.toString() ? '?' + params : ''}`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d: RecommendationsApiResponse) => { setData(d); setLoading(false); setError(false); })
      .catch(() => { setLoading(false); setError(true); });
  }, [project, projectPath]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, pollMs);
    return () => clearInterval(id);
  }, [fetchData, pollMs]);

  return { data, loading, error };
}
