import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Effect, Match, Schema } from 'effect';

import type { PaymentAuthorizationCondition } from '../../shared/domain/authorization-proof.ts';
import type { PaymentRecord } from '../persistence/payment-aggregate-persistence.ts';
import { DeliveryCapabilityPort } from '../ports/delivery-capability-port.ts';
import type { PaymentCodCapability } from '../ports/delivery-capability-port.ts';
import type { PaymentOwnerEvidenceUnavailable, PaymentOwnerScope } from '../ports/owner-evidence-unavailable.ts';
import { PaymentTermEvidencePort } from '../ports/payment-term-evidence-port.ts';
import type { PaymentTermUseEvidence } from '../ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort } from '../ports/pickup-capability-port.ts';
import type { PaymentPickupCollectionCapability } from '../ports/pickup-capability-port.ts';
import { MethodConditionCheck } from './authorization-currentness.ts';
import type { MethodConditionCheckCase } from './authorization-currentness.ts';

/**
 * Current method-condition evidence (#1149 "Accepted Launch behavior"). Deferred invoice, Cash on
 * Delivery and pay on pickup/on-site may authorize commitment before collection only through their
 * exact Current owner evidence; none of them records or claims collection. An owner outage fails as
 * `PaymentOwnerEvidenceUnavailable`, never as absence or a negative fact.
 */

const sameTermRef = Schema.toEquivalence(PaymentTermRefSchema);
const met = (condition: PaymentAuthorizationCondition) => MethodConditionCheck.Met({ condition });
const notMet = (reason: string) => MethodConditionCheck.NotMet({ reason });

type MethodConditionRequirements = DeliveryCapabilityPort | PaymentTermEvidencePort | PickupCapabilityPort;
type MethodConditionVerification = Effect.Effect<
  MethodConditionCheckCase,
  PaymentOwnerEvidenceUnavailable,
  MethodConditionRequirements
>;

/**
 * DEFERRED_INVOICE: the exact resolved term must still be NET_DAYS with the same C15 semantic
 * snapshot the Payment retained, and the CCC entitlement/policy must be Current. A semantic change
 * produces a new Payment Term Ref; it never re-qualifies an old Payment or proof.
 */
export const deferredTermCondition = (
  payment: Pick<PaymentRecord, 'paymentTermRef' | 'termSemanticEvidence'>,
  evidence: PaymentTermUseEvidence,
): MethodConditionCheckCase =>
  Match.value(evidence).pipe(
    Match.tagsExhaustive({
      NOT_USABLE: ({ reason }) => notMet(`The Payment Term is not usable for this purchase: ${reason}`),
      USABLE: ({ entitlementEvidenceRef, paymentTermRef, semanticSnapshot }) => {
        if (!sameTermRef(paymentTermRef, payment.paymentTermRef)) {
          return notMet('The owner evidence concerns a different Payment Term Ref');
        }
        if (
          semanticSnapshot.semanticFingerprint !== payment.termSemanticEvidence.semanticFingerprint ||
          semanticSnapshot.semanticRevisionId !== payment.termSemanticEvidence.semanticRevisionId
        ) {
          return notMet('The Payment Term semantic meaning differs from the meaning retained by the Payment');
        }
        const { semantics } = semanticSnapshot;
        return semantics.kind === 'NET_DAYS'
          ? met({ _tag: 'DEFERRED_NET_DAYS', entitlementEvidenceRef, netDays: semantics.days })
          : notMet('Deferred invoice requires a NET_DAYS Payment Term');
      },
    }),
  );

/** CASH_ON_DELIVERY: the exact selected Delivery Offer must be Currently COD-capable for the exact amount. */
export const codDeliveryCondition = (deliveryOfferRef: string, capability: PaymentCodCapability) =>
  Match.value(capability).pipe(
    Match.tagsExhaustive({
      NOT_SUPPORTED: ({ reason }) => notMet(`The exact Delivery Offer does not support Cash on Delivery: ${reason}`),
      SUPPORTED: (supported) =>
        supported.deliveryOfferRef === deliveryOfferRef
          ? met({
              _tag: 'COD_DELIVERY_OFFER',
              capabilityEvidenceRef: supported.capabilityEvidenceRef,
              deliveryOfferRef: supported.deliveryOfferRef,
            })
          : notMet('The COD capability evidence concerns a different Delivery Offer'),
    }),
  );

/** PAY_ON_PICKUP_OR_ON_SITE: the exact authorized pickup/on-site capability must Currently support collection. */
export const pickupCondition = (pickupCapabilityRef: string, capability: PaymentPickupCollectionCapability) =>
  Match.value(capability).pipe(
    Match.tagsExhaustive({
      NOT_SUPPORTED: ({ reason }) =>
        notMet(`The exact pickup/on-site capability does not support collection: ${reason}`),
      SUPPORTED: (supported) =>
        supported.pickupCapabilityRef === pickupCapabilityRef
          ? met({
              _tag: 'PICKUP_CAPABILITY',
              capabilityEvidenceRef: supported.capabilityEvidenceRef,
              pickupCapabilityRef: supported.pickupCapabilityRef,
            })
          : notMet('The pickup capability evidence concerns a different capability'),
    }),
  );

const verifyDeferredTerm = Effect.fn('PaymentAuthorization.verifyDeferredTerm')(function* verifyDeferredTerm(
  payment: PaymentRecord,
  scope: PaymentOwnerScope,
) {
  const terms = yield* PaymentTermEvidencePort;
  const evidence = yield* terms.verifyTermUse({
    customerConfigurationId: payment.customerConfigurationId,
    method: payment.method,
    paymentTermRef: payment.paymentTermRef,
    scope,
  });
  return deferredTermCondition(payment, evidence);
});

const verifyCashOnDelivery = Effect.fn('PaymentAuthorization.verifyCashOnDelivery')(function* verifyCashOnDelivery(
  payment: PaymentRecord,
  deliveryOfferRef: string,
  scope: PaymentOwnerScope,
) {
  const delivery = yield* DeliveryCapabilityPort;
  const capability = yield* delivery.verifyCashOnDelivery({ amount: payment.amount, deliveryOfferRef, scope });
  return codDeliveryCondition(deliveryOfferRef, capability);
});

const verifyPickupCollection = Effect.fn('PaymentAuthorization.verifyPickupCollection')(
  function* verifyPickupCollection(payment: PaymentRecord, pickupCapabilityRef: string, scope: PaymentOwnerScope) {
    const pickup = yield* PickupCapabilityPort;
    const capability = yield* pickup.verifyPickupCollection({ amount: payment.amount, pickupCapabilityRef, scope });
    return pickupCondition(pickupCapabilityRef, capability);
  },
);

const unmatchedBinding = (payment: PaymentRecord): MethodConditionVerification =>
  Effect.succeed(notMet(`The ${payment.method} Payment has no method condition matching its execution binding`));

/** Verifies the Current method condition of one non-prepaid Payment through its exact owner port. */
export const verifyMethodCondition = (payment: PaymentRecord, scope: PaymentOwnerScope): MethodConditionVerification =>
  payment.method === 'DEFERRED_INVOICE'
    ? verifyDeferredTerm(payment, scope)
    : Match.value(payment.executionBinding).pipe(
        Match.tagsExhaustive({
          BANK_ACCOUNTING_RECEIPT: () => unmatchedBinding(payment),
          COD_DELIVERY_OFFER: ({ deliveryOfferRef }): MethodConditionVerification =>
            payment.method === 'CASH_ON_DELIVERY'
              ? verifyCashOnDelivery(payment, deliveryOfferRef, scope)
              : unmatchedBinding(payment),
          GATEWAY_ACCOUNT: () => unmatchedBinding(payment),
          PICKUP_CAPABILITY: ({ pickupCapabilityRef }): MethodConditionVerification =>
            payment.method === 'PAY_ON_PICKUP_OR_ON_SITE'
              ? verifyPickupCollection(payment, pickupCapabilityRef, scope)
              : unmatchedBinding(payment),
        }),
      );
