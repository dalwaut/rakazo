import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineWatchSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import type { RoutineWatchTickDeps } from "./routine-watch.js";
import {
  checkRoutineWatch,
  compareReading,
  describeEntryChanges,
  FILES_SCRIPT,
  parseRoutineWatch,
  resolveWatchPath,
  stableStringify,
  tickRoutineWatch,
  toolResultText,
  validateRoutineWatch,
  watchFolder,
} from "./routine-watch.js";

vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original()),
  provisionComputer: vi.fn(),
}));

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
        bot: {
          findUnique: vi.fn(async () => ({
            id: "bot-1",
            computer: { id: "computer-1", scope: "team" },
          })),
        },
        routine: { updateMany },
        $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
      },
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      connector: {
        discoverTools: vi.fn(async () => [
          { name: "brain_changed", readOnly: true, route: { connectorId: "installed" } },
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

  it("posts 'no changes' when loud", async () => {
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
      blocks: [{ kind: "meta", text: "Brain check routine: no changes" }],
    });
  });

  it.each([false, undefined])(
    "refuses a tool with readOnly %s without executing it",
    async (readOnly) => {
      const { deps, routine } = setup({ data: "ok" });
      vi.mocked(deps.connector!.discoverTools).mockResolvedValue([
        { name: "brain_changed", readOnly, description: "Read changes", inputSchema: {} },
      ]);
      await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("can change data");
      expect(deps.connector!.execute).not.toHaveBeenCalled();
      await expect(
        validateRoutineWatch(deps, RoutineWatchSchema.parse(routine.watch), routine),
      ).rejects.toThrow("can change data");
    },
  );

  it.each([false, undefined, true])("checks lazy tool readOnly %s", async (readOnly) => {
    const { deps, routine } = setup({ data: "ok" });
    vi.mocked(deps.connector!.discoverTools).mockResolvedValue([]);
    deps.connector!.resolveCall = vi.fn(async (call) => ({
      call,
      tool: { name: call.tool, readOnly, description: "Read changes", inputSchema: {} },
    }));
    if (readOnly)
      await expect(checkRoutineWatch(deps, routine)).resolves.toMatchObject({ changed: false });
    else await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("can change data");
    expect(deps.connector!.execute).toHaveBeenCalledTimes(readOnly ? 1 : 0);
  });

  it.each([{ isError: true, content: [{ type: "text", text: "failed" }] }, { error: "failed" }])(
    "rejects error result envelopes",
    async (data) => {
      const { deps, routine } = setup({ data });
      await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("failed");
    },
  );

  it.each([new ComputerBusyError(), new DOMException("timed out", "TimeoutError")])(
    "retries temporary provisioning conflicts without losing the baseline",
    async (error) => {
      const { deps, routine, updateMany, messages } = setup({});
      routine.watch = { kind: "files", paths: ["inbox"] } as unknown as typeof routine.watch;
      vi.mocked(provisionComputer).mockRejectedValueOnce(error);
      await tickRoutineWatch(deps, routine, target, scheduledAt);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { nextRunAt: expect.any(Date) } }),
      );
      expect(deps.jobs.enqueue).toHaveBeenCalledOnce();
      expect(deps.jobs.cancel).not.toHaveBeenCalled();
      expect(messages).toEqual([]);
    },
  );

  it("keeps sub-second modification times in file signatures", async () => {
    const { deps, routine } = setup({});
    routine.watch = { kind: "files", paths: ["inbox"] } as unknown as typeof routine.watch;
    vi.mocked(provisionComputer).mockResolvedValue({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    let mtime = "1.123";
    deps.sandbox = {
      execute: vi.fn(async function* () {
        yield { type: "stdout", data: `inbox/note.txt\t3\t${mtime}\n` };
        yield { type: "exit", code: 0 };
      }),
    } as unknown as typeof deps.sandbox;
    const baseline = await checkRoutineWatch(deps, routine);
    routine.watchState = baseline.state as typeof routine.watchState;
    mtime = "1.456";
    expect((await checkRoutineWatch(deps, routine)).changed).toBe(true);
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

describe("file watch boundaries", () => {
  it("allows normalized team paths inside the bot folder", () => {
    expect(resolveWatchPath("team", "bot-1", "/home/rakazo/bots/bot-1/inbox/../notes")).toBe(
      "/home/rakazo/bots/bot-1/notes",
    );
    expect(resolveWatchPath("team", "bot-1", "notes")).toBe("/home/rakazo/bots/bot-1/notes");
  });
  it.each(["/etc", "../bot-2", "/home/rakazo/bots/bot-1/../../shared", "shared/../../other"])(
    "refuses team escape %s",
    (path) => {
      expect(() => resolveWatchPath("team", "bot-1", path)).toThrow("inside the bot's folder");
    },
  );
  it("keeps dedicated computers unrestricted", () => {
    expect(resolveWatchPath("dedicated", "bot-1", "/etc")).toBe("/etc");
    expect(resolveWatchPath("dedicated", "bot-1", "../tmp")).toBe("/home/tmp");
  });
});

describe("files listing script", () => {
  it("refuses a symlink that points outside the bot folder before listing", () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "routine-watch-")));
    try {
      const folder = join(temp, "bot");
      mkdirSync(folder);
      const outside = join(temp, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "private.txt"), "fixture");
      const link = join(folder, "link");
      symlinkSync(outside, link);
      for (const path of [link, join(link, "private.txt")]) {
        const result = spawnSync("sh", ["-c", FILES_SCRIPT, "watch", folder, path], {
          encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Path escapes the bot folder");
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps an earlier listing failure and its stderr when the last path succeeds", () => {
    // Simulate a sandbox where one find fails, followed by a successful listing.
    const script = `find() { if [ "$2" = / ]; then echo denied >&2; return 1; fi; printf 'ok\\t1\\t1.234\\n'; }\n${FILES_SCRIPT}`;
    const result = spawnSync("sh", ["-c", script, "watch", "", "/", "/."], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("denied");
    expect(result.stdout).toContain("1.234");
  });
});
