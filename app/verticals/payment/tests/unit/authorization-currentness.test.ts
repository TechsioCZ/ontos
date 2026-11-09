import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { DateTime, Duration, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { IssuePaymentAuthorizationPayloadSchema } from '../../shared/actions/issue-payment-authorization.ts';
import {
  PaymentAuthorizationCodDeliveryOfferSchema,
  PaymentAuthorizationDeferredNetDaysSchema,
  PaymentAuthorizationPickupCapabilitySchema,
  PaymentAuthorizationPrepaidCollectionSchema,
  PaymentAuthorizationZeroPayableSchema,
} from '../../shared/domain/authorization-proof.ts';
import type {
  PaymentAuthorizationBinding,
  PaymentAuthorizationCondition,
} from '../../shared/domain/authorization-proof.ts';
import type { PaymentPurchasingContext } from '../../shared/domain/applicability-purchasing-context.ts';
import type { PaymentCodCarrier } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentOperationKind, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import {
  attemptMismatchReasons,
  MethodConditionCheck,
  methodConditionReasons,
  prepaidCurrentnessReasons,
  proofKindForMethod,
  proofValidity,
  proofValidityDuration,
  requirePrepaidCoverage,
  subjectMismatchReasons,
  validityWindowReasons,
} from '../../src/domain/authorization-currentness.ts';
import {
  codDeliveryCondition,
  deferredTermCondition,
  pickupCondition,
  verifyMethodCondition,
} from '../../src/domain/authorization-method-condition.ts';
import type { PaymentMethodConditionSubject } from '../../src/domain/authorization-method-condition.ts';
import type { PaymentFundsOperation, PaymentFundsSnapshot } from '../../src/domain/coverage.ts';
import { DeliveryCapabilityPort } from '../../src/ports/delivery-capability-port.ts';
import { PaymentTermEvidencePort } from '../../src/ports/payment-term-evidence-port.ts';
import type { PaymentTermPurchase } from '../../src/ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort } from '../../src/ports/pickup-capability-port.ts';

const czk = (amountMinor: number): PaymentMonetaryAmount => ({ amountMinor, currency: 'CZK' });
const tenantId = '11111111-1111-4111-8111-111111111111';
const termRef = (resourceId: string): PaymentTermRef => ({
  moduleId: 'payment.term-catalog',
  resourceId,
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
});
const TERM_A = termRef('22222222-2222-4222-8222-222222222222');
const TERM_B = termRef('33333333-3333-4333-8333-333333333333');
const COLLECT_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_COLLECT_ID = '99999999-9999-4999-8999-999999999999';
const REFUND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T = DateTime.makeUnsafe('2026-11-09T10:00:00.000Z');
const at = (iso: string) => DateTime.makeUnsafe(iso);

const binding: PaymentAuthorizationBinding = {
  amount: czk(100_000),
  executionBinding: {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'production',
    providerAccountRef: 'acc-1',
    providerFamily: 'GOPAY',
  },
  method: 'ONLINE_GATEWAY',
  orderCommitmentAttemptId: 'attempt-1',
  orderCommitmentTime: T,
  paymentId: '44444444-4444-4444-8444-444444444444',
  paymentTermRef: TERM_A,
  purchaseCorrelationId: 'purchase-1',
};

const snapshotOf = (
  paymentTermRef: PaymentTermRef,
  semantics: { readonly days?: number; readonly kind: 'IMMEDIATE' | 'NET_DAYS' },
  semanticFingerprint = 'a'.repeat(64),
): PaymentTermDefinitionSnapshot =>
  Schema.decodeUnknownSync(PaymentTermDefinitionSnapshotSchema)({
    code: semantics.kind,
    compatibilityId: 'compat.v2',
    definitionRevisionId: '55555555-5555-4555-8555-555555555555',
    lifecycle: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
    metadataRevision: 1,
    name: semantics.kind,
    paymentTermRef,
    semanticFingerprint,
    semanticRevisionId: '66666666-6666-4666-8666-666666666666',
    semantics:
      semantics.kind === 'NET_DAYS'
        ? {
            calculationRuleVersion: 2,
            calendarRule: 'CALENDAR_DAYS',
            days: semantics.days ?? 14,
            dueDateAnchor: 'INVOICE_ISSUE_DATE',
            kind: 'NET_DAYS',
          }
        : { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
  });

const operation = (
  operationId: string,
  kind: PaymentOperationKind,
  outcome: PaymentOperationOutcome,
  amountMinor: number,
  targetOperationId?: string,
): PaymentFundsOperation => ({ amount: czk(amountMinor), kind, operationId, outcome, targetOperationId });
const funds = (
  operations: readonly PaymentFundsOperation[],
  overrides: Partial<Omit<PaymentFundsSnapshot, 'operations'>> = {},
): PaymentFundsSnapshot => ({
  collectionCorrections: [],
  operations,
  required: czk(1000),
  unresolvedEvidence: false,
  ...overrides,
});
const confirmedCollect = operation(COLLECT_ID, 'COLLECT', 'EFFECT_CONFIRMED', 1000);
const prepaid: PaymentAuthorizationCondition = {
  _tag: 'PREPAID_COLLECTION',
  collectOperationId: COLLECT_ID,
  covered: czk(1000),
};
const codeOf = <A, E extends { readonly code: string }>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((failure) => failure.code));

describe('#1149 Payment Authorization proof kind', () => {
  it('#1149 prepaid methods need coverage; deferred, COD and pickup prove a method condition', () => {
    expect(proofKindForMethod('ONLINE_GATEWAY')).toBe('PREPAID_COVERAGE');
    expect(proofKindForMethod('BANK_TRANSFER_ADVANCE')).toBe('PREPAID_COVERAGE');
    expect(proofKindForMethod('DEFERRED_INVOICE')).toBe('METHOD_CONDITION');
    expect(proofKindForMethod('CASH_ON_DELIVERY')).toBe('METHOD_CONDITION');
    expect(proofKindForMethod('PAY_ON_PICKUP_OR_ON_SITE')).toBe('METHOD_CONDITION');
  });
});

describe('#1149 exact Attempt and Payment binding', () => {
  it('#1149 an exact binding has no mismatch', () => {
    expect(attemptMismatchReasons(binding, binding)).toEqual([]);
  });
  it('#1149 every material difference is reported', () => {
    expect(
      attemptMismatchReasons(binding, {
        amount: czk(99_999),
        executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
        method: 'BANK_TRANSFER_ADVANCE',
        orderCommitmentAttemptId: 'attempt-2',
        orderCommitmentTime: at('2026-11-09T09:59:59.000Z'),
        paymentId: '77777777-7777-4777-8777-777777777777',
        paymentTermRef: TERM_B,
        purchaseCorrelationId: 'purchase-2',
      }),
    ).toEqual([
      'ATTEMPT_MISMATCH',
      'COMMITMENT_TIME_MISMATCH',
      'PAYMENT_MISMATCH',
      'PURCHASE_MISMATCH',
      'AMOUNT_MISMATCH',
      'METHOD_MISMATCH',
      'TERM_MISMATCH',
      'BINDING_MISMATCH',
    ]);
  });
  it('#1149 the Payment meaning comparison ignores Attempt identity and T', () => {
    expect(subjectMismatchReasons(binding, { ...binding, orderCommitmentAttemptId: 'other' })).toEqual([]);
    expect(
      subjectMismatchReasons(binding, {
        ...binding,
        executionBinding: {
          _tag: 'GATEWAY_ACCOUNT',
          environment: 'production',
          providerAccountRef: 'acc-2',
          providerFamily: 'GOPAY',
        },
      }),
    ).toEqual(['BINDING_MISMATCH']);
  });
});

describe('#1149 actual time versus frozen business T', () => {
  const issued = proofValidity(at('2026-11-09T10:00:02.000Z'), Duration.seconds(60));
  it('#1149 the window starts at the actual issuance instant, not at T', () => {
    expect(DateTime.formatIso(issued.issuedAt)).toBe('2026-11-09T10:00:02.000Z');
    expect(DateTime.formatIso(issued.expiresAt)).toBe('2026-11-09T10:01:02.000Z');
    expect(Duration.toMillis(proofValidityDuration(issued))).toBe(60_000);
  });
  it('#1149 use at 10:00:03 after T 10:00:00 and issuance 10:00:02 is inside the window', () => {
    expect(validityWindowReasons(issued, at('2026-11-09T10:00:03.000Z'))).toEqual([]);
    expect(validityWindowReasons(issued, issued.issuedAt)).toEqual([]);
  });
  it('#1149 checking against old T would be before issuance: NOT_YET_VALID, never backdated', () => {
    expect(validityWindowReasons(issued, T)).toEqual(['NOT_YET_VALID']);
  });
  it('#1149 at or after E the proof is expired whatever T says', () => {
    expect(validityWindowReasons(issued, issued.expiresAt)).toEqual(['EXPIRED']);
    expect(validityWindowReasons(issued, at('2026-11-09T11:00:00.000Z'))).toEqual(['EXPIRED']);
  });
  it('#1149 the payload rejects a validity window beyond the owner maximum', () => {
    const encoded = Schema.encodeSync(IssuePaymentAuthorizationPayloadSchema)({
      binding,
      issuanceKey: 'key-1',
      validitySeconds: 900,
    });
    expect(
      Schema.is(IssuePaymentAuthorizationPayloadSchema)(
        Schema.decodeUnknownSync(IssuePaymentAuthorizationPayloadSchema)(encoded),
      ),
    ).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(IssuePaymentAuthorizationPayloadSchema)({ ...encoded, validitySeconds: 901 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(IssuePaymentAuthorizationPayloadSchema)({ ...encoded, validitySeconds: 0 }),
    ).toThrow();
  });
});

describe('#1149 prepaid issuance gate', () => {
  it.effect('#1149 proven unreduced coverage yields a PREPAID_COLLECTION condition', () =>
    Effect.gen(function* covered() {
      const condition = yield* requirePrepaidCoverage(funds([confirmedCollect]));
      expect(Schema.is(PaymentAuthorizationPrepaidCollectionSchema)(condition)).toBe(true);
      expect(condition).toMatchObject({ collectOperationId: COLLECT_ID, covered: czk(1000) });
    }),
  );
  it.effect('#1149 zero payable yields ZERO_PAYABLE without a collection', () =>
    Effect.gen(function* zero() {
      const condition = yield* requirePrepaidCoverage(funds([], { required: czk(0) }));
      expect(Schema.is(PaymentAuthorizationZeroPayableSchema)(condition)).toBe(true);
    }),
  );
  it.effect('#1149 a browser return or live collection is not coverage', () =>
    Effect.gen(function* notCovered() {
      expect(yield* codeOf(requirePrepaidCoverage(funds([])))).toBe('payment_authorization_coverage_insufficient');
      expect(yield* codeOf(requirePrepaidCoverage(funds([operation(COLLECT_ID, 'COLLECT', 'PENDING', 1000)])))).toBe(
        'payment_authorization_coverage_insufficient',
      );
    }),
  );
  it.effect('#1149 pending, indeterminate or confirmed returns refuse a fresh prepaid proof', () =>
    Effect.gen(function* reduced() {
      for (const outcome of ['PENDING', 'INDETERMINATE', 'EFFECT_CONFIRMED'] as const) {
        const refunded = funds([confirmedCollect, operation(REFUND_ID, 'REFUND', outcome, 100, COLLECT_ID)]);
        expect(yield* codeOf(requirePrepaidCoverage(refunded))).toBe('payment_authorization_coverage_insufficient');
      }
    }),
  );
  it.effect('#1149 unresolved evidence holds the proof for reconciliation', () =>
    Effect.gen(function* held() {
      expect(yield* codeOf(requirePrepaidCoverage(funds([confirmedCollect], { unresolvedEvidence: true })))).toBe(
        'payment_held_for_reconciliation',
      );
    }),
  );
});

describe('#1149 prepaid Current validation', () => {
  it('#1149 same coverage revision and sufficient coverage is Current', () => {
    expect(
      prepaidCurrentnessReasons({
        condition: prepaid,
        currentCoverageRevision: 2,
        proofCoverageRevision: 2,
        snapshot: funds([confirmedCollect]),
      }),
    ).toEqual([]);
  });
  it('#1149 a refund start bumps the revision and removes coverage', () => {
    expect(
      prepaidCurrentnessReasons({
        condition: prepaid,
        currentCoverageRevision: 3,
        proofCoverageRevision: 2,
        snapshot: funds([confirmedCollect, operation(REFUND_ID, 'REFUND', 'PENDING', 1000, COLLECT_ID)]),
      }),
    ).toEqual(['COVERAGE_REVISION_CHANGED', 'COVERAGE_INSUFFICIENT']);
  });
  it('#1149 restored evidence never silently renews a proof bound to an older revision', () => {
    expect(
      prepaidCurrentnessReasons({
        condition: prepaid,
        currentCoverageRevision: 5,
        proofCoverageRevision: 2,
        snapshot: funds([confirmedCollect]),
      }),
    ).toEqual(['COVERAGE_REVISION_CHANGED']);
  });
  it('#1149 a different collection lineage, held evidence or zero-payable drift is not the proof coverage', () => {
    const other = operation(OTHER_COLLECT_ID, 'COLLECT', 'EFFECT_CONFIRMED', 1000);
    expect(
      prepaidCurrentnessReasons({
        condition: prepaid,
        currentCoverageRevision: 1,
        proofCoverageRevision: 1,
        snapshot: funds([other]),
      }),
    ).toEqual(['COVERAGE_INSUFFICIENT']);
    expect(
      prepaidCurrentnessReasons({
        condition: prepaid,
        currentCoverageRevision: 1,
        proofCoverageRevision: 1,
        snapshot: funds([confirmedCollect], { unresolvedEvidence: true }),
      }),
    ).toEqual(['COVERAGE_HELD']);
    expect(
      prepaidCurrentnessReasons({
        condition: { _tag: 'ZERO_PAYABLE', required: czk(0) },
        currentCoverageRevision: 1,
        proofCoverageRevision: 1,
        snapshot: funds([], { required: czk(0) }),
      }),
    ).toEqual([]);
  });
});

const retiredOn = (snapshot: PaymentTermDefinitionSnapshot, effectiveTo: string): PaymentTermDefinitionSnapshot => ({
  ...snapshot,
  lifecycle: { effectiveFrom: snapshot.lifecycle.effectiveFrom, effectiveTo, state: 'RETIRED' },
});
const usableTermA = (semanticSnapshot: PaymentTermDefinitionSnapshot) => ({
  _tag: 'USABLE' as const,
  entitlementEvidenceRef: 'ent-a',
  paymentTermRef: TERM_A,
  semanticSnapshot,
});

const COD_CARRIER = { accountRef: 'carrier-account-1', environment: 'production', sourceSystem: 'carrier-dpd' };
const COD_OFFER_1 = {
  _tag: 'COD_DELIVERY_OFFER',
  capabilityEvidenceRef: 'cap-1',
  carrier: COD_CARRIER,
  deliveryOfferRef: 'offer-1',
} as const;

describe('#1149 method conditions', () => {
  const retained = snapshotOf(TERM_A, { days: 14, kind: 'NET_DAYS' });
  const payment = { paymentTermRef: TERM_A, termSemanticEvidence: retained };
  it('#1149 usable NET_DAYS with the retained meaning and Current entitlement is met', () => {
    const check = deferredTermCondition(
      payment,
      {
        _tag: 'USABLE',
        entitlementEvidenceRef: 'ent-a',
        paymentTermRef: TERM_A,
        semanticSnapshot: retained,
      },
      T,
    );
    expect(MethodConditionCheck.$is('Met')(check)).toBe(true);
    if (MethodConditionCheck.$is('Met')(check)) {
      expect(Schema.is(PaymentAuthorizationDeferredNetDaysSchema)(check.condition)).toBe(true);
      expect(check.condition).toMatchObject({ entitlementEvidenceRef: 'ent-a', netDays: 14 });
    }
  });
  it('#1149 not-current entitlement, another Ref, changed semantics or IMMEDIATE are not met', () => {
    const notMet = [
      deferredTermCondition(
        payment,
        { _tag: 'NOT_USABLE', paymentTermRef: TERM_A, reason: 'ENTITLEMENT_NOT_CURRENT' },
        T,
      ),
      deferredTermCondition(
        payment,
        {
          _tag: 'USABLE',
          entitlementEvidenceRef: 'ent-a',
          paymentTermRef: TERM_B,
          semanticSnapshot: snapshotOf(TERM_B, { kind: 'NET_DAYS' }),
        },
        T,
      ),
      deferredTermCondition(
        payment,
        {
          _tag: 'USABLE',
          entitlementEvidenceRef: 'ent-a',
          paymentTermRef: TERM_A,
          semanticSnapshot: snapshotOf(TERM_A, { days: 30, kind: 'NET_DAYS' }, 'b'.repeat(64)),
        },
        T,
      ),
      deferredTermCondition(
        { paymentTermRef: TERM_A, termSemanticEvidence: snapshotOf(TERM_A, { kind: 'IMMEDIATE' }) },
        {
          _tag: 'USABLE',
          entitlementEvidenceRef: 'ent-a',
          paymentTermRef: TERM_A,
          semanticSnapshot: snapshotOf(TERM_A, { kind: 'IMMEDIATE' }),
        },
        T,
      ),
    ];
    expect(notMet.map((check) => MethodConditionCheck.$is('NotMet')(check))).toEqual([true, true, true, true]);
  });
  it('#1149 a USABLE answer carrying an already retired C15 snapshot is not met; a scheduled retirement still is', () => {
    const retiredBefore = deferredTermCondition(
      payment,
      usableTermA(retiredOn(retained, '2026-11-01T00:00:00.000Z')),
      T,
    );
    const retiredExactlyAtT = deferredTermCondition(
      payment,
      usableTermA(retiredOn(retained, '2026-11-09T10:00:00.000Z')),
      T,
    );
    const scheduledAfter = deferredTermCondition(
      payment,
      usableTermA(retiredOn(retained, '2026-12-01T00:00:00.000Z')),
      T,
    );
    expect(MethodConditionCheck.$is('NotMet')(retiredBefore)).toBe(true);
    expect(MethodConditionCheck.$is('NotMet')(retiredExactlyAtT)).toBe(true);
    expect(MethodConditionCheck.$is('Met')(scheduledAfter)).toBe(true);
  });
  it('#1149 COD requires the exact COD-capable Delivery Offer', () => {
    const supported = codDeliveryCondition(COD_OFFER_1, {
      _tag: 'SUPPORTED',
      capabilityEvidenceRef: 'cap-1',
      carrier: COD_CARRIER,
      deliveryOfferRef: 'offer-1',
    });
    expect(MethodConditionCheck.$is('Met')(supported)).toBe(true);
    if (MethodConditionCheck.$is('Met')(supported)) {
      expect(Schema.is(PaymentAuthorizationCodDeliveryOfferSchema)(supported.condition)).toBe(true);
    }
    expect(
      MethodConditionCheck.$is('NotMet')(
        codDeliveryCondition(COD_OFFER_1, {
          _tag: 'SUPPORTED',
          capabilityEvidenceRef: 'cap',
          carrier: COD_CARRIER,
          deliveryOfferRef: 'offer-2',
        }),
      ),
    ).toBe(true);
    expect(
      MethodConditionCheck.$is('NotMet')(
        codDeliveryCondition(COD_OFFER_1, {
          _tag: 'NOT_SUPPORTED',
          deliveryOfferRef: 'offer-1',
          reason: 'OFFER_NOT_COD_CAPABLE',
        }),
      ),
    ).toBe(true);
  });
  it('#1149 pickup requires the exact authorized capability', () => {
    const supported = pickupCondition('store-1', {
      _tag: 'SUPPORTED',
      capabilityEvidenceRef: 'cap',
      pickupCapabilityRef: 'store-1',
    });
    expect(MethodConditionCheck.$is('Met')(supported)).toBe(true);
    if (MethodConditionCheck.$is('Met')(supported)) {
      expect(Schema.is(PaymentAuthorizationPickupCapabilitySchema)(supported.condition)).toBe(true);
    }
    expect(
      MethodConditionCheck.$is('NotMet')(
        pickupCondition('store-1', {
          _tag: 'NOT_SUPPORTED',
          pickupCapabilityRef: 'store-1',
          reason: 'COLLECTION_NOT_SUPPORTED',
        }),
      ),
    ).toBe(true);
  });
  it('#1149 cancelled vs unaffected entitlement: only the same entitlement identity keeps the proof Current', () => {
    const original: PaymentAuthorizationCondition = {
      _tag: 'DEFERRED_NET_DAYS',
      entitlementEvidenceRef: 'ent-a',
      netDays: 14,
    };
    expect(methodConditionReasons(original, MethodConditionCheck.Met({ condition: { ...original } }))).toEqual([]);
    expect(
      methodConditionReasons(
        original,
        MethodConditionCheck.Met({ condition: { ...original, entitlementEvidenceRef: 'ent-a2' } }),
      ),
    ).toEqual(['METHOD_CONDITION_NOT_MET']);
    expect(methodConditionReasons(original, MethodConditionCheck.NotMet({ reason: 'cancelled' }))).toEqual([
      'METHOD_CONDITION_NOT_MET',
    ]);
    expect(methodConditionReasons(prepaid, MethodConditionCheck.Met({ condition: original }))).toEqual([
      'METHOD_CONDITION_NOT_MET',
    ]);
  });
});

describe('#1149 method-condition owner questions concern the exact stored purchase and carrier', () => {
  const retained = snapshotOf(TERM_A, { days: 14, kind: 'NET_DAYS' });
  const guestBuyer: PaymentPurchasingContext = {
    channelId: 'web-cz',
    contextRef: 'purchasing-context-1',
    contextRevision: '1',
    marketId: 'market-cz',
    subject: { guestEvidenceRef: 'guest-evidence-1', guestSessionRef: 'guest-session-1', kind: 'GUEST' },
  };
  const dpdCarrier: PaymentCodCarrier = {
    accountRef: 'dpd-merchant-12',
    environment: 'production',
    sourceSystem: 'dpd',
  };
  const storedPayment: PaymentMethodConditionSubject = {
    amount: czk(100_000),
    customerConfigurationId: 'ccc-1',
    executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
    method: 'DEFERRED_INVOICE',
    paymentTermRef: TERM_A,
    purchasingContext: guestBuyer,
    termSemanticEvidence: retained,
  };

  const ownerScope = { legalEntityId: '33333333-3333-4333-8333-333333333333', tenantId };
  const notConsulted = Layer.mergeAll(
    Layer.succeed(PaymentTermEvidencePort, { verifyTermUse: () => Effect.die('the term owner is not consulted') }),
    Layer.succeed(DeliveryCapabilityPort, {
      verifyCashOnDelivery: () => Effect.die('the Delivery owner is not consulted'),
    }),
    Layer.succeed(PickupCapabilityPort, {
      verifyPickupCollection: () => Effect.die('the pickup owner is not consulted'),
    }),
  );

  const deliveryOwnerNaming = (carrier: PaymentCodCarrier) =>
    Layer.merge(
      notConsulted,
      Layer.succeed(DeliveryCapabilityPort, {
        verifyCashOnDelivery: ({ deliveryOfferRef }) =>
          Effect.succeed({
            _tag: 'SUPPORTED' as const,
            capabilityEvidenceRef: `cod-capability-${carrier.sourceSystem}`,
            carrier,
            deliveryOfferRef,
          }),
      }),
    );

  it.effect('#1149 a deferred proof asks the term owner about the Payment stored trusted Purchasing Context', () =>
    Effect.gen(function* deferredPurchaseScope() {
      const asked: PaymentTermPurchase[] = [];
      const recordingTermOwner = Layer.succeed(PaymentTermEvidencePort, {
        verifyTermUse: ({ purchase }) =>
          Effect.sync(() => {
            asked.push(purchase);
            return {
              _tag: 'USABLE' as const,
              entitlementEvidenceRef: 'entitlement-1',
              paymentTermRef: TERM_A,
              semanticSnapshot: retained,
            };
          }),
      });
      const check = yield* verifyMethodCondition(
        storedPayment,
        [{ enabled: true, method: 'DEFERRED_INVOICE', revision: 1 }],
        ownerScope,
      ).pipe(Effect.provide(Layer.merge(notConsulted, recordingTermOwner)));
      expect(MethodConditionCheck.$is('Met')(check)).toBe(true);
      expect(asked).toStrictEqual([{ _tag: 'PURCHASING_CONTEXT', purchasingContext: guestBuyer }]);
    }),
  );

  it.effect('#1149 COD is not met when the Delivery owner names another carrier for the bound offer', () =>
    Effect.gen(function* codCarrierCurrentness() {
      const codPayment: PaymentMethodConditionSubject = {
        ...storedPayment,
        executionBinding: {
          _tag: 'COD_DELIVERY_OFFER',
          capabilityEvidenceRef: 'cod-capability-dpd',
          carrier: dpdCarrier,
          deliveryOfferRef: 'offer-1',
        },
        method: 'CASH_ON_DELIVERY',
      };
      const check = (carrier: PaymentCodCarrier) =>
        verifyMethodCondition(
          codPayment,
          [{ enabled: true, method: 'CASH_ON_DELIVERY', revision: 1 }],
          ownerScope,
        ).pipe(
          Effect.provide(deliveryOwnerNaming(carrier)),
          Effect.map((result) => result._tag),
        );
      expect(yield* check(dpdCarrier)).toBe('Met');
      expect(yield* check({ accountRef: 'ppl-merchant-77', environment: 'production', sourceSystem: 'ppl' })).toBe(
        'NotMet',
      );
      expect(yield* check({ ...dpdCarrier, accountRef: 'dpd-merchant-99' })).toBe('NotMet');
      expect(yield* check({ ...dpdCarrier, environment: 'sandbox' })).toBe('NotMet');
    }),
  );
});
