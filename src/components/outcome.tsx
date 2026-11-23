import type { ComponentType } from "react";
import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleMinus,
  IconCircleX,
  IconPlayerStop,
  type IconProps,
} from "@tabler/icons-react";

import { tone, toneText, type Tone } from "@/components/tone";
import type { ItemOutcome } from "@/lib/batch";
import { cn } from "@/lib/utils";

export interface OutcomeMeta {
  label: string;
  tone: Tone;
  icon: ComponentType<IconProps>;
}

export const OUTCOME_META: Record<ItemOutcome, OutcomeMeta> = {
  success: { label: "Synced", tone: "success", icon: IconCircleCheck },
  warnings: { label: "Synced with warnings", tone: "warning", icon: IconAlertTriangle },
  partial: { label: "Finished with errors", tone: "destructive", icon: IconAlertTriangle },
  cancelled: { label: "Cancelled", tone: "muted", icon: IconPlayerStop },
  failed: { label: "Failed", tone: "destructive", icon: IconCircleX },
  skipped: { label: "Skipped", tone: "warning", icon: IconBan },
  notRun: { label: "Not run", tone: "muted", icon: IconCircleDashed },
  inSync: { label: "Already in sync", tone: "success", icon: IconCircleCheck },
  excluded: { label: "Not included", tone: "muted", icon: IconCircleMinus },
  pending: { label: "Pending", tone: "muted", icon: IconCircleDashed },
};

export function OutcomeIcon({ outcome, className }: { outcome: ItemOutcome; className?: string }) {
  const meta = OUTCOME_META[outcome];
  const Icon = meta.icon;
  return <Icon className={cn("size-4 shrink-0", toneText[meta.tone], className)} aria-label={meta.label} />;
}

/** Round tinted icon used in report headers. */
export function OutcomeMedia({ outcome, className }: { outcome: ItemOutcome; className?: string }) {
  const meta = OUTCOME_META[outcome];
  const Icon = meta.icon;
  return (
    <div className={cn("flex size-12 shrink-0 items-center justify-center rounded-full", tone[meta.tone], className)}>
      <Icon className="size-6" />
    </div>
  );
}
