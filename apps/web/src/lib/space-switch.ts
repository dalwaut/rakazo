import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

/**
 * Switching spaces in place: the shell is keyed by this counter, so a switch
 * throws away every piece of the previous space's state, as a reload would,
 * without reloading the page.
 */
let epoch = 0;
const listeners = new Set<() => void>();
let shellReady: (() => void) | null = null;

/** The longest the old screen is held while the new space's shell renders. */
const READY_TIMEOUT_MS = 1_500;
const SWITCHING_CLASS = "rk-space-switching";

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSpaceEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch);
}

/**
 * Remounts the shell for the newly selected space. Where the browser supports
 * view transitions, the old screen stays up until the new shell has its bots
 * and conversation, then crossfades to it, so nothing flashes empty.
 */
export function remountShellForSpace(update: () => void): void {
  const remount = () => {
    update();
    epoch += 1;
    for (const listener of listeners) listener();
  };
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (typeof document.startViewTransition !== "function" || reducedMotion) {
    remount();
    return;
  }
  const root = document.documentElement;
  root.classList.add(SWITCHING_CLASS);
  const transition = document.startViewTransition(async () => {
    const ready = new Promise<void>((resolve) => {
      shellReady = resolve;
      window.setTimeout(resolve, READY_TIMEOUT_MS);
    });
    flushSync(remount);
    await ready;
    shellReady = null;
  });
  void transition.finished.finally(() => root.classList.remove(SWITCHING_CLASS));
}

/** Called by the shell once its bots and conversation are on screen. */
export function markShellReady(): void {
  shellReady?.();
}
