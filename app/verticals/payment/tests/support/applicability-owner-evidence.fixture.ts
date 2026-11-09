import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Effect, Layer, Schema } from 'effect';

import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import { DeliveryCapabilityPort } from '../../src/ports/delivery-capability-port.ts';
import type {
  PaymentCodCapability,
  PaymentDeliveryCapabilityService,
} from '../../src/ports/delivery-capability-port.ts';
import { GatewayBindingPort } from '../../src/ports/gateway-binding-port.ts';
import type { PaymentGatewayBindingService } from '../../src/ports/gateway-binding-port.ts';
import { ownerEvidenceUnavailable } from '../../src/ports/owner-evidence-unavailable.ts';
import { PaymentTermEvidencePort } from '../../src/ports/payment-term-evidence-port.ts';
import type { PaymentTermEvidenceService, PaymentTermUseEvidence } from '../../src/ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort } from '../../src/ports/pickup-capability-port.ts';
import type {
  PaymentPickupCapabilityService,
  PaymentPickupCollectionCapability,
} from '../../src/ports/pickup-capability-port.ts';

/**
 * PUBLIC-CONTRACT FIXTURES of the downstream owners Payment applicability (#1147) depends on:
 * C15 Payment Term Catalog + Commerce Customer Context (term semantics and Current entitlement),
 * C17 Gateway Enablement (#1155), Delivery Offer COD capability and pickup/on-site capability.
 * They answer exactly what each owner's public port contract allows and stand in only for those
 * owners' future runtimes; the Payment evaluator, persistence and Core boundary under test are real.
 * Every fixture records which exact subject Payment asked about.
 */

export const OWNER_EVIDENCE_UNAVAILABLE = 'UNAVAILABLE' as const;
type Unavailable = typeof OWNER_EVIDENCE_UNAVAILABLE;

export const termRefFor = (tenantId: string, resourceId: string): PaymentTermRef => ({
  moduleId: 'payment.term-catalog',
  resourceId,
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
});

const snapshotBase = (paymentTermRef: PaymentTermRef) => ({
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  lifecycle: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
  metadataRevision: 1,
  paymentTermRef,
  semanticFingerprint: 'e'.repeat(64),
  semanticRevisionId: '66666666-6666-4666-8666-666666666666',
});

/** C15 public snapshot of a canonical (v2) `NET_DAYS(N)` term. */
export const netDaysSnapshot = (paymentTermRef: PaymentTermRef, days: number): PaymentTermDefinitionSnapshot =>
  Schema.decodeUnknownSync(PaymentTermDefinitionSnapshotSchema)({
    ...snapshotBase(paymentTermRef),
    code: `NET_${days}`,
    compatibilityId: 'net_days.invoice_issue_date.calendar_days.v2',
    name: `Net ${days}`,
    semantics: {
      calculationRuleVersion: 2,
      calendarRule: 'CALENDAR_DAYS',
      days,
      dueDateAnchor: 'INVOICE_ISSUE_DATE',
      kind: 'NET_DAYS',
    },
  });

/** C15 public snapshot of a retained historical (v1) `NET_DAYS(N)` meaning; never relabelled as v2. */
export const legacyNetDaysSnapshot = (paymentTermRef: PaymentTermRef, days: number): PaymentTermDefinitionSnapshot =>
  Schema.decodeUnknownSync(PaymentTermDefinitionSnapshotSchema)({
    ...snapshotBase(paymentTermRef),
    code: `NET_${days}_V1`,
    compatibilityId: 'net_days.invoice_issued_at.utc.v1',
    name: `Net ${days} (v1)`,
    semantics: {
      calculationRuleVersion: 1,
      calendarRule: 'CALENDAR_DAYS_UTC',
      days,
      dueDateAnchor: 'INVOICE_ISSUED_AT',
      kind: 'NET_DAYS',
    },
  });

/** C15 public snapshot of the canonical `IMMEDIATE` term. */
export const immediateSnapshot = (paymentTermRef: PaymentTermRef): PaymentTermDefinitionSnapshot =>
  Schema.decodeUnknownSync(PaymentTermDefinitionSnapshotSchema)({
    ...snapshotBase(paymentTermRef),
    code: 'IMMEDIATE',
    compatibilityId: 'immediate.v2',
    name: 'Immediate',
    semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
  });

export const usableTerm = (snapshot: PaymentTermDefinitionSnapshot, entitlementEvidenceRef: string) =>
  ({
    _tag: 'USABLE',
    entitlementEvidenceRef,
    paymentTermRef: snapshot.paymentTermRef,
    semanticSnapshot: snapshot,
  }) satisfies PaymentTermUseEvidence;

export const notUsableTerm = (
  paymentTermRef: PaymentTermRef,
  reason: Extract<PaymentTermUseEvidence, { _tag: 'NOT_USABLE' }>['reason'],
) => ({ _tag: 'NOT_USABLE', paymentTermRef, reason }) satisfies PaymentTermUseEvidence;

export interface OwnerEvidenceCalls {
  readonly deliveryOffers: string[];
  readonly gatewayBindings: PaymentGatewayAccountBinding[];
  readonly gatewayListings: number[];
  readonly pickupCapabilities: string[];
  readonly termMethods: PaymentMethod[];
}

export interface ApplicabilityOwnerEvidenceScript {
  /** Delivery Offer owner: COD capability per exact offer ref, or an outage. */
  readonly codCapability: (deliveryOfferRef: string) => PaymentCodCapability | Unavailable;
  /** C17: the bindings currently enabled for the Customer Configuration, or an outage. */
  readonly enabledGatewayBindings: readonly PaymentGatewayAccountBinding[] | Unavailable;
  /** Pickup owner: collection capability per exact capability ref, or an outage. */
  readonly pickupCapability: (pickupCapabilityRef: string) => PaymentPickupCollectionCapability | Unavailable;
  /** C15 + CCC: the exact term-use decision for the method being evaluated, or an outage. */
  readonly termUse: (method: PaymentMethod) => PaymentTermUseEvidence | Unavailable;
}

const sameBinding = (left: PaymentGatewayAccountBinding, right: PaymentGatewayAccountBinding) =>
  left.providerFamily === right.providerFamily &&
  left.providerAccountRef === right.providerAccountRef &&
  left.environment === right.environment;

/** Builds the four owner port fixtures from one script; the returned calls record every exact question. */
export const applicabilityOwnerEvidenceFixture = (script: ApplicabilityOwnerEvidenceScript) => {
  const calls: OwnerEvidenceCalls = {
    deliveryOffers: [],
    gatewayBindings: [],
    gatewayListings: [],
    pickupCapabilities: [],
    termMethods: [],
  };
  const termEvidence: PaymentTermEvidenceService = {
    verifyTermUse: ({ method }) => {
      calls.termMethods.push(method);
      const answer = script.termUse(method);
      return answer === OWNER_EVIDENCE_UNAVAILABLE
        ? Effect.fail(ownerEvidenceUnavailable('PAYMENT_TERM_EVIDENCE', 'Fixture: term owner unavailable'))
        : Effect.succeed(answer);
    },
  };
  const gateway: PaymentGatewayBindingService = {
    listEnabledBindings: () => {
      calls.gatewayListings.push(1);
      const enabled = script.enabledGatewayBindings;
      return enabled === OWNER_EVIDENCE_UNAVAILABLE
        ? Effect.fail(ownerEvidenceUnavailable('GATEWAY_BINDING', 'Fixture: C17 unavailable'))
        : Effect.succeed(enabled);
    },
    verifySelectedBinding: ({ binding }) => {
      calls.gatewayBindings.push(binding);
      const enabled = script.enabledGatewayBindings;
      if (enabled === OWNER_EVIDENCE_UNAVAILABLE) {
        return Effect.fail(ownerEvidenceUnavailable('GATEWAY_BINDING', 'Fixture: C17 unavailable'));
      }
      return Effect.succeed(
        enabled.some((candidate) => sameBinding(candidate, binding))
          ? { _tag: 'ENABLED' as const, binding }
          : { _tag: 'NOT_ENABLED' as const, binding },
      );
    },
  };
  const delivery: PaymentDeliveryCapabilityService = {
    verifyCashOnDelivery: ({ deliveryOfferRef }) => {
      calls.deliveryOffers.push(deliveryOfferRef);
      const answer = script.codCapability(deliveryOfferRef);
      return answer === OWNER_EVIDENCE_UNAVAILABLE
        ? Effect.fail(ownerEvidenceUnavailable('DELIVERY_CAPABILITY', 'Fixture: Delivery Offer owner unavailable'))
        : Effect.succeed(answer);
    },
  };
  const pickup: PaymentPickupCapabilityService = {
    verifyPickupCollection: ({ pickupCapabilityRef }) => {
      calls.pickupCapabilities.push(pickupCapabilityRef);
      const answer = script.pickupCapability(pickupCapabilityRef);
      return answer === OWNER_EVIDENCE_UNAVAILABLE
        ? Effect.fail(ownerEvidenceUnavailable('PICKUP_CAPABILITY', 'Fixture: pickup owner unavailable'))
        : Effect.succeed(answer);
    },
  };
  const layer = Layer.mergeAll(
    Layer.succeed(PaymentTermEvidencePort, termEvidence),
    Layer.succeed(GatewayBindingPort, gateway),
    Layer.succeed(DeliveryCapabilityPort, delivery),
    Layer.succeed(PickupCapabilityPort, pickup),
  );
  return { calls, layer };
};

export const GOPAY_PRODUCTION: PaymentGatewayAccountBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'gopay-merchant-1',
  providerFamily: 'GOPAY',
};
export const STRIPE_PRODUCTION: PaymentGatewayAccountBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'stripe-merchant-1',
  providerFamily: 'STRIPE',
};

export const codSupported = (deliveryOfferRef: string): PaymentCodCapability => ({
  _tag: 'SUPPORTED',
  capabilityEvidenceRef: `cod-capability:${deliveryOfferRef}`,
  deliveryOfferRef,
});
export const pickupSupported = (pickupCapabilityRef: string): PaymentPickupCollectionCapability => ({
  _tag: 'SUPPORTED',
  capabilityEvidenceRef: `pickup-capability:${pickupCapabilityRef}`,
  pickupCapabilityRef,
});
