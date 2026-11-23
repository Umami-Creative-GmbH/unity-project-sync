import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./index.css";

// Follow the OS light/dark preference.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", darkQuery.matches);
applyTheme();
darkQuery.addEventListener("change", applyTheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
      {/* Raised above the home footer so toasts never cover its sync buttons. */}
      <Toaster position="bottom-right" offset={{ bottom: 80, right: 16 }} richColors={false} closeButton />
    </TooltipProvider>
  </React.StrictMode>,
);
