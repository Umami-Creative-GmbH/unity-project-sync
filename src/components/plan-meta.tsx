import type { ComponentType } from "react";
import { IconEqual, IconFilePlus, IconPencil, IconScale, IconTrash, type IconProps } from "@tabler/icons-react";

import type { Tone } from "@/components/tone";
import type { PlanAction, PlanReason } from "@/lib/types";

export interface ActionMeta {
  /** Tile / tab label. */
  label: string;
  /** Short badge label used on list rows. */
  badge: string;
  description: string;
  tone: Tone;
  icon: ComponentType<IconProps>;
}

export const ACTION_META: Record<PlanAction | "unchanged", ActionMeta> = {
  copy: {
    label: "New",
    badge: "copy",
    description: "Missing in target — will be copied",
    tone: "success",
    icon: IconFilePlus,
  },
  update: {
    label: "Changed",
    badge: "update",
    description: "Size differs — will be overwritten",
    tone: "info",
    icon: IconPencil,
  },
  verify: {
    label: "To verify",
    badge: "verify",
    description: "Same size, different timestamp — contents are compared; copied only if different",
    tone: "violet",
    icon: IconScale,
  },
  delete: {
    label: "Delete",
    badge: "delete",
    description: "Not in source — will be removed from target",
    tone: "destructive",
    icon: IconTrash,
  },
  unchanged: {
    label: "Unchanged",
    badge: "same",
    description: "Identical size and timestamp — skipped",
    tone: "muted",
    icon: IconEqual,
  },
};

export const REASON_LABEL: Record<PlanReason, string> = {
  new: "New in source",
  size: "Size differs",
  mtime: "Timestamp differs",
  type: "File/folder type conflict",
  extra: "Not in source",
  case: "Name differs only in letter case — renamed",
};
