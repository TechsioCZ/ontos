import { startOutboxWorkerHost } from '@app/core-runtime/outbox/worker';
import { Console, Effect, Layer, Option } from 'effect';

import { CommerceEnrollmentContinuation } from '../../src/enrollment/continuation/enrollment-continuation.ts';
import { runCommerceEnrollmentRecovery, withCommerceEnrollmentRecovery } from '../../src/worker-host/recovery.ts';

// No database or transport credentials. This fixture proves the real process signal boundary;
// native journal and owner-side-effect recovery belongs to the separate database proofs.
const continuation = Layer.effect(
  CommerceEnrollmentContinuation,
  Effect.acquireRelease(
    Effect.succeed({
      advance: () => Effect.succeed({ outcome: 'COMPLETE' as const }),
      openSweepPass: Effect.succeed({
        advance: () => Effect.succeed({ outcome: 'COMPLETE' as const }),
        claimSweep: () => Effect.succeed(Option.some(1)),
        compositionRevision: `sha256:${'a'.repeat(64)}`,
        listDue: () => Console.log('recovery-discovered').pipe(Effect.as([])),
      }),
    }),
    () => Console.log('recovery-disposed'),
  ),
);

startOutboxWorkerHost({
  entries: [
    withCommerceEnrollmentRecovery(
      {
        claimOwnerPrefix: 'commerce-recovery-signal-proof',
        registrations: 1,
        runLoop: ({ health }) =>
          Effect.acquireUseRelease(
            Console.log('outbox-started'),
            () => Effect.forever((health?.cycleSucceeded ?? Effect.void).pipe(Effect.andThen(Effect.sleep(10)))),
            () => Console.log('outbox-disposed'),
          ),
      },
      (health) =>
        Effect.scoped(
          Layer.build(continuation).pipe(
            Effect.flatMap((context) => Effect.provideContext(runCommerceEnrollmentRecovery(health), context)),
          ),
        ),
    ),
  ],
  health: true,
});
