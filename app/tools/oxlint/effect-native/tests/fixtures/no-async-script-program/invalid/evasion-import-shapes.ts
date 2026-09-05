// expect-count: 7
// Aliased / namespace / computed / submodule import shapes that are NOT driver edges.
import { Effect as E, pipe } from "effect";
import * as Fx from "effect/Effect";
import * as Sc from "effect/Schema";

// `sync` is not a Promise constructor: an async thunk here is still an async program.
export const a = E.sync(async () => 1);
// Namespace submodule import, non-driver-edge callee.
export const b = Fx.map(Fx.succeed(1), async (value: number) => value + 1);
// Computed access to a non-driver-edge member.
export const c = Fx["forEach"]([1], async (value: number) => value);
// The `catch` handler of a real driver edge is not itself Promise-land.
export const d = E.tryPromise({ catch: async (cause: unknown) => String(cause), try: () => Promise.resolve(1) });
// Second argument of a driver-edge constructor, not the first.
export const f = Fx.promise(Fx.succeed(1), async () => 2);
// A different effect namespace entirely.
export const g = Sc.transform(Sc.String, { decode: async (value: string) => value });
// A `try` key nested one level below the driver-edge options object.
export const h = E.tryPromise({ catch: String, try: { nested: async () => 1 } as never });
void pipe;
