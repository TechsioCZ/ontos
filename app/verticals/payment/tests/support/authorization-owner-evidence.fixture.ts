import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Effect, Layer, Ref, Schema } from 'effect';

import { PaymentPurchasingSubjectSchema } from '../../shared/domain/applicability-purchasing-context.ts';
import type { PaymentPurchasingSubject } from '../../shared/domain/applicability-purchasing-context.ts';
import type { PaymentCodCarrier } from '../../shared/domain/payment-execution-binding.ts';
import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../../src/ports/commitment-outcome-port.ts';
import { DeliveryCapabilityPort } from '../../src/ports/delivery-capability-port.ts';
import type { PaymentCodNotSupportedReasonSchema } from '../../src/ports/delivery-capability-port.ts';
import { GatewayBindingPort, unavailableGatewayBinding } from '../../src/ports/gateway-binding-port.ts';
import { ownerEvidenceUnavailable } from '../../src/ports/owner-evidence-unavailable.ts';
import { PaymentTermEvidencePort } from '../../src/ports/payment-term-evidence-port.ts';
import type { PaymentTermPurchase, PaymentTermUseEvidence } from '../../src/ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort } from '../../src/ports/pickup-capability-port.ts';
import type { PaymentPickupNotSupportedReasonSchema } from '../../src/ports/pickup-capability-port.ts';
import { RefundableItemsPort, unavailableRefundableItems } from '../../src/ports/refundable-items-port.ts';

/**
 * PUBLIC-CONTRACT FIXTURES of the downstream owners Payment Authorization (#1149) consumes:
 * - C15 Payment Term Catalog + Commerce Customer Context: exact term semantics and Current
 *   entitlement periods per Customer Configuration (cancelled vs unaffected periods);
 * - Delivery Offer owner: exact COD capability of one selected Delivery Offer;
 * - pickup/on-site owner: exact collection capability.
 * They answer only what each owner's public port contract allows and stand in for those owners'
 * future runtimes. The Payment Action, Read, persistence and Core boundary under test are real.
 */

const sameTermRef = Schema.toEquivalence(PaymentTermRefSchema);

export const authorizationTermRefFor = (tenantId: string, resourceId: string): PaymentTermRef => ({
  moduleId: 'payment.term-catalog',
  resourceId,
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
});

/** C15 public snapshot of a canonical `NET_DAYS(N)` term with an exact semantic fingerprint. */
export const authorizationNetDaysSnapshot = (
  paymentTermRef: PaymentTermRef,
  days: number,
  semanticFingerprint = 'd'.repeat(64),
): PaymentTermDefinitionSnapshot =>
  Schema.decodeUnknownSync(PaymentTermDefinitionSnapshotSchema)({
    code: `NET_${days}`,
    compatibilityId: 'net_days.invoice_issue_date.calendar_days.v2',
    definitionRevisionId: '57575757-5757-4575-8575-575757575757',
    lifecycle: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
    metadataRevision: 1,
    name: `Net ${days}`,
    paymentTermRef,
    semanticFingerprint,
    semanticRevisionId: '67676767-6767-4676-8676-676767676767',
    semantics: {
      calculationRuleVersion: 2,
      calendarRule: 'CALENDAR_DAYS',
      days,
      dueDateAnchor: 'INVOICE_ISSUE_DATE',
      kind: 'NET_DAYS',
    },
  });

/** One CCC entitlement period of one buyer (the purchasing-context subject) for one exact Payment Term Ref. */
export interface AuthorizationEntitlementPeriodFixture {
  readonly buyer: PaymentPurchasingSubject;
  readonly entitlementEvidenceRef: string;
  /** The C15 semantic snapshot the term owner Currently publishes for the Ref. */
  readonly semanticSnapshot: PaymentTermDefinitionSnapshot;
  readonly status: 'CURRENT' | 'CANCELLED';
}

/** The carrier the fixture Delivery owner names for every COD-capable offer; COD bindings must retain it. */
export const AUTHORIZATION_COD_CARRIER = {
  accountRef: 'ppl-cod-contract-1',
  environment: 'production',
  sourceSystem: 'ppl',
} as const satisfies PaymentCodCarrier;

type CodAnswer = 'SUPPORTED' | 'UNAVAILABLE' | typeof PaymentCodNotSupportedReasonSchema.Type;
type PickupAnswer = 'SUPPORTED' | 'UNAVAILABLE' | typeof PaymentPickupNotSupportedReasonSchema.Type;

const sameBuyer = Schema.toEquivalence(PaymentPurchasingSubjectSchema);

const termUse = (
  periods: readonly AuthorizationEntitlementPeriodFixture[],
  purchase: PaymentTermPurchase,
  paymentTermRef: PaymentTermRef,
): PaymentTermUseEvidence => {
  const period = periods.find(
    (candidate) =>
      sameBuyer(candidate.buyer, purchase.purchasingContext.subject) &&
      sameTermRef(candidate.semanticSnapshot.paymentTermRef, paymentTermRef),
  );
  if (period === undefined) {
    return { _tag: 'NOT_USABLE', paymentTermRef, reason: 'ENTITLEMENT_NOT_CURRENT' };
  }
  return period.status === 'CANCELLED'
    ? { _tag: 'NOT_USABLE', paymentTermRef, reason: 'ENTITLEMENT_NOT_CURRENT' }
    : {
        _tag: 'USABLE',
        entitlementEvidenceRef: period.entitlementEvidenceRef,
        paymentTermRef,
        semanticSnapshot: period.semanticSnapshot,
      };
};

/**
 * Mutable owner state for one test: entitlement periods, COD answers per Delivery Offer and pickup
 * answers per capability. `layer` provides all six Payment owner ports; the three ports
 * authorization does not consult stay explicitly unavailable.
 */
export const makeAuthorizationOwnerEvidenceFixture = Effect.gen(function* makeAuthorizationOwnerEvidenceFixture() {
  const periods = yield* Ref.make<readonly AuthorizationEntitlementPeriodFixture[]>([]);
  const termEvidenceUnavailable = yield* Ref.make(false);
  const cod = yield* Ref.make<ReadonlyMap<string, CodAnswer>>(new Map());
  const pickup = yield* Ref.make<ReadonlyMap<string, PickupAnswer>>(new Map());

  const layer = Layer.mergeAll(
    Layer.succeed(PaymentTermEvidencePort, {
      verifyTermUse: ({ paymentTermRef, purchase }) =>
        Effect.gen(function* answerTermUse() {
          if (yield* Ref.get(termEvidenceUnavailable)) {
            return yield* ownerEvidenceUnavailable('PAYMENT_TERM_EVIDENCE', 'Customer Context fixture is down');
          }
          return termUse(yield* Ref.get(periods), purchase, paymentTermRef);
        }),
    }),
    Layer.succeed(DeliveryCapabilityPort, {
      verifyCashOnDelivery: ({ deliveryOfferRef }) =>
        Effect.gen(function* answerCod() {
          const answer = (yield* Ref.get(cod)).get(deliveryOfferRef) ?? 'OFFER_NOT_CURRENT';
          if (answer === 'UNAVAILABLE') {
            return yield* ownerEvidenceUnavailable('DELIVERY_CAPABILITY', 'Delivery Offer fixture is down');
          }
          return answer === 'SUPPORTED'
            ? {
                _tag: 'SUPPORTED' as const,
                capabilityEvidenceRef: `cod-capability:${deliveryOfferRef}`,
                carrier: AUTHORIZATION_COD_CARRIER,
                deliveryOfferRef,
              }
            : { _tag: 'NOT_SUPPORTED' as const, deliveryOfferRef, reason: answer };
        }),
    }),
    Layer.succeed(PickupCapabilityPort, {
      verifyPickupCollection: ({ pickupCapabilityRef }) =>
        Effect.gen(function* answerPickup() {
          const answer = (yield* Ref.get(pickup)).get(pickupCapabilityRef) ?? 'CAPABILITY_NOT_CURRENT';
          if (answer === 'UNAVAILABLE') {
            return yield* ownerEvidenceUnavailable('PICKUP_CAPABILITY', 'Pickup capability fixture is down');
          }
          return answer === 'SUPPORTED'
            ? {
                _tag: 'SUPPORTED' as const,
                capabilityEvidenceRef: `pickup-capability:${pickupCapabilityRef}`,
                pickupCapabilityRef,
              }
            : { _tag: 'NOT_SUPPORTED' as const, pickupCapabilityRef, reason: answer };
        }),
    }),
    Layer.succeed(GatewayBindingPort, unavailableGatewayBinding),
    Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
    Layer.succeed(RefundableItemsPort, unavailableRefundableItems),
  );

  return {
    layer,
    putEntitlementPeriod: (period: AuthorizationEntitlementPeriodFixture) =>
      Ref.update(periods, (current) => [
        ...current.filter(
          (candidate) =>
            !sameBuyer(candidate.buyer, period.buyer) ||
            !sameTermRef(candidate.semanticSnapshot.paymentTermRef, period.semanticSnapshot.paymentTermRef),
        ),
        period,
      ]),
    setCod: (deliveryOfferRef: string, answer: CodAnswer) =>
      Ref.update(cod, (current) => new Map([...current, [deliveryOfferRef, answer]])),
    setPickup: (pickupCapabilityRef: string, answer: PickupAnswer) =>
      Ref.update(pickup, (current) => new Map([...current, [pickupCapabilityRef, answer]])),
    setTermEvidenceUnavailable: (unavailable: boolean) => Ref.set(termEvidenceUnavailable, unavailable),
  };
});
