import { createHash } from 'node:crypto';

import { DateTime, Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyInventoryImportIntentSchema } from '../../shared/domain/symmy-catalog-pricing-inventory-intents.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyStockRowsSchema, SymmyStockScopeSchema } from '../../shared/domain/symmy-stock-batch.ts';
import { buildSymmyStockPlan } from '../../src/persistence/symmy-stock-plan.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const positionRef = (resourceId: string) => ({
  moduleId: 'commerce.inventory',
  resourceId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
});
const entry = (itemKey: string, locationKey: string, resourceId: string) => ({
  customerConfigurationId: 'customer-configuration',
  issuerBackendId: 'stock-backend',
  itemKey,
  locationKey,
  namespace: 'stock-namespace',
  positionRef: positionRef(resourceId),
  scope: 'stock-scope',
});
const template = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
  inventoryBackendId: 'stock-backend',
  items: [
    {
      effects: [
        {
          effectKey: 'inventory-absolute-on-hand',
          operation: {
            entrypointKey: 'commerce.inventory.import-source-assertion',
            moduleId: 'commerce.inventory',
            schemaVersion: '1',
          },
        },
      ],
      itemKey: 'stock',
      source: {
        entityKind: 'STOCK',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-namespace',
        sourceRecordId: 'enrollment',
      },
    },
  ],
  stockScope: [
    entry('item-1', 'warehouse-1', '44444444-4444-4444-8444-444444444441'),
    entry('item-2', 'warehouse-1', '44444444-4444-4444-8444-444444444442'),
  ],
});
const row = (itemKey: string, locationKey: string, revision = 'r1') => ({
  businessObservedAt: '2026-01-01T10:00:00.000Z',
  itemKey,
  locationKey,
  quantity: { amount: '12.5', unitRef },
  revision,
  sourceReference: `erp-${revision}`,
});
const rowsOf = (...rows: readonly ReturnType<typeof row>[]) => Schema.decodeUnknownSync(SymmyStockRowsSchema)(rows);
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
const build = (
  rows: ReturnType<typeof rowsOf>,
  overrides: {
    readonly idempotencyKey?: string;
    readonly receivedAt?: DateTime.Utc;
    readonly template?: SymmyFixtureExecutionPlan;
  } = {},
) =>
  buildSymmyStockPlan({
    digest,
    idempotencyKey: overrides.idempotencyKey ?? 'stock-key-1',
    receivedAt: overrides.receivedAt ?? DateTime.makeUnsafe('2026-01-01T12:00:00.000Z'),
    rows,
    template: overrides.template ?? template,
  });
const intentsOf = (plan: SymmyFixtureExecutionPlan) =>
  plan.items.flatMap(({ effects }) => effects.map(({ intent }) => intent));

describe('Symmy stock enrollment scope', () => {
  it('rejects a scope that names one item and location twice', () => {
    const decode = Schema.decodeUnknownResult(SymmyStockScopeSchema);
    const one = entry('item-1', 'warehouse-1', '44444444-4444-4444-8444-444444444441');
    expect(Result.isSuccess(decode([one]))).toBe(true);
    expect(Result.isFailure(decode([]))).toBe(true);
    expect(
      Result.isFailure(decode([one, { ...one, positionRef: positionRef('44444444-4444-4444-8444-444444444449') }])),
    ).toBe(true);
    expect(
      Result.isSuccess(decode([one, entry('item-1', 'warehouse-2', '44444444-4444-4444-8444-444444444449')])),
    ).toBe(true);
  });

  it('keeps two different item and location pairs apart even when their texts concatenate alike', () => {
    const decode = Schema.decodeUnknownResult(SymmyStockScopeSchema);
    const one = entry('a', 'bc', '44444444-4444-4444-8444-444444444441');
    const other = entry('ab', 'c', '44444444-4444-4444-8444-444444444442');
    expect(Result.isSuccess(decode([one, other]))).toBe(true);
  });
});

describe('Symmy stock plan from the public rows', () => {
  it.effect('maps each row to one absolute on-hand stock effect on the enrolled position', () =>
    Effect.gen(function* maps() {
      const plan = Option.getOrThrow(
        yield* build(rowsOf(row('item-1', 'warehouse-1'), row('item-2', 'warehouse-1', 'r2'))),
      );
      expect(plan.items).toHaveLength(2);
      const [first, second] = plan.items;
      expect(first?.itemKey).toBe('stock-0');
      expect(second?.itemKey).toBe('stock-1');
      expect(first?.source).toMatchObject({
        entityKind: 'STOCK',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-namespace',
      });
      const [effect] = first?.effects ?? [];
      expect(effect?.effectKey).toBe('inventory-absolute-on-hand');
      expect(effect?.operation).toEqual({
        entrypointKey: 'commerce.inventory.import-source-assertion',
        moduleId: 'commerce.inventory',
        schemaVersion: '1',
      });
      expect(effect?.originalTarget).toEqual(positionRef('44444444-4444-4444-8444-444444444441'));
      const [intent] = intentsOf(plan);
      expect(Schema.is(SymmyInventoryImportIntentSchema)(intent)).toBe(true);
      expect(intent).toMatchObject({
        payload: {
          authorizationTargetRef: positionRef('44444444-4444-4444-8444-444444444441'),
          items: [
            {
              businessObservedAt: '2026-01-01T10:00:00.000Z',
              coverage: [],
              customerConfigurationId: 'customer-configuration',
              factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
              issuer: { backendId: 'stock-backend', backendKind: 'external_business_system' },
              itemExternalKey: {
                externalScope: 'stock-scope',
                externalValue: 'item-1',
                identifierKind: 'ITEM',
                namespace: 'stock-namespace',
                tenantId,
              },
              locationExternalKey: { externalValue: 'warehouse-1', identifierKind: 'LOCATION' },
              orderingEvidence: { _tag: 'SOURCE_REVISION', revision: 'r1' },
              quantity: { amount: '12.5', unitRef },
              receivedAt: '2026-01-01T12:00:00.000Z',
              sourceReference: 'erp-r1',
            },
          ],
        },
      });
      expect(plan.items.every(({ unsupportedBranches }) => unsupportedBranches === undefined)).toBe(true);
    }),
  );

  it.effect(
    'derives the same identities for the same Idempotency-Key and row index, and different ones otherwise',
    () =>
      Effect.gen(function* derives() {
        const rows = rowsOf(row('item-1', 'warehouse-1'), row('item-2', 'warehouse-1'));
        const first = Option.getOrThrow(yield* build(rows));
        const again = Option.getOrThrow(yield* build(rows));
        expect(again).toEqual(first);
        const assertionIds = intentsOf(first).map((intent) =>
          Schema.is(SymmyInventoryImportIntentSchema)(intent) ? intent.payload.items[0]?.assertionId : undefined,
        );
        expect(new Set(assertionIds).size).toBe(2);
        expect(new Set(first.items.map(({ sourceOccurrenceId }) => sourceOccurrenceId)).size).toBe(2);
        const otherKey = Option.getOrThrow(yield* build(rows, { idempotencyKey: 'stock-key-2' }));
        expect(otherKey).not.toEqual(first);
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
        expect(assertionIds.every((id) => id !== undefined && uuid.test(id))).toBe(true);
      }),
  );

  it.effect('does not read the quantity or the time of the request to derive an identity', () =>
    Effect.gen(function* stable() {
      const rows = rowsOf(row('item-1', 'warehouse-1'));
      const changed = rowsOf({ ...row('item-1', 'warehouse-1'), quantity: { amount: '99', unitRef } });
      const [first, second] = [
        Option.getOrThrow(yield* build(rows)),
        Option.getOrThrow(yield* build(changed, { receivedAt: DateTime.makeUnsafe('2026-02-02T00:00:00.000Z') })),
      ];
      expect(second.items[0]?.sourceOccurrenceId).toBe(first.items[0]?.sourceOccurrenceId);
      expect(second.items[0]?.source).toEqual(first.items[0]?.source);
    }),
  );

  it.effect('admits no plan when any row names a position the route is not enrolled for', () =>
    Effect.gen(function* denies() {
      const unknownItem = yield* build(rowsOf(row('item-1', 'warehouse-1'), row('item-9', 'warehouse-1')));
      expect(Option.isNone(unknownItem)).toBe(true);
      const unknownLocation = yield* build(rowsOf(row('item-1', 'warehouse-9')));
      expect(Option.isNone(unknownLocation)).toBe(true);
      const swapped = yield* build(rowsOf(row('warehouse-1', 'item-1')));
      expect(Option.isNone(swapped)).toBe(true);
    }),
  );

  it.effect('admits no plan for a route without a scope or whose scope belongs to another issuer', () =>
    Effect.gen(function* denies() {
      const rows = rowsOf(row('item-1', 'warehouse-1'));
      const { stockScope: _removed, ...withoutScope } = template;
      expect(Option.isNone(yield* build(rows, { template: withoutScope }))).toBe(true);
      const otherBackend = {
        ...template,
        stockScope: template.stockScope?.map((scoped) => ({ ...scoped, issuerBackendId: 'another-backend' })),
      };
      expect(
        Option.isNone(
          yield* build(rows, { template: Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)(otherBackend) }),
        ),
      ).toBe(true);
    }),
  );

  it.effect('admits no plan for a quantity unit that belongs to another tenant than the enrolled position', () =>
    Effect.gen(function* denies() {
      const foreign = rowsOf({
        ...row('item-1', 'warehouse-1'),
        quantity: { amount: '1', unitRef: { ...unitRef, tenantId: '22222222-2222-4222-8222-222222222222' } },
      });
      expect(Option.isNone(yield* build(foreign))).toBe(true);
    }),
  );
});
