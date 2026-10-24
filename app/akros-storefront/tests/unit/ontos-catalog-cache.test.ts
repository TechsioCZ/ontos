import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { after } from "next/server";
import { catalogCache } from "@/ontos/catalog-cache";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn<typeof after>() }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn() }));

const options = {
  storage: "shared" as const,
  freshMs: 10_000,
  staleMs: 60_000,
  keepMs: 600_000,
  limit: 10,
};
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
  vi.mocked(after).mockImplementation((task) => {
    if (typeof task === "function") void task();
  });
  // No Cloudflare request context (plain Next.js): the isolate map only.
  vi.mocked(getCloudflareContext).mockImplementation(() => {
    throw new Error("no context");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  it("does not start a stale refresh or its mint until after the response", async () => {
    vi.useFakeTimers();
    const jobs: Array<() => unknown> = [];
    vi.mocked(after).mockImplementation((task) => {
      if (typeof task === "function") jobs.push(task);
    });
    const cache = catalogCache<string>("after-response", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(11_000);
    const load = vi.fn<() => Promise<string>>(async () => "v2");
    expect(await cache.get("k", load)).toBe("v1");
    expect(await cache.get("k", load)).toBe("v1");
    expect(load).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(1);
    await jobs[0]();
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.get("k", load)).toBe("v2");
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
  it("does not retain a value that expires while a failed owner read is pending", async () => {
    vi.useFakeTimers();
    const cache = catalogCache<string>("pending-expiry", options);
    await cache.get("k", async () => "v1");
    vi.advanceTimersByTime(options.keepMs - 1);
    const pending = deferred<string>();
    const page = cache.get("k", () => pending.promise);
    const rejected = expect(page).rejects.toThrow("owner unavailable");
    await vi.advanceTimersByTimeAsync(2);
    pending.reject(new Error("owner unavailable"));
    await rejected;
  });
  it("rejects expired shared prices even when KV retains them for its minimum 60-second TTL", async () => {
    vi.useFakeTimers();
    vi.mocked(after).mockClear();
    const strict = { ...options, staleMs: options.freshMs, keepMs: options.freshMs };
    const waits: Promise<unknown>[] = [];
    const at = Date.now() - 11_000;
    const store = {
      getWithMetadata: vi.fn(async () => ({
        value: JSON.stringify({ at, value: "old-price" }),
        metadata: { at },
      })),
      put: vi.fn(async () => undefined),
    };
    vi.mocked(getCloudflareContext).mockReturnValue({
      env: { STOREFRONT_CATALOG_CACHE: store },
      ctx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    } as unknown as ReturnType<typeof getCloudflareContext>);
    const cache = catalogCache<string>("prices", strict);
    const load = vi.fn(async () => "new-price");
    expect(await cache.get("k", load)).toBe("new-price");
    await Promise.all(waits);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledWith(
      expect.stringMatching(/^prices\//u),
      expect.any(String),
      {
        expirationTtl: 60,
        metadata: { at: Date.now() },
      },
    );
    await expect(
      cache.get("other", async () => {
        throw new Error("owner unavailable");
      }),
    ).rejects.toThrow("owner unavailable");
    expect(after).not.toHaveBeenCalled();
  });
  it("reads fresh prices without waiting for or writing shared caches, including across isolates", async () => {
    vi.useFakeTimers();
    const pending = deferred<never>();
    const edge = {
      match: vi.fn(() => pending.promise),
      put: vi.fn(() => pending.promise),
    };
    const store = {
      getWithMetadata: vi.fn(() => pending.promise),
      put: vi.fn(() => pending.promise),
    };
    const waitUntil = vi.fn();
    vi.stubGlobal("caches", { default: edge });
    vi.mocked(getCloudflareContext).mockReturnValue({
      env: { STOREFRONT_CATALOG_CACHE: store },
      ctx: { waitUntil },
    } as unknown as ReturnType<typeof getCloudflareContext>);
    const strict = {
      ...options,
      storage: "isolate" as const,
      staleMs: options.freshMs,
      keepMs: options.freshMs,
    };
    const cache = catalogCache<string>("prices", strict);
    const load = vi.fn(async () => "new-price");
    expect(await cache.get("k", load)).toBe("new-price");
    vi.advanceTimersByTime(9_999);
    expect(await cache.get("k", load)).toBe("new-price");
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await cache.get("k", load)).toBe("new-price");
    expect(load).toHaveBeenCalledTimes(2);
    expect(await catalogCache<string>("prices", strict).get("k", load)).toBe("new-price");
    expect(load).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10_000);
    await expect(
      cache.get("k", async () => {
        throw new Error("owner unavailable");
      }),
    ).rejects.toThrow("owner unavailable");
    expect(edge.match).not.toHaveBeenCalled();
    expect(edge.put).not.toHaveBeenCalled();
    expect(store.getWithMetadata).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
  it("serves fresh colo navigation without waiting for a pending KV lookup", async () => {
    vi.useFakeTimers();
    const at = Date.now() - options.freshMs + 1;
    const pending = deferred<{ value: null; metadata: null }>();
    const edge = {
      match: vi.fn<() => Promise<Response>>(
        async () =>
          new Response(JSON.stringify({ at, value: "colo-navigation" }), {
            headers: { "x-catalog-at": String(at) },
          }),
      ),
      put: vi.fn<() => Promise<void>>(),
    };
    const store = {
      getWithMetadata: vi.fn<() => typeof pending.promise>(() => pending.promise),
      put: vi.fn<() => Promise<void>>(),
    };
    vi.stubGlobal("caches", { default: edge });
    vi.mocked(getCloudflareContext).mockReturnValue({
      env: { STOREFRONT_CATALOG_CACHE: store },
      ctx: { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() },
    } as unknown as ReturnType<typeof getCloudflareContext>);
    const load = vi.fn<() => Promise<string>>(async () => "owner-navigation");
    let rendered: string | undefined;
    const read = catalogCache<string>("navigation", options)
      .get("k", load)
      .then((value) => {
        rendered = value;
      });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(rendered).toBe("colo-navigation");
      expect(store.getWithMetadata).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
    } finally {
      pending.resolve({ value: null, metadata: null });
      await read;
    }
  });
  it("starts KV while a colo miss is still pending", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response | undefined>();
    const at = Date.now();
    const edge = {
      match: vi.fn<() => typeof pending.promise>(() => pending.promise),
      put: vi.fn<() => Promise<void>>(),
    };
    const store = {
      getWithMetadata: vi.fn<() => Promise<{ value: string; metadata: { at: number } }>>(
        async () => ({
          value: JSON.stringify({ at, value: "kv-navigation" }),
          metadata: { at },
        }),
      ),
      put: vi.fn<() => Promise<void>>(),
    };
    vi.stubGlobal("caches", { default: edge });
    vi.mocked(getCloudflareContext).mockReturnValue({
      env: { STOREFRONT_CATALOG_CACHE: store },
      ctx: { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() },
    } as unknown as ReturnType<typeof getCloudflareContext>);
    const load = vi.fn<() => Promise<string>>(async () => "owner-navigation");
    const read = catalogCache<string>("navigation", options).get("k", load);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getWithMetadata).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
    } finally {
      pending.resolve(undefined);
      await read;
    }
    expect(await read).toBe("kv-navigation");
  });
  it.each(["newer", "unavailable"])(
    "prefers valid fresh colo navigation when KV is %s",
    async (state) => {
      vi.useFakeTimers();
      const at = Date.now() - 1;
      const edge = {
        match: vi.fn<() => Promise<Response>>(
          async () =>
            new Response(JSON.stringify({ at, value: "colo-navigation" }), {
              headers: { "x-catalog-at": String(at) },
            }),
        ),
        put: vi.fn<() => Promise<void>>(),
      };
      const store = {
        getWithMetadata: vi.fn<() => Promise<{ value: string; metadata: { at: number } }>>(
          async () => {
            if (state === "unavailable") throw new Error("KV unavailable");
            return {
              value: JSON.stringify({ at: at + 1, value: "newer-kv-navigation" }),
              metadata: { at: at + 1 },
            };
          },
        ),
        put: vi.fn<() => Promise<void>>(),
      };
      vi.stubGlobal("caches", { default: edge });
      vi.mocked(getCloudflareContext).mockReturnValue({
        env: { STOREFRONT_CATALOG_CACHE: store },
        ctx: { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() },
      } as unknown as ReturnType<typeof getCloudflareContext>);
      const load = vi.fn<() => Promise<string>>(async () => "owner-navigation");
      expect(await catalogCache<string>("navigation", options).get("k", load)).toBe(
        "colo-navigation",
      );
      expect(load).not.toHaveBeenCalled();
    },
  );
  it.each(["stream error", "truncated JSON"])(
    "reads valid KV navigation when a fresh colo body has a %s",
    async (state) => {
      vi.useFakeTimers();
      const at = Date.now() - 1;
      const edge = {
        match: vi.fn<() => Promise<Response>>(
          async () =>
            new Response(
              state === "stream error"
                ? new ReadableStream({
                    start(controller) {
                      controller.error(new Error("colo body unavailable"));
                    },
                  })
                : '{"value":',
              { headers: { "x-catalog-at": String(at) } },
            ),
        ),
        put: vi.fn<() => Promise<void>>(),
      };
      const store = {
        getWithMetadata: vi.fn<() => Promise<{ value: string; metadata: { at: number } }>>(
          async () => ({
            value: JSON.stringify({ at: at + 1, value: "kv-navigation" }),
            metadata: { at: at + 1 },
          }),
        ),
        put: vi.fn<() => Promise<void>>(),
      };
      vi.stubGlobal("caches", { default: edge });
      vi.mocked(getCloudflareContext).mockReturnValue({
        env: { STOREFRONT_CATALOG_CACHE: store },
        ctx: { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() },
      } as unknown as ReturnType<typeof getCloudflareContext>);
      const load = vi.fn<() => Promise<string>>(async () => {
        throw new Error("owner unavailable");
      });
      expect(await catalogCache<string>("navigation", options).get("k", load)).toBe(
        "kv-navigation",
      );
      expect(load).not.toHaveBeenCalled();
    },
  );
  it.each(["expired", "missing", "unavailable", "unbound"])(
    "reads KV when the colo navigation is %s",
    async (state) => {
      vi.useFakeTimers();
      const at = Date.now();
      const coloAt = at - options.freshMs;
      const edge = {
        match: vi.fn<() => Promise<Response | undefined>>(async () => {
          if (state === "unavailable") throw new Error("Cache API unavailable");
          return state === "missing"
            ? undefined
            : new Response(JSON.stringify({ at: coloAt, value: "old-navigation" }), {
                headers: { "x-catalog-at": String(coloAt) },
              });
        }),
        put: vi.fn<() => Promise<void>>(),
      };
      const store = {
        getWithMetadata: vi.fn<() => Promise<{ value: string; metadata: { at: number } }>>(
          async () => ({
            value: JSON.stringify({ at, value: "current-navigation" }),
            metadata: { at },
          }),
        ),
        put: vi.fn<() => Promise<void>>(),
      };
      vi.stubGlobal("caches", { default: state === "unbound" ? undefined : edge });
      vi.mocked(getCloudflareContext).mockReturnValue({
        env: { STOREFRONT_CATALOG_CACHE: store },
        ctx: { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() },
      } as unknown as ReturnType<typeof getCloudflareContext>);
      const load = vi.fn<() => Promise<string>>(async () => "owner-navigation");
      expect(await catalogCache<string>("navigation", options).get("k", load)).toBe(
        "current-navigation",
      );
      expect(store.getWithMetadata).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
    },
  );
  it("shares navigation read by a shopper with another Worker isolate", async () => {
    const stored = new Map<string, { value: string; metadata: unknown }>();
    const waits: Promise<unknown>[] = [];
    const store = {
      getWithMetadata: vi.fn(
        async (key: string) => stored.get(key) ?? { value: null, metadata: null },
      ),
      put: vi.fn(async (key: string, value: string, options: { metadata?: unknown }) => {
        stored.set(key, { value, metadata: options.metadata });
      }),
    };
    vi.mocked(getCloudflareContext).mockReturnValue({
      env: { STOREFRONT_CATALOG_CACHE: store },
      ctx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    } as unknown as ReturnType<typeof getCloudflareContext>);
    await catalogCache<string>("t", options).get("k", async () => "v1");
    await Promise.all(waits);
    expect(store.put).toHaveBeenCalledWith(expect.stringMatching(/^t\//u), expect.any(String), {
      expirationTtl: options.keepMs / 1000,
      metadata: { at: expect.any(Number) },
    });
    const load = vi.fn(async () => "v2");
    const other = catalogCache<string>("t", options);
    expect(await other.get("k", load)).toBe("v1");
    expect(load).not.toHaveBeenCalled();
    // The isolate's own copy then renders without another shared lookup.
    store.getWithMetadata.mockClear();
    expect(await other.get("k", load)).toBe("v1");
    expect(store.getWithMetadata).not.toHaveBeenCalled();
  });
});
