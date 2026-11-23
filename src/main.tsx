import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

import App from "./App";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { appSettings } from "@/hooks/use-app-settings";
import { createThemeController } from "@/lib/theme";
import "./index.css";

// Theme: System (follows the OS live) / Light / Dark. Starts from the startup hint (already applied
// by the inline script in index.html), then follows the stored setting and every change to it.
const theme = createThemeController(
  {
    root: document.documentElement,
    darkQuery: window.matchMedia("(prefers-color-scheme: dark)"),
    storage: (() => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    })(),
    // Title bar matches the chosen theme (null = follow the OS).
    setNativeTheme: (t) => getCurrentWindow().setTheme(t),
  },
  appSettings.get().theme,
);
appSettings.subscribe(() => theme.set(appSettings.get().theme));
void appSettings.load();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
      {/* Raised above the home footer so toasts never cover its sync buttons. */}
      <Toaster position="bottom-right" offset={{ bottom: 80, right: 16 }} richColors={false} closeButton />
    </TooltipProvider>
  </React.StrictMode>,
);
