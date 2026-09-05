// `Effect` imported from a project-local module is not the `effect` package.
import { Effect } from './local-effect.ts';

export const value = Effect.gen(function* () {
  yield* Effect.log('x');
  throw new Error('this file never imports the effect package');
});
