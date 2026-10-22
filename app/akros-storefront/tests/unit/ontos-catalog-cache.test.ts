import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogCache } from "@/ontos/catalog-cache";

vi.mock("server-only", () => ({}));

const options = { freshMs: 10_000, keepMs: 60_000, refreshWaitMs: 800, limit: 10 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("catalog stale-while-revalidate cache", () => {
  it("waits for the first read and serves it while fresh", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    const load = vi.fn(async () => "v1");
    expect(await cache.get("k", load)).toBe("v1");
    vi.advanceTimersByTime(9_000);
    expect(await cache.get("k", load)).toBe("v1");
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("renders a stale value when the refresh is slow and the refreshed value afterwards", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(11_000);
    const slow = deferred<string>();
    const page = cache.get("k", () => slow.promise);
    await vi.advanceTimersByTimeAsync(options.refreshWaitMs);
    expect(await page).toBe("v1");
    slow.resolve("v2");
    await vi.advanceTimersByTimeAsync(0);
    const load = vi.fn(async () => "v3");
    expect(await cache.get("k", load)).toBe("v2");
    expect(load).not.toHaveBeenCalled();
  });
  it("renders the refreshed value when the refresh is quick", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(11_000);
    expect(await cache.get("k", async () => "v2")).toBe("v2");
  });
  it("renders the previous value when the owner read fails, and fails without one", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(11_000);
    expect(await cache.get("k", async () => Promise.reject(new Error("503")))).toBe("v1");
    await expect(cache.get("other", async () => Promise.reject(new Error("503")))).rejects.toThrow(
      "503",
    );
  });
  it("forgets values older than keepMs", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(options.keepMs);
    const slow = deferred<string>();
    const page = cache.get("k", () => slow.promise);
    await vi.advanceTimersByTimeAsync(options.refreshWaitMs * 2);
    slow.resolve("v2");
    expect(await page).toBe("v2");
  });
});
