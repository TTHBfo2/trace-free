'use client';

import { ProjectProvider } from '@/hooks/useProject';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return <ProjectProvider>{children}</ProjectProvider>;
}
