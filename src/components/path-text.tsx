import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { splitPath } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * An absolute path that truncates at the *start* (the end of a path is usually what matters),
 * with a tooltip showing the full path. `focusable={false}` drops it from the tab order (when the
 * full path is announced some other way, e.g. a row description); hovering still shows the tooltip.
 */
export function AbsolutePath({
  path,
  className,
  focusable = true,
}: {
  path: string;
  className?: string;
  focusable?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={focusable ? 0 : -1}
          className={cn(
            "min-w-0 truncate text-left font-mono text-xs [direction:rtl] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm",
            className,
          )}
        >
          <bdi>{path}</bdi>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(32rem,90vw)] font-mono break-all">{path}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A relative project path ("Assets/Scenes/Main.unity") whose directory part truncates first so the
 * file name stays visible (a middle-ellipsis effect). Uses a native title for the full path, which
 * stays cheap when hundreds of rows are rendered.
 */
export function RelativePath({
  path,
  isDir,
  className,
}: {
  path: string;
  isDir?: boolean;
  className?: string;
}) {
  const [dir, name] = splitPath(path);
  return (
    <span className={cn("flex min-w-0 font-mono text-xs", className)} title={path}>
      {dir && <span className="min-w-0 truncate text-muted-foreground">{dir}</span>}
      <span className="max-w-[75%] shrink-0 truncate">
        {name}
        {isDir ? "/" : ""}
      </span>
    </span>
  );
}
