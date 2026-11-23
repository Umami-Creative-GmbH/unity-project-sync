import { useEffect, useRef, type ComponentType } from "react";
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconPalette,
  IconRefresh,
  IconX,
  type IconProps,
} from "@tabler/icons-react";

import { AboutSettings } from "@/components/settings/about-settings";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { SyncSettings } from "@/components/settings/sync-settings";
import { tone } from "@/components/tone";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAppInfo } from "@/hooks/use-app-info";
import { appSettings, useAppSettings, useAppSettingsStatus } from "@/hooks/use-app-settings";
import { cn } from "@/lib/utils";

export type SettingsSection = "sync" | "appearance" | "about";

const SECTIONS: { id: SettingsSection; label: string; icon: ComponentType<IconProps> }[] = [
  { id: "sync", label: "Sync", icon: IconRefresh },
  { id: "appearance", label: "Appearance", icon: IconPalette },
  { id: "about", label: "About", icon: IconInfoCircle },
];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A scan or sync is running (thread settings and installing updates are locked meanwhile). */
  busy: boolean;
  /** The section shown (kept by the parent, so e.g. an update toast can open "About"). */
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

/**
 * Settings: sidebar navigation + one section at a time. Changes apply immediately and are saved
 * automatically (no Save button). Below ~700 px of dialog width the sidebar becomes a segmented
 * row under the title (container query on the dialog).
 */
export function SettingsDialog({ open, onOpenChange, busy, section, onSectionChange: setSection }: SettingsDialogProps) {
  const [settings, update] = useAppSettings();
  const status = useAppSettingsStatus();
  const app = useAppInfo();
  const navRef = useRef<HTMLElement>(null);
  const current = SECTIONS.find((s) => s.id === section)!;

  // Opening Settings retries a load that failed earlier (e.g. the file was briefly locked).
  useEffect(() => {
    if (open && appSettings.status() === "failed") void appSettings.load();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="@container flex h-[min(600px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(880px,calc(100%-2rem))]"
        onOpenAutoFocus={(e) => {
          // Start on the selected section's nav item rather than the close button.
          const active = navRef.current?.querySelector<HTMLElement>("[aria-current=page]");
          if (active) {
            e.preventDefault();
            active.focus();
          }
        }}
      >
        <div className="grid min-h-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)] @min-[700px]:grid-cols-[11rem_minmax(0,1fr)] @min-[820px]:grid-cols-[13rem_minmax(0,1fr)] @min-[700px]:grid-rows-[auto_minmax(0,1fr)]">
          {/* Title bar: "Settings / Section" + close. */}
          <div className="flex h-12 min-w-0 items-center gap-2 border-b pr-2 pl-4 @min-[700px]:col-start-2 @min-[700px]:row-start-1 @min-[700px]:pl-6">
            <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 text-sm leading-none">
              <span className="text-muted-foreground">Settings</span>
              <span aria-hidden className="text-muted-foreground/50">
                /
              </span>
              <span className="truncate font-semibold">{current.label}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              Changes apply immediately and are saved automatically.
            </DialogDescription>
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close settings">
                <IconX />
              </Button>
            </DialogClose>
          </div>

          {/* Section navigation: sidebar when wide, segmented row when narrow. */}
          <nav
            ref={navRef}
            aria-label="Settings sections"
            className="border-b px-4 py-2 @min-[700px]:col-start-1 @min-[700px]:row-span-2 @min-[700px]:row-start-1 @min-[700px]:flex @min-[700px]:flex-col @min-[700px]:border-r @min-[700px]:border-b-0 @min-[700px]:bg-muted/30 @min-[700px]:p-2"
          >
            <ul className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-[3px] @min-[700px]:flex @min-[700px]:flex-col @min-[700px]:bg-transparent @min-[700px]:p-0 @min-[700px]:pt-1">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={id === section ? "page" : undefined}
                    onClick={() => setSection(id)}
                    className={cn(
                      "flex h-7 w-full items-center justify-center gap-2 rounded-md px-2 text-sm font-medium text-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      "aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-sm",
                      "@min-[700px]:h-8 @min-[700px]:justify-start @min-[700px]:px-2.5 @min-[700px]:text-muted-foreground @min-[700px]:hover:bg-muted @min-[700px]:aria-[current=page]:bg-muted @min-[700px]:aria-[current=page]:text-foreground @min-[700px]:aria-[current=page]:shadow-none",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                </li>
              ))}
            </ul>
            {/* Sidebar footer (wide only). */}
            <div className="mt-auto hidden px-2.5 pb-1 text-xs text-muted-foreground @min-[700px]:block">
              Unity Project Sync
              {app.version && <code className="ml-1.5 font-mono text-[0.7rem]">{app.version}</code>}
            </div>
          </nav>

          {/* Content. */}
          <div
            key={section}
            className="min-h-0 overflow-y-auto [scrollbar-width:thin] @min-[700px]:col-start-2 @min-[700px]:row-start-2">
            <div className="mx-auto w-full max-w-2xl px-4 py-5 @min-[700px]:px-6">
              {status === "failed" && (
                <div role="status" className={cn("mb-5 flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-xs", tone.warning)}>
                  <IconAlertTriangle className="mt-px size-4 shrink-0" />
                  <span>
                    Your saved settings couldn&apos;t be loaded. Changes apply now but won&apos;t be saved. Reopen
                    Settings or restart the app to try again.
                  </span>
                </div>
              )}
              {section === "sync" && (
                <SyncSettings
                  settings={settings}
                  onChange={update}
                  busy={busy}
                  loading={status === "idle" || status === "loading"}
                />
              )}
              {section === "appearance" && <AppearanceSettings settings={settings} onChange={update} />}
              {section === "about" && <AboutSettings busy={busy} />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
