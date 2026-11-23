import type { ReactNode } from "react";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderQuestion,
  IconInfoCircle,
  IconLoader2,
  IconTargetArrow,
  IconCrown,
} from "@tabler/icons-react";

import { AbsolutePath } from "@/components/path-text";
import { tone, type Tone } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ProjectInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

export type FolderRole = "source" | "target";

export interface FolderStatus {
  label: string;
  tone: Tone;
  icon: ReactNode;
}

export function folderStatus(
  role: FolderRole,
  path: string | null,
  info: ProjectInfo | null,
  inspecting: boolean,
): FolderStatus {
  const iconCls = "size-3";
  if (!path) return { label: "Not selected", tone: "muted", icon: <IconCircleDashed className={iconCls} /> };
  if (!info && inspecting)
    return { label: "Checking…", tone: "muted", icon: <IconLoader2 className={cn(iconCls, "animate-spin")} /> };
  if (!info) return { label: "Couldn't inspect", tone: "destructive", icon: <IconCircleX className={iconCls} /> };
  if (!info.exists) {
    return role === "target"
      ? { label: "Will be created", tone: "info", icon: <IconFolderPlus className={iconCls} /> }
      : { label: "Not found", tone: "destructive", icon: <IconCircleX className={iconCls} /> };
  }
  if (info.isUnityProject) {
    return {
      label: info.unityVersion ? `Unity ${info.unityVersion}` : "Unity project",
      tone: "success",
      icon: <IconCircleCheck className={iconCls} />,
    };
  }
  if (info.isEmpty) {
    return role === "target"
      ? { label: "Empty folder", tone: "info", icon: <IconCircleDashed className={iconCls} /> }
      : { label: "Empty folder", tone: "destructive", icon: <IconCircleX className={iconCls} /> };
  }
  return { label: "Not a Unity project", tone: "warning", icon: <IconFolderQuestion className={iconCls} /> };
}

interface FolderCardProps {
  role: FolderRole;
  path: string | null;
  info: ProjectInfo | null;
  inspecting: boolean;
  disabled?: boolean;
  onBrowse: () => void;
  /** Extra content below the path (warnings, acknowledgements). */
  children?: ReactNode;
}

export function FolderCard({ role, path, info, inspecting, disabled, onBrowse, children }: FolderCardProps) {
  const status = folderStatus(role, path, info, inspecting);
  const isSource = role === "source";

  return (
    <Card size="sm" className="min-w-0">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md",
              isSource ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
            )}
          >
            {isSource ? <IconCrown className="size-4" /> : <IconTargetArrow className="size-4" />}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-sm font-medium">{isSource ? "Source" : "Target"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {isSource ? "The truth — never modified" : "Mirrored from source"}
            </div>
          </div>
          <Badge className={cn("max-w-[55%]", tone[status.tone])}>
            {status.icon}
            <span className="truncate">{status.label}</span>
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg border bg-muted/40 px-2.5">
            {path ? (
              <AbsolutePath path={path} className="w-full" />
            ) : (
              <span className="truncate text-xs text-muted-foreground">No folder selected</span>
            )}
          </div>
          <Button
            variant="outline"
            onClick={onBrowse}
            disabled={disabled}
            aria-label={`Browse for ${role} folder`}
          >
            <IconFolderOpen data-icon="inline-start" />
            Browse
          </Button>
        </div>

        {children}
      </CardContent>
    </Card>
  );
}

/** Small inline notice used inside folder cards and elsewhere. */
export function InlineNotice({
  variant,
  children,
  className,
}: {
  variant: "warning" | "destructive" | "info";
  children: ReactNode;
  className?: string;
}) {
  const Icon = variant === "info" ? IconInfoCircle : IconAlertTriangle;
  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg px-2.5 py-2 text-xs leading-relaxed",
        variant === "warning" && tone.warning,
        variant === "destructive" && tone.destructive,
        variant === "info" && tone.info,
        className,
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
