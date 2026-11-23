// Stand-ins for the Tauri modules the app imports, used only by `pnpm demo`: vite.config.ts aliases
// every module named below to this file in `--mode demo`.
import { initialSettings, invoke as demoInvoke, listen as demoListen } from "@/demo/backend";
import pkg from "../../package.json";

// `?shots`: hide scrollbars for clean screenshots (the content itself is unchanged).
if (new URLSearchParams(window.location.search).has("shots")) {
  const style = document.createElement("style");
  style.textContent = "* { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }";
  document.head.append(style);
}

// @tauri-apps/api/core
export const invoke = <T>(cmd: string, args?: Record<string, unknown>) => demoInvoke(cmd, args) as Promise<T>;
export const isTauri = () => true;

// @tauri-apps/api/event
export const listen = async <T>(event: string, handler: (e: { event: string; id: number; payload: T }) => void) =>
  demoListen(event, handler as (e: { event: string; id: number; payload: unknown }) => void);

// @tauri-apps/api/window
export const getCurrentWindow = () => ({
  setTheme: async () => {},
  setTitle: async () => {},
  onFocusChanged: async () => () => {},
});

// @tauri-apps/api/app
export const getVersion = async () => pkg.version;
export const getTauriVersion = async () => "2.12.7";

// @tauri-apps/plugin-store: one in-memory store, reset on every page load.
const data = new Map<string, unknown>(Object.entries(initialSettings()));
const store = {
  get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
  set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
  delete: async (key: string) => data.delete(key),
  has: async (key: string) => data.has(key),
  save: async () => {},
};
export const load = async () => store;

// @tauri-apps/plugin-dialog
export const open = async () => "D:\\Unity\\NewProject";

// @tauri-apps/plugin-opener
export const openUrl = async (url: string) => void window.open(url, "_blank", "noopener");

// @tauri-apps/plugin-updater: always up to date.
export const check = async () => null;
