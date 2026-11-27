import { describe, expect, it, rstest as vi } from "@rstest/core";
import { createSharedRead } from "../src/ontos/shared-read";

describe("typed public read sharing", () => {
  it("rejects an already cancelled visitor even when a stale answer is settled", async () => {
    const read = createSharedRead<string>();
    await read("product", 1000, async () => "previous");
    const caller = new AbortController();
    caller.abort();
    await expect(
      read("product", 0, async () => "updated", {
        caller: { signal: caller.signal },
        stale: true,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels one visitor without stopping the shared read for another", async () => {
    const read = createSharedRead<string>();
    const owner = Promise.withResolvers<string>();
    const load = vi.fn(async () => await owner.promise);
    const caller = new AbortController();
    const first = read("product", 1000, load, { caller: { signal: caller.signal } });
    const second = read("product", 1000, load);
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    caller.abort();
    await cancelled;
    owner.resolve("current product");
    expect(await second).toBe("current product");
    expect(await read("product", 1000, load)).toBe("current product");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds a new revision's wait and then publishes that revision's completed answer", async () => {
    const read = createSharedRead<string>();
    await read("product", 1000, async () => "previous", { generation: 1 });
    const owner = Promise.withResolvers<string>();
    const load = vi.fn(async () => await owner.promise);
    expect(await read("product", 1000, load, { generation: 2, waitMs: 1 })).toBe("previous");
    owner.resolve("updated");
    expect(await read("product", 1000, load, { generation: 2 })).toBe("updated");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never retains a settled answer the owner marks unavailable", async () => {
    const read = createSharedRead<{ ready: boolean }>();
    const load = vi.fn().mockResolvedValueOnce({ ready: false }).mockResolvedValue({ ready: true });
    const options = { keep: (value: { ready: boolean }) => value.ready };
    expect(await read("product", 1000, load, options)).toEqual({ ready: false });
    expect(await read("product", 1000, load, options)).toEqual({ ready: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps stale data after a failed background refresh and replaces it after recovery", async () => {
    const read = createSharedRead<string>();
    await read("product", 1000, async () => "previous");
    const failed = vi.fn(async () => {
      throw new Error("Owner unavailable");
    });
    expect(await read("product", 0, failed, { stale: true })).toBe("previous");
    const recovered = vi.fn(async () => "updated");
    expect(await read("product", 0, recovered, { stale: true })).toBe("previous");
    expect(await read("product", 1000, recovered)).toBe("updated");
    expect(failed).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});
