import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { Array as Arr, Crypto, Deferred, Effect, Fiber, Option, Order, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { actionInvocations, dataAccessEvents } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import { paymentEvidencePersistenceForTransaction } from '../../src/persistence/payment-evidence-persistence.ts';
import { paymentSourcePersistenceForTransaction } from '../../src/persistence/payment-source-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';

import { failureCodeOf, operationalScopeOf, paymentTestRelations, provenanceFor } from './database-fixture.ts';
import { acceptObservation, decideReconciliation, refundCaseFor } from '../support/refund-action-driver.ts';
import type { RefundCase } from '../support/refund-action-driver.ts';
import {
  awaitBlockedLockWaiters,
  loadPaymentAggregate,
  refundRuntimeContextAccess,
  refundRuntimePermission,
  seedPayment,
  transitionOperation,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime, SeedPaymentOptions } from '../support/refund-native-runtime.ts';

/**
 * #1151 "Several observations proven to describe the same economic effect count once" across Payments:
 * one bank transaction of one source binding, reported under different occurrence ids and correlated to
 * two different Payments of the same Tenant / Selling Legal Entity, confirms exactly one of them. The
 * other statement stays held reconciliation debt, so one receipt never backs two prepaid coverages.
 * Driven through the registered acceptance and reconciliation Actions on native PostgreSQL.
 */

const native = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeRuntime = Effect.gen(function* acquireAttributionNativeRuntime() {
  const { admin, runtime } = yield* testDatabaseClients;
  const database = yield* makeTestDatabaseFromClient(runtime, paymentTestRelations);
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, paymentTestRelations);
  const actionRuntime = makeActionRuntime(
    { executor: database },
    makeActionRepository(yield* Crypto.Crypto),
    refundRuntimePermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision: makeScriptedBoundAccessGate('allowed').bound,
      contextAccess: refundRuntimeContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actionRuntime, admin, coreAdmin, database } satisfies RefundNativeRuntime;
});

/** The ERP bank account that reports receipts of bank-transfer Payments. */
const erpBank = {
  accountRef: 'CZ6508000000192000145399',
  environment: 'production',
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-helios',
} as const;

/** A 1 000 CZK bank-transfer Payment whose collection still awaits the receipt. */
const bankTransferPayment: SeedPaymentOptions = {
  amountMinor: 100_000,
  binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
  collected: false,
  method: 'BANK_TRANSFER_ADVANCE',
};

/** One bank transaction: the same economic effect whichever occurrence reports it. */
const BANK_TRANSACTION = 'erp-helios:bank-transaction:2026-11-08-17';

interface TwoPayments {
  readonly first: { readonly collectOperationId: string; readonly paymentId: string };
  readonly refundCase: RefundCase;
  readonly second: { readonly collectOperationId: string; readonly paymentId: string };
}

/** Two pending bank-transfer Payments of one Tenant / Selling Legal Entity and the ERP receipt authority. */
const twoBankTransferPayments = Effect.fn('EconomicEffectAttributionTest.twoPayments')(function* twoPayments() {
  const refundCase = yield* refundCaseFor(yield* nativeRuntime, {
    ...bankTransferPayment,
    gatewayRoute: false,
    receiptSource: {
      ...erpBank,
      factFamily: 'BANK_ACCOUNTING_RECEIPT',
      method: 'BANK_TRANSFER_ADVANCE',
      refundRoute: false,
    },
  });
  const second = yield* seedPayment(refundCase.native.database, refundCase.scope, bankTransferPayment);
  return { first: refundCase.payment, refundCase, second } satisfies TwoPayments;
});

type AcceptEncoded = typeof AcceptPaymentObservationPayloadSchema.Encoded;

/** The ERP receipt of the one bank transaction, reported as `sourceOccurrenceId` for one Payment. */
const receiptOf = (
  payment: { readonly collectOperationId: string; readonly paymentId: string },
  sourceOccurrenceId: string,
): AcceptEncoded => ({
  amount: { amountMinor: 100_000, currency: 'CZK' },
  economicEffectKey: BANK_TRANSACTION,
  factFamily: 'BANK_ACCOUNTING_RECEIPT',
  factKind: 'COLLECTION_CONFIRMED',
  operationId: payment.collectOperationId,
  paymentId: payment.paymentId,
  source: erpBank,
  sourceOccurrenceId,
  sourceRevision: 0,
});

const collectOutcomeOf = Effect.fn('EconomicEffectAttributionTest.collectOutcomeOf')(function* collectOutcomeOf(
  refundCase: RefundCase,
  payment: { readonly collectOperationId: string; readonly paymentId: string },
) {
  const aggregate = yield* loadPaymentAggregate(refundCase.native.database, refundCase.scope, payment.paymentId);
  return aggregate.operations.find((operation) => operation.operationId === payment.collectOperationId)?.outcome;
});

it.live(
  '#1151 one bank transaction confirms one Payment: the same transaction reported for another Payment is held',
  () =>
    native(
      Effect.gen(function* oneTransactionOnePayment() {
        const { first, refundCase, second } = yield* twoBankTransferPayments();
        // The bank statement import confirms the receipt for the first Payment.
        const confirmed = yield* acceptObservation(refundCase, receiptOf(first, 'bank-statement-line-17'));
        expect(confirmed.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        expect(confirmed.outcomeChange?.to).toBe('EFFECT_CONFIRMED');
        // The ERP voucher reports the same bank transaction for the second Payment: it cannot confirm it too.
        const reused = yield* acceptObservation(refundCase, receiptOf(second, 'erp-receipt-voucher-17'));
        expect(reused.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        expect(reused.outcomeChange).toBeUndefined();
        expect(reused.reconciliationCaseId).toBeDefined();
        // The same transaction restated for the first Payment still corroborates its own collection.
        const restated = yield* acceptObservation(refundCase, receiptOf(first, 'erp-receipt-voucher-17-copy'));
        expect(restated.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        expect(restated.interpretation).toBe('NO_CHANGE');

        expect(yield* collectOutcomeOf(refundCase, first)).toBe('EFFECT_CONFIRMED');
        expect(yield* collectOutcomeOf(refundCase, second)).toBe('PENDING');
      }),
    ),
);

it.live('#1151 a new keyless receipt cannot corroborate a standing confirmation, but exact redelivery replays', () =>
  native(
    Effect.gen(function* keylessReceiptRestatement() {
      const { first, refundCase } = yield* twoBankTransferPayments();
      const { economicEffectKey: _key, ...receipt } = receiptOf(first, 'keyless-bank-statement-line');
      const confirmed = yield* acceptObservation(refundCase, receipt);
      expect(confirmed.outcomeChange?.to).toBe('EFFECT_CONFIRMED');
      const duplicate = yield* acceptObservation(refundCase, receipt);
      expect(duplicate.acceptanceOutcome).toBe('DUPLICATE');
      expect(duplicate.observationId).toBe(confirmed.observationId);

      const restated = yield* acceptObservation(refundCase, {
        ...receipt,
        sourceOccurrenceId: 'unlinked-erp-voucher',
      });
      expect(restated.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      expect(restated.reconciliationCaseId).toBeDefined();
      expect(restated.outcomeChange).toBeUndefined();
      expect(yield* collectOutcomeOf(refundCase, first)).toBe('EFFECT_CONFIRMED');
    }),
  ),
);

it.live('#1151 exact Payment correlation alone does not identify an economic effect across keyless receipts', () =>
  native(
    Effect.gen(function* twoKeylessReceipts() {
      const { first, refundCase, second } = yield* twoBankTransferPayments();
      const { economicEffectKey: _firstKey, ...bankStatement } = receiptOf(first, 'keyless-bank-statement');
      const { economicEffectKey: _secondKey, ...erpVoucher } = receiptOf(second, 'keyless-erp-voucher');

      // Both receipts have a valid source and exact operation. No common economic identity is supplied.
      const bankResult = yield* acceptObservation(refundCase, bankStatement);
      const voucherResult = yield* acceptObservation(refundCase, erpVoucher);
      expect(bankResult).toMatchObject({
        acceptanceOutcome: 'ACCEPTED_OBSERVATION',
        operationId: first.collectOperationId,
      });
      expect(voucherResult).toMatchObject({
        acceptanceOutcome: 'ACCEPTED_OBSERVATION',
        operationId: second.collectOperationId,
      });
      expect(yield* collectOutcomeOf(refundCase, first)).toBe('EFFECT_CONFIRMED');
      expect(yield* collectOutcomeOf(refundCase, second)).toBe('EFFECT_CONFIRMED');
    }),
  ),
);

it.live(
  '#1151 one bank transaction confirms one Payment: concurrent first reports for two Payments confirm exactly one',
  () =>
    native(
      Effect.gen(function* concurrentFirstAttribution() {
        const { first, refundCase, second } = yield* twoBankTransferPayments();
        const results = yield* Effect.all(
          [
            acceptObservation(refundCase, receiptOf(first, 'bank-statement-line-17')),
            acceptObservation(refundCase, receiptOf(second, 'erp-receipt-voucher-17')),
          ],
          { concurrency: 2 },
        );
        expect(
          Arr.sort(
            results.map((result) => result.acceptanceOutcome),
            Order.String,
          ),
        ).toEqual(['ACCEPTED_OBSERVATION', 'HELD_UNRESOLVED']);
        const outcomes = [yield* collectOutcomeOf(refundCase, first), yield* collectOutcomeOf(refundCase, second)];
        expect(
          Arr.sort(
            outcomes.flatMap((outcome) => (outcome === undefined ? [] : [outcome])),
            Order.String,
          ),
        ).toEqual(['EFFECT_CONFIRMED', 'PENDING']);
      }),
    ),
);

it.live(
  '#1151 one bank transaction confirms one Payment: governed attachment never counts a transaction that confirmed another Payment',
  () =>
    native(
      Effect.gen(function* attachAfterAcceptance() {
        const { first, refundCase, second } = yield* twoBankTransferPayments();
        const confirmed = yield* acceptObservation(refundCase, receiptOf(first, 'bank-statement-line-17'));
        expect(confirmed.outcomeChange?.to).toBe('EFFECT_CONFIRMED');
        // Contradictory signals left the second collection in CONFLICT: the report waits as held debt.
        yield* transitionOperation(refundCase.native.database, refundCase.scope, {
          operationId: second.collectOperationId,
          paymentId: second.paymentId,
          to: 'CONFLICT',
        });
        const held = yield* acceptObservation(refundCase, receiptOf(second, 'erp-receipt-voucher-17'));
        expect(held.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        // Governance cannot attach the transaction that already confirmed the first Payment.
        const attach = decideReconciliation(refundCase, {
          caseId: held.reconciliationCaseId ?? '',
          decision: {
            _tag: 'ATTACH_EVIDENCE',
            observationId: held.observationId,
            operationId: second.collectOperationId,
          },
          reason: 'The voucher is the second Payment',
        });
        expect(yield* failureCodeOf(attach)).toBe('payment_reconciliation_evidence_not_qualified');
        expect(yield* collectOutcomeOf(refundCase, first)).toBe('EFFECT_CONFIRMED');
        expect(yield* collectOutcomeOf(refundCase, second)).toBe('CONFLICT');
      }),
    ),
);

it.live(
  '#1151 one bank transaction confirms one Payment: a transaction attached by governance never confirms another Payment',
  () =>
    native(
      Effect.gen(function* acceptanceAfterAttach() {
        const { first, refundCase, second } = yield* twoBankTransferPayments();
        yield* transitionOperation(refundCase.native.database, refundCase.scope, {
          operationId: first.collectOperationId,
          paymentId: first.paymentId,
          to: 'CONFLICT',
        });
        const held = yield* acceptObservation(refundCase, receiptOf(first, 'bank-statement-line-17'));
        expect(held.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        // Governed reconciliation attaches the transaction to the first Payment, which confirms it.
        const attached = yield* decideReconciliation(refundCase, {
          caseId: held.reconciliationCaseId ?? '',
          decision: {
            _tag: 'ATTACH_EVIDENCE',
            observationId: held.observationId,
            operationId: first.collectOperationId,
          },
          reason: 'The statement line is the first Payment',
        });
        expect(Option.getOrUndefined(attached.outcomeChange)).toMatchObject({ toOutcome: 'EFFECT_CONFIRMED' });
        // The ERP voucher reports the same transaction for the second Payment: held, not counted again.
        const reused = yield* acceptObservation(refundCase, receiptOf(second, 'erp-receipt-voucher-17'));
        expect(reused.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        expect(yield* collectOutcomeOf(refundCase, second)).toBe('PENDING');
      }),
    ),
);

it.live(
  '#1151 one bank transaction confirms one Payment: a report racing an uncommitted attribution of another Payment ends held, not failed',
  () =>
    native(
      Effect.gen(function* racingFirstAttribution() {
        const { first, refundCase, second } = yield* twoBankTransferPayments();
        const { database } = refundCase.native;
        const { scope } = refundCase;
        const provenance = yield* provenanceFor(scope);
        const attributed = yield* Deferred.make<number>();
        const release = yield* Deferred.make<boolean>();
        // A governed attachment of the first Payment has claimed the transaction but not yet committed.
        const holder = yield* database
          .transaction((transaction) =>
            Effect.gen(function* holdUncommittedAttribution() {
              const scoped = yield* installOperationalScope(
                transaction,
                operationalScopeOf(scope),
                defineDatabaseIdentityEnrollment([]),
              );
              const claim = yield* paymentEvidencePersistenceForTransaction(scoped).attributeEconomicEffect({
                economicEffectKey: BANK_TRANSACTION,
                factKind: 'COLLECTION_CONFIRMED',
                operationId: first.collectOperationId,
                paymentId: first.paymentId,
                provenance,
                source: erpBank,
              });
              const [backend] = yield* transaction.execute<{ readonly pid: number }>(
                sql`select pg_catalog.pg_backend_pid() as pid`,
                'objects',
              );
              yield* Deferred.succeed(attributed, backend?.pid ?? 0);
              yield* Deferred.await(release);
              return claim;
            }),
          )
          .pipe(Effect.forkChild);
        const holderPid = yield* Deferred.await(attributed);
        // The ERP voucher reports the same transaction for the second Payment and waits on the claim.
        const racing = yield* acceptObservation(refundCase, receiptOf(second, 'erp-receipt-voucher-17')).pipe(
          Effect.forkChild,
        );
        expect(yield* awaitBlockedLockWaiters(refundCase.native, holderPid, 1)).toBeGreaterThan(0);
        yield* Deferred.succeed(release, true);

        expect(yield* Fiber.join(holder)).toBe('ATTRIBUTED');
        const reused = yield* Fiber.join(racing);
        expect(reused.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        expect(reused.reconciliationCaseId).toBeDefined();
        expect(yield* collectOutcomeOf(refundCase, second)).toBe('PENDING');
      }),
    ),
);

it.live('#1152 attachment waits for a pending authority revocation and refuses after it commits', () =>
  native(
    Effect.gen(function* revokeBeforeAttachment() {
      const { first, refundCase } = yield* twoBankTransferPayments();
      const { database } = refundCase.native;
      const { scope } = refundCase;
      yield* transitionOperation(database, scope, {
        operationId: first.collectOperationId,
        paymentId: first.paymentId,
        to: 'CONFLICT',
      });
      const held = yield* acceptObservation(refundCase, receiptOf(first, 'bank-receipt-to-attach'));
      expect(held).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED', operationId: first.collectOperationId });

      const updated = yield* Deferred.make<number>();
      const release = yield* Deferred.make<boolean>();
      const provenance = yield* provenanceFor(scope);
      const revoke = yield* database
        .transaction((transaction) =>
          Effect.gen(function* pauseRevocation() {
            const scoped = yield* installOperationalScope(
              transaction,
              operationalScopeOf(scope),
              defineDatabaseIdentityEnrollment([]),
            );
            const sources = paymentSourcePersistenceForTransaction(
              scoped,
              scope,
              paymentEvidencePersistenceForTransaction(scoped),
            );
            yield* sources.configureAuthority({
              expectedRevision: 1,
              factFamily: 'BANK_ACCOUNTING_RECEIPT',
              method: 'BANK_TRANSFER_ADVANCE',
              provenance,
              reason: 'Revoke original bank receipt authority',
              refundRoute: false,
              source: erpBank,
              status: 'REVOKED',
              submitterPrincipalIds: [scope.principalId],
            });
            const [backend] = yield* transaction.execute<{ readonly pid: number }>(
              sql`select pg_catalog.pg_backend_pid() as pid`,
              'objects',
            );
            yield* Deferred.succeed(updated, backend?.pid ?? 0);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      const holderPid = yield* Deferred.await(updated);
      const attach = yield* decideReconciliation(refundCase, {
        caseId: held.reconciliationCaseId ?? '',
        decision: { _tag: 'ATTACH_EVIDENCE', observationId: held.observationId },
        reason: 'Attach the bank receipt that resolves the collection conflict',
      }).pipe(
        Effect.match({
          onFailure: (failure) => (Predicate.hasProperty(failure, 'code') ? failure.code : 'unknown'),
          onSuccess: () => 'APPLIED',
        }),
        Effect.forkChild,
      );
      const waited = yield* Effect.race(
        awaitBlockedLockWaiters(refundCase.native, holderPid, 1).pipe(Effect.map((waiters) => waiters > 0)),
        Fiber.await(attach).pipe(Effect.as(false)),
      );
      const paymentLock = yield* refundCase.native.admin
        .unsafe('select payment_id from payment.payments where payment_id = $1 for update nowait', [first.paymentId])
        .pipe(Effect.result);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(revoke);

      expect(Result.isSuccess(paymentLock)).toBe(true);
      const refusal = yield* Fiber.join(attach);
      expect({ refusal, waited }).toEqual({ refusal: 'payment_reconciliation_evidence_not_qualified', waited: true });
      expect(yield* collectOutcomeOf(refundCase, first)).toBe('CONFLICT');
    }),
  ),
);

/** The economic-effect attribution lookups Core persisted in the scenario's Tenant, with their Action. */
const attributionLookupsOf = (refundCase: RefundCase) =>
  refundCase.native.coreAdmin
    .select({
      accessKind: dataAccessEvents.accessKind,
      actionKey: actionInvocations.actionKey,
      queryHash: dataAccessEvents.queryHash,
      resultCount: dataAccessEvents.resultCount,
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
    .where(
      and(
        eq(dataAccessEvents.tenantId, refundCase.scope.tenantId),
        like(dataAccessEvents.queryHash, 'payment.core.economic-effect-attribution%'),
      ),
    )
    .orderBy(asc(dataAccessEvents.occurredAt));

const attributionLookup = (actionKey: string, paymentId: string) => ({
  accessKind: 'read',
  actionKey,
  queryHash: `payment.core.economic-effect-attribution:${paymentId}`,
  resultCount: 1,
  targetResourceId: paymentId,
  targetResourceType: 'payment.core.payment',
});

it.live(
  '#1151 one bank transaction confirms one Payment: every decision on the attribution persists its Data Access Event',
  () =>
    native(
      Effect.gen(function* attributionDataAccessEvidence() {
        const { first, refundCase, second } = yield* twoBankTransferPayments();
        yield* transitionOperation(refundCase.native.database, refundCase.scope, {
          operationId: first.collectOperationId,
          paymentId: first.paymentId,
          to: 'CONFLICT',
        });
        const held = yield* acceptObservation(refundCase, receiptOf(first, 'bank-statement-line-17'));
        // Governance attaches the transaction to the first Payment: the claim is part of that decision.
        yield* decideReconciliation(refundCase, {
          caseId: held.reconciliationCaseId ?? '',
          decision: {
            _tag: 'ATTACH_EVIDENCE',
            observationId: held.observationId,
            operationId: first.collectOperationId,
          },
          reason: 'The statement line is the first Payment',
        });
        // The report for the second Payment is held because the attribution names the first Payment.
        const reused = yield* acceptObservation(refundCase, receiptOf(second, 'erp-receipt-voucher-17'));
        expect(reused.acceptanceOutcome).toBe('HELD_UNRESOLVED');

        expect(yield* attributionLookupsOf(refundCase)).toStrictEqual([
          attributionLookup('payment.core.record-payment-reconciliation-decision', first.paymentId),
          attributionLookup('payment.core.accept-payment-observation', second.paymentId),
        ]);
      }),
    ),
);
