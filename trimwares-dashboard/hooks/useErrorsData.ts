'use client';

import { useState, useEffect, useCallback } from 'react';
import { useProject } from './useProject';

export interface ErrorEntry {
  timestamp: number;
  provider:  string;
  model:     string;
  error:     string;
  latencyMs: number;
}

export interface ErrorsData {
  errors: ErrorEntry[];
  count:  number;
}

export function useErrorsData(intervalMs = 10000) {
  const { project, projectPath } = useProject();
  const [data,    setData]    = useState<ErrorsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);

  const fetch_ = useCallback(() => {
    const params = new URLSearchParams();
    if (projectPath) params.set('projectPath', projectPath);
    else if (project) params.set('project', project);
    fetch(`/api/errors${params.toString() ? '?' + params : ''}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(d => { setData(d); setLoading(false); setError(false); })
      .catch(() => { setLoading(false); setError(true); });
  }, [project, projectPath]);

  useEffect(() => {
    fetch_();
    const t = setInterval(fetch_, intervalMs);
    return () => clearInterval(t);
  }, [fetch_, intervalMs]);

  return { data, loading, error };
}
