import { randomUUID } from 'node:crypto';

import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { RelevantStockPositionSetRequestSchema } from '../../shared/domain/current-relevant-stock-position-set.ts';
import {
  inventoryBackendConfigurations,
  inventoryCatalogToStockBindings,
  inventoryRelations,
  inventoryStockItems,
  inventoryStockLocations,
  inventoryStockPositions,
  inventoryStockSharingEligibilities,
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
      yield* admin.insert(inventoryStockSharingEligibilities).values({
        ...sharing,
        eligibilityId: randomUUID(),
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
      yield* admin
        .update(inventoryStockPositions)
        .set({ endedAt: new Date('2026-10-05T12:00:00.000Z'), lifecycleState: 'HISTORICAL', revision: 2 })
        .where(eq(inventoryStockPositions.stockPositionId, positionId));
      const ended = yield* revalidate(bindingChanged.completeness);
      expect(ended.outcome).toBe('COMPLETE');
      if (ended.outcome === 'COMPLETE') {
        expect(ended.previousProof).toBe('INVALIDATED');
        expect(ended.positionRefs).toHaveLength(1);
      }
    }),
  ),
);
