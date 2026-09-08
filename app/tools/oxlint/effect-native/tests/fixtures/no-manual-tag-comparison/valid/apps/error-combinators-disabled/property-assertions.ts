import { expect } from '@app/effect-rstest';
import { Effect } from 'effect';
declare const program: Effect.Effect<unknown, unknown>;
program.pipe(Effect.catch((error) => {
  expect(error).toHaveProperty('_tag');
  expect(error).toHaveProperty('cause._tag', 'Missing');
  return Effect.void;
}));
