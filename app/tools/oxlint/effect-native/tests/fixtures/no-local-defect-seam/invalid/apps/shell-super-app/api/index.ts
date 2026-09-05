// expect-count: 7
// A4: the Shell BFF repeats one `catchCause` + `Cause.hasDies` seam per handler.
// `Effect` comes from the Modern.js edge barrel that re-exports effect verbatim.
import { Effect, HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Cause, pipe } from 'effect';

declare const shellInternalProblem: () => { readonly _tag: 'ShellInternal' };
declare const currentSession: Effect.Effect<string, never>;
declare const listTenants: Effect.Effect<readonly string[], never>;
declare const api: never;

export const sessionHandler = currentSession.pipe(
  Effect.catchCause((cause) =>
    Cause.hasDies(cause)
      ? Effect.annotateLogs(Effect.logError('Unexpected Shell current-session defect', cause), {
          correlationId: 'missing',
        }).pipe(Effect.andThen(Effect.fail(shellInternalProblem())))
      : Effect.failCause(cause),
  ),
);

export const tenantHandler = listTenants.pipe(
  Effect.catchCause((cause) =>
    Cause.hasDies(cause) || Cause.hasInterrupts(cause)
      ? Effect.fail(shellInternalProblem())
      : Effect.failCause(cause),
  ),
);

// Point-free / data-first usage is the same seam.
export const sandboxed = pipe(currentSession, Effect.sandbox);
export const dataFirst = Effect.catchDefect(currentSession, () => Effect.fail(shellInternalProblem()));
