import { afterEach, describe, expect, it, vi } from "vitest";

type Transition = { update: () => Promise<void>; done: () => void };

/** A fake document whose view transitions run their update only when told to. */
function stubTransitions() {
  const transitions: Transition[] = [];
  const classes = new Set<string>();
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    },
    startViewTransition(update: () => Promise<void>) {
      let done = () => {};
      const finished = new Promise<void>((resolve) => {
        done = resolve;
      });
      transitions.push({ update, done });
      return { finished };
    },
  });
  return { transitions, classes };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("switching spaces in place", () => {
  it("does not remount when the switch is abandoned", async () => {
    const { transitions } = stubTransitions();
    const { remountShellForSpace } = await import("./space-switch");
    const commit = vi.fn(() => false);
    remountShellForSpace(commit);
    await transitions[0]!.update();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("releases each held screen with its own shell, even when switches overlap", async () => {
    vi.useFakeTimers();
    const { transitions, classes } = stubTransitions();
    const { markShellReady, remountShellForSpace } = await import("./space-switch");
    remountShellForSpace(() => true);
    const first = transitions[0]!.update();
    remountShellForSpace(() => true);
    const second = transitions[1]!.update();
    // The first switch gives up waiting; the second's shell then reports ready.
    await vi.advanceTimersByTimeAsync(1_500);
    await first;
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    markShellReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(secondDone).toBe(true);
    // The class stays until the last transition finishes.
    transitions[0]!.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(classes.has("rk-space-switching")).toBe(true);
    transitions[1]!.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(classes.has("rk-space-switching")).toBe(false);
  });
});
