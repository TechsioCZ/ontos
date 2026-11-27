import { beforeEach, expect, it } from "vitest";
import { clearSharedReads, renewSharedReads, sharedRead } from "@/ontos/shared-read";

beforeEach(() => clearSharedReads());

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("with waitMs, serves the replaced generation's answer while the new generation's first read is slow", async () => {
  expect(await sharedRead("k", 15_000, async () => "R1", { generation: 1, waitMs: 20 })).toBe("R1");
  let finish: (value: string) => void = () => undefined;
  const slow = () => new Promise<string>((resolve) => (finish = resolve));
  expect(await sharedRead("k", 15_000, slow, { generation: 2, waitMs: 20 })).toBe("R1");
  // The next reader of the new generation joins that read instead of starting another one.
  expect(
    await sharedRead("k", 15_000, async () => "never read", { generation: 2, waitMs: 20 }),
  ).toBe("R1");
  finish("R2");
  await later(0);
  expect(
    await sharedRead("k", 15_000, async () => "never read", { generation: 2, waitMs: 20 }),
  ).toBe("R2");
});

it("a new generation read again in the background reaches the first visit after it, once per generation", async () => {
  let reads = 0;
  const load = async () => `R${(reads += 1)}`;
  expect(await sharedRead("k", 15_000, load, { stale: true, generation: 1, waitMs: 0 })).toBe("R1");
  renewSharedReads(2);
  // Announced while the pass for 2 runs: folded into one more pass, for the newest only.
  renewSharedReads(3);
  renewSharedReads(4);
  await later(5);
  expect(reads).toBe(3);
  expect(await sharedRead("k", 15_000, load, { stale: true, generation: 4, waitMs: 0 })).toBe("R3");
  expect(reads).toBe(3);
});

it("without waitMs, a new generation waits for its own read", async () => {
  expect(await sharedRead("k", 15_000, async () => "R1", { generation: 1 })).toBe("R1");
  const read = sharedRead("k", 15_000, () => later(40).then(() => "R2"), { generation: 2 });
  expect(await read).toBe("R2");
});
