// FALSE POSITIVE regression fixture (must not report).
//
// The driver-edge seam (`Effect.tryPromise({ try: async () => … })`,
// `Effect.promise(async () => …)`) is explicitly allowed, and the rule header
// claims `as` / `satisfies` / `!` wrappers are handled. They are not:
// `skipWrappers` climbs *up* to the outermost TS wrapper while
// `isFirstArgumentOf` calls `unwrap` to peel the argument *down* to the bare
// expression, so the two identities can never be equal once any wrapper is
// present and the exemption silently disappears.
import { Effect } from "effect";

// `as` cast on the driver-edge function itself.
export const a = Effect.promise((async () => 3) as () => Promise<number>);

// `as const` on the tryPromise options object.
export const b = Effect.tryPromise({
	catch: (cause: unknown) => new Error(String(cause)),
	try: async () => 2,
} as const);

// `satisfies` on the tryPromise options object.
export const c = Effect.tryPromise({
	catch: (cause: unknown) => new Error(String(cause)),
	try: async () => 2,
} satisfies { readonly catch: (cause: unknown) => Error; readonly try: () => Promise<number> });
