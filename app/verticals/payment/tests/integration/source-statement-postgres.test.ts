import { Deferred, Effect, Fiber, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import { ConfigurePaymentSourceAuthorityPayloadSchema } from '../../shared/actions/configure-payment-source-authority.ts';
import { RecordPaymentLocalEvidencePayloadSchema } from '../../shared/actions/record-payment-local-evidence.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { PaymentRefundBasisSchema } from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import {
  acceptPaymentObservationAction,
  handleAcceptPaymentObservation,
} from '../../src/actions/accept-payment-observation.action.ts';
import {
  configurePaymentSourceAuthorityAction,
  handleConfigurePaymentSourceAuthority,
} from '../../src/actions/configure-payment-source-authority.action.ts';
import {
  handleRecordPaymentLocalEvidence,
  recordPaymentLocalEvidenceAction,
} from '../../src/actions/record-payment-local-evidence.action.ts';
import type { PaymentRecord } from '../../src/persistence/payment-aggregate-persistence.ts';
import { paymentSourceServicesForTransaction } from '../../src/persistence/payment-source-persistence.ts';
import type { PaymentSourceServices } from '../../src/persistence/payment-source-persistence.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  failureCodeOf,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  paymentTestRelations,
  provenanceFor,
  randomUuid,
  withPersistence,
} from './database-fixture.ts';

/**
 * Native PostgreSQL acceptance of the external/offline source boundary (#1152, ingress half of #1151).
 * Each statement runs the real registered handler with its real service factory and Core Action
 * collector inside one Core-scoped transaction, exactly as the Action runtime installs it, against the
 * worktree database. Bank/ERP, carrier, POS and manual-route statements are public-contract fixtures
 * of those external sources; Payment setup uses the foundation aggregate primitives.
 */

const R2 = 'd'.repeat(64);

/** Public-contract fixtures of external source bindings. */
const erpBank = {
  accountRef: 'CZ6508000000192000145399',
  environment: 'production',
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-helios',
} as const;
const pplCarrier = {
  accountRef: 'ppl-cod-contract-1',
  environment: 'production',
  sourceKind: 'CARRIER',
  sourceSystem: 'ppl',
} as const;
const storePos = {
  accountRef: 'pos-drawer-1',
  environment: 'production',
  sourceKind: 'LOCAL_POS_OPERATOR',
  sourceSystem: 'store-pos',
} as const;
const treasuryDesk = {
  accountRef: 'treasury-manual-1',
  environment: 'production',
  sourceKind: 'MANUAL_EXTERNAL_REFUND',
  sourceSystem: 'treasury-desk',
} as const;

const bankBinding: PaymentExecutionBinding = { _tag: 'BANK_ACCOUNTING_RECEIPT' };
const codBinding: PaymentExecutionBinding = {
  _tag: 'COD_DELIVERY_OFFER',
  capabilityEvidenceRef: 'cod-capability-evidence-1',
  deliveryOfferRef: 'ppl-delivery-offer-1',
};
const pickupBinding: PaymentExecutionBinding = {
  _tag: 'PICKUP_CAPABILITY',
  capabilityEvidenceRef: 'pickup-capability-evidence-1',
  pickupCapabilityRef: 'pickup-prague-1',
};

interface ActionBase {
  readonly actionInvocationId: string;
  readonly compositionRevision: string;
  readonly scope: ReturnType<typeof operationalScopeOf>;
}

/** One Core-scoped owner transaction carrying the Action's real services, as the runtime installs them. */
const inActionTransaction = <A, E>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  compositionRevision: string,
  body: (services: PaymentSourceServices, base: ActionBase) => Effect.Effect<A, E>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* scopedAction() {
      const operational = operationalScopeOf(scope);
      const scoped = yield* installOperationalScope(transaction, operational);
      const services = yield* paymentSourceServicesForTransaction(scoped, operational, compositionRevision);
      const actionInvocationId = yield* randomUuid;
      return yield* body(services, { actionInvocationId, compositionRevision, scope: operational });
    }),
  );

const configure = Effect.fn('SourceTest.configure')(function* configure(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  encoded: typeof ConfigurePaymentSourceAuthorityPayloadSchema.Encoded,
) {
  const payload = yield* Schema.decodeUnknownEffect(ConfigurePaymentSourceAuthorityPayloadSchema)(encoded);
  return yield* inActionTransaction(database, scope, COMPOSITION_REVISION, (services, base) => {
    const { descriptor } = configurePaymentSourceAuthorityAction;
    const collector = createActionCollector(
      descriptor.domainEvents,
      'payment.core',
      descriptor.accessEvidencePolicy,
      descriptor.auditEvidenceSchema,
    );
    return handleConfigurePaymentSourceAuthority(payload, { ...base, ...collector, services });
  });
});

const accept = Effect.fn('SourceTest.accept')(function* accept(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  encoded: typeof AcceptPaymentObservationPayloadSchema.Encoded,
  compositionRevision: string = COMPOSITION_REVISION,
) {
  const payload = yield* Schema.decodeUnknownEffect(AcceptPaymentObservationPayloadSchema)(encoded);
  return yield* inActionTransaction(database, scope, compositionRevision, (services, base) => {
    const { descriptor } = acceptPaymentObservationAction;
    const collector = createActionCollector(
      descriptor.domainEvents,
      'payment.core',
      descriptor.accessEvidencePolicy,
      descriptor.auditEvidenceSchema,
    );
    return handleAcceptPaymentObservation(payload, { ...base, ...collector, services }).pipe(
      Effect.map((result) => ({ evidence: collector.snapshot(), invocationId: base.actionInvocationId, result })),
    );
  });
});

const recordLocal = Effect.fn('SourceTest.recordLocal')(function* recordLocal(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  encoded: typeof RecordPaymentLocalEvidencePayloadSchema.Encoded,
) {
  const payload = yield* Schema.decodeUnknownEffect(RecordPaymentLocalEvidencePayloadSchema)(encoded);
  return yield* inActionTransaction(database, scope, COMPOSITION_REVISION, (services, base) => {
    const { descriptor } = recordPaymentLocalEvidenceAction;
    const collector = createActionCollector(
      descriptor.domainEvents,
      'payment.core',
      descriptor.accessEvidencePolicy,
      descriptor.auditEvidenceSchema,
    );
    return handleRecordPaymentLocalEvidence(payload, { ...base, ...collector, services }).pipe(
      Effect.map((result) => ({ evidence: collector.snapshot(), result })),
    );
  });
});

const createPayment = Effect.fn('SourceTest.createPayment')(function* createPayment(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  method: PaymentMethod,
  executionBinding: PaymentExecutionBinding,
) {
  const input = yield* newPaymentInput(scope);
  const created = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertPayment({ ...input, executionBinding, method }),
  );
  return created.record;
});

const startCollect = Effect.fn('SourceTest.startCollect')(function* startCollect(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  payment: PaymentRecord,
) {
  const input = yield* collectInput(scope, { amountMinor: 100_000, paymentId: payment.paymentId }, 'collect-1');
  const created = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertOperation({ ...input, binding: payment.executionBinding }),
  );
  return created.record;
});

const startRefund = Effect.fn('SourceTest.startRefund')(function* startRefund(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  payment: PaymentRecord,
  collectOperationId: string,
) {
  const provenance = yield* provenanceFor(scope);
  const refundBasis = Schema.decodeUnknownSync(PaymentRefundBasisSchema)({
    _tag: 'REFUNDABLE_ITEMS',
    items: [{ amountMinor: 100_000, currency: 'CZK', itemRef: 'order-item-1', sourceEvidenceRef: 'aftercare-claim-1' }],
  });
  const created = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertOperation({
      amount: { amountMinor: 100_000, currency: 'CZK' },
      binding: payment.executionBinding,
      initialOutcome: 'PENDING',
      kind: 'REFUND',
      materialRequest: { amountMinor: 100_000, itemRefs: ['order-item-1'], kind: 'REFUND' },
      operationKey: 'refund-1',
      paymentId: payment.paymentId,
      provenance,
      refundBasis,
      targetOperationId: collectOperationId,
    }),
  );
  return created.record;
});

const aggregateOf = (database: PaymentTestDatabase, scope: PaymentTestScope, paymentId: string) =>
  withPersistence(database, scope, (persistence) => persistence.loadAggregate(paymentId));

const outcomeOf = Effect.fn('SourceTest.outcomeOf')(function* outcomeOf(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  paymentId: string,
  operationId: string,
) {
  const aggregate = yield* aggregateOf(database, scope, paymentId);
  return aggregate.operations.find((operation) => operation.operationId === operationId)?.outcome;
});

type AcceptEncoded = typeof AcceptPaymentObservationPayloadSchema.Encoded;
type ConfigureEncoded = typeof ConfigurePaymentSourceAuthorityPayloadSchema.Encoded;

const bankReceipt = (paymentId: string, overrides: Partial<AcceptEncoded> = {}): AcceptEncoded => ({
  amount: { amountMinor: 100_000, currency: 'CZK' },
  evidenceRef: 'erp-receipt-voucher-17',
  factFamily: 'BANK_ACCOUNTING_RECEIPT',
  factKind: 'COLLECTION_CONFIRMED',
  paymentId,
  source: erpBank,
  sourceOccurredAt: '2026-11-08T09:15:00.000Z',
  sourceOccurrenceId: 'bank-line-2026-11-08-17',
  sourceRevision: 1,
  ...overrides,
});

const authorityFor = (
  source: ConfigureEncoded['source'],
  factFamily: ConfigureEncoded['factFamily'],
  method: PaymentMethod,
  refundRoute = false,
): ConfigureEncoded => ({
  factFamily,
  method,
  reason: `Configured ${factFamily} authority`,
  refundRoute,
  source,
  status: 'ACTIVE',
});

const nativeDatabase = Effect.gen(function* nativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const database = yield* makeTestDatabaseFromClient(runtime, paymentTestRelations);
  const scope = yield* makeTestScope;
  const countRows = (table: 'observations' | 'reconciliation_cases' | 'operation_outcome_transitions') =>
    admin
      .unsafe<{ count: number }>(
        `select count(*)::integer as count from payment.${table} where tenant_id = $1 and legal_entity_id = $2`,
        [scope.tenantId, scope.legalEntityId],
      )
      .pipe(Effect.map((rows) => rows[0]?.count ?? -1));
  return { admin, countRows, database, scope };
});

describe('#1152 external/offline source boundary on native PostgreSQL', () => {
  it.live('#1152 QR exists without bank receipt: collection is not confirmed and a QR instruction is no receipt', () =>
    Effect.scoped(
      Effect.gen(function* qrWithoutReceipt() {
        const { countRows, database, scope } = yield* nativeDatabase;
        yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
        const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
        const collect = yield* startCollect(database, scope, payment);
        const refused = yield* failureCodeOf(
          accept(database, scope, bankReceipt(payment.paymentId, { factKind: 'COLLECTION_PENDING' })),
        );
        expect(refused).toBe('payment_source_fact_unsupported');
        expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('PENDING');
        expect(yield* countRows('observations')).toBe(0);
      }),
    ),
  );

  it.live(
    '#1152 ERP owns the exact accounting receipt: accepted as qualified evidence, Symmy transport is not proof',
    () =>
      Effect.scoped(
        Effect.gen(function* erpReceipt() {
          const { countRows, database, scope } = yield* nativeDatabase;
          yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
          const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
          const collect = yield* startCollect(database, scope, payment);

          const symmy = yield* failureCodeOf(
            accept(database, scope, bankReceipt(payment.paymentId, { source: { ...erpBank, sourceSystem: 'symmy' } })),
          );
          expect(symmy).toBe('payment_source_authority_forbidden');
          expect(yield* countRows('observations')).toBe(0);

          const accepted = yield* accept(database, scope, bankReceipt(payment.paymentId));
          expect(accepted.result.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
          expect(accepted.result.interpretation).toBe('TRANSITION');
          expect(accepted.result.operationId).toBe(collect.operationId);
          expect(accepted.result.outcomeChange).toEqual({
            from: 'PENDING',
            operationId: collect.operationId,
            to: 'EFFECT_CONFIRMED',
          });
          expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('EFFECT_CONFIRMED');
          expect(accepted.evidence.domainEvents.map((event) => event.eventType)).toEqual([
            'payment.core.operation-outcome-changed.v1',
          ]);
          expect(accepted.evidence.outboxMessages).toHaveLength(1);
          expect(accepted.evidence.outboxMessages[0]?.message.topic).toBe('payment.core.operation-outcome-changed.v1');
        }),
      ),
  );

  it.live('#1152 Unauthorized manual mark paid: a method without a configured local source changes nothing', () =>
    Effect.scoped(
      Effect.gen(function* unauthorizedMarkPaid() {
        const { countRows, database, scope } = yield* nativeDatabase;
        const payment = yield* createPayment(database, scope, 'PAY_ON_PICKUP_OR_ON_SITE', pickupBinding);
        const collect = yield* startCollect(database, scope, payment);
        const posEvidence = {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          evidenceRef: 'pos-receipt-881',
          factFamily: 'LOCAL_POS_COLLECTION',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: payment.paymentId,
          pickupCapabilityRef: 'pickup-prague-1',
          reason: 'Customer paid at the pickup counter',
          source: storePos,
          sourceOccurrenceId: 'pos-receipt-881',
          sourceRevision: 1,
        } as const;
        expect(yield* failureCodeOf(recordLocal(database, scope, posEvidence))).toBe(
          'payment_source_authority_forbidden',
        );
        // Operator evidence cannot be smuggled through the integration Action even once configured.
        yield* configure(database, scope, authorityFor(storePos, 'LOCAL_POS_COLLECTION', 'PAY_ON_PICKUP_OR_ON_SITE'));
        const { evidenceRef: _evidenceRef, reason: _reason, ...asIngress } = posEvidence;
        expect(yield* failureCodeOf(accept(database, scope, asIngress))).toBe('payment_source_authority_forbidden');
        const before = yield* aggregateOf(database, scope, payment.paymentId);
        expect(before.payment.coverageRevision).toBe(payment.coverageRevision);
        expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('PENDING');
        expect(yield* countRows('observations')).toBe(0);

        // With the configured local source, the permitted operator records exact governed evidence.
        const recorded = yield* recordLocal(database, scope, posEvidence);
        expect(recorded.result.interpretation).toBe('TRANSITION');
        expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('EFFECT_CONFIRMED');
      }),
    ),
  );

  it.live(
    '#1152 A receipt belongs to another account or tenant: same amount and reference never mutate the target',
    () =>
      Effect.scoped(
        Effect.gen(function* foreignReceipt() {
          const { admin, countRows, database, scope } = yield* nativeDatabase;
          yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
          const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
          const collect = yield* startCollect(database, scope, payment);
          for (const source of [
            { ...erpBank, accountRef: 'CZ0000000000000000000001' },
            { ...erpBank, environment: 'sandbox' },
          ]) {
            expect(yield* failureCodeOf(accept(database, scope, bankReceipt(payment.paymentId, { source })))).toBe(
              'payment_source_authority_forbidden',
            );
          }
          // Same amount and variable symbol, no exact Payment identity: unassigned held debt only.
          const { paymentId: _paymentId, ...withoutPayment } = bankReceipt(payment.paymentId, {
            sourceOccurrenceId: 'bank-line-vs-20261108',
          });
          const uncorrelated = yield* accept(database, scope, withoutPayment);
          expect(uncorrelated.result.acceptanceOutcome).toBe('HELD_UNRESOLVED');
          expect(uncorrelated.result.paymentId).toBeUndefined();

          // A foreign Tenant/Selling Legal Entity with its own valid authority names this Payment.
          const foreign = yield* makeTestScope;
          yield* configure(
            database,
            foreign,
            authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'),
          );
          const foreignResult = yield* accept(database, foreign, bankReceipt(payment.paymentId));
          expect(foreignResult.result.acceptanceOutcome).toBe('HELD_UNRESOLVED');
          expect(foreignResult.result.paymentId).toBeUndefined();
          const [foreignRow] = yield* admin.unsafe<{ payment_id: string | null }>(
            'select payment_id from payment.observations where observation_id = $1',
            [foreignResult.result.observationId],
          );
          expect(foreignRow?.payment_id).toBeNull();

          const after = yield* aggregateOf(database, scope, payment.paymentId);
          expect(after.payment.coverageRevision).toBe(payment.coverageRevision);
          expect(after.openReconciliationCaseCount).toBe(0);
          expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('PENDING');
          expect(yield* countRows('observations')).toBe(1);
        }),
      ),
  );

  it.live(
    '#1152 COD collection precedes remittance: collection recorded, remittance stays a separate unproven fact',
    () =>
      Effect.scoped(
        Effect.gen(function* codBeforeRemittance() {
          const { admin, database, scope } = yield* nativeDatabase;
          yield* configure(database, scope, authorityFor(pplCarrier, 'COD_CUSTOMER_COLLECTION', 'CASH_ON_DELIVERY'));
          yield* configure(database, scope, authorityFor(erpBank, 'COD_REMITTANCE', 'CASH_ON_DELIVERY'));
          const payment = yield* createPayment(database, scope, 'CASH_ON_DELIVERY', codBinding);
          const collect = yield* startCollect(database, scope, payment);
          const collected = yield* accept(database, scope, {
            amount: { amountMinor: 100_000, currency: 'CZK' },
            deliveryOfferRef: 'ppl-delivery-offer-1',
            factFamily: 'COD_CUSTOMER_COLLECTION',
            factKind: 'COLLECTION_CONFIRMED',
            paymentId: payment.paymentId,
            source: pplCarrier,
            sourceOccurrenceId: 'ppl-shipment-1-cod-collected',
            sourceRevision: 1,
          });
          expect(collected.result.interpretation).toBe('TRANSITION');
          expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('EFFECT_CONFIRMED');
          const settlements = admin
            .unsafe<{ count: number }>(
              "select count(*)::integer as count from payment.observations where payment_id = $1 and fact_kind = 'SETTLEMENT_OBSERVED'",
              [payment.paymentId],
            )
            .pipe(Effect.map((rows) => rows[0]?.count));
          expect(yield* settlements).toBe(0);

          const remitted = yield* accept(database, scope, {
            amount: { amountMinor: 98_500, currency: 'CZK' },
            factFamily: 'COD_REMITTANCE',
            factKind: 'SETTLEMENT_OBSERVED',
            paymentId: payment.paymentId,
            source: erpBank,
            sourceOccurrenceId: 'bank-line-ppl-remittance-7',
            sourceRevision: 1,
          });
          expect(remitted.result.interpretation).toBe('NO_CHANGE');
          expect(remitted.evidence.domainEvents).toEqual([]);
          expect(yield* settlements).toBe(1);
          expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('EFFECT_CONFIRMED');
        }),
      ),
  );

  it.live('#1152 Delivery does not prove collection: a DELIVERED signal is never promoted', () =>
    Effect.scoped(
      Effect.gen(function* deliveredIsNotCollected() {
        const { countRows, database, scope } = yield* nativeDatabase;
        // The carrier contract here only proves remittance, not customer collection.
        yield* configure(database, scope, authorityFor(pplCarrier, 'COD_REMITTANCE', 'CASH_ON_DELIVERY'));
        const payment = yield* createPayment(database, scope, 'CASH_ON_DELIVERY', codBinding);
        const collect = yield* startCollect(database, scope, payment);
        const delivered = {
          deliveryOfferRef: 'ppl-delivery-offer-1',
          factFamily: 'COD_CUSTOMER_COLLECTION',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: payment.paymentId,
          source: pplCarrier,
          sourceOccurrenceId: 'ppl-shipment-1-delivered',
          sourceRevision: 1,
        } as const;
        expect(yield* failureCodeOf(accept(database, scope, delivered))).toBe('payment_source_authority_forbidden');
        yield* configure(database, scope, authorityFor(pplCarrier, 'COD_CUSTOMER_COLLECTION', 'CASH_ON_DELIVERY'));
        expect(yield* failureCodeOf(accept(database, scope, { ...delivered, factKind: 'UNRECOGNIZED' }))).toBe(
          'payment_source_fact_unsupported',
        );
        expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('PENDING');
        expect(yield* countRows('observations')).toBe(0);
      }),
    ),
  );

  it.live(
    '#1152 Accounting corrects a mistaken receipt: audit stays, coverage is reconciled, no money return is invented',
    () =>
      Effect.scoped(
        Effect.gen(function* accountingCorrection() {
          const { admin, database, scope } = yield* nativeDatabase;
          yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
          const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
          const collect = yield* startCollect(database, scope, payment);
          const receipt = yield* accept(database, scope, bankReceipt(payment.paymentId));
          const confirmed = yield* aggregateOf(database, scope, payment.paymentId);

          const correction = yield* accept(database, scope, {
            amount: { amountMinor: 100_000, currency: 'CZK' },
            correctsObservationId: receipt.result.observationId,
            factFamily: 'BANK_ACCOUNTING_RECEIPT',
            factKind: 'SOURCE_CORRECTION',
            paymentId: payment.paymentId,
            source: erpBank,
            sourceOccurrenceId: 'bank-line-2026-11-08-17-storno',
            sourceRevision: 1,
          });
          expect(correction.result.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
          expect(correction.result.interpretation).toBe('CORRECTION');
          expect(correction.result.reconciliationCaseId).toBeDefined();
          const corrected = yield* aggregateOf(database, scope, payment.paymentId);
          expect(corrected.operations.map((operation) => [operation.kind, operation.outcome])).toEqual([
            ['COLLECT', 'CONFLICT'],
          ]);
          expect(corrected.payment.coverageRevision).toBeGreaterThan(confirmed.payment.coverageRevision);
          expect(corrected.openReconciliationCaseCount).toBe(1);
          const [original] = yield* admin.unsafe<{ acceptance_outcome: string; fact_kind: string }>(
            'select acceptance_outcome, fact_kind from payment.observations where observation_id = $1',
            [receipt.result.observationId],
          );
          expect(original).toEqual({ acceptance_outcome: 'ACCEPTED_OBSERVATION', fact_kind: 'COLLECTION_CONFIRMED' });
          expect(collect.operationId).toBe(corrected.operations[0]?.operationId);
          // The correction keeps its exact claimed amount and effect as evidence; reopening the receipt to
          // CONFLICT holds the funds instead of also deducting the claimed amount from coverage.
          const [storedCorrection] = yield* admin.unsafe<{ amount_minor: number; correction_effect: string }>(
            'select amount_minor::integer as amount_minor, correction_effect from payment.observations where observation_id = $1',
            [correction.result.observationId],
          );
          expect(storedCorrection).toEqual({ amount_minor: 100_000, correction_effect: 'REOPEN_TO_CONFLICT' });
          expect(corrected.collectionCorrections).toEqual([]);
        }),
      ),
  );

  it.live(
    '#1152 source correction versus actual reversal: a partial correction reduces coverage, a real refund is separate',
    () =>
      Effect.scoped(
        Effect.gen(function* correctionVersusRefund() {
          const { database, scope } = yield* nativeDatabase;
          yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
          yield* configure(database, scope, authorityFor(erpBank, 'REFUND_EXECUTION', 'BANK_TRANSFER_ADVANCE', true));
          const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
          const collect = yield* startCollect(database, scope, payment);
          const receipt = yield* accept(database, scope, bankReceipt(payment.paymentId));
          const partial = yield* accept(database, scope, {
            amount: { amountMinor: 40_000, currency: 'CZK' },
            correctsObservationId: receipt.result.observationId,
            factFamily: 'BANK_ACCOUNTING_RECEIPT',
            factKind: 'SOURCE_CORRECTION',
            paymentId: payment.paymentId,
            source: erpBank,
            sourceOccurrenceId: 'bank-line-17-partial-correction',
            sourceRevision: 1,
          });
          expect(partial.result.interpretation).toBe('CORRECTION');
          const reduced = yield* aggregateOf(database, scope, payment.paymentId);
          expect(reduced.collectionCorrections).toEqual([{ amountMinor: 40_000, currency: 'CZK' }]);
          expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('EFFECT_CONFIRMED');

          const refund = yield* startRefund(database, scope, payment, collect.operationId);
          const returned = yield* accept(database, scope, {
            amount: { amountMinor: 100_000, currency: 'CZK' },
            factFamily: 'REFUND_EXECUTION',
            factKind: 'REFUND_CONFIRMED',
            operationId: refund.operationId,
            paymentId: payment.paymentId,
            source: erpBank,
            sourceOccurrenceId: 'bank-outgoing-line-3',
            sourceRevision: 1,
          });
          expect(returned.result.interpretation).toBe('TRANSITION');
          const after = yield* aggregateOf(database, scope, payment.paymentId);
          expect(after.operations.map((operation) => [operation.kind, operation.outcome])).toEqual([
            ['COLLECT', 'EFFECT_CONFIRMED'],
            ['REFUND', 'EFFECT_CONFIRMED'],
          ]);
          expect(after.collectionCorrections).toEqual([{ amountMinor: 40_000, currency: 'CZK' }]);
        }),
      ),
  );

  it.live('#1152 COD funds are refunded by the merchant: bank route proves the refund, duplicates count once', () =>
    Effect.scoped(
      Effect.gen(function* codMerchantRefund() {
        const { countRows, database, scope } = yield* nativeDatabase;
        yield* configure(database, scope, authorityFor(pplCarrier, 'COD_CUSTOMER_COLLECTION', 'CASH_ON_DELIVERY'));
        const carrierRefund = yield* failureCodeOf(
          configure(database, scope, authorityFor(pplCarrier, 'REFUND_EXECUTION', 'CASH_ON_DELIVERY', true)),
        );
        expect(carrierRefund).toBe('payment_source_configuration_invalid');
        yield* configure(database, scope, authorityFor(erpBank, 'REFUND_EXECUTION', 'CASH_ON_DELIVERY', true));
        const payment = yield* createPayment(database, scope, 'CASH_ON_DELIVERY', codBinding);
        const collect = yield* startCollect(database, scope, payment);
        yield* accept(database, scope, {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          deliveryOfferRef: 'ppl-delivery-offer-1',
          factFamily: 'COD_CUSTOMER_COLLECTION',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: payment.paymentId,
          source: pplCarrier,
          sourceOccurrenceId: 'ppl-shipment-1-cod-collected',
          sourceRevision: 1,
        });
        const refund = yield* startRefund(database, scope, payment, collect.operationId);
        const carrierClaim = yield* failureCodeOf(
          accept(database, scope, {
            amount: { amountMinor: 100_000, currency: 'CZK' },
            deliveryOfferRef: 'ppl-delivery-offer-1',
            factFamily: 'REFUND_EXECUTION',
            factKind: 'REFUND_CONFIRMED',
            operationId: refund.operationId,
            paymentId: payment.paymentId,
            source: pplCarrier,
            sourceOccurrenceId: 'ppl-shipment-1-refund',
            sourceRevision: 1,
          }),
        );
        expect(carrierClaim).toBe('payment_source_authority_forbidden');

        const bankRefund = {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          economicEffectKey: 'bank-transfer-ref-551',
          factFamily: 'REFUND_EXECUTION',
          factKind: 'REFUND_CONFIRMED',
          operationId: refund.operationId,
          paymentId: payment.paymentId,
          source: erpBank,
          sourceOccurrenceId: 'bank-outgoing-line-551',
          sourceRevision: 1,
        } as const;
        const proven = yield* accept(database, scope, bankRefund);
        expect(proven.result.interpretation).toBe('TRANSITION');
        const redelivered = yield* accept(database, scope, bankRefund);
        expect(redelivered.result.acceptanceOutcome).toBe('DUPLICATE');
        expect(redelivered.result.duplicateOfOutcome).toBe('ACCEPTED_OBSERVATION');
        expect(redelivered.result.observationId).toBe(proven.result.observationId);
        expect(redelivered.evidence.domainEvents).toEqual([]);
        const corroborating = yield* accept(database, scope, {
          ...bankRefund,
          sourceOccurrenceId: 'bank-statement-2026-11-09-line-4',
        });
        expect(corroborating.result.interpretation).toBe('NO_CHANGE');
        const after = yield* aggregateOf(database, scope, payment.paymentId);
        expect(after.operations.map((operation) => [operation.kind, operation.outcome])).toEqual([
          ['COLLECT', 'EFFECT_CONFIRMED'],
          ['REFUND', 'EFFECT_CONFIRMED'],
        ]);
        expect(after.activeClaims.map((claim) => claim.itemRef)).toEqual(['order-item-1']);
        // CREATION x2 + collection confirmation + one refund confirmation: the same effect counted once.
        expect(yield* countRows('operation_outcome_transitions')).toBe(4);
      }),
    ),
  );

  it.live('#1152 Manual route lacks refund-effect proof: an operator assertion never confirms the refund', () =>
    Effect.scoped(
      Effect.gen(function* manualRefundRoute() {
        const { database, scope } = yield* nativeDatabase;
        yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
        yield* configure(
          database,
          scope,
          authorityFor(treasuryDesk, 'REFUND_EXECUTION', 'BANK_TRANSFER_ADVANCE', true),
        );
        const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
        const collect = yield* startCollect(database, scope, payment);
        yield* accept(database, scope, bankReceipt(payment.paymentId));
        const refund = yield* startRefund(database, scope, payment, collect.operationId);
        const manual = {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          evidenceRef: 'treasury-transfer-order-12',
          factFamily: 'REFUND_EXECUTION',
          factKind: 'REFUND_PENDING',
          operationId: refund.operationId,
          paymentId: payment.paymentId,
          reason: 'Manual transfer ordered from the merchant account',
          source: treasuryDesk,
          sourceOccurrenceId: 'treasury-order-12',
          sourceRevision: 1,
        } as const;
        const requested = yield* recordLocal(database, scope, manual);
        expect(requested.result.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        const asserted = yield* failureCodeOf(
          recordLocal(database, scope, {
            ...manual,
            factKind: 'REFUND_CONFIRMED',
            sourceOccurrenceId: 'treasury-12-done',
          }),
        );
        expect(asserted).toBe('payment_source_fact_unsupported');
        expect(yield* outcomeOf(database, scope, payment.paymentId, refund.operationId)).toBe('PENDING');
      }),
    ),
  );

  it.live('#1152 Late bank evidence under a compatible runtime: R2 provenance recorded, R1 lineage untouched', () =>
    Effect.scoped(
      Effect.gen(function* lateEvidence() {
        const { admin, database, scope } = yield* nativeDatabase;
        yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
        const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
        const collect = yield* startCollect(database, scope, payment);
        expect(collect.provenance.compositionRevision).toBe(COMPOSITION_REVISION);
        const late = yield* accept(database, scope, bankReceipt(payment.paymentId), R2);
        const [observation] = yield* admin.unsafe<{ action_invocation_id: string; composition_revision: string }>(
          'select action_invocation_id, composition_revision from payment.observations where observation_id = $1',
          [late.result.observationId],
        );
        expect(observation).toEqual({ action_invocation_id: late.invocationId, composition_revision: R2 });
        const transitions = yield* admin.unsafe<{ composition_revision: string; to_outcome: string }>(
          'select composition_revision, to_outcome from payment.operation_outcome_transitions where operation_id = $1 order by outcome_revision',
          [collect.operationId],
        );
        expect(transitions).toEqual([
          { composition_revision: COMPOSITION_REVISION, to_outcome: 'PENDING' },
          { composition_revision: R2, to_outcome: 'EFFECT_CONFIRMED' },
        ]);
        const [operation] = yield* admin.unsafe<{ composition_revision: string }>(
          'select composition_revision from payment.payment_operations where operation_id = $1',
          [collect.operationId],
        );
        expect(operation?.composition_revision).toBe(COMPOSITION_REVISION);
        expect(late.evidence.domainEvents[0]?.payloadJson).toMatchObject({
          cause: { _tag: 'OBSERVATION', observationId: late.result.observationId },
          originalActionInvocationId: collect.provenance.actionInvocationId,
          originalCompositionRevision: COMPOSITION_REVISION,
          provenance: { actionInvocationId: late.invocationId, compositionRevision: R2 },
        });
      }),
    ),
  );

  it.live('#1152 duplicate source occurrences and revisions: replay is idempotent, changed content conflicts', () =>
    Effect.scoped(
      Effect.gen(function* duplicates() {
        const { countRows, database, scope } = yield* nativeDatabase;
        yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
        const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
        yield* startCollect(database, scope, payment);
        const first = yield* accept(database, scope, bankReceipt(payment.paymentId));
        const again = yield* accept(database, scope, bankReceipt(payment.paymentId));
        expect(again.result.acceptanceOutcome).toBe('DUPLICATE');
        expect(again.result.observationId).toBe(first.result.observationId);
        const changed = yield* failureCodeOf(
          accept(database, scope, bankReceipt(payment.paymentId, { amount: { amountMinor: 99_000, currency: 'CZK' } })),
        );
        expect(changed).toBe('payment_source_occurrence_conflict');
        const revised = yield* accept(database, scope, bankReceipt(payment.paymentId, { sourceRevision: 2 }));
        expect(revised.result.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        expect(revised.result.interpretation).toBe('NO_CHANGE');
        expect(yield* countRows('observations')).toBe(2);
        expect(yield* countRows('operation_outcome_transitions')).toBe(2);
      }),
    ),
  );

  it.live('#1152 contradictory observations: later non-collection evidence makes the operation CONFLICT debt', () =>
    Effect.scoped(
      Effect.gen(function* contradictory() {
        const { database, scope } = yield* nativeDatabase;
        yield* configure(database, scope, authorityFor(pplCarrier, 'COD_CUSTOMER_COLLECTION', 'CASH_ON_DELIVERY'));
        const payment = yield* createPayment(database, scope, 'CASH_ON_DELIVERY', codBinding);
        const collect = yield* startCollect(database, scope, payment);
        const collected = {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          deliveryOfferRef: 'ppl-delivery-offer-1',
          factFamily: 'COD_CUSTOMER_COLLECTION',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: payment.paymentId,
          source: pplCarrier,
          sourceOccurrenceId: 'ppl-shipment-1-cod-collected',
          sourceRevision: 1,
        } as const;
        yield* accept(database, scope, collected);
        const contradiction = yield* accept(database, scope, {
          ...collected,
          factKind: 'COLLECTION_NOT_EFFECTED',
          sourceOccurrenceId: 'ppl-shipment-1-refused',
        });
        expect(contradiction.result.acceptanceOutcome).toBe('CONFLICT');
        expect(contradiction.result.outcomeChange).toEqual({
          from: 'EFFECT_CONFIRMED',
          operationId: collect.operationId,
          to: 'CONFLICT',
        });
        const after = yield* aggregateOf(database, scope, payment.paymentId);
        expect(after.openReconciliationCaseCount).toBe(1);
        expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('CONFLICT');
      }),
    ),
  );

  it.live(
    '#1152 exact amount/currency mismatch: amount contradiction is held conflict, a foreign currency is refused',
    () =>
      Effect.scoped(
        Effect.gen(function* amountMismatch() {
          const { countRows, database, scope } = yield* nativeDatabase;
          yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
          const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
          const collect = yield* startCollect(database, scope, payment);
          const foreignCurrency = yield* failureCodeOf(
            accept(database, scope, bankReceipt(payment.paymentId, { amount: { amountMinor: 4000, currency: 'EUR' } })),
          );
          expect(foreignCurrency).toBe('payment_source_currency_mismatch');
          expect(yield* countRows('observations')).toBe(0);
          const short = yield* accept(
            database,
            scope,
            bankReceipt(payment.paymentId, { amount: { amountMinor: 90_000, currency: 'CZK' } }),
          );
          expect(short.result.acceptanceOutcome).toBe('CONFLICT');
          expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).not.toBe(
            'EFFECT_CONFIRMED',
          );
          const after = yield* aggregateOf(database, scope, payment.paymentId);
          expect(after.openReconciliationCaseCount).toBe(1);
        }),
      ),
  );

  it.live('#1152 independent-method availability: a revoked bank authority does not block COD carrier evidence', () =>
    Effect.scoped(
      Effect.gen(function* independentMethods() {
        const { database, scope } = yield* nativeDatabase;
        const bank = yield* configure(
          database,
          scope,
          authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'),
        );
        yield* configure(database, scope, authorityFor(pplCarrier, 'COD_CUSTOMER_COLLECTION', 'CASH_ON_DELIVERY'));
        const revoked = yield* configure(database, scope, {
          ...authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'),
          expectedRevision: bank.revision,
          reason: 'Bank feed retired',
          status: 'REVOKED',
        });
        expect([revoked.changed, revoked.revision, revoked.status]).toEqual([true, 2, 'REVOKED']);
        const bankPayment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
        yield* startCollect(database, scope, bankPayment);
        expect(yield* failureCodeOf(accept(database, scope, bankReceipt(bankPayment.paymentId)))).toBe(
          'payment_source_authority_forbidden',
        );
        const codPayment = yield* createPayment(database, scope, 'CASH_ON_DELIVERY', codBinding);
        const codCollect = yield* startCollect(database, scope, codPayment);
        yield* accept(database, scope, {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          deliveryOfferRef: 'ppl-delivery-offer-1',
          factFamily: 'COD_CUSTOMER_COLLECTION',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: codPayment.paymentId,
          source: pplCarrier,
          sourceOccurrenceId: 'ppl-shipment-9-cod-collected',
          sourceRevision: 1,
        });
        expect(yield* outcomeOf(database, scope, codPayment.paymentId, codCollect.operationId)).toBe(
          'EFFECT_CONFIRMED',
        );
      }),
    ),
  );

  it.live('#1152 source authority configuration is revisioned, idempotent and fenced', () =>
    Effect.scoped(
      Effect.gen(function* configuration() {
        const { admin, database, scope } = yield* nativeDatabase;
        const payload = authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE');
        const created = yield* configure(database, scope, payload);
        expect([created.changed, created.revision]).toEqual([true, 1]);
        const unchanged = yield* configure(database, scope, payload);
        expect([unchanged.changed, unchanged.revision, unchanged.sourceAuthorityId]).toEqual([
          false,
          1,
          created.sourceAuthorityId,
        ]);
        const fenced = yield* failureCodeOf(
          configure(database, scope, { ...payload, expectedRevision: 7, status: 'REVOKED' }),
        );
        expect(fenced).toBe('payment_source_authority_revision_conflict');
        const history = yield* admin.unsafe<{ revision: number; status: string }>(
          'select revision, status from payment.source_authority_revisions where source_authority_id = $1 order by revision',
          [created.sourceAuthorityId],
        );
        expect(history).toEqual([{ revision: 1, status: 'ACTIVE' }]);
      }),
    ),
  );
});

describe('#1151 source ingress concurrency on native PostgreSQL', () => {
  it.live('#1151 Duplicate and corroborating observations describe one effect: concurrent redelivery serializes', () =>
    Effect.scoped(
      Effect.gen(function* concurrentRedelivery() {
        const { admin, countRows, database, scope } = yield* nativeDatabase;
        yield* configure(database, scope, authorityFor(erpBank, 'BANK_ACCOUNTING_RECEIPT', 'BANK_TRANSFER_ADVANCE'));
        const payment = yield* createPayment(database, scope, 'BANK_TRANSFER_ADVANCE', bankBinding);
        const collect = yield* startCollect(database, scope, payment);
        const locked = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const payload = yield* Schema.decodeUnknownEffect(AcceptPaymentObservationPayloadSchema)(
          bankReceipt(payment.paymentId),
        );

        // Delivery A takes the source authority lock (as the Action does first) and holds it.
        const first = yield* inActionTransaction(database, scope, COMPOSITION_REVISION, (services, base) =>
          Effect.gen(function* acceptWhileHolding() {
            yield* services.source.lockAuthorities({ factFamily: 'BANK_ACCOUNTING_RECEIPT', source: erpBank });
            yield* Deferred.succeed(locked, true);
            yield* Deferred.await(release);
            const { descriptor } = acceptPaymentObservationAction;
            const collector = createActionCollector(
              descriptor.domainEvents,
              'payment.core',
              descriptor.accessEvidencePolicy,
              descriptor.auditEvidenceSchema,
            );
            return yield* handleAcceptPaymentObservation(payload, { ...base, ...collector, services });
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(locked);

        // Delivery B of the identical occurrence races through the real handler.
        const second = yield* accept(database, scope, bankReceipt(payment.paymentId)).pipe(Effect.forkChild);
        const waitingOnLocks = admin
          .unsafe<{ waiting: number }>(
            `select count(*)::integer as waiting from pg_catalog.pg_stat_activity
             where datname = current_database() and cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
               and wait_event_type = 'Lock'`,
          )
          .pipe(Effect.map((rows) => rows[0]?.waiting ?? 0));
        const awaitBlockedWaiter = (
          remainingChecks: number,
        ): Effect.Effect<number, Effect.Error<typeof waitingOnLocks>> =>
          waitingOnLocks.pipe(
            Effect.flatMap((waiting) =>
              waiting > 0 || remainingChecks === 0
                ? Effect.succeed(waiting)
                : Effect.suspend(() => awaitBlockedWaiter(remainingChecks - 1)),
            ),
          );
        expect(yield* awaitBlockedWaiter(5000)).toBeGreaterThan(0);
        yield* Deferred.succeed(release, true);

        const winner = yield* Fiber.join(first);
        const loser = yield* Fiber.join(second);
        expect(winner.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        expect(loser.result.acceptanceOutcome).toBe('DUPLICATE');
        expect(loser.result.observationId).toBe(winner.observationId);
        expect(loser.evidence.outboxMessages).toEqual([]);
        expect(yield* outcomeOf(database, scope, payment.paymentId, collect.operationId)).toBe('EFFECT_CONFIRMED');
        expect(yield* countRows('observations')).toBe(1);
        expect(yield* countRows('operation_outcome_transitions')).toBe(2);
      }),
    ),
  );
});
