import { CreateRuleResultSchema } from '@app/assortment/actions/create-rule';
import { SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { decodeSymmyAssortmentRuleSource, mapSymmyAssortmentRule } from '../../shared/symmy-internal-contracts.ts';

const tenantId = '3d46590b-7eae-422c-9643-e5bd5c13403b';
const sellerId = '50aa3386-3f2a-456a-8ad6-28e402754e26';
const otherTenantId = 'ba2b0e85-3862-4c7b-9484-3c438d11fb44';
const mappingVersion = 'INTERNAL_C14_ASSORTMENT_RULE_V1';
const ruleOperation = 'commerce.assortment.create-rule';
const bindingOperation = 'commerce.assortment.create-applicability-binding';

const route = Schema.decodeUnknownSync(SymmyRouteContextSchema)({
  allowedOwnerOperations: [ruleOperation, bindingOperation].map((entrypointKey) => ({
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
    commerceMarketRef: ref('commerce.market-catalog', 'commerce.market-catalog.market', 'fixture-market'),
    sellingLegalEntityRef: ref('party.registry', 'party.registry.legal-entity', sellerId),
    storefrontRef: ref('commerce.storefront-registry', 'commerce.storefront-registry.storefront', 'fixture-storefront'),
  },
  contractVersion: mappingVersion,
  effect: 'DENY',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  purpose: 'PURCHASE',
  reason: 'An explicit fixture policy restricts the group',
  selector: { kind: 'PRODUCT', productRef: ref('commerce.catalog', 'commerce.catalog.product', 'fixture-product') },
  sourceRecordId: 'source-rule-1',
};

const receiptFor = (receiptTenant: string) =>
  Schema.decodeUnknownSync(CreateRuleResultSchema)({
    created: true,
    initialRuleRevisionRef: {
      ownerModuleId: 'commerce.assortment',
      revision: '1',
      sourceRef: {
        ...ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision'),
        tenantId: receiptTenant,
      },
    },
    stableRuleRef: {
      ...ref('commerce.assortment', 'commerce.assortment.stable-rule', 'rule'),
      tenantId: receiptTenant,
    },
  });

it.effect('maps an explicit rule to the exact owner payloads using the returned initial revision', () =>
  Effect.gen(function* verifiedRuleMapping() {
    const plan = yield* mapSymmyAssortmentRule(route, yield* decodeSymmyAssortmentRuleSource(source));
    const original = receiptFor(tenantId);
    const binding = yield* plan.binding(original);
    expect(plan.record).toMatchObject({ issuerId: route.issuerId, sourceRecordId: source.sourceRecordId });
    expect(plan.rule).toMatchObject({ effect: 'DENY', purpose: 'PURCHASE', selector: source.selector });
    expect(binding.audience).toEqual(source.audience);
    expect(binding.commercialScope).toEqual(source.commercialScope);
    expect(DateTime.formatIso(binding.effectiveFrom)).toBe(source.effectiveFrom);
    expect(binding.ruleRevisionRef).toEqual(original.initialRuleRevisionRef);
    expect(binding.provenanceRef).toBe(plan.rule.provenanceRef);
  }),
);

it.effect('keeps the stable rule code across retries without merging different issuers or routes', () =>
  Effect.gen(function* qualifiedRuleIdentity() {
    const fact = yield* decodeSymmyAssortmentRuleSource(source);
    const baseline = yield* mapSymmyAssortmentRule(route, fact);
    const retry = yield* mapSymmyAssortmentRule(route, fact);
    const otherIssuer = Schema.decodeUnknownSync(SymmyRouteContextSchema)({ ...route, issuerId: 'other-producer' });
    const isolated = yield* mapSymmyAssortmentRule(otherIssuer, fact);
    expect(retry.rule).toEqual(baseline.rule);
    expect(isolated.rule.stableCode).not.toBe(baseline.rule.stableCode);
  }),
);

it.effect('rejects missing authority, cross-tenant references and a foreign owner receipt', () =>
  Effect.gen(function* deniedRuleMapping() {
    const denied = Schema.decodeUnknownSync(SymmyRouteContextSchema)({
      ...route,
      allowedOwnerOperations: route.allowedOwnerOperations.slice(0, 1),
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
    const plan = yield* mapSymmyAssortmentRule(route, fact);
    const receiptFailure = yield* Effect.flip(plan.binding(receiptFor(otherTenantId)));
    expect(receiptFailure).toMatchObject({ reason: 'rule_receipt_scope_mismatch' });
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
