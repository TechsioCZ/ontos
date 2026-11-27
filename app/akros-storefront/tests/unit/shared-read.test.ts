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

it("without waitMs, a new generation waits for its own read", async () => {
  expect(await sharedRead("k", 15_000, async () => "R1", { generation: 1 })).toBe("R1");
  const read = sharedRead("k", 15_000, () => later(40).then(() => "R2"), { generation: 2 });
  expect(await read).toBe("R2");
});

it("reads the answers visitors used lately again for a new generation, so its first visitor does not wait", async () => {
  let reads = 0;
  const owner = { state: "R1" };
  const load = async () => {
    reads += 1;
    return owner.state;
  };
  expect(await sharedRead("product", 15_000, load, { generation: 1, waitMs: 20 })).toBe("R1");
  expect(await sharedRead("tree", 15_000, load, { generation: 1, waitMs: 20 })).toBe("R1");
  owner.state = "R2";
  renewSharedReads(2);
  await later(0);
  expect(reads).toBe(4);
  // The first visitor of generation 2 takes the renewed answer, even one that cannot wait.
  expect(
    await sharedRead("product", 15_000, async () => "never read", { generation: 2, waitMs: 0 }),
  ).toBe("R2");
  // A renewal never replaces a newer generation, and does not read again what it already read.
  renewSharedReads(2);
  await later(0);
  expect(reads).toBe(4);
});
