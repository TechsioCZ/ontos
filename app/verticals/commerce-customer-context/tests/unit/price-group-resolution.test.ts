/* eslint-disable effect-native/no-manual-tag-comparison -- Resolution tests assert all four exact public discriminants and evidence payloads; expires: 2027-03-01. */
import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { AssignCustomerPriceGroupPayloadSchema } from '../../src/actions/assign-customer-price-group.action.ts';
import {
  customerPriceGroupAssignmentReadPermission,
  customerPriceGroupAssignmentReadRead,
  readCustomerPriceGroupAssignments,
} from '../../src/api/customer-price-group-assignment-read.read.ts';
import {
  customerPriceGroupResolutionPermission,
  customerPriceGroupResolutionRead,
  resolveCustomerPriceGroupFromServices,
} from '../../src/api/customer-price-group-resolution.read.ts';
import { CustomerPriceGroupResolutionRequestSchema } from '../../shared/apis/customer-price-group-resolution.ts';
import type {
  CustomerPriceGroupAssignment,
  PriceGroupCatalogOutcome,
  PriceGroupRef,
} from '../../shared/domain/price-group-contracts.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import type {
  CustomerPriceGroupAssignmentStorePort,
  PriceGroupCatalogPort,
} from '../../shared/domain/price-group-ports.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import { resolveCustomerPriceGroupAt } from '../../shared/domain/price-group-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const priceGroupRef: PriceGroupRef = {
  moduleId: 'pricing.catalog',
  resourceId: 'price-group-standard',
  resourceType: 'pricing.catalog.price-group',
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const counterpartyProfile = {
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId: 'counterparty-profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const compatibility = {
  catalogRevision: 7,
  contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
  contractRevision: 1,
  definitionRevision: 4,
} as const;

const assignment = (
  resourceId: string,
  effectiveFrom = '2026-01-01T00:00:00.000Z',
  effectiveTo: string | null = null,
): CustomerPriceGroupAssignment => ({
  assignmentRef: {
    moduleId: 'commerce.customer-context',
    resourceId,
    resourceType: 'commerce.customer-context.customer-price-group-assignment',
    tenantId,
  },
  compatibility,
  effectiveFrom,
  effectiveTo,
  priceGroupRef,
  profile,
  reason: 'Contracted customer pricing',
  recordedAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
  state: 'ACTIVE',
});

const catalog = (outcome: PriceGroupCatalogOutcome): PriceGroupCatalogPort => ({
  resolveCurrent: () => Effect.succeed(outcome),
});
const unavailableStore = () => Effect.die('store must not run after profile not-found');
const unreachableStore: CustomerPriceGroupAssignmentStorePort = {
  assign: unavailableStore,
  list: unavailableStore,
  migrate: unavailableStore,
  remove: unavailableStore,
  resolve: unavailableStore,
};

it.effect('resolves NONE only when there is no current temporal assignment', () =>
  Effect.gen(function* noCurrentAssignment() {
    const result = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('past', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')],
      '2026-03-01T00:00:00.000Z',
      catalog({ _tag: 'MISSING' }),
    );
    expect(result).toEqual({ _tag: 'NONE' });
  }),
);

it.effect('returns ASSIGNED with fresh compatibility evidence from the Pricing catalog', () =>
  Effect.gen(function* assignedResolution() {
    let catalogEffectiveAt = '';
    const result = yield* resolveCustomerPriceGroupAt(profile, [assignment('current')], '2026-03-01T00:00:00.000Z', {
      resolveCurrent: (_ref, _contract, effectiveAt) => {
        catalogEffectiveAt = effectiveAt;
        return Effect.succeed({ _tag: 'USABLE', compatibility, priceGroupRef });
      },
    });
    expect(catalogEffectiveAt).toBe('2026-03-01T00:00:00.000Z');
    expect(result._tag).toBe('ASSIGNED');
    if (result._tag === 'ASSIGNED') {
      expect(result.compatibility.catalogRevision).toBe(7);
      expect(result.priceGroupRef).toEqual(priceGroupRef);
    }
  }),
);

it.effect('threads one trusted Read instant and exact Counterparty association through inspection', () =>
  Effect.gen(function* timedCounterpartyInspection() {
    const inspected: unknown[][] = [];
    const profileValidation = {
      inspect: (...input: unknown[]) => {
        inspected.push(input);
        return Effect.succeed({ _tag: 'NOT_FOUND' } as const);
      },
    };
    const now = Effect.succeed('2026-03-01T00:00:00.000Z');
    const request = {
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const },
      profile: counterpartyProfile,
    };
    yield* Effect.exit(
      readCustomerPriceGroupAssignments(request, tenantId, {
        now,
        profileValidation,
        store: unreachableStore,
      }),
    );
    yield* Effect.exit(
      resolveCustomerPriceGroupFromServices(request, tenantId, {
        catalog: catalog({ _tag: 'MISSING' }),
        now,
        profileValidation,
        store: unreachableStore,
      }),
    );
    expect(inspected).toEqual([
      [counterpartyProfile, '2026-03-01T00:00:00.000Z', counterpartyRef],
      [counterpartyProfile, '2026-03-01T00:00:00.000Z', counterpartyRef],
    ]);
  }),
);

it.effect('resolves from the dedicated current-at lookup instead of capped history', () =>
  Effect.gen(function* dedicatedCurrentLookup() {
    let resolvedAt = '';
    const result = yield* resolveCustomerPriceGroupFromServices(
      {
        authorizationSubject: { kind: 'RETAIL' },
        profile,
      },
      tenantId,
      {
        catalog: catalog({ _tag: 'MISSING' }),
        now: Effect.succeed('2026-03-01T00:00:00.000Z'),
        profileValidation: {
          inspect: () =>
            Effect.succeed({
              _tag: 'CURRENT',
              counterpartyRef: null,
              revision: 1,
              state: 'ACTIVE',
            }),
        },
        store: {
          ...unreachableStore,
          resolve: (_profile, effectiveAt) => {
            resolvedAt = effectiveAt;
            return Effect.succeed({ _tag: 'found', assignments: [] });
          },
        },
      },
    );
    expect(resolvedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(result.resolution).toEqual({ _tag: 'NONE' });
  }),
);

it.effect('reports every unusable catalog state as BROKEN instead of falling back', () =>
  Effect.gen(function* brokenResolution() {
    const missing = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('missing')],
      '2026-03-01T00:00:00.000Z',
      catalog({ _tag: 'MISSING' }),
    );
    expect(missing).toMatchObject({ _tag: 'BROKEN', catalogRevision: null, reason: 'MISSING' });

    const retired = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('retired')],
      '2026-03-01T00:00:00.000Z',
      catalog({ _tag: 'RETIRED', catalogRevision: 8 }),
    );
    expect(retired).toMatchObject({ _tag: 'BROKEN', catalogRevision: 8, reason: 'RETIRED' });
  }),
);

it.effect('reports overlapping current assignments as INCONSISTENT without catalog access', () =>
  Effect.gen(function* inconsistentResolution() {
    let catalogCalls = 0;
    const result = yield* resolveCustomerPriceGroupAt(
      profile,
      [assignment('one'), assignment('two')],
      '2026-03-01T00:00:00.000Z',
      {
        resolveCurrent: () => {
          catalogCalls += 1;
          return Effect.succeed({ _tag: 'MISSING' });
        },
      },
    );
    expect(result).toEqual({ _tag: 'INCONSISTENT', currentAssignmentCount: 2 });
    expect(catalogCalls).toBe(0);
  }),
);

it.effect('propagates catalog unavailability and never collapses it into NONE', () =>
  Effect.gen(function* unavailableResolution() {
    const exit = yield* Effect.exit(
      resolveCustomerPriceGroupAt(profile, [assignment('current')], '2026-03-01T00:00:00.000Z', {
        resolveCurrent: () =>
          Effect.fail(
            new CustomerPriceGroupCatalogUnavailable({
              code: 'customer_price_group_catalog_unavailable',
              reason: 'Pricing unavailable',
            }),
          ),
      }),
    );
    expect(exit._tag).toBe('Failure');
  }),
);

it.effect('rejects invalid periods and declares tagged business-plus-resource Read authority', () =>
  Effect.gen(function* contracts() {
    const invalid = yield* Effect.exit(
      Schema.decodeUnknownEffect(AssignCustomerPriceGroupPayloadSchema)({
        effectiveFrom: '2026-03-01T00:00:00.000Z',
        effectiveTo: '2026-03-01T00:00:00.000Z',
        expectedProfileRevision: 1,
        priceGroupRef,
        profile,
        reason: 'Invalid interval',
      }),
    );
    expect(invalid._tag).toBe('Failure');
    expect(customerPriceGroupAssignmentReadRead.descriptor.permissionTarget).toBe('conditional');
    expect(customerPriceGroupResolutionRead.descriptor.permissionTarget).toBe('conditional');
    expect(customerPriceGroupAssignmentReadPermission.branchTags).toEqual(['COUNTERPARTY', 'RETAIL']);
    expect(customerPriceGroupResolutionPermission.branchTags).toEqual(['COUNTERPARTY', 'RETAIL']);
    expect(
      Schema.is(CustomerPriceGroupResolutionRequestSchema)({
        authorizationSubject: { kind: 'COUNTERPARTY' },
        profile,
      }),
    ).toBe(false);
  }),
);
