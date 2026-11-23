import { IconInfoCircle, IconLock } from "@tabler/icons-react";

import { ACTION_META } from "@/components/plan-meta";
import { SettingRow, SettingsGroup, SettingsPage } from "@/components/settings/settings-layout";
import { toneText } from "@/components/tone";
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useThreadInfo } from "@/hooks/use-thread-info";
import { resolvedThreadCount, sanitizeThreads, threadChoices } from "@/lib/settings";
import type { AppSettings, PlanAction } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SyncSettingsProps {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  /** A scan or sync is running: thread settings are locked until it has finished. */
  busy: boolean;
  /** The stored settings haven't arrived yet: the controls wait instead of showing defaults. */
  loading?: boolean;
}

export function SyncSettings({ settings, onChange, busy, loading = false }: SyncSettingsProps) {
  const info = useThreadInfo();
  const locked = busy || loading;
  const threadsDisabled = locked || !settings.multiThreaded;
  const effective = resolvedThreadCount(settings, info);

  const threadsDescription = !settings.multiThreaded
    ? "One thread while multi-threaded sync is off."
    : settings.threads === "auto"
      ? `Auto uses one thread per logical CPU, at most 16 (${info.autoThreads} on this PC).`
      : `${settings.threads} files are scanned, copied, verified or deleted at the same time.`;

  return (
    <SettingsPage>
      <SettingsGroup
        title="Performance"
        footer={
          busy ? (
            <>
              <IconLock className={cn("mt-px size-3.5 shrink-0", toneText.warning)} />
              <span>
                A scan or sync is running and keeps the threads it started with. These settings can be changed again
                once it has finished.
              </span>
            </>
          ) : (
            <>
              <IconInfoCircle className="mt-px size-3.5 shrink-0" />
              <span>
                Applies from the next scan or sync, which will use{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {effective} {effective === 1 ? "thread" : "threads"}
                </span>
                .
              </span>
            </>
          )
        }
      >
        <SettingRow
          label="Multi-threaded sync"
          labelFor="setting-multi-threaded"
          disabled={locked}
          description="Scan, copy, verify and delete several files at once. Fastest on SSDs; turn it off for hard disks (HDD) and network shares, where parallel access makes the drive seek."
          control={
            <Switch
              id="setting-multi-threaded"
              checked={settings.multiThreaded}
              disabled={locked}
              onCheckedChange={(v) => onChange({ multiThreaded: v })}
            />
          }
        />
        <SettingRow
          label="Threads"
          disabled={threadsDisabled}
          description={threadsDescription}
          control={({ labelId, descriptionId }) => (
            <Select
              value={String(settings.threads)}
              disabled={threadsDisabled}
              onValueChange={(v) => {
                const threads = sanitizeThreads(v === "auto" ? "auto" : Number(v));
                if (threads !== null) onChange({ threads });
              }}
            >
              <SelectTrigger
                className="w-44 tabular-nums"
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="auto">
                    Auto <span className="text-muted-foreground">({info.autoThreads} on this PC)</span>
                  </SelectItem>
                </SelectGroup>
                <SelectSeparator />
                <SelectGroup>
                  {threadChoices(settings.threads).map((n) => (
                    <SelectItem key={n} value={String(n)} className="tabular-nums">
                      {n} threads
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        />
      </SettingsGroup>

      <ChangeDetection />
    </SettingsPage>
  );
}

const RULES: { action: PlanAction | "unchanged"; when: string; then: string }[] = [
  { action: "copy", when: "Missing in the target", then: "copied" },
  { action: "update", when: "Size differs", then: "overwritten" },
  {
    action: "verify",
    when: "Same size, modification time differs by more than 2\u00a0s",
    then: "contents compared — copied only if they differ",
  },
  { action: "unchanged", when: "Same size and time (within 2\u00a0s)", then: "skipped" },
  { action: "delete", when: "Not in the source", then: "deleted from the target" },
];

/** Read-only: how a scan decides what to do with each file. */
function ChangeDetection() {
  return (
    <SettingsGroup
      title="Change detection"
      description="How a scan decides what happens to each file in the scope. Size comes first; contents are only read when nothing but the time differs."
    >
      <ul className="flex flex-col py-1.5">
        {RULES.map(({ action, when, then }) => {
          const meta = ACTION_META[action];
          const Icon = meta.icon;
          return (
            <li key={action} className="flex items-start gap-3 px-4 py-1.5 text-xs">
              <span className={cn("mt-px flex w-20 shrink-0 items-center gap-1.5 font-medium", toneText[meta.tone])}>
                <Icon className="size-3.5 shrink-0" />
                {meta.label}
              </span>
              <span className="min-w-0 flex-1 text-muted-foreground">
                <span className="text-foreground">{when}</span>
                <span aria-hidden className="px-1.5 text-muted-foreground/60">
                  →
                </span>
                <span className="sr-only">: </span>
                {then}
              </span>
            </li>
          );
        })}
      </ul>
    </SettingsGroup>
  );
}
