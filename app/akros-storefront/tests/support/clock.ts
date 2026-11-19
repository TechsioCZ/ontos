import { setImmediate } from "node:timers/promises";
import { vi } from "vitest";

/** Advance retry delays, but yield to real HTTP between attempts. */
export async function withRetryClock<T>(action: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const pending = action();
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      await setImmediate();
      if (!settled && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    }
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}
