// Every way a policy can legitimately be attached to a Promise bridge.
import { Effect, Schedule, pipe } from 'effect';

import { withAresPolicy } from './shared-policies.ts';

declare const db: { rollback: () => Promise<void>; read: () => Promise<string> };

const withDatabasePolicy = Effect.timeout('5 seconds');
const databaseRetry = Effect.retry({ schedule: Schedule.exponential('50 millis'), while: () => true });

// Same-file partially applied `Effect.timeout`.
export const rollback = Effect.tryPromise(() => db.rollback()).pipe(withDatabasePolicy);

// Same-file partially applied `Effect.retry`, several stages down the chain.
export const read = Effect.tryPromise({ catch: () => new Error('read failed'), try: () => db.read() }).pipe(
  Effect.mapError(() => new Error('mapped')),
  databaseRetry,
);

// Imported shared combinator matching `policyHelperPattern`.
export const shared = Effect.tryPromise(() => db.read()).pipe(withAresPolicy);

// Data-first policy wrapper.
export const dataFirst = Effect.timeout(Effect.tryPromise(() => db.read()), '2 seconds');

// Bare `pipe(...)` from `effect`.
export const pointFree = pipe(
  Effect.tryPromise(() => db.read()),
  Effect.mapError(() => new Error('mapped')),
  Effect.timeout('1 second'),
);

// A policy on the surrounding `Effect.gen` really does bound the calls inside it.
export const generated = Effect.gen(function* () {
  const first = yield* Effect.tryPromise(() => db.read());
  const second = yield* Effect.tryPromise(() => db.read());
  return [first, second] as const;
}).pipe(Effect.timeout('4 seconds'));
