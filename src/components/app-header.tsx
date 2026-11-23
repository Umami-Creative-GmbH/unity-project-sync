import type { ReactNode } from "react";
import { IconBrandUnity, IconSettings } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function AppHeader({ right, onOpenSettings }: { right?: ReactNode; onOpenSettings?: () => void }) {
  return (
    <header className="shrink-0 border-b bg-background">
      <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
        <AppMark />
        <div className="min-w-0 flex-1 leading-tight">
          <h1 className="text-base font-semibold tracking-tight">Unity Project Sync</h1>
          <p className="truncate text-xs text-muted-foreground">
            Mirror the parts of a Unity project that matter — Library and friends stay untouched.
          </p>
        </div>
        {right}
        {onOpenSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Settings" onClick={onOpenSettings}>
                <IconSettings />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

/** The app's mark (header, About). */
export function AppMark({ size = "default" }: { size?: "default" | "lg" }) {
  return (
    <div
      className={
        size === "lg"
          ? "flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm"
          : "flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"
      }
    >
      <IconBrandUnity className={size === "lg" ? "size-7" : "size-5"} />
    </div>
  );
}
