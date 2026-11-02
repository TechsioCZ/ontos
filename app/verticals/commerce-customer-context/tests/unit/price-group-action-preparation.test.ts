import type { OperationalScope } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { DateTime, Schema } from 'effect';
import { PriceGroupCompatibilityEvidenceSchema } from '../../shared/domain/price-group-contracts.ts';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type { PriceGroupCompatibilityEvidence } from '../../shared/domain/price-group-contracts.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import type {
  AssignCustomerPriceGroupStoreInput,
  MigrateCustomerPriceGroupStoreInput,
} from '../../shared/domain/price-group-ports.ts';
import { assignCustomerPriceGroupAction } from '../../src/actions/assign-customer-price-group.action.ts';
import { assignCounterpartyPriceGroupAction } from '../../src/actions/assign-counterparty-price-group.action.ts';
import { migrateCustomerPriceGroupAction } from '../../src/actions/migrate-customer-price-group.action.ts';
import { migrateCounterpartyPriceGroupAction } from '../../src/actions/migrate-counterparty-price-group.action.ts';
import { removeCustomerPriceGroupAction } from '../../src/actions/remove-customer-price-group.action.ts';
import { removeCounterpartyPriceGroupAction } from '../../src/actions/remove-counterparty-price-group.action.ts';
import {
  preparePriceGroupActionServices,
  priceGroupMutationCanReachCatalog,
  preparedPriceGroupAssignmentMatches,
  preparedPriceGroupMigrationMatches,
  preparedPriceGroupPayloadMatches,
  preparedPriceGroupScopeMatches,
  preparedPriceGroupWindowOpen,
  samePreparedPriceGroupProfile,
} from '../../src/actions/price-group-action-preparation.ts';

const scope: OperationalScope = {
  audience: 'commerce-customer-context',
  authBindingId: '12480000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:price-group-preparation',
  authenticationNamespaceId: 'staff',
  authMethod: 'session',
  correlationId: 'price-group-preparation',
  legalEntityId: '12480000-0000-4000-8000-000000000002',
  principalId: '12480000-0000-4000-8000-000000000003',
  tenantId: '12480000-0000-4000-8000-000000000004',
  traceId: 'price-group-preparation-trace',
};
const millis = (instant: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(instant));
const compositionRevision = 'a'.repeat(64);
const invocation = '12480000-0000-4000-8000-000000000005';
const trustedOperationAt = '2026-10-31T12:00:00.000Z';
const ownerEnd = '2026-10-31T12:00:05.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '12480000-0000-4000-8000-000000000006',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId: scope.tenantId,
};
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '12480000-0000-4000-8000-000000000007',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId: scope.tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '12480000-0000-4000-8000-000000000008',
  resourceType: 'party.registry.counterparty',
  tenantId: scope.tenantId,
} as const;
const compatibility: PriceGroupCompatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: trustedOperationAt, effectiveTo: ownerEnd },
  definitionRevisionId: '12480000-0000-4000-8000-000000000009',
  definitionRevisionNumber: 3,
  meaningFingerprint: 'b'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, version: 1 },
  trustedOperationAt,
  verifiedAt: '2026-10-31T12:00:01.000Z',
};
const payload = {
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: '2026-12-01T00:00:00.000Z',
  expectedProfileRevision: 2,
  priceGroupRef,
  profile,
  reason: 'Assign the current contract group.',
};
const input: AssignCustomerPriceGroupStoreInput = {
  ...payload,
  actionInvocationId: invocation,
  compatibility,
  principalId: scope.principalId,
  recordedAt: '2026-10-31T12:00:02.000Z',
  tenantId: scope.tenantId,
};

it('prepares all four Catalog-dependent Actions and leaves Remove Actions local', () => {
  expect(getActionServicePreflight(assignCustomerPriceGroupAction)).toBe(preparePriceGroupActionServices);
  expect(getActionServicePreflight(assignCounterpartyPriceGroupAction)).toBe(preparePriceGroupActionServices);
  expect(getActionServicePreflight(migrateCustomerPriceGroupAction)).toBe(preparePriceGroupActionServices);
  expect(getActionServicePreflight(migrateCounterpartyPriceGroupAction)).toBe(preparePriceGroupActionServices);
  expect(getActionServicePreflight(removeCustomerPriceGroupAction)).toBeUndefined();
  expect(getActionServicePreflight(removeCounterpartyPriceGroupAction)).toBeUndefined();
});

it('defers retroactive schedules to the handler without reaching Catalog for any Assign or Migrate Action', () => {
  const current = { _tag: 'CURRENT', counterpartyRef: null, revision: 2, state: 'ACTIVE' } as const;
  const counterpartyCurrent = { ...current, counterpartyRef };
  const counterpartyProfile = {
    ...profile,
    kind: 'COUNTERPARTY',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  } as const;
  const assignmentRef = {
    moduleId: 'commerce.customer-context',
    resourceId: '12480000-0000-4000-8000-000000000010',
    resourceType: 'commerce.customer-context.customer-price-group-assignment',
    tenantId: scope.tenantId,
  } as const;
  const migration = {
    effectiveFrom: payload.effectiveFrom,
    reason: payload.reason,
    sourcePriceGroupRef: { ...priceGroupRef, resourceId: 'source-group' },
    targetPriceGroupRef: priceGroupRef,
    targets: [{ assignmentRef, expectedProfileRevision: 2, expectedRevision: 4, profile }],
  };
  const counterpartyMigration = {
    ...migration,
    counterpartyRef,
    targets: [{ assignmentRef, expectedProfileRevision: 2, expectedRevision: 4, profile: counterpartyProfile }],
  };
  const cases = [
    { facts: [current], intent: payload },
    { facts: [counterpartyCurrent], intent: { ...payload, counterpartyRef, profile: counterpartyProfile } },
    { facts: [current], intent: migration },
    { facts: [counterpartyCurrent], intent: counterpartyMigration },
  ];
  for (const { facts, intent } of cases) {
    const effectiveAt = millis(intent.effectiveFrom);
    expect(priceGroupMutationCanReachCatalog(intent, facts, effectiveAt - 1)).toBe(true);
    expect(priceGroupMutationCanReachCatalog(intent, facts, effectiveAt)).toBe(true);
    expect(priceGroupMutationCanReachCatalog(intent, facts, effectiveAt + 1)).toBe(false);
  }
});

it('does not let schedule deferral bypass the exact owner profile snapshot gate', () => {
  const current = { _tag: 'CURRENT', counterpartyRef: null, revision: 2, state: 'ACTIVE' } as const;
  const beforeSchedule = millis(payload.effectiveFrom) - 1;
  expect(priceGroupMutationCanReachCatalog(payload, [current], beforeSchedule)).toBe(true);
  expect(priceGroupMutationCanReachCatalog(payload, [], beforeSchedule)).toBe(false);
  expect(priceGroupMutationCanReachCatalog(payload, [{ _tag: 'NOT_FOUND' }], beforeSchedule)).toBe(false);
  expect(priceGroupMutationCanReachCatalog(payload, [{ ...current, revision: 3 }], beforeSchedule)).toBe(false);
  expect(priceGroupMutationCanReachCatalog(payload, [{ ...current, state: 'SUSPENDED' }], beforeSchedule)).toBe(false);
});

it('honors the actual exclusive owner End without relabeling the prepared trustedOperationAt', () => {
  const original = structuredClone(compatibility);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, millis(ownerEnd) - 1)).toBe(true);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, millis(ownerEnd))).toBe(false);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, millis(ownerEnd) + 1)).toBe(false);
  expect(preparedPriceGroupWindowOpen(compatibility, input.recordedAt, millis(input.recordedAt))).toBe(false);
  expect(compatibility).toEqual(original);
});

it('caps long and explicitly open-ended owner periods without extending the observation on reuse', () => {
  const long = {
    ...compatibility,
    definitionEffectivePeriod: { ...compatibility.definitionEffectivePeriod, effectiveTo: payload.effectiveTo },
  };
  const open = {
    ...compatibility,
    definitionEffectivePeriod: { ...compatibility.definitionEffectivePeriod, effectiveTo: null },
  };
  const cap = millis(trustedOperationAt) + 30_000;
  expect(preparedPriceGroupWindowOpen(long, trustedOperationAt, cap - 1)).toBe(true);
  expect(preparedPriceGroupWindowOpen(long, trustedOperationAt, cap)).toBe(false);
  expect(preparedPriceGroupWindowOpen(open, trustedOperationAt, cap - 1)).toBe(true);
  expect(preparedPriceGroupWindowOpen(open, trustedOperationAt, cap)).toBe(false);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, millis(trustedOperationAt))).toBe(false);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, Number.NaN)).toBe(false);
});

it('does not invent an owner period or End when validity is absent or malformed', () => {
  const { effectiveTo: _end, ...withoutEnd } = compatibility.definitionEffectivePeriod;
  const { definitionEffectivePeriod: _period, ...withoutPeriod } = compatibility;
  const accepts = Schema.is(PriceGroupCompatibilityEvidenceSchema);
  expect(accepts({ ...compatibility, definitionEffectivePeriod: withoutEnd })).toBe(false);
  expect(accepts(withoutPeriod)).toBe(false);
  expect(
    accepts({
      ...compatibility,
      definitionEffectivePeriod: { ...compatibility.definitionEffectivePeriod, effectiveTo: 'invalid' },
    }),
  ).toBe(false);
});

it('binds exact scope, principal authentication, Legal Entity, Storefront, and composition', () => {
  const matches = (actual: OperationalScope, revision = compositionRevision) =>
    preparedPriceGroupScopeMatches(scope, actual, compositionRevision, revision);
  expect(matches({ ...scope })).toBe(true);
  expect(matches({ ...scope, principalId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...scope, tenantId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...scope, legalEntityId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...scope, authBindingId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...scope, authenticationNamespaceId: 'another-namespace' })).toBe(false);
  expect(matches({ ...scope, trustedStorefrontId: 'another-storefront' })).toBe(false);
  expect(matches({ ...scope, audience: 'another-owner' })).toBe(false);
  expect(matches({ ...scope, correlationId: 'another-request' })).toBe(false);
  expect(matches({ ...scope, traceId: 'another-trace' })).toBe(false);
  expect(matches(scope, 'c'.repeat(64))).toBe(false);
});

it('binds the complete assignment intent and invocation but permits a fresh final recordedAt', () => {
  const matches = (actual: AssignCustomerPriceGroupStoreInput) =>
    preparedPriceGroupAssignmentMatches(payload, invocation, scope, compatibility, actual);
  expect(matches(input)).toBe(true);
  expect(matches({ ...input, recordedAt: '2026-10-31T12:00:03.000Z' })).toBe(true);
  expect(matches({ ...input, actionInvocationId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...input, principalId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...input, tenantId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...input, reason: 'A different intent' })).toBe(false);
  expect(matches({ ...input, counterpartyRef })).toBe(false);
  expect(matches({ ...input, expectedProfileRevision: 3 })).toBe(false);
  expect(matches({ ...input, effectiveFrom: payload.effectiveTo })).toBe(false);
  expect(matches({ ...input, effectiveTo: null })).toBe(false);
  expect(matches({ ...input, priceGroupRef: { ...priceGroupRef, resourceId: 'another-group' } })).toBe(false);
  expect(matches({ ...input, compatibility: { ...compatibility, trustedOperationAt: input.recordedAt } })).toBe(false);
  expect(
    matches({
      ...input,
      compatibility: {
        ...compatibility,
        definitionEffectivePeriod: { ...compatibility.definitionEffectivePeriod, effectiveTo: null },
      },
    }),
  ).toBe(false);
});

it('binds every migration target revision, source, order, and Counterparty association', () => {
  const counterpartyProfile = {
    ...profile,
    kind: 'COUNTERPARTY',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  } as const;
  const target = {
    assignmentRef: {
      moduleId: 'commerce.customer-context',
      resourceId: '12480000-0000-4000-8000-000000000010',
      resourceType: 'commerce.customer-context.customer-price-group-assignment',
      tenantId: scope.tenantId,
    },
    expectedProfileRevision: 2,
    expectedRevision: 4,
    profile: counterpartyProfile,
  } as const;
  const second = { ...target, assignmentRef: { ...target.assignmentRef, resourceId: 'another-assignment' } };
  const migration = {
    counterpartyRef,
    effectiveFrom: payload.effectiveFrom,
    reason: payload.reason,
    sourcePriceGroupRef: { ...priceGroupRef, resourceId: 'source-group' },
    targetPriceGroupRef: priceGroupRef,
    targets: [target, second],
  };
  const mutation: MigrateCustomerPriceGroupStoreInput = {
    ...migration,
    actionInvocationId: invocation,
    compatibility,
    principalId: scope.principalId,
    recordedAt: input.recordedAt,
    tenantId: scope.tenantId,
  };
  expect(preparedPriceGroupMigrationMatches(migration, invocation, scope, compatibility, mutation)).toBe(true);
  expect(preparedPriceGroupPayloadMatches(migration, { ...migration, targets: [second, target] })).toBe(false);
  expect(
    preparedPriceGroupPayloadMatches(migration, {
      ...migration,
      targets: [{ ...target, expectedRevision: 5 }, second],
    }),
  ).toBe(false);
  expect(
    preparedPriceGroupPayloadMatches(migration, {
      ...migration,
      counterpartyRef: { ...counterpartyRef, resourceId: 'another-counterparty' },
    }),
  ).toBe(false);
  expect(preparedPriceGroupPayloadMatches(migration, { ...migration, sourcePriceGroupRef: priceGroupRef })).toBe(false);
});

it('rechecks profile existence, revision, lifecycle, and exact association rather than only its ID', () => {
  const current = { _tag: 'CURRENT', counterpartyRef, revision: 2, state: 'ACTIVE' } as const;
  expect(samePreparedPriceGroupProfile(current, structuredClone(current))).toBe(true);
  expect(samePreparedPriceGroupProfile(current, { _tag: 'NOT_FOUND' })).toBe(false);
  expect(samePreparedPriceGroupProfile(current, { ...current, revision: 3 })).toBe(false);
  expect(samePreparedPriceGroupProfile(current, { ...current, state: 'SUSPENDED' })).toBe(false);
  expect(samePreparedPriceGroupProfile(current, { ...current, counterpartyRef: null })).toBe(false);
  expect(
    samePreparedPriceGroupProfile(current, {
      ...current,
      counterpartyRef: { ...counterpartyRef, resourceId: 'another-counterparty' },
    }),
  ).toBe(false);
});
