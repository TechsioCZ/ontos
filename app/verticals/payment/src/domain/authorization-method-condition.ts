import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import type { PaymentMethodEnablementState } from '../../shared/domain/applicability-contract.ts';
import type { PaymentAuthorizationCondition } from '../../shared/domain/authorization-proof.ts';
import { PaymentCodCarrierSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
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
import type { PaymentCodDeliveryOfferBinding } from './cod-carrier.ts';

/**
 * Current method-condition evidence (#1149 "Accepted Launch behavior"). Deferred invoice, Cash on
 * Delivery and pay on pickup/on-site may authorize commitment before collection only through their
 * exact Current owner evidence; none of them records or claims collection. An owner outage fails as
 * `PaymentOwnerEvidenceUnavailable`, never as absence or a negative fact.
 */

const sameTermRef = Schema.toEquivalence(PaymentTermRefSchema);
const met = (condition: PaymentAuthorizationCondition) => MethodConditionCheck.Met({ condition });
const notMet = (reason: string) => MethodConditionCheck.NotMet({ reason });

/** The retained Payment facts a method condition is decided from. */
export type PaymentMethodConditionSubject = Pick<
  PaymentRecord,
  | 'amount'
  | 'customerConfigurationId'
  | 'executionBinding'
  | 'method'
  | 'paymentTermRef'
  | 'purchasingContext'
  | 'termSemanticEvidence'
>;

type MethodConditionRequirements = DeliveryCapabilityPort | PaymentTermEvidencePort | PickupCapabilityPort;
type MethodConditionVerification = Effect.Effect<
  MethodConditionCheckCase,
  PaymentOwnerEvidenceUnavailable,
  MethodConditionRequirements
>;

/**
 * DEFERRED_INVOICE: the exact resolved term must still be NET_DAYS with the same C15 semantic
 * snapshot the Payment retained, that snapshot must itself still be Current at `at` (an owner answer
 * calling a term usable while its own snapshot says it was retired is contradictory evidence; a
 * scheduled retirement keeps it Current until reached), and the CCC entitlement/policy must be
 * Current. A semantic change produces a new Payment Term Ref; it never re-qualifies an old Payment or proof.
 */
export const deferredTermCondition = (
  payment: Pick<PaymentRecord, 'paymentTermRef' | 'termSemanticEvidence'>,
  evidence: PaymentTermUseEvidence,
  at: DateTime.Utc,
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
        const { effectiveTo } = semanticSnapshot.lifecycle;
        if (effectiveTo !== null && DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(effectiveTo), at)) {
          return notMet('The Payment Term snapshot was already retired');
        }
        const { semantics } = semanticSnapshot;
        return semantics.kind === 'NET_DAYS'
          ? met({ _tag: 'DEFERRED_NET_DAYS', entitlementEvidenceRef, netDays: semantics.days })
          : notMet('Deferred invoice requires a NET_DAYS Payment Term');
      },
    }),
  );

const sameCarrier = Schema.toEquivalence(PaymentCodCarrierSchema);

/**
 * CASH_ON_DELIVERY: the exact selected Delivery Offer must be Currently COD-capable for the exact amount,
 * collected by the exact carrier binding the Payment retained. That carrier is the only authority whose
 * collection evidence Payment accepts, so an offer the Delivery owner now serves through another carrier
 * no longer satisfies the condition.
 */
export const codDeliveryCondition = (binding: PaymentCodDeliveryOfferBinding, capability: PaymentCodCapability) =>
  Match.value(capability).pipe(
    Match.tagsExhaustive({
      NOT_SUPPORTED: ({ reason }) => notMet(`The exact Delivery Offer does not support Cash on Delivery: ${reason}`),
      SUPPORTED: (supported) => {
        if (supported.deliveryOfferRef !== binding.deliveryOfferRef) {
          return notMet('The COD capability evidence concerns a different Delivery Offer');
        }
        if (!sameCarrier(supported.carrier, binding.carrier)) {
          return notMet('The COD capability names a different carrier than the one the Payment is bound to');
        }
        return met({
          _tag: 'COD_DELIVERY_OFFER',
          capabilityEvidenceRef: supported.capabilityEvidenceRef,
          deliveryOfferRef: supported.deliveryOfferRef,
        });
      },
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
  payment: PaymentMethodConditionSubject,
  scope: PaymentOwnerScope,
) {
  const terms = yield* PaymentTermEvidencePort;
  const evidence = yield* terms.verifyTermUse({
    customerConfigurationId: payment.customerConfigurationId,
    method: payment.method,
    paymentTermRef: payment.paymentTermRef,
    purchase: { _tag: 'PURCHASING_CONTEXT', purchasingContext: payment.purchasingContext },
    scope,
  });
  return deferredTermCondition(payment, evidence, yield* DateTime.now);
});

const verifyCashOnDelivery = Effect.fn('PaymentAuthorization.verifyCashOnDelivery')(function* verifyCashOnDelivery(
  payment: PaymentMethodConditionSubject,
  binding: PaymentCodDeliveryOfferBinding,
  scope: PaymentOwnerScope,
) {
  const delivery = yield* DeliveryCapabilityPort;
  const capability = yield* delivery.verifyCashOnDelivery({
    amount: payment.amount,
    deliveryOfferRef: binding.deliveryOfferRef,
    scope,
  });
  return codDeliveryCondition(binding, capability);
});

const verifyPickupCollection = Effect.fn('PaymentAuthorization.verifyPickupCollection')(
  function* verifyPickupCollection(
    payment: PaymentMethodConditionSubject,
    pickupCapabilityRef: string,
    scope: PaymentOwnerScope,
  ) {
    const pickup = yield* PickupCapabilityPort;
    const capability = yield* pickup.verifyPickupCollection({ amount: payment.amount, pickupCapabilityRef, scope });
    return pickupCondition(pickupCapabilityRef, capability);
  },
);

const unmatchedBinding = (payment: PaymentMethodConditionSubject): MethodConditionVerification =>
  Effect.succeed(notMet(`The ${payment.method} Payment has no method condition matching its execution binding`));

/**
 * #1147 merchant applicability of the Payment's own method: a pre-collection method condition holds
 * only while the method is Currently enabled for the Payment's Customer Configuration. A withdrawn,
 * never configured or ambiguous enablement leaves the method not applicable, whatever the owner
 * evidence says, so it neither issues nor keeps a proof Current.
 */
export const methodEnablementCondition = (
  enablements: readonly PaymentMethodEnablementState[],
  method: PaymentMethod,
): Option.Option<MethodConditionCheckCase> => {
  const rows = enablements.filter((row) => row.method === method);
  const [row] = rows;
  if (row === undefined) {
    return Option.some(notMet(`${method} is not enabled for the Customer Configuration`));
  }
  if (rows.length > 1) {
    return Option.some(notMet(`${method} has conflicting enablement configuration`));
  }
  return row.enabled ? Option.none() : Option.some(notMet(`${method} was withdrawn for the Customer Configuration`));
};

const verifyOwnerCondition = (
  payment: PaymentMethodConditionSubject,
  scope: PaymentOwnerScope,
): MethodConditionVerification =>
  payment.method === 'DEFERRED_INVOICE'
    ? verifyDeferredTerm(payment, scope)
    : Match.value(payment.executionBinding).pipe(
        Match.tagsExhaustive({
          BANK_ACCOUNTING_RECEIPT: () => unmatchedBinding(payment),
          COD_DELIVERY_OFFER: (binding): MethodConditionVerification =>
            payment.method === 'CASH_ON_DELIVERY'
              ? verifyCashOnDelivery(payment, binding, scope)
              : unmatchedBinding(payment),
          GATEWAY_ACCOUNT: () => unmatchedBinding(payment),
          PICKUP_CAPABILITY: ({ pickupCapabilityRef }): MethodConditionVerification =>
            payment.method === 'PAY_ON_PICKUP_OR_ON_SITE'
              ? verifyPickupCollection(payment, pickupCapabilityRef, scope)
              : unmatchedBinding(payment),
        }),
      );

/**
 * Verifies the Current method condition of one non-prepaid Payment: the method must still be
 * applicable (merchant enablement, checked locally first), then its exact owner port must confirm it.
 */
export const verifyMethodCondition = (
  payment: PaymentMethodConditionSubject,
  enablements: readonly PaymentMethodEnablementState[],
  scope: PaymentOwnerScope,
): MethodConditionVerification =>
  Option.match(methodEnablementCondition(enablements, payment.method), {
    onNone: () => verifyOwnerCondition(payment, scope),
    onSome: Effect.succeed,
  });
