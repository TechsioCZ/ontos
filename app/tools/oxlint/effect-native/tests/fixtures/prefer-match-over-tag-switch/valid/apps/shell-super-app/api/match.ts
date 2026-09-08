import { Effect, Match } from 'effect';
import { Match as M } from 'effect';
import * as MatchNs from 'effect/Match';

class ReadInputValidationError {
  readonly _tag = 'ReadInputValidationError';
}
class ReadHandlerNotFound {
  readonly _tag = 'ReadHandlerNotFound';
}
type IdentityRuntimeError = ReadInputValidationError | ReadHandlerNotFound;

declare const invalid: () => string;
declare const notFound: () => string;

/** The audit's target: exhaustive Match over the tagged union. */
export const identityProblem = (error: IdentityRuntimeError): string =>
  Match.value(error).pipe(
    Match.tags({
      ReadHandlerNotFound: notFound,
      ReadInputValidationError: invalid,
    }),
    Match.exhaustive,
  );

/** Aliased root import — still Match, still no switch. */
export const aliased = (error: IdentityRuntimeError): string =>
  M.value(error).pipe(M.tag('ReadHandlerNotFound', notFound), M.orElse(invalid));

/** Namespace import of the `effect/Match` submodule. */
export const namespaced = (state: 'loading' | 'ready'): string =>
  MatchNs.value(state).pipe(
    MatchNs.when('loading', () => 'spinner'),
    MatchNs.when('ready', () => 'view'),
    MatchNs.exhaustive,
  );

/** Failures stay on the error channel. */
export const handled = (
  program: Effect.Effect<string, IdentityRuntimeError>,
): Effect.Effect<string> =>
  program.pipe(
    Effect.catchTags({
      ReadHandlerNotFound: () => Effect.succeed(notFound()),
      ReadInputValidationError: () => Effect.succeed(invalid()),
    }),
  );
