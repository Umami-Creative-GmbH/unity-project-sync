// Demo data for `pnpm demo`: a few believable Unity projects and the files a scan "finds".
// Deterministic (seeded), so every run and every screenshot shows the same numbers.
import type { PlanAction, PlanEntry, PlanReason, ProjectLastRun, SyncScope } from "@/lib/types";

const MB = 1024 * 1024;
const KB = 1024;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const UNITY_ROOT_DIRS = ["Assets", "Library", "Logs", "Packages", "ProjectSettings", "Temp", "UserSettings"];

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FileSpec {
  dirs: string[];
  stems: string[];
  suffixes?: string[];
  ext: string;
  /** Bytes, log-uniform between the two. */
  size: [number, number];
  count: number;
}

interface ActionMix {
  action: PlanAction;
  reason: PlanReason;
  specs: FileSpec[];
}

export interface DemoFolder {
  exists: boolean;
  unityVersion: string | null;
}

export interface DemoProject {
  name: string;
  source: string;
  target: string;
  sourceFolder: DemoFolder;
  targetFolder: DemoFolder;
  lastRun: ProjectLastRun | null;
  scope?: SyncScope;
  seed: number;
  changes: ActionMix[];
  /** Folders removed from the target (delete, reason "extra"). */
  deletedDirs: string[];
  unchanged: { files: number; bytes: number };
  /** Copy-phase throughput in cost units per second (bytes + 64 KiB per file), like the backend. */
  costPerSec: number;
}

const ENV = ["Rock", "Pine", "Fern", "Moss", "Cliff", "Birch", "Grass", "Log", "Stump", "Bush", "Mushroom", "Root"];
const PROPS = ["Crate", "Barrel", "Lantern", "Fence", "Cart", "Signpost", "Well", "Bridge", "Campfire", "Tent"];
const CHARS = ["Ranger", "Wolf", "Owl", "Deer", "Fox", "Boar"];
const TEX = ["_Albedo", "_Normal", "_Mask", "_Height"];
const CARS = ["Coupe", "Rally", "Muscle", "Truck", "Buggy", "GT"];
const TRACKS = ["Canyon", "Harbor", "Alpine", "Desert", "Downtown"];
const UI = ["Button", "Toggle", "Slider", "Panel", "Tab", "Tooltip", "Dropdown", "Badge", "Card", "Dialog", "Avatar", "Chip"];
const ICONS = ["home", "settings", "user", "search", "bell", "star", "heart", "trash", "edit", "play", "pause", "lock", "map", "gift", "coin", "gem", "shield", "sword", "bag", "chat"];
const SCRIPTS = ["Controller", "Manager", "Spawner", "Pool", "Input", "Camera", "Audio", "Save", "Weather", "Quest", "Inventory", "Health"];

export const DEMO_PROJECTS: DemoProject[] = [
  {
    name: "Forest Demo",
    source: "D:\\Unity\\ForestDemo",
    target: "E:\\Backup\\Unity\\ForestDemo",
    sourceFolder: { exists: true, unityVersion: "6000.0.23f1" },
    targetFolder: { exists: true, unityVersion: "6000.0.23f1" },
    lastRun: { finishedAt: -1 * DAY - 3 * HOUR, outcome: "success", durationMs: 41_000, bytesWritten: 2.1 * 1024 * MB, filesWritten: 612, deleted: 14, errorCount: 0 },
    seed: 11,
    costPerSec: 205 * MB,
    changes: [
      {
        action: "copy",
        reason: "new",
        specs: [
          { dirs: ["Assets/Art/Textures/Environment", "Assets/Art/Textures/Props"], stems: [...ENV, ...PROPS], suffixes: TEX, ext: ".png", size: [900 * KB, 9 * MB], count: 120 },
          { dirs: ["Assets/Art/Models/Environment", "Assets/Art/Models/Props"], stems: [...ENV, ...PROPS], suffixes: ["_LOD0", "_LOD1", "_A", "_B"], ext: ".fbx", size: [400 * KB, 14 * MB], count: 46 },
          { dirs: ["Assets/Audio/Ambience"], stems: ["ForestDay", "ForestNight", "Rain", "Wind", "Creek", "Birds"], suffixes: ["_Loop", "_01", "_02"], ext: ".wav", size: [6 * MB, 38 * MB], count: 12 },
          { dirs: ["Assets/Prefabs/Environment"], stems: ENV, suffixes: ["_A", "_B", "_C", "_Cluster"], ext: ".prefab", size: [8 * KB, 180 * KB], count: 34 },
          { dirs: ["Assets/Art/Materials"], stems: [...ENV, ...PROPS], suffixes: ["_Wet", "_Snow", "_Autumn"], ext: ".mat", size: [3 * KB, 9 * KB], count: 16 },
        ],
      },
      {
        action: "update",
        reason: "size",
        specs: [
          { dirs: ["Assets/Scenes"], stems: ["ForestClearing", "RiverCrossing", "Camp", "MainMenu"], ext: ".unity", size: [2 * MB, 24 * MB], count: 4 },
          { dirs: ["Assets/Scripts/Gameplay", "Assets/Scripts/World"], stems: SCRIPTS, ext: ".cs", size: [2 * KB, 28 * KB], count: 18 },
          { dirs: ["Assets/Art/Materials"], stems: [...ENV, ...CHARS], ext: ".mat", size: [3 * KB, 9 * KB], count: 16 },
          { dirs: ["ProjectSettings"], stems: ["ProjectSettings", "QualitySettings", "TagManager"], ext: ".asset", size: [4 * KB, 90 * KB], count: 3 },
        ],
      },
      {
        action: "verify",
        reason: "mtime",
        specs: [
          { dirs: ["Assets/Art/Textures/Characters"], stems: CHARS, suffixes: TEX, ext: ".png", size: [2 * MB, 12 * MB], count: 14 },
          { dirs: ["Assets/Art/Models/Characters"], stems: CHARS, ext: ".fbx", size: [3 * MB, 22 * MB], count: 6 },
        ],
      },
      {
        action: "delete",
        reason: "extra",
        specs: [{ dirs: ["Assets/Art/Textures/_Old"], stems: ENV, suffixes: ["_Albedo_v1", "_Normal_v1"], ext: ".png", size: [1 * MB, 6 * MB], count: 10 }],
      },
    ],
    deletedDirs: ["Assets/Art/Textures/_Old"],
    unchanged: { files: 5_812, bytes: 9.38 * 1024 * MB },
  },
  {
    name: "Racing Prototype",
    source: "D:\\Unity\\RacingPrototype",
    target: "\\\\nas\\unity-backup\\RacingPrototype",
    sourceFolder: { exists: true, unityVersion: "2022.3.50f1" },
    targetFolder: { exists: true, unityVersion: "2022.3.50f1" },
    lastRun: { finishedAt: -3 * DAY - 5 * HOUR, outcome: "success", durationMs: 96_000, bytesWritten: 860 * MB, filesWritten: 231, deleted: 0, errorCount: 0 },
    seed: 23,
    costPerSec: 108 * MB,
    changes: [
      {
        action: "copy",
        reason: "new",
        specs: [
          { dirs: ["Assets/Vehicles/Models"], stems: CARS, suffixes: ["_Body", "_Wheels", "_Interior"], ext: ".fbx", size: [2 * MB, 18 * MB], count: 14 },
          { dirs: ["Assets/Vehicles/Textures"], stems: CARS, suffixes: TEX, ext: ".png", size: [2 * MB, 11 * MB], count: 22 },
          { dirs: ["Assets/Tracks/Lightmaps"], stems: TRACKS, suffixes: ["_Lightmap-0_comp_light", "_Lightmap-1_comp_light", "_ReflectionProbe-0"], ext: ".exr", size: [8 * MB, 32 * MB], count: 12 },
        ],
      },
      {
        action: "update",
        reason: "size",
        specs: [
          { dirs: ["Assets/Tracks/Scenes"], stems: TRACKS, ext: ".unity", size: [6 * MB, 40 * MB], count: 3 },
          { dirs: ["Assets/Scripts/Vehicles"], stems: ["Drivetrain", "Suspension", "TireModel", "Ghost", "LapTimer"], ext: ".cs", size: [3 * KB, 34 * KB], count: 5 },
          { dirs: ["Packages"], stems: ["manifest", "packages-lock"], ext: ".json", size: [2 * KB, 14 * KB], count: 2 },
        ],
      },
      {
        action: "verify",
        reason: "mtime",
        specs: [{ dirs: ["Assets/Audio/Engines"], stems: CARS, suffixes: ["_Idle", "_High", "_Low"], ext: ".wav", size: [3 * MB, 14 * MB], count: 9 }],
      },
    ],
    deletedDirs: [],
    unchanged: { files: 3_406, bytes: 6.71 * 1024 * MB },
  },
  {
    name: "UI Kit",
    source: "D:\\Unity\\UIKit",
    target: "E:\\Backup\\Unity\\UIKit",
    sourceFolder: { exists: true, unityVersion: "6000.0.23f1" },
    targetFolder: { exists: false, unityVersion: null },
    lastRun: null,
    seed: 37,
    costPerSec: 40 * MB,
    changes: [
      {
        action: "copy",
        reason: "new",
        specs: [
          { dirs: ["Assets/UIKit/Sprites/Icons"], stems: ICONS, suffixes: ["_16", "_24", "_32", "_48", "_64", "_128"], ext: ".png", size: [2 * KB, 60 * KB], count: 118 },
          { dirs: ["Assets/UIKit/Sprites/Frames"], stems: UI, suffixes: ["_Default", "_Hover", "_Pressed", "_Disabled"], ext: ".png", size: [12 * KB, 420 * KB], count: 46 },
          { dirs: ["Assets/UIKit/Prefabs"], stems: UI, suffixes: ["", "_Primary", "_Secondary", "_Ghost", "_Large", "_Small"], ext: ".prefab", size: [6 * KB, 90 * KB], count: 60 },
          { dirs: ["Assets/UIKit/Fonts"], stems: ["Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Inter-Bold", "JetBrainsMono-Regular"], ext: ".ttf", size: [280 * KB, 900 * KB], count: 5 },
          { dirs: ["Assets/UIKit/Scripts"], stems: UI, suffixes: ["View", "Binder", "Animator"], ext: ".cs", size: [1 * KB, 16 * KB], count: 30 },
          { dirs: ["Assets/UIKit/Shaders"], stems: ["RoundedRect", "Blur", "Gradient", "Shadow"], ext: ".shader", size: [3 * KB, 22 * KB], count: 4 },
          { dirs: ["Assets/UIKit/Demo"], stems: ["Gallery", "Showcase"], ext: ".unity", size: [1 * MB, 6 * MB], count: 2 },
          { dirs: ["Packages"], stems: ["manifest", "packages-lock"], ext: ".json", size: [2 * KB, 14 * KB], count: 2 },
          { dirs: ["ProjectSettings"], stems: ["ProjectSettings", "ProjectVersion", "EditorBuildSettings", "GraphicsSettings", "InputManager", "TagManager"], ext: ".asset", size: [1 * KB, 80 * KB], count: 6 },
        ],
      },
    ],
    deletedDirs: [],
    unchanged: { files: 0, bytes: 0 },
  },
  {
    name: "Jam Game 2024",
    source: "F:\\Archive\\JamGame2024",
    target: "E:\\Backup\\Unity\\JamGame2024",
    sourceFolder: { exists: false, unityVersion: null },
    targetFolder: { exists: true, unityVersion: "2022.3.20f1" },
    lastRun: { finishedAt: -41 * DAY, outcome: "success", durationMs: 28_000, bytesWritten: 312 * MB, filesWritten: 1_204, deleted: 0, errorCount: 0 },
    seed: 41,
    costPerSec: 100 * MB,
    changes: [],
    deletedDirs: [],
    unchanged: { files: 0, bytes: 0 },
  },
];

export function findDemoProject(path: string): { project: DemoProject; side: "source" | "target" } | null {
  const key = path.trim().toLowerCase();
  for (const project of DEMO_PROJECTS) {
    if (project.source.toLowerCase() === key) return { project, side: "source" };
    if (project.target.toLowerCase() === key) return { project, side: "target" };
  }
  return null;
}

/** Plan entries of a project (sorted by path), each Assets/ file with its .meta file. */
export function planEntries(project: DemoProject): PlanEntry[] {
  const random = rng(project.seed);
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  const used = new Set<string>();
  const entries: PlanEntry[] = [];
  for (const mix of project.changes) {
    for (const spec of mix.specs) {
      for (let i = 0; i < spec.count; i++) {
        // Re-pick a few times before numbering, so names stay natural.
        let base = "";
        for (let tries = 0; tries < 40 && (!base || used.has(`${base}${spec.ext}`)); tries++) {
          base = `${pick(spec.dirs)}/${pick(spec.stems)}${spec.suffixes ? pick(spec.suffixes) : ""}`;
        }
        let path = `${base}${spec.ext}`;
        for (let n = 2; used.has(path); n++) path = `${base}_${String(n).padStart(2, "0")}${spec.ext}`;
        used.add(path);
        const [min, max] = spec.size;
        const size = Math.round(min * Math.pow(max / min, random()));
        entries.push({ path, action: mix.action, reason: mix.reason, size, isDir: false });
        if (path.startsWith("Assets/")) {
          entries.push({ path: `${path}.meta`, action: mix.action, reason: mix.reason, size: 300 + Math.round(random() * 1800), isDir: false });
        }
      }
    }
  }
  for (const dir of project.deletedDirs) {
    entries.push({ path: dir, action: "delete", reason: "extra", size: 0, isDir: true });
    entries.push({ path: `${dir}.meta`, action: "delete", reason: "extra", size: 400, isDir: false });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
