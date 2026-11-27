import { useId, useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconFiles,
  IconFilterOff,
  IconFolder,
  IconInfoCircle,
  IconPlus,
  IconRestore,
  IconX,
} from "@tabler/icons-react";

import { tone, toneText } from "@/components/tone";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  EXCLUDE_PRESETS,
  containsName,
  excludePatternError,
  isAliasProne,
  isExcludedName,
  isNeverSync,
  sameName,
} from "@/lib/scope";
import { MAX_EXCLUDE_PATTERNS, NEVER_SYNC, type ProjectInfo, type SyncScope } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ScopeEditorProps {
  scope: SyncScope;
  isDefault: boolean;
  /** Source inspection result; used to offer folders and flag missing ones. */
  sourceInfo: ProjectInfo | null;
  disabled?: boolean;
  onChange: (scope: SyncScope) => void;
  onReset: () => void;
  /** Text typed in the custom exclusion input but not yet added. */
  onPendingExcludeChange?: (text: string) => void;
}

export function ScopeEditor({
  scope,
  isDefault,
  sourceInfo,
  disabled,
  onChange,
  onReset,
  onPendingExcludeChange,
}: ScopeEditorProps) {
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
              Excluded files are neither copied nor deleted. Patterns match file or folder names at any depth
              inside the scope folders (not the scope folders themselves) (<span className="font-mono">*</span> any text, <span className="font-mono">?</span> one character,
              ignoring case) and also exclude their <span className="font-mono">.meta</span> file.
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

        <ExcludeEditor
          patterns={scope.exclude}
          folders={scope.folders}
          disabled={disabled}
          onChange={(exclude) => onChange({ ...scope, exclude })}
          onPendingChange={onPendingExcludeChange}
        />
      </CardContent>
    </Card>
  );
}

const PRESET_PATTERNS: readonly string[] = EXCLUDE_PRESETS.map((p) => p.pattern);

/** Exclusion patterns: preset toggles, custom pattern chips and an input to add one. */
function ExcludeEditor({
  patterns,
  folders,
  disabled,
  onChange,
  onPendingChange,
}: {
  patterns: string[];
  /** The scope folders: patterns never exclude them, so a pattern naming one gets a warning. */
  folders: string[];
  disabled?: boolean;
  onChange: (patterns: string[]) => void;
  /** Reports the typed but not yet added pattern (trimmed), so saving can't drop it silently. */
  onPendingChange?: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const labelId = useId();

  const custom = patterns.filter((p) => !containsName(PRESET_PATTERNS, p));
  // Scope folders themselves are never excluded (only what lies inside them), so warn when a
  // pattern looks meant for one: remove the folder from the scope instead.
  const shadowed = folders.filter((f) => patterns.some((p) => isExcludedName(f, [p])));
  const remove = (pattern: string) => onChange(patterns.filter((p) => !sameName(p, pattern)));
  const togglePreset = (pattern: string) => {
    if (containsName(patterns, pattern)) return remove(pattern);
    if (patterns.length >= MAX_EXCLUDE_PATTERNS) {
      setError(`At most ${MAX_EXCLUDE_PATTERNS} patterns.`);
      return;
    }
    onChange([...patterns, pattern]);
    setError(null);
  };

  const add = () => {
    const pattern = draft.trim();
    const problem =
      excludePatternError(pattern) ??
      (containsName(patterns, pattern)
        ? "Already excluded."
        : patterns.length >= MAX_EXCLUDE_PATTERNS
          ? `At most ${MAX_EXCLUDE_PATTERNS} patterns.`
          : null);
    if (problem) {
      setError(problem);
      return;
    }
    onChange([...patterns, pattern]);
    setDraft("");
    onPendingChange?.("");
    setError(null);
  };

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <IconFilterOff className="size-3.5" />
          Exclude
        </span>

        {EXCLUDE_PRESETS.map(({ label, pattern }) => {
          const on = containsName(patterns, pattern);
          return (
            <button
              key={pattern}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => togglePreset(pattern)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
                on ? "bg-secondary" : "border-dashed text-muted-foreground hover:text-foreground",
              )}
            >
              {on ? <IconCheck className="size-3.5" /> : <IconPlus className="size-3.5" />}
              <span className={cn(on && "font-medium")}>{label}</span>
              <span className="font-mono text-[0.7rem] opacity-70">{pattern}</span>
            </button>
          );
        })}

        {custom.map((pattern) => (
          <div key={pattern} className="flex h-7 items-center gap-1 rounded-full border bg-secondary pr-0.5 pl-2.5 text-xs">
            <span className="font-mono font-medium">{pattern}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-full"
              disabled={disabled}
              aria-label={`Stop excluding ${pattern}`}
              onClick={() => remove(pattern)}
            >
              <IconX />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Input
          id="custom-exclude"
          value={draft}
          disabled={disabled}
          placeholder="Custom pattern, e.g. *.bak or Recordings"
          aria-label="Custom exclusion pattern"
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className="h-7 max-w-72 font-mono text-xs md:text-xs"
          onChange={(e) => {
            setDraft(e.target.value);
            onPendingChange?.(e.target.value.trim());
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="outline" size="sm" disabled={disabled || !draft.trim()} onClick={add}>
          <IconPlus data-icon="inline-start" />
          Add
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {shadowed.length > 0 && (
        <p className={cn("flex items-center gap-1.5 text-xs", toneText.warning)}>
          <IconAlertTriangle className="size-3.5 shrink-0" />
          Patterns don't exclude scope folders themselves ({shadowed.join(", ")}) — remove them from the scope
          instead.
        </p>
      )}
    </div>
  );
}
