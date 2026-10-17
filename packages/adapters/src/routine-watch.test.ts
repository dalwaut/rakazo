import { RoutineWatchSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RoutineWatchTickDeps } from "./routine-watch.js";
import {
  checkRoutineWatch,
  compareReading,
  describeEntryChanges,
  parseRoutineWatch,
  readItems,
  stableStringify,
  tickRoutineWatch,
  toolResultText,
  watchFolder,
} from "./routine-watch.js";

const NOW = new Date("2026-10-16T12:00:00.000Z");

describe("RoutineWatchSchema", () => {
  it("defaults to every 15 minutes, quiet", () => {
    const watch = RoutineWatchSchema.parse({ kind: "files", paths: ["inbox"] });
    expect(watch).toMatchObject({ everyMinutes: 15, loud: false });
  });

  it("needs the field its kind uses", () => {
    expect(RoutineWatchSchema.safeParse({ kind: "files" }).success).toBe(false);
    expect(RoutineWatchSchema.safeParse({ kind: "command" }).success).toBe(false);
    expect(RoutineWatchSchema.safeParse({ kind: "tool" }).success).toBe(false);
  });

  it("keeps integration checks to at most every 5 minutes", () => {
    const fast = { kind: "tool", tool: "brain_changed", everyMinutes: 1 };
    expect(RoutineWatchSchema.safeParse(fast).success).toBe(false);
    expect(RoutineWatchSchema.safeParse({ ...fast, everyMinutes: 5 }).success).toBe(true);
  });

  it("tracks items by up to five fields, identity first", () => {
    const tool = { kind: "tool", tool: "list_tasks", track: ["id", "date_updated"] };
    expect(RoutineWatchSchema.parse(tool).track).toEqual(["id", "date_updated"]);
    expect(RoutineWatchSchema.safeParse({ ...tool, track: [] }).success).toBe(false);
    expect(
      RoutineWatchSchema.safeParse({ kind: "files", paths: ["a"], track: ["id"] }).success,
    ).toBe(false);
  });

  it("reads an invalid stored watch as none rather than throwing", () => {
    expect(parseRoutineWatch({ kind: "nope" })).toBeNull();
    expect(parseRoutineWatch(null)).toBeNull();
  });
});

describe("compareReading", () => {
  const reading = { fingerprint: "b", detail: "new output" };

  it("records the first reading as a baseline and does not run", () => {
    expect(compareReading(null, reading, NOW)).toMatchObject({
      changed: false,
      state: { outcome: "baseline", fingerprint: "b" },
    });
  });

  it("does not run when the fingerprint is the same", () => {
    const previous = {
      checkedAt: "x",
      outcome: "unchanged" as const,
      fingerprint: "b",
      detail: null,
    };
    expect(compareReading(previous, reading, NOW)).toMatchObject({
      changed: false,
      state: { outcome: "unchanged" },
    });
  });

  it("runs, with the reading's detail, when it differs", () => {
    const previous = {
      checkedAt: "x",
      outcome: "unchanged" as const,
      fingerprint: "a",
      detail: null,
    };
    expect(compareReading(previous, reading, NOW)).toMatchObject({
      changed: true,
      state: { outcome: "changed", detail: "new output" },
    });
  });

  it("compares against the last good fingerprint after a failed check", () => {
    const failed = { checkedAt: "x", outcome: "failed" as const, fingerprint: "b", detail: "boom" };
    expect(compareReading(failed, reading, NOW).changed).toBe(false);
  });
});

describe("describeEntryChanges", () => {
  it("names what was added, edited and removed", () => {
    const text = describeEntryChanges(
      { "a.txt": "1:1", "b.txt": "1:1", "c.txt": "1:1" },
      { "a.txt": "1:1", "b.txt": "2:2", "d.txt": "1:1" },
    );
    expect(text).toBe("New: d.txt\nEdited: b.txt\nRemoved: c.txt");
  });
});

describe("stableStringify", () => {
  it("ignores key order", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });
});

describe("tickRoutineWatch", () => {
  const scheduledAt = new Date(Date.now() - 1_000);
  const target = { threadId: "thread-1", botId: "bot-1" };

  function setup(result: { data?: unknown; error?: string }, watch: Record<string, unknown> = {}) {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const messages: Array<{ role: string; blocks: unknown }> = [];
    const tx = {
      thread: { update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })) },
      message: {
        create: vi.fn(async ({ data }: { data: { role: string; blocks: unknown } }) => {
          messages.push(data);
          return { id: "m1", ...data };
        }),
      },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const deps = {
      prisma: {
        routine: { updateMany },
        $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
      },
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      connector: {
        discoverTools: vi.fn(async () => [
          { name: "brain_changed", route: { connectorId: "installed" } },
        ]),
        execute: vi.fn(async function* () {
          if (result.error) yield { type: "error", message: result.error };
          else yield { type: "result", data: result.data };
        }),
      },
    } as unknown as RoutineWatchTickDeps;
    const routine = {
      id: "routine-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      name: "Brain check",
      watch: { kind: "tool", tool: "brain_changed", args: { limit: 1 }, ...watch },
      watchState: {
        checkedAt: "x",
        outcome: "unchanged",
        fingerprint: null as string | null,
        detail: null,
      },
    };
    return { deps, routine, updateMany, messages };
  }

  it("records a quiet no-change check without a message and schedules the next", async () => {
    const { deps, routine, updateMany, messages } = setup({ data: { changes: [] } });
    // First reading is the baseline.
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    const baseline = (
      updateMany.mock.calls[0] as unknown as [
        { data: { watchState: { checkedAt: string; fingerprint: string } } },
      ]
    )[0].data.watchState;
    routine.watchState = { ...baseline, outcome: "unchanged", detail: null };

    const tick = await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(tick).toEqual({ run: false });
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          watchState: expect.objectContaining({ outcome: "unchanged" }),
        }),
      }),
    );
    expect(deps.jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(0);
  });

  it("posts 'No changes, routine ended' when loud", async () => {
    const { deps, routine, updateMany, messages } = setup(
      { data: { changes: [] } },
      { loud: true },
    );
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    const baseline = (
      updateMany.mock.calls[0] as unknown as [
        { data: { watchState: { checkedAt: string; fingerprint: string } } },
      ]
    )[0].data.watchState;
    routine.watchState = { ...baseline, outcome: "unchanged", detail: null };
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(messages.at(-1)).toMatchObject({
      role: "system",
      blocks: [{ kind: "meta", text: "Brain check routine: No changes, routine ended" }],
    });
  });

  it("runs with a note of what changed", async () => {
    const { deps, routine } = setup({ data: { changes: [{ path: "Facts/new.md" }] } });
    routine.watchState.fingerprint = "old";
    const tick = await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(tick.run).toBe(true);
    if (!tick.run) return;
    expect(tick.note).toContain("What changed since the last check");
    expect(tick.note).toContain("Facts/new.md");
    expect(tick.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it("pauses the routine and has the bot say why when the check fails", async () => {
    const { deps, routine, updateMany, messages } = setup({ error: "401 unauthorized" });
    const tick = await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(tick).toEqual({ run: false });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ active: false, nextRunAt: null }),
      }),
    );
    expect(deps.jobs.cancel).toHaveBeenCalled();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "bot" });
    expect(JSON.stringify(messages[0]?.blocks)).toContain("401 unauthorized");
  });
});

describe("watchFolder", () => {
  // A team computer refuses "." as a bot path, which failed every files watch live.
  it("is the bot's own folder on a team computer and the workspace on a private one", () => {
    expect(watchFolder("team", "bot-1")).toBe("/home/rakazo/bots/bot-1");
    expect(watchFolder("dedicated", "bot-1")).toBe("/home/rakazo");
  });
});

describe("toolResultText", () => {
  // The shape the VEC brain's brain_changed returned live through an installed MCP server.
  const envelope = {
    content: [{ type: "text", text: '{\n  "changes": [{"what": "add test note"}]\n}' }],
    isError: false,
  };

  it("unwraps an MCP result to its text", () => {
    expect(toolResultText(envelope)).toBe('{\n  "changes": [{"what": "add test note"}]\n}');
  });

  it("joins several text parts and skips non-text ones", () => {
    expect(
      toolResultText({
        content: [
          { type: "text", text: "one" },
          { type: "image", data: "…" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });

  it("keeps plain strings and other data readable", () => {
    expect(toolResultText("plain")).toBe("plain");
    expect(toolResultText({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("readItems", () => {
  const inbox = (messages: unknown[]) => ({
    content: [{ type: "text", text: JSON.stringify({ fetchedAt: Date.now(), messages }) }],
  });

  it("ignores everything outside the tracked fields", () => {
    const first = readItems(inbox([{ id: "m1", subject: "Invoice", snippet: "a" }]), ["id"]);
    const again = readItems(inbox([{ id: "m1", subject: "Invoice", snippet: "b" }]), ["id"]);
    expect(first.fingerprint).toBe(again.fingerprint);
  });

  it("names new, updated and gone items by their title", () => {
    const before = readItems(
      [
        { id: "t1", name: "Write rate card", date_updated: "1" },
        { id: "t2", name: "Call printer", date_updated: "1" },
      ],
      ["id", "date_updated"],
    );
    const after = readItems(
      [
        { id: "t1", name: "Write rate card", date_updated: "2" },
        { id: "t3", name: "Book venue", date_updated: "1" },
      ],
      ["id", "date_updated"],
    );
    const previous = {
      checkedAt: "x",
      outcome: "unchanged" as const,
      fingerprint: before.fingerprint,
      entries: before.entries,
      detail: null,
    };
    expect(compareReading(previous, after, NOW).state.detail).toBe(
      "New: Book venue\nUpdated: Write rate card\nGone: Call printer",
    );
  });

  it("finds items nested anywhere in the result", () => {
    const reading = readItems({ data: { files: [{ id: "f1", name: "Rates.pdf" }] } }, ["id"]);
    expect(Object.keys(reading.entries ?? {})).toEqual(["f1"]);
  });

  it("treats an empty list as no items, not a failure", () => {
    expect(readItems(inbox([]), ["id"]).entries).toEqual({});
  });
});

describe("watch tool guard", () => {
  function setupTool(tool: { name: string; readOnly?: boolean }, args: Record<string, unknown>) {
    const execute = vi.fn(async function* () {
      yield { type: "result", data: [] };
    });
    const deps = {
      connector: {
        discoverTools: vi.fn(async () => [{ ...tool, route: { connectorId: "installed" } }]),
        execute,
      },
    } as unknown as RoutineWatchTickDeps;
    const routine = {
      id: "r",
      spaceId: "s",
      userId: "u",
      botId: "b",
      watch: { kind: "tool", tool: tool.name, args },
      watchState: null,
    };
    return { deps, routine, execute };
  }

  it("refuses a tool that changes things, without calling it", async () => {
    const { deps, routine, execute } = setupTool({ name: "send_email" }, {});
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(/only reads/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a write action on a tool that takes one", async () => {
    const { deps, routine, execute } = setupTool({ name: "clickbot_tasks" }, { action: "delete" });
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(/only reads/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a tool its integration declares as a write", async () => {
    const { deps, routine } = setupTool({ name: "brain_changed", readOnly: false }, {});
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(/only reads/);
  });

  it("allows reads, including tools whose name does not say", async () => {
    for (const [name, args] of [
      ["brain_changed", {}],
      ["clickbot_tasks", { action: "list" }],
      ["search_threads", { query: "invoice" }],
    ] as const) {
      const { deps, routine } = setupTool({ name }, args);
      await expect(checkRoutineWatch(deps, routine)).resolves.toMatchObject({ changed: false });
    }
  });
});
