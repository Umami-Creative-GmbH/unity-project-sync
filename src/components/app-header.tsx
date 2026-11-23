import type { ReactNode } from "react";
import { IconBrandUnity } from "@tabler/icons-react";

export function AppHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="shrink-0 border-b bg-background">
      <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <IconBrandUnity className="size-5" />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <h1 className="text-base font-semibold tracking-tight">Unity Project Sync</h1>
          <p className="truncate text-xs text-muted-foreground">
            Mirror the parts of a Unity project that matter — Library and friends stay untouched.
          </p>
        </div>
        {right}
      </div>
    </header>
  );
}
