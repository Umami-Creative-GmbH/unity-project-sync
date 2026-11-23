import { IconArrowsLeftRight, IconBolt, IconInfoCircle, IconSearch } from "@tabler/icons-react";

import { FolderCard, InlineNotice } from "@/components/folder-card";
import { ScopeEditor } from "@/components/scope-editor";
import { ShutdownSwitch } from "@/components/shutdown-switch";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProjectInfo, SyncScope } from "@/lib/types";

export interface FolderState {
  path: string | null;
  info: ProjectInfo | null;
  inspecting: boolean;
}

interface SetupPanelProps {
  source: FolderState;
  target: FolderState;
  scope: SyncScope;
  scopeIsDefault: boolean;
  /** Target exists, is non-empty and is not a Unity project. */
  targetNeedsAck: boolean;
  targetAck: boolean;
  shutdownAfter: boolean;
  /** Why Scan/Sync now are disabled; null when ready. */
  blocker: string | null;
  disabled?: boolean;
  onBrowse: (role: "source" | "target") => void;
  onSwap: () => void;
  onScopeChange: (scope: SyncScope) => void;
  onScopeReset: () => void;
  onTargetAckChange: (v: boolean) => void;
  onShutdownAfterChange: (v: boolean) => void;
  onScan: () => void;
  onSyncNow: () => void;
}

export function SetupPanel(props: SetupPanelProps) {
  const { source, target, disabled } = props;
  const sourceInfo = source.info;
  const targetInfo = target.info;
  const versionMismatch =
    sourceInfo?.unityVersion &&
    targetInfo?.unityVersion &&
    sourceInfo.unityVersion !== targetInfo.unityVersion;

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Folders" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start">
        <FolderCard
          role="source"
          path={source.path}
          info={sourceInfo}
          inspecting={source.inspecting}
          disabled={disabled}
          onBrowse={() => props.onBrowse("source")}
        >
          {source.path && sourceInfo && !sourceInfo.exists && (
            <InlineNotice variant="destructive">This folder doesn't exist.</InlineNotice>
          )}
          {sourceInfo?.exists && !sourceInfo.isUnityProject && (
            <InlineNotice variant="warning">
              The source must be a Unity project (with <span className="font-mono">Assets</span> and{" "}
              <span className="font-mono">ProjectSettings</span> folders).
            </InlineNotice>
          )}
        </FolderCard>

        <div className="flex justify-center sm:pt-12">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                onClick={props.onSwap}
                disabled={disabled || (!source.path && !target.path)}
                aria-label="Swap source and target"
              >
                <IconArrowsLeftRight className="rotate-90 sm:rotate-0" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Swap source and target</TooltipContent>
          </Tooltip>
        </div>

        <FolderCard
          role="target"
          path={target.path}
          info={targetInfo}
          inspecting={target.inspecting}
          disabled={disabled}
          onBrowse={() => props.onBrowse("target")}
        >
          {props.targetNeedsAck && (
            <div className="flex flex-col gap-2">
              <InlineNotice variant="warning">
                This folder isn't empty and isn't a Unity project. Anything inside the sync scope that doesn't exist in
                the source will be <strong>deleted</strong> here.
              </InlineNotice>
              <div className="flex items-start gap-2 px-0.5">
                <Checkbox
                  id="target-ack"
                  className="mt-0.5"
                  checked={props.targetAck}
                  disabled={disabled}
                  onCheckedChange={(v) => props.onTargetAckChange(v === true)}
                />
                <Label htmlFor="target-ack" className="text-xs leading-snug font-normal">
                  I understand — use this folder as the target anyway.
                </Label>
              </div>
            </div>
          )}
          {versionMismatch && (
            <InlineNotice variant="info">
              Different Unity version than the source ({sourceInfo!.unityVersion}). The target will take the
              source's version.
            </InlineNotice>
          )}
        </FolderCard>
      </section>

      <ScopeEditor
        scope={props.scope}
        isDefault={props.scopeIsDefault}
        sourceInfo={sourceInfo}
        disabled={disabled}
        onChange={props.onScopeChange}
        onReset={props.onScopeReset}
      />

      <ShutdownSwitch
        id="shutdown-after"
        checked={props.shutdownAfter}
        onCheckedChange={props.onShutdownAfterChange}
      />

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
        <div className="min-h-5 flex-1 text-xs text-muted-foreground">
          {props.blocker && (
            <span className="inline-flex items-center gap-1.5">
              <IconInfoCircle className="size-3.5 shrink-0" />
              {props.blocker}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper so the tooltip still works while the button is disabled */}
              <span className="flex-1 sm:flex-none" tabIndex={props.blocker ? 0 : -1}>
                <Button
                  variant="outline"
                  size="lg"
                  className="w-full"
                  onClick={props.onSyncNow}
                  disabled={disabled || !!props.blocker}
                >
                  <IconBolt data-icon="inline-start" />
                  Sync now
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Scan and sync right away — skips the preview</TooltipContent>
          </Tooltip>
          <Button
            size="lg"
            className="flex-1 sm:flex-none sm:px-5"
            onClick={props.onScan}
            disabled={disabled || !!props.blocker}
          >
            <IconSearch data-icon="inline-start" />
            Scan
          </Button>
        </div>
      </div>
    </div>
  );
}
