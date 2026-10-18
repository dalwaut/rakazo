import { useSyncExternalStore } from "react";

/**
 * Switching spaces in place: the shell is keyed by this counter, so a switch
 * throws away every piece of the previous space's state, as a reload would,
 * without reloading the page.
 */
let epoch = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSpaceEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch);
}

export function remountShellForSpace(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}
