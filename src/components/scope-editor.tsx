import { useState } from "react";
import {
  IconAlertTriangle,
  IconFiles,
  IconFolder,
  IconInfoCircle,
  IconPlus,
  IconRestore,
  IconX,
} from "@tabler/icons-react";

import { tone } from "@/components/tone";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { containsName, isAliasProne, isNeverSync } from "@/lib/scope";
import { NEVER_SYNC, type ProjectInfo, type SyncScope } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ScopeEditorProps {
  scope: SyncScope;
  isDefault: boolean;
  /** Source inspection result; used to offer folders and flag missing ones. */
  sourceInfo: ProjectInfo | null;
  disabled?: boolean;
  onChange: (scope: SyncScope) => void;
  onReset: () => void;
}

export function ScopeEditor({ scope, isDefault, sourceInfo, disabled, onChange, onReset }: ScopeEditorProps) {
  const [addOpen, setAddOpen] = useState(false);

  const sourceDirs = sourceInfo?.exists ? sourceInfo.rootDirs : null;
  const addable = (sourceDirs ?? []).filter((d) => !isNeverSync(d) && !isAliasProne(d) && !containsName(scope.folders, d));

  const removeFolder = (name: string) =>
    onChange({ ...scope, folders: scope.folders.filter((f) => f !== name) });
  const addFolder = (name: string) => {
    onChange({ ...scope, folders: [...scope.folders, name] });
    setAddOpen(false);
  };

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Sync scope</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About the sync scope"
                className="rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <IconInfoCircle className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="block max-w-72 leading-relaxed">
              Only these parts are mirrored. Everything else in the target is never read or touched.
              <br />
              Never synced: <span className="font-mono">{NEVER_SYNC.join(", ")}</span>
            </TooltipContent>
          </Tooltip>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onReset} disabled={disabled || isDefault}>
            <IconRestore data-icon="inline-start" />
            Reset to default
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className={cn(
              "flex h-7 items-center gap-2 rounded-full border pr-1 pl-2.5 text-xs transition-colors",
              scope.includeRootFiles ? "bg-secondary" : "border-dashed text-muted-foreground",
            )}
          >
            <IconFiles className="size-3.5" />
            <Label htmlFor="scope-root-files" className="text-xs font-normal">
              Root files
            </Label>
            <Switch
              id="scope-root-files"
              size="sm"
              checked={scope.includeRootFiles}
              disabled={disabled}
              onCheckedChange={(v) => onChange({ ...scope, includeRootFiles: v === true })}
            />
          </div>

          {scope.folders.map((name) => {
            const missing = sourceDirs !== null && !containsName(sourceDirs, name);
            const chip = (
              <div
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-full border pr-0.5 pl-2.5 text-xs",
                  missing ? cn(tone.warning, "border-amber-500/40") : "bg-secondary",
                )}
              >
                {missing ? <IconAlertTriangle className="size-3.5" /> : <IconFolder className="size-3.5" />}
                <span className="font-medium">{name}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-full"
                  disabled={disabled}
                  aria-label={`Remove ${name} from scope`}
                  onClick={() => removeFolder(name)}
                >
                  <IconX />
                </Button>
              </div>
            );
            return missing ? (
              <Tooltip key={name}>
                <TooltipTrigger asChild>{chip}</TooltipTrigger>
                <TooltipContent>Missing in source — will be deleted in target</TooltipContent>
              </Tooltip>
            ) : (
              <div key={name}>{chip}</div>
            );
          })}

          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="rounded-full border-dashed" disabled={disabled}>
                <IconPlus data-icon="inline-start" />
                Add folder
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1.5">
              <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
                Top-level folders in source
              </div>
              {sourceDirs === null ? (
                <p className="px-2 pb-2 text-xs text-muted-foreground">Choose an existing source folder first.</p>
              ) : addable.length === 0 ? (
                <p className="px-2 pb-2 text-xs text-muted-foreground">
                  All available folders are already in the scope.
                </p>
              ) : (
                <div className="flex max-h-56 flex-col overflow-y-auto">
                    {addable.map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => addFolder(dir)}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted"
                      >
                        <IconFolder className="size-4 text-muted-foreground" />
                        <span className="truncate">{dir}</span>
                      </button>
                    ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {!scope.includeRootFiles && scope.folders.length === 0 && (
          <p className="text-xs text-destructive">The scope is empty — enable root files or add a folder.</p>
        )}
      </CardContent>
    </Card>
  );
}
