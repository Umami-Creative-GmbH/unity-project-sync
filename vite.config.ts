import path from "node:path";
import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// `pnpm demo` (vite --mode demo): the UI runs in a normal browser against a simulated backend with
// demo projects (src/demo), e.g. for screenshots. Only this mode swaps the Tauri modules.
const DEMO_SHIMMED = [
  "@tauri-apps/api/core",
  "@tauri-apps/api/event",
  "@tauri-apps/api/window",
  "@tauri-apps/api/app",
  "@tauri-apps/plugin-store",
  "@tauri-apps/plugin-dialog",
  "@tauri-apps/plugin-opener",
  "@tauri-apps/plugin-updater",
];

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      ...(mode === "demo"
        ? DEMO_SHIMMED.map((name) => ({
            find: new RegExp(`^${name.replace(/[/.]/g, "\\$&")}$`),
            replacement: path.resolve(import.meta.dirname, "./src/demo/shims.ts"),
          }))
        : []),
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
  // The app is loaded from disk by the webview, so one larger bundle (recharts for the transfer
  // chart) costs nothing; keep the warning for real surprises.
  build: {
    chunkSizeWarningLimit: 1500,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // The demo gets its own port so it can run next to `pnpm tauri dev`.
    port: mode === "demo" ? 1430 : 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
