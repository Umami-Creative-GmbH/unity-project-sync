import type { ReactNode } from "react";
import {
  IconAlertCircle,
  IconBrandGithub,
  IconCircleCheck,
  IconDownload,
  IconExternalLink,
  IconInfoCircle,
  IconLoader2,
  IconLock,
  IconRefresh,
  IconWorld,
} from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { AppMark } from "@/components/app-header";
import { SettingRow, SettingsGroup, SettingsPage } from "@/components/settings/settings-layout";
import { tone, toneText } from "@/components/tone";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAppInfo } from "@/hooks/use-app-info";
import { useThreadInfo } from "@/hooks/use-thread-info";
import { updates, useUpdateState } from "@/hooks/use-update";
import { errorMessage } from "@/lib/api";
import { APP_AUTHOR, APP_NAME, APP_TAGLINE, COPYRIGHT, SOURCE_URL, WEBSITE_URL } from "@/lib/app-info";
import { formatDate } from "@/lib/format";
import { isUpdateInProgress, updateOf, type UpdateState } from "@/lib/update-store";
import { describeProgress, downloadFraction, releaseTime, type AvailableUpdate } from "@/lib/updates";
import { cn } from "@/lib/utils";

const SOURCE_LABEL = SOURCE_URL.replace(/^https:\/\//, "");
const WEBSITE_LABEL = WEBSITE_URL.replace(/^https:\/\//, "");

interface AboutSettingsProps {
  /** A scan or sync is running: installing an update would stop it. */
  busy: boolean;
}

export function AboutSettings({ busy }: AboutSettingsProps) {
  const app = useAppInfo();
  const threads = useThreadInfo();
  const update = useUpdateState();
  const shownUpdate = updateOf(update);
  const checking = update.status === "checking";
  const checkFailed = update.status === "error" && update.during === "check";

  const open = (url: string) => {
    openUrl(url).catch((e) => toast.error("Couldn't open the browser", { description: errorMessage(e) }));
  };

  return (
    <SettingsPage>
      <div className="flex items-center gap-4 px-1">
        <AppMark size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-lg leading-tight font-semibold tracking-tight">{APP_NAME}</h3>
          <p className="text-sm text-muted-foreground">{APP_TAGLINE}.</p>
        </div>
      </div>

      <SettingsGroup title="App">
        <SettingRow
          label={
            <span className="flex items-baseline gap-2">
              Version
              <code className="font-mono text-xs font-normal text-muted-foreground">{app.version ?? "—"}</code>
            </span>
          }
          description={<VersionStatus state={update} />}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={checking || isUpdateInProgress(update)}
              onClick={() => void updates.check()}
            >
              {checking ? (
                <IconLoader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <IconRefresh data-icon="inline-start" />
              )}
              {checking ? "Checking…" : checkFailed ? "Try again" : "Check for updates"}
            </Button>
          }
        />
        {shownUpdate && <UpdateCard state={update} update={shownUpdate} busy={busy} />}
        <SettingRow
          label="Author"
          control={<span className="text-sm font-medium">{APP_AUTHOR}</span>}
        />
        <SettingRow
          label="Website"
          description={<span className="font-mono">{WEBSITE_LABEL}</span>}
          control={
            <Button variant="outline" size="sm" onClick={() => open(WEBSITE_URL)}>
              <IconWorld data-icon="inline-start" />
              Open website
              <IconExternalLink data-icon="inline-end" className="text-muted-foreground" />
            </Button>
          }
        />
        <SettingRow
          label="Source code"
          description={
            // Wraps only after a slash ("github.com/" | "Umami-Creative-GmbH/unity-project-sync").
            <span className="font-mono">
              {SOURCE_LABEL.split("/").map((part, i, all) => (
                <span key={i} className="whitespace-nowrap">
                  {part}
                  {i < all.length - 1 && (
                    <>
                      /<wbr />
                    </>
                  )}
                </span>
              ))}
            </span>
          }
          control={
            <Button variant="outline" size="sm" onClick={() => open(SOURCE_URL)}>
              <IconBrandGithub data-icon="inline-start" />
              View on GitHub
              <IconExternalLink data-icon="inline-end" className="text-muted-foreground" />
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Under the hood">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 px-4 py-3 text-xs">
          <Fact label="Tauri">{app.tauriVersion ?? "—"}</Fact>
          <Fact label="WebView">{app.webView ?? "—"}</Fact>
          <Fact label="Logical CPUs">{threads.logicalCpus}</Fact>
          <Fact label="Auto threads">
            {threads.autoThreads} <span className="text-muted-foreground">(max. {threads.maxThreads} when fixed)</span>
          </Fact>
        </dl>
      </SettingsGroup>

      <p className="px-1 text-center text-xs text-muted-foreground">{COPYRIGHT}</p>
    </SettingsPage>
  );
}

/** One line under "Version": the result of the last check (announced to screen readers). */
function VersionStatus({ state }: { state: UpdateState }) {
  let content: ReactNode;
  switch (state.status) {
    case "checking":
      content = "Checking for updates…";
      break;
    case "up-to-date":
      content = (
        <span className={cn("inline-flex items-center gap-1", toneText.success)}>
          <IconCircleCheck className="size-3.5 shrink-0" />
          You&apos;re up to date.
        </span>
      );
      break;
    case "error":
      content =
        state.during === "check" ? (
          <span className={cn("inline-flex items-start gap-1", toneText.destructive)}>
            <IconAlertCircle className="mt-px size-3.5 shrink-0" />
            <span>Couldn&apos;t check for updates. {state.message}</span>
          </span>
        ) : (
          `Version ${state.update?.version ?? ""} is available.`
        );
      break;
    case "available":
    case "downloading":
    case "installing":
      content = `Version ${state.update.version} is available.`;
      break;
    default:
      content = "Current version of the application.";
  }
  return (
    <span role="status" aria-live="polite">
      {content}
    </span>
  );
}

function UpdateCard({ state, update, busy }: { state: UpdateState; update: AvailableUpdate; busy: boolean }) {
  const released = releaseTime(update.date);
  const downloading = state.status === "downloading";
  const installing = state.status === "installing";
  const downloaded = (state.status === "available" || state.status === "error") && state.downloaded === true;
  // A failed re-check keeps the update; only download/install failures belong to this card.
  const failed = state.status === "error" && state.during !== "check" ? state : null;
  const fraction = downloading ? downloadFraction(state.progress) : null;
  const blocked = busy && !downloading && !installing;

  return (
    <section aria-label={`Update to version ${update.version}`} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", tone.info)}>
          <IconDownload className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm leading-snug font-medium">
            Version <span className="font-mono">{update.version}</span> is available
          </span>
          <span className="text-xs text-muted-foreground">
            {released !== null ? `Released ${formatDate(released)} · ` : ""}
            You have <span className="font-mono">{update.currentVersion}</span>
          </span>
        </div>
      </div>

      {update.notes && (
        // Plain text on purpose: release notes are never rendered as HTML.
        <div
          tabIndex={0}
          role="region"
          aria-label="Release notes"
          className="max-h-40 overflow-y-auto rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap outline-none [scrollbar-width:thin] focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {update.notes}
        </div>
      )}

      {downloading && (
        <div className="flex flex-col gap-1.5">
          <Progress
            // Size unknown (no Content-Length yet): a pulsing full bar instead of an empty one.
            value={fraction === null ? 100 : fraction * 100}
            aria-label="Downloading the update"
            className={cn("h-1.5", fraction === null && "animate-pulse opacity-50 motion-reduce:animate-none")}
          />
          <span className="text-xs text-muted-foreground tabular-nums">
            Downloading… {describeProgress(state.progress)}
          </span>
        </div>
      )}

      {installing && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconLoader2 className="size-3.5 shrink-0 animate-spin" />
          Starting the installer. The app closes now and restarts when the update is installed.
        </p>
      )}

      {failed && (
        <p role="alert" className={cn("flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs", tone.destructive)}>
          <IconAlertCircle className="mt-px size-3.5 shrink-0" />
          <span>{failed.message}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p id="update-install-hint" className="flex min-w-48 flex-1 items-start gap-1.5 text-xs text-muted-foreground">
          {blocked ? (
            <>
              <IconLock className={cn("mt-px size-3.5 shrink-0", toneText.warning)} />
              <span>
                A scan or sync is running. Installing closes the app and would stop it, so this is possible again
                once it has finished.
              </span>
            </>
          ) : (
            <>
              <IconInfoCircle className="mt-px size-3.5 shrink-0" />
              <span>The app closes to install the update and restarts automatically.</span>
            </>
          )}
        </p>
        <Button
          size="sm"
          disabled={blocked || downloading || installing}
          aria-describedby="update-install-hint"
          onClick={() => void updates.install()}
        >
          {downloading || installing ? (
            <IconLoader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <IconDownload data-icon="inline-start" />
          )}
          {downloading
            ? "Downloading…"
            : installing
              ? "Installing…"
              : downloaded
                ? "Install and restart"
                : failed
                  ? "Try again"
                  : "Download and install"}
        </Button>
      </div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono tabular-nums">{children}</dd>
    </>
  );
}
