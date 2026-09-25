import type { OperationalScope } from '@app/core-runtime';
import {
  ReadHandlerNotFound,
  ReadPermissionDenied,
  allowOwnerAuthorizationOverlay,
  toBusinessPermissionAccessKey,
} from '@app/core-runtime';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { expect, it } from 'effect-rstest';
import { Effect, Option, Predicate, Schema } from 'effect';

import { mapInventoryReservationDetailDomainError } from '../../api/inventory-reservation-detail-read-server.ts';
import { mapReservationConfirmationVerificationDomainError } from '../../api/reservation-confirmation-verification-read-server.ts';
import {
  InventoryReservationDetailDomainConflictProblemSchema,
  InventoryReservationDetailDomainPolicyProblemSchema,
  InventoryReservationDetailDomainUnavailableProblemSchema,
  InventoryReservationDetailRequestSchema,
} from '../../shared/apis/inventory-reservation-detail.ts';
import {
  ReservationConfirmationVerificationDomainConflictProblemSchema,
  ReservationConfirmationVerificationDomainPolicyProblemSchema,
  ReservationConfirmationVerificationDomainUnavailableProblemSchema,
  ReservationConfirmationVerificationRequestSchema,
} from '../../shared/apis/reservation-confirmation-verification.ts';
import {
  EstablishInventoryReservationInputSchema,
  InventoryObligationRejected,
  establishInventoryReservation,
} from '../../shared/domain/inventory-obligation.ts';
import type { ProvisionalInventoryReservation } from '../../shared/domain/inventory-obligation.ts';
import {
  ReservationConfirmationRejected,
  ReservationConfirmationSchema,
  ReservationConfirmationUnavailable,
} from '../../shared/domain/reservation-confirmation.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { InventoryObligationPersistenceUnavailable } from '../../src/persistence/inventory-obligation-repository.ts';
import {
  inventoryReservationDetailRead,
  readInventoryReservationDetail,
} from '../../src/api/inventory-reservation-detail.read.ts';
import {
  reservationConfirmationVerificationRead,
  verifyReservationConfirmation,
} from '../../src/api/reservation-confirmation-verification.read.ts';
import { getReadPermissionTargetResolver } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const confirmationId = '33333333-3333-4333-8333-333333333333';
const itemId = '77777777-7777-4777-8777-777777777777';
const unitId = '88888888-8888-4888-8888-888888888888';
const positionId = '99999999-9999-4999-8999-999999999999';
const bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const attemptId = 'attempt-checkout-1';
const issuedAt = '2026-09-24T10:00:00.000Z';
const expiresAt = '2026-09-24T10:15:00.000Z';
const scope = {
  authBindingId: '44444444-4444-4444-8444-444444444444',
  authContextRef: 'better-auth-session:inventory-reservation-governed-reads',
  authMethod: 'session',
  correlationId: 'inventory-reservation-governed-reads',
  legalEntityId: '55555555-5555-4555-8555-555555555555',
  principalId: '66666666-6666-4666-8666-666666666666',
  tenantId,
} as const satisfies OperationalScope;
const principal = {
  authBindingId: scope.authBindingId,
  authContextRef: scope.authContextRef,
  authMethod: scope.authMethod,
  legalEntityId: scope.legalEntityId,
  principalId: scope.principalId,
  tenantId,
};

const reservationRef = {
  moduleId: 'commerce.inventory',
  resourceId: reservationId,
  resourceType: 'commerce.inventory.inventory-reservation',
  tenantId,
} as const;

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;

const itemRef = {
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
} as const;

const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const catalogSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: issuedAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});

const makeReservation = () =>
  establishInventoryReservation(
    Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema)({
      authority: {
        configurationId: 'inventory-owner-primary',
        customerConfigurationId: 'customer-configuration-primary',
        revision: 1,
        selectedAt: '2026-09-24T09:00:00.000Z',
        selection: {
          backend: 'external_business_system',
          backendId: 'erp-primary',
          exactReservationCapability: 'SUPPORTED',
          stockCorrectionCapability: 'UNSUPPORTED',
        },
        tenantId,
      },
      establishedAt: issuedAt,
      origin: { attemptId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
      ref: reservationRef,
      requirements: [
        {
          allocations: [
            {
              allocationId: 'allocation-1',
              positionRef: {
                moduleId: 'commerce.inventory',
                resourceId: positionId,
                resourceType: 'commerce.inventory.stock-position',
                tenantId,
              },
              quantity: { amount: '2', unitRef },
              stockItemRef: itemRef,
            },
          ],
          bindingRef: {
            moduleId: 'commerce.inventory',
            resourceId: bindingId,
            resourceType: 'commerce.inventory.catalog-to-stock-binding',
            tenantId,
          },
          catalogSelection,
          exactSelectionMeaning,
          purchaseDemandOccurrenceId: 'demand-occurrence-1',
          quantity: '2',
          stockItem,
          unitRef,
        },
      ],
    }),
  );

const confirmationFor = (reservation: ProvisionalInventoryReservation) =>
  Schema.decodeUnknownSync(ReservationConfirmationSchema)({
    authorityEvidence: {
      effectId: 'effect:confirmation:attempt-1',
      evidence: {
        allocations: reservation.requirements.flatMap(({ allocations }) =>
          allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
            allocationId,
            quantity,
            stockItemRef,
            stockPositionRef: positionRef,
          })),
        ),
        attemptId,
        customerConfigurationId: reservation.authority.customerConfigurationId,
        ownerEvidenceRef: 'owner-proof:confirmation:1',
        reservationId,
        tenantId,
        validFrom: issuedAt,
        validUntil: expiresAt,
      },
      issuer: {
        backend: 'external_business_system',
        backendId: 'erp-primary',
        origin: 'EXTERNAL_BUSINESS_SYSTEM',
      },
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: 'RESERVATION_CONFIRMATION',
    },
    expiresAt,
    health: {
      observation: { _tag: 'ISSUED', effectiveAt: issuedAt, ownerEvidenceRef: 'owner-proof:confirmation:1' },
      state: 'VALID',
    },
    issuanceRank: {
      issuedAt,
      ownerEvidenceRef: 'owner-proof:confirmation:1',
      source: 'RESERVATION_AUTHORITY_EVIDENCE',
    },
    issuedAt,
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: confirmationId,
      resourceType: 'commerce.inventory.reservation-confirmation',
      tenantId,
    },
    reservation,
    revision: 1,
  });

it('binds both reads to inventory.resource.read for the exact requested ResourceRef', () => {
  const reservationInput = Schema.decodeUnknownSync(InventoryReservationDetailRequestSchema)({ reservationRef });
  const confirmationInput = Schema.decodeUnknownSync(ReservationConfirmationVerificationRequestSchema)({
    attemptId,
    confirmationRef: {
      moduleId: 'commerce.inventory',
      resourceId: confirmationId,
      resourceType: 'commerce.inventory.reservation-confirmation',
      tenantId,
    },
    evaluatedAt: '2026-09-24T10:05:00.000Z',
    reservationRef,
  });

  expect(inventoryReservationDetailRead.descriptor.permissionTarget).toBe('business_permission');
  const reservationResolver = getReadPermissionTargetResolver(inventoryReservationDetailRead);
  expect(Predicate.isFunction(reservationResolver)).toBe(true);
  if (Predicate.isFunction(reservationResolver)) {
    expect(reservationResolver(reservationInput, scope)).toEqual({
      businessPermission: {
        permission: 'inventory.resource.read',
        target: {
          kind: 'inventory_resource',
          resource: {
            moduleId: reservationRef.moduleId,
            resourceId: reservationRef.resourceId,
            resourceType: reservationRef.resourceType,
          },
          tenantId,
        },
      },
      kind: 'business_permission',
    });
  }

  expect(reservationConfirmationVerificationRead.descriptor.permissionTarget).toBe('business_permission');
  const confirmationResolver = getReadPermissionTargetResolver(reservationConfirmationVerificationRead);
  expect(Predicate.isFunction(confirmationResolver)).toBe(true);
  if (Predicate.isFunction(confirmationResolver)) {
    expect(confirmationResolver(confirmationInput, scope)).toEqual({
      businessPermission: {
        permission: 'inventory.resource.read',
        target: {
          kind: 'inventory_resource',
          resource: {
            moduleId: confirmationInput.confirmationRef.moduleId,
            resourceId: confirmationInput.confirmationRef.resourceId,
            resourceType: confirmationInput.confirmationRef.resourceType,
          },
          tenantId,
        },
      },
      kind: 'business_permission',
    });
  }
});

it.effect('reads the exact Reservation with bounded evidence and returns typed not found', () =>
  Effect.gen(function* readReservation() {
    const reservation = yield* makeReservation();
    const input = Schema.decodeUnknownSync(InventoryReservationDetailRequestSchema)({ reservationRef });
    const found = yield* readInventoryReservationDetail(input, {
      readKey: inventoryReservationDetailRead.descriptor.readKey,
      scope,
      services: { read: () => Effect.succeed(Option.some(reservation)) },
    });
    const missing = yield* readInventoryReservationDetail(input, {
      readKey: inventoryReservationDetailRead.descriptor.readKey,
      scope,
      services: { read: () => Effect.succeed(Option.none()) },
    }).pipe(Effect.flip);

    expect(found).toEqual({ evidence: { resultCount: 1 }, result: { reservation } });
    expect(Schema.is(ReadHandlerNotFound)(missing)).toBe(true);
  }),
);

it.effect('denies the exact Inventory Resource before opening owner persistence or producing evidence', () =>
  Effect.gen(function* denyBeforeOwnerPersistence() {
    let databaseCalls = 0;
    const stages: string[] = [];
    const database = {
      executor: yield* makeTestDatabase(() => {
        databaseCalls += 1;
        return Effect.succeed([]);
      }),
    };
    const runtime = makeReadRuntime(
      database,
      openModuleEntrypointGateway,
      { resolve: () => Effect.succeed(scope) },
      {
        businessPermissions: ({ targets }) =>
          Effect.succeed(
            targets.map((target) => ({
              decision: 'denied' as const,
              key: toBusinessPermissionAccessKey(target),
            })),
          ),
        legalEntities: ({ legalEntityIds }) =>
          Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
        modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
        resources: ({ resources }) =>
          Effect.succeed(
            resources.map((resource) => ({
              decision: 'allowed' as const,
              key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
            })),
          ),
        tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
      },
      {
        onStage: (stage) => {
          stages.push(stage);
        },
        ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      },
    );
    const input = Schema.decodeUnknownSync(InventoryReservationDetailRequestSchema)({ reservationRef });
    const failure = yield* runtime
      .runRead({
        input,
        principal,
        registration: inventoryReservationDetailRead,
        transport: { correlationId: scope.correlationId },
      })
      .pipe(Effect.flip);

    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    expect(databaseCalls).toBe(1);
    expect(stages).toEqual(['input_decoded', 'scope_validated', 'module_state_checked', 'permission_checked']);
  }),
);

it.effect('verifies the exact Confirmation, Reservation, and Attempt while preserving current health and history', () =>
  Effect.gen(function* verifyConfirmation() {
    const reservation = yield* makeReservation();
    const confirmation = confirmationFor(reservation);
    const input = Schema.decodeUnknownSync(ReservationConfirmationVerificationRequestSchema)({
      attemptId,
      confirmationRef: confirmation.ref,
      evaluatedAt: '2026-09-24T10:05:00.000Z',
      reservationRef,
    });
    const result = yield* verifyReservationConfirmation(input, {
      readKey: reservationConfirmationVerificationRead.descriptor.readKey,
      scope,
      services: {
        findByRef: () => Effect.succeed(Option.some(confirmation)),
        readHistory: () => Effect.succeed([confirmation]),
      },
    });
    const mismatch = yield* verifyReservationConfirmation(
      Schema.decodeUnknownSync(ReservationConfirmationVerificationRequestSchema)({
        ...input,
        attemptId: 'attempt-checkout-other',
      }),
      {
        readKey: reservationConfirmationVerificationRead.descriptor.readKey,
        scope,
        services: {
          findByRef: () => Effect.succeed(Option.some(confirmation)),
          readHistory: () => Effect.succeed([confirmation]),
        },
      },
    ).pipe(Effect.flip);

    expect(result).toEqual({
      evidence: { resultCount: 1 },
      result: {
        current: confirmation,
        evaluation: { outcome: 'READY_TO_ESTABLISH_PROTECTION' },
        health: confirmation.health,
        history: [confirmation],
      },
    });
    expect(mismatch).toMatchObject({ reason: 'RESERVATION_SCOPE_MISMATCH' });
  }),
);

it('maps durable conflicts, semantic rejection, and owner unavailability to typed 409/422/503 Problems', () => {
  const reservationConflict = mapInventoryReservationDetailDomainError(
    new InventoryObligationRejected({
      code: 'inventory_obligation_rejected',
      reason: 'OBLIGATION_IDENTITY_CONFLICT',
    }),
  );
  const reservationRejected = mapInventoryReservationDetailDomainError(
    new InventoryObligationRejected({
      code: 'inventory_obligation_rejected',
      reason: 'INVALID_PERSISTED_OBLIGATION',
    }),
  );
  const reservationUnavailable = mapInventoryReservationDetailDomainError(
    new InventoryObligationPersistenceUnavailable({
      code: 'inventory_obligation_persistence_unavailable',
      reason: 'private persistence detail',
    }),
  );
  const confirmationConflict = mapReservationConfirmationVerificationDomainError(
    new ReservationConfirmationRejected({
      code: 'reservation_confirmation_rejected',
      reason: 'RESERVATION_SCOPE_MISMATCH',
    }),
  );
  const confirmationRejected = mapReservationConfirmationVerificationDomainError(
    new ReservationConfirmationRejected({
      code: 'reservation_confirmation_rejected',
      reason: 'INVALID_CONFIRMATION',
    }),
  );
  const confirmationUnavailable = mapReservationConfirmationVerificationDomainError(
    new ReservationConfirmationUnavailable({
      code: 'reservation_confirmation_unavailable',
      reason: 'private owner detail',
      retryable: true,
    }),
  );

  expect(Schema.is(InventoryReservationDetailDomainConflictProblemSchema)(reservationConflict)).toBe(true);
  expect(Schema.is(InventoryReservationDetailDomainPolicyProblemSchema)(reservationRejected)).toBe(true);
  expect(Schema.is(InventoryReservationDetailDomainUnavailableProblemSchema)(reservationUnavailable)).toBe(true);
  expect(Schema.is(ReservationConfirmationVerificationDomainConflictProblemSchema)(confirmationConflict)).toBe(true);
  expect(Schema.is(ReservationConfirmationVerificationDomainPolicyProblemSchema)(confirmationRejected)).toBe(true);
  expect(Schema.is(ReservationConfirmationVerificationDomainUnavailableProblemSchema)(confirmationUnavailable)).toBe(
    true,
  );
  expect([
    reservationConflict.status,
    reservationRejected.status,
    reservationUnavailable.status,
    confirmationConflict.status,
    confirmationRejected.status,
    confirmationUnavailable.status,
  ]).toEqual([409, 422, 503, 409, 422, 503]);
  expect(JSON.stringify([reservationUnavailable, confirmationUnavailable])).not.toContain('private');
});
