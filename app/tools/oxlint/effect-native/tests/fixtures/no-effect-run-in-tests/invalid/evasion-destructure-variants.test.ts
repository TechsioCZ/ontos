// expect-count: 2
// Renamed-with-default and computed keys in an ObjectPattern are still the run functions.
import { Effect } from "effect";

declare const fallback: unknown;

const { runPromise: rp = fallback, ["runSync"]: rs, ...rest } = Effect;

export const collected = [rp, rs, rest];
