// Building blocks of the settings pages: titled groups of rows in a bordered card.
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A titled group of setting rows. */
export function SettingsGroup({
  title,
  description,
  footer,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  /** Muted strip at the bottom of the card (notes that apply to the whole group). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-col gap-0.5 px-1">
        <h3 id={id} className="text-sm font-semibold tracking-tight">
          {title}
        </h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="divide-y">{children}</div>
        {footer && (
          <div className="flex items-start gap-2 border-t bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
            {footer}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One setting: label + description on the left, the control on the right. `labelFor` links the
 * label to a control with that id; otherwise the label's id is passed to `control` for
 * aria-labelledby.
 */
export function SettingRow({
  label,
  description,
  labelFor,
  control,
  disabled,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  labelFor?: string;
  control?: ReactNode | ((ids: { labelId: string; descriptionId: string }) => ReactNode);
  disabled?: boolean;
  className?: string;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const LabelTag = labelFor ? "label" : "div";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3", className)}>
      <div className={cn("flex min-w-48 flex-1 flex-col gap-0.5", disabled && "opacity-60")}>
        <LabelTag id={labelId} htmlFor={labelFor} className="text-sm leading-snug font-medium">
          {label}
        </LabelTag>
        {description && (
          <p id={descriptionId} className="text-xs leading-relaxed text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {control && (
        <div className="flex shrink-0 items-center gap-2">
          {typeof control === "function" ? control({ labelId, descriptionId }) : control}
        </div>
      )}
    </div>
  );
}

/** Page heading of a settings section (screen readers; the dialog title shows it visually). */
export function SettingsPage({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>;
}
