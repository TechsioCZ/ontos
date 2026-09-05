// `includeTests` (default false): D tier blesses deliberately malformed values in tests, and B2's
// Effect test harness does not exist yet, so test doubles still synthesise rejection values.
import { Effect } from "effect";

export const rejectingDouble = () => Effect.die(new Error("deliberate test defect"));

export const malformed = new TypeError("proves the decoder rejects this shape");

export const isNative = (cause: unknown): boolean => cause instanceof Error;
