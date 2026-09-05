// The single outer HTTP instrumentation/error seam A4/A6 asks for (matches the default `seamPaths`).
// Exactly one place converts defects into a sanitized typed internal problem.
import { Cause, Effect } from 'effect';

declare const internalProblem: () => { readonly _tag: 'Internal' };

export const withHttpErrorSeam = <A, E>(handler: Effect.Effect<A, E>): Effect.Effect<A, E | { readonly _tag: 'Internal' }> =>
  handler.pipe(
    Effect.catchCause((cause) =>
      Cause.hasDies(cause) || Cause.hasInterrupts(cause)
        ? Effect.annotateLogs(Effect.logError('Unhandled defect at the HTTP seam', cause), {
            seam: 'http',
          }).pipe(Effect.andThen(Effect.fail(internalProblem())))
        : Effect.failCause(cause),
    ),
    Effect.catchDefect(() => Effect.fail(internalProblem())),
  );
