import { beforeEach, expect, it } from "vitest";
import { clearSharedReads, sharedRead } from "@/ontos/shared-read";

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
