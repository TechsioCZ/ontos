import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Predicate, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  coreRelations,
  outboxMessages,
  principalAuthBindings,
  principals,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { PaymentSourceRejected } from '../../shared/domain/source-statement.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { recordPaymentLocalEvidenceAction } from '../../src/actions/record-payment-local-evidence.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { collectInput, makeTestScope, newPaymentInput, withPersistence } from './database-fixture.ts';
import type { PaymentTestScope } from './database-fixture.ts';
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

/** One more active principal of the scope's Tenant (an integration, provider or POS operator identity). */
const seedPrincipal = Effect.fn('SourceCoreRuntime.seedPrincipal')(function* seedPrincipal(
  database: EvidenceNativeDatabase,
  scope: PaymentTestScope,
  displayName: string,
) {
  const principalId = randomUUID();
  yield* database.coreAdmin.insert(principals).values({
    displayName,
    kind: 'human',
    principalId,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* database.coreAdmin.insert(principalAuthBindings).values({
    authenticationNamespaceId: 'test.payment-evidence.v1',
    principalAuthBindingId: principalId,
    principalId,
    provider: 'better_auth',
    providerSubjectId: `payment-source-${principalId}`,
    status: 'active',
    subjectType: 'user',
    tenantId: scope.tenantId,
  });
  return { principal: principalOf({ ...scope, principalId }), principalId };
});

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
          submitterPrincipalIds: [scope.principalId],
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

/** The refusal of a statement from a principal that is not bound to the claimed source authority. */
const isSourceRejected = Schema.is(PaymentSourceRejected);
const expectForbiddenSource = (failure: { readonly _tag: string }) =>
  expect(isSourceRejected(failure) ? failure.code : undefined).toBe('payment_source_authority_forbidden');

it.live(
  '#1153 #1152 Only principals bound to a source authority speak as it: bound accepted, another permitted principal and a revoked binding refused',
  () =>
    native(
      Effect.gen(function* boundSubmitters() {
        const { admin, runtime } = yield* testDatabaseClients;
        const database: EvidenceNativeDatabase = {
          coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
          database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
          runtimeClient: runtime,
        };
        const scope = yield* makeTestScope;
        yield* seedCoreScope(database, scope);
        const staff = principalOf(scope);
        const erp = yield* seedPrincipal(database, scope, 'ERP integration principal');
        const carrier = yield* seedPrincipal(database, scope, 'Carrier integration principal');
        // Every principal here holds payment.core.observation.accept: the permission alone is not the source.
        const actions = yield* runtimesFor(database, COMPOSITION_R1);
        const configure = (submitterPrincipalIds: readonly string[], expectedRevision?: number) => {
          const binding = {
            factFamily: 'BANK_ACCOUNTING_RECEIPT',
            method: 'BANK_TRANSFER_ADVANCE',
            reason: 'The customer ERP is the accounting System of Record',
            refundRoute: false,
            source: erpBank,
            status: 'ACTIVE',
            submitterPrincipalIds,
          } as const;
          return actions.runAction({
            payload: expectedRevision === undefined ? binding : { ...binding, expectedRevision },
            principal: staff,
            registration: configurePaymentSourceAuthorityAction,
            transport: { correlationId: 'payment-source-bind', idempotencyKey: randomUUID() },
          });
        };
        const bound = yield* configure([erp.principalId]);
        expect([bound.revision, bound.submitterPrincipalIds]).toEqual([1, [erp.principalId]]);

        const paymentInput = yield* newPaymentInput(scope);
        const payment = yield* withPersistence(database.database, scope, (persistence) =>
          persistence.insertPayment({
            ...paymentInput,
            executionBinding: bankBinding,
            method: 'BANK_TRANSFER_ADVANCE',
          }),
        );
        const collectRequest = yield* collectInput(
          scope,
          { amountMinor: 100_000, paymentId: payment.record.paymentId },
          'collect-1',
        );
        const collect = yield* withPersistence(database.database, scope, (persistence) =>
          persistence.insertOperation({ ...collectRequest, binding: bankBinding }),
        );
        const receipt = (sourceOccurrenceId: string) =>
          ({
            amount: { amountMinor: 100_000, currency: 'CZK' },
            evidenceRef: `voucher-${sourceOccurrenceId}`,
            factFamily: 'BANK_ACCOUNTING_RECEIPT',
            factKind: 'COLLECTION_CONFIRMED',
            paymentId: payment.record.paymentId,
            source: erpBank,
            sourceOccurrenceId,
            sourceRevision: 1,
          }) satisfies typeof AcceptPaymentObservationPayloadSchema.Encoded;
        const submit = (
          principal: ReturnType<typeof principalOf>,
          payload: typeof AcceptPaymentObservationPayloadSchema.Encoded,
        ) =>
          actions.runAction({
            payload,
            principal,
            registration: acceptPaymentObservationAction,
            transport: { correlationId: 'payment-source-bound-submit', idempotencyKey: randomUUID() },
          });
        const recorded = () =>
          admin.unsafe<{ observations: number; outcome: string }>(
            `select (select count(*)::integer from payment.observations where tenant_id = $1) as observations,
                    (select outcome from payment.payment_operations where operation_id = $2) as outcome`,
            [scope.tenantId, collect.record.operationId],
          );

        // Another principal holding the same permission names the ERP source: refused, nothing written.
        expectForbiddenSource(yield* submit(carrier.principal, receipt('bank-line-forged')).pipe(Effect.flip));
        // The configuring staff principal is not a submitter of the source either.
        expectForbiddenSource(yield* submit(staff, receipt('bank-line-staff')).pipe(Effect.flip));
        expect(yield* recorded()).toEqual([{ observations: 0, outcome: 'PENDING' }]);

        // The bound ERP principal is the source: its receipt confirms the collection.
        const accepted = yield* submit(erp.principal, receipt('bank-line-1'));
        expect(accepted).toMatchObject({
          acceptanceOutcome: 'ACCEPTED_OBSERVATION',
          outcomeChange: { from: 'PENDING', to: 'EFFECT_CONFIRMED' },
          sourceAuthorityId: bound.sourceAuthorityId,
        });

        // Revoking the binding is a new audited revision; the former submitter is then refused.
        const rebound = yield* configure([carrier.principalId], 1);
        expect([rebound.changed, rebound.revision, rebound.submitterPrincipalIds]).toEqual([
          true,
          2,
          [carrier.principalId],
        ]);
        const correction = {
          correctsObservationId: accepted.observationId,
          factFamily: 'BANK_ACCOUNTING_RECEIPT',
          factKind: 'SOURCE_CORRECTION',
          paymentId: payment.record.paymentId,
          source: erpBank,
          sourceOccurrenceId: 'bank-line-1-storno',
          sourceRevision: 1,
        } satisfies typeof AcceptPaymentObservationPayloadSchema.Encoded;
        expectForbiddenSource(yield* submit(erp.principal, correction).pipe(Effect.flip));
        expect(yield* recorded()).toEqual([{ observations: 1, outcome: 'EFFECT_CONFIRMED' }]);

        // The binding history is append-only: each revision keeps the submitters it bound.
        const revisions = yield* admin.unsafe<{ revision: number; submitter_principal_ids: string[] }>(
          `select revision, submitter_principal_ids from payment.source_authority_revisions
            where source_authority_id = $1 order by revision`,
          [bound.sourceAuthorityId],
        );
        expect(revisions).toEqual([
          { revision: 1, submitter_principal_ids: [erp.principalId] },
          { revision: 2, submitter_principal_ids: [carrier.principalId] },
        ]);
      }),
    ),
);

it.live('#1153 #1152 Local POS evidence is accepted only from an operator bound to the configured POS source', () =>
  native(
    Effect.gen(function* boundOperator() {
      const { admin, runtime } = yield* testDatabaseClients;
      const database: EvidenceNativeDatabase = {
        coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
        database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
        runtimeClient: runtime,
      };
      const scope = yield* makeTestScope;
      yield* seedCoreScope(database, scope);
      const staff = principalOf(scope);
      const cashier = yield* seedPrincipal(database, scope, 'Prague store cashier');
      const actions = yield* runtimesFor(database, COMPOSITION_R1);
      const posSource = {
        accountRef: 'pos-drawer-1',
        environment: 'production',
        sourceKind: 'LOCAL_POS_OPERATOR',
        sourceSystem: 'store-pos',
      } as const;
      yield* actions.runAction({
        payload: {
          factFamily: 'LOCAL_POS_COLLECTION',
          method: 'PAY_ON_PICKUP_OR_ON_SITE',
          reason: 'The Prague store POS records pickup payments',
          refundRoute: false,
          source: posSource,
          status: 'ACTIVE',
          submitterPrincipalIds: [cashier.principalId],
        },
        principal: staff,
        registration: configurePaymentSourceAuthorityAction,
        transport: { correlationId: 'payment-source-pos', idempotencyKey: randomUUID() },
      });
      const paymentInput = yield* newPaymentInput(scope);
      const payment = yield* withPersistence(database.database, scope, (persistence) =>
        persistence.insertPayment({
          ...paymentInput,
          executionBinding: pickupBinding,
          method: 'PAY_ON_PICKUP_OR_ON_SITE',
        }),
      );
      const collectRequest = yield* collectInput(
        scope,
        { amountMinor: 100_000, paymentId: payment.record.paymentId },
        'collect-1',
      );
      yield* withPersistence(database.database, scope, (persistence) =>
        persistence.insertOperation({ ...collectRequest, binding: pickupBinding }),
      );
      const record = (principal: ReturnType<typeof principalOf>, sourceOccurrenceId: string) =>
        actions.runAction({
          payload: {
            amount: { amountMinor: 100_000, currency: 'CZK' },
            evidenceRef: sourceOccurrenceId,
            factFamily: 'LOCAL_POS_COLLECTION',
            factKind: 'COLLECTION_CONFIRMED',
            paymentId: payment.record.paymentId,
            pickupCapabilityRef: 'pickup-prague-1',
            reason: 'Customer paid at pickup',
            source: posSource,
            sourceOccurrenceId,
            sourceRevision: 1,
          },
          principal,
          registration: recordPaymentLocalEvidenceAction,
          transport: { correlationId: 'payment-source-pos-record', idempotencyKey: randomUUID() },
        });

      // Holding the local-evidence permission is not being the configured POS operator.
      expectForbiddenSource(yield* record(staff, 'pos-receipt-staff').pipe(Effect.flip));
      const [before] = yield* admin.unsafe<{ observations: number }>(
        'select count(*)::integer as observations from payment.observations where tenant_id = $1',
        [scope.tenantId],
      );
      expect(before).toEqual({ observations: 0 });

      const accepted = yield* record(cashier.principal, 'pos-receipt-882');
      expect(accepted).toMatchObject({
        acceptanceOutcome: 'ACCEPTED_OBSERVATION',
        outcomeChange: { from: 'PENDING', to: 'EFFECT_CONFIRMED' },
      });
    }),
  ),
);
