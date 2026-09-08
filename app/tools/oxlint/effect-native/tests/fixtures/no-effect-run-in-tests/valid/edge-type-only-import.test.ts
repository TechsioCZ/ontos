// A type-only import is erased before runtime and cannot open a fiber, so it is not a B2 site.
import type { runPromise } from "effect/Effect";
import { type runSync } from "effect/Effect";

export type Runner = typeof runPromise;
export type SyncRunner = typeof runSync;
