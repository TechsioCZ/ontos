import { Effect } from 'effect';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

/** Runs a tagging client Effect in the browser runtime. Exactly one handler runs when it settles. */
export const runTagEffect = <A, E>(
  effect: Effect.Effect<A, E>,
  handlers: { readonly onFailure: (error: E) => void; readonly onSuccess: (value: A) => void },
) => {
  void browserRuntime.runPromise(effect.pipe(Effect.match(handlers)));
};
