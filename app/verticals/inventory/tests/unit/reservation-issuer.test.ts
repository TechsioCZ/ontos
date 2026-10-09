import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { InventoryReservationGuaranteeUnsupported } from '../../shared/domain/inventory-reservation-guarantee-unsupported.ts';
import {
  ReservationAuthorityConfirmedObservationSchema,
  ReservationAuthorityIssueRequestSchema,
  ReservationAuthorityObservationSchema,
  ReservationAuthorityUnavailable,
  ReservationEffectIndeterminate,
  ReservationIssuerEvidenceRejected,
} from '../../shared/domain/reservation-authority.ts';
import type { ReservationAuthorityIssuerPort } from '../../src/services/reservation-issuer.service.ts';
import { makeReservationIssuerService } from '../../src/services/reservation-issuer.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const stockItemId = '22222222-2222-4222-8222-222222222222';
const stockPositionId = '33333333-3333-4333-8333-333333333333';
const unitId = '44444444-4444-4444-8444-444444444444';
const validFrom = '2026-09-24T10:00:00.000Z';
const validUntil = '2026-09-24T10:15:00.000Z';
const decodeConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema, {
  onExcessProperty: 'error',
});
const decodeRequest = Schema.decodeUnknownSync(ReservationAuthorityIssueRequestSchema, {
  onExcessProperty: 'error',
});
const decodeObservation = Schema.decodeUnknownSync(ReservationAuthorityObservationSchema, {
  onExcessProperty: 'error',
});
const decodeConfirmedObservation = Schema.decodeUnknownSync(ReservationAuthorityConfirmedObservationSchema, {
  onExcessProperty: 'error',
});

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const allocation = {
  allocationId: 'allocation-1',
  quantity: { amount: '2.5', unitRef },
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: stockItemId,
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  stockPositionRef: {
    moduleId: 'commerce.inventory',
    resourceId: stockPositionId,
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
} as const;
const secondAllocation = {
  ...allocation,
  allocationId: 'allocation-2',
} as const;

const configurationFor = (
  backend: 'external_business_system' | 'ontos_wms',
  exactReservationCapability: 'SUPPORTED' | 'UNSUPPORTED' = 'SUPPORTED',
) =>
  decodeConfiguration({
    configurationId: '55555555-5555-4555-8555-555555555555',
    customerConfigurationId: 'customer-configuration-1',
    revision: 1,
    selectedAt: '2026-09-24T09:00:00.000Z',
    selection: {
      backend,
      backendId: backend === 'external_business_system' ? 'erp-primary' : 'ontos-wms-primary',
      exactReservationCapability,
      stockCorrectionCapability: backend === 'ontos_wms' ? 'SUPPORTED' : 'UNSUPPORTED',
    },
    tenantId,
  });

const requestFor = (
  backend: 'external_business_system' | 'ontos_wms',
  operation: 'RESERVATION_CONFIRMATION' | 'COMMITMENT_PROTECTION' = 'RESERVATION_CONFIRMATION',
) =>
  decodeRequest({
    configuration: configurationFor(backend),
    effectId: `effect:${operation.toLowerCase()}:attempt-1`,
    operation,
    reservation: {
      allocations: [allocation],
      attemptId: 'attempt-1',
      reservationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId,
    },
  });

const confirmedObservation = (
  request: ReturnType<typeof requestFor>,
  overrides: Partial<typeof ReservationAuthorityConfirmedObservationSchema.Encoded> = {},
) =>
  decodeConfirmedObservation({
    effectId: request.effectId,
    evidence: {
      allocations: request.reservation.allocations,
      attemptId: request.reservation.attemptId,
      customerConfigurationId: request.configuration.customerConfigurationId,
      ownerEvidenceRef: `owner-proof:${request.operation.toLowerCase()}:1`,
      reservationId: request.reservation.reservationId,
      tenantId: request.reservation.tenantId,
      validFrom,
      validUntil,
    },
    issuer: {
      backend: request.configuration.selection.backend,
      backendId: request.configuration.selection.backendId,
      origin:
        request.configuration.selection.backend === 'external_business_system'
          ? 'EXTERNAL_BUSINESS_SYSTEM'
          : 'ONTOS_WMS',
    },
    kind: 'CONFIRMED',
    operation: request.operation,
    ...overrides,
  });

const portReturning = (observation: ReturnType<typeof decodeObservation>): ReservationAuthorityIssuerPort => ({
  issue: () => Effect.succeed(observation),
});

describe('Inventory Reservation issuer', () => {
  it('rejects duplicate Allocation identities within one exact Reservation scope', () => {
    const request = requestFor('external_business_system');

    expect(() =>
      decodeRequest({
        ...request,
        reservation: { ...request.reservation, allocations: [allocation, allocation] },
      }),
    ).toThrow();
  });

  it.effect('preserves the selected External Business System as the sole Confirmation issuer', () =>
    Effect.gen(function* issueExternalConfirmation() {
      const request = requestFor('external_business_system');
      const evidence = yield* makeReservationIssuerService(portReturning(confirmedObservation(request))).issue(request);

      expect(evidence).toEqual({
        effectId: request.effectId,
        evidence: {
          allocations: [allocation],
          attemptId: 'attempt-1',
          customerConfigurationId: 'customer-configuration-1',
          ownerEvidenceRef: 'owner-proof:reservation_confirmation:1',
          reservationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId,
          validFrom,
          validUntil,
        },
        issuer: {
          backend: 'external_business_system',
          backendId: 'erp-primary',
          origin: 'EXTERNAL_BUSINESS_SYSTEM',
        },
        kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
        operation: 'RESERVATION_CONFIRMATION',
      });
    }),
  );

  it.effect('preserves OntOS WMS as the sole issuer when that backend is selected', () =>
    Effect.gen(function* issueWmsConfirmation() {
      const request = requestFor('ontos_wms');
      const evidence = yield* makeReservationIssuerService(portReturning(confirmedObservation(request))).issue(request);

      expect(evidence.issuer).toEqual({
        backend: 'ontos_wms',
        backendId: 'ontos-wms-primary',
        origin: 'ONTOS_WMS',
      });
    }),
  );

  it.effect('returns typed no-guarantee non-success without fabricating proof or fallback', () =>
    Effect.gen(function* rejectUnsupportedGuarantee() {
      const supportedRequest = requestFor('external_business_system');
      const request = decodeRequest({
        ...supportedRequest,
        configuration: configurationFor('external_business_system', 'UNSUPPORTED'),
      });
      const failure = yield* makeReservationIssuerService(portReturning(confirmedObservation(supportedRequest)))
        .issue(request)
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(InventoryReservationGuaranteeUnsupported);
      expect(failure).toMatchObject({
        fallbackApplied: false,
        proofIssued: false,
        selectedBackendId: 'erp-primary',
      });
    }),
  );

  it.effect('keeps authority unavailability distinct and does not claim the effect is absent', () =>
    Effect.gen(function* reportUnavailableAuthority() {
      const request = requestFor('external_business_system');
      const port = portReturning(
        decodeObservation({
          effectAbsenceProven: false,
          effectId: request.effectId,
          kind: 'UNAVAILABLE',
          recovery: 'VERIFY_OR_RECOVER_ORIGINAL_EFFECT',
        }),
      );
      const failure = yield* makeReservationIssuerService(port).issue(request).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ReservationAuthorityUnavailable);
      expect(failure).toMatchObject({
        effectAbsenceProven: false,
        fallbackApplied: false,
        originalEffectId: request.effectId,
        proofIssued: false,
        selectedBackend: 'external_business_system',
        selectedBackendId: 'erp-primary',
      });
    }),
  );

  it.effect('preserves an indeterminate original effect and forbids a competing fresh Reservation', () =>
    Effect.gen(function* preserveIndeterminateEffect() {
      const request = requestFor('external_business_system');
      const port = portReturning(
        decodeObservation({
          competingFreshEffectAllowed: false,
          effectId: request.effectId,
          kind: 'INDETERMINATE',
          recovery: 'RECOVER_ORIGINAL_EFFECT',
        }),
      );
      const failure = yield* makeReservationIssuerService(port).issue(request).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ReservationEffectIndeterminate);
      expect(failure).toMatchObject({
        competingFreshEffectAllowed: false,
        fallbackApplied: false,
        originalEffectId: request.effectId,
        proofIssued: false,
        recovery: 'RECOVER_ORIGINAL_EFFECT',
      });
    }),
  );

  it.effect('binds Commitment Protection to the same selected issuer and exact Reservation scope', () =>
    Effect.gen(function* issueCommitmentProtection() {
      const request = requestFor('external_business_system', 'COMMITMENT_PROTECTION');
      const evidence = yield* makeReservationIssuerService(portReturning(confirmedObservation(request))).issue(request);

      expect(evidence).toMatchObject({
        effectId: request.effectId,
        evidence: {
          allocations: [allocation],
          attemptId: 'attempt-1',
          customerConfigurationId: 'customer-configuration-1',
          reservationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId,
        },
        issuer: {
          backend: 'external_business_system',
          backendId: 'erp-primary',
          origin: 'EXTERNAL_BUSINESS_SYSTEM',
        },
        operation: 'COMMITMENT_PROTECTION',
      });
    }),
  );

  it.effect('rejects proof whose issuer, effect or exact Reservation scope differs from the request', () =>
    Effect.gen(function* rejectFabricatedOrMismatchedEvidence() {
      const request = requestFor('external_business_system');
      const observations = [
        confirmedObservation(request, {
          issuer: { backend: 'ontos_wms', backendId: 'ontos-wms-primary', origin: 'ONTOS_WMS' },
        }),
        confirmedObservation(request, { effectId: 'effect:different' }),
        decodeObservation({
          competingFreshEffectAllowed: false,
          effectId: 'effect:different',
          kind: 'INDETERMINATE',
          recovery: 'RECOVER_ORIGINAL_EFFECT',
        }),
        confirmedObservation(request, {
          evidence: {
            ...confirmedObservation(request).evidence,
            reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        }),
      ];

      for (const observation of observations) {
        const failure = yield* makeReservationIssuerService(portReturning(observation))
          .issue(request)
          .pipe(Effect.flip);
        expect(failure).toBeInstanceOf(ReservationIssuerEvidenceRejected);
        expect(failure).toMatchObject({ fallbackApplied: false, proofIssued: false });
      }
    }),
  );

  it.effect('rejects evidence with different Allocation multiplicity from the exact Reservation scope', () =>
    Effect.gen(function* rejectAllocationMultiplicityMismatch() {
      const base = requestFor('external_business_system');
      const request = decodeRequest({
        ...base,
        reservation: { ...base.reservation, allocations: [allocation, secondAllocation] },
      });
      const observation = confirmedObservation(request, {
        evidence: {
          ...confirmedObservation(request).evidence,
          allocations: [allocation],
        },
      });
      const failure = yield* makeReservationIssuerService(portReturning(observation)).issue(request).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ReservationIssuerEvidenceRejected);
      expect(failure).toMatchObject({ reason: 'EXACT_RESERVATION_SCOPE_MISMATCH' });
    }),
  );

  it.effect('rejects an invalid or already-ended proof validity boundary', () =>
    Effect.gen(function* rejectInvalidValidity() {
      const request = requestFor('external_business_system');
      const observation = confirmedObservation(request, {
        evidence: {
          ...confirmedObservation(request).evidence,
          validFrom: validUntil,
          validUntil: validFrom,
        },
      });
      const failure = yield* makeReservationIssuerService(portReturning(observation)).issue(request).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ReservationIssuerEvidenceRejected);
      expect(failure).toMatchObject({ reason: 'INVALID_PROOF_VALIDITY' });
    }),
  );
});
