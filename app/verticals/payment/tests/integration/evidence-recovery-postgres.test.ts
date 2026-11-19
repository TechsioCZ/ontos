import { randomUUID } from 'node:crypto';

import { GatewayAssertionRedemptionService } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { Clock, Crypto, DateTime, Effect, Exit, Fiber, Layer, Option, Predicate, Ref, Schema } from 'effect';
import type { Scope } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionDurableWork,
  coreRelations,
  outboxMessages,
  tenantModuleStates,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { lockApplicationCompositionAuthority } from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  defineOutboxWorker,
  extractOutboxWorkerSubscriptions,
} from '../../../../packages/core-runtime/src/outbox/definition.ts';
import type { OutboxWorkerHandler } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import { makeOutboxRepository } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../../../packages/core-runtime/src/outbox/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { makeNativeOutboxWorkerFixture } from '../../../../packages/core-runtime/tests/support/outbox-worker-native-fixture.ts';
import { getVerticalRuntimeOutboxWorkers } from '../../../../packages/core-runtime/src/modules/runtime-registration.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { PaymentProviderReplayGuaranteeSchema } from '../../shared/domain/evidence-contract.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { OutboxPayloadSchema as RecoveryRequestedSchema } from '../../shared/outbox/payment-core-operation-recovery-requested-v1.ts';
import type { OutboxPayload as RecoveryRequested } from '../../shared/outbox/payment-core-operation-recovery-requested-v1.ts';
import { OutboxPayloadSchema as OutcomeChangedSchema } from '../../shared/outbox/payment-core-operation-outcome-changed-v1.ts';
import { startPaymentCollectionAction } from '../../src/actions/start-payment-collection.action.ts';
import { executeGatewayOperationWorker } from '../../src/workers/execute-gateway-operation.worker.ts';
import { recoverGatewayOperationWorker } from '../../src/workers/recover-gateway-operation.worker.ts';
import { currentPaymentRead } from '../../src/api/current-payment.read.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { paymentRecoveryModeAtDispatch } from '../../src/domain/evidence-recovery.ts';
import type { PaymentRecoveryOperationView } from '../../src/domain/evidence-recovery.ts';
import type { PaymentOwnerScope } from '../../src/ports/owner-evidence-unavailable.ts';
import { PaymentProviderReplayEvidencePort } from '../../src/ports/provider-replay-evidence-port.ts';
import { makeLifecycleOwnerContractFixture } from '../support/lifecycle-owner-contract.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { failureCodeOf, makeTestScope } from './database-fixture.ts';
import {
  BANK_BINDING,
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  GATEWAY_BINDING,
  principalOf,
  RECOVERY_REQUESTED,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase, EvidenceScenario } from './evidence-native-support.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const native = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(nativeServices));

const nativeDatabase = Effect.gen(function* evidenceNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

/** The real Core Action and Read runtimes as they run under one approved Composition revision. */
const makeEvidenceRuntimes = Effect.fn('EvidenceNative.makeRuntimes')(function* makeEvidenceRuntimes(
  database: EvidenceNativeDatabase,
  compositionRevision: string,
  lockCompositionAuthority: typeof lockApplicationCompositionAuthority = openActionRuntimeOptions.lockCompositionAuthority,
) {
  const crypto = yield* Crypto.Crypto;
  const accessDecision = makeScriptedBoundAccessGate('allowed').bound;
  const actions = makeActionRuntime(
    { executor: database.database },
    makeActionRepository(crypto),
    evidenceAllowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision,
      contextAccess: evidenceContextAccess,
      lockCompositionAuthority,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(compositionRevision),
    },
  );
  const reads = makeReadRuntime(
    { executor: database.database },
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    evidenceContextAccess,
    {
      accessDecision,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

/** The revisions under which Core tracks the operation's unknown effect as payment.core durable work. */
const unknownEffectWork = (evidence: EvidenceScenario, operationId: string) =>
  evidence.native.coreAdmin
    .select({ originalRevision: applicationCompositionDurableWork.originalRevision })
    .from(applicationCompositionDurableWork)
    .where(
      and(
        eq(applicationCompositionDurableWork.ownerModuleKey, 'payment.core'),
        eq(applicationCompositionDurableWork.workId, `payment-operation:${evidence.scope.tenantId}:${operationId}`),
      ),
    )
    .pipe(Effect.map((rows) => rows.map((row) => row.originalRevision)));

/** Completion declarations of this Tenant's Payment Outbox rows of one topic, oldest first. */
const completionOf = (evidence: EvidenceScenario, topic: string) =>
  evidence.native.coreAdmin
    .select({
      consumer: outboxMessages.completionConsumerModuleKey,
      revision: outboxMessages.completionOriginalRevision,
    })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.tenantId, evidence.scope.tenantId),
        eq(outboxMessages.producerModuleKey, 'payment.core'),
        eq(outboxMessages.topic, topic),
      ),
    )
    .orderBy(outboxMessages.createdAt);

/** Core durable work admitted for one Outbox row and its completion consumer. */
const outboxWork = (evidence: EvidenceScenario, topic: string) =>
  evidence.native.coreAdmin
    .select({ originalRevision: applicationCompositionDurableWork.originalRevision })
    .from(applicationCompositionDurableWork)
    .innerJoin(
      outboxMessages,
      eq(
        applicationCompositionDurableWork.workId,
        sql`'outbox:' || ${outboxMessages.outboxMessageId}::text || ':payment.core'`,
      ),
    )
    .where(
      and(
        eq(applicationCompositionDurableWork.ownerModuleKey, 'payment.core'),
        eq(outboxMessages.tenantId, evidence.scope.tenantId),
        eq(outboxMessages.topic, topic),
      ),
    )
    .pipe(Effect.map((rows) => rows.map((row) => row.originalRevision)));

const scenario = Effect.fn('EvidenceRecoveryTest.scenario')(function* scenario() {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeEvidenceRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeEvidenceRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

/** Committed Outbox rows decoded through the published topic contract. */
const recoveryMessages = (evidence: ReturnType<typeof evidenceScenarioOf>) =>
  evidence
    .outbox(RECOVERY_REQUESTED)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RecoveryRequestedSchema))));

const historicalWindow = {
  providerIdempotency: {
    environment: 'production',
    providerAccountRef: 'stripe-account-1',
    providerFamily: 'STRIPE',
    providerIdempotencyKey: 'historical-local-key',
    windowSeconds: 3600,
  },
};

const stripeBinding: PaymentGatewayAccountBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'stripe-account-1',
  providerFamily: 'STRIPE',
};
const providerGuarantee = (
  target: Pick<PaymentRecoveryOperationView, 'binding' | 'kind' | 'materialHash' | 'operationId' | 'paymentId'>,
  scope: PaymentOwnerScope,
  startsAtEpochMs: number,
) =>
  Schema.decodeUnknownSync(PaymentProviderReplayGuaranteeSchema)({
    ...scope,
    binding: target.binding,
    endpointRef: 'stripe.payment-intents.create',
    expiresAtEpochMs: startsAtEpochMs + 3_600_000,
    materialHash: target.materialHash,
    operationId: target.operationId,
    operationKind: target.kind,
    paymentId: target.paymentId,
    providerIdempotencyKeyHash: 'b'.repeat(64),
    providerRequestHash: 'c'.repeat(64),
    startsAtEpochMs,
  });

/** Fast test leases and retries; runtime-only changes that keep the published subscription bytes. */
const fixtureRuntime = {
  leaseDurationMs: 1000,
  retryPolicy: { initialBackoffMs: 0, maxAttempts: 3, maxBackoffMs: 0, multiplier: 1 },
} as const;

/** The C17 provider contract fixture bound to Payment's real registered recovery worker subscription. */
const recoveryWorker = <Failure>(handler: OutboxWorkerHandler<RecoveryRequested, Failure>) =>
  defineOutboxWorker({ ...recoverGatewayOperationWorker.descriptor, ...fixtureRuntime }, handler);

/** The C17 executor contract fixture: the original dispatch reached its safe checkpoint (#1158). */
const executorCheckpoint = defineOutboxWorker(
  { ...executeGatewayOperationWorker.descriptor, ...fixtureRuntime },
  () => Effect.void,
);

const recoveryDelivery = Effect.fn('EvidenceRecoveryTest.delivery')(function* recoveryDelivery() {
  const template = recoveryWorker(() => Effect.void);
  // The composition publishes Payment's real registered subscriptions (executor, notification, recovery).
  const fixture = makeNativeOutboxWorkerFixture(getVerticalRuntimeOutboxWorkers(paymentRegistration));
  const snapshot = yield* fixture.authority.load;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1229-payment-entitlement',
    sourceConnections: yield* loadDatabaseConnectionPair(),
  });
  const admin = yield* makeTestPgClient(isolated.connections.admin.connectionString);
  const runtime = yield* makeTestPgClient(isolated.connections.runtime.connectionString);
  const database = {
    coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
    database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    runtimeClient: runtime,
  } satisfies EvidenceNativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  yield* database.coreAdmin.insert(tenantModuleStates).values({
    moduleKey: 'payment.core',
    state: 'active',
    tenantId: scope.tenantId,
  });
  const { revision } = snapshot.composition;
  const r1 = yield* makeEvidenceRuntimes(database, revision, lockApplicationCompositionAuthority);
  const evidence = evidenceScenarioOf({ native: database, r1, r2: r1, scope });
  const crypto = yield* Crypto.Crypto;
  const repository = makeOutboxRepository(database.database, crypto);
  return { database, evidence, fixture, isolated, r1, repository, revision, template };
});

const admitOriginalStripeCollection = Effect.fn('EvidenceRecoveryTest.admitOriginalStripeCollection')(
  function* admitOriginalStripeCollection(delivery: Effect.Success<ReturnType<typeof recoveryDelivery>>) {
    const { evidence, r1 } = delivery;
    const payment = yield* evidence.createPayment(100_000, stripeBinding);
    const owners = yield* makeLifecycleOwnerContractFixture({
      enabledBindings: [stripeBinding],
      gatewayAvailable: true,
      metadataRevision: 1,
      termUse: 'USABLE',
    });
    const result = yield* r1.actions
      .runAction({
        payload: {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          method: 'ONLINE_GATEWAY',
          operationKey: 'collect-recovery-original',
          paymentId: payment.paymentId,
        },
        principal: principalOf(evidence.scope),
        registration: startPaymentCollectionAction,
        transport: { correlationId: 'payment-recovery-original', idempotencyKey: randomUUID() },
      })
      .pipe(Effect.provide(owners.layer));
    return { ...result.operation, paymentId: payment.paymentId };
  },
);

it.live(
  '#1151 Lost create response does not authorize another charge: INDETERMINATE, same binding, no competitor',
  () =>
    native(
      Effect.gen(function* lostCreateResponse() {
        yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
        const evidence = yield* scenario();
        const payment = yield* evidence.createPayment();
        const collect = yield* evidence.startOperation({
          amountMinor: 100_000,
          operationKey: 'collect-a',
          paymentId: payment.paymentId,
        });
        const idempotencyKey = randomUUID();
        const recovered = yield* evidence.recover(
          {
            operationId: collect.operationId,
            paymentId: payment.paymentId,
            reason: 'The provider create response was lost in transport',
            trigger: 'EXECUTION_OUTCOME_UNKNOWN',
          },
          { idempotencyKey },
        );
        expect(recovered).toMatchObject({
          executorWorkAdmitted: true,
          heldForReconciliation: false,
          operationId: collect.operationId,
          operationOutcome: 'INDETERMINATE',
          previousOutcome: 'PENDING',
          providerReplay: 'NOT_PROVEN',
          recoveryMode: 'AUTHORITATIVE_LOOKUP',
        });

        // The original operation, binding and lineage are retained; recovery is a new governed invocation.
        const [operation] = yield* evidence.rows.operations(payment.paymentId);
        expect(operation).toMatchObject({ binding: GATEWAY_BINDING, outcome: 'INDETERMINATE', outcomeRevision: 2 });
        const transitions = yield* evidence.rows.transitions(collect.operationId);
        expect(transitions.map((row) => [row.fromOutcome, row.toOutcome, row.causeKind, row.causeId])).toEqual([
          [null, 'PENDING', 'CREATION', null],
          ['PENDING', 'INDETERMINATE', 'RECOVERY', recovered.recoveryId],
        ]);
        const recoveries = yield* evidence.rows.recoveries(payment.paymentId);
        expect(recoveries).toHaveLength(1);
        expect(recoveries[0]).toMatchObject({ bindingSnapshot: GATEWAY_BINDING, mode: 'AUTHORITATIVE_LOOKUP' });

        // No competing collection identity, gateway or account can be opened while the effect is unknown.
        expect(
          yield* failureCodeOf(
            evidence.startOperation({ amountMinor: 100_000, operationKey: 'collect-b', paymentId: payment.paymentId }),
          ),
        ).toBe('payment_collect_lineage_conflict');
        expect(yield* evidence.rows.operations(payment.paymentId)).toHaveLength(1);

        // The executor task names only the original operation and binding.
        const [message] = yield* recoveryMessages(evidence);
        expect(message).toMatchObject({
          binding: GATEWAY_BINDING,
          mode: 'AUTHORITATIVE_LOOKUP',
          operationId: collect.operationId,
          operationKey: 'collect-a',
          originalCompositionRevision: COMPOSITION_R1,
        });

        // The committed Core invocation is not executed again: no second recovery request exists.
        const replayed = yield* failureCodeOf(
          evidence.recover(
            {
              operationId: collect.operationId,
              paymentId: payment.paymentId,
              reason: 'The provider create response was lost in transport',
              trigger: 'EXECUTION_OUTCOME_UNKNOWN',
            },
            { idempotencyKey },
          ),
        );
        expect(replayed).toBe('action_already_committed');
        expect(yield* evidence.rows.recoveries(payment.paymentId)).toHaveLength(1);
      }),
    ),
);

it.live('#1158 Lookup recovery delivery is tracked: Core durable work of the recovering revision until done', () =>
  native(
    Effect.gen(function* lookupRecoveryTracked() {
      // The operation was admitted under R1; a later compatible runtime R2 asks for the lookup, so the
      // delivery is Core durable work of that recovering invocation, never relabelled R1 work.
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R2);
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-lookup-tracked',
        paymentId: payment.paymentId,
      });
      const recovered = yield* evidence.recover(
        {
          operationId: collect.operationId,
          paymentId: payment.paymentId,
          reason: 'The provider create response was lost in transport',
          trigger: 'EXECUTION_OUTCOME_UNKNOWN',
        },
        { runtimes: evidence.r2 },
      );
      expect(recovered).toMatchObject({
        executorWorkAdmitted: true,
        executorWorkTracked: true,
        originalCompositionRevision: COMPOSITION_R1,
        recoveryMode: 'AUTHORITATIVE_LOOKUP',
      });
      expect(yield* completionOf(evidence, RECOVERY_REQUESTED)).toEqual([
        { consumer: 'payment.core', revision: COMPOSITION_R2 },
      ]);
      expect(yield* outboxWork(evidence, RECOVERY_REQUESTED)).toEqual([COMPOSITION_R2]);
    }),
  ),
);

it.live('#1151 Provider idempotency window has expired: recovery falls back to lookup, never a replay', () =>
  native(
    Effect.gen(function* expiredProviderWindow() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment(100_000, stripeBinding);
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        binding: stripeBinding,
        materialExtras: historicalWindow,
        operationKey: 'collect-window-expired',
        paymentId: payment.paymentId,
      });
      // The handler reads the ACTUAL time after the Payment row lock (never a frozen business T): the
      // test clock puts that boundary two hours after admission, beyond the one-hour provider window.
      const admittedAt = yield* Clock.currentTimeMillis;
      const request = {
        operationId: collect.operationId,
        paymentId: payment.paymentId,
        reason: 'Retry the uncertain charge with the same local identity',
        requestedMode: 'PROVIDER_IDEMPOTENT_REPLAY',
        trigger: 'OPERATOR_REQUEST',
      } as const;
      // Lookup is concrete executor work: it is completion-bound like a replay (#1158).
      expect(yield* evidence.recover(request)).toMatchObject({
        executorWorkTracked: true,
        providerReplay: 'NOT_PROVEN',
        recoveryMode: 'AUTHORITATIVE_LOOKUP',
      });
      const proof = providerGuarantee(collect, evidence.scope, admittedAt);
      const recovered = yield* Effect.gen(function* recoverAfterWindow() {
        yield* TestClock.setTime(admittedAt + 7_200_000);
        return yield* evidence.recover(request).pipe(
          Effect.provideService(PaymentProviderReplayEvidencePort, () => ({
            readGuarantee: () => Effect.succeedSome(proof),
          })),
        );
      }).pipe(Effect.provide(TestClock.layer()));
      expect(recovered).toMatchObject({
        modeDowngraded: true,
        providerReplay: 'EXPIRED',
        recoveryMode: 'AUTHORITATIVE_LOOKUP',
      });
      const messages = yield* recoveryMessages(evidence);
      expect(messages).toHaveLength(2);
      expect(
        messages.every(
          ({ mode, operationId }) => mode === 'AUTHORITATIVE_LOOKUP' && operationId === collect.operationId,
        ),
      ).toBe(true);
    }),
  ),
);

it.live(
  '#1151/#1153 Native replay keeps the original operation and drains only after matched recovery completes',
  () =>
    native(
      Effect.gen(function* replayWithFreshAssertion() {
        const delivery = yield* recoveryDelivery();
        const { database, evidence, fixture, isolated, r1, repository, revision, template } = delivery;
        const collect = yield* admitOriginalStripeCollection(delivery);
        const scope = { legalEntityId: evidence.scope.legalEntityId, tenantId: evidence.scope.tenantId };
        const proof = providerGuarantee(collect, scope, yield* Clock.currentTimeMillis);
        const source = {
          accountRef: stripeBinding.providerAccountRef,
          environment: stripeBinding.environment,
          sourceKind: 'PAYMENT_GATEWAY',
          sourceSystem: stripeBinding.providerFamily,
        } as const;
        yield* evidence.configureSource({
          factFamily: 'GATEWAY_OUTCOME',
          method: 'ONLINE_GATEWAY',
          reason: 'C17 Stripe contract fixture for exact original replay',
          refundRoute: false,
          source,
          status: 'ACTIVE',
          submitterPrincipalIds: [evidence.scope.principalId],
        });
        const redemption = yield* GatewayAssertionRedemptionService.pipe(
          Effect.provide(
            GatewayAssertionRedemptionLive.pipe(
              Layer.provide(GatewayAssertionRedemptionDatabaseLive),
              Layer.provide(Layer.succeed(PgClient.PgClient, evidence.native.runtimeClient)),
            ),
          ),
        );
        const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const assertion = () => ({
          audience: 'payment',
          expiresAtEpochSeconds: nowSeconds + 300,
          issuer: 'https://gateway.ontos.test',
          jti: randomUUID(),
        });
        const replayOnce = (key: string) =>
          evidence
            .recover(
              {
                operationId: collect.operationId,
                paymentId: collect.paymentId,
                reason: 'Authorized retry of the same provider request',
                trigger: 'EXECUTION_OUTCOME_UNKNOWN',
              },
              { idempotencyKey: key },
            )
            .pipe(
              Effect.provideService(PaymentProviderReplayEvidencePort, () => ({
                readGuarantee: (target) => {
                  expect(target).toMatchObject({
                    binding: stripeBinding,
                    materialHash: collect.materialHash,
                    operationId: collect.operationId,
                    operationKind: 'COLLECT',
                    paymentId: collect.paymentId,
                    scope,
                  });
                  return Effect.succeedSome(proof);
                },
              })),
            );

        const first = assertion();
        yield* redemption.consume(first);
        const firstReplay = yield* replayOnce(randomUUID());
        const second = assertion();
        yield* redemption.consume(second);
        const secondReplay = yield* replayOnce(randomUUID());

        for (const replay of [firstReplay, secondReplay]) {
          expect(replay).toMatchObject({
            executorWorkAdmitted: true,
            executorWorkTracked: true,
            operationId: collect.operationId,
            originalCompositionRevision: revision,
            providerReplay: 'COVERS_NOW',
            recoveryMode: 'PROVIDER_IDEMPOTENT_REPLAY',
          });
        }
        // Replaying the consumed assertion fails on its own, independent of business replay.
        const reused = yield* Effect.flip(redemption.consume(first));
        expect(Predicate.isTagged(reused, 'GatewayAssertionReplayError')).toBe(true);
        // The original Payment Operation and exact provider request binding remain unchanged.
        expect(yield* evidence.rows.operations(collect.paymentId)).toHaveLength(1);
        const messages = yield* recoveryMessages(evidence);
        expect(messages.map((message) => message.binding)).toEqual([stripeBinding, stripeBinding]);
        expect(new Set(messages.map((message) => message.materialHash))).toEqual(new Set([collect.materialHash]));
        expect(messages.map((message) => message.providerReplayGuarantee)).toEqual([proof, proof]);

        const queued = yield* database.coreAdmin
          .select({
            completionConsumer: outboxMessages.completionConsumerModuleKey,
            completionRevision: outboxMessages.completionOriginalRevision,
            messageId: outboxMessages.outboxMessageId,
          })
          .from(outboxMessages)
          .where(eq(outboxMessages.topic, RECOVERY_REQUESTED));
        expect(queued).toHaveLength(2);
        expect(
          queued.every(
            ({ completionConsumer, completionRevision }) =>
              completionConsumer === 'payment.core' && completionRevision === revision,
          ),
        ).toBe(true);
        expect(yield* unknownEffectWork(evidence, collect.operationId)).toEqual([revision]);

        yield* isolated.composition.closeAdmission();
        expect(Exit.isFailure(yield* Effect.exit(isolated.composition.drain()))).toBe(true);
        // The original gateway dispatch and both replays are matched to Payment's registered workers.
        expect((yield* repository.matchUnmatched(revision, yield* DateTime.nowAsDate)).deliveriesCreated).toBe(3);
        const claimedAt = DateTime.add(yield* DateTime.now, { seconds: 1 });
        const abandoned = yield* Effect.fromOption(
          yield* fixture.bind(
            [template],
            repository.claimNext([template], 'original-recovery-worker', DateTime.toDateUtc(claimedAt), revision),
          ),
        );
        const modes = yield* Ref.make<readonly string[]>([]);
        const worker = recoveryWorker((message, context) =>
          Effect.gen(function* runProviderContractFixture() {
            expect(context.compositionRevision).toBe(revision);
            const current = yield* r1.reads.runRead({
              input: { paymentId: message.paymentId },
              principal: principalOf(evidence.scope),
              registration: currentPaymentRead,
              transport: { correlationId: 'payment-provider-recovery-dispatch' },
            });
            const operation = current.operations.find(({ operationId }) => operationId === message.operationId);
            if (operation === undefined) {
              return yield* paymentUnavailable('Current Payment Operation is unavailable to the C17 fixture');
            }
            const mode = paymentRecoveryModeAtDispatch(
              message,
              { ...operation, paymentId: message.paymentId },
              scope,
              yield* DateTime.now,
              proof,
            );
            yield* Ref.update(modes, (prior) => [...prior, mode]);
            if (mode === 'PROVIDER_IDEMPOTENT_REPLAY') {
              // The provider fixture reports the retained request's same effect through the registered Action.
              yield* evidence.accept({
                amount: { amountMinor: 100_000, currency: 'CZK' },
                economicEffectKey: 'stripe-recovery-original-effect',
                factFamily: 'GATEWAY_OUTCOME',
                factKind: 'COLLECTION_CONFIRMED',
                operationId: message.operationId,
                paymentId: message.paymentId,
                source,
                sourceOccurrenceId: 'stripe-recovery-verified-occurrence',
                sourceRevision: 1,
              });
            } else if (mode !== 'ALREADY_RESOLVED') {
              return yield* paymentUnavailable('The fixture did not prove a safe recovery checkpoint');
            }
            return yield* Effect.void;
          }),
        );
        const afterLease = DateTime.toDateUtc(DateTime.add(claimedAt, { seconds: 2 }));
        const restarted = makeOutboxRuntime(makeOutboxRepository(database.database, yield* Crypto.Crypto));
        const cycle = yield* fixture.bind(
          [worker],
          restarted.runCycle({
            claimOwner: 'restarted-recovery-worker',
            compositionRevision: revision,
            maxDeliveries: 2,
            now: afterLease,
            registrations: [worker],
            subscriptions: extractOutboxWorkerSubscriptions([worker]),
          }),
        );
        expect(cycle).toMatchObject({ claimed: 2, failed: 0, succeeded: 2 });
        expect(yield* Ref.get(modes)).toEqual(['PROVIDER_IDEMPOTENT_REPLAY', 'ALREADY_RESOLVED']);
        expect(Exit.isFailure(yield* Effect.exit(repository.complete(abandoned, afterLease)))).toBe(true);
        expect(yield* evidence.rows.operations(collect.paymentId)).toMatchObject([
          { compositionRevision: revision, operationId: collect.operationId, outcome: 'EFFECT_CONFIRMED' },
        ]);
        expect(yield* unknownEffectWork(evidence, collect.operationId)).toEqual([]);
        // The unfinished original dispatch still holds the release (#1153) until the executor completes it.
        expect(Exit.isFailure(yield* Effect.exit(isolated.composition.drain()))).toBe(true);
        const dispatched = yield* fixture.bind(
          [executorCheckpoint],
          restarted.runCycle({
            claimOwner: 'original-executor',
            compositionRevision: revision,
            maxDeliveries: 1,
            now: afterLease,
            registrations: [executorCheckpoint],
            subscriptions: extractOutboxWorkerSubscriptions([executorCheckpoint]),
          }),
        );
        expect(dispatched).toMatchObject({ claimed: 1, failed: 0, succeeded: 1 });
        yield* isolated.composition.drain();
      }),
    ),
  { timeout: 120_000 },
);

it.live('#1151 Late callback is admitted by a compatible new runtime and preserves the original lineage', () =>
  native(
    Effect.gen(function* lateCallbackUnderR2() {
      // The unknown effect arises under the compatible R2, so R2 is the release that tracks it.
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R2);
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-r1',
        paymentId: payment.paymentId,
      });
      expect(collect.provenance.compositionRevision).toBe(COMPOSITION_R1);
      // Business waiting on the R1 handoff is not Core durable work.
      expect(yield* unknownEffectWork(evidence, collect.operationId)).toEqual([]);
      // R2 records the recovery request of the R1 operation as its own invocation.
      const recovered = yield* evidence.recover(
        {
          operationId: collect.operationId,
          paymentId: payment.paymentId,
          reason: 'Late provider callback after the runtime change',
          trigger: 'EXECUTION_OUTCOME_UNKNOWN',
        },
        { runtimes: evidence.r2 },
      );
      expect(recovered.originalCompositionRevision).toBe(COMPOSITION_R1);
      // The unknown effect is tracked as Core durable work of the release that made it unknown.
      expect(yield* unknownEffectWork(evidence, collect.operationId)).toEqual([COMPOSITION_R2]);
      // The independently authorized, qualified observation arrives under R2 and resolves O.
      const authority = yield* evidence.configureAuthority();
      const callback = yield* evidence.recordObservation(
        {
          acceptanceOutcome: 'HELD_UNRESOLVED',
          amountMinor: 100_000,
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
          sourceAuthorityId: authority,
        },
        COMPOSITION_R2,
      );
      const caseId = yield* evidence.openCase('UNRESOLVED_OPERATION', payment.paymentId, collect.operationId);
      const decided = yield* evidence.decide(
        {
          caseId,
          decision: { _tag: 'ATTACH_EVIDENCE', observationId: callback },
          reason: 'Qualified late provider callback proves the original collection',
        },
        { runtimes: evidence.r2 },
      );
      expect(Option.isSome(decided.outcomeChange)).toBe(true);
      // The proven outcome releases the tracked work, so R2 can drain again.
      expect(yield* unknownEffectWork(evidence, collect.operationId)).toEqual([]);

      const [operation] = yield* evidence.rows.operations(payment.paymentId);
      expect(operation).toMatchObject({ compositionRevision: COMPOSITION_R1, outcome: 'EFFECT_CONFIRMED' });
      const transitions = yield* evidence.rows.transitions(collect.operationId);
      expect(transitions.map((row) => [row.toOutcome, row.causeKind, row.compositionRevision])).toEqual([
        ['PENDING', 'CREATION', COMPOSITION_R1],
        ['INDETERMINATE', 'RECOVERY', COMPOSITION_R2],
        ['EFFECT_CONFIRMED', 'RECONCILIATION', COMPOSITION_R2],
      ]);
      const [recovery] = yield* evidence.rows.recoveries(payment.paymentId);
      expect(recovery?.compositionRevision).toBe(COMPOSITION_R2);
      const [callbackRow] = yield* evidence.rows.observation(callback);
      expect(callbackRow).toMatchObject({ compositionRevision: COMPOSITION_R2, operationId: collect.operationId });
      const [changed] = yield* evidence
        .outbox('payment.core.operation-outcome-changed.v1')
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OutcomeChangedSchema))));
      expect(changed).toMatchObject({
        operationId: collect.operationId,
        originalCompositionRevision: COMPOSITION_R1,
        provenance: { compositionRevision: COMPOSITION_R2 },
        toOutcome: 'EFFECT_CONFIRMED',
      });
      // Neither R1 work is relabeled nor a replacement financial operation created.
      expect(yield* evidence.rows.operations(payment.paymentId)).toHaveLength(1);
    }),
  ),
);

it.live('#1151 Business waiting does not fabricate a perpetual execution lease or a pending task', () =>
  native(
    Effect.gen(function* businessWaiting() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment(100_000, BANK_BINDING, 'BANK_TRANSFER_ADVANCE');
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        binding: BANK_BINDING,
        operationKey: 'bank-receipt',
        paymentId: payment.paymentId,
      });
      const waited = yield* evidence.recover({
        operationId: collect.operationId,
        paymentId: payment.paymentId,
        reason: 'The bank receipt is overdue',
        trigger: 'OUTCOME_OVERDUE',
      });
      expect(waited).toMatchObject({
        executorWorkAdmitted: false,
        heldForReconciliation: false,
        operationOutcome: 'PENDING',
        providerReplay: 'NOT_APPLICABLE',
        recoveryMode: 'AWAIT_QUALIFIED_EVIDENCE',
      });
      // No executor task is fabricated for business waiting, and no Core durable work holds the release...
      expect(yield* recoveryMessages(evidence)).toHaveLength(0);
      expect(yield* unknownEffectWork(evidence, collect.operationId)).toEqual([]);
      // ...and the waiting state stays visible separately from debt.
      const debt = yield* evidence.debt({ paymentId: payment.paymentId });
      expect(debt.awaitingEvidence.map((operation) => operation.operationId)).toEqual([collect.operationId]);
      expect(debt.unresolvedOperations).toHaveLength(0);
      expect(debt.openCases).toHaveLength(0);
    }),
  ),
);

it.live('#1151 Closing admission retains unresolved accepted work: missing authority is held, never NOT_EFFECTED', () =>
  native(
    Effect.gen(function* missingAuthorityHeld() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-held',
        paymentId: payment.paymentId,
      });
      const request = (trigger: 'EXECUTION_OUTCOME_UNKNOWN' | 'LOOKUP_AUTHORITY_UNAVAILABLE') => ({
        operationId: collect.operationId,
        paymentId: payment.paymentId,
        reason: 'The executor has no lookup credentials for the original account',
        trigger,
      });
      yield* evidence.recover(request('EXECUTION_OUTCOME_UNKNOWN'));
      const held = yield* evidence.recover(request('LOOKUP_AUTHORITY_UNAVAILABLE'));
      expect(held).toMatchObject({
        executorWorkAdmitted: false,
        heldForReconciliation: true,
        operationOutcome: 'INDETERMINATE',
        recoveryMode: 'GOVERNED_RECONCILIATION',
      });
      yield* evidence.recover(request('LOOKUP_AUTHORITY_UNAVAILABLE'));
      const cases = yield* evidence.rows.cases(payment.paymentId);
      expect(cases.map((row) => [row.caseKind, row.status, row.operationId])).toEqual([
        ['UNRESOLVED_OPERATION', 'OPEN', collect.operationId],
      ]);
      const debt = yield* evidence.debt({ paymentId: payment.paymentId });
      expect(debt.unresolvedOperations.map((operation) => [operation.operationId, operation.outcome])).toEqual([
        [collect.operationId, 'INDETERMINATE'],
      ]);
      expect(debt.openCases).toHaveLength(1);
      // No fake DONE: the case cannot be closed while the effect is unknown.
      const caseId = cases[0]?.caseId ?? '';
      expect(
        yield* failureCodeOf(
          evidence.decide({
            caseId,
            decision: { _tag: 'CLOSE_CASE', evidenceRef: 'operator-note-1' },
            reason: 'Attempt to close the unresolved recovery',
          }),
        ),
      ).toBe('payment_reconciliation_obligation_unresolved');
      const [operation] = yield* evidence.rows.operations(payment.paymentId);
      expect(operation?.outcome).toBe('INDETERMINATE');
    }),
  ),
);

it.live('#1151 recovery refuses resolved operations and foreign scopes', () =>
  native(
    Effect.gen(function* refusedRecovery() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-done',
        paymentId: payment.paymentId,
      });
      yield* evidence.settle(payment.paymentId, collect.operationId, 1, 'EFFECT_CONFIRMED');
      const request = {
        operationId: collect.operationId,
        paymentId: payment.paymentId,
        reason: 'Nothing to recover',
        trigger: 'OPERATOR_REQUEST',
      } as const;
      expect(yield* failureCodeOf(evidence.recover(request))).toBe('payment_recovery_operation_already_resolved');
      const foreign = yield* scenario();
      expect(yield* failureCodeOf(foreign.recover(request))).toBe('payment_not_found');
      expect(yield* evidence.rows.recoveries(payment.paymentId)).toHaveLength(0);
    }),
  ),
);

it.live('#1151 concurrent recovery requests serialize on the Payment row lock and transition once', () =>
  native(
    Effect.gen(function* concurrentRecovery() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-race',
        paymentId: payment.paymentId,
      });
      const request = {
        operationId: collect.operationId,
        paymentId: payment.paymentId,
        reason: 'Two executors lost the same response',
        trigger: 'EXECUTION_OUTCOME_UNKNOWN',
      } as const;
      const fibers = yield* Effect.forEach([0, 1], () => Effect.forkChild(evidence.recover(request)));
      const results = yield* Fiber.joinAll(fibers);
      expect(results.map((result) => result.operationOutcome)).toEqual(['INDETERMINATE', 'INDETERMINATE']);
      expect(new Set(results.map((result) => result.previousOutcome))).toEqual(new Set(['PENDING', 'INDETERMINATE']));
      const transitions = yield* evidence.rows.transitions(collect.operationId);
      expect(transitions.map((row) => row.toOutcome)).toEqual(['PENDING', 'INDETERMINATE']);
      expect(yield* evidence.rows.recoveries(payment.paymentId)).toHaveLength(2);
    }),
  ),
);
