import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSharedReads, sharedRead } from "@/ontos/shared-read";

// A slow owner must not hold a search: after waitMs the reader gets the answer the newer read replaces.
const read = (load: () => Promise<string>) =>
  sharedRead("key", 1_000, () => load(), { waitMs: 20 });
const later = (value: string, ms: number) =>
  new Promise<string>((resolve) => setTimeout(() => resolve(value), ms));

beforeEach(() => {
  clearSharedReads();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

it("answers a slow newer read with the previous answer, then with the newer one once it lands", async () => {
  expect(await read(async () => "old")).toBe("old");
  vi.advanceTimersByTime(2_000);
  const slow = later("new", 200);
  expect(await read(() => slow)).toBe("old");
  // Readers while it is still pending wait no longer either, and share it.
  expect(await read(async () => "other")).toBe("old");
  await slow;
  expect(await read(async () => "other")).toBe("new");
});

it("keeps the previous answer when the newer read fails, and reads again on the next visit", async () => {
  expect(await read(async () => "old")).toBe("old");
  vi.advanceTimersByTime(2_000);
  expect(await read(() => Promise.reject(new Error("owner down")))).toBe("old");
  expect(await read(async () => "new")).toBe("new");
});

it("waits for the first read: there is no answer to give instead", async () => {
  expect(await read(() => later("first", 60))).toBe("first");
});
