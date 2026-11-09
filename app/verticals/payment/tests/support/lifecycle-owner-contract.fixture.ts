import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Effect, Layer, Ref, Schema } from 'effect';

import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../../src/ports/commitment-outcome-port.ts';
import { DeliveryCapabilityPort, unavailableDeliveryCapability } from '../../src/ports/delivery-capability-port.ts';
import { GatewayBindingPort } from '../../src/ports/gateway-binding-port.ts';
import { ownerEvidenceUnavailable } from '../../src/ports/owner-evidence-unavailable.ts';
import { PaymentTermEvidencePort } from '../../src/ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort, unavailablePickupCapability } from '../../src/ports/pickup-capability-port.ts';
import { RefundableItemsPort, unavailableRefundableItems } from '../../src/ports/refundable-items-port.ts';

/**
 * PUBLIC-CONTRACT FIXTURES for the lifecycle lane (#1148). They stand in only for the future C15/CCC
 * Payment Term evidence route and the C17 Gateway Enablement route, through the foundation owner ports.
 * Payment itself (Actions, Reads, persistence, PostgreSQL) is never faked. The fixture state is
 * mutable so a test can change owner configuration after a Payment exists and prove history is kept.
 */
export interface LifecycleOwnerContractState {
  /** Gateway bindings C17 Currently enables; anything else is NOT_ENABLED. */
  readonly enabledBindings: readonly PaymentGatewayAccountBinding[];
  /** False simulates a C17 outage: verification fails as owner evidence unavailable. */
  readonly gatewayAvailable: boolean;
  /** C15 metadata revision of the published snapshot; a metadata change keeps the semantic identity. */
  readonly metadataRevision: number;
  /** Term evidence answer: usable, definitively not usable, or an outage. */
  readonly termUse: 'NOT_USABLE' | 'UNAVAILABLE' | 'USABLE';
}

export const LIFECYCLE_GATEWAY_BINDING: PaymentGatewayAccountBinding = Object.freeze({
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'gopay-account-primary',
  providerFamily: 'GOPAY',
});

export const lifecycleTermSnapshot = (
  paymentTermRef: PaymentTermRef,
  metadataRevision: number,
): PaymentTermDefinitionSnapshot =>
  Schema.decodeSync(PaymentTermDefinitionSnapshotSchema)({
    code: 'IMMEDIATE',
    compatibilityId: 'immediate.v2',
    definitionRevisionId: '55555555-5555-4555-8555-555555555555',
    lifecycle: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
    metadataRevision,
    name: `Immediate (metadata ${metadataRevision})`,
    paymentTermRef,
    semanticFingerprint: 'f'.repeat(64),
    semanticRevisionId: '66666666-6666-4666-8666-666666666666',
    semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
  });

const sameBinding = (left: PaymentGatewayAccountBinding, right: PaymentGatewayAccountBinding) =>
  left.environment === right.environment &&
  left.providerAccountRef === right.providerAccountRef &&
  left.providerFamily === right.providerFamily;

/** Builds the owner-port layer over one mutable public-contract fixture state. */
export const makeLifecycleOwnerContractFixture = Effect.fn('LifecycleOwnerContractFixture.make')(
  function* makeLifecycleOwnerContractFixture(initial: LifecycleOwnerContractState) {
    const state = yield* Ref.make(initial);
    const layer = Layer.mergeAll(
      Layer.succeed(PaymentTermEvidencePort, {
        verifyTermUse: ({ paymentTermRef }) =>
          Ref.get(state).pipe(
            Effect.flatMap(({ metadataRevision, termUse }) => {
              if (termUse === 'UNAVAILABLE') {
                return Effect.fail(ownerEvidenceUnavailable('PAYMENT_TERM_EVIDENCE', 'Fixture: C15/CCC route is down'));
              }
              return Effect.succeed(
                termUse === 'USABLE'
                  ? {
                      _tag: 'USABLE' as const,
                      entitlementEvidenceRef: `ccc-entitlement-${paymentTermRef.resourceId}`,
                      paymentTermRef,
                      semanticSnapshot: lifecycleTermSnapshot(paymentTermRef, metadataRevision),
                    }
                  : { _tag: 'NOT_USABLE' as const, paymentTermRef, reason: 'ENTITLEMENT_NOT_CURRENT' as const },
              );
            }),
          ),
      }),
      Layer.succeed(GatewayBindingPort, {
        listEnabledBindings: () =>
          Ref.get(state).pipe(
            Effect.flatMap(({ enabledBindings, gatewayAvailable }) =>
              gatewayAvailable
                ? Effect.succeed(enabledBindings)
                : Effect.fail(ownerEvidenceUnavailable('GATEWAY_BINDING', 'Fixture: C17 route is down')),
            ),
          ),
        verifySelectedBinding: ({ binding }) =>
          Ref.get(state).pipe(
            Effect.flatMap(({ enabledBindings, gatewayAvailable }) => {
              if (!gatewayAvailable) {
                return Effect.fail(ownerEvidenceUnavailable('GATEWAY_BINDING', 'Fixture: C17 route is down'));
              }
              const enabled = enabledBindings.some((candidate) => sameBinding(candidate, binding));
              return Effect.succeed(
                enabled ? { _tag: 'ENABLED' as const, binding } : { _tag: 'NOT_ENABLED' as const, binding },
              );
            }),
          ),
      }),
      Layer.succeed(DeliveryCapabilityPort, unavailableDeliveryCapability),
      Layer.succeed(PickupCapabilityPort, unavailablePickupCapability),
      Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
      Layer.succeed(RefundableItemsPort, unavailableRefundableItems),
    );
    return {
      layer,
      update: (change: (current: LifecycleOwnerContractState) => LifecycleOwnerContractState) =>
        Ref.update(state, change),
    };
  },
);
