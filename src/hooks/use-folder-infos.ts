import { useEffect, useMemo, useRef, useState } from "react";

import { api, errorMessage } from "@/lib/api";
import type { ProjectInfo } from "@/lib/types";

export interface FolderInfoState {
  info: ProjectInfo | null;
  loading: boolean;
  error: string | null;
}

const CONCURRENCY = 3;
const DEBOUNCE_MS = 150;

/** Runs `fn` over `items` with at most `limit` calls in flight. */
export async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * True when `state` holds no result yet: missing, or a placeholder of a run that never finished
 * inspecting it (its cleanup may not have removed the placeholder yet when the next run starts).
 */
export function needsInspection(state: FolderInfoState | undefined): boolean {
  return !state || (state.loading && !state.info && !state.error);
}

/**
 * Inspects many folders (the sources and targets of the project list) with limited concurrency.
 * New paths are inspected when they appear; every path is re-inspected when `refreshKey` changes
 * (window focus, after a run). Previous results stay visible while re-inspecting.
 */
export function useFolderInfos(paths: (string | null)[], refreshKey: number): Record<string, FolderInfoState> {
  const unique = useMemo(() => [...new Set(paths.filter((p): p is string => !!p))].sort(), [paths]);
  const key = unique.join("\n");
  const [infos, setInfos] = useState<Record<string, FolderInfoState>>({});
  const infosRef = useRef(infos);
  infosRef.current = infos;
  const lastRefreshRef = useRef<number | null>(null);

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    const refreshAll = lastRefreshRef.current !== refreshKey;
    const todo = refreshAll ? list : list.filter((p) => needsInspection(infosRef.current[p]));
    if (todo.length === 0) return;

    let stale = false;
    let finished = false;
    const timer = window.setTimeout(() => {
      lastRefreshRef.current = refreshKey;
      setInfos((prev) => {
        const next: Record<string, FolderInfoState> = {};
        for (const p of list) next[p] = prev[p] ?? { info: null, loading: false, error: null };
        for (const p of todo) next[p] = { ...next[p], loading: true };
        return next;
      });
      void runLimited(todo, CONCURRENCY, async (path) => {
        if (stale) return;
        let result: FolderInfoState;
        try {
          result = { info: await api.inspectProject(path), loading: false, error: null };
        } catch (e) {
          result = { info: null, loading: false, error: errorMessage(e) };
        }
        if (!stale) setInfos((prev) => (path in prev ? { ...prev, [path]: result } : prev));
      }).then(() => {
        finished = true;
      });
    }, DEBOUNCE_MS);

    return () => {
      stale = true;
      window.clearTimeout(timer);
      // An interrupted refresh-all run doesn't count as a refresh: the next run re-inspects everything.
      if (refreshAll && !finished) lastRefreshRef.current = null;
      // Paths this run never finished: forget never-inspected ones (so the next run picks them
      // up again) and stop the spinner on the others (they keep their previous result).
      setInfos((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const p of todo) {
          const s = next[p];
          if (!s?.loading) continue;
          changed = true;
          if (!s.info && !s.error) delete next[p];
          else next[p] = { ...s, loading: false };
        }
        return changed ? next : prev;
      });
    };
  }, [key, refreshKey]);

  return infos;
}
