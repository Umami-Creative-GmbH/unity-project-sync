import type { ReactNode } from "react";
import { IconBrandGithub, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { AppMark } from "@/components/app-header";
import { SettingRow, SettingsGroup, SettingsPage } from "@/components/settings/settings-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppInfo } from "@/hooks/use-app-info";
import { useThreadInfo } from "@/hooks/use-thread-info";
import { errorMessage } from "@/lib/api";
import { APP_AUTHOR, APP_NAME, APP_TAGLINE, COPYRIGHT, SOURCE_URL } from "@/lib/app-info";
import { UPDATES_ENABLED } from "@/lib/updates";

const SOURCE_LABEL = SOURCE_URL.replace(/^https:\/\//, "");

export function AboutSettings() {
  const app = useAppInfo();
  const threads = useThreadInfo();

  const openSource = () => {
    openUrl(SOURCE_URL).catch((e) => toast.error("Couldn't open the browser", { description: errorMessage(e) }));
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
          description="Current version of the application."
          control={
            <>
              {!UPDATES_ENABLED && <Badge variant="secondary">Coming soon</Badge>}
              {/* TODO(updates): enable once checkForUpdates() in src/lib/updates.ts is wired up. */}
              <Button variant="outline" size="sm" disabled={!UPDATES_ENABLED} aria-describedby="updates-hint">
                <IconRefresh data-icon="inline-start" />
                Check for updates
              </Button>
              <span id="updates-hint" className="sr-only">
                Update checks are coming soon.
              </span>
            </>
          }
        />
        <SettingRow
          label="Author"
          control={<span className="text-sm font-medium">{APP_AUTHOR}</span>}
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
            <Button variant="outline" size="sm" onClick={openSource}>
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono tabular-nums">{children}</dd>
    </>
  );
}
