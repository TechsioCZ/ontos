// expect-count: 7
// B1 policies bound only evaluated work, not dormant values, preceding pipeline stages,
// unrelated helper callbacks or shadowed imports. Imports/aliases retain lexical identity.
import { Effect, pipe as flow } from 'effect';
declare const read: () => Promise<string>;
const { tryPromise: bridge } = Effect;
export const alias = bridge(read);
export const template = (Effect as typeof Effect)[`promise`](read);
export const before = Effect.succeed(1).pipe(
  Effect.timeout('1 second'),
  Effect.flatMap(() => Effect.promise(read)),
);
export const dormant = Effect.sync(() => Effect.promise(read)).pipe(Effect.timeout('1 second'));
export const value = Effect.succeed(Effect.promise(read)).pipe(Effect.timeout('1 second'));
export function shadowPolicy(Effect: { timeout: (s: string) => <A>(x: A) => A }) {
  return bridge(read).pipe(Effect.timeout('1 second'));
}
export function localPolicy() {
  const pretendPolicy = <A>(x: A) => x;
  return flow(bridge(read), pretendPolicy);
}
