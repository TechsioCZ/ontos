import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogCache } from "@/ontos/catalog-cache";
import { nextRequest } from "../support/next-request";

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
let request: ReturnType<typeof nextRequest>;
beforeEach(() => {
  request = nextRequest();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("catalog stale-while-revalidate cache", () => {
  it("waits for the first read and serves it while fresh", async () => {
    const cache = catalogCache<string>(options);
    const reads: string[] = [];
    const load = async () => {
      reads.push("k");
      return "v1";
    };
    expect(await request.run(() => cache.get("k", load))).toBe("v1");
    vi.advanceTimersByTime(9_000);
    expect(await request.run(() => cache.get("k", load))).toBe("v1");
    await request.close();
    expect(reads).toEqual(["k"]);
  });
  it("renders a stale value at once and the background refresh on the next view", async () => {
    const cache = catalogCache<string>(options);
    await request.run(() => cache.get("k", async () => "v1"));
    vi.advanceTimersByTime(11_000);
    const slow = deferred<string>();
    const reads: string[] = [];
    const load = () => {
      reads.push("refresh");
      return slow.promise;
    };
    expect(await request.run(() => cache.get("k", load))).toBe("v1");
    expect(await request.run(() => cache.get("k", load))).toBe("v1");
    const closed = request.close();
    slow.resolve("v2");
    await closed;
    expect(reads).toEqual(["refresh"]);
    expect(
      await request.run(() =>
        cache.get("k", async () => {
          reads.push("unexpected");
          return "v3";
        }),
      ),
    ).toBe("v2");
    expect(reads).toEqual(["refresh"]);
  });
  it("does not start a stale refresh or its mint until after the response", async () => {
    const cache = catalogCache<string>(options);
    await request.run(() => cache.get("k", async () => "v1"));
    vi.advanceTimersByTime(11_000);
    const reads: string[] = [];
    const load = async () => {
      reads.push("owner");
      return "v2";
    };
    expect(await request.run(() => cache.get("k", load))).toBe("v1");
    expect(await request.run(() => cache.get("k", load))).toBe("v1");
    // Both reads have completed; Next has not received its response-close signal yet.
    expect(reads).toEqual([]);
    await request.close();
    expect(reads).toEqual(["owner"]);
    expect(await request.run(() => cache.get("k", load))).toBe("v2");
  });
  it("waits for the owner when the value is older than staleMs", async () => {
    const cache = catalogCache<string>(options);
    await request.run(() => cache.get("k", async () => "v1"));
    vi.advanceTimersByTime(options.staleMs);
    const slow = deferred<string>();
    const page = request.run(() => cache.get("k", () => slow.promise));
    await vi.advanceTimersByTimeAsync(5_000);
    slow.resolve("v2");
    expect(await page).toBe("v2");
    await request.close();
  });
  it("renders the previous value when the owner read fails, and fails without one", async () => {
    const cache = catalogCache<string>(options);
    await request.run(() => cache.get("k", async () => "v1"));
    vi.advanceTimersByTime(options.staleMs + 1);
    const fail = async (): Promise<string> => {
      throw new Error("503");
    };
    expect(await request.run(() => cache.get("k", fail))).toBe("v1");
    await expect(request.run(() => cache.get("other", fail))).rejects.toThrow("503");
    await request.close();
  });
  it("forgets values older than keepMs", async () => {
    const cache = catalogCache<string>(options);
    await request.run(() => cache.get("k", async () => "v1"));
    vi.advanceTimersByTime(options.keepMs);
    await expect(
      request.run(() =>
        cache.get("k", async () => {
          throw new Error("503");
        }),
      ),
    ).rejects.toThrow("503");
    await request.close();
  });
  it("does not retain a value that expires while a failed owner read is pending", async () => {
    const cache = catalogCache<string>(options);
    await request.run(() => cache.get("k", async () => "v1"));
    vi.advanceTimersByTime(options.keepMs - 1);
    const pending = deferred<string>();
    const page = request.run(() => cache.get("k", () => pending.promise));
    const rejected = expect(page).rejects.toThrow("owner unavailable");
    await vi.advanceTimersByTimeAsync(2);
    pending.reject(new Error("owner unavailable"));
    await rejected;
    await request.close();
  });
});
