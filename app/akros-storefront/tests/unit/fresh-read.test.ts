import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperation } from "@ontos/storefront-runtime";
import { clearFreshReads, freshRead, latestFreshRead } from "@/ontos/fresh-read";
import {
  applyLiveFrame,
  ERP_OWNERS,
  MERCHANDISE_OWNERS,
  resetLiveChanges,
  setLiveConnected,
} from "@/ontos/live-changes";

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
  resetLiveChanges();
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

it("with waitMs, hands a visit the newest answer once a slow read takes longer, and the read goes on", async () => {
  const bounded = { ...timing, waitMs: 20 };
  expect(await read(load, bounded)).toBe("N");
  vi.advanceTimersByTime(2_000);
  let finish: (value: string) => void = () => undefined;
  expect(await read(() => new Promise<string>((resolve) => (finish = resolve)), bounded)).toBe("N");
  finish("N+1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await read(async () => "never read", bounded)).toBe("N+1");
  // A visit with nothing kept still waits for its own read.
  clearFreshReads();
  expect(
    await read(() => new Promise((resolve) => setTimeout(() => resolve("slow"), 60)), bounded),
  ).toBe("slow");
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

it("with the change stream open, serves the answer without an owner read until its owner changes, then reads again at once", async () => {
  vi.useRealTimers();
  const streamed = { maxAgeMs: 50, intervalMs: 20, keepAliveMs: 2_000, owners: MERCHANDISE_OWNERS };
  setLiveConnected(true, Date.now() - 1);
  expect(await read(load, streamed)).toBe("N");
  // Older than maxAgeMs, yet no merchandise change: no owner read, no background repeat.
  await new Promise((resolve) => setTimeout(resolve, 120));
  owner = "unsaved";
  expect(await read(load, streamed)).toBe("N");
  expect(loads).toBe(1);
  // Another owner's change keeps the answer.
  applyLiveFrame("event: change\ndata: catalog");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await read(load, streamed)).toBe("N");
  expect(loads).toBe(1);
  // An admin save: the background read repeats at the change, so the next visit takes the new state at once.
  owner = "N+1";
  applyLiveFrame("event: change\ndata: merchandise,shell");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(loads).toBe(2);
  expect(await read(load, streamed)).toBe("N+1");
  expect(loads).toBe(2);
});

it("with the stream open, never serves an answer whose read started before its owner's change", async () => {
  const streamed = { ...timing, owners: ERP_OWNERS };
  setLiveConnected(true, Date.now() - 1);
  let finish: (value: string) => void = () => undefined;
  const running = read(() => new Promise<string>((resolve) => (finish = resolve)), streamed);
  vi.advanceTimersByTime(1);
  applyLiveFrame("event: change\ndata: pricing");
  finish("N");
  // The visit that waited gets its own read.
  expect(await running).toBe("N");
  owner = "N+1";
  // Only 1 ms old, but read before the price change: read again.
  expect(await read(load, streamed)).toBe("N+1");
  // A stream that opens again counts as a change of every owner.
  owner = "N+2";
  vi.advanceTimersByTime(1);
  setLiveConnected(true);
  vi.advanceTimersByTime(1);
  expect(await read(load, streamed)).toBe("N+2");
  // Without the stream the time bound applies again.
  owner = "N+3";
  setLiveConnected(false);
  expect(await read(load, streamed)).toBe("N+2");
  vi.advanceTimersByTime(2_000);
  expect(await read(load, streamed)).toBe("N+3");
});
