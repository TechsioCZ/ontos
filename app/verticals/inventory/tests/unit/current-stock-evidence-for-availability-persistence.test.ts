import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CurrentStockEvidenceForAvailabilityUnavailable } from '../../shared/domain/current-stock-evidence-for-availability.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { currentStockEvidenceForAvailabilityDependenciesForScope } from '../../src/persistence/current-stock-evidence-for-availability-repository.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const locationId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-09-24T10:00:00.000Z';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const locationRef = {
  moduleId: 'commerce.inventory',
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
} as const;
const position = Schema.decodeUnknownSync(StockPositionSchema)({
  createdAt: timestamp,
  endedAt: null,
  lifecycle: 'CURRENT',
  onHand: {
    _tag: 'CURRENT',
    evidenceRef: 'wms:position:42',
    meaning: 'ON_HAND',
    observedAt: timestamp,
    ownerConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    quantity: { amount: '10', unitRef },
  },
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  revision: 4,
  scope: {
    customerConfigurationId: 'customer-configuration-primary',
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    stockLocationRef: locationRef,
    unitRef,
  },
});
const activeLocationRow = {
  addressEvidence: null,
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(timestamp)),
  currentRevision: 1,
  displayName: 'Prague stock pool',
  lifecycleState: 'ACTIVE',
  physicalSiteKeys: ['prague-a'],
  scopeKind: 'PHYSICAL_SITE',
  stockLocationId: locationId,
  successorStockLocationId: null,
  tenantId,
  transitionedAt: null,
  transitionReason: null,
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(timestamp)),
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:current-stock-evidence-test:run:1',
    authMethod: 'system',
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId,
  }),
  correlationId: 'current-stock-evidence-persistence-test',
};

describe('Current Stock Evidence for Availability persistence', () => {
  it.effect('reads the exact tenant-scoped Stock Location referenced by the Position', () =>
    Effect.gen(function* readExactStockLocation() {
      const whereResult = Object.assign(Effect.succeed([]), {
        limit: () => Effect.succeed([activeLocationRow]),
      });
      const transaction = {
        select: () => ({
          from: () => ({
            where: () => whereResult,
          }),
        }),
      };
      // @ts-expect-error Mock implements only the exercised Stock Location read chain.
      const dependencies = currentStockEvidenceForAvailabilityDependenciesForScope(transaction, scope);

      const result = yield* dependencies.findStockLocation(position);

      expect(Option.isSome(result)).toBe(true);
      expect(result).toEqual(
        Option.some({
          displayName: 'Prague stock pool',
          lifecycle: { _tag: 'ACTIVE' },
          operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['prague-a'] },
          ref: locationRef,
          revision: 1,
        }),
      );
    }),
  );

  it.effect('maps a foreign Stock Location reference to typed dependency unavailability before querying', () =>
    Effect.gen(function* rejectForeignStockLocation() {
      let selectCount = 0;
      const transaction = {
        select: () => {
          selectCount += 1;
          return {
            from: () => ({
              where: () => Effect.succeed([]),
            }),
          };
        },
      };
      // @ts-expect-error Mock implements only the eager unresolved-effect query shape.
      const dependencies = currentStockEvidenceForAvailabilityDependenciesForScope(transaction, scope);
      const foreignPosition = {
        ...position,
        scope: {
          ...position.scope,
          stockLocationRef: { ...position.scope.stockLocationRef, tenantId: otherTenantId },
        },
      };

      const failure = yield* dependencies.findStockLocation(foreignPosition).pipe(Effect.flip);

      expect(Schema.is(CurrentStockEvidenceForAvailabilityUnavailable)(failure)).toBe(true);
      expect(failure.retryable).toBe(true);
      expect(selectCount).toBe(1);
    }),
  );
});
