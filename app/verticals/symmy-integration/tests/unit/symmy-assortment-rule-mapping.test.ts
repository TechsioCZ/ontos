import { SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  SymmyFixtureExecutionPlanSchema,
  SymmyInternalExecutionPlanSchema,
} from '../../shared/domain/symmy-job-execution.ts';
import { decodeSymmyAssortmentRuleSource, mapSymmyAssortmentRule } from '../../shared/symmy-internal-contracts.ts';

const tenantId = '3d46590b-7eae-422c-9643-e5bd5c13403b';
const sellerId = '50aa3386-3f2a-456a-8ad6-28e402754e26';
const otherTenantId = 'ba2b0e85-3862-4c7b-9484-3c438d11fb44';
const mappingVersion = 'INTERNAL_C14_ASSORTMENT_RULE_V1';
const ruleOperation = 'commerce.assortment.import-symmy-rule';

const route = Schema.decodeUnknownSync(SymmyRouteContextSchema)({
  allowedOwnerOperations: [ruleOperation].map((entrypointKey) => ({
    entrypointKey,
    moduleId: 'commerce.assortment',
    schemaVersion: '1',
  })),
  factFamily: 'ASSORTMENT_RULE',
  issuerId: 'test-policy-producer',
  mappingVersion,
  principalId: 'b3e8bc14-be85-4d83-acd9-2516b89cff6e',
  route: { integrationRouteId: 'test-assortment', tenantId },
  routeRevision: '1',
  sellingLegalEntityId: sellerId,
  sourceNamespace: 'policy',
});

const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
const source = {
  audience: {
    groupRef: ref('commerce.customer-context', 'commerce.customer-context.customer-group', 'fixture-wholesale'),
    kind: 'COMMERCE_CUSTOMER_GROUP',
  },
  commercialScope: {
    channelRef: ref('commerce.channel', 'commerce.channel.channel', 'fixture-wholesale'),
    commerceMarketRef: ref('commerce.market', 'commerce.market.market', 'fixture-market'),
    sellingLegalEntityRef: ref('party.registry', 'party.registry.legal-entity', sellerId),
    storefrontRef: ref('commerce.storefront', 'commerce.storefront.storefront', 'fixture-storefront'),
  },
  contractVersion: mappingVersion,
  effect: 'DENY',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  purpose: 'PURCHASE',
  reason: 'An explicit fixture policy restricts the group',
  selector: { kind: 'PRODUCT', productRef: ref('commerce.catalog', 'commerce.catalog.product', 'fixture-product') },
  sourceRecordId: 'source-rule-1',
};

it.effect('maps an explicit rule to one atomic owner command with an exact binding', () =>
  Effect.gen(function* verifiedRuleMapping() {
    const plan = yield* mapSymmyAssortmentRule(route, yield* decodeSymmyAssortmentRuleSource(source));
    const { binding, rule } = plan.payload;
    expect(plan.record).toMatchObject({ issuerId: route.issuerId, sourceRecordId: source.sourceRecordId });
    expect(rule).toMatchObject({ effect: 'DENY', purpose: 'PURCHASE', selector: source.selector });
    expect(binding.audience).toEqual(source.audience);
    expect(binding.commercialScope).toEqual(source.commercialScope);
    expect(DateTime.formatIso(binding.effectiveFrom)).toBe(source.effectiveFrom);
    expect(binding.provenanceRef).toBe(rule.provenanceRef);
  }),
);

it.effect('keeps the stable rule code across retries without merging different issuers or routes', () =>
  Effect.gen(function* qualifiedRuleIdentity() {
    const fact = yield* decodeSymmyAssortmentRuleSource(source);
    const baseline = yield* mapSymmyAssortmentRule(route, fact);
    const retry = yield* mapSymmyAssortmentRule(route, fact);
    const otherIssuer = Schema.decodeUnknownSync(SymmyRouteContextSchema)({ ...route, issuerId: 'other-producer' });
    const isolated = yield* mapSymmyAssortmentRule(otherIssuer, fact);
    expect(retry.payload.rule).toEqual(baseline.payload.rule);
    expect(isolated.payload.rule.stableCode).not.toBe(baseline.payload.rule.stableCode);
  }),
);

it.effect('rejects missing authority, cross-tenant references and incomplete commercial scope', () =>
  Effect.gen(function* deniedRuleMapping() {
    const denied = Schema.decodeUnknownSync(SymmyRouteContextSchema)({
      ...route,
      allowedOwnerOperations: [
        { ...route.allowedOwnerOperations[0], entrypointKey: 'commerce.assortment.create-rule' },
      ],
    });
    const fact = yield* decodeSymmyAssortmentRuleSource(source);
    const routeFailure = yield* Effect.flip(mapSymmyAssortmentRule(denied, fact));
    expect(routeFailure).toMatchObject({ reason: 'route_not_allowed' });
    const foreignFact = yield* decodeSymmyAssortmentRuleSource({
      ...source,
      selector: { ...source.selector, productRef: { ...source.selector.productRef, tenantId: otherTenantId } },
    });
    const scopeFailure = yield* Effect.flip(mapSymmyAssortmentRule(route, foreignFact));
    expect(scopeFailure).toMatchObject({ reason: 'source_scope_mismatch' });
    const { channelRef, sellingLegalEntityRef } = source.commercialScope;
    const wideFact = yield* decodeSymmyAssortmentRuleSource({
      ...source,
      commercialScope: { channelRef, sellingLegalEntityRef },
    });
    const wideScopeFailure = yield* Effect.flip(mapSymmyAssortmentRule(route, wideFact));
    expect(wideScopeFailure).toMatchObject({ reason: 'source_scope_mismatch' });
  }),
);

it.effect('rejects category hints and wildcard targets before constructing either owner payload', () =>
  Effect.gen(function* invalidRuleFacts() {
    const hint = yield* Effect.flip(decodeSymmyAssortmentRuleSource({ ...source, category: 'not-policy' }));
    expect(Schema.isSchemaError(hint)).toBe(true);
    const wildcard = yield* Effect.flip(decodeSymmyAssortmentRuleSource({ ...source, selector: { kind: 'ALL' } }));
    expect(Schema.isSchemaError(wildcard)).toBe(true);
  }),
);

it('accepts the exact policy intent in operator configuration only', () => {
  const configuredPlan = {
    items: [
      {
        effects: [
          {
            effectKey: 'assortment',
            intent: { _tag: 'AssortmentRuleFixture', source },
            operation: route.allowedOwnerOperations[0],
          },
        ],
        itemKey: 'rule',
        source: {
          entityKind: route.factFamily,
          issuerId: route.issuerId,
          sourceNamespace: route.sourceNamespace,
          sourceRecordId: source.sourceRecordId,
        },
        sourceOccurrenceId: 'test-occurrence',
      },
    ],
  };
  expect(Result.isSuccess(Schema.decodeUnknownResult(SymmyFixtureExecutionPlanSchema)(configuredPlan))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(SymmyInternalExecutionPlanSchema)(configuredPlan))).toBe(true);
});
