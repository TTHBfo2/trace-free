'use client';

import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

export interface ProjectEntry {
  name: string;
  path: string | null;
  spend?: number;
  requests?: number;
  providers?: string[];
}

interface ProjectCtx {
  project: string | null;      // label filter (legacy / labels mode)
  projectPath: string | null;  // absolute path (registry mode)
  setProject: (name: string | null, path: string | null) => void;
}

const ProjectContext = createContext<ProjectCtx>({
  project: null,
  projectPath: null,
  setProject: () => {},
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProjectName]    = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);

  function setProject(name: string | null, path: string | null) {
    setProjectName(name);
    setProjectPath(path);
  }

  return (
    <ProjectContext.Provider value={{ project, projectPath, setProject }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  return useContext(ProjectContext);
}
