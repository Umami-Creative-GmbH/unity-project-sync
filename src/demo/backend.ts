// Simulated backend for `pnpm demo`: answers the Tauri commands from src/lib/api.ts and emits the
// same progress events as src-tauri, with data from ./data.ts. Never part of a production build
// (vite.config.ts only aliases the Tauri modules to src/demo/shims in `--mode demo`).
//
// Screenshot helpers on `window.upsDemo` (also usable from the devtools console):
//   upsDemo.pause() / upsDemo.resume()   freeze or continue a running scan/sync
//   upsDemo.pauseAt("Forest Demo", 0.6)  pause once that project's sync reaches 60 %
//   upsDemo.speed = 4                    run the simulation 4x faster (or open with ?speed=4)
// Open with ?shots to hide scrollbars.
import { DEMO_PROJECTS, UNITY_ROOT_DIRS, findDemoProject, planEntries, rng, type DemoProject } from "@/demo/data";
import type {
  CountBytes,
  PlanEntry,
  PlanSummary,
  ProjectInfo,
  ScanProgress,
  SyncProgress,
  SyncReport,
  SyncScope,
  ThreadInfo,
} from "@/lib/types";
import { DEFAULT_SCOPE } from "@/lib/types";

type Handler = (event: { event: string; id: number; payload: unknown }) => void;

const listeners = new Map<string, Map<number, Handler>>();
let nextListenerId = 1;

export function listen(event: string, handler: Handler): () => void {
  const id = nextListenerId++;
  let map = listeners.get(event);
  if (!map) listeners.set(event, (map = new Map()));
  map.set(id, handler);
  return () => map.delete(id);
}

function emit(event: string, payload: unknown) {
  for (const [id, handler] of listeners.get(event) ?? []) handler({ event, id, payload });
}

// ---- controls ---------------------------------------------------------------------------------

const TICK_MS = 100;
const THREADS: ThreadInfo = { logicalCpus: 16, autoThreads: 16, maxThreads: 32 };

const controls = {
  paused: false,
  speed: Number(new URLSearchParams(window.location.search).get("speed")) || 1,
  pauseRule: null as { name: string; fraction: number } | null,
  pause() {
    controls.paused = true;
  },
  resume() {
    controls.paused = false;
  },
  pauseAt(name: string, fraction: number) {
    controls.pauseRule = { name, fraction };
  },
};
(window as unknown as { upsDemo: typeof controls }).upsDemo = controls;

/** Waits one tick of wall time (and while paused); returns the simulated ms that passed. */
async function tick(): Promise<number> {
  do {
    await new Promise((r) => setTimeout(r, TICK_MS));
  } while (controls.paused);
  return TICK_MS * controls.speed;
}

const cancelled = new Set<number>();

class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

// ---- commands ---------------------------------------------------------------------------------

function inspectProject(path: string): ProjectInfo {
  const found = findDemoProject(path);
  const folder = found ? (found.side === "source" ? found.project.sourceFolder : found.project.targetFolder) : null;
  const exists = folder?.exists ?? false;
  const isUnity = exists && folder?.unityVersion != null;
  return {
    path,
    exists,
    isEmpty: false,
    isUnityProject: isUnity,
    unityVersion: isUnity ? folder!.unityVersion : null,
    rootDirs: exists ? UNITY_ROOT_DIRS : [],
    comparePath: path.trim().toLowerCase(),
  };
}

interface StoredPlan {
  project: DemoProject;
  summary: PlanSummary;
  entries: PlanEntry[];
}

const plans = new Map<number, StoredPlan>();
let nextPlanId = 1;

function inScope(path: string, scope: SyncScope): boolean {
  const top = path.split("/")[0];
  return path.includes("/") ? scope.folders.includes(top) : scope.includeRootFiles;
}

function sum(entries: PlanEntry[], action: PlanEntry["action"]): CountBytes {
  const list = entries.filter((e) => e.action === action && !e.isDir);
  return { files: list.length, bytes: list.reduce((s, e) => s + e.size, 0) };
}

async function scan(source: string, target: string, scope: SyncScope, opId: number): Promise<PlanSummary> {
  const found = findDemoProject(source);
  if (!found || found.side !== "source") throw `The source folder doesn't exist: ${source}`;
  const project = found.project;
  const entries = planEntries(project).filter((e) => inScope(e.path, scope));
  const total = project.unchanged.files + entries.length;
  let scanMs = 0;

  // Walk source, then target, then compare, like the backend's three phases.
  for (const [phase, count, ms] of [
    ["source", total + Math.round(total / 9), 1400],
    ["target", project.targetFolder.exists ? total : 0, 1000],
    ["compare", total, 500],
  ] as const) {
    for (let t = 0; t < ms; ) {
      if (cancelled.has(opId)) throw new Cancelled().message;
      const dt = await tick();
      t += dt;
      scanMs += dt;
      const p: ScanProgress = { opId, phase, entries: Math.min(count, Math.round((count * t) / ms)) };
      emit("scan-progress", p);
    }
  }

  const planId = nextPlanId++;
  const del = sum(entries, "delete");
  const copy = sum(entries, "copy");
  const update = sum(entries, "update");
  const verify = sum(entries, "verify");
  const summary: PlanSummary = {
    planId,
    source,
    target,
    scope,
    copy,
    update,
    verify,
    delete: { ...del, dirs: entries.filter((e) => e.action === "delete" && e.isDir).length },
    unchanged: project.unchanged,
    totalBytes: copy.bytes + update.bytes + verify.bytes,
    entries,
    entriesTruncated: false,
    totalEntries: entries.length,
    warnings: [],
    scanMs,
    scanThreads: THREADS.autoThreads,
  };
  plans.set(planId, { project, summary, entries });
  return summary;
}

const COST_PER_FILE = 64 * 1024;

async function runSync(planId: number, opId: number): Promise<SyncReport> {
  const plan = plans.get(planId);
  if (!plan) throw "This scan is no longer available. Scan again.";
  plans.delete(planId);
  const { project, summary, entries } = plan;
  const random = rng(project.seed * 7 + 1);
  const deletes = entries.filter((e) => e.action === "delete");
  const files = entries.filter((e) => e.action !== "delete" && !e.isDir);
  const totalFiles = files.length;
  const totalBytes = summary.totalBytes;
  const threads = Math.max(1, Math.min(THREADS.autoThreads, totalFiles));

  let elapsedMs = 0;
  let doneBytes = 0;
  let doneFiles = 0;
  let deleteDone = 0;
  let bytesPerSec = 0;
  let costPerSec = 0;
  let current: string | null = null;
  const progress = (phase: SyncProgress["phase"]): SyncProgress => {
    const remainingCost = totalBytes - doneBytes + (totalFiles - doneFiles) * COST_PER_FILE;
    return {
      opId,
      phase,
      doneBytes,
      totalBytes,
      doneFiles,
      totalFiles,
      bytesPerSec,
      costPerSec,
      etaSecs: costPerSec > 0 && elapsedMs > 1500 ? remainingCost / costPerSec : null,
      elapsedMs,
      currentFile: current,
      errors: 0,
      deleteDone,
      deleteTotal: deletes.length,
      threads,
    };
  };
  const report = (wasCancelled: boolean): SyncReport => {
    const verifyFiles = files.filter((f) => f.action === "verify");
    const changed = Math.round(verifyFiles.length * 0.25);
    return {
      copied: files.filter((f) => f.action === "copy").length,
      updated: files.filter((f) => f.action === "update").length,
      verifiedIdentical: verifyFiles.length - changed,
      verifiedChanged: changed,
      deletedFiles: deletes.filter((d) => !d.isDir).length,
      deletedDirs: deletes.filter((d) => d.isDir).length,
      bytesWritten: doneBytes - Math.round(summary.verify.bytes * 0.75 * (doneBytes / Math.max(1, totalBytes))),
      durationMs: Math.round(elapsedMs),
      cancelled: wasCancelled,
      errors: [],
      errorCount: 0,
      threads,
    };
  };

  // Deletion phase.
  for (const d of deletes) {
    if (cancelled.has(opId)) return report(true);
    current = d.path;
    deleteDone++;
    if (deleteDone % 4 === 0 || deleteDone === deletes.length) {
      elapsedMs += await tick();
      emit("sync-progress", progress("deleting"));
    }
  }

  // Copy phase: a cost budget per tick (bytes + 64 KiB per file), so small files lower the byte rate.
  let fileIndex = 0;
  let fileDone = 0;
  let smoothed = 0;
  let wave = random() * Math.PI * 2;
  while (fileIndex < files.length) {
    if (cancelled.has(opId)) return report(true);
    const rule = controls.pauseRule;
    if (rule && rule.name === project.name && totalBytes > 0 && doneBytes / totalBytes >= rule.fraction) {
      controls.pauseRule = null;
      controls.paused = true;
    }
    const dt = await tick();
    elapsedMs += dt;
    wave += 0.35;
    const rate = project.costPerSec * (1 + 0.035 * Math.sin(wave) + 0.04 * (random() - 0.5));
    let budget = (rate * dt) / 1000;
    const before = doneBytes;
    while (budget > 0 && fileIndex < files.length) {
      const f = files[fileIndex];
      if (fileDone === 0) budget -= COST_PER_FILE;
      const take = Math.min(f.size - fileDone, Math.max(0, budget));
      fileDone += take;
      budget -= take;
      doneBytes += take;
      current = f.path;
      if (fileDone >= f.size) {
        fileIndex++;
        fileDone = 0;
        doneFiles++;
      }
    }
    const instant = ((doneBytes - before) * 1000) / dt;
    smoothed = smoothed === 0 ? instant : smoothed * 0.7 + instant * 0.3;
    bytesPerSec = smoothed;
    costPerSec = rate;
    emit("sync-progress", progress("copying"));
  }

  current = null;
  elapsedMs += await tick();
  emit("sync-progress", progress("finalizing"));
  return report(false);
}

export async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case "inspect_project":
      await new Promise((r) => setTimeout(r, 60));
      return inspectProject(args.path as string);
    case "default_scope":
      return DEFAULT_SCOPE;
    case "thread_info":
      return THREADS;
    case "scan":
      return scan(args.source as string, args.target as string, args.scope as SyncScope, args.opId as number);
    case "run_sync":
      return runSync(args.planId as number, args.opId as number);
    case "discard_plans":
      for (const id of args.planIds as number[]) plans.delete(id);
      return;
    case "cancel_operation":
      cancelled.add(args.opId as number);
      return;
    case "prepare_settings":
      return null;
    case "backup_settings":
      return "C:\\Users\\demo\\AppData\\Roaming\\de.umami.unityprojectsync\\settings.backup.json";
    case "shutdown_system":
      console.info("[demo] shutdown_system: the demo never shuts anything down");
      return;
    default:
      throw `[demo] unknown command: ${cmd}`;
  }
}

/** Initial content of the demo's (in-memory) settings store. */
export function initialSettings(): Record<string, unknown> {
  const now = Date.now();
  return {
    projects: DEMO_PROJECTS.map((p, i) => ({
      id: `demo-${i + 1}`,
      name: p.name,
      source: p.source,
      target: p.target,
      scope: p.scope ?? DEFAULT_SCOPE,
      targetAck: false,
      lastRun: p.lastRun ? { ...p.lastRun, finishedAt: now + p.lastRun.finishedAt } : null,
    })),
    appSettings: { multiThreaded: true, threads: "auto", theme: "system" },
  };
}
