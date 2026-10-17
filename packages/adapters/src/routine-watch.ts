import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentHomeStore,
  ConnectorProvider,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import type { RoutineWatch, RoutineWatchState } from "@rakazo/contracts";
import { RoutineWatchSchema, RoutineWatchStateSchema } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import { watchToolRefusal } from "@rakazo/core";
import type { ComputerMode, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  parseComputerMode,
} from "@rakazo/db";
import { scheduleComputerSleep } from "./computer-idle.js";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import { resolveBotWorkspacePath, teamBotWorkspaceDirectory } from "./computer-support.js";

/**
 * The checker behind a routine's "when something changes" trigger. It never
 * calls a model: it fingerprints the watched thing and compares the result
 * with the last one, so a routine only spends a run when there is news.
 */

/** Every sandbox resolves the computer's workspace, `bots/` and `shared/`, from here. */
const WORKSPACE = "/home/rakazo";
const CHECK_TIMEOUT_MS = 60_000;
/** Starting a stopped computer can take longer than a check; it gets its own budget. */
const PROVISION_TIMEOUT_MS = 5 * 60_000;
/** A busy or still-booting computer is tried again this soon, not counted as a failure. */
const RETRY_AFTER_MS = 60_000;
/** Above this, a files watch keeps only the fingerprint and reports a count. */
const MAX_TRACKED_ENTRIES = 2_000;
const MAX_DETAIL = 1_500;
const MAX_LISTED = 20;

export type RoutineWatchDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  dataDir?: string;
  connector?: ConnectorProvider;
  /** The shell tool's desktop-protection guard: why a command is refused on a graphical computer. */
  commandRefusal?: (command: string) => string | undefined;
};

export type RoutineWatchTarget = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  watch: unknown;
  watchState: unknown;
};

/** Thrown when a check cannot be completed; the routine is paused and the bot says why. */
export class RoutineWatchError extends Error {}

/** Thrown when a check cannot run yet for a passing reason; it is retried shortly, not paused. */
export class RoutineWatchRetry extends Error {}

export type RoutineWatchOutcome = {
  state: RoutineWatchState;
  /** True when the routine should run now. */
  changed: boolean;
};

export function parseRoutineWatch(value: unknown): RoutineWatch | null {
  if (value == null) return null;
  const parsed = RoutineWatchSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRoutineWatchState(value: unknown): RoutineWatchState | null {
  if (value == null) return null;
  const parsed = RoutineWatchStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** When the next check is due. */
export function nextRoutineWatchAt(watch: RoutineWatch, from: Date): Date {
  return new Date(from.getTime() + watch.everyMinutes * 60_000);
}

/** What a watch looks at, in a few words, for messages and the routine list. */
export function describeRoutineWatch(watch: RoutineWatch): string {
  if (watch.kind === "files") return (watch.paths ?? []).join(", ");
  if (watch.kind === "command") return `\`${watch.command ?? ""}\``;
  return watch.tool ?? "";
}

export async function checkRoutineWatch(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  now: Date = new Date(),
): Promise<RoutineWatchOutcome> {
  const watch = parseRoutineWatch(routine.watch);
  if (!watch) throw new RoutineWatchError("The change trigger's settings are not valid.");
  const previous = parseRoutineWatchState(routine.watchState);
  const reading =
    watch.kind === "tool"
      ? await readTool(deps, routine, watch)
      : await readComputer(deps, routine, watch);
  return compareReading(previous, reading, now);
}

type Reading = {
  fingerprint: string;
  entries?: Record<string, string>;
  /** Shown when the reading differs from the last one. */
  detail: string | null;
};

/** Pure: decides baseline / unchanged / changed and describes the change. */
export function compareReading(
  previous: RoutineWatchState | null,
  reading: Reading,
  now: Date,
): RoutineWatchOutcome {
  const base = {
    checkedAt: now.toISOString(),
    fingerprint: reading.fingerprint,
    ...(reading.entries ? { entries: reading.entries } : {}),
  };
  // A first check, or the first good one after a failure, only records where things stand.
  if (!previous?.fingerprint) {
    return { changed: false, state: { ...base, outcome: "baseline", detail: null } };
  }
  if (previous.fingerprint === reading.fingerprint) {
    return { changed: false, state: { ...base, outcome: "unchanged", detail: null } };
  }
  const detail =
    reading.entries && previous.entries
      ? describeEntryChanges(previous.entries, reading.entries)
      : reading.detail;
  return { changed: true, state: { ...base, outcome: "changed", detail } };
}

export function describeEntryChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  const items = Object.keys(after).some((key) => after[key]?.startsWith(ITEM_SIGNATURE));
  // Files are named by path; tracked items by the title saved in their signature.
  const name = (key: string, signature: string | undefined) =>
    items ? (itemTitle(signature) ?? key) : key;
  const added: string[] = [];
  const edited: string[] = [];
  const removed: string[] = [];
  for (const [key, signature] of Object.entries(after)) {
    if (!(key in before)) added.push(name(key, signature));
    else if (before[key] !== signature) edited.push(name(key, signature));
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(name(key, before[key]));
  const lines: string[] = [];
  const list = (label: string, names: string[]) => {
    if (!names.length) return;
    const shown = names.sort().slice(0, MAX_LISTED);
    const more = names.length - shown.length;
    lines.push(`${label}: ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}`);
  };
  list("New", added);
  list(items ? "Updated" : "Edited", edited);
  list(items ? "Gone" : "Removed", removed);
  return lines.join("\n") || (items ? "The watched items changed." : "The watched files changed.");
}

/** Marks an item signature, so a note can name items by title rather than identity. */
const ITEM_SIGNATURE = "item:";
const TITLE_FIELDS = ["name", "title", "subject", "summary", "filename", "snippet"];

function itemTitle(signature: string | undefined): string | null {
  if (!signature?.startsWith(ITEM_SIGNATURE)) return null;
  try {
    const { title } = JSON.parse(signature.slice(ITEM_SIGNATURE.length)) as { title?: unknown };
    return typeof title === "string" && title ? title : null;
  } catch {
    return null;
  }
}

/**
 * The items in a JSON result, compared by the tracked fields only. Every object
 * anywhere in the result that carries the first field is an item; that field
 * is its identity, and the rest decide whether it was updated.
 */
export function readItems(data: unknown, track: readonly string[]): Reading {
  const [identity, ...fields] = track;
  const entries: Record<string, string> = {};
  const visit = (value: unknown) => {
    if (Object.keys(entries).length >= MAX_TRACKED_ENTRIES) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = identity ? record[identity] : undefined;
    if (typeof id === "string" || typeof id === "number") {
      const titleField = TITLE_FIELDS.find((field) => typeof record[field] === "string");
      const title = titleField ? String(record[titleField]).slice(0, 120) : null;
      entries[String(id)] =
        `${ITEM_SIGNATURE}${stableStringify({ fields: fields.map((field) => record[field] ?? null), title })}`;
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(resultJson(data));
  return { fingerprint: sha256(stableStringify(entries)), entries, detail: null };
}

/** A result as JSON: the parsed text of an MCP or text result, or the data itself. */
function resultJson(data: unknown): unknown {
  const text = typeof data === "string" || isMcpEnvelope(data) ? toolResultText(data) : null;
  if (text === null) return data;
  try {
    return JSON.parse(text);
  } catch {
    throw new RoutineWatchError("The result is not JSON, so its tracked fields cannot be read.");
  }
}

function isMcpEnvelope(data: unknown): boolean {
  return Array.isArray((data as { content?: unknown } | null)?.content);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON with sorted keys, so the same data always fingerprints the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL)}…` : trimmed;
}

function context(routine: RoutineWatchTarget): AdapterContext {
  const operationId = `watch:${routine.id}:${Date.now()}`;
  return {
    operationId,
    traceId: operationId,
    spaceId: routine.spaceId,
    userId: routine.userId,
    botId: routine.botId,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  };
}

// Lists every file under each path as "path<TAB>size<TAB>mtime". A path that
// does not exist is reported rather than read as "no files", which would make
// a deleted folder look unchanged forever.
// A path that cannot be fully listed fails the whole check, with find's error,
// rather than saving a partial listing that would read as removed files.
const FILES_SCRIPT = `status=0
for p in "$@"; do
  if [ -e "$p" ]; then find "$p" -type f -printf '%p\\t%s\\t%T@\\n' || status=$?
  else printf 'MISSING\\t%s\\n' "$p"; fi
done
exit $status`;

/** Where a bot's relative paths and commands start. */
export function watchFolder(mode: ComputerMode, botId: string): string {
  // Not resolveBotWorkspacePath(mode, botId, "."): a team computer refuses "." as escaping.
  return mode === "team" ? `${WORKSPACE}/${teamBotWorkspaceDirectory(botId)}` : WORKSPACE;
}

async function readComputer(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  watch: RoutineWatch,
): Promise<Reading> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: routine.botId },
    include: { computer: true },
  });
  if (!bot?.computer) throw new RoutineWatchError("This bot has no computer to check.");
  const mode = parseComputerMode(bot.computer.scope);
  if (watch.kind === "command") {
    const graphical =
      bot.computer.kind !== "desktop" && deps.sandbox.describe().capabilities.graphical;
    const refusal = graphical ? deps.commandRefusal?.(watch.command ?? "") : undefined;
    if (refusal) {
      throw new RoutineWatchError(
        `The check command is refused by the desktop-protection guard: ${refusal}.`,
      );
    }
  }
  const ctx = context(routine);
  let computer: Awaited<ReturnType<typeof provisionComputer>>;
  try {
    computer = await provisionComputer(deps, bot.computer.id, {
      ...ctx,
      signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
    });
  } catch (error) {
    // Another run booting it, or an update in progress: try again shortly.
    if (
      error instanceof ComputerBusyError ||
      (error as { name?: string })?.name === "TimeoutError"
    ) {
      throw new RoutineWatchRetry(errorText(error));
    }
    throw new RoutineWatchError(`Could not start the bot's computer: ${errorText(error)}`);
  }
  scheduleComputerSleep(deps.jobs, bot.computer.id);
  // The check's own time budget starts once the computer is up.
  const checkCtx = context(routine);
  const botFolder = watchFolder(mode, bot.id);
  const resolve = (path: string) =>
    path.startsWith("/") ? path : `${WORKSPACE}/${resolveBotWorkspacePath(mode, bot.id, path)}`;

  if (watch.kind === "command") {
    const result = await run(
      deps,
      computer,
      checkCtx,
      ["sh", "-lc", watch.command ?? ""],
      botFolder,
    );
    if (result.code !== 0) {
      throw new RoutineWatchError(
        `The check command exited with ${result.code}${result.stderr ? `: ${clip(result.stderr)}` : "."}`,
      );
    }
    if (watch.track) return readItems(result.stdout, watch.track);
    return { fingerprint: sha256(result.stdout), detail: clip(result.stdout) || null };
  }

  const paths = (watch.paths ?? []).map(resolve);
  const result = await run(
    deps,
    computer,
    checkCtx,
    ["sh", "-c", FILES_SCRIPT, "watch", ...paths],
    WORKSPACE,
  );
  if (result.code !== 0) {
    throw new RoutineWatchError(
      `Could not list the watched files (exit ${result.code})${result.stderr ? `: ${clip(result.stderr)}` : "."}`,
    );
  }
  const entries: Record<string, string> = {};
  const missing: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [first, second, third] = line.split("\t");
    if (first === "MISSING") missing.push(second ?? "");
    // Full mtime precision, so a same-size edit later in the same second still counts.
    else if (first) entries[first] = `${second}:${third}`;
  }
  if (missing.length) {
    throw new RoutineWatchError(`Nothing exists at ${missing.join(", ")}.`);
  }
  const fingerprint = sha256(stableStringify(entries));
  const count = Object.keys(entries).length;
  return count > MAX_TRACKED_ENTRIES
    ? { fingerprint, detail: `${count} watched files; something among them changed.` }
    : { fingerprint, entries, detail: null };
}

async function run(
  deps: RoutineWatchDeps,
  computer: Awaited<ReturnType<typeof provisionComputer>>,
  ctx: AdapterContext,
  argv: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  let code = -1;
  try {
    for await (const event of deps.sandbox.execute(
      computer,
      { argv, cwd, timeoutMs: CHECK_TIMEOUT_MS },
      ctx,
    )) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "stderr") stderr += event.data;
      else if (event.type === "exit") code = event.code;
    }
  } catch (error) {
    throw new RoutineWatchError(`The check could not run on the computer: ${errorText(error)}`);
  }
  return { stdout, stderr, code };
}

async function readTool(
  deps: RoutineWatchDeps,
  routine: RoutineWatchTarget,
  watch: RoutineWatch,
): Promise<Reading> {
  const connector = deps.connector;
  if (!connector) throw new RoutineWatchError("No integrations are available to check.");
  const ctx = context(routine);
  const toolName = watch.tool ?? "";
  let tools: Awaited<ReturnType<ConnectorProvider["discoverTools"]>>;
  try {
    tools = await connector.discoverTools(ctx);
  } catch (error) {
    throw new RoutineWatchError(`Could not list the integration's tools: ${errorText(error)}`);
  }
  const call = { tool: toolName, args: watch.args ?? {}, executionId: ctx.operationId };
  const listed = tools.find((candidate) => candidate.name === toolName);
  // A catalog tool reached through resolveCall carries its declared effect too.
  const lookup = listed
    ? { call: { ...call, route: listed.route }, tool: listed }
    : await connector.resolveCall?.(call, ctx).catch(() => undefined);
  const resolved = lookup?.call ?? null;
  const tool = lookup?.tool;
  if (!resolved) {
    throw new RoutineWatchError(`No connected integration has a tool named ${toolName}.`);
  }
  // A check runs unattended and never asks, so it may only ever read.
  const action = (watch.args as { action?: unknown } | undefined)?.action;
  const refusal = watchToolRefusal({
    toolName,
    action: typeof action === "string" ? action : undefined,
    readOnly: tool?.readOnly,
    rules: (await deps.prisma.actionApprovalRule.findMany({
      where: { spaceId: routine.spaceId, createdByUserId: routine.userId },
      select: { effect: true, matchKind: true, matchValue: true },
    })) as ActionApprovalRule[],
  });
  if (refusal) throw new RoutineWatchError(refusal);
  let data: unknown;
  let failure: string | null = null;
  try {
    for await (const event of connector.execute(resolved, ctx)) {
      if (event.type === "result") data = event.data;
      else if (event.type === "error") failure = event.message;
    }
  } catch (error) {
    failure = errorText(error);
  }
  if (failure) throw new RoutineWatchError(`${toolName} failed: ${clip(failure)}`);
  if ((data as { isError?: unknown } | null)?.isError === true) {
    throw new RoutineWatchError(`${toolName} returned an error: ${clip(toolResultText(data))}`);
  }
  if (watch.track) return readItems(data, watch.track);
  // The fingerprint covers the whole result; only the note the bot reads is unwrapped.
  return {
    fingerprint: sha256(stableStringify(data ?? null)),
    detail: clip(toolResultText(data)),
  };
}

/**
 * What a tool returned, as text a bot can read: an MCP result's text parts
 * rather than its `{content:[{type:"text",text}]}` envelope.
 */
export function toolResultText(data: unknown): string {
  if (typeof data === "string") return data;
  const content = (data as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          (part as { type?: unknown })?.type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text);
    if (texts.length) return texts.join("\n");
  }
  return stableStringify(data ?? null);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RoutineWatchTickDeps = RoutineWatchDeps & {
  jobs: JobPublisher;
};

type TickRoutine = RoutineWatchTarget & { name: string };

export type RoutineWatchTick =
  | { run: false }
  | { run: true; state: RoutineWatchState; nextRunAt: Date; note: string };

/**
 * One scheduled check of a watching routine. Returns whether the routine
 * should run now; every other outcome is fully handled here: the next check is
 * scheduled, or the routine is paused and its bot says why.
 */
export async function tickRoutineWatch(
  deps: RoutineWatchTickDeps,
  routine: TickRoutine,
  target: { threadId: string; botId: string },
  scheduledAt: Date,
): Promise<RoutineWatchTick> {
  const watch = parseRoutineWatch(routine.watch);
  const previous = parseRoutineWatchState(routine.watchState);
  const now = new Date();
  let outcome: RoutineWatchOutcome;
  try {
    if (!watch) throw new RoutineWatchError("The change trigger's settings are not valid.");
    outcome = await checkRoutineWatch(deps, routine, now);
  } catch (error) {
    if (error instanceof RoutineWatchRetry) {
      const retryAt = new Date(now.getTime() + RETRY_AFTER_MS);
      const deferred = await deps.prisma.routine.updateMany({
        where: { id: routine.id, active: true, nextRunAt: scheduledAt },
        data: { nextRunAt: retryAt },
      });
      if (deferred.count === 1) await deps.jobs.enqueue(routineWakeupJob(routine.id, retryAt));
      return { run: false };
    }
    const reason = error instanceof Error ? error.message : String(error);
    const paused = await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: scheduledAt },
      data: {
        active: false,
        nextRunAt: null,
        watchState: {
          checkedAt: now.toISOString(),
          outcome: "failed",
          fingerprint: previous?.fingerprint ?? null,
          ...(previous?.entries ? { entries: previous.entries } : {}),
          detail: reason,
        } satisfies RoutineWatchState,
      },
    });
    if (paused.count === 1) {
      await deps.jobs.cancel(routineJobKey(routine.id)).catch(() => undefined);
      await postRoutineWatchMessage(deps, {
        spaceId: routine.spaceId,
        ...target,
        role: "bot",
        text: `I paused the **${routine.name}** routine because its change check failed: ${reason}\n\nTell me how to fix it, or turn the routine back on once it's sorted.`,
      });
    }
    return { run: false };
  }
  const nextRunAt = nextRoutineWatchAt(
    watch,
    new Date(Math.max(now.getTime(), scheduledAt.getTime())),
  );
  if (outcome.changed) {
    return {
      run: true,
      state: outcome.state,
      nextRunAt,
      note: `\n\nThis run was started because something you watch changed (${describeRoutineWatch(watch)}).\nWhat changed since the last check:\n${outcome.state.detail ?? "(no detail)"}`,
    };
  }
  const claimed = await deps.prisma.routine.updateMany({
    where: { id: routine.id, active: true, nextRunAt: scheduledAt },
    data: { nextRunAt, watchState: outcome.state },
  });
  if (claimed.count !== 1) return { run: false };
  if (watch.loud) {
    await postRoutineWatchMessage(deps, {
      spaceId: routine.spaceId,
      ...target,
      role: "system",
      text:
        outcome.state.outcome === "baseline"
          ? `${routine.name} routine: watching for changes`
          : `${routine.name} routine: No changes, routine ended`,
    });
  }
  await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  return { run: false };
}

/** A line in the routine's thread without a model run. */
export async function postRoutineWatchMessage(
  deps: Pick<RoutineWatchDeps, "prisma" | "events">,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    role: "bot" | "system";
    text: string;
  },
): Promise<void> {
  const blocks =
    input.role === "bot"
      ? [{ kind: "text" as const, text: input.text }]
      : [{ kind: "meta" as const, text: input.text }];
  try {
    const seq = await deps.prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        botId: input.botId,
        role: input.role,
        blocks,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: input.role, blocks },
      });
      return event.seq;
    });
    if (seq !== undefined) await deps.events.notify(input.threadId, seq).catch(() => undefined);
  } catch {
    // Best effort: the routine's state is already saved.
  }
}
