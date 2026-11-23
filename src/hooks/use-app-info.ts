import { useEffect, useState } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";

import { webViewFromBrands, webViewVersion } from "@/lib/app-info";

export interface AppInfo {
  /** App version from tauri.conf.json; null while loading or outside Tauri. */
  version: string | null;
  tauriVersion: string | null;
  /** e.g. "WebView2 131.0.2903.70"; null when unknown. */
  webView: string | null;
}

let cached: Promise<AppInfo> | null = null;
let resolved: AppInfo | null = null;

interface UADataLike {
  getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[] }>;
}

/** Full engine version via User-Agent Client Hints, falling back to the (reduced) UA string. */
async function fetchWebView(): Promise<string | null> {
  try {
    const data = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
    const values = await data?.getHighEntropyValues(["fullVersionList"]);
    const full = webViewFromBrands(values?.fullVersionList);
    if (full) return full;
  } catch {
    /* not supported */
  }
  return webViewVersion(navigator.userAgent);
}

function fetchAppInfo(): Promise<AppInfo> {
  cached ??= Promise.all([
    getVersion().catch(() => null),
    getTauriVersion().catch(() => null),
    fetchWebView(),
  ]).then(([version, tauriVersion, webView]) => (resolved = { version, tauriVersion, webView }));
  return cached;
}

/** Versions shown in Settings → About (asked once per app session). */
export function useAppInfo(): AppInfo {
  const [info, setInfo] = useState<AppInfo>(
    () => resolved ?? { version: null, tauriVersion: null, webView: webViewVersion(navigator.userAgent) },
  );
  useEffect(() => {
    let alive = true;
    void fetchAppInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
