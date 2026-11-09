import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Predicate } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations, outboxMessages } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { recordPaymentLocalEvidenceAction } from '../../src/actions/record-payment-local-evidence.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { collectInput, makeTestScope, newPaymentInput, withPersistence } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * The source Actions through the real registered descriptors and the real Core Action runtime over the
 * worktree PostgreSQL (#1152 "Public admission and runtime lifetime", #1151 TECH-01 late callbacks):
 * Core invocation ledger, idempotent replay, Composition revision admission, owner transaction, RLS and
 * the Core Outbox. Permission and context access are opened here; their matrix is #1153's acceptance.
 * The ERP bank statement and the POS statement are public-contract fixtures of external sources.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const erpBank = {
  accountRef: 'CZ6508000000192000145399',
  environment: 'production',
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-helios',
} as const;
const bankBinding: PaymentExecutionBinding = { _tag: 'BANK_ACCOUNTING_RECEIPT' };
const pickupBinding: PaymentExecutionBinding = {
  _tag: 'PICKUP_CAPABILITY',
  capabilityEvidenceRef: 'pickup-capability-evidence-1',
  pickupCapabilityRef: 'pickup-prague-1',
};

const runtimesFor = Effect.fn('SourceCoreRuntime.runtimes')(function* runtimesFor(
  database: EvidenceNativeDatabase,
  compositionRevision: string,
) {
  const crypto = yield* Crypto.Crypto;
  return makeActionRuntime(
    { executor: database.database },
    makeActionRepository(crypto),
    evidenceAllowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision: makeScriptedBoundAccessGate('allowed').bound,
      contextAccess: evidenceContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(compositionRevision),
    },
  );
});

it.live('#1152 #1151 Late bank evidence through the real Core runtime: ERP receipt accepted once under R2', () =>
  native(
    Effect.gen(function* lateReceiptThroughCore() {
      const { admin, runtime } = yield* testDatabaseClients;
      const database: EvidenceNativeDatabase = {
        coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
        database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
        runtimeClient: runtime,
      };
      const scope = yield* makeTestScope;
      yield* seedCoreScope(database, scope);
      const principal = principalOf(scope);
      const atR1 = yield* runtimesFor(database, COMPOSITION_R1);
      const atR2 = yield* runtimesFor(database, COMPOSITION_R2);

      const configured = yield* atR1.runAction({
        payload: {
          factFamily: 'BANK_ACCOUNTING_RECEIPT',
          method: 'BANK_TRANSFER_ADVANCE',
          reason: 'The customer ERP is the accounting System of Record',
          refundRoute: false,
          source: erpBank,
          status: 'ACTIVE',
        },
        principal,
        registration: configurePaymentSourceAuthorityAction,
        transport: { correlationId: 'payment-source-configure', idempotencyKey: randomUUID() },
      });
      expect([configured.changed, configured.revision, configured.status]).toEqual([true, 1, 'ACTIVE']);

      // The Payment and its COLLECT were admitted under R1 (their creating Actions belong to other lanes).
      const paymentInput = yield* newPaymentInput(scope);
      const payment = yield* withPersistence(database.database, scope, (persistence) =>
        persistence.insertPayment({ ...paymentInput, executionBinding: bankBinding, method: 'BANK_TRANSFER_ADVANCE' }),
      );
      const collectRequest = yield* collectInput(
        scope,
        { amountMinor: 100_000, paymentId: payment.record.paymentId },
        'collect-1',
      );
      const collect = yield* withPersistence(database.database, scope, (persistence) =>
        persistence.insertOperation({
          ...collectRequest,
          binding: bankBinding,
          provenance: { ...collectRequest.provenance, compositionRevision: COMPOSITION_R1 },
        }),
      );

      const receipt = {
        amount: { amountMinor: 100_000, currency: 'CZK' },
        evidenceRef: 'erp-receipt-voucher-17',
        factFamily: 'BANK_ACCOUNTING_RECEIPT',
        factKind: 'COLLECTION_CONFIRMED',
        paymentId: payment.record.paymentId,
        receivedAt: '2026-11-09T07:00:00.000Z',
        source: erpBank,
        sourceOccurredAt: '2026-11-08T09:15:00.000Z',
        sourceOccurrenceId: 'bank-line-2026-11-08-17',
        sourceRevision: 1,
      } satisfies typeof AcceptPaymentObservationPayloadSchema.Encoded;
      const idempotencyKey = randomUUID();
      const request = {
        payload: receipt,
        principal,
        registration: acceptPaymentObservationAction,
        transport: { correlationId: 'payment-source-late-receipt', idempotencyKey },
      } as const;
      const accepted = yield* atR2.runAction(request);
      expect(accepted).toMatchObject({
        acceptanceOutcome: 'ACCEPTED_OBSERVATION',
        interpretation: 'TRANSITION',
        operationId: collect.record.operationId,
        outcomeChange: { from: 'PENDING', operationId: collect.record.operationId, to: 'EFFECT_CONFIRMED' },
      });
      // A retry of the committed invocation is answered by Core (refresh governed reads), never re-executed.
      const replayed = yield* atR2.runAction(request).pipe(Effect.flip);
      expect(Predicate.isTagged(replayed, 'ActionAlreadyCommitted')).toBe(true);

      const [observation] = yield* admin.unsafe<{
        action_invocation_id: string;
        composition_revision: string;
        received_at: Date;
        verified_at: Date;
      }>(
        'select action_invocation_id, composition_revision, received_at, verified_at from payment.observations where observation_id = $1',
        [accepted.observationId],
      );
      expect(observation?.composition_revision).toBe(COMPOSITION_R2);
      expect(observation?.received_at.toISOString()).toBe('2026-11-09T07:00:00.000Z');
      expect((observation?.verified_at.getTime() ?? 0) >= (observation?.received_at.getTime() ?? 1)).toBe(true);
      const invocations = yield* admin.unsafe<{ action_invocation_id: string }>(
        'select action_invocation_id from payment.observations where tenant_id = $1',
        [scope.tenantId],
      );
      expect(invocations).toHaveLength(1);

      const outbox = yield* database.coreAdmin
        .select({ payloadJson: outboxMessages.payloadJson })
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.tenantId, scope.tenantId),
            eq(outboxMessages.producerModuleKey, 'payment.core'),
            eq(outboxMessages.topic, 'payment.core.operation-outcome-changed.v1'),
          ),
        );
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.payloadJson).toMatchObject({
        cause: { _tag: 'OBSERVATION', observationId: accepted.observationId },
        fromOutcome: 'PENDING',
        originalCompositionRevision: COMPOSITION_R1,
        provenance: { actionInvocationId: observation?.action_invocation_id, compositionRevision: COMPOSITION_R2 },
        toOutcome: 'EFFECT_CONFIRMED',
      });
    }),
  ),
);

it.live('#1152 Unauthorized manual mark paid through the real Core runtime: refused, nothing committed', () =>
  native(
    Effect.gen(function* unauthorizedThroughCore() {
      const { admin, runtime } = yield* testDatabaseClients;
      const database: EvidenceNativeDatabase = {
        coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
        database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
        runtimeClient: runtime,
      };
      const scope = yield* makeTestScope;
      yield* seedCoreScope(database, scope);
      const actions = yield* runtimesFor(database, COMPOSITION_R1);
      const paymentInput = yield* newPaymentInput(scope);
      const payment = yield* withPersistence(database.database, scope, (persistence) =>
        persistence.insertPayment({
          ...paymentInput,
          executionBinding: pickupBinding,
          method: 'PAY_ON_PICKUP_OR_ON_SITE',
        }),
      );
      const failure = yield* actions
        .runAction({
          payload: {
            amount: { amountMinor: 100_000, currency: 'CZK' },
            evidenceRef: 'pos-receipt-881',
            factFamily: 'LOCAL_POS_COLLECTION',
            factKind: 'COLLECTION_CONFIRMED',
            paymentId: payment.record.paymentId,
            pickupCapabilityRef: 'pickup-prague-1',
            reason: 'Operator marks the order paid',
            source: {
              accountRef: 'pos-drawer-1',
              environment: 'production',
              sourceKind: 'LOCAL_POS_OPERATOR',
              sourceSystem: 'store-pos',
            },
            sourceOccurrenceId: 'pos-receipt-881',
            sourceRevision: 1,
          },
          principal: principalOf(scope),
          registration: recordPaymentLocalEvidenceAction,
          transport: { correlationId: 'payment-source-mark-paid', idempotencyKey: randomUUID() },
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'PaymentSourceRejected')).toBe(true);
      expect(Predicate.hasProperty(failure, 'code') ? failure.code : undefined).toBe(
        'payment_source_authority_forbidden',
      );
      const [counts] = yield* admin.unsafe<{ cases: number; observations: number }>(
        `select (select count(*)::integer from payment.observations where tenant_id = $1) as observations,
                (select count(*)::integer from payment.reconciliation_cases where tenant_id = $1) as cases`,
        [scope.tenantId],
      );
      expect(counts).toEqual({ cases: 0, observations: 0 });
      const after = yield* withPersistence(database.database, scope, (persistence) =>
        persistence.loadAggregate(payment.record.paymentId),
      );
      expect(after.payment.coverageRevision).toBe(payment.record.coverageRevision);
    }),
  ),
);
