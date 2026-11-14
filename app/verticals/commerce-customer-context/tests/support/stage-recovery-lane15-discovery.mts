import {
  ActionAuthorizationPreflightDatabaseLive,
  CorePersistenceLive,
  DatabaseConfig,
  parseDatabaseConfig,
} from '@app/core-runtime';
import { NodeRuntime } from '@effect/platform-node';
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from 'effect';

import { ClaimEnrollmentTransitionInputSchema, EnrollmentAttemptIdSchema } from '../../shared/enrollment-contracts.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentDueAttemptStoreForRun,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../../src/enrollment/orchestration/owner-transaction-runner.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';

// Owner-local native child, invoked only by the existing integration test entrypoint.
// Credentials come from injected process configuration, never a file or command-line argument.
const InputSchema = Schema.Struct({
  mode: Schema.Literals(['claim', 'discover']),
  transition: CommerceEnrollmentOwnerTransitionSchema,
});
const Lane15DiscoveryReceiptSchema = Schema.Struct({
  attemptIds: Schema.Array(EnrollmentAttemptIdSchema),
  phase: Schema.Literals(['claimed', 'discovered']),
  pid: Schema.Number,
});

const database = Layer.effect(
  DatabaseConfig,
  Config.Redacted('DATABASE_URL').pipe(
    Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
  ),
);
const runner = CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
  Layer.provide(
    ActionAuthorizationPreflightDatabaseLive.pipe(Layer.provide(CorePersistenceLive.pipe(Layer.provide(database)))),
  ),
);
const nativeChild = Effect.gen(function* lane15NativeChild() {
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InputSchema))(process.argv[2]);
  const transactions = yield* CommerceEnrollmentOwnerTransactionRunner;
  const { transition } = input;
  let attemptIds: readonly (typeof EnrollmentAttemptIdSchema.Type)[] = [];
  if (input.mode === 'claim') {
    const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: transition.tenantId }, transactions.run);
    const claimed = yield* store.claimTransition(
      yield* Schema.decodeEffect(ClaimEnrollmentTransitionInputSchema)({
        actorPrincipalId: transition.actorPrincipalId,
        expectedRevision: transition.expectedRevision,
        leaseDurationMs: 60_000,
        ownerInvocationId: transition.ownerInvocationId,
        ownerModuleKey: transition.ownerModuleKey,
        portalEnrollmentAttemptId: transition.portalEnrollmentAttemptId,
        requestDigest: transition.requestDigest,
        required: true,
        tenantId: transition.tenantId,
        transitionKey: transition.transitionKey,
        workerId: 'lane15-native-crash-process',
      }),
    );
    if (claimed.outcome !== 'CLAIMED') {
      yield* Effect.die('The crash fixture did not acquire a fresh durable claim');
    }
    attemptIds = [claimed.attempt.portalEnrollmentAttemptId];
  } else {
    const rows = yield* commerceEnrollmentDueAttemptStoreForRun(transactions.runWorker).listDue({
      after: Option.none(),
      limit: 500,
      maxSweeps: 3,
      staleAfterMillis: 0,
    });
    attemptIds = rows.filter((row) => row.tenantId === transition.tenantId).map((row) => row.portalEnrollmentAttemptId);
  }
  yield* Console.log(
    yield* Schema.encodeEffect(Schema.fromJsonString(Lane15DiscoveryReceiptSchema))({
      attemptIds,
      phase: input.mode === 'claim' ? 'claimed' : 'discovered',
      pid: process.pid,
    }),
  );
  if (input.mode === 'claim') {
    // The parent kills this exact PID only after observing the post-commit receipt.
    yield* Effect.never;
  }
}).pipe(Effect.scoped, Effect.provide(runner));

// Do not export this executable entrypoint through a product package.
NodeRuntime.runMain(nativeChild);
