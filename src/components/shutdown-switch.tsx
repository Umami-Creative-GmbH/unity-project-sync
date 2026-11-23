import { IconPower } from "@tabler/icons-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ShutdownSwitchProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Single-line variant for toolbars. */
  compact?: boolean;
  className?: string;
}

const HINT = "Only if every project syncs without errors and nothing is cancelled or skipped — with a 60 s countdown to cancel.";

/** "Shutdown after" option. Not persisted — always off on launch. */
export function ShutdownSwitch({ id, checked, onCheckedChange, compact, className }: ShutdownSwitchProps) {
  const icon = (
    <IconPower className={cn("size-4 shrink-0", checked ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} />
  );

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex h-8 items-center gap-2 rounded-lg border bg-card pr-1.5 pl-2.5 transition-colors",
              checked && "border-amber-500/40 bg-amber-500/5",
              className,
            )}
          >
            {icon}
            <Label htmlFor={id} className="text-xs font-medium whitespace-nowrap">
              Shut down after
            </Label>
            <Switch id={id} size="sm" checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} />
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{HINT}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors",
        checked && "border-amber-500/40 bg-amber-500/5",
        className,
      )}
    >
      {icon}
      <div className="min-w-0 flex-1 leading-tight">
        <Label htmlFor={id} className="text-sm font-medium">
          Shut down after sync
        </Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{HINT}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} />
    </div>
  );
}
