import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { CurrentStockEvidenceForAvailabilityUnavailable } from '../../shared/domain/current-stock-evidence-for-availability.ts';
import type { ReservationCreateEffectForAvailability } from '../../shared/domain/current-stock-evidence-for-availability.ts';
import {
  IndeterminateReservationCreateEffectSchema,
  ReconciliationRequiredReservationCreateEffectSchema,
  RequestedReservationCreateEffectSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import { compareInventorySourceOrdering } from '../../shared/domain/inventory-source-ordering.ts';
import { InventorySourceAssertionIdSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { PhysicalStockEffectIdSchema } from '../../shared/domain/physical-stock-effect.ts';
import { CurrentSuccessfulAllocationQuantitySchema } from '../../shared/domain/stock-position.ts';
import { ImportedCommittedObligationRefSchema } from '../../shared/resources/imported-committed-obligation.ts';
import { InventoryReservationRefSchema } from '../../shared/resources/inventory-reservation.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';
import type { CurrentStockEvidenceForAvailabilityDependencies } from '../services/current-stock-evidence-for-availability.service.ts';
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Core invokes this adapter only inside the governed transaction-scoped Read factory; expires: 2027-03-31.
import { makeDrizzleCatalogToStockBindingPersistence } from './catalog-to-stock-binding-repository.ts';
import { inventoryBackendConfigurationPersistenceForScope } from './inventory-backend-configuration-repository.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryObligationPersistenceForScope } from './inventory-obligation-repository.ts';
import { inventoryObligationAllocations, inventoryObligations } from './inventory-obligation-table.ts';
import { inventorySourceAssertionPersistenceForScope } from './inventory-source-assertion-repository.ts';
import { inventorySourceImportLedger } from './inventory-source-import-ledger-table.ts';
import { physicalStockEffectPersistenceForScope } from './physical-stock-effect-repository.ts';
import { inventoryPhysicalStockEffects } from './physical-stock-effect-table.ts';
import { listUnresolvedReservationCreateEffects } from './reservation-create-effect-repository.ts';
import { inventoryReservationReleaseEffects } from './reservation-release-effect-table.ts';
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Core invokes this adapter only inside the governed transaction-scoped Read factory; expires: 2027-03-31.
import { makeDrizzleStockItemRepository } from './stock-item-repository.ts';
import { stockLocationPersistenceForScope } from './stock-location-repository.ts';
import { stockPositionPersistenceForScope } from './stock-position-repository.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = <Cause>(cause: Cause) => {
  const failure = new CurrentStockEvidenceForAvailabilityUnavailable({
    code: 'current_stock_evidence_for_availability_unavailable',
    reason: 'Current Stock evidence for Availability is temporarily unavailable',
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const mapUnavailable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CurrentStockEvidenceForAvailabilityUnavailable, R> =>
  effect.pipe(Effect.mapError((cause) => unavailable(cause)));

const requireTenant = (
  scope: OperationalScope,
  positionRef: StockPositionRef,
): Effect.Effect<void, CurrentStockEvidenceForAvailabilityUnavailable> =>
  positionRef.tenantId === scope.tenantId
    ? Effect.void
    : Effect.fail(unavailable('Stock Position Tenant does not match the trusted operation scope'));

const storedNumericPattern = /^(?<integer>[0-9]+)(?:\.(?<fraction>[0-9]+))?$/u;
const canonicalAmount = (amount: string): string => {
  const groups = storedNumericPattern.exec(amount)?.groups;
  if (groups?.['integer'] === undefined) {
    return amount;
  }
  const integer = BigInt(groups['integer']).toString();
  const fraction = (groups['fraction'] ?? '').replace(/0+$/u, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

export const currentStockEvidenceForAvailabilityDependenciesForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): CurrentStockEvidenceForAvailabilityDependencies => {
  const authorities = inventoryBackendConfigurationPersistenceForScope(transaction, scope);
  const bindings = makeDrizzleCatalogToStockBindingPersistence(transaction);
  const stockItems = makeDrizzleStockItemRepository(transaction);
  const stockLocations = stockLocationPersistenceForScope(transaction, scope);
  const positions = stockPositionPersistenceForScope(transaction, scope);
  const obligations = inventoryObligationPersistenceForScope(transaction, scope);
  const sourceAssertions = inventorySourceAssertionPersistenceForScope(transaction, scope);
  const physicalEffects = physicalStockEffectPersistenceForScope(transaction, scope);

  const readCommittedObligation = Effect.fn('CurrentStockEvidenceForAvailabilityPersistence.readCommittedObligation')(
    function* readCommitted(row: { readonly obligationId: string; readonly originKind: string }) {
      if (row.originKind === 'IMPORTED_PROVEN_ORDER') {
        const ref = yield* Schema.decodeEffect(ImportedCommittedObligationRefSchema)({
          moduleId: 'commerce.inventory',
          resourceId: row.obligationId,
          resourceType: 'commerce.inventory.imported-committed-obligation',
          tenantId: scope.tenantId,
        }).pipe(Effect.mapError(unavailable));
        const obligation = yield* mapUnavailable(obligations.read(ref));
        return yield* Effect.fromOption(obligation).pipe(
          Effect.mapError((cause) =>
            unavailable({ cause, reason: `Committed obligation ${row.obligationId} was not found` }),
          ),
        );
      }
      const ref = yield* Schema.decodeEffect(InventoryReservationRefSchema)({
        moduleId: 'commerce.inventory',
        resourceId: row.obligationId,
        resourceType: 'commerce.inventory.inventory-reservation',
        tenantId: scope.tenantId,
      }).pipe(Effect.mapError(unavailable));
      const obligation = yield* mapUnavailable(obligations.read(ref));
      return yield* Effect.fromOption(obligation).pipe(
        Effect.mapError((cause) =>
          unavailable({ cause, reason: `Committed obligation ${row.obligationId} was not found` }),
        ),
      );
    },
  );

  const listCommittedObligations: CurrentStockEvidenceForAvailabilityDependencies['listCommittedObligations'] =
    Effect.fn('CurrentStockEvidenceForAvailabilityPersistence.listCommittedObligations')(
      function* listCommitted(positionRef) {
        yield* requireTenant(scope, positionRef);
        const rows = yield* transaction
          .select({
            obligationId: inventoryObligations.obligationId,
            originKind: inventoryObligations.originKind,
          })
          .from(inventoryObligations)
          .innerJoin(
            inventoryObligationAllocations,
            and(
              eq(inventoryObligationAllocations.tenantId, inventoryObligations.tenantId),
              eq(inventoryObligationAllocations.obligationId, inventoryObligations.obligationId),
            ),
          )
          .where(
            and(
              eq(inventoryObligations.tenantId, scope.tenantId),
              eq(inventoryObligations.lifecycleMeaning, 'COMMITTED_OBLIGATION'),
              eq(inventoryObligationAllocations.stockPositionId, positionRef.resourceId),
            ),
          )
          .orderBy(asc(inventoryObligations.obligationId))
          .pipe(Effect.mapError(unavailable));
        const distinctRows = [
          ...new Map(rows.map((row) => [`${row.originKind}:${row.obligationId}`, row] as const)).values(),
        ];
        return yield* Effect.forEach(distinctRows, readCommittedObligation, { concurrency: 1 });
      },
    );

  const listCurrentSuccessfulAllocations: CurrentStockEvidenceForAvailabilityDependencies['listCurrentSuccessfulAllocations'] =
    Effect.fn('CurrentStockEvidenceForAvailabilityPersistence.listCurrentSuccessfulAllocations')(
      function* listCurrentAllocations(positionRef) {
        yield* requireTenant(scope, positionRef);
        const rows = yield* transaction
          .select({
            allocationId: inventoryObligationAllocations.allocationId,
            amount: inventoryObligationAllocations.allocatedAmount,
            unitResourceId: inventoryObligationAllocations.unitResourceId,
          })
          .from(inventoryObligationAllocations)
          .innerJoin(
            inventoryObligations,
            and(
              eq(inventoryObligations.tenantId, inventoryObligationAllocations.tenantId),
              eq(inventoryObligations.obligationId, inventoryObligationAllocations.obligationId),
            ),
          )
          .leftJoin(
            inventoryReservationReleaseEffects,
            and(
              eq(inventoryReservationReleaseEffects.tenantId, inventoryObligations.tenantId),
              eq(inventoryReservationReleaseEffects.reservationId, inventoryObligations.obligationId),
            ),
          )
          .where(
            and(
              eq(inventoryObligationAllocations.tenantId, scope.tenantId),
              eq(inventoryObligationAllocations.stockPositionId, positionRef.resourceId),
              eq(inventoryObligations.lifecycleMeaning, 'PROVISIONAL_RESERVATION'),
              or(
                isNull(inventoryReservationReleaseEffects.currentState),
                ne(inventoryReservationReleaseEffects.currentState, 'RELEASED'),
              ),
            ),
          )
          .orderBy(asc(inventoryObligationAllocations.allocationId))
          .pipe(Effect.mapError(unavailable));
        return yield* Schema.decodeEffect(Schema.Array(CurrentSuccessfulAllocationQuantitySchema))(
          rows.map((row) => ({
            allocationId: row.allocationId,
            positionRef,
            quantity: {
              amount: canonicalAmount(row.amount),
              unitRef: {
                moduleId: 'commerce.catalog',
                resourceId: row.unitResourceId,
                resourceType: 'commerce.catalog.product-unit',
                tenantId: scope.tenantId,
              },
            },
            status: 'CURRENT_SUCCESSFUL',
          })),
        ).pipe(Effect.mapError(unavailable));
      },
    );

  const listMaterialEffects: CurrentStockEvidenceForAvailabilityDependencies['listMaterialEffects'] = Effect.fn(
    'CurrentStockEvidenceForAvailabilityPersistence.listMaterialEffects',
  )(function* listMaterialPhysicalEffects(positionRef) {
    yield* requireTenant(scope, positionRef);
    const rows = yield* transaction
      .select({ effectId: inventoryPhysicalStockEffects.effectId })
      .from(inventoryPhysicalStockEffects)
      .where(
        and(
          eq(inventoryPhysicalStockEffects.tenantId, scope.tenantId),
          eq(inventoryPhysicalStockEffects.positionId, positionRef.resourceId),
          eq(inventoryPhysicalStockEffects.state, 'APPLIED'),
        ),
      )
      .orderBy(asc(inventoryPhysicalStockEffects.requestedAt), asc(inventoryPhysicalStockEffects.effectId))
      .pipe(Effect.mapError(unavailable));
    return yield* Effect.forEach(
      rows,
      ({ effectId }) =>
        Schema.decodeEffect(PhysicalStockEffectIdSchema)(effectId).pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((id) => mapUnavailable(physicalEffects.read(id))),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(unavailable(`Physical Stock effect ${effectId} was not found`)),
              onSome: Effect.succeed,
            }),
          ),
        ),
      { concurrency: 1 },
    );
  });

  const readLatestSourceAssertion: CurrentStockEvidenceForAvailabilityDependencies['readLatestSourceAssertion'] =
    Effect.fn('CurrentStockEvidenceForAvailabilityPersistence.readLatestSourceAssertion')(
      function* readLatestAcceptedAssertion(positionRef) {
        yield* requireTenant(scope, positionRef);
        const accepted = yield* transaction
          .select({
            assertionId: inventorySourceImportLedger.assertionId,
            orderingEvidence: inventorySourceImportLedger.proposalJson,
          })
          .from(inventorySourceImportLedger)
          .innerJoin(
            inventoryStockPositions,
            and(
              eq(inventoryStockPositions.tenantId, inventorySourceImportLedger.tenantId),
              eq(inventoryStockPositions.stockPositionId, inventorySourceImportLedger.positionId),
            ),
          )
          .innerJoin(
            inventoryBackendConfigurations,
            and(
              eq(inventoryBackendConfigurations.tenantId, inventoryStockPositions.tenantId),
              eq(inventoryBackendConfigurations.configurationId, inventoryStockPositions.ownerConfigurationId),
            ),
          )
          .where(
            and(
              eq(inventorySourceImportLedger.tenantId, scope.tenantId),
              eq(inventorySourceImportLedger.positionId, positionRef.resourceId),
              eq(inventorySourceImportLedger.status, 'ACCEPTED'),
              eq(inventorySourceImportLedger.customerConfigurationId, inventoryStockPositions.customerConfigurationId),
              eq(inventorySourceImportLedger.issuerBackendKind, inventoryBackendConfigurations.backendKind),
              eq(inventorySourceImportLedger.issuerBackendId, inventoryBackendConfigurations.backendId),
              eq(inventorySourceImportLedger.factMeaning, 'ABSOLUTE_PHYSICAL_ON_HAND'),
            ),
          )
          .pipe(Effect.mapError(unavailable));
        const [head, ...candidates] = accepted;
        if (head === undefined) {
          return Option.none();
        }
        let latest = head;
        for (const candidate of candidates) {
          if (
            compareInventorySourceOrdering(
              candidate.orderingEvidence.orderingEvidence,
              latest.orderingEvidence.orderingEvidence,
            ) === 'NEWER'
          ) {
            latest = candidate;
          }
        }
        const assertionId = yield* Schema.decodeEffect(InventorySourceAssertionIdSchema)(latest.assertionId).pipe(
          Effect.mapError(unavailable),
        );
        const assertion = yield* mapUnavailable(sourceAssertions.findById(assertionId));
        return yield* Option.match(assertion, {
          onNone: () => Effect.fail(unavailable(`Accepted source assertion ${latest.assertionId} was not found`)),
          onSome: Effect.succeedSome,
        });
      },
    );

  const findAuthority: CurrentStockEvidenceForAvailabilityDependencies['findAuthority'] = (customerConfigurationId) =>
    mapUnavailable(authorities.findCurrent(customerConfigurationId));

  const findBinding: CurrentStockEvidenceForAvailabilityDependencies['findBinding'] = (position) =>
    requireTenant(scope, position.ref).pipe(
      Effect.flatMap(() => mapUnavailable(bindings.findCurrentByStockItem(position.scope.stockItemRef))),
    );

  const findStockItem: CurrentStockEvidenceForAvailabilityDependencies['findStockItem'] = (position) =>
    requireTenant(scope, position.ref).pipe(
      Effect.flatMap(() => mapUnavailable(stockItems.findById(scope.tenantId, position.scope.stockItemRef.resourceId))),
    );

  const findStockLocation: CurrentStockEvidenceForAvailabilityDependencies['findStockLocation'] = (position) =>
    requireTenant(scope, position.ref).pipe(
      Effect.flatMap(() => mapUnavailable(stockLocations.read(position.scope.stockLocationRef))),
    );

  const readPosition: CurrentStockEvidenceForAvailabilityDependencies['readPosition'] = (positionRef) =>
    requireTenant(scope, positionRef).pipe(Effect.flatMap(() => mapUnavailable(positions.read(positionRef))));

  const unresolvedCreateEffects: CurrentStockEvidenceForAvailabilityDependencies['unresolvedCreateEffects'] =
    mapUnavailable(listUnresolvedReservationCreateEffects(transaction, scope)).pipe(
      Effect.map((effects) =>
        effects.filter(
          (effect): effect is ReservationCreateEffectForAvailability =>
            Schema.is(RequestedReservationCreateEffectSchema)(effect) ||
            Schema.is(ReconciliationRequiredReservationCreateEffectSchema)(effect) ||
            Schema.is(IndeterminateReservationCreateEffectSchema)(effect),
        ),
      ),
    );

  return Object.freeze({
    findAuthority,
    findBinding,
    findStockItem,
    findStockLocation,
    listCommittedObligations,
    listCurrentSuccessfulAllocations,
    listMaterialEffects,
    readLatestSourceAssertion,
    readPosition,
    unresolvedCreateEffects,
  });
};
