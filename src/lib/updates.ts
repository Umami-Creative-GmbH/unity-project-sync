// In-app updates via @tauri-apps/plugin-updater (config: src-tauri/tauri.conf.json > plugins >
// updater). The app asks our own update server
//   https://ups.umami-creative.app/api/update/{{target}}/{{arch}}/{{current_version}}
// which answers 204 (no update) or the newest signed release. Downloads are verified against the
// public key in tauri.conf.json before anything runs.
//
// Windows: installing launches the NSIS installer in passive mode (progress bar only) and exits the
// app right away; the installer restarts it when done. A running scan or sync would be killed, so
// the update store refuses to install while one is running (see ./update-store.ts).
//
// This module is the thin adapter around the plugin plus the pure helpers (progress, mapping,
// error texts); the state machine lives in ./update-store.ts.
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";

import { errorMessage } from "@/lib/api";
import { formatBytes, formatPercent } from "@/lib/format";

/** The update request has no timeout of its own; a hanging server must not leave "Checking…". */
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;
/** Whole download (the installer is a few MB); generous for slow connections. */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** What the update server announced. */
export interface AvailableUpdate {
  /** The running version. */
  currentVersion: string;
  version: string;
  /** Release notes (plain text / Markdown: render as text, never as HTML); absent when empty. */
  notes?: string;
  /** Publish date (RFC 3339), when the server sent one. */
  date?: string;
}

/** Bytes received so far; `total` is null while (or if) the size is unknown. */
export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

export const NO_PROGRESS: DownloadProgress = { downloaded: 0, total: null };

/** Operations on an announced update (holds a resource in the backend until closed). */
export interface UpdateHandle {
  /** Downloads the installer and verifies its signature. Rejects on any failure. */
  download(onProgress?: (progress: DownloadProgress) => void): Promise<void>;
  /**
   * Installs the downloaded update. On Windows this never resolves: the app exits and the
   * installer restarts it.
   */
  install(): Promise<void>;
  /** Releases the update and any downloaded bytes. */
  close(): Promise<void>;
}

export type UpdateCheckResult =
  | { status: "up-to-date"; currentVersion: string | null }
  | ({ status: "available" } & AvailableUpdate & UpdateHandle)
  | { status: "error"; message: string };

// ---- pure helpers ------------------------------------------------------------------------------

/** Folds one download event into the progress (Started → Progress per chunk → Finished). */
export function applyDownloadEvent(progress: DownloadProgress, event: DownloadEvent): DownloadProgress {
  switch (event.event) {
    case "Started": {
      const len = event.data.contentLength;
      return { downloaded: 0, total: typeof len === "number" && Number.isFinite(len) && len > 0 ? len : null };
    }
    case "Progress": {
      const chunk = event.data.chunkLength;
      const add = Number.isFinite(chunk) && chunk > 0 ? chunk : 0;
      return { ...progress, downloaded: progress.downloaded + add };
    }
    case "Finished":
      // Without a Content-Length the size is known only now.
      return { downloaded: progress.downloaded, total: progress.total ?? progress.downloaded };
    default:
      return progress;
  }
}

/** 0..1, or null while the size is unknown. */
export function downloadFraction(progress: DownloadProgress): number | null {
  if (progress.total === null || progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.downloaded / progress.total));
}

/** "42% · 2.1 MB of 5 MB", or "2.1 MB" while the size is unknown. */
export function describeProgress(progress: DownloadProgress): string {
  const fraction = downloadFraction(progress);
  if (fraction === null || progress.total === null) return formatBytes(progress.downloaded);
  const done = Math.min(progress.downloaded, progress.total);
  return `${formatPercent(fraction)} · ${formatBytes(done)} of ${formatBytes(progress.total)}`;
}

/** The plugin's update object (the fields read here; mockable). */
export interface PluginUpdateLike {
  currentVersion: string;
  version: string;
  body?: string | null;
  date?: string | null;
}

/** What the UI shows of an update: blank notes and unparsable dates are dropped. */
export function toAvailableUpdate(update: PluginUpdateLike): AvailableUpdate {
  const out: AvailableUpdate = { currentVersion: update.currentVersion, version: update.version.replace(/^v/, "") };
  const notes = typeof update.body === "string" ? update.body.replace(/\r\n?/g, "\n").trim() : "";
  if (notes) out.notes = notes;
  if (typeof update.date === "string" && releaseTime(update.date) !== null) out.date = update.date;
  return out;
}

/** Epoch ms of an RFC 3339 date, or null. */
export function releaseTime(date: string | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isFinite(t) ? t : null;
}

export const NOT_IN_APP_MESSAGE = "Updates can only be checked in the installed app.";

/** A readable message for an updater error (the plugin's own texts are rather technical). */
export function updateErrorMessage(err: unknown, during: "check" | "download" | "install"): string {
  const raw = errorMessage(err);
  const text = raw.toLowerCase();
  if (during === "check" && (text.includes("field was not set") || text.includes("signature"))) {
    // e.g. "the `signature` field was not set on the updater response": nothing was downloaded.
    return "The update server didn't send a valid answer. Try again later.";
  }
  if (text.includes("signature")) {
    return "The downloaded update failed the signature check and was not installed.";
  }
  if (
    text.includes("error sending request") ||
    text.includes("body error") ||
    text.includes("decoding response body") ||
    text.includes("timed out") ||
    text.includes("connect") ||
    text.includes("dns") ||
    text.includes("network")
  ) {
    return during === "check"
      ? "Couldn't reach the update server. Check your internet connection and try again."
      : "The download was interrupted. Check your internet connection and try again.";
  }
  if (text.includes("could not fetch a valid release json")) {
    return "The update server didn't send a valid answer. Try again later.";
  }
  if (text.includes("download request failed")) {
    return "The update couldn't be downloaded from the server. Try again later.";
  }
  if (during === "install") return `The installer couldn't be started: ${raw}`;
  return raw || "Something went wrong.";
}

// ---- plugin adapter ----------------------------------------------------------------------------

/** Wraps the plugin's update object. */
export function toUpdateHandle(update: {
  download(onEvent?: (e: DownloadEvent) => void, options?: { timeout?: number }): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}): UpdateHandle {
  return {
    async download(onProgress) {
      let progress = NO_PROGRESS;
      await update.download(
        (event) => {
          progress = applyDownloadEvent(progress, event);
          onProgress?.(progress);
        },
        { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS },
      );
    },
    install: () => update.install(),
    close: () => update.close(),
  };
}

/** Asks the update server once. Never rejects; outside the Tauri app the result is an error. */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isTauri()) return { status: "error", message: NOT_IN_APP_MESSAGE };
  try {
    const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    if (!update) {
      const currentVersion = await getVersion().catch(() => null);
      return { status: "up-to-date", currentVersion };
    }
    return { status: "available", ...toAvailableUpdate(update), ...toUpdateHandle(update) };
  } catch (e) {
    console.warn("Update check failed:", e);
    return { status: "error", message: updateErrorMessage(e, "check") };
  }
}
