import { OutboxWorkerTenantScope } from '@app/core-runtime/outbox/worker';
import { defineScopedRoutine, isVerifiedOutboxWorkerHandlerContext } from '@app/core-runtime';
import type { ScopedRoutineInvoker, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Context, Effect, Layer, Option, Ref, Schema } from 'effect';
import { SymmyJobNotificationClaimSchema } from '../../shared/domain/symmy-job-notification.ts';
import type {
  SymmyJobNotificationClaim,
  SymmyJobNotificationClaimInput,
  SymmyJobNotificationSettlement,
} from '../../shared/domain/symmy-job-notification.ts';

import { SymmyJobLifecycleStoreError } from './symmy-job-notification-store-error.ts';

export { SymmyJobLifecycleStoreError } from './symmy-job-notification-store-error.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(new SymmyJobLifecycleStoreError({ code: 'lifecycle_store_unavailable' }), 'cause', {
    enumerable: false,
    value: cause,
  });
const ownerModuleKey = 'integration.symmy';
const base = { ownerModuleKey, schema: 'symmy_integration' } as const;
const claim = defineScopedRoutine({
  ...base,
  name: 'claim_symmy_job_notification',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.toEncoded(SymmyJobNotificationClaimSchema),
  routineKey: 'symmy-job.claim-notification',
});
const settle = defineScopedRoutine({
  ...base,
  name: 'settle_symmy_job_notification',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'boolean' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: Schema.Struct({ applied: Schema.Boolean }),
  routineKey: 'symmy-job.settle-notification',
});
const readWake = defineScopedRoutine({
  ...base,
  name: 'read_symmy_job_notification_wake',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ wake_at_ms: Schema.Int.check(Schema.isGreaterThan(0)) }),
  routineKey: 'symmy-job.read-notification-wake',
});

const readWakeAt = (transaction: ScopedRoutineInvoker, jobId: string) =>
  transaction.invoke(readWake, [jobId]).pipe(
    Effect.map(([row]) => row?.wake_at_ms),
    Effect.mapError(unavailable),
  );

export interface SymmyJobNotificationStoreService {
  readonly claim: (
    input: SymmyJobNotificationClaimInput,
  ) => Effect.Effect<SymmyJobNotificationClaim, SymmyJobLifecycleStoreError>;
  readonly settle: (
    input: SymmyJobNotificationSettlement,
  ) => Effect.Effect<{ readonly applied: boolean; readonly wakeAtMs?: number }, SymmyJobLifecycleStoreError>;
}
export class SymmyJobNotificationStore extends Context.Service<
  SymmyJobNotificationStore,
  SymmyJobNotificationStoreService
>()('@app/symmy-integration/services/symmy-job-notification-store/SymmyJobNotificationStore') {}
export const symmyJobNotificationStore = (transaction: ScopedRoutineInvoker): SymmyJobNotificationStoreService =>
  SymmyJobNotificationStore.of({
    claim: Effect.fn('SymmyJobNotificationStore.claim')(function* claimNotification(
      input: SymmyJobNotificationClaimInput,
    ) {
      const [row] = yield* transaction
        .invoke(claim, [
          input.jobId,
          input.claimToken,
          {
            ...input.policy,
            destinationDigest: input.destinationDigest,
            payloadDigest: input.payloadDigest,
          },
        ])
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* unavailable();
      }
      const claimed = yield* Schema.decodeUnknownEffect(SymmyJobNotificationClaimSchema)(row).pipe(
        Effect.mapError(unavailable),
      );
      if (claimed.mode !== 'BUSY' && claimed.mode !== 'NOT_DUE') {
        return claimed;
      }
      const wakeAtMs = yield* readWakeAt(transaction, input.jobId);
      return wakeAtMs === undefined ? claimed : { ...claimed, wakeAtMs };
    }),
    settle: Effect.fn('SymmyJobNotificationStore.settle')(function* settleNotification(
      input: SymmyJobNotificationSettlement,
    ) {
      const [row] = yield* transaction
        .invoke(settle, [input.jobId, input.claimToken, input.version, input.delivered, input.retryable])
        .pipe(Effect.mapError(unavailable));
      const applied = row?.applied ?? false;
      if (!applied || input.delivered || !input.retryable) {
        return { applied };
      }
      const wakeAtMs = yield* readWakeAt(transaction, input.jobId);
      return wakeAtMs === undefined ? { applied } : { applied, wakeAtMs };
    }),
  });

export const SymmyJobNotificationStoreLive = Layer.effect(
  SymmyJobNotificationStore,
  Effect.gen(function* makeClaimedNotificationStore() {
    const tenantScope = yield* OutboxWorkerTenantScope;
    const scoped = Effect.fn('SymmyJobNotificationStore.claimedScope')(function* scoped<A, E>(
      context: OutboxWorkerHandlerContext | undefined,
      operation: (invoker: ScopedRoutineInvoker) => Effect.Effect<A, E>,
    ) {
      if (
        context === undefined ||
        !isVerifiedOutboxWorkerHandlerContext(context) ||
        context.consumerModuleKey !== ownerModuleKey ||
        context.producerModuleKey !== ownerModuleKey ||
        context.topic !== 'integration.symmy.job-admitted.v1' ||
        context.workerKey !== 'integration.symmy.execute-symmy-job' ||
        context.actorPrincipalId === undefined
      ) {
        return yield* unavailable();
      }
      const result = yield* Ref.make(Option.none<A>());
      yield* tenantScope
        .run(context, (scope) =>
          operation(scope.routineInvoker).pipe(Effect.flatMap((value) => Ref.set(result, Option.some(value)))),
        )
        .pipe(Effect.mapError(unavailable));
      const saved = yield* Ref.get(result);
      if (Option.isNone(saved)) {
        return yield* unavailable();
      }
      return saved.value;
    });
    return SymmyJobNotificationStore.of({
      claim: (input) => scoped(input.context, (invoker) => symmyJobNotificationStore(invoker).claim(input)),
      settle: (input) => scoped(input.context, (invoker) => symmyJobNotificationStore(invoker).settle(input)),
    });
  }),
);
