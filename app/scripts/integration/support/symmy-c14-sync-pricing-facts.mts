import { randomUUID } from 'node:crypto';

import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import type { ProductCategoryRef } from '@app/catalog/resources/product-category';
import { executeCreateProductCategoryWithAuthorization } from '@app/catalog/api/client';
import {
  executeManageExternalPriceSourcePolicyWithAuthorization,
  executeSetSupportedCurrenciesWithAuthorization,
} from '@app/pricing/api/client';
import { bootstrapInternalC14PriceInputFacts } from '@app/pricing/testing/c14-price-input-bootstrap';
import { PriceCommercialScopeSchema, PriceUnitBasisSchema } from '@app/pricing-contracts/domain/price-definition';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import { SymmyRouteExecutionConfigurationSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { assert, expect } from 'effect-rstest';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';

import type { prepareInternalSyncAuthority } from './symmy-c14-sync-authority.mts';
import { internalSyncSource } from './symmy-c14-sync-plans.mts';
import { internalStockItemKeys } from './symmy-c14-sync-stock-facts.mts';

type Authority = Effect.Success<ReturnType<typeof prepareInternalSyncAuthority>>;
export const internalSyncListCode = 'INTERNAL_C14_SOURCE_OWNED_LIST';
const groupModule = 'pricing.price-group-catalog';
const priceSource = {
  mapping: {
    mappingContractRef: 'INTERNAL_C14_SYNC_PRICE_MAPPING',
    mappingContractVersion: internalSyncSource.mappingVersion,
  },
  sourceAuthority: { sourceAuthorityRef: 'INTERNAL_C14_SYNC_PRICE_AUTHORITY', sourceAuthorityVersion: '1' },
};
export const internalSyncPricingSystem = {
  ownerModuleId: 'external.internal-c14',
  sourceSystemRef: 'INTERNAL_C14_SYNC_PRICE_SYSTEM',
} as const;
const operation = (entrypointKey: string, moduleId: string, schemaVersion: string) => ({
  entrypointKey,
  moduleId,
  schemaVersion,
});
const source = (entityKind: string) => ({
  entityKind,
  issuerId: internalSyncSource.issuerId,
  sourceNamespace: internalSyncSource.namespace,
  sourceRecordId: 'INTERNAL_C14_SOURCE_ENROLLMENT',
});

/** Shared governed configuration, including the real Category the source explicitly selects for its rows. */
export const prepareInternalSyncPricing = Effect.fn('InternalC14Sync.pricingSetup')(function* pricingSetup(input: {
  readonly authority: Authority;
  readonly catalogUrl: string;
  readonly compositionRevision: string;
  readonly marketUrl: string;
  readonly pricingUrl: string;
}) {
  const { authority, compositionRevision } = input;
  const { legalEntityId, shell, tenantId } = authority;
  const catalog = yield* shell.issueFixtureSetupGateway({ audience: 'catalog' });
  const market = yield* shell.issueFixtureSetupGateway({ audience: 'commerce-market-catalog', legalEntityId });
  const facts = yield* bootstrapInternalC14PriceInputFacts({
    market: {
      authorization: Redacted.make(`Bearer ${market.token}`),
      options: { baseUrl: input.marketUrl, compositionRevision, idempotencyKey: 'INTERNAL_C14_SYNC_MARKET' },
      payload: {
        channels: ['B2C'],
        effectivePeriod: { startsAt: yield* DateTime.now },
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        lifecycle: 'ACTIVE',
        marketCode: 'INTERNAL_C14_SYNC_MARKET',
        marketId: randomUUID(),
        purpose: 'Explicit shared commercial scope for unseen source SKUs',
        reason: 'INTERNAL_C14 one-time integration configuration',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
        supportedLocales: ['en'],
      },
      requestCorrelation: randomUUID(),
    },
    unit: {
      authorization: Redacted.make(`Bearer ${catalog.token}`),
      options: { baseUrl: input.catalogUrl, compositionRevision, idempotencyKey: 'INTERNAL_C14_SYNC_UNIT_CREATE' },
      payload: {
        code: 'INTERNAL_C14_SYNC_UNIT',
        evidenceRefs: ['INTERNAL_C14_EXPLICIT_NATIVE_STOCK_UNIT'],
        label: 'Internal Stock and Price whole unit',
        reason: 'INTERNAL_C14 one-time integration Unit',
        rule: { rounding: 'HALF_UP', step: '1' },
        unitRef: yield* Schema.decodeUnknownEffect(ProductUnitRefSchema)({
          moduleId: 'commerce.catalog',
          resourceId: randomUUID(),
          resourceType: 'commerce.catalog.product-unit',
          tenantId,
        }),
      },
      requestCorrelation: randomUUID(),
    },
  });
  const options = { baseUrl: input.pricingUrl, compositionRevision };
  const categoryGateway = yield* shell.issueFixtureSetupGateway({ audience: 'catalog' });
  const category = yield* executeCreateProductCategoryWithAuthorization(
    {
      name: 'INTERNAL_C14 source-selected merchandise',
      reason: 'Shared fixture merchandising classification explicitly selected by the source payload',
    },
    `Bearer ${categoryGateway.token}`,
    randomUUID(),
    { baseUrl: input.catalogUrl, compositionRevision, idempotencyKey: 'INTERNAL_C14_SOURCE_CATEGORY' },
  );
  assert.isOk('category' in category);
  const effectiveFrom = DateTime.formatIso(yield* DateTime.now);
  const currency = yield* shell.issueFixtureSetupGateway({ audience: 'pricing' });
  const currencies = yield* executeSetSupportedCurrenciesWithAuthorization(
    yield* Schema.decodeUnknownEffect(SetSupportedCurrenciesV2PayloadSchema)({
      expectedState: { state: 'ABSENT' },
      intendedEffectivePeriod: { effectiveFrom, effectiveTo: null },
      intent: 'ESTABLISH_CURRENT',
      reason: 'INTERNAL_C14 one-time CZK support',
      schemaVersion: '2',
      supportedCurrencies: ['CZK'],
    }),
    `Bearer ${currency.token}`,
    randomUUID(),
    { ...options, idempotencyKey: 'INTERNAL_C14_SYNC_CURRENCY' },
  );
  assert.isOk('current' in currencies);
  expect(currencies.current.supportedCurrencies).toEqual(['CZK']);
  const commercialScope = yield* Schema.decodeUnknownEffect(PriceCommercialScopeSchema)({
    channelId: 'B2C',
    marketId: facts.market.marketRef.resourceId,
    sellingLegalEntityId: legalEntityId,
  });
  const unitBasis = yield* Schema.decodeUnknownEffect(PriceUnitBasisSchema)({
    quantity: '1',
    unitRef: facts.unit.unit,
  });
  const policyIds = yield* Effect.forEach(
    ['NO_GROUP', 'ANY_PRICE_GROUP'] as const,
    Effect.fn('InternalC14Sync.establishPricePolicy')(function* establish(kind) {
      const gateway = yield* shell.issueFixtureSetupGateway({ audience: 'pricing', legalEntityId });
      const result = yield* executeManageExternalPriceSourcePolicyWithAuthorization(
        {
          intent: 'ESTABLISH',
          policy: {
            authority: priceSource.sourceAuthority,
            commercialScope,
            currencyCode: 'CZK',
            effectivePeriod: { effectiveFrom },
            mapping: priceSource.mapping,
            priceGroupCoverage: { kind },
            unitBasis,
          },
          reason: `INTERNAL_C14 source-wide ${kind}; no SKU identities`,
          verificationRef: `INTERNAL_C14_SYNC_POLICY_${kind}`,
        },
        `Bearer ${gateway.token}`,
        randomUUID(),
        { ...options, idempotencyKey: `INTERNAL_C14_SYNC_POLICY_${kind}` },
      );
      assert.isOk('policyId' in result);
      assert.isOk('outcome' in result);
      expect(result.outcome).toBe('STORED');
      return result.policyId;
    }),
    { concurrency: 1 },
  );
  expect(new Set(policyIds).size).toBe(2);
  return {
    ...facts,
    priceSource: {
      ...priceSource,
      defaults: {
        commercialScope: { channelId: 'B2C' as const, marketId: facts.market.marketRef.resourceId },
        unitBasis: { quantity: '1', unitRef: facts.unit.unit },
      },
    },
    pricingSourceSystem: internalSyncPricingSystem,
    sourceCategory: category.category.categoryRef,
  };
});

export const makeInternalSyncListEnrollment = (sourceRouteId: string) =>
  Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'list-create-authority',
            operation: operation('pricing.price-group-catalog.create-price-group', groupModule, '1'),
          },
        ],
        itemKey: 'list-enrollment',
        source: source('PRICE_GROUP'),
      },
    ],
    sourceMappingVersion: internalSyncSource.mappingVersion,
    sourceRouteId,
    sourceRouteRevision: internalSyncSource.routeRevision,
  }).pipe(Effect.flatMap(Schema.encodeEffect(SymmyRouteExecutionConfigurationSchema)));

export const makeInternalSyncListBody = (effectiveFrom: string) => ({
  priceLists: [
    {
      businessCode: internalSyncListCode,
      code: internalSyncListCode,
      description: 'Source-owned list shared by both unseen SKUs',
      effectiveFrom,
      name: 'Internal source-wide list',
      prices: [],
      purpose: 'INTERNAL_C14 integration-owned list pricing',
    },
  ],
});

export const internalSyncSkuPrices = [
  { base: '25', itemKey: internalStockItemKeys[0], list: '19' },
  { base: '43', itemKey: internalStockItemKeys[1], list: '31' },
] as const;
export const makeInternalSyncProducts = (
  keys: readonly (typeof internalStockItemKeys)[number][],
  effectiveFrom: string,
  categories?: readonly ProductCategoryRef[],
): typeof Schema.Json.Type => ({
  products: internalSyncSkuPrices
    .filter(({ itemKey }) => keys.includes(itemKey))
    .map(({ base, itemKey, list }) => {
      const prices: (typeof Schema.Json.Type)[] = [
        { amount: base, currencyCode: 'CZK', effectiveFrom },
        { amount: list, currencyCode: 'CZK', effectiveFrom, priceGroupCode: internalSyncListCode },
      ];
      const product = {
        identifier: { type: 'sku', value: itemKey },
        lifecycle: 'ACTIVE',
        name: itemKey,
        variants: [{ identifier: { type: 'sku', value: itemKey }, prices }],
      };
      return categories === undefined ? product : { ...product, categories };
    }),
});

/** Native persisted amounts and source association, not a successful HTTP envelope or a captured exact grant. */
export const assertInternalSyncPrices = Effect.fn('InternalC14Sync.persistedPrices')(function* persisted(input: {
  readonly authority: Authority;
  readonly sourceRouteId: string;
}) {
  const { admin, legalEntityId, systemPrincipalId, tenantId } = input.authority;
  const prices = yield* admin`
    select c.record_id as item_key, p.price_id, p.price_group_selector->>'kind' as selector,
      trim_scale(r.amount)::text as amount, r.revision_number,
      s.source_authority_ref, s.mapping_contract_ref, s.source_system_ref, s.source_owner_module_id,
      g.record_key as list_code, g.issuer, g.namespace, g.route_id, gi.principal_id as list_executor
    from pricing.prices p
    join pricing.price_revisions r on r.tenant_id=p.tenant_id and r.price_id=p.price_id
    join pricing.price_source_assertions s on s.tenant_id=r.tenant_id and s.price_revision_id=r.price_revision_id
    join catalog.catalog_source_correlations c on c.tenant_id=p.tenant_id
      and c.product_id=(p.catalog_selection->'productRef'->>'resourceId')::uuid and c.entity_kind='PRODUCT'
      and c.issuer_id=${internalSyncSource.issuerId} and c.record_namespace=${internalSyncSource.namespace}
      and c.route_scope=${input.sourceRouteId}
    left join price_group_catalog.price_group_source_correlations g on g.tenant_id=p.tenant_id
      and g.price_group_id=(p.price_group_selector->'priceGroupRef'->>'resourceId')::uuid
    left join core.action_invocations gi on gi.tenant_id=g.tenant_id
      and gi.action_invocation_id=g.created_by_action_invocation_id
    where p.tenant_id=${tenantId} and p.legal_entity_id=${legalEntityId}
      and p.created_by_principal_id=${systemPrincipalId}
    order by c.record_id, selector
  `;
  const parsed = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        amount: Schema.String,
        issuer: Schema.OptionFromNullOr(Schema.String),
        item_key: Schema.String,
        list_code: Schema.OptionFromNullOr(Schema.String),
        list_executor: Schema.OptionFromNullOr(Schema.String),
        mapping_contract_ref: Schema.String,
        namespace: Schema.OptionFromNullOr(Schema.String),
        price_id: Schema.String,
        revision_number: Schema.Int,
        route_id: Schema.OptionFromNullOr(Schema.String),
        selector: Schema.Literals(['NO_GROUP', 'PRICE_GROUP']),
        source_authority_ref: Schema.String,
        source_owner_module_id: Schema.String,
        source_system_ref: Schema.String,
      }),
    ),
  )(prices);
  expect(parsed).toHaveLength(4);
  expect(new Set(parsed.map(({ price_id }) => price_id)).size).toBe(4);
  for (const { base, itemKey, list } of internalSyncSkuPrices) {
    const rows = parsed.filter(({ item_key }) => item_key === `product:sku:${itemKey}`);
    expect(rows).toHaveLength(2);
    expect(rows.map(({ amount, selector }) => ({ amount, selector }))).toEqual([
      { amount: base, selector: 'NO_GROUP' },
      { amount: list, selector: 'PRICE_GROUP' },
    ]);
    for (const row of rows) {
      expect(row.revision_number).toBe(1);
      expect(row.source_authority_ref).toBe(priceSource.sourceAuthority.sourceAuthorityRef);
      expect(row.mapping_contract_ref).toBe(priceSource.mapping.mappingContractRef);
      expect(row.source_system_ref).toBe(internalSyncPricingSystem.sourceSystemRef);
      expect(row.source_owner_module_id).toBe(internalSyncPricingSystem.ownerModuleId);
      expect(row.list_code).toEqual(row.selector === 'NO_GROUP' ? Option.none() : Option.some(internalSyncListCode));
      if (row.selector === 'PRICE_GROUP') {
        expect(row.list_executor).toEqual(Option.some(systemPrincipalId));
        expect({ issuer: row.issuer, namespace: row.namespace, routeId: row.route_id }).toEqual({
          issuer: Option.some(internalSyncSource.issuerId),
          namespace: Option.some(internalSyncSource.namespace),
          routeId: Option.some(input.sourceRouteId),
        });
      }
    }
  }
  const [counts] = yield* admin`
    select (select count(*)::integer from pricing.external_price_source_authority_grants where tenant_id=${tenantId}) as exact_grants,
      (select count(*)::integer from pricing.external_price_source_policies where tenant_id=${tenantId}) as policies,
      (select count(*)::integer from pricing.price_revisions where tenant_id=${tenantId}) as revisions,
      (select count(*)::integer from inventory.source_provisioning_policies where tenant_id=${tenantId}) as inventory_policies,
      (select count(*)::integer from catalog.products where tenant_id=${tenantId}) as products,
      (select count(*)::integer from catalog.product_variants where tenant_id=${tenantId}) as variants,
      (select count(*)::integer from price_group_catalog.price_groups where tenant_id=${tenantId}) as groups,
      (select count(*)::integer from price_group_catalog.price_group_source_correlations where tenant_id=${tenantId}) as lists
  `;
  expect(counts).toEqual({
    exact_grants: 0,
    groups: 1,
    inventory_policies: 1,
    lists: 1,
    policies: 2,
    products: 2,
    revisions: 4,
    variants: 2,
  });
  const coverages = yield* admin`select price_group_coverage from pricing.external_price_source_policies
    where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} order by price_group_coverage`;
  expect(coverages).toEqual([{ price_group_coverage: 'ANY_PRICE_GROUP' }, { price_group_coverage: 'NO_GROUP' }]);
  return parsed;
});
