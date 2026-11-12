import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { and, asc, eq } from 'drizzle-orm';
import { Crypto, Effect } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { actionInvocations, coreRelations, dataAccessEvents } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import { startPaymentCollectionAction } from '../../src/actions/start-payment-collection.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeLifecycleOwnerContractFixture } from '../support/lifecycle-owner-contract.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { failureCodeOf, makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase, EvidenceScenario } from './evidence-native-support.ts';

/**
 * ACTIONS.md "Record a Data Access Event whenever Action processing reads business data whose result
 * contributes to a successful response or write" on native PostgreSQL: registered Payment Actions run
 * through the real Core Action runtime, and the Core `data_access_events` table must hold the bounded
 * read evidence (resource kind and ids, counts, no payload) of every successful invocation, including an
 * operation replay, and nothing for a failed one.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* dataAccessNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('PaymentDataAccess.makeRuntimes')(function* makeRuntimes(
  database: EvidenceNativeDatabase,
  compositionRevision: string,
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

const scenario = Effect.fn('PaymentDataAccess.scenario')(function* scenario() {
  // Gateway dispatches admitted under R1 are completion-bound executor work of R1 (#1158).
  yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

/** The binding the scenario's Payments execute under; C17 Currently enables it. */
const ENABLED_GATEWAY: PaymentGatewayAccountBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'gopay-account-1',
  providerFamily: 'GOPAY',
};

const GOPAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

/** Runs the registered `start-payment-collection` Action through the Core runtime. */
const collect = Effect.fn('PaymentDataAccess.collect')(function* collect(
  evidence: EvidenceScenario,
  payload: { readonly amountMinor: number; readonly operationKey: string; readonly paymentId: string },
) {
  const owners = yield* makeLifecycleOwnerContractFixture({
    enabledBindings: [ENABLED_GATEWAY],
    gatewayAvailable: true,
    metadataRevision: 1,
    termUse: 'USABLE',
  });
  return yield* evidence.r1.actions
    .runAction({
      payload: {
        amount: { amountMinor: payload.amountMinor, currency: 'CZK' },
        method: 'ONLINE_GATEWAY',
        operationKey: payload.operationKey,
        paymentId: payload.paymentId,
      },
      principal: principalOf(evidence.scope),
      registration: startPaymentCollectionAction,
      transport: { correlationId: 'payment-data-access-collect', idempotencyKey: randomUUID() },
    })
    .pipe(Effect.provide(owners.layer));
});

/** Every Data Access Event Core persisted in the scenario's fresh Tenant, with its invoking Action. */
const accessEventsOf = (evidence: EvidenceScenario) =>
  evidence.native.coreAdmin
    .select({
      accessKind: dataAccessEvents.accessKind,
      actionInvocationId: dataAccessEvents.actionInvocationId,
      actionKey: actionInvocations.actionKey,
      evidenceCaptureMode: dataAccessEvents.evidenceCaptureMode,
      evidencePayloadJson: dataAccessEvents.evidencePayloadJson,
      evidencePolicyKey: dataAccessEvents.evidencePolicyKey,
      outcome: dataAccessEvents.outcome,
      queryHash: dataAccessEvents.queryHash,
      resultCount: dataAccessEvents.resultCount,
      servingModuleKey: dataAccessEvents.servingModuleKey,
      targetModuleKey: dataAccessEvents.targetModuleKey,
      targetResourceId: dataAccessEvents.targetResourceId,
      targetResourceType: dataAccessEvents.targetResourceType,
    })
    .from(dataAccessEvents)
    .innerJoin(
      actionInvocations,
      and(
        eq(actionInvocations.tenantId, dataAccessEvents.tenantId),
        eq(actionInvocations.actionInvocationId, dataAccessEvents.actionInvocationId),
      ),
    )
    .where(eq(dataAccessEvents.tenantId, evidence.scope.tenantId))
    .orderBy(asc(dataAccessEvents.occurredAt), asc(dataAccessEvents.queryHash));

type AccessEvent = Effect.Success<ReturnType<typeof accessEventsOf>>[number];

const COLLECT_ACTION = 'payment.core.start-payment-collection';

/** Read of one Payment aggregate, as metadata-only evidence of the Action's descriptor policy. */
const paymentAggregateRead = (paymentId: string, policyKey: string) => ({
  accessKind: 'read',
  evidenceCaptureMode: 'metadata_only',
  evidencePayloadJson: null,
  evidencePolicyKey: policyKey,
  outcome: 'allowed',
  queryHash: `payment.core.payment-aggregate:${paymentId}`,
  resultCount: 1,
  servingModuleKey: 'payment.core',
  targetModuleKey: 'payment.core',
  targetResourceId: paymentId,
  targetResourceType: 'payment.core.payment',
});

const eventsOfInvocation = (events: readonly AccessEvent[], actionInvocationId: string | null | undefined) =>
  events.filter((event) => event.actionInvocationId === actionInvocationId);

it.live('ACTIONS.md: a successful COLLECT start persists Data Access Events for its Payment invariant reads', () =>
  native(
    Effect.gen(function* successfulCollectEvidence() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();

      const started = yield* collect(evidence, {
        amountMinor: 100_000,
        operationKey: 'collect-data-access',
        paymentId: payment.paymentId,
      });
      expect(started.replayed).toBe(false);

      const events = yield* accessEventsOf(evidence);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.actionKey === COLLECT_ACTION && event.outcome === 'allowed')).toBe(true);
      expect(events).toContainEqual({
        ...paymentAggregateRead(payment.paymentId, 'payment.core.start-payment-collection.access.v1'),
        actionInvocationId: events[0]?.actionInvocationId,
        actionKey: COLLECT_ACTION,
      });
      // The competing-intent lookup of the purchase is evidenced by its bounded count, never its key.
      expect(events).toContainEqual(
        expect.objectContaining({
          accessKind: 'list',
          queryHash: 'payment.core.purchase-intents',
          resultCount: 1,
          targetResourceId: null,
        }),
      );
      // Bounded metadata only: no evidence payload and no purchase or intent key in any query hash.
      expect(events.every((event) => event.evidencePayloadJson === null)).toBe(true);
      expect(events.some((event) => event.queryHash?.includes(payment.purchaseCorrelationId) === true)).toBe(false);
    }),
  ),
);

it.live('ACTIONS.md: a COLLECT replay under a new invocation persists its own Data Access Events', () =>
  native(
    Effect.gen(function* replayedCollectEvidence() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const request = { amountMinor: 100_000, operationKey: 'collect-replayed', paymentId: payment.paymentId };

      const first = yield* collect(evidence, request);
      const replay = yield* collect(evidence, request);
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.operation.operationId).toBe(first.operation.operationId);

      const events = yield* accessEventsOf(evidence);
      const invocations = [...new Set(events.map((event) => event.actionInvocationId))];
      expect(invocations).toHaveLength(2);
      // The replaying invocation read the Payment aggregate to recover the same logical operation.
      const replayEvents = eventsOfInvocation(events, invocations[1]);
      expect(replayEvents).toContainEqual({
        ...paymentAggregateRead(payment.paymentId, 'payment.core.start-payment-collection.access.v1'),
        actionInvocationId: invocations[1],
        actionKey: COLLECT_ACTION,
      });
    }),
  ),
);

it.live('ACTIONS.md: a failed COLLECT start persists no Data Access Event', () =>
  native(
    Effect.gen(function* failedCollectEvidence() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();

      // The request does not restate the immutable Payment amount: the handler read the Payment, then failed.
      const code = yield* failureCodeOf(
        collect(evidence, { amountMinor: 99_999, operationKey: 'collect-refused', paymentId: payment.paymentId }),
      );
      expect(code).toBe('payment_collection_meaning_conflict');

      expect(yield* accessEventsOf(evidence)).toStrictEqual([]);
    }),
  ),
);

it.live('ACTIONS.md: an accepted source statement persists Data Access Events for the reads it was decided on', () =>
  native(
    Effect.gen(function* acceptedObservationEvidence() {
      const evidence = yield* scenario();
      const configured = yield* evidence.configureSource({
        factFamily: 'GATEWAY_OUTCOME',
        reason: 'GoPay callbacks are the gateway outcome authority',
        refundRoute: false,
        source: GOPAY_SOURCE,
        status: 'ACTIVE',
        submitterPrincipalIds: [evidence.scope.principalId],
      });
      const payment = yield* evidence.createPayment();
      const operation = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-observed',
        paymentId: payment.paymentId,
      });

      const accepted = yield* evidence.accept({
        amount: { amountMinor: 100_000, currency: 'CZK' },
        economicEffectKey: 'gopay:payment:observed',
        factFamily: 'GATEWAY_OUTCOME',
        factKind: 'COLLECTION_CONFIRMED',
        operationId: operation.operationId,
        paymentId: payment.paymentId,
        source: GOPAY_SOURCE,
        sourceOccurrenceId: `gopay-callback-${randomUUID()}`,
        sourceRevision: 0,
      });
      expect(accepted).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION', paymentId: payment.paymentId });

      const events = yield* accessEventsOf(evidence);
      const configureEvents = events.filter(
        (event) => event.actionKey === 'payment.core.configure-payment-source-authority',
      );
      expect(configureEvents).toContainEqual(
        expect.objectContaining({
          accessKind: 'read',
          queryHash: `payment.core.source-authority:${configured.sourceAuthorityId}`,
          resultCount: 0,
        }),
      );
      const acceptEvents = events.filter((event) => event.actionKey === 'payment.core.accept-payment-observation');
      expect(acceptEvents).toContainEqual({
        ...paymentAggregateRead(payment.paymentId, 'payment.core.accept-payment-observation.access.v1'),
        actionInvocationId: acceptEvents[0]?.actionInvocationId,
        actionKey: 'payment.core.accept-payment-observation',
      });
      // The configured authorities of the statement's source and fact family, evidenced by count only.
      expect(acceptEvents).toContainEqual(
        expect.objectContaining({
          accessKind: 'list',
          queryHash: 'payment.core.source-authorities',
          resultCount: 1,
          targetResourceId: null,
        }),
      );
      // The occurrence was new: the duplicate lookup found nothing.
      expect(acceptEvents).toContainEqual(
        expect.objectContaining({ queryHash: 'payment.core.source-occurrence', resultCount: 0 }),
      );
    }),
  ),
);

/** A GoPay gateway outcome naming a Payment that does not exist in the invoking scope. */
const unresolvedStatement = (missingPaymentId: string) =>
  ({
    amount: { amountMinor: 100_000, currency: 'CZK' },
    economicEffectKey: `gopay:payment:${missingPaymentId}`,
    factFamily: 'GATEWAY_OUTCOME',
    factKind: 'COLLECTION_CONFIRMED',
    paymentId: missingPaymentId,
    source: GOPAY_SOURCE,
    sourceOccurrenceId: `gopay-callback-${randomUUID()}`,
    sourceRevision: 0,
  }) as const;

it.live('ACTIONS.md: a statement held for a missing Payment persists its zero-result Payment lookup', () =>
  native(
    Effect.gen(function* unresolvedTargetEvidence() {
      const evidence = yield* scenario();
      yield* evidence.configureSource({
        factFamily: 'GATEWAY_OUTCOME',
        reason: 'GoPay callbacks are the gateway outcome authority',
        refundRoute: false,
        source: GOPAY_SOURCE,
        status: 'ACTIVE',
        submitterPrincipalIds: [evidence.scope.principalId],
      });
      const missingPaymentId = randomUUID();

      const held = yield* evidence.accept(unresolvedStatement(missingPaymentId));
      expect(held.acceptanceOutcome).toBe('HELD_UNRESOLVED');

      const events = yield* accessEventsOf(evidence);
      const acceptEvents = events.filter((event) => event.actionKey === 'payment.core.accept-payment-observation');
      // The Action decided on the Payment lookup that found nothing; no Payment resource was read.
      expect(acceptEvents).toContainEqual({
        accessKind: 'read',
        actionInvocationId: acceptEvents[0]?.actionInvocationId,
        actionKey: 'payment.core.accept-payment-observation',
        evidenceCaptureMode: 'metadata_only',
        evidencePayloadJson: null,
        evidencePolicyKey: 'payment.core.accept-payment-observation.access.v1',
        outcome: 'allowed',
        queryHash: `payment.core.payment-aggregate:${missingPaymentId}`,
        resultCount: 0,
        servingModuleKey: 'payment.core',
        targetModuleKey: null,
        targetResourceId: null,
        targetResourceType: null,
      });
    }),
  ),
);

it.live('ACTIONS.md: a refused statement for a missing Payment persists no Data Access Event', () =>
  native(
    Effect.gen(function* refusedUnresolvedTargetEvidence() {
      const evidence = yield* scenario();

      // No authority is configured for the source: the Action looked the Payment up, then failed.
      const code = yield* failureCodeOf(evidence.accept(unresolvedStatement(randomUUID())));
      expect(code).toBe('payment_source_authority_forbidden');

      expect(yield* accessEventsOf(evidence)).toStrictEqual([]);
    }),
  ),
);
