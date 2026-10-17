import * as z from "zod";

/**
 * A routine that starts "when something changes". A checker, not a model,
 * takes a fingerprint of the watched thing on an interval; the routine only
 * runs when the fingerprint differs from the last one.
 *
 * - `files`: paths on the bot's computer (relative paths resolve into the
 *   bot's own folder). Names, sizes and modified times are compared.
 * - `command`: a shell command on the bot's computer; its output is the
 *   fingerprint. A non-zero exit is a failed check.
 * - `tool`: a read-only tool from a connected integration, called with fixed
 *   arguments; its result is the fingerprint.
 */
export const ROUTINE_WATCH_KINDS = ["files", "command", "tool"] as const;
export const ROUTINE_WATCH_DEFAULT_MINUTES = 15;
/** Integration checks call someone else's server; keep them from hammering it. */
export const ROUTINE_WATCH_MIN_TOOL_MINUTES = 5;

export const RoutineWatchSchema = z
  .object({
    kind: z.enum(ROUTINE_WATCH_KINDS),
    paths: z.array(z.string().trim().min(1).max(500)).min(1).max(20).optional(),
    command: z.string().trim().min(1).max(2000).optional(),
    tool: z.string().trim().min(1).max(200).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    everyMinutes: z.number().int().min(1).max(1440).default(ROUTINE_WATCH_DEFAULT_MINUTES),
    /** Post "No changes" in chat on every quiet check, not only in history. */
    loud: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "files" && !value.paths?.length) {
      ctx.addIssue({ code: "custom", message: "Add a file or folder to watch", path: ["paths"] });
    }
    if (value.kind === "command" && !value.command) {
      ctx.addIssue({ code: "custom", message: "Add a command to run", path: ["command"] });
    }
    if (value.kind === "tool") {
      if (!value.tool) {
        ctx.addIssue({ code: "custom", message: "Pick a tool to check", path: ["tool"] });
      }
      if (value.everyMinutes < ROUTINE_WATCH_MIN_TOOL_MINUTES) {
        ctx.addIssue({
          code: "custom",
          message: `Integration checks run at most every ${ROUTINE_WATCH_MIN_TOOL_MINUTES} minutes`,
          path: ["everyMinutes"],
        });
      }
    }
  });
export type RoutineWatch = z.infer<typeof RoutineWatchSchema>;
export type RoutineWatchInput = z.input<typeof RoutineWatchSchema>;

export const ROUTINE_WATCH_OUTCOMES = ["baseline", "unchanged", "changed", "failed"] as const;

/** What the last check saw. Written by the checker, never by clients. */
export const RoutineWatchStateSchema = z.object({
  checkedAt: z.string(),
  outcome: z.enum(ROUTINE_WATCH_OUTCOMES),
  fingerprint: z.string().nullable(),
  /** files: path -> "size:mtime", so a change can be described, not just detected. */
  entries: z.record(z.string(), z.string()).optional(),
  /** What changed, or why the check failed, in a sentence or a short list. */
  detail: z.string().nullable(),
});
export type RoutineWatchState = z.infer<typeof RoutineWatchStateSchema>;
