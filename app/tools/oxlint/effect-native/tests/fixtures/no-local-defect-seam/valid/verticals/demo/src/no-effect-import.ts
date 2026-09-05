// No effect import at all: nothing to resolve, nothing to report.
declare const Effect: { readonly catchCause: (f: unknown) => unknown };
declare const Cause: { readonly hasDies: (c: unknown) => boolean };

export const catchAll = Effect.catchCause(() => undefined);
export const dies = Cause.hasDies(undefined);
