import { useEffect, useState } from "react";

import { api, errorMessage } from "@/lib/api";
import type { ProjectInfo } from "@/lib/types";

interface ProjectInfoState {
  info: ProjectInfo | null;
  loading: boolean;
  error: string | null;
}

/** Runs `inspect_project` whenever `path` (or `refreshKey`) changes; ignores stale responses. */
export function useProjectInfo(path: string | null, refreshKey: number): ProjectInfoState {
  const [state, setState] = useState<ProjectInfoState & { path: string | null }>({
    path: null,
    info: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!path) {
      setState({ path: null, info: null, loading: false, error: null });
      return;
    }
    let stale = false;
    // Keep the previous info while re-inspecting the same path (avoids badge flicker on refresh).
    setState((s) => (s.path === path ? { ...s, loading: true } : { path, info: null, loading: true, error: null }));
    api
      .inspectProject(path)
      .then((info) => {
        if (!stale) setState({ path, info, loading: false, error: null });
      })
      .catch((err) => {
        if (!stale) setState({ path, info: null, loading: false, error: errorMessage(err) });
      });
    return () => {
      stale = true;
    };
  }, [path, refreshKey]);

  // Never expose info that belongs to a different path than the current one.
  if (state.path !== path) return { info: null, loading: !!path, error: null };
  return { info: state.info, loading: state.loading, error: state.error };
}
