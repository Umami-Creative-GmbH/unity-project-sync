import { IconPower } from "@tabler/icons-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface ShutdownSwitchProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}

/** "Shutdown after" option. Not persisted — always off on launch. */
export function ShutdownSwitch({ id, checked, onCheckedChange, className }: ShutdownSwitchProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors",
        checked && "border-amber-500/40 bg-amber-500/5",
        className,
      )}
    >
      <IconPower className={cn("size-4 shrink-0", checked ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1 leading-tight">
        <Label htmlFor={id} className="text-sm font-medium">
          Shut down after sync
        </Label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Only if the sync completes without errors — with a 60 s countdown to cancel.
        </p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} />
    </div>
  );
}
