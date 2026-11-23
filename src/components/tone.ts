// Semantic accent classes (on top of shadcn tokens) used for status badges, tiles and icons.
export const tone = {
  success: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400",
  info: "bg-sky-500/10 text-sky-700 dark:bg-sky-400/10 dark:text-sky-400",
  violet: "bg-violet-500/10 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300",
  destructive: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  muted: "bg-muted text-muted-foreground",
} as const;

export const toneText = {
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-sky-600 dark:text-sky-400",
  violet: "text-violet-600 dark:text-violet-300",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const;

export type Tone = keyof typeof tone;
