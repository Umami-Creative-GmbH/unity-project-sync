import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The fixed bar under the scrolling content that holds a view's primary actions, so they stay on
 * screen however long the list gets. Layout: status things on the left (shutdown switch, a short
 * note via ActionFooterStatus, which also takes the free space), buttons on the right, primary last.
 * Only one is mounted at a time, so all share the id the "Skip to the actions" link points to.
 */
export function ActionFooter({
  id = "batch-actions",
  label,
  children,
}: {
  id?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <footer id={id} tabIndex={-1} aria-label={label} className="shrink-0 border-t bg-background outline-none">
      <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3 sm:px-6">{children}</div>
    </footer>
  );
}

/** Short status text between the left-hand controls and the buttons; empty, it is just the spacer. */
export function ActionFooterStatus({ children, className }: { children?: ReactNode; className?: string }) {
  return <span className={cn("min-w-0 flex-1 truncate text-xs text-muted-foreground", className)}>{children}</span>;
}
