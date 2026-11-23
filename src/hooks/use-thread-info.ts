import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { fallbackThreadInfo } from "@/lib/settings";
import type { ThreadInfo } from "@/lib/types";

const browserGuess = () => fallbackThreadInfo(typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined);

let cached: Promise<ThreadInfo> | null = null;
let resolved: ThreadInfo | null = null;

function fetchThreadInfo(): Promise<ThreadInfo> {
  cached ??= api
    .threadInfo()
    .catch((e) => {
      console.warn("Could not get the thread info:", e);
      return browserGuess();
    })
    .then((info) => (resolved = info));
  return cached;
}

/** What "Auto" threads means on this PC (asked once; a browser estimate until then). */
export function useThreadInfo(): ThreadInfo {
  const [info, setInfo] = useState<ThreadInfo>(() => resolved ?? browserGuess());
  useEffect(() => {
    let alive = true;
    void fetchThreadInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
