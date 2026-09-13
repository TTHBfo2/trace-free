'use client';

import { useState, useEffect, useCallback } from 'react';
import { useProject } from './useProject';

export interface ModelRow {
  model: string;
  provider: string;
  requests: number;
  totalCost: number;
  saved: number;
  cacheRate: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelsApiResponse {
  models: ModelRow[];
}

export function useModelsData(pollMs = 10000) {
  const { project, projectPath } = useProject();
  const [data, setData]       = useState<ModelsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  const fetchData = useCallback(() => {
    const params = new URLSearchParams();
    if (projectPath) params.set('projectPath', projectPath);
    else if (project) params.set('project', project);
    const url = `/api/models${params.toString() ? '?' + params : ''}`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d: ModelsApiResponse) => { setData(d); setLoading(false); setError(false); })
      .catch(() => { setLoading(false); setError(true); });
  }, [project, projectPath]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, pollMs);
    return () => clearInterval(id);
  }, [fetchData, pollMs]);

  return { data, loading, error };
}
