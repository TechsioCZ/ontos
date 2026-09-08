// expect-count: 7
import { it } from 'effect-rstest';
import { Effect } from 'effect';

const complete = () => Promise.resolve();
it('local Promise factory', () => complete());
it('local Promise value', () => {
  const result = Promise.resolve();
  return result;
});
it('resolved Promise', () => Promise.resolve());
it('block return', () => {
  const value = 1;
  return Promise.resolve(value);
});
it('global Promise', () => globalThis.Promise.all([]));
it('Effect runner', () => Effect.runPromise(Effect.void));
it('Promise constructor', () => new Promise((resolve) => resolve(undefined)));
