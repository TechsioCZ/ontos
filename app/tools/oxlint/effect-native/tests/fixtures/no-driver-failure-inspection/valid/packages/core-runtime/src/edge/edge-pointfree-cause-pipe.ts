/**
 * Point-free form of the pattern the rule already blesses in applied form.
 *
 * `Effect.failCause(rollbackSignal.cause)` and `Cause.pretty(rollbackSignal.cause)` are allowed by
 * `causeSinks`, but `insideCauseSink` only inspects the *callee* of the enclosing call, so the same
 * two expressions written point-free through `pipe` report as ".cause chain walking". `pipe` is the
 * standard Effect combinator form, and `RollbackSignal` (see `valid/packages/core-runtime/src/
 * actions/runtime.ts`) is a real shape in this repo, so this is not a driver failure walk.
 */
import { Cause, Effect, pipe } from 'effect';

declare const rollbackSignal: { readonly cause: Cause.Cause<never> };

export const rethrow = (): Effect.Effect<never> => pipe(rollbackSignal.cause, Effect.failCause);

export const render = (): string => pipe(rollbackSignal.cause, Cause.pretty);
