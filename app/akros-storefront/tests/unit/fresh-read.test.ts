import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperation } from "@ontos/storefront-runtime";
import { clearFreshReads, freshRead, latestFreshRead } from "@/ontos/fresh-read";

// The owner's state, changed by an "admin save"; every load records when it ran.
let owner = "N";
let loads = 0;
const load = async () => {
  loads += 1;
  return owner;
};
const caller = () => Effect.runSync(createOperation());
// No background repeat inside these tests unless a test asks for it.
const timing = { maxAgeMs: 1_500, intervalMs: 60_000, keepAliveMs: 0 };
const read = (loader: () => Promise<string> = load, t = timing) =>
  freshRead("key", t, () => loader(), caller());

beforeEach(() => {
  clearFreshReads();
  owner = "N";
  loads = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

it("answers a save 2 s later with the new state on the first visit, without waiting 15 s or retrying", async () => {
  expect(await read()).toBe("N");
  owner = "N+1";
  vi.advanceTimersByTime(2_000);
  expect(await read()).toBe("N+1");
  expect(loads).toBe(2);
});

it("serves a young answer to every visit without another owner read", async () => {
  expect(await read()).toBe("N");
  vi.advanceTimersByTime(1_000);
  await Promise.all(Array.from({ length: 20 }, () => read()));
  expect(loads).toBe(1);
});

it("never lets a read that started before a newer one replace the newer answer", async () => {
  let finishOld: (value: string) => void = () => undefined;
  const old = read(() => new Promise<string>((resolve) => (finishOld = resolve)));
  vi.advanceTimersByTime(2_000);
  owner = "N+1";
  // The old read is too old to be joined: this visit starts its own, newer read.
  expect(await read()).toBe("N+1");
  finishOld("N");
  // The visit that waited for the old read gets its answer, but the shared answer stays the newer one.
  expect(await old).toBe("N");
  expect(await read(async () => "never read")).toBe("N+1");
});

it("keeps the last answer while the owner is down, and refuses it once it is 10 minutes old", async () => {
  expect(await read()).toBe("N");
  vi.advanceTimersByTime(20_000);
  const down = () => Promise.reject(new Error("owner down"));
  expect(await read(down)).toBe("N");
  vi.advanceTimersByTime(11 * 60_000);
  await expect(read(down)).rejects.toThrow("owner down");
});

it("hands a caller that cannot wait the newest answer while a slow read goes on, never one 10 minutes old", async () => {
  expect(latestFreshRead("key")).toBeUndefined();
  expect(await read()).toBe("N");
  vi.advanceTimersByTime(20_000);
  let finish: (value: string) => void = () => undefined;
  const slow = read(() => new Promise<string>((resolve) => (finish = resolve)));
  expect(latestFreshRead("key")).toBe("N");
  finish("N+1");
  expect(await slow).toBe("N+1");
  expect(latestFreshRead("key")).toBe("N+1");
  vi.advanceTimersByTime(11 * 60_000);
  expect(latestFreshRead("key")).toBeUndefined();
});

it("repeats the read in the background while visits come, so a later visit gets a fresh answer at once", async () => {
  vi.useRealTimers();
  const polled = { maxAgeMs: 400, intervalMs: 20, keepAliveMs: 1_000 };
  expect(await read(load, polled)).toBe("N");
  owner = "N+1";
  await new Promise((resolve) => setTimeout(resolve, 150));
  const before = loads;
  expect(await read(async () => "visit read", polled)).toBe("N+1");
  expect(loads).toBe(before);
  // Once the visits stop, the background read stops too.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const stopped = loads;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(loads).toBe(stopped);
});
