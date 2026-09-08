// Pathological but legal module syntax: top-level await, dynamic import, labels, regex, BigInt.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

const pattern = /Effect\.runPromise\(/gu;

export const size = 1_000n;

outer: for (const _ of [1, 2]) {
  break outer;
}

const mod = await import("node:util");

export const seam = await Effect.runPromise(program);

export const info = `${String(mod)}${String(pattern.source)}`;
