import { Effect, pipe as flow } from 'effect';
import { withAresPolicy as withPolicy } from './policies.ts';
declare const read: () => Promise<string>;
const { promise: bridge, timeout: bound } = Effect;
const withBound = bound('1 second');
export const bounded = flow(bridge(read), withBound);
export const callback = Effect.forEach([1], () => bridge(read)).pipe(withPolicy);
export function unrelated(Effect: { promise: (x: unknown) => unknown }) {
  return Effect.promise(read);
}
export const withFinalizer = Effect.acquireRelease(Effect.succeed(1), () => bridge(read));
