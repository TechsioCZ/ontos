import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DateTime, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from 'effect';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { symmyJobRoutes } from '../../verticals/symmy-integration/src/db/schema.ts';
import {
  SymmyRouteEnrollmentRequestSchema,
  decideSymmyRouteWrite,
  symmyPlannedRouteRow,
  symmyRouteInventoryOf,
  symmyRouteRequestRefusals,
} from '../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts';

import { SymmyFixtureExecutionPlanSchema } from '../../verticals/symmy-integration/shared/domain/symmy-job-execution.ts';
import {
  SymmyInventorySourceSchema,
  SymmyStockRowSchema,
} from '../../verticals/symmy-integration/shared/domain/symmy-stock-batch.ts';
import { SymmyPriceSourceSchema } from '../../verticals/symmy-integration/shared/domain/symmy-price-list-batch.ts';
import {
  requireSymmyDemoStage,
  symmyDemoInventoryConfiguration,
  symmyDemoCatalogReadinessConfiguration,
  symmyDemoPolicyScope,
  symmyDemoPricePolicies,
  symmyDemoStockSourceRetention,
  symmyDemoStockSourceRouteId,
  validateSymmyDemoSourceEnrollment,
} from './symmy-demo-source-policies.mts';
import {
  buildSymmyProductPlan,
  readinessOperations,
} from '../../verticals/symmy-integration/src/persistence/symmy-product-plan.ts';
import { SymmyProductRowsSchema } from '../../verticals/symmy-integration/shared/domain/symmy-product-batch.ts';
import { symmyDemoExchangeConfiguration } from './symmy-demo-exchange-authority.mts';

await using runtime = ManagedRuntime.make(Layer.empty);

const unitResourceId = '11111111-1111-4111-8111-111111111111';
const symmyIssuerId = 'symmy-akros';
const catalogModule = 'commerce.catalog';
const productUnitResource = 'commerce.catalog.product-unit';
const inventoryModule = 'commerce.inventory';
const productsMapping = 'symmy-products';
const createProductEntrypoint = 'commerce.catalog.create-product';
const { tenantId } = symmyDemoPolicyScope;
const unitRef = {
  moduleId: catalogModule,
  resourceId: unitResourceId,
  resourceType: productUnitResource,
  tenantId,
};
const inventorySource = Schema.decodeUnknownSync(SymmyInventorySourceSchema)({
  customerConfigurationId: 'akros',
  externalScope: 'akros',
  issuer: { backendId: 'akros-erp', backendKind: 'external_business_system' },
  locations: [
    {
      locationKey: 'MAIN',
      stockLocationRef: {
        moduleId: inventoryModule,
        resourceId: '22222222-2222-4222-8222-222222222222',
        resourceType: 'commerce.inventory.stock-location',
        tenantId,
      },
    },
  ],
  namespace: 'akros-erp',
  policyRef: {
    moduleId: inventoryModule,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.inventory.source-provisioning-policy',
    tenantId,
  },
  unitRef,
});
const source = Schema.decodeUnknownSync(SymmyPriceSourceSchema)({
  mapping: { mappingContractRef: productsMapping, mappingContractVersion: '1' },
  sourceAuthority: { sourceAuthorityRef: symmyIssuerId, sourceAuthorityVersion: '1' },
});
const dimension = {
  channel_id: 'B2C' as const,
  currency_code: 'CZK',
  effective_from: '2026-11-01T00:00:00.000Z',
  market_id: 'akros-cz',
  unit_id: unitRef.resourceId,
  unit_quantity: '1',
};
const LegacySourceConfigurationSchema = Schema.Struct({
  ...SymmyFixtureExecutionPlanSchema.fields,
  stockScope: Schema.Array(
    Schema.Struct({
      itemKey: SymmyStockRowSchema.fields.itemKey,
      locationKey: SymmyStockRowSchema.fields.locationKey,
    }),
  ),
});
const decodeLegacyConfiguration = Schema.decodeUnknownSync(LegacySourceConfigurationSchema);
const decodeFixturePlan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema);

const fixture = (entityKind: 'PRODUCT' | 'STOCK') => ({
  inventoryBackendId: 'akros-erp',
  items: [
    {
      effects: [
        {
          effectKey: 'existing-operation',
          operation: {
            entrypointKey:
              entityKind === 'PRODUCT' ? createProductEntrypoint : 'commerce.inventory.import-source-assertion',
            moduleId: entityKind === 'PRODUCT' ? catalogModule : inventoryModule,
            schemaVersion: '1',
          },
        },
      ],
      itemKey: 'source',
      source: { entityKind, issuerId: symmyIssuerId, sourceNamespace: 'akros-erp', sourceRecordId: 'source' },
    },
  ],
  stockScope: [{ itemKey: 'ONLY-THE-OLD-SKU', locationKey: 'MAIN' }],
});

await test('enrolls native axis-free readiness idempotently and plans all six native steps for ACTIVE', () =>
  runtime.runPromise(
    Effect.gen(function* sourcePolicyTest() {
      const original = fixture('PRODUCT');
      const template = yield* symmyDemoInventoryConfiguration(
        decodeLegacyConfiguration({
          ...original,
          items: [
            {
              ...original.items[0],
              effects: [
                {
                  ...original.items[0].effects[0],
                  operation: {
                    entrypointKey: createProductEntrypoint,
                    moduleId: catalogModule,
                    schemaVersion: '2',
                  },
                },
                {
                  effectKey: 'existing-update',
                  operation: {
                    entrypointKey: 'commerce.catalog.update-product',
                    moduleId: catalogModule,
                    schemaVersion: '1',
                  },
                },
              ],
            },
            {
              ...original.items[0],
              effects: [
                {
                  effectKey: 'sku',
                  operation: {
                    entrypointKey: 'commerce.catalog.assign-sku',
                    moduleId: catalogModule,
                    schemaVersion: '1',
                  },
                },
              ],
              itemKey: 'variant',
              source: { ...original.items[0].source, entityKind: 'VARIANT' },
            },
          ],
        }),
        inventorySource,
        true,
      );
      const ready = yield* symmyDemoCatalogReadinessConfiguration(template, inventorySource);
      deepStrictEqual(ready.catalogReadiness, {
        divisible: false,
        kind: 'AXIS_FREE_UNTYPED',
        locale: 'en',
        unitRef,
      });
      deepStrictEqual(yield* symmyDemoCatalogReadinessConfiguration(ready, inventorySource), ready);
      const request = Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema)({
        configuration: ready,
        legalEntityId: symmyDemoPolicyScope.legalEntityId,
        lifecyclePolicy: { policyId: 'products', revision: 'v1' },
        mappingVersion: 'v1',
        principalId: symmyDemoPolicyScope.principalId,
        routeId: '1a24b716-0542-40d5-8906-c78554b7436d',
        routeKey: 'productsBatch',
        routeRevision: 'v1',
        tenantId,
      });
      yield* validateSymmyDemoSourceEnrollment(request);
      const planInput = {
        digest: (value) => Effect.succeed(createHash('sha256').update(value).digest('hex')),
        idempotencyKey: 'demo-readiness-regression',
        legalEntityId: symmyDemoPolicyScope.legalEntityId,
        priceGroups: [],
        receivedAt: DateTime.makeUnsafe('2026-11-23T00:00:00.000Z'),
        route: { mappingVersion: 'v1', routeId: request.routeId },
        rows: Schema.decodeUnknownSync(SymmyProductRowsSchema)([
          {
            lifecycle: 'ACTIVE',
            name: 'Approved demo product',
            unsupported: [],
            variants: [{ localized: [], prices: [], sku: 'new-demo-sku' }],
          },
        ]),
        template: ready,
        tenantId,
      } satisfies Parameters<typeof buildSymmyProductPlan>[0];
      const before = yield* buildSymmyProductPlan({ ...planInput, template });
      ok(Option.isSome(before));
      equal(
        before.value.items.flatMap((item) => item.effects).filter(({ effectKey }) => effectKey.startsWith('readiness-'))
          .length,
        0,
      );
      const plan = yield* buildSymmyProductPlan(planInput);
      ok(Option.isSome(plan));
      const effects = plan.value.items.flatMap((item) => item.effects);
      equal(effects.filter(({ effectKey }) => effectKey.startsWith('readiness-')).length, 6);
      for (const operation of readinessOperations) {
        ok(
          effects.some(
            (effect) =>
              effect.operation.moduleId === operation.moduleId &&
              effect.operation.entrypointKey === operation.entrypointKey &&
              effect.operation.schemaVersion === operation.schemaVersion,
          ),
        );
      }
      ok(!effects.some(({ effectKey }) => effectKey === 'product-update'));
      const foreign = Schema.decodeUnknownSync(SymmyInventorySourceSchema)({
        ...inventorySource,
        locations: inventorySource.locations.map((location) => ({
          ...location,
          stockLocationRef: { ...location.stockLocationRef, tenantId: unitResourceId },
        })),
        policyRef: { ...inventorySource.policyRef, tenantId: unitResourceId },
        unitRef: { ...inventorySource.unitRef, tenantId: unitResourceId },
      });
      ok(Exit.isFailure(yield* Effect.exit(symmyDemoCatalogReadinessConfiguration(ready, foreign))));
      ok(
        Exit.isFailure(
          yield* Effect.exit(
            symmyDemoCatalogReadinessConfiguration(
              decodeFixturePlan({
                ...ready,
                inventoryBackendId: 'another-backend',
              }),
              inventorySource,
            ),
          ),
        ),
      );
      ok(
        Exit.isFailure(
          yield* Effect.exit(
            symmyDemoCatalogReadinessConfiguration(
              decodeFixturePlan({
                ...ready,
                catalogReadiness: { ...ready.catalogReadiness, divisible: true },
              }),
              inventorySource,
            ),
          ),
        ),
      );
    }),
  ));

await test('creates source-wide base and group policies without overlapping mappings or SKU identities', () =>
  runtime.runPromise(
    Effect.gen(function* sourcePolicyTest() {
      const groupSource = Schema.decodeUnknownSync(SymmyPriceSourceSchema)({
        ...source,
        mapping: { mappingContractRef: 'symmy-price-lists', mappingContractVersion: '1' },
      });
      const policies = yield* symmyDemoPricePolicies(
        [
          { coverage: 'NO_GROUP', source },
          { coverage: 'ANY_PRICE_GROUP', source: groupSource },
          { coverage: 'ANY_PRICE_GROUP', source: groupSource },
        ],
        [dimension],
      );
      equal(policies.length, 2);
      deepStrictEqual(
        policies.map((policy) => [policy.mapping.mappingContractRef, policy.priceGroupCoverage.kind]),
        [
          [productsMapping, 'NO_GROUP'],
          ['symmy-price-lists', 'ANY_PRICE_GROUP'],
        ],
      );
      ok(policies.every((policy) => !('catalogSelection' in policy) && !('productRef' in policy)));
      ok(
        policies.every((policy) => policy.commercialScope.sellingLegalEntityId === symmyDemoPolicyScope.legalEntityId),
      );
    }),
  ));

await test('refuses missing dimensions instead of inventing a commercial price scope', () =>
  runtime.runPromise(
    Effect.gen(function* sourcePolicyTest() {
      const exit = yield* Effect.exit(symmyDemoPricePolicies([{ coverage: 'NO_GROUP', source }], []));
      ok(Exit.isFailure(exit));
    }),
  ));

await test('removes finite SKU scope and enrolls the shared policy on stock and product routes idempotently', () =>
  runtime.runPromise(
    Effect.gen(function* sourcePolicyTest() {
      yield* Effect.forEach(
        ['PRODUCT', 'STOCK'] as const,
        Effect.fnUntraced(function* checkInventoryRoute(entity) {
          const upgraded = yield* symmyDemoInventoryConfiguration(
            decodeLegacyConfiguration(fixture(entity)),
            inventorySource,
            entity === 'PRODUCT',
          );
          ok(!('stockScope' in upgraded));
          deepStrictEqual(upgraded.inventorySource, inventorySource);
          const next = yield* symmyDemoInventoryConfiguration(upgraded, inventorySource, entity === 'PRODUCT');
          deepStrictEqual(next, upgraded);
          equal(
            upgraded.items
              .flatMap((item) => item.effects)
              .filter((effect) => effect.operation.entrypointKey === 'commerce.inventory.provision-source-stock-item')
              .length,
            entity === 'PRODUCT' ? 1 : 0,
          );
          ok(!JSON.stringify(upgraded).includes('ONLY-THE-OLD-SKU'));
        }),
        { concurrency: 1, discard: true },
      );
    }),
  ));

await test('refuses non-stage before obtaining any database service', () =>
  runtime.runPromise(
    Effect.gen(function* sourcePolicyTest() {
      const exit = yield* Effect.exit(requireSymmyDemoStage('production'));
      ok(Exit.isFailure(exit));
      ok(!JSON.stringify(exit).includes('Service not found'));
      ok(Exit.isSuccess(yield* Effect.exit(requireSymmyDemoStage('stage'))));
    }),
  ));

await test('publishes one deterministic physical rollover route with separate retention, not a random route each release', () => {
  equal(symmyDemoStockSourceRouteId, '20f8cb1e-ecc1-8fda-912d-699274afc835');
  equal(symmyDemoStockSourceRetention.routeId, symmyDemoStockSourceRouteId);
  equal(symmyDemoStockSourceRetention.policyId, 'akros-symmy-stock-source-v1');
  equal(symmyDemoStockSourceRetention.targetLegalEntityId, null);
  equal(symmyDemoStockSourceRetention.retentionMs, 30 * 24 * 60 * 60 * 1000);
});

await test('the actual enrollment owner accepts source-scoped stock with its required position read, not the removed SKU schema', () =>
  runtime.runPromise(
    Effect.gen(function* sourcePolicyTest() {
      const configuration = yield* symmyDemoInventoryConfiguration(
        decodeLegacyConfiguration(fixture('STOCK')),
        inventorySource,
        false,
      );
      const request = Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema)({
        configuration,
        lifecyclePolicy: { policyId: 'akros-symmy-stock-source-v1', revision: 'v1' },
        mappingVersion: 'v1',
        principalId: symmyDemoPolicyScope.principalId,
        routeId: symmyDemoStockSourceRouteId,
        routeKey: 'inventoryStockBatch',
        routeRevision: 'v1',
        tenantId,
      });
      const inventory = symmyRouteInventoryOf(request.routeKey);
      ok(Option.isOption(inventory) && Option.isSome(inventory));
      deepStrictEqual(symmyRouteRequestRefusals(request, inventory.value), []);
      const stopped = {
        ...symmyPlannedRouteRow(request),
        active: false,
        changeToken: 7,
        fixturePlan: request.configuration,
        lifecyclePolicy: request.lifecyclePolicy ?? null,
        routeRevision: 'previous',
      };
      const restarted = decideSymmyRouteWrite(
        request,
        {
          byRouteId: Option.some(stopped),
          bySelector: Option.none(),
        },
        { expectedChangeToken: 7, kind: 'replace' },
      );
      ok('kind' in restarted && restarted.kind === 'replace');
      equal(restarted.admissions, 'outstanding');
      deepStrictEqual(
        decideSymmyRouteWrite(
          request,
          {
            byRouteId: Option.none(),
            bySelector: Option.none(),
          },
          { kind: 'enroll' },
        ),
        { kind: 'insert' },
      );
    }),
  ));

await test('source → exchange → source replay preserves approved demo authority and still validates native operations', () =>
  runtime.runPromise(
    Effect.gen(function* sourcePolicyTest() {
      const productRouteId = '1a24b716-0542-40d5-8906-c78554b7436d';
      const base = {
        ...fixture('PRODUCT'),
        items: [
          ['PRODUCT', catalogModule, createProductEntrypoint],
          ['VARIANT', catalogModule, 'commerce.catalog.create-variant'],
          ['PRICE', 'commerce.pricing', 'commerce.pricing.define-price'],
        ].map(([entityKind, moduleId, entrypointKey]) => ({
          effects: [{ effectKey: 'existing-operation', operation: { entrypointKey, moduleId, schemaVersion: '2' } }],
          itemKey: entityKind,
          source: { ...fixture('PRODUCT').items[0].source, entityKind },
        })),
        priceSource: source,
        pricingSourceSystem: { ownerModuleId: 'external.symmy', sourceSystemRef: symmyIssuerId },
        sourceRouteId: productRouteId,
      };
      const first = yield* symmyDemoInventoryConfiguration(decodeLegacyConfiguration(base), inventorySource, true).pipe(
        Effect.flatMap((configuration) => symmyDemoCatalogReadinessConfiguration(configuration, inventorySource)),
      );
      const requestOf = (configuration: typeof SymmyFixtureExecutionPlanSchema.Type) =>
        Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema)({
          configuration,
          legalEntityId: symmyDemoPolicyScope.legalEntityId,
          lifecyclePolicy: { policyId: 'products', revision: 'v1' },
          mappingVersion: 'v1',
          principalId: symmyDemoPolicyScope.principalId,
          routeId: productRouteId,
          routeKey: 'productsBatch',
          routeRevision: 'v1',
          tenantId,
        });
      yield* validateSymmyDemoSourceEnrollment(requestOf(first));
      const exchange = yield* symmyDemoExchangeConfiguration(first, 'productsBatch');
      const replay = yield* symmyDemoInventoryConfiguration(exchange.configuration, inventorySource, true).pipe(
        Effect.flatMap((configuration) => symmyDemoCatalogReadinessConfiguration(configuration, inventorySource)),
      );
      const request = requestOf(replay);
      const inventory = symmyRouteInventoryOf(request.routeKey);
      ok(Option.isSome(inventory));
      ok(
        symmyRouteRequestRefusals(request, inventory.value).some(
          ({ code }) => code === 'operation_not_in_route_inventory',
        ),
      );
      yield* validateSymmyDemoSourceEnrollment(request);
      deepStrictEqual(replay, requestOf(decodeFixturePlan(exchange.configuration)).configuration);
      deepStrictEqual(yield* symmyDemoExchangeConfiguration(replay, 'productsBatch'), {
        changed: false,
        configuration: exchange.configuration,
      });
      yield* Effect.forEach(
        [
          { tenantId: unitResourceId },
          { principalId: unitResourceId },
          { legalEntityId: unitResourceId },
          { routeId: unitResourceId },
        ],
        Effect.fnUntraced(function* checkScopeRefusal(change) {
          const altered = Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema)({ ...request, ...change });
          ok(Exit.isFailure(yield* Effect.exit(validateSymmyDemoSourceEnrollment(altered))));
        }),
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(
        ['version', 'key', 'unknown-demo', 'unknown-native', 'source'] as const,
        Effect.fnUntraced(function* checkOperationRefusal(corruption) {
          const altered = requestOf(
            decodeFixturePlan({
              ...replay,
              items: replay.items.map((item) => ({
                ...item,
                effects: item.effects.map((effect) =>
                  effect.operation.moduleId === 'demo.merchandise'
                    ? {
                        ...effect,
                        effectKey: corruption === 'key' ? `wrong-${effect.effectKey}` : effect.effectKey,
                        operation: {
                          ...effect.operation,
                          entrypointKey: corruption.startsWith('unknown-')
                            ? 'demo.merchandise.unapproved-operation'
                            : effect.operation.entrypointKey,
                          moduleId: corruption === 'unknown-native' ? catalogModule : effect.operation.moduleId,
                          schemaVersion: corruption === 'version' ? '999' : effect.operation.schemaVersion,
                        },
                      }
                    : effect,
                ),
                source: corruption === 'source' ? { ...item.source, issuerId: 'other-issuer' } : item.source,
              })),
            }),
          );
          ok(Exit.isFailure(yield* Effect.exit(validateSymmyDemoSourceEnrollment(altered))), corruption);
        }),
        { concurrency: 1, discard: true },
      );
    }),
  ));

await test('route selector uniqueness retains NULL semantics only for active routes and chains after the membership migration', () => {
  const config = getTableConfig(symmyJobRoutes);
  ok(!config.uniqueConstraints.some((constraint) => constraint.name === 'symmy_job_routes_scope_selector_uq'));
  const activeIndexes = config.indexes.filter(
    (index) => index.config.name?.startsWith('symmy_job_routes_active_') === true,
  );
  equal(activeIndexes.length, 4);
  const dialect = new PgDialect();
  const conditions = activeIndexes.map((index) => {
    ok(index.config.unique);
    ok(index.config.where);
    return dialect.sqlToQuery(index.config.where).sql;
  });
  for (const company of ['is null', 'is not null']) {
    for (const code of ['is null', 'is not null']) {
      equal(
        conditions.filter(
          (condition) =>
            condition.includes(`"legal_entity_id" ${company}`) &&
            condition.includes(`"route_code" ${code}`) &&
            condition.includes('"active"'),
        ).length,
        1,
      );
    }
  }
  const snapshotId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('MigrationSnapshotId'));
  const snapshot = Schema.Struct({ id: snapshotId, prevIds: Schema.Array(snapshotId) });
  const directory = '../../verticals/symmy-integration/drizzle/';
  const previous = Schema.decodeUnknownSync(Schema.fromJsonString(snapshot))(
    readFileSync(
      new URL(`${directory}20261123001000_c14-membership-missing-context-items/snapshot.json`, import.meta.url),
      'utf-8',
    ),
  );
  const current = Schema.decodeUnknownSync(Schema.fromJsonString(snapshot))(
    readFileSync(
      new URL(`${directory}20261123001100_demo-active-source-routes/snapshot.json`, import.meta.url),
      'utf-8',
    ),
  );
  deepStrictEqual(current.prevIds, [previous.id]);
});
