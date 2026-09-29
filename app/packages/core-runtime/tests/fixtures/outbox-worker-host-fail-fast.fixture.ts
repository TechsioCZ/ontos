import { Effect, Layer, Option } from 'effect';

import { defineOutboxWorkerEntry, startOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';

const emptyResult = {
  claimed: 0,
  dead: 0,
  deliveriesCreated: 0,
  failed: 0,
  messagesMatched: 0,
  retried: 0,
  succeeded: 0,
} as const;

let failingCycles = 0;

const observedRuntime = (name: string, failAfterCycles: Option.Option<number>) =>
  Layer.effect(
    OutboxRuntime,
    Effect.acquireRelease(
      Effect.succeed({
        matchMessages: () => Effect.succeed({ deliveriesCreated: 0, messagesMatched: 0 }),
        runCycle: (input: { readonly claimOwner: string }) =>
          Effect.suspend(() => {
            process.stdout.write(`cycle:${name}:${input.claimOwner.split(':')[0] ?? ''}\n`);
            if (Option.isNone(failAfterCycles)) {
              return Effect.succeed(emptyResult);
            }
            failingCycles += 1;
            return failingCycles > failAfterCycles.value
              ? Effect.die('fixture loop defect')
              : Effect.succeed(emptyResult);
          }),
      }),
      () =>
        Effect.sync(() => {
          process.stdout.write(`disposed:${name}\n`);
        }),
    ),
  );

startOutboxWorkerHost({
  entries: [
    defineOutboxWorkerEntry({
      claimOwnerPrefix: 'billing-outbox-worker',
      layer: observedRuntime('billing', Option.some(3)),
      registrations: [],
      subscriptions: [],
    }),
    defineOutboxWorkerEntry({
      claimOwnerPrefix: 'ledger-outbox-worker',
      layer: observedRuntime('ledger', Option.none()),
      registrations: [],
      subscriptions: [],
    }),
  ],
});
