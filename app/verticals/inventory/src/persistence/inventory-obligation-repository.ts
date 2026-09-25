import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  ImportedCommittedObligationSchema,
  InventoryObligationRejected,
  InventoryObligationSchema,
  ProvisionalInventoryReservationSchema,
  RuntimeCommittedInventoryObligationSchema,
} from '../../shared/domain/inventory-obligation.ts';
import type {
  ImportedCommittedObligation,
  InventoryObligation,
  ProvisionalInventoryReservation,
  RuntimeCommittedInventoryObligation,
} from '../../shared/domain/inventory-obligation.ts';
import { InventoryObligationPersistenceUnavailable } from '../../shared/domain/inventory-obligation-persistence-unavailable.ts';
import type { ImportedCommittedObligationRef } from '../../shared/resources/imported-committed-obligation.ts';
import type { InventoryReservationRef } from '../../shared/resources/inventory-reservation.ts';
import {
  inventoryObligationAllocations,
  inventoryObligationCoverageTriggerContract,
  inventoryObligationRequirements,
  inventoryObligations,
  inventoryObligationScopeTriggerContract,
} from './inventory-obligation-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type ObligationRow = typeof inventoryObligations.$inferSelect;
type RequirementRow = typeof inventoryObligationRequirements.$inferSelect;
type AllocationRow = typeof inventoryObligationAllocations.$inferSelect;
const INVENTORY_MODULE_ID = 'commerce.inventory' as const;
const INVENTORY_RESERVATION_RESOURCE_TYPE = 'commerce.inventory.inventory-reservation' as const;
const STOCK_ITEM_RESOURCE_TYPE = 'commerce.inventory.stock-item' as const;
const STOCK_POSITION_RESOURCE_TYPE = 'commerce.inventory.stock-position' as const;
const CATALOG_BINDING_RESOURCE_TYPE = 'commerce.inventory.catalog-to-stock-binding' as const;

export { InventoryObligationPersistenceUnavailable } from '../../shared/domain/inventory-obligation-persistence-unavailable.ts';

export type InventoryObligationPersistenceError =
  | InventoryObligationRejected
  | InventoryObligationPersistenceUnavailable;

export interface InventoryReservationEstablishment {
  readonly obligation: ProvisionalInventoryReservation;
  readonly outcome: 'ESTABLISHED' | 'EXACT_REPLAY';
}

export interface ImportedObligationEstablishment {
  readonly obligation: ImportedCommittedObligation;
  readonly outcome: 'IMPORTED' | 'EXACT_REPLAY';
}

export interface RuntimeCommittedObligationTransition {
  readonly obligation: RuntimeCommittedInventoryObligation;
  readonly outcome: 'COMMITTED' | 'EXACT_REPLAY';
}

export interface InventoryObligationPersistence {
  readonly commitReservation: (
    obligation: RuntimeCommittedInventoryObligation,
  ) => Effect.Effect<RuntimeCommittedObligationTransition, InventoryObligationPersistenceError>;
  readonly establishReservation: (
    obligation: ProvisionalInventoryReservation,
  ) => Effect.Effect<InventoryReservationEstablishment, InventoryObligationPersistenceError>;
  readonly importCommitted: (
    obligation: ImportedCommittedObligation,
  ) => Effect.Effect<ImportedObligationEstablishment, InventoryObligationPersistenceError>;
  readonly read: (
    ref: ImportedCommittedObligationRef | InventoryReservationRef,
  ) => Effect.Effect<Option.Option<InventoryObligation>, InventoryObligationPersistenceError>;
}

const unavailable = (cause?: unknown) => {
  const failure = new InventoryObligationPersistenceUnavailable({
    code: 'inventory_obligation_persistence_unavailable',
    reason: 'Inventory obligation persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const reject = (reason: InventoryObligationRejected['reason'], _obligationId?: string) =>
  new InventoryObligationRejected({ code: 'inventory_obligation_rejected', reason });

const uniqueViolationSqlState = ['23', '505'].join('');
const foreignKeyViolationSqlState = ['23', '503'].join('');
const checkViolationSqlState = ['23', '514'].join('');

export const mapInventoryObligationWriteError = (
  cause: unknown,
  obligationId?: string,
): InventoryObligationPersistenceError => {
  const attempt = findPostgresFailure(
    cause,
    ({ code, constraint }) => code === uniqueViolationSqlState && constraint === 'inventory_obligations_attempt_uk',
  );
  if (Option.isSome(attempt)) {
    return reject('ATTEMPT_ALREADY_BOUND', obligationId);
  }
  const importedLineage = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_obligations_imported_lineage_uk',
  );
  if (Option.isSome(importedLineage)) {
    return reject('SOURCE_LINEAGE_ALREADY_IMPORTED', obligationId);
  }
  const commitBinding = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      (code === uniqueViolationSqlState && constraint === 'inventory_obligations_runtime_accepted_order_uk') ||
      (code === checkViolationSqlState && constraint === 'inventory_obligations_immutable_origin_ck'),
  );
  if (Option.isSome(commitBinding)) {
    return reject('ORDER_COMMIT_BINDING_CONFLICT', obligationId);
  }
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      ['obligations_pkey', 'inventory_obligations_scope_id_uk'].includes(constraint ?? ''),
  );
  if (Option.isSome(identity)) {
    return reject('OBLIGATION_IDENTITY_CONFLICT', obligationId);
  }
  const scopeConstraints = new Set([
    'inventory_obligations_backend_configuration_fk',
    'inventory_obligation_requirements_obligation_fk',
    'inventory_obligation_requirements_item_fk',
    'inventory_obligation_allocations_requirement_fk',
    'inventory_obligation_allocations_position_fk',
    'inventory_obligation_allocations_item_fk',
    inventoryObligationCoverageTriggerContract.constraintName,
    ...Object.values(inventoryObligationScopeTriggerContract.constraintNames),
  ]);
  const scope = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      (code === foreignKeyViolationSqlState || code === checkViolationSqlState) &&
      scopeConstraints.has(constraint ?? ''),
  );
  return Option.isSome(scope) ? reject('INVALID_PERSISTED_OBLIGATION', obligationId) : unavailable(cause);
};

const instantAsDate = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const parentValues = (obligation: InventoryObligation) => {
  const common = {
    authorityBackendId: obligation.authority.selection.backendId,
    authorityBackendKind: obligation.authority.selection.backend,
    authorityExactReservationCapability: obligation.authority.selection.exactReservationCapability,
    authorityRevision: obligation.authority.revision,
    authoritySelectedAt: instantAsDate(obligation.authority.selectedAt),
    authorityStockCorrectionCapability: obligation.authority.selection.stockCorrectionCapability,
    customerConfigurationId: obligation.authority.customerConfigurationId,
    lifecycleMeaning: obligation.lifecycleMeaning,
    obligationId: obligation.ref.resourceId,
    ownerConfigurationId: obligation.authority.configurationId,
    tenantId: obligation.ref.tenantId,
  };
  if (Schema.is(ImportedCommittedObligationSchema)(obligation)) {
    return {
      ...common,
      acceptedOrderId: obligation.orderProof.acceptedOrderId,
      attemptId: null,
      establishedAt: instantAsDate(obligation.importedAt),
      orderEvidenceObservedAt: instantAsDate(obligation.orderProof.observedAt),
      orderEvidenceRef: obligation.orderProof.evidenceRef,
      originKind: obligation.origin.kind,
      sourceObligationId: obligation.origin.sourceObligationId,
      sourceOrderId: obligation.origin.sourceOrderId,
      sourceSystem: obligation.origin.sourceSystem,
    };
  }
  const commitProof = Schema.is(RuntimeCommittedInventoryObligationSchema)(obligation) ? obligation.orderProof : null;
  return {
    ...common,
    acceptedOrderId: commitProof?.acceptedOrderId ?? null,
    attemptId: obligation.origin.attemptId,
    establishedAt: instantAsDate(obligation.establishedAt),
    orderEvidenceObservedAt: commitProof === null ? null : instantAsDate(commitProof.observedAt),
    orderEvidenceRef: commitProof?.evidenceRef ?? null,
    originKind: obligation.origin.kind,
    sourceObligationId: null,
    sourceOrderId: null,
    sourceSystem: null,
  };
};

const requirementValues = (obligation: InventoryObligation) =>
  obligation.requirements.map((requirement) => ({
    bindingId: requirement.bindingRef.resourceId,
    catalogSelection: requirement.catalogSelection,
    exactSelectionMeaningId: requirement.exactSelectionMeaning.id,
    exactSelectionMeaningKind: requirement.exactSelectionMeaning.kind,
    obligationId: obligation.ref.resourceId,
    purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
    requestedAmount: requirement.quantity,
    stockItemId: requirement.stockItem.stockItemRef.resourceId,
    stockItemRevision: requirement.stockItem.revision,
    stockItemSnapshot: requirement.stockItem,
    tenantId: obligation.ref.tenantId,
    unitModuleId: requirement.unitRef.moduleId,
    unitResourceId: requirement.unitRef.resourceId,
    unitResourceType: requirement.unitRef.resourceType,
    unitTenantId: requirement.unitRef.tenantId,
  }));

const allocationValues = (obligation: InventoryObligation) =>
  obligation.requirements.flatMap((requirement) =>
    requirement.allocations.map((allocation) => ({
      allocatedAmount: allocation.quantity.amount,
      allocationId: allocation.allocationId,
      obligationId: obligation.ref.resourceId,
      purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
      stockItemId: allocation.stockItemRef.resourceId,
      stockPositionId: allocation.positionRef.resourceId,
      tenantId: obligation.ref.tenantId,
      unitModuleId: allocation.quantity.unitRef.moduleId,
      unitResourceId: allocation.quantity.unitRef.resourceId,
      unitResourceType: allocation.quantity.unitRef.resourceType,
      unitTenantId: allocation.quantity.unitRef.tenantId,
    })),
  );

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

const unitRefFor = (row: RequirementRow | AllocationRow) => ({
  moduleId: row.unitModuleId,
  resourceId: row.unitResourceId,
  resourceType: row.unitResourceType,
  tenantId: row.unitTenantId,
});

const requirementsFor = (
  row: ObligationRow,
  requirements: readonly RequirementRow[],
  allocations: readonly AllocationRow[],
): readonly unknown[] =>
  requirements.map((requirement) => {
    const matchingAllocations: unknown[] = [];
    for (const allocation of allocations) {
      if (allocation.purchaseDemandOccurrenceId === requirement.purchaseDemandOccurrenceId) {
        matchingAllocations.push({
          allocationId: allocation.allocationId,
          positionRef: {
            moduleId: INVENTORY_MODULE_ID,
            resourceId: allocation.stockPositionId,
            resourceType: STOCK_POSITION_RESOURCE_TYPE,
            tenantId: row.tenantId,
          },
          quantity: { amount: canonicalAmount(allocation.allocatedAmount), unitRef: unitRefFor(allocation) },
          stockItemRef: {
            moduleId: INVENTORY_MODULE_ID,
            resourceId: allocation.stockItemId,
            resourceType: STOCK_ITEM_RESOURCE_TYPE,
            tenantId: row.tenantId,
          },
        });
      }
    }
    return {
      allocations: matchingAllocations,
      bindingRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: requirement.bindingId,
        resourceType: CATALOG_BINDING_RESOURCE_TYPE,
        tenantId: row.tenantId,
      },
      catalogSelection: requirement.catalogSelection,
      exactSelectionMeaning: {
        id: requirement.exactSelectionMeaningId,
        kind: requirement.exactSelectionMeaningKind,
      },
      purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
      quantity: canonicalAmount(requirement.requestedAmount),
      stockItem: requirement.stockItemSnapshot,
      unitRef: unitRefFor(requirement),
    };
  });

const decodeAggregate = (
  row: ObligationRow,
  requirements: readonly RequirementRow[],
  allocations: readonly AllocationRow[],
) => {
  const authority = {
    configurationId: row.ownerConfigurationId,
    customerConfigurationId: row.customerConfigurationId,
    revision: row.authorityRevision,
    selectedAt: row.authoritySelectedAt.toISOString(),
    selection: {
      backend: row.authorityBackendKind,
      backendId: row.authorityBackendId,
      exactReservationCapability: row.authorityExactReservationCapability,
      stockCorrectionCapability: row.authorityStockCorrectionCapability,
    },
    tenantId: row.tenantId,
  };
  const demand = requirementsFor(row, requirements, allocations);
  if (row.originKind === 'ORDER_COMMITMENT_ATTEMPT') {
    const ref = {
      moduleId: INVENTORY_MODULE_ID,
      resourceId: row.obligationId,
      resourceType: INVENTORY_RESERVATION_RESOURCE_TYPE,
      tenantId: row.tenantId,
    };
    const encoded =
      row.lifecycleMeaning === 'COMMITTED_OBLIGATION'
        ? {
            authority,
            confirmationTerminationReleasesStock: false,
            establishedAt: row.establishedAt.toISOString(),
            historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
            lifecycleMeaning: row.lifecycleMeaning,
            obligationReductionCreatesOnHand: false,
            orderProof: {
              acceptedOrderId: row.acceptedOrderId,
              attemptId: row.attemptId,
              authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
              commitStatus: 'COMMITTED',
              evidenceRef: row.orderEvidenceRef,
              observedAt: row.orderEvidenceObservedAt?.toISOString(),
              reservationRef: ref,
              tenantId: row.tenantId,
            },
            origin: { attemptId: row.attemptId, kind: row.originKind },
            physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
            ref,
            remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
            requirements: demand,
          }
        : {
            authority,
            establishedAt: row.establishedAt.toISOString(),
            lifecycleMeaning: row.lifecycleMeaning,
            origin: { attemptId: row.attemptId, kind: row.originKind },
            ref,
            requirements: demand,
          };
    return Schema.decodeUnknownEffect(InventoryObligationSchema)(encoded).pipe(Effect.mapError(unavailable));
  }
  const encoded = {
    authority,
    importedAt: row.establishedAt.toISOString(),
    lifecycleMeaning: row.lifecycleMeaning,
    orderProof: {
      acceptedOrderId: row.acceptedOrderId,
      authority: 'ORDER_MIGRATION_PROOF_AUTHORITY',
      commitStatus: 'COMMITTED',
      evidenceRef: row.orderEvidenceRef,
      observedAt: row.orderEvidenceObservedAt?.toISOString(),
      sourceOrderId: row.sourceOrderId,
      sourceSystem: row.sourceSystem,
    },
    origin: {
      kind: row.originKind,
      sourceObligationId: row.sourceObligationId,
      sourceOrderId: row.sourceOrderId,
      sourceSystem: row.sourceSystem,
    },
    ref: {
      moduleId: INVENTORY_MODULE_ID,
      resourceId: row.obligationId,
      resourceType: 'commerce.inventory.imported-committed-obligation',
      tenantId: row.tenantId,
    },
    requirements: demand,
    runtimeAttemptId: null,
  };
  return Schema.decodeUnknownEffect(InventoryObligationSchema)(encoded).pipe(Effect.mapError(unavailable));
};

const canonicalObligation = (obligation: InventoryObligation) =>
  Schema.encodeEffect(Schema.fromJsonString(InventoryObligationSchema))({
    ...obligation,
    requirements: obligation.requirements
      .toSorted((left, right) => left.purchaseDemandOccurrenceId.localeCompare(right.purchaseDemandOccurrenceId))
      .map((requirement) => ({
        ...requirement,
        allocations: requirement.allocations.toSorted((left, right) =>
          left.allocationId.localeCompare(right.allocationId),
        ),
      })),
  }).pipe(Effect.mapError(unavailable));

export const inventoryObligationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): InventoryObligationPersistence => {
  const requireTenant = (tenantId: string, obligationId?: string) =>
    tenantId === scope.tenantId ? Effect.void : Effect.fail(reject('TENANT_SCOPE_MISMATCH', obligationId));

  const readRows = Effect.fn('InventoryObligationPersistence.readRows')(function* readObligationRows(
    row: ObligationRow,
  ) {
    const requirementsRead = transaction
      .select()
      .from(inventoryObligationRequirements)
      .where(
        and(
          eq(inventoryObligationRequirements.tenantId, scope.tenantId),
          eq(inventoryObligationRequirements.obligationId, row.obligationId),
        ),
      )
      .orderBy(asc(inventoryObligationRequirements.purchaseDemandOccurrenceId))
      .pipe(Effect.mapError(unavailable));
    const allocationsRead = transaction
      .select()
      .from(inventoryObligationAllocations)
      .where(
        and(
          eq(inventoryObligationAllocations.tenantId, scope.tenantId),
          eq(inventoryObligationAllocations.obligationId, row.obligationId),
        ),
      )
      .orderBy(asc(inventoryObligationAllocations.allocationId))
      .pipe(Effect.mapError(unavailable));
    const [requirements, allocations] = yield* Effect.all([requirementsRead, allocationsRead] as const, {
      concurrency: 1,
    });
    return yield* decodeAggregate(row, requirements, allocations);
  });

  const findParent = (predicate: ReturnType<typeof and>) =>
    transaction.select().from(inventoryObligations).where(predicate).limit(1).pipe(Effect.mapError(unavailable));

  const read: InventoryObligationPersistence['read'] = Effect.fn('InventoryObligationPersistence.read')(
    function* readObligation(ref) {
      yield* requireTenant(ref.tenantId, ref.resourceId);
      const [row] = yield* findParent(
        and(eq(inventoryObligations.tenantId, scope.tenantId), eq(inventoryObligations.obligationId, ref.resourceId)),
      );
      if (row === undefined) {
        return Option.none<InventoryObligation>();
      }
      const obligation = yield* readRows(row);
      if (obligation.ref.resourceType !== ref.resourceType) {
        return yield* reject('OBLIGATION_IDENTITY_CONFLICT', ref.resourceId);
      }
      return Option.some(obligation);
    },
  );

  const persistNew = Effect.fn('InventoryObligationPersistence.persistNew')(function* persistNewObligation(
    obligation: InventoryObligation,
  ) {
    const [inserted] = yield* transaction
      .insert(inventoryObligations)
      .values(parentValues(obligation))
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError((cause) => mapInventoryObligationWriteError(cause, obligation.ref.resourceId)));
    if (inserted === undefined) {
      return false;
    }
    yield* transaction
      .insert(inventoryObligationRequirements)
      .values(requirementValues(obligation))
      .pipe(Effect.mapError((cause) => mapInventoryObligationWriteError(cause, obligation.ref.resourceId)));
    yield* transaction
      .insert(inventoryObligationAllocations)
      .values(allocationValues(obligation))
      .pipe(Effect.mapError((cause) => mapInventoryObligationWriteError(cause, obligation.ref.resourceId)));
    return true;
  });

  const establishReservation: InventoryObligationPersistence['establishReservation'] = Effect.fn(
    'InventoryObligationPersistence.establishReservation',
  )(function* establishReservationObligation(obligation) {
    const obligationId = obligation.ref.resourceId;
    yield* requireTenant(obligation.ref.tenantId, obligationId);
    if (!Schema.is(ProvisionalInventoryReservationSchema)(obligation)) {
      return yield* reject('INVALID_PERSISTED_OBLIGATION', obligationId);
    }
    const inserted = yield* persistNew(obligation);
    if (inserted) {
      return { obligation, outcome: 'ESTABLISHED' as const };
    }
    const [existingRow] = yield* findParent(
      and(
        eq(inventoryObligations.tenantId, scope.tenantId),
        eq(inventoryObligations.originKind, 'ORDER_COMMITMENT_ATTEMPT'),
        eq(inventoryObligations.attemptId, obligation.origin.attemptId),
      ),
    );
    if (existingRow === undefined) {
      return yield* reject('OBLIGATION_IDENTITY_CONFLICT', obligation.ref.resourceId);
    }
    const existing = yield* readRows(existingRow);
    if (existing.ref.resourceId !== obligation.ref.resourceId) {
      return yield* reject('ATTEMPT_ALREADY_BOUND', obligation.ref.resourceId);
    }
    const [existingCanonical, requestedCanonical] = yield* Effect.all(
      [canonicalObligation(existing), canonicalObligation(obligation)] as const,
      { concurrency: 1 },
    );
    if (existingCanonical !== requestedCanonical) {
      return yield* reject('OBLIGATION_IDENTITY_CONFLICT', obligation.ref.resourceId);
    }
    return { obligation, outcome: 'EXACT_REPLAY' as const };
  });

  const commitReservation: InventoryObligationPersistence['commitReservation'] = Effect.fn(
    'InventoryObligationPersistence.commitReservation',
  )(function* commitReservationObligation(obligation) {
    const obligationId = obligation.ref.resourceId;
    yield* requireTenant(obligation.ref.tenantId, obligationId);
    if (!Schema.is(RuntimeCommittedInventoryObligationSchema)(obligation)) {
      return yield* reject('INVALID_PERSISTED_OBLIGATION', obligationId);
    }
    const [updatedRow] = yield* transaction
      .update(inventoryObligations)
      .set({
        acceptedOrderId: obligation.orderProof.acceptedOrderId,
        lifecycleMeaning: 'COMMITTED_OBLIGATION',
        orderEvidenceObservedAt: instantAsDate(obligation.orderProof.observedAt),
        orderEvidenceRef: obligation.orderProof.evidenceRef,
      })
      .where(
        and(
          eq(inventoryObligations.tenantId, scope.tenantId),
          eq(inventoryObligations.obligationId, obligationId),
          eq(inventoryObligations.originKind, 'ORDER_COMMITMENT_ATTEMPT'),
          eq(inventoryObligations.attemptId, obligation.origin.attemptId),
          eq(inventoryObligations.lifecycleMeaning, 'PROVISIONAL_RESERVATION'),
        ),
      )
      .returning()
      .pipe(Effect.mapError((cause) => mapInventoryObligationWriteError(cause, obligationId)));
    if (updatedRow !== undefined) {
      const persisted = yield* readRows(updatedRow);
      if (!Schema.is(RuntimeCommittedInventoryObligationSchema)(persisted)) {
        return yield* reject('INVALID_PERSISTED_OBLIGATION', obligationId);
      }
      return { obligation: persisted, outcome: 'COMMITTED' as const };
    }

    const [existingRow] = yield* findParent(
      and(eq(inventoryObligations.tenantId, scope.tenantId), eq(inventoryObligations.obligationId, obligationId)),
    );
    if (existingRow === undefined) {
      return yield* reject('OBLIGATION_IDENTITY_CONFLICT', obligationId);
    }
    const existing = yield* readRows(existingRow);
    if (!Schema.is(RuntimeCommittedInventoryObligationSchema)(existing)) {
      return yield* reject('RESERVATION_NOT_PROVISIONAL', obligationId);
    }
    const [existingCanonical, requestedCanonical] = yield* Effect.all(
      [canonicalObligation(existing), canonicalObligation(obligation)] as const,
      { concurrency: 1 },
    );
    if (existingCanonical !== requestedCanonical) {
      return yield* reject('ORDER_COMMIT_BINDING_CONFLICT', obligationId);
    }
    return { obligation: existing, outcome: 'EXACT_REPLAY' as const };
  });

  const importCommitted: InventoryObligationPersistence['importCommitted'] = Effect.fn(
    'InventoryObligationPersistence.importCommitted',
  )(function* importCommittedObligation(obligation) {
    const obligationId = obligation.ref.resourceId;
    yield* requireTenant(obligation.ref.tenantId, obligationId);
    if (!Schema.is(ImportedCommittedObligationSchema)(obligation)) {
      return yield* reject('INVALID_PERSISTED_OBLIGATION', obligationId);
    }
    const inserted = yield* persistNew(obligation);
    if (inserted) {
      return { obligation, outcome: 'IMPORTED' as const };
    }
    const [existingRow] = yield* findParent(
      and(
        eq(inventoryObligations.tenantId, scope.tenantId),
        eq(inventoryObligations.originKind, 'IMPORTED_PROVEN_ORDER'),
        eq(inventoryObligations.sourceSystem, obligation.origin.sourceSystem),
        eq(inventoryObligations.sourceOrderId, obligation.origin.sourceOrderId),
        eq(inventoryObligations.sourceObligationId, obligation.origin.sourceObligationId),
      ),
    );
    if (existingRow === undefined) {
      return yield* reject('OBLIGATION_IDENTITY_CONFLICT', obligation.ref.resourceId);
    }
    const existing = yield* readRows(existingRow);
    const [existingCanonical, requestedCanonical] = yield* Effect.all(
      [canonicalObligation(existing), canonicalObligation(obligation)] as const,
      { concurrency: 1 },
    );
    if (existing.ref.resourceId !== obligation.ref.resourceId || existingCanonical !== requestedCanonical) {
      return yield* reject('SOURCE_LINEAGE_ALREADY_IMPORTED', obligation.ref.resourceId);
    }
    return { obligation, outcome: 'EXACT_REPLAY' as const };
  });

  return { commitReservation, establishReservation, importCommitted, read };
};
