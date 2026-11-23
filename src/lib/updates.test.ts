import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  isTauri: vi.fn(() => true),
  getVersion: vi.fn(async () => "0.1.0"),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));

import {
  applyDownloadEvent,
  checkForUpdates,
  describeProgress,
  downloadFraction,
  NO_PROGRESS,
  NOT_IN_APP_MESSAGE,
  toAvailableUpdate,
  updateErrorMessage,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  type DownloadProgress,
} from "@/lib/updates";

function fold(events: DownloadEvent[]): DownloadProgress[] {
  const out: DownloadProgress[] = [];
  let p = NO_PROGRESS;
  for (const e of events) {
    p = applyDownloadEvent(p, e);
    out.push(p);
  }
  return out;
}

beforeEach(() => {
  mocks.check.mockReset();
  mocks.isTauri.mockReset().mockReturnValue(true);
  mocks.getVersion.mockReset().mockResolvedValue("0.1.0");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("applyDownloadEvent", () => {
  it("adds up the chunks of a download with a known size", () => {
    const steps = fold([
      { event: "Started", data: { contentLength: 1000 } },
      { event: "Progress", data: { chunkLength: 400 } },
      { event: "Progress", data: { chunkLength: 600 } },
      { event: "Finished" },
    ]);
    expect(steps).toEqual([
      { downloaded: 0, total: 1000 },
      { downloaded: 400, total: 1000 },
      { downloaded: 1000, total: 1000 },
      { downloaded: 1000, total: 1000 },
    ]);
  });

  it("learns the size only when finished without a Content-Length", () => {
    const steps = fold([
      { event: "Started", data: {} },
      { event: "Progress", data: { chunkLength: 300 } },
      { event: "Finished" },
    ]);
    expect(steps[1]).toEqual({ downloaded: 300, total: null });
    expect(steps[2]).toEqual({ downloaded: 300, total: 300 });
  });

  it("ignores nonsense sizes", () => {
    expect(applyDownloadEvent(NO_PROGRESS, { event: "Started", data: { contentLength: 0 } }).total).toBeNull();
    const p = applyDownloadEvent({ downloaded: 5, total: 10 }, { event: "Progress", data: { chunkLength: -3 } });
    expect(p).toEqual({ downloaded: 5, total: 10 });
  });
});

describe("downloadFraction / describeProgress", () => {
  it("is null while the size is unknown", () => {
    expect(downloadFraction({ downloaded: 10, total: null })).toBeNull();
    expect(describeProgress({ downloaded: 1536, total: null })).toBe("1.5 KB");
  });

  it("is clamped to 0..1", () => {
    expect(downloadFraction({ downloaded: 50, total: 200 })).toBe(0.25);
    expect(downloadFraction({ downloaded: 300, total: 200 })).toBe(1);
    expect(describeProgress({ downloaded: 512 * 1024, total: 2 * 1024 * 1024 })).toBe("25% · 512 KB of 2 MB");
    expect(describeProgress({ downloaded: 3000, total: 2048 })).toBe("100% · 2 KB of 2 KB");
  });
});

describe("toAvailableUpdate", () => {
  it("keeps notes as text and drops blank notes and bad dates", () => {
    expect(
      toAvailableUpdate({
        currentVersion: "0.1.0",
        version: "0.2.0",
        body: "  <b>New</b>\r\n- faster  ",
        date: "2026-11-23T14:05:00Z",
      }),
    ).toEqual({ currentVersion: "0.1.0", version: "0.2.0", notes: "<b>New</b>\n- faster", date: "2026-11-23T14:05:00Z" });
    expect(toAvailableUpdate({ currentVersion: "0.1.0", version: "v0.2.0", body: "  \n ", date: "yesterday" })).toEqual({
      currentVersion: "0.1.0",
      version: "0.2.0",
    });
    expect(toAvailableUpdate({ currentVersion: "0.1.0", version: "0.2.0", body: null, date: null })).toEqual({
      currentVersion: "0.1.0",
      version: "0.2.0",
    });
  });
});

describe("updateErrorMessage", () => {
  it("translates the plugin's errors", () => {
    expect(updateErrorMessage("Could not fetch a valid release JSON from the remote", "check")).toMatch(
      /didn't send a valid answer/,
    );
    expect(updateErrorMessage("error sending request for url (https://x)", "check")).toMatch(/Couldn't reach/);
    expect(updateErrorMessage("error sending request for url (https://x)", "download")).toMatch(/interrupted/);
    expect(updateErrorMessage(new Error("signature verification failed"), "download")).toMatch(/signature check/);
    expect(updateErrorMessage("Download request failed with status: 404 Not Found", "download")).toMatch(
      /couldn't be downloaded/,
    );
    expect(updateErrorMessage("access denied", "install")).toBe("The installer couldn't be started: access denied");
    expect(updateErrorMessage("weird", "check")).toBe("weird");
  });

  it("does not blame the signature check for a bad server answer during the check", () => {
    for (const field of ["signature", "url"]) {
      expect(updateErrorMessage(`the \`${field}\` field was not set on the updater response`, "check")).toBe(
        "The update server didn't send a valid answer. Try again later.",
      );
    }
  });

  it("treats a broken or timed-out response body as a network problem", () => {
    expect(updateErrorMessage("request or response body error", "download")).toMatch(/download was interrupted/);
    expect(updateErrorMessage("error decoding response body for url (https://x)", "check")).toMatch(
      /Couldn't reach the update server/,
    );
  });
});

describe("checkForUpdates", () => {
  it("reports an error outside the Tauri app without calling the plugin", async () => {
    mocks.isTauri.mockReturnValue(false);
    expect(await checkForUpdates()).toEqual({ status: "error", message: NOT_IN_APP_MESSAGE });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("is up to date when the server has nothing newer (204)", async () => {
    mocks.check.mockResolvedValue(null);
    expect(await checkForUpdates()).toEqual({ status: "up-to-date", currentVersion: "0.1.0" });
    expect(mocks.check).toHaveBeenCalledWith({ timeout: UPDATE_CHECK_TIMEOUT_MS });
  });

  it("maps a failed check to an error result (never rejects)", async () => {
    mocks.check.mockRejectedValue("Could not fetch a valid release JSON from the remote");
    const r = await checkForUpdates();
    expect(r.status).toBe("error");
  });

  it("wraps an available update: progress, install and close go to the plugin", async () => {
    const plugin = {
      currentVersion: "0.1.0",
      version: "0.2.0",
      body: "Notes",
      date: "2026-11-23T14:05:00Z",
      download: vi.fn(async (onEvent?: (e: DownloadEvent) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 10 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 4 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 6 } });
        onEvent?.({ event: "Finished" });
      }),
      install: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    mocks.check.mockResolvedValue(plugin);
    const r = await checkForUpdates();
    if (r.status !== "available") throw new Error(`unexpected ${r.status}`);
    expect(r).toMatchObject({ currentVersion: "0.1.0", version: "0.2.0", notes: "Notes", date: "2026-11-23T14:05:00Z" });

    const seen: DownloadProgress[] = [];
    await r.download((p) => seen.push(p));
    expect(plugin.download).toHaveBeenCalledWith(expect.any(Function), { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
    expect(seen.map((p) => p.downloaded)).toEqual([0, 4, 10, 10]);
    expect(seen[seen.length - 1]).toEqual({ downloaded: 10, total: 10 });

    await r.install();
    expect(plugin.install).toHaveBeenCalledTimes(1);
    await r.close();
    expect(plugin.close).toHaveBeenCalledTimes(1);
  });
});
