import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Effect, Exit, Option, Schema } from 'effect';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { symmyJobRoutes } from '../../verticals/symmy-integration/src/db/schema.ts';
import {
  SymmyRouteEnrollmentRequestSchema,
  decideSymmyRouteWrite,
  symmyPlannedRouteRow,
  symmyRouteInventoryOf,
  symmyRouteRequestRefusals,
} from '../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts';

import { SymmyInventorySourceSchema } from '../../verticals/symmy-integration/shared/domain/symmy-stock-batch.ts';
import { SymmyPriceSourceSchema } from '../../verticals/symmy-integration/shared/domain/symmy-price-list-batch.ts';
import {
  requireSymmyDemoStage,
  symmyDemoInventoryConfiguration,
  symmyDemoPolicyScope,
  symmyDemoPricePolicies,
  symmyDemoStockSourceRetention,
  symmyDemoStockSourceRouteId,
} from './symmy-demo-source-policies.mts';

const { tenantId } = symmyDemoPolicyScope;
const unitRef = {
  moduleId: 'commerce.catalog', resourceType: 'commerce.catalog.product-unit',
  resourceId: '11111111-1111-4111-8111-111111111111', tenantId,
};
const inventorySource = Schema.decodeUnknownSync(SymmyInventorySourceSchema)({
  customerConfigurationId: 'akros',
  externalScope: 'akros',
  namespace: 'akros-erp',
  issuer: { backendKind: 'external_business_system', backendId: 'symmy-akros' },
  locations: [{
    locationKey: 'MAIN',
    stockLocationRef: {
      moduleId: 'commerce.inventory', resourceType: 'commerce.inventory.stock-location',
      resourceId: '22222222-2222-4222-8222-222222222222', tenantId,
    },
  }],
  policyRef: {
    moduleId: 'commerce.inventory', resourceType: 'commerce.inventory.source-provisioning-policy',
    resourceId: '33333333-3333-4333-8333-333333333333', tenantId,
  },
  unitRef,
});
const source = Schema.decodeUnknownSync(SymmyPriceSourceSchema)({
  mapping: { mappingContractRef: 'symmy-products', mappingContractVersion: '1' },
  sourceAuthority: { sourceAuthorityRef: 'symmy-akros', sourceAuthorityVersion: '1' },
});
const dimension = {
  channel_id: 'B2C' as const, market_id: 'akros-cz', currency_code: 'CZK',
  unit_id: unitRef.resourceId, unit_quantity: '1', effective_from: '2026-11-01T00:00:00.000Z',
};
const fixture = (entityKind: 'PRODUCT' | 'STOCK') => ({
  inventoryBackendId: 'symmy-akros',
  stockScope: [{ itemKey: 'ONLY-THE-OLD-SKU', locationKey: 'MAIN' }],
  items: [{
    itemKey: 'source',
    source: { entityKind, issuerId: 'symmy-akros', sourceNamespace: 'akros-erp', sourceRecordId: 'source' },
    effects: [{
      effectKey: 'existing-operation',
      operation: {
        moduleId: entityKind === 'PRODUCT' ? 'commerce.catalog' : 'commerce.inventory',
        entrypointKey: entityKind === 'PRODUCT' ? 'commerce.catalog.create-product' : 'commerce.inventory.import-source-assertion',
        schemaVersion: '1',
      },
    }],
  }],
});

test('creates source-wide base and group policies without overlapping mappings or SKU identities', async () => {
  const groupSource = Schema.decodeUnknownSync(SymmyPriceSourceSchema)({
    ...source, mapping: { mappingContractRef: 'symmy-price-lists', mappingContractVersion: '1' },
  });
  const policies = await Effect.runPromise(symmyDemoPricePolicies([
    { source, coverage: 'NO_GROUP' },
    { source: groupSource, coverage: 'ANY_PRICE_GROUP' },
    { source: groupSource, coverage: 'ANY_PRICE_GROUP' },
  ], [dimension]));
  equal(policies.length, 2);
  deepStrictEqual(policies.map((policy) => [policy.mapping.mappingContractRef, policy.priceGroupCoverage.kind]), [
    ['symmy-products', 'NO_GROUP'], ['symmy-price-lists', 'ANY_PRICE_GROUP'],
  ]);
  ok(policies.every((policy) => !('catalogSelection' in policy) && !('productRef' in policy)));
  ok(policies.every((policy) => policy.commercialScope.sellingLegalEntityId === symmyDemoPolicyScope.legalEntityId));
});

test('refuses missing dimensions instead of inventing a commercial price scope', async () => {
  const exit = await Effect.runPromiseExit(symmyDemoPricePolicies([{ source, coverage: 'NO_GROUP' }], []));
  ok(Exit.isFailure(exit));
});

test('removes finite SKU scope and enrolls the shared policy on stock and product routes idempotently', async () => {
  for (const entity of ['PRODUCT', 'STOCK'] as const) {
    const upgraded = await Effect.runPromise(symmyDemoInventoryConfiguration(fixture(entity), inventorySource, entity === 'PRODUCT'));
    ok(!('stockScope' in upgraded));
    deepStrictEqual(upgraded.inventorySource, inventorySource);
    const next = await Effect.runPromise(symmyDemoInventoryConfiguration(upgraded, inventorySource, entity === 'PRODUCT'));
    deepStrictEqual(next, upgraded);
    equal(upgraded.items.flatMap((item) => item.effects).filter(
      (effect) => effect.operation.entrypointKey === 'commerce.inventory.provision-source-stock-item',
    ).length, entity === 'PRODUCT' ? 1 : 0);
    ok(!JSON.stringify(upgraded).includes('ONLY-THE-OLD-SKU'));
  }
});

test('refuses non-stage before obtaining any database service', async () => {
  const exit = await Effect.runPromiseExit(requireSymmyDemoStage('production'));
  ok(Exit.isFailure(exit));
  ok(!JSON.stringify(exit).includes('Service not found'));
  ok(Exit.isSuccess(await Effect.runPromiseExit(requireSymmyDemoStage('stage'))));
});

test('publishes one deterministic physical rollover route with separate retention, not a random route each release', () => {
  equal(symmyDemoStockSourceRouteId, '20f8cb1e-ecc1-8fda-912d-699274afc835');
  equal(symmyDemoStockSourceRetention.routeId, symmyDemoStockSourceRouteId);
  equal(symmyDemoStockSourceRetention.policyId, 'akros-symmy-stock-source-v1');
  equal(symmyDemoStockSourceRetention.targetLegalEntityId, null);
  equal(symmyDemoStockSourceRetention.retentionMs, 30 * 24 * 60 * 60 * 1000);
});

test('the actual enrollment owner accepts source-scoped stock with its required position read, not the removed SKU schema', async () => {
  const configuration = await Effect.runPromise(symmyDemoInventoryConfiguration(fixture('STOCK'), inventorySource, false));
  const request = Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema)({
    tenantId, principalId: symmyDemoPolicyScope.principalId,
    routeId: symmyDemoStockSourceRouteId, routeKey: 'inventoryStockBatch',
    configuration, lifecyclePolicy: { policyId: 'akros-symmy-stock-source-v1', revision: 'v1' },
    mappingVersion: 'v1', routeRevision: 'v1',
  });
  const inventory = symmyRouteInventoryOf(request.routeKey);
  ok(Option.isOption(inventory) && Option.isSome(inventory));
  deepStrictEqual(symmyRouteRequestRefusals(request, inventory.value), []);
  const stopped = {
    ...symmyPlannedRouteRow(request), active: false, changeToken: 7, routeRevision: 'previous',
    fixturePlan: request.configuration, lifecyclePolicy: request.lifecyclePolicy ?? null,
  };
  const restarted = decideSymmyRouteWrite(request, {
    bySelector: Option.none(), byRouteId: Option.some(stopped),
  }, { kind: 'replace', expectedChangeToken: 7 });
  ok('kind' in restarted && restarted.kind === 'replace');
  equal(restarted.admissions, 'outstanding');
  deepStrictEqual(decideSymmyRouteWrite(request, {
    bySelector: Option.none(), byRouteId: Option.none(),
  }, { kind: 'enroll' }), { kind: 'insert' });
});

test('route selector uniqueness retains NULL semantics only for active routes and chains after the membership migration', () => {
  const config = getTableConfig(symmyJobRoutes);
  ok(!config.uniqueConstraints.some((constraint) => constraint.name === 'symmy_job_routes_scope_selector_uq'));
  const activeIndexes = config.indexes.filter((index) => index.config.name?.startsWith('symmy_job_routes_active_'));
  equal(activeIndexes.length, 4);
  const dialect = new PgDialect();
  const conditions = activeIndexes.map((index) => {
    ok(index.config.unique);
    ok(index.config.where);
    return dialect.sqlToQuery(index.config.where).sql;
  });
  for (const company of ['is null', 'is not null']) {
    for (const code of ['is null', 'is not null']) {
      equal(conditions.filter((condition) => condition.includes(`"legal_entity_id" ${company}`) &&
        condition.includes(`"route_code" ${code}`) && condition.includes('"active"')).length, 1);
    }
  }
  const snapshot = Schema.Struct({ id: Schema.String, prevIds: Schema.Array(Schema.String) });
  const directory = '../../verticals/symmy-integration/drizzle/';
  const previous = Schema.decodeUnknownSync(Schema.fromJsonString(snapshot))(readFileSync(
    new URL(`${directory}20261123001000_c14-membership-missing-context-items/snapshot.json`, import.meta.url), 'utf8',
  ));
  const current = Schema.decodeUnknownSync(Schema.fromJsonString(snapshot))(readFileSync(
    new URL(`${directory}20261123001100_demo-active-source-routes/snapshot.json`, import.meta.url), 'utf8',
  ));
  deepStrictEqual(current.prevIds, [previous.id]);
});
