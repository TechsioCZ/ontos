// Every spelling of a policy that really is attached to the bridge. None of these may report.
import { Effect } from 'effect';
import { pipe } from 'effect/Function';
import { timeout } from 'effect/Effect';

declare const db: { read: () => Promise<string> };

// A TS wrapper between the bridge and its `.pipe`.
export const asChain = (Effect.tryPromise(() => db.read()) as Effect.Effect<string, unknown>).pipe(
  Effect.timeout('1 second'),
);
export const nonNullChain = Effect.tryPromise(() => db.read())!.pipe(Effect.timeout('1 second'));

// Computed `pipe`, computed policy member.
export const computedPipe = Effect.tryPromise(() => db.read())['pipe'](Effect.timeout('1 second'));
export const computedTimeout = Effect['timeout'](Effect.tryPromise(() => db.read()), '1 second');

// Bare member import of the policy, and `pipe` from `effect/Function`.
export const bareTimeout = Effect.tryPromise(() => db.read()).pipe(timeout('1 second'));
export const functionPipe = pipe(Effect.tryPromise(() => db.read()), Effect.timeout('1 second'));

// Data-first retry, and a policy several `.pipe` calls down the chain.
export const dataFirstRetry = Effect.retry(Effect.tryPromise(() => db.read()), { times: 3 });
export const doubleChain = Effect.tryPromise(() => db.read())
  .pipe(Effect.mapError(() => new Error('mapped')))
  .pipe(Effect.timeout('1 second'));
