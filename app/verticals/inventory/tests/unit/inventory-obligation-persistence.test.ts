/* oxlint-disable anti-slop/no-unknown-parameters, sonarjs/no-nested-functions -- Focused Drizzle transaction mocks accept opaque table identities and mirror fluent query-builder chains; expires: 2027-03-31. */
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Cause, DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  EstablishInventoryReservationInputSchema,
  ImportCommittedInventoryObligationInputSchema,
  InventoryObligationRequirementSchema,
  ProvisionalInventoryReservationSchema,
  RuntimeCommittedInventoryObligationSchema,
} from '../../shared/domain/inventory-obligation.ts';
import type {
  ImportedCommittedObligation,
  ProvisionalInventoryReservation,
  RuntimeCommittedInventoryObligation,
} from '../../shared/domain/inventory-obligation.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { InventoryReservationRefSchema } from '../../shared/resources/inventory-reservation.ts';
import {
  InventoryObligationPersistenceUnavailable,
  inventoryObligationPersistenceForScope,
  mapInventoryObligationWriteError,
} from '../../src/persistence/inventory-obligation-repository.ts';
import { inventoryCatalogToStockBindings } from '../../src/persistence/catalog-to-stock-binding-table.ts';
import {
  INVENTORY_OBLIGATION_TABLES,
  inventoryObligationAllocations,
  inventoryObligationCommitTransitionContract,
  inventoryObligationCoverageTriggerContract,
  inventoryObligationImmutabilityContract,
  inventoryObligationRequirements,
  inventoryObligations,
  inventoryObligationScopeTriggerContract,
} from '../../src/persistence/inventory-obligation-table.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const importedObligationId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const positionId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const bindingId = '99999999-9999-4999-8999-999999999999';
const occurredAt = '2026-09-24T10:00:00.000Z';
const occurredAtDate = DateTime.toDateUtc(DateTime.makeUnsafe(occurredAt));
const decodeReservationInput = Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema, {
  onExcessProperty: 'error',
});
const decodeImportedInput = Schema.decodeUnknownSync(ImportCommittedInventoryObligationInputSchema, {
  onExcessProperty: 'error',
});
const decodeRequirement = Schema.decodeUnknownSync(InventoryObligationRequirementSchema, {
  onExcessProperty: 'error',
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:inventory-obligation-test:run:1',
    authMethod: 'system',
    principalId: '88888888-8888-4888-8888-888888888888',
    tenantId,
  }),
  correlationId: 'inventory-obligation-test',
};
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
const authority = {
  configurationId,
  customerConfigurationId: 'customer-configuration-primary',
  revision: 1 as const,
  selectedAt: '2026-09-24T09:00:00.000Z',
  selection: {
    backend: 'external_business_system' as const,
    backendId: 'erp-primary',
    exactReservationCapability: 'SUPPORTED' as const,
    stockCorrectionCapability: 'UNSUPPORTED' as const,
  },
  tenantId,
};
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: occurredAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});
const requirement = decodeRequirement({
  allocations: [
    {
      allocationId: 'allocation-1',
      positionRef: {
        moduleId: 'commerce.inventory' as const,
        resourceId: positionId,
        resourceType: 'commerce.inventory.stock-position' as const,
        tenantId,
      },
      quantity: { amount: '5', unitRef },
      stockItemRef: itemRef,
    },
  ],
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: bindingId,
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  exactSelectionMeaning,
  purchaseDemandOccurrenceId: 'demand-occurrence-1',
  quantity: '5',
  stockItem,
  unitRef,
});
const reservationInput = decodeReservationInput({
  authority,
  establishedAt: occurredAt,
  origin: { attemptId: 'attempt-checkout-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: reservationId,
    resourceType: 'commerce.inventory.inventory-reservation',
    tenantId,
  },
  requirements: [requirement],
});
const reservation = {
  ...reservationInput,
  lifecycleMeaning: 'PROVISIONAL_RESERVATION',
} satisfies ProvisionalInventoryReservation;
const runtimeCommitted = Schema.decodeUnknownSync(RuntimeCommittedInventoryObligationSchema)({
  ...reservation,
  confirmationTerminationReleasesStock: false,
  historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
  lifecycleMeaning: 'COMMITTED_OBLIGATION',
  obligationReductionCreatesOnHand: false,
  orderProof: {
    acceptedOrderId: 'accepted-order-1',
    attemptId: reservation.origin.attemptId,
    authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
    commitStatus: 'COMMITTED',
    evidenceRef: 'accepted-order-proof-1',
    observedAt: '2026-09-24T10:05:00.000Z',
    reservationRef: reservation.ref,
    tenantId,
  },
  physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
  remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
}) satisfies RuntimeCommittedInventoryObligation;
const importedInput = decodeImportedInput({
  authority,
  importedAt: occurredAt,
  orderProofObservation: {
    acceptedOrderId: 'legacy-order-42',
    evidenceRef: 'erp-order-commit-proof-42',
    observedAt: occurredAt,
    sourceOrderId: 'erp-order-42',
    sourceSystem: 'erp-primary',
  },
  origin: {
    kind: 'IMPORTED_PROVEN_ORDER',
    sourceObligationId: 'erp-hold-42',
    sourceOrderId: 'erp-order-42',
    sourceSystem: 'erp-primary',
  },
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: importedObligationId,
    resourceType: 'commerce.inventory.imported-committed-obligation',
    tenantId,
  },
  requirements: [requirement],
  runtimeAttemptId: null,
});
const imported = {
  authority: importedInput.authority,
  importedAt: importedInput.importedAt,
  lifecycleMeaning: 'COMMITTED_OBLIGATION',
  orderProof: {
    ...importedInput.orderProofObservation,
    authority: 'ORDER_MIGRATION_PROOF_AUTHORITY',
    commitStatus: 'COMMITTED',
  },
  origin: importedInput.origin,
  ref: importedInput.ref,
  requirements: importedInput.requirements,
  runtimeAttemptId: null,
} satisfies ImportedCommittedObligation;

const obligationRow = {
  acceptedOrderId: null,
  attemptId: 'attempt-checkout-1',
  authorityBackendId: 'erp-primary',
  authorityBackendKind: 'external_business_system',
  authorityExactReservationCapability: 'SUPPORTED',
  authorityRevision: 1,
  authoritySelectedAt: DateTime.toDateUtc(DateTime.makeUnsafe(authority.selectedAt)),
  authorityStockCorrectionCapability: 'UNSUPPORTED',
  createdAt: occurredAtDate,
  customerConfigurationId: authority.customerConfigurationId,
  establishedAt: occurredAtDate,
  lifecycleMeaning: 'PROVISIONAL_RESERVATION',
  obligationId: reservationId,
  orderEvidenceObservedAt: null,
  orderEvidenceRef: null,
  originKind: 'ORDER_COMMITMENT_ATTEMPT',
  ownerConfigurationId: configurationId,
  sourceObligationId: null,
  sourceOrderId: null,
  sourceSystem: null,
  tenantId,
};
const committedObligationRow = {
  ...obligationRow,
  acceptedOrderId: runtimeCommitted.orderProof.acceptedOrderId,
  lifecycleMeaning: 'COMMITTED_OBLIGATION',
  orderEvidenceObservedAt: DateTime.toDateUtc(DateTime.makeUnsafe(runtimeCommitted.orderProof.observedAt)),
  orderEvidenceRef: runtimeCommitted.orderProof.evidenceRef,
};
const requirementRow = {
  bindingId,
  catalogSelection: selection,
  exactSelectionMeaningId: exactSelectionMeaning.id,
  exactSelectionMeaningKind: exactSelectionMeaning.kind,
  obligationId: reservationId,
  purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
  requestedAmount: '5.000000000',
  stockItemId: itemId,
  stockItemRevision: 1,
  stockItemSnapshot: stockItem,
  tenantId,
  unitModuleId: unitRef.moduleId,
  unitResourceId: unitId,
  unitResourceType: unitRef.resourceType,
  unitTenantId: tenantId,
};
const allocationRow = {
  allocatedAmount: '5.000000000',
  allocationId: 'allocation-1',
  obligationId: reservationId,
  purchaseDemandOccurrenceId: requirement.purchaseDemandOccurrenceId,
  stockItemId: itemId,
  stockPositionId: positionId,
  tenantId,
  unitModuleId: unitRef.moduleId,
  unitResourceId: unitId,
  unitResourceType: unitRef.resourceType,
  unitTenantId: tenantId,
};
const currentBindingRows = [{ bindingId, stockItemId: itemId }];
const currentBindingQuery = () => ({
  where: () => ({
    for: () => {
      const result = Effect.succeed(currentBindingRows);
      return Object.assign(result, { limit: () => result });
    },
  }),
});

describe('Inventory obligation persistence', () => {
  it('owns one RLS aggregate with Attempt/import-lineage uniqueness and exact tenant-qualified references', () => {
    expect(INVENTORY_OBLIGATION_TABLES).toEqual([
      inventoryObligationAllocations,
      inventoryObligationRequirements,
      inventoryObligations,
    ]);
    const parent = getTableConfig(inventoryObligations);
    const requirements = getTableConfig(inventoryObligationRequirements);
    const allocations = getTableConfig(inventoryObligationAllocations);

    expect([parent, requirements, allocations].map(({ enableRLS }) => enableRLS)).toEqual([true, true, true]);
    expect(parent.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining(['inventory_obligations_attempt_uk', 'inventory_obligations_imported_lineage_uk']),
    );
    expect(requirements.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_obligation_requirements_obligation_fk',
        'inventory_obligation_requirements_item_fk',
      ]),
    );
    expect(allocations.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_obligation_allocations_requirement_fk',
        'inventory_obligation_allocations_position_fk',
      ]),
    );
    expect(requirements.columns.find(({ name }) => name === 'requested_amount')?.getSQLType()).toBe('numeric(38, 9)');
    expect(requirements.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'binding_id',
        'catalog_selection',
        'exact_selection_meaning_id',
        'exact_selection_meaning_kind',
        'stock_item_snapshot',
      ]),
    );
    expect(parent.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['authority_exact_reservation_capability', 'authority_stock_correction_capability']),
    );
    expect(allocations.columns.find(({ name }) => name === 'allocated_amount')?.getSQLType()).toBe('numeric(38, 9)');
  });

  it('publishes migration hardening for exact authority, Item/Unit/Position scope, and immutable snapshots', () => {
    expect(inventoryObligationScopeTriggerContract.constraintNames).toEqual({
      allocation: 'inventory_obligation_allocations_exact_scope_ck',
      authority: 'inventory_obligations_exact_authority_ck',
      requirement: 'inventory_obligation_requirements_exact_item_unit_ck',
    });
    expect(inventoryObligationCoverageTriggerContract).toEqual({
      constraintName: 'inventory_obligations_exact_requirement_coverage_ck',
      functionName: 'inventory.enforce_obligation_requirement_coverage',
      timing: 'AFTER INSERT DEFERRABLE INITIALLY DEFERRED',
      triggerNames: [
        'inventory_obligation_requirements_exact_coverage_trg',
        'inventory_obligation_allocations_exact_coverage_trg',
      ],
    });
    expect(inventoryObligationImmutabilityContract).toMatchObject({
      importedOriginKind: 'IMPORTED_PROVEN_ORDER',
      rejectChildEvent: 'UPDATE OR DELETE',
      rejectObligationDelete: true,
      runtimeOriginKind: 'ORDER_COMMITMENT_ATTEMPT',
      runtimeTransition: {
        from: 'PROVISIONAL_RESERVATION',
        requiredProofColumns: ['accepted_order_id', 'order_evidence_ref', 'order_evidence_observed_at'],
        to: 'COMMITTED_OBLIGATION',
      },
    });
    expect(inventoryObligationImmutabilityContract.obligationImmutableColumns).toEqual(
      expect.arrayContaining([
        'obligation_id',
        'attempt_id',
        'source_order_id',
        'owner_configuration_id',
        'created_at',
      ]),
    );
    expect(inventoryObligationImmutabilityContract.importedProofImmutableColumns).toEqual([
      'lifecycle_meaning',
      'accepted_order_id',
      'order_evidence_ref',
      'order_evidence_observed_at',
    ]);
    expect(inventoryObligationCommitTransitionContract).toEqual({
      constraintName: 'inventory_obligations_immutable_origin_ck',
      exactMutableColumns: [
        'lifecycle_meaning',
        'accepted_order_id',
        'order_evidence_ref',
        'order_evidence_observed_at',
      ],
      functionName: 'inventory.reject_obligation_origin_mutation',
      indexName: 'inventory_obligations_runtime_accepted_order_uk',
      requiredProofColumns: ['accepted_order_id', 'order_evidence_ref', 'order_evidence_observed_at'],
      timing: 'BEFORE UPDATE OR DELETE',
      transition: { from: 'PROVISIONAL_RESERVATION', to: 'COMMITTED_OBLIGATION' },
      triggerName: 'inventory_obligations_immutable_origin_trg',
    });
  });

  it.effect('persists the Reservation parent, Requirements, and Allocations as one transaction-scoped aggregate', () =>
    Effect.gen(function* persistAggregate() {
      const writes: { readonly table: unknown; readonly values: unknown }[] = [];
      const transaction = {
        insert: (table: unknown) => ({
          values: (values: unknown) => {
            writes.push({ table, values });
            return table === inventoryObligations
              ? { onConflictDoNothing: () => ({ returning: () => Effect.succeed([obligationRow]) }) }
              : Effect.succeed([]);
          },
        }),
        select: () => ({ from: () => currentBindingQuery() }),
      };
      // @ts-expect-error Mock implements only the exercised Effect-Drizzle chains.
      const persistence = inventoryObligationPersistenceForScope(transaction, scope);

      const result = yield* persistence.establishReservation(reservation);

      expect(result).toEqual({ obligation: reservation, outcome: 'ESTABLISHED' });
      expect(writes.map(({ table }) => table)).toEqual([
        inventoryObligations,
        inventoryObligationRequirements,
        inventoryObligationAllocations,
      ]);
    }),
  );

  it.effect('returns the original aggregate for an exact retry and canonicalizes numeric scale padding', () =>
    Effect.gen(function* exactReplay() {
      const transaction = {
        insert: () => ({
          values: () => ({ onConflictDoNothing: () => ({ returning: () => Effect.succeed([]) }) }),
        }),
        select: () => ({
          from: (table: unknown) =>
            table === inventoryCatalogToStockBindings
              ? currentBindingQuery()
              : {
                  where: () =>
                    table === inventoryObligations
                      ? { limit: () => Effect.succeed([obligationRow]) }
                      : {
                          orderBy: () =>
                            Effect.succeed(
                              table === inventoryObligationRequirements ? [requirementRow] : [allocationRow],
                            ),
                        },
                },
        }),
      };
      // @ts-expect-error Mock implements only the exercised Effect-Drizzle chains.
      const persistence = inventoryObligationPersistenceForScope(transaction, scope);

      const result = yield* persistence.establishReservation(reservation);

      expect(result).toEqual({ obligation: reservation, outcome: 'EXACT_REPLAY' });
      expect(result.obligation.requirements[0]?.quantity).toBe('5');
    }),
  );

  it.effect('round-trips a supported external authority without rewriting either capability', () =>
    Effect.gen(function* roundTripSupportedExternalAuthority() {
      const expected = Schema.decodeUnknownSync(ProvisionalInventoryReservationSchema)({
        ...reservation,
        authority: {
          ...reservation.authority,
          selection: {
            ...reservation.authority.selection,
            stockCorrectionCapability: 'SUPPORTED',
          },
        },
      });
      const transaction = {
        select: () => ({
          from: (table: unknown) => ({
            where: () =>
              table === inventoryObligations
                ? {
                    limit: () =>
                      Effect.succeed([
                        {
                          ...obligationRow,
                          authorityStockCorrectionCapability: 'SUPPORTED',
                        },
                      ]),
                  }
                : {
                    orderBy: () =>
                      Effect.succeed(table === inventoryObligationRequirements ? [requirementRow] : [allocationRow]),
                  },
          }),
        }),
      };
      // @ts-expect-error Mock implements only the exercised Effect-Drizzle chains.
      const persistence = inventoryObligationPersistenceForScope(transaction, scope);

      const result = Option.getOrThrow(yield* persistence.read(expected.ref));

      expect(result.authority).toEqual(expected.authority);
    }),
  );

  it.effect('round-trips the exact OntOS WMS authority capabilities', () =>
    Effect.gen(function* roundTripOntosWmsAuthority() {
      const expected = Schema.decodeUnknownSync(ProvisionalInventoryReservationSchema)({
        ...reservation,
        authority: {
          ...reservation.authority,
          selection: {
            backend: 'ontos_wms',
            backendId: 'ontos-wms',
            exactReservationCapability: 'SUPPORTED',
            stockCorrectionCapability: 'SUPPORTED',
          },
        },
      });
      const transaction = {
        select: () => ({
          from: (table: unknown) => ({
            where: () =>
              table === inventoryObligations
                ? {
                    limit: () =>
                      Effect.succeed([
                        {
                          ...obligationRow,
                          authorityBackendId: 'ontos-wms',
                          authorityBackendKind: 'ontos_wms',
                          authorityExactReservationCapability: 'SUPPORTED',
                          authorityStockCorrectionCapability: 'SUPPORTED',
                        },
                      ]),
                  }
                : {
                    orderBy: () =>
                      Effect.succeed(table === inventoryObligationRequirements ? [requirementRow] : [allocationRow]),
                  },
          }),
        }),
      };
      // @ts-expect-error Mock implements only the exercised Effect-Drizzle chains.
      const persistence = inventoryObligationPersistenceForScope(transaction, scope);

      const result = Option.getOrThrow(yield* persistence.read(expected.ref));

      expect(result.authority).toEqual(expected.authority);
    }),
  );

  it.effect(
    'atomically commits the same Reservation row while preserving exact Requirement and Allocation history',
    () =>
      Effect.gen(function* commitSameAggregate() {
        let transitionValues: unknown;
        const transaction = {
          select: () => ({
            from: (table: unknown) => ({
              where: () => ({
                orderBy: () =>
                  Effect.succeed(table === inventoryObligationRequirements ? [requirementRow] : [allocationRow]),
              }),
            }),
          }),
          update: (table: unknown) => ({
            set: (values: unknown) => {
              expect(table).toBe(inventoryObligations);
              transitionValues = values;
              return { where: () => ({ returning: () => Effect.succeed([committedObligationRow]) }) };
            },
          }),
        };
        // @ts-expect-error Mock implements only the exercised Effect-Drizzle chains.
        const persistence = inventoryObligationPersistenceForScope(transaction, scope);

        const result = yield* persistence.commitReservation(runtimeCommitted);

        expect(result).toEqual({ obligation: runtimeCommitted, outcome: 'COMMITTED' });
        expect(transitionValues).toMatchObject({
          acceptedOrderId: 'accepted-order-1',
          lifecycleMeaning: 'COMMITTED_OBLIGATION',
          orderEvidenceRef: 'accepted-order-proof-1',
        });
        expect(result.obligation.requirements).toEqual(reservation.requirements);
        expect(result.obligation.ref).toEqual(reservation.ref);
      }),
  );

  it.effect('returns exact replay but rejects a different Order binding for an already committed obligation', () =>
    Effect.gen(function* commitReplayAndConflict() {
      let row: typeof inventoryObligations.$inferSelect = committedObligationRow;
      const transaction = {
        select: () => ({
          from: (table: unknown) => ({
            where: () =>
              table === inventoryObligations
                ? { limit: () => Effect.succeed([row]) }
                : {
                    orderBy: () =>
                      Effect.succeed(table === inventoryObligationRequirements ? [requirementRow] : [allocationRow]),
                  },
          }),
        }),
        update: () => ({
          set: () => ({ where: () => ({ returning: () => Effect.succeed([]) }) }),
        }),
      };
      // @ts-expect-error Mock implements only the exercised Effect-Drizzle chains.
      const persistence = inventoryObligationPersistenceForScope(transaction, scope);

      const replay = yield* persistence.commitReservation(runtimeCommitted);
      expect(replay).toEqual({ obligation: runtimeCommitted, outcome: 'EXACT_REPLAY' });

      row = { ...committedObligationRow, acceptedOrderId: 'accepted-order-2' };
      const failure = yield* persistence.commitReservation(runtimeCommitted).pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: 'ORDER_COMMIT_BINDING_CONFLICT' });
    }),
  );

  it.effect('conflicts when the same Attempt is retried with another Reservation identity', () =>
    Effect.gen(function* rejectAnotherIdentity() {
      const changedRef = Schema.decodeUnknownSync(InventoryReservationRefSchema)({
        ...reservation.ref,
        resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      });
      const changed = {
        ...reservation,
        ref: changedRef,
      };
      const transaction = {
        insert: () => ({
          values: () => ({ onConflictDoNothing: () => ({ returning: () => Effect.succeed([]) }) }),
        }),
        select: () => ({
          from: (table: unknown) =>
            table === inventoryCatalogToStockBindings
              ? currentBindingQuery()
              : {
                  where: () =>
                    table === inventoryObligations
                      ? { limit: () => Effect.succeed([obligationRow]) }
                      : {
                          orderBy: () =>
                            Effect.succeed(
                              table === inventoryObligationRequirements ? [requirementRow] : [allocationRow],
                            ),
                        },
                },
        }),
      };
      // @ts-expect-error Mock implements only the exercised Effect-Drizzle chains.
      const persistence = inventoryObligationPersistenceForScope(transaction, scope);

      const failure = yield* persistence.establishReservation(changed).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'ATTEMPT_ALREADY_BOUND' });
    }),
  );

  it.effect('stores imported committed lineage and proof without an Attempt identity', () =>
    Effect.gen(function* persistImported() {
      let parentWrite: unknown;
      const transaction = {
        insert: (table: unknown) => ({
          values: (values: unknown) => {
            if (table === inventoryObligations) {
              parentWrite = values;
              return { onConflictDoNothing: () => ({ returning: () => Effect.succeed([{}]) }) };
            }
            return Effect.succeed([]);
          },
        }),
        select: () => ({ from: () => currentBindingQuery() }),
      };
      // @ts-expect-error Mock implements only the exercised Effect-Drizzle chains.
      const persistence = inventoryObligationPersistenceForScope(transaction, scope);

      const result = yield* persistence.importCommitted(imported);

      expect(result.outcome).toBe('IMPORTED');
      expect(parentWrite).toMatchObject({
        acceptedOrderId: 'legacy-order-42',
        attemptId: null,
        lifecycleMeaning: 'COMMITTED_OBLIGATION',
        originKind: 'IMPORTED_PROVEN_ORDER',
        sourceObligationId: 'erp-hold-42',
        sourceOrderId: 'erp-order-42',
      });
    }),
  );

  it.effect('rejects a foreign Tenant before touching the owner transaction', () =>
    Effect.gen(function* rejectForeignTenant() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('must not touch transaction');
          },
        },
      );
      // @ts-expect-error Mock deliberately exposes no transaction operations.
      const persistence = inventoryObligationPersistenceForScope(transaction, scope);
      const foreignRef = Schema.decodeUnknownSync(InventoryReservationRefSchema)({
        ...reservation.ref,
        tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });

      const failure = yield* persistence.read(foreignRef).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'TENANT_SCOPE_MISMATCH' });
    }),
  );

  it('maps only exact constraint failures to obligation conflicts', () => {
    expect(
      mapInventoryObligationWriteError(
        Cause.fail({ code: '23505', constraint: 'inventory_obligations_attempt_uk' }),
        reservationId,
      ),
    ).toMatchObject({ reason: 'ATTEMPT_ALREADY_BOUND' });
    expect(
      mapInventoryObligationWriteError(
        Cause.fail({ code: '23514', constraint: 'inventory_obligation_allocations_exact_scope_ck' }),
        reservationId,
      ),
    ).toMatchObject({ reason: 'INVALID_PERSISTED_OBLIGATION' });
    expect(
      mapInventoryObligationWriteError(
        Cause.fail({ code: '23505', constraint: 'inventory_obligations_runtime_accepted_order_uk' }),
        reservationId,
      ),
    ).toMatchObject({ reason: 'ORDER_COMMIT_BINDING_CONFLICT' });
    expect(
      mapInventoryObligationWriteError(
        Cause.fail({ code: '23514', constraint: 'inventory_obligations_immutable_origin_ck' }),
        reservationId,
      ),
    ).toMatchObject({ reason: 'ORDER_COMMIT_BINDING_CONFLICT' });
    expect(
      mapInventoryObligationWriteError(
        Cause.fail({
          code: '23514',
          constraint: inventoryObligationCoverageTriggerContract.constraintName,
        }),
        reservationId,
      ),
    ).toMatchObject({ reason: 'INVALID_PERSISTED_OBLIGATION' });
    expect(
      Schema.is(InventoryObligationPersistenceUnavailable)(
        mapInventoryObligationWriteError(Cause.fail({ code: 'XX000', constraint: 'unrelated' }), reservationId),
      ),
    ).toBe(true);
  });
});
