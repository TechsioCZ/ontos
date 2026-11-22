import { createHash } from 'node:crypto';

import { SourceStockPositionResolutionResponseSchema } from '@app/inventory/api/source-stock-position-resolution';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { assert, describe, expect, it } from 'effect-rstest';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyProductRowsSchema } from '../../shared/domain/symmy-product-batch.ts';
import {
  SymmyInventorySourceSchema,
  SymmyStockPositionFactsSchema,
  SymmyStockRowsSchema,
} from '../../shared/domain/symmy-stock-batch.ts';
import type { SymmyStockPositionFacts } from '../../shared/domain/symmy-stock-batch.ts';
import { readSymmyStockPositionFacts } from '../../shared/symmy-stock-position-facts.ts';
import {
  buildSymmyProductPlan,
  createProductOperation,
  provisionStockItemOperation,
} from '../../src/persistence/symmy-product-plan.ts';
import { buildSymmyStockPlan, stockOperation } from '../../src/persistence/symmy-stock-plan.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const inventoryRef = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.inventory',
  resourceId,
  resourceType: `commerce.inventory.${resourceType}`,
  tenantId,
});
const source = Schema.decodeUnknownSync(SymmyInventorySourceSchema)({
  customerConfigurationId: 'customer-configuration',
  externalScope: 'stock-scope',
  issuer: { backendId: 'stock-backend', backendKind: 'external_business_system' },
  locations: [
    {
      locationKey: 'warehouse-1',
      stockLocationRef: inventoryRef('stock-location', '44444444-4444-4444-8444-444444444440'),
    },
  ],
  namespace: 'stock-namespace',
  policyRef: inventoryRef('source-provisioning-policy', '44444444-4444-4444-8444-444444444449'),
  unitRef,
});
const enrolledSource = { issuerId: 'route-issuer', sourceNamespace: 'route-namespace', sourceRecordId: 'enrollment' };
const template = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
  inventoryBackendId: source.issuer.backendId,
  inventorySource: source,
  items: [
    {
      effects: [{ effectKey: 'stock', operation: stockOperation }],
      itemKey: 'stock',
      source: { ...enrolledSource, entityKind: 'STOCK' },
    },
  ],
});
const row = (itemKey: string, locationKey = 'warehouse-1') => ({
  businessObservedAt: '2026-01-01T10:00:00.000Z',
  itemKey,
  locationKey,
  quantity: { amount: '12.5', unitRef },
  revision: 'r1',
  sourceReference: 'erp-r1',
});
const rowsOf = (...rows: readonly ReturnType<typeof row>[]) => Schema.decodeUnknownSync(SymmyStockRowsSchema)(rows);
const resolution = (itemKey: string) =>
  Schema.decodeUnknownSync(SourceStockPositionResolutionResponseSchema)({
    _tag: 'RESOLVED',
    policyRef: source.policyRef,
    positionRef: inventoryRef(
      'stock-position',
      itemKey === 'unseen-A' ? '44444444-4444-4444-8444-444444444441' : '44444444-4444-4444-8444-444444444442',
    ),
    stockItemRef: inventoryRef(
      'stock-item',
      itemKey === 'unseen-A' ? '55555555-5555-4555-8555-555555555551' : '55555555-5555-4555-8555-555555555552',
    ),
    stockLocationRef: source.locations[0]?.stockLocationRef,
  });
const factsOf = (...keys: readonly string[]): SymmyStockPositionFacts =>
  Schema.decodeUnknownSync(SymmyStockPositionFactsSchema)(
    keys.map((itemKey) => ({
      request: {
        customerConfigurationId: source.customerConfigurationId,
        externalScope: source.externalScope,
        issuer: source.issuer,
        itemKey,
        locationKey: 'warehouse-1',
        namespace: source.namespace,
      },
      resolution: resolution(itemKey),
    })),
  );
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
const build = (
  rows: ReturnType<typeof rowsOf>,
  facts: SymmyStockPositionFacts | null,
  selected: SymmyFixtureExecutionPlan = template,
) =>
  buildSymmyStockPlan({
    digest,
    facts: facts ?? undefined,
    idempotencyKey: 'stock-key-1',
    receivedAt: DateTime.makeUnsafe('2026-01-01T12:00:00.000Z'),
    rows,
    template: selected,
  });

describe('Symmy stock from the public Inventory resolution contract', () => {
  it.effect('accepts two unseen SKUs without a configuration change and pins the owner positions', () =>
    Effect.gen(function* test() {
      const rows = rowsOf(row('unseen-A'), row('unseen-B'));
      const facts = Option.getOrThrow(
        yield* readSymmyStockPositionFacts({
          resolve: (request) => Effect.succeed(resolution(request.itemKey)),
          rows,
          source,
        }),
      );
      const plan = Option.getOrThrow(yield* build(rows, facts));
      expect(plan.items).toHaveLength(2);
      expect(plan.items.map(({ effects }) => effects[0].originalTarget?.resourceId)).toEqual([
        '44444444-4444-4444-8444-444444444441',
        '44444444-4444-4444-8444-444444444442',
      ]);
      expect(JSON.stringify(template)).not.toContain('unseen-');
      expect(plan.items[0]?.effects[0].intent).toMatchObject({
        payload: {
          items: [
            {
              customerConfigurationId: source.customerConfigurationId,
              issuer: source.issuer,
              itemExternalKey: {
                externalScope: source.externalScope,
                externalValue: 'unseen-A',
                identifierKind: 'ITEM',
              },
              locationExternalKey: { externalValue: 'warehouse-1', identifierKind: 'LOCATION' },
            },
          ],
        },
      });
    }),
  );

  it.effect('keeps an early stock batch unadmitted until product provisioning is visible to the public read', () =>
    Effect.gen(function* test() {
      const rows = rowsOf(row('unseen-A'));
      const early = yield* readSymmyStockPositionFacts({
        resolve: () => Effect.succeed({ _tag: 'UNRESOLVED', reason: 'ITEM_NOT_PROVISIONED' }),
        rows,
        source,
      });
      expect(Option.isNone(early)).toBe(true);
      expect(Option.isNone(yield* build(rows, null))).toBe(true);
      const ready = yield* readSymmyStockPositionFacts({
        resolve: (request) => Effect.succeed(resolution(request.itemKey)),
        rows,
        source,
      });
      expect(Option.isSome(yield* build(rows, Option.getOrThrow(ready)))).toBe(true);
    }),
  );

  it.effect('reproduces the exact native assertion on replay, including its owner authorization target', () =>
    Effect.gen(function* test() {
      const rows = rowsOf(row('unseen-A'));
      const facts = factsOf('unseen-A');
      expect(yield* build(rows, facts)).toEqual(yield* build(rows, facts));
    }),
  );

  it.effect('rejects foreign source, backend, policy, location, tenant and unit facts rather than guessing', () =>
    Effect.gen(function* test() {
      const rows = rowsOf(row('unseen-A'));
      const [fact] = factsOf('unseen-A');
      assert.isDefined(fact);
      const current = Schema.decodeUnknownSync(SourceStockPositionResolutionResponseSchema.members[0])(fact.resolution);
      const deniedFacts = [
        { ...fact, request: { ...fact.request, namespace: 'foreign-source' } },
        { ...fact, request: { ...fact.request, issuer: { ...fact.request.issuer, backendId: 'foreign-backend' } } },
        {
          ...fact,
          resolution: {
            ...current,
            policyRef: { ...source.policyRef, resourceId: '44444444-4444-4444-8444-444444444448' },
          },
        },
        {
          ...fact,
          resolution: {
            ...current,
            stockLocationRef: inventoryRef('stock-location', '44444444-4444-4444-8444-444444444448'),
          },
        },
        {
          ...fact,
          resolution: {
            ...current,
            positionRef: { ...current.positionRef, tenantId: '22222222-2222-4222-8222-222222222222' },
          },
        },
      ];
      for (const denied of deniedFacts) {
        expect(
          Option.isNone(yield* build(rows, Schema.decodeUnknownSync(SymmyStockPositionFactsSchema)([denied]))),
        ).toBe(true);
      }
      for (const denied of [
        row('unseen-A', 'foreign-location'),
        {
          ...row('unseen-A'),
          quantity: { amount: '1', unitRef: { ...unitRef, resourceId: '33333333-3333-4333-8333-333333333334' } },
        },
        {
          ...row('unseen-A'),
          quantity: { amount: '1', unitRef: { ...unitRef, tenantId: '22222222-2222-4222-8222-222222222222' } },
        },
      ]) {
        expect(Option.isNone(yield* build(rowsOf(denied), [fact]))).toBe(true);
      }
      const { inventoryBackendId: _removed, ...withoutBackend } = template;
      expect(Option.isNone(yield* build(rows, [fact], withoutBackend))).toBe(true);
    }),
  );

  it.effect('rejects duplicate resolution answers and requires every row to resolve before admission', () =>
    Effect.gen(function* test() {
      const facts = factsOf('unseen-A');
      expect(Option.isNone(yield* build(rowsOf(row('unseen-A')), [...facts, ...facts]))).toBe(true);
      expect(Option.isNone(yield* build(rowsOf(row('unseen-A'), row('unseen-B')), facts))).toBe(true);
    }),
  );

  it.effect(
    'products schedule one replayable provisioning effect per unseen SKU using only the one source policy',
    () =>
      Effect.gen(function* test() {
        const productTemplate = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
          inventoryBackendId: source.issuer.backendId,
          inventorySource: source,
          items: [
            {
              effects: [createProductOperation, provisionStockItemOperation].map((operation, index) => ({
                effectKey: `enrolled-${index}`,
                operation,
              })),
              itemKey: 'products',
              source: { ...enrolledSource, entityKind: 'PRODUCT' },
            },
          ],
        });
        const plan = Option.getOrThrow(
          yield* buildSymmyProductPlan({
            digest,
            idempotencyKey: 'products-key',
            legalEntityId: Option.getOrUndefined(Option.none<string>()),
            priceGroups: [],
            receivedAt: DateTime.makeUnsafe('2026-01-01T12:00:00.000Z'),
            route: { mappingVersion: 'v1', routeId: '66666666-6666-4666-8666-666666666666' },
            rows: Schema.decodeUnknownSync(SymmyProductRowsSchema)(
              ['unseen-A', 'unseen-B'].map((sku) => ({
                identifier: { type: 'sku', value: sku },
                name: sku,
                unsupported: [],
                variants: [{ localized: [], prices: [] }],
              })),
            ),
            template: productTemplate,
            tenantId,
          }),
        );
        const provisions = plan.items.flatMap(({ effects }) =>
          effects.filter(({ operation }) => operation.entrypointKey === provisionStockItemOperation.entrypointKey),
        );
        expect(provisions).toHaveLength(2);
        expect(
          provisions.map(({ intent }) =>
            Match.value(intent).pipe(
              Match.tag('CatalogProductDependentEffect', ({ request }) =>
                Match.value(request).pipe(
                  Match.tag('ProvisionSourceStockItem', ({ itemKey }) => itemKey),
                  Match.orElse(() => {}),
                ),
              ),
              Match.orElse(() => {}),
            ),
          ),
        ).toEqual(['unseen-A', 'unseen-B']);
        expect(provisions.every(({ dependsOn }) => dependsOn?.length === 1)).toBe(true);
        expect(provisions.every(({ originalTarget }) => originalTarget === undefined)).toBe(true);
      }),
  );
});
