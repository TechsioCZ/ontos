import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { catalogCache } from "@/ontos/catalog-cache";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn() }));

const options = { freshMs: 10_000, staleMs: 60_000, keepMs: 600_000, limit: 10 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  // No Cloudflare request context (plain Next.js): the isolate map only.
  vi.mocked(getCloudflareContext).mockImplementation(() => {
    throw new Error("no context");
  });
});
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
  it("renders a stale value at once and the background refresh on the next view", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(11_000);
    const slow = deferred<string>();
    const load = vi.fn(() => slow.promise);
    expect(await cache.get("k", load)).toBe("v1");
    // A second view while the refresh runs starts no second owner read.
    expect(await cache.get("k", load)).toBe("v1");
    expect(load).toHaveBeenCalledTimes(1);
    slow.resolve("v2");
    await vi.advanceTimersByTimeAsync(0);
    const next = vi.fn(async () => "v3");
    expect(await cache.get("k", next)).toBe("v2");
    expect(next).not.toHaveBeenCalled();
  });
  it("waits for the owner when the value is older than staleMs", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(options.staleMs);
    const slow = deferred<string>();
    const page = cache.get("k", () => slow.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    slow.resolve("v2");
    expect(await page).toBe("v2");
  });
  it("renders the previous value when the owner read fails, and fails without one", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(options.staleMs + 1);
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
    await expect(cache.get("k", async () => Promise.reject(new Error("503")))).rejects.toThrow(
      "503",
    );
  });
  it("warms only values older than the given age", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("t", options);
    const load = vi.fn(async () => "v1");
    expect(await cache.warm("k", load, 30_000)).toBe("refreshed");
    vi.advanceTimersByTime(20_000);
    expect(await cache.warm("k", load, 30_000)).toBe("fresh");
    expect(await cache.warm("j", async () => Promise.reject(new Error("503")), 30_000)).toBe(
      "failed",
    );
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("on Workers reads and writes the shared catalog store, so another isolate starts warm", async () => {
    const stored = new Map<string, string>();
    const waits: Promise<unknown>[] = [];
    const store = {
      get: vi.fn(async (key: string) => {
        const value = stored.get(key);
        return value === undefined ? null : JSON.parse(value);
      }),
      put: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
    };
    vi.mocked(getCloudflareContext).mockReturnValue({
      env: { STOREFRONT_CATALOG_CACHE: store },
      ctx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    } as unknown as ReturnType<typeof getCloudflareContext>);
    await catalogCache<string>("t", options).warm("k", async () => "v1", 30_000);
    await Promise.all(waits);
    expect(store.put).toHaveBeenCalledWith(expect.stringMatching(/^t\//u), expect.any(String), {
      expirationTtl: options.keepMs / 1000,
    });
    const load = vi.fn(async () => "v2");
    expect(await catalogCache<string>("t", options).get("k", load)).toBe("v1");
    expect(load).not.toHaveBeenCalled();
  });
});
