import { randomUUID } from 'node:crypto';

import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { eq } from 'drizzle-orm';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { CatalogToStockBindingSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import { StockSharingEligibilitySchema } from '../../shared/domain/stock-sharing-eligibility.ts';
import { RelevantStockPositionSetRequestSchema } from '../../shared/domain/current-relevant-stock-position-set.ts';
import {
  inventoryBackendConfigurations,
  inventoryCatalogToStockBindings,
  inventoryCatalogToStockBindingHistory,
  inventoryRelations,
  inventoryStockItems,
  inventoryStockLocations,
  inventoryStockPositions,
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
} from '../../src/database/schema.ts';
import { observeRelevantStockPositionSet } from '../../src/persistence/current-relevant-stock-position-set-repository.ts';
import { evaluateRelevantStockPositionSet } from '../../src/services/current-relevant-stock-position-set.service.ts';
import { observation, request, sharing } from '../support/current-relevant-stock-position-set.ts';

it.live('runtime-role atomic query includes a concurrent unknown Position insert on owner revalidation', () =>
  Effect.scoped(
    Effect.gen(function* positionSetScenario1() {
      const clients = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(clients.admin, inventoryRelations);
      const runtime = yield* makeTestDatabaseFromClient(clients.runtime, coreRelations);
      const tenantId = randomUUID();
      const itemId = randomUUID();
      const configurationId = randomUUID();
      const positionId = randomUUID();
      const locationId = randomUUID();
      const unitId = randomUUID();
      const bindingId = randomUUID();
      const scope = {
        ...trustVerifiedGatewayPrincipalContext(
          {
            authBindingId: randomUUID(),
            authContextRef: 'better-auth-session:position-set-test',
            authMethod: 'session',
            legalEntityId: randomUUID(),
            principalId: randomUUID(),
            tenantId,
          },
          'a'.repeat(64),
        ),
        correlationId: 'position-set-postgres',
      };
      const input = Schema.decodeUnknownSync(RelevantStockPositionSetRequestSchema)({
        mode: 'POTENTIALLY_RELEVANT_POSITIONS',
        scope: {
          ...request.scope,
          ownerConfigurationRef: { ...request.scope.ownerConfigurationRef, resourceId: configurationId, tenantId },
          stockItemRef: { ...request.scope.stockItemRef, resourceId: itemId, tenantId },
          unitRef: { ...request.scope.unitRef, resourceId: unitId, tenantId },
        },
      });
      const [backend] = observation.backendConfigurations;
      const [item] = observation.items;
      const [binding] = observation.bindings;
      const [location] = observation.locations;
      const [position] = observation.positions;
      if (
        backend === undefined ||
        item === undefined ||
        binding === undefined ||
        location === undefined ||
        position === undefined
      ) {
        return;
      }
      yield* admin.insert(inventoryBackendConfigurations).values({ ...backend, configurationId, tenantId });
      yield* admin
        .insert(inventoryStockItems)
        .values({ ...item, stockItemId: itemId, stockUnitResourceId: unitId, stockUnitTenantId: tenantId, tenantId });
      yield* admin.insert(inventoryCatalogToStockBindings).values({
        ...binding,
        bindingId,
        catalogSelection: {
          ...binding.catalogSelection,
          productRef: { ...binding.catalogSelection.productRef, tenantId },
          variantRef: { ...binding.catalogSelection.variantRef, tenantId },
        },
        stockItemId: itemId,
        stockUnitResourceId: unitId,
        stockUnitTenantId: tenantId,
        tenantId,
      });
      yield* admin.insert(inventoryStockLocations).values({ ...location, stockLocationId: locationId, tenantId });
      const empty = yield* runtime.transaction((transaction) =>
        Effect.gen(function* proveEmptyPredicate() {
          const scoped = yield* installOperationalScope(transaction, scope);
          const snapshot = yield* observeRelevantStockPositionSet(scoped, scope, input.scope);
          return yield* evaluateRelevantStockPositionSet(input, snapshot, scope);
        }),
      );
      expect(empty.outcome).toBe('COMPLETE');
      if (empty.outcome === 'COMPLETE') {
        expect(empty.positionRefs).toEqual([]);
      }
      const firstPosition = {
        ...position,
        ownerConfigurationId: configurationId,
        stockItemId: itemId,
        stockLocationId: locationId,
        stockPositionId: positionId,
        stockUnitResourceId: unitId,
        stockUnitTenantId: tenantId,
        tenantId,
      };
      yield* admin.insert(inventoryStockPositions).values(firstPosition);
      const first = yield* runtime.transaction((transaction) =>
        Effect.gen(function* observeBeforeInsert() {
          const scoped = yield* installOperationalScope(transaction, scope);
          const snapshot = yield* observeRelevantStockPositionSet(scoped, scope, input.scope);
          const secondLocationId = randomUUID();
          // Separate admin connection commits a phantom while the original read transaction remains open.
          yield* admin
            .insert(inventoryStockLocations)
            .values({ ...location, stockLocationId: secondLocationId, tenantId });
          const [laterInsert] = yield* admin
            .insert(inventoryStockPositions)
            .values({
              customerConfigurationId: firstPosition.customerConfigurationId,
              lifecycleState: 'CURRENT',
              onHandState: 'UNKNOWN',
              ownerConfigurationId: configurationId,
              stockItemId: itemId,
              stockLocationId: secondLocationId,
              stockPositionId: randomUUID(),
              stockUnitModuleId: firstPosition.stockUnitModuleId,
              stockUnitResourceId: unitId,
              stockUnitResourceType: firstPosition.stockUnitResourceType,
              stockUnitTenantId: tenantId,
              tenantId,
            })
            .returning({ createdAt: inventoryStockPositions.createdAt });
          expect(snapshot.observedAt).toBeDefined();
          expect(laterInsert).toBeDefined();
          const result = yield* evaluateRelevantStockPositionSet(input, snapshot, scope);
          if (result.outcome === 'COMPLETE' && snapshot.observedAt !== undefined && laterInsert !== undefined) {
            expect(DateTime.toEpochMillis(result.completeness.observedAt)).toBe(snapshot.observedAt.getTime());
            expect(snapshot.observedAt.getTime()).toBeLessThanOrEqual(laterInsert.createdAt.getTime());
          }
          return result;
        }),
      );
      expect(first.outcome).toBe('COMPLETE');
      if (first.outcome !== 'COMPLETE') {
        return;
      }
      expect(first.positionRefs).toHaveLength(1);
      const next = yield* runtime.transaction((transaction) =>
        Effect.gen(function* revalidateAfterInsert() {
          const scoped = yield* installOperationalScope(transaction, scope);
          const snapshot = yield* observeRelevantStockPositionSet(scoped, scope, input.scope);
          return yield* evaluateRelevantStockPositionSet(
            { ...input, previousCompleteness: first.completeness },
            snapshot,
            scope,
          );
        }),
      );
      expect(next.outcome).toBe('COMPLETE');
      if (next.outcome === 'COMPLETE') {
        expect(next.positionRefs).toHaveLength(2);
        expect(next.previousProof).toBe('INVALIDATED');
      }
      if (next.outcome !== 'COMPLETE') {
        return;
      }
      const revalidate = (previousCompleteness: typeof next.completeness) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* verifyMaterialChanges() {
            const scoped = yield* installOperationalScope(transaction, scope);
            const snapshot = yield* observeRelevantStockPositionSet(scoped, scope, input.scope);
            return yield* evaluateRelevantStockPositionSet({ ...input, previousCompleteness }, snapshot, scope);
          }),
        );
      const eligibilityId = randomUUID();
      yield* admin.insert(inventoryStockSharingEligibilities).values({
        ...sharing,
        eligibilityId,
        ownerConfigurationId: configurationId,
        sellingLegalEntityId: scope.legalEntityId,
        stockPositionId: positionId,
        tenantId,
      });
      const sharingChanged = yield* revalidate(next.completeness);
      expect(sharingChanged.outcome).toBe('COMPLETE');
      if (sharingChanged.outcome !== 'COMPLETE') {
        return;
      }
      expect(sharingChanged.previousProof).toBe('INVALIDATED');
      expect(sharingChanged.sharingEligibility).toBe('NOT_EVALUATED');
      yield* admin
        .update(inventoryCatalogToStockBindings)
        .set({ currentRevision: 2 })
        .where(eq(inventoryCatalogToStockBindings.bindingId, bindingId));
      const bindingChanged = yield* revalidate(sharingChanged.completeness);
      expect(bindingChanged.outcome).toBe('COMPLETE');
      if (bindingChanged.outcome !== 'COMPLETE') {
        return;
      }
      expect(bindingChanged.previousProof).toBe('INVALIDATED');
      const bindingSnapshot = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        bindingRef: {
          moduleId: 'commerce.inventory',
          resourceId: bindingId,
          resourceType: 'commerce.inventory.catalog-to-stock-binding',
          tenantId,
        },
        catalogSelection: {
          ...binding.catalogSelection,
          productRef: { ...binding.catalogSelection.productRef, tenantId },
          variantRef: { ...binding.catalogSelection.variantRef, tenantId },
        },
        effectiveFrom: binding.effectiveFrom.toISOString(),
        exactSelectionMeaning: { id: binding.exactSelectionMeaningId, kind: binding.exactSelectionKind },
        revision: 1,
        stockItemRef: input.scope.stockItemRef,
        unitRef: input.scope.unitRef,
      });
      const eligibilityIds = [eligibilityId, randomUUID(), randomUUID()];
      yield* admin.insert(inventoryStockSharingEligibilities).values(
        eligibilityIds.slice(1).map((id) => ({
          ...sharing,
          eligibilityId: id,
          ownerConfigurationId: configurationId,
          sellingLegalEntityId: scope.legalEntityId,
          stockPositionId: positionId,
          tenantId,
        })),
      );
      yield* admin.insert(inventoryCatalogToStockBindingHistory).values(
        Array.from({ length: 20 }, (_unused, index) => ({
          bindingId,
          endedAt: binding.effectiveFrom,
          ownerEvidenceRef: 'aggregate-snapshot-test',
          revision: index + 1,
          snapshot: bindingSnapshot,
          tenantId,
          transition: 'CORRECTED' as const,
        })),
      );
      for (const id of eligibilityIds) {
        const sharingSnapshot = Schema.decodeUnknownSync(StockSharingEligibilitySchema)({
          commerceValidation: {
            evidenceRef: sharing.commerceValidationEvidenceRef,
            observedAt: sharing.commerceValidationObservedAt.toISOString(),
            verification: 'OWNER_VERIFIED_CURRENT',
          },
          effectivePeriod: { from: sharing.effectiveFrom.toISOString(), to: null },
          lifecycle: 'CURRENT',
          ref: {
            moduleId: 'commerce.inventory',
            resourceId: id,
            resourceType: 'commerce.inventory.stock-sharing-eligibility',
            tenantId,
          },
          revision: 1,
          scope: {
            customerConfigurationId: input.scope.customerConfigurationId,
            ownerConfigurationRef: input.scope.ownerConfigurationRef,
            positionRef: {
              moduleId: 'commerce.inventory',
              resourceId: positionId,
              resourceType: 'commerce.inventory.stock-position',
              tenantId,
            },
          },
          subject: {
            channel: 'B2C',
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: scope.legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
          },
        });
        yield* admin.insert(inventoryStockSharingEligibilityHistory).values(
          Array.from({ length: 10 }, (_unused, index) => ({
            eligibilityId: id,
            revision: index + 1,
            snapshot: sharingSnapshot,
            tenantId,
            transitionAt: sharing.effectiveFrom,
          })),
        );
      }
      yield* admin
        .update(inventoryStockPositions)
        .set({
          onHandAmount: '12345678901234567890.123456789',
          onHandEvidenceRef: 'exact-decimal-test',
          onHandObservedAt: sharing.effectiveFrom,
          onHandState: 'CURRENT',
        })
        .where(eq(inventoryStockPositions.stockPositionId, positionId));
      const aggregated = yield* runtime.transaction((transaction) =>
        Effect.gen(function* verifyIndependentAggregates() {
          const scoped = yield* installOperationalScope(transaction, scope);
          const snapshot = yield* observeRelevantStockPositionSet(scoped, scope, input.scope);
          expect(snapshot.positions).toHaveLength(2);
          expect(snapshot.sharing).toHaveLength(3);
          expect(snapshot.bindingHistory).toHaveLength(20);
          expect(snapshot.sharingHistory).toHaveLength(30);
          expect(snapshot.positions.find((row) => row.stockPositionId === positionId)?.onHandAmount).toBe(
            '12345678901234567890.123456789',
          );
          expect(snapshot.bindingHistory.every((row) => Predicate.isDate(row.endedAt))).toBe(true);
          const historyIds = snapshot.sharingHistory.map((row) => row.historyId);
          expect(historyIds.every((id, index) => index === 0 || id > (historyIds[index - 1] ?? ''))).toBe(true);
          return yield* evaluateRelevantStockPositionSet(
            { ...input, previousCompleteness: bindingChanged.completeness },
            snapshot,
            scope,
          );
        }),
      );
      expect(aggregated.outcome).toBe('COMPLETE');
      if (aggregated.outcome !== 'COMPLETE') {
        return;
      }
      expect(aggregated.previousProof).toBe('INVALIDATED');
      const stable = yield* revalidate(aggregated.completeness);
      expect(stable.outcome).toBe('COMPLETE');
      if (stable.outcome === 'COMPLETE') {
        expect(stable.previousProof).toBe('CURRENT');
      }
      yield* admin
        .update(inventoryStockPositions)
        .set({
          endedAt: new Date('2026-10-05T12:00:00.000Z'),
          lifecycleState: 'HISTORICAL',
          onHandState: 'STALE',
          revision: 2,
        })
        .where(eq(inventoryStockPositions.stockPositionId, positionId));
      const ended = yield* revalidate(aggregated.completeness);
      expect(ended.outcome).toBe('COMPLETE');
      if (ended.outcome === 'COMPLETE') {
        expect(ended.previousProof).toBe('INVALIDATED');
        expect(ended.positionRefs).toHaveLength(1);
      }
    }),
  ),
);
