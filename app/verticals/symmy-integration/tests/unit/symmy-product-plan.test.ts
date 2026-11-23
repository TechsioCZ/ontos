import { createHash } from 'node:crypto';

import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { Cause, DateTime, Effect, Exit, Match, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { priceSourceFactFingerprint } from '../../../pricing/src/services/price-source-provenance.service.ts';
import { AdmitSymmyJobPayloadSchema, AdmitSymmyJobRejected } from '../../shared/domain/symmy-job-admission.ts';
import { mapAdmitSymmyJobBusinessProblem } from '../../shared/domain/admit-symmy-job-business-problems.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import {
  SymmyProductPlanLimitError,
  SymmyProductRowsSchema,
  symmyProductPlanSize,
} from '../../shared/domain/symmy-product-batch.ts';
import type { SymmyProductPriceGroupFacts } from '../../shared/domain/symmy-product-batch.ts';
import { symmyRequestItemKey } from '../../src/persistence/symmy-job-execution-store.ts';
import {
  buildSymmyProductPlan,
  provisionStockItemOperation,
  readinessOperations,
} from '../../src/persistence/symmy-product-plan.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const routeId = '55555555-5555-4555-8555-555555555555';
const ref = (moduleId: string, resourceType: string, suffix: string) => ({
  moduleId,
  resourceId: `33333333-3333-4333-8333-${suffix.padStart(12, '0')}`,
  resourceType,
  tenantId,
});
const unitRef = ref('commerce.catalog', 'commerce.catalog.product-unit', '3');
const groupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '33333333-3333-4333-8333-000000000009',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const operation = (moduleId: string, entrypointKey: string, schemaVersion: string) => ({
  entrypointKey,
  moduleId,
  schemaVersion,
});
const enroll = (entityKind: string, sourceRecordId: string, ...operations: ReturnType<typeof operation>[]) => ({
  effects: operations.map((enrolled, index) => ({ effectKey: `authority-${index}`, operation: enrolled })),
  itemKey: `enrolled-${entityKind.toLowerCase()}`,
  source: { entityKind, issuerId: 'route-issuer', sourceNamespace: 'route-namespace', sourceRecordId },
});
const createProduct = operation('commerce.catalog', 'commerce.catalog.create-product', '2');
const updateProduct = operation('commerce.catalog', 'commerce.catalog.update-product', '1');
const createVariant = operation('commerce.catalog', 'commerce.catalog.create-variant', '2');
const variantFacts = operation('commerce.catalog', 'commerce.catalog.set-variant-localized-facts', '1');
const productFacts = operation('commerce.catalog', 'commerce.catalog.set-product-localized-facts', '1');
const variantSku = operation('commerce.catalog', 'commerce.catalog.assign-sku', '1');
const priceDefine = operation('commerce.pricing', 'commerce.pricing.define-price', '2');
const categoryAssignment = operation('commerce.catalog', 'commerce.catalog.add-product-category-assignment', '1');
const priceDefaults = {
  commercialScope: { channelId: 'B2B', marketId: 'cz-market' },
  unitBasis: { quantity: '1', unitRef },
};
const templateInput = (defaults?: typeof priceDefaults) => {
  const priceSource = {
    mapping: { mappingContractRef: 'SYMMY_PRICE_MAPPING', mappingContractVersion: 'mapping-v1' },
    sourceAuthority: { sourceAuthorityRef: 'SYMMY_PRICE_AUTHORITY', sourceAuthorityVersion: '1' },
  };
  return {
    items: [
      enroll('PRODUCT', 'enrolled-product', createProduct, updateProduct, productFacts),
      enroll('VARIANT', 'enrolled-variant', createVariant, variantFacts, variantSku),
      enroll('PRICE', 'enrolled-price', priceDefine),
    ],
    priceSource: defaults === undefined ? priceSource : { ...priceSource, defaults },
    pricingSourceSystem: { ownerModuleId: 'external.symmy', sourceSystemRef: 'SYMMY_PRICES' },
    sourceMappingVersion: 'mapping-v1',
    sourceRouteId: '66666666-6666-4666-8666-666666666666',
  };
};
const decodeTemplate = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema);
const template = decodeTemplate(templateInput(priceDefaults));

type Json = typeof Schema.Json.Type;
type Fields = Readonly<Record<string, Json>>;
const variant = (extra: Fields = {}) => ({ localized: [], prices: [], ...extra });
const price = (extra: Fields = {}) => ({ amount: '25.50', currencyCode: 'CZK', ...extra });
const product = (extra: Fields = {}, variants: readonly Json[] = [variant()]) => ({
  name: 'Chair',
  unsupported: [],
  variants,
  ...extra,
});
const rowsOf = (...rows: readonly Json[]) => Schema.decodeUnknownSync(SymmyProductRowsSchema)(rows);
const texts = (count: number): readonly Json[] =>
  Array.from({ length: count }, (_, index) => ({ locale: `en-x-l${index}`, name: 'Chair' }));

const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
const build = (
  rows: ReturnType<typeof rowsOf>,
  overrides: {
    readonly groups?: SymmyProductPriceGroupFacts;
    readonly idempotencyKey?: string;
    readonly receivedAt?: DateTime.Utc;
    readonly template?: SymmyFixtureExecutionPlan;
    readonly withoutLegalEntity?: boolean;
  } = {},
) =>
  buildSymmyProductPlan({
    digest,
    idempotencyKey: overrides.idempotencyKey ?? 'product-key-1',
    legalEntityId: overrides.withoutLegalEntity === true ? undefined : legalEntityId,
    priceGroups: overrides.groups ?? [],
    receivedAt: overrides.receivedAt ?? DateTime.makeUnsafe('2026-01-01T12:00:00.000Z'),
    route: { mappingVersion: 'route-mapping', routeId },
    rows,
    template: overrides.template ?? template,
    tenantId,
  });

type Effect_ = SymmyFixtureExecutionPlan['items'][number]['effects'][number];
const itemKeys = (plan: SymmyFixtureExecutionPlan) => plan.items.map(({ itemKey }) => itemKey);
const itemOf = (plan: SymmyFixtureExecutionPlan, itemKey: string) => {
  const item = plan.items.find((candidate) => candidate.itemKey === itemKey);
  if (item === undefined) {
    throw new Error(`No plan item ${itemKey}`);
  }
  return item;
};
const effectOf = (plan: SymmyFixtureExecutionPlan, itemKey: string, effectKey: string) => {
  const effect = itemOf(plan, itemKey).effects.find((candidate) => candidate.effectKey === effectKey);
  if (effect === undefined) {
    throw new Error(`No effect ${effectKey} in ${itemKey}`);
  }
  return effect;
};
const createPayloadOf = (effect: Effect_) =>
  Option.getOrUndefined(
    Match.value(effect.intent).pipe(
      Match.when({ _tag: 'CatalogCreateProduct' }, ({ payload }) => payload),
      Match.option,
    ),
  );
const dependentOf = (effect: Effect_) =>
  Option.getOrUndefined(
    Match.value(effect.intent).pipe(
      Match.when({ _tag: 'CatalogProductDependentEffect' }, (intent) => intent),
      Match.option,
    ),
  );
const priceRequestOf = (effect: Effect_) =>
  Option.getOrUndefined(
    Match.value(dependentOf(effect)?.request).pipe(
      Match.when({ _tag: 'DefinePrice' }, ({ payload }) => payload),
      Match.option,
    ),
  );
const requestTagOf = (effect: Effect_) => dependentOf(effect)?.request._tag;
const textRequestOf = (effect: Effect_) =>
  Option.getOrUndefined(
    Match.value(dependentOf(effect)?.request).pipe(
      Match.when({ _tag: 'SetProductLocalizedFacts' }, ({ payload }) => payload),
      Match.when({ _tag: 'SetVariantLocalizedFacts' }, ({ payload }) => payload),
      Match.option,
    ),
  );
const skuRequestOf = (effect: Effect_) =>
  Option.getOrUndefined(
    Match.value(dependentOf(effect)?.request).pipe(
      Match.when({ _tag: 'AssignVariantSku' }, ({ payload }) => payload),
      Match.option,
    ),
  );

it.effect('pins source Categories after Product creation and makes every Price wait for their assignments', () =>
  Effect.gen(function* categoryPlan() {
    const categories = [
      ref('commerce.catalog', 'commerce.catalog.product-category', '81'),
      ref('commerce.catalog', 'commerce.catalog.product-category', '82'),
    ];
    const source = templateInput(priceDefaults);
    const enrolled = decodeTemplate({
      ...source,
      items: [
        enroll('PRODUCT', 'enrolled-product', createProduct, updateProduct, categoryAssignment),
        ...source.items.slice(1),
      ],
    });
    const plan = Option.getOrThrow(
      yield* build(rowsOf(product({ categories, lifecycle: 'ACTIVE' }, [variant({ prices: [price()] })])), {
        template: enrolled,
      }),
    );
    for (const [index, categoryRef] of categories.entries()) {
      expect(effectOf(plan, 'product-0', `category-assign-${index}`)).toMatchObject({
        dependsOn: [{ effectKey: 'product-create', itemKey: 'product-0' }],
        intent: {
          parent: { effectKey: 'product-create', itemKey: 'product-0' },
          request: { _tag: 'AddProductCategoryAssignment', payload: { categoryRef, reason: 'Symmy product import' } },
        },
        operation: categoryAssignment,
      });
      expect(effectOf(plan, 'product-0-variant-0-price-0', 'price-define').dependsOn).toContainEqual({
        effectKey: `category-assign-${index}`,
        itemKey: 'product-0',
      });
    }
    expect(Option.isNone(yield* build(rowsOf(product({ categories }))))).toBe(true);
    expect(
      Option.isNone(
        yield* build(rowsOf(product({ categories: [{ ...categories[0], tenantId: legalEntityId }] })), {
          template: enrolled,
        }),
      ),
    ).toBe(true);
    const absent = Option.getOrThrow(yield* build(rowsOf(product()), { template: enrolled }));
    expect(itemOf(absent, 'product-0').effects.map(({ effectKey }) => effectKey)).toEqual(['product-create']);
    expect(symmyProductPlanSize({ categories, variants: [{}] }).effects).toBe(3);
  }),
);

it.effect('plans readiness only for explicit ACTIVE under an enrolled axis-free untyped policy', () =>
  Effect.gen(function* readinessPlan() {
    const source = templateInput(priceDefaults);
    const readyTemplate = decodeTemplate({
      ...source,
      catalogReadiness: { divisible: false, kind: 'AXIS_FREE_UNTYPED', locale: 'cs-CZ', unitRef },
      items: [
        enroll('PRODUCT', 'enrolled-product', createProduct, ...readinessOperations),
        enroll('VARIANT', 'enrolled-variant', createVariant, variantFacts),
        enroll('PRICE', 'enrolled-price', priceDefine),
      ],
    });
    const active = yield* build(rowsOf(product({ lifecycle: 'ACTIVE' }, [variant({ prices: [price()] })])), {
      template: readyTemplate,
    });
    expect(Option.isSome(active)).toBe(true);
    if (Option.isNone(active)) {
      return yield* Effect.die('Expected an ACTIVE plan');
    }
    const { effects } = itemOf(active.value, 'product-0');
    expect(
      effects.map(({ effectKey, operation: selectedOperation }) => [effectKey, selectedOperation.entrypointKey]),
    ).toEqual([
      ['product-create', 'commerce.catalog.create-product'],
      ['readiness-axes', 'commerce.catalog.govern-variant-axes'],
      ['readiness-confirm', 'commerce.catalog.confirm-variant-combination'],
      ['readiness-name', 'commerce.catalog.set-product-localized-facts'],
      ['readiness-activate', 'commerce.catalog.update-product'],
      ['readiness-unit', 'commerce.catalog.set-product-unit-target-divisibility'],
      ['readiness-untyped', 'commerce.catalog.decide-product-type-unnecessary'],
    ]);
    expect(effectOf(active.value, 'product-0', 'readiness-name').intent).toMatchObject({
      request: { kind: 'AXIS_FREE_UNTYPED', locale: 'cs-CZ', name: 'Chair', step: 'NAME' },
    });
    expect(itemOf(active.value, 'product-0-variant-0-price-0').effects[0]?.dependsOn).toContainEqual({
      effectKey: 'readiness-untyped',
      itemKey: 'product-0',
    });
    const draft = yield* build(rowsOf(product()), { template: readyTemplate });
    expect(Option.isSome(draft)).toBe(true);
    if (Option.isNone(draft)) {
      return yield* Effect.die('Expected a DRAFT plan');
    }
    expect(itemOf(draft.value, 'product-0').effects.map(({ effectKey }) => effectKey)).toEqual(['product-create']);
    return yield* Effect.void;
  }),
);

it.effect('orders readiness after every explicit product text, including the readiness locale', () =>
  Effect.gen(function* localizedReadinessOrder() {
    const readyTemplate = decodeTemplate({
      ...templateInput(priceDefaults),
      catalogReadiness: { divisible: false, kind: 'AXIS_FREE_UNTYPED', locale: 'cs-CZ', unitRef },
      items: [enroll('PRODUCT', 'enrolled-product', createProduct, ...readinessOperations)],
    });
    for (const localized of [
      [
        { description: 'Zdrojový popis', locale: 'cs-CZ', name: 'Zdrojová židle' },
        { locale: 'en', name: 'Source chair' },
      ],
      [{ description: 'Pouze zdrojový popis', locale: 'cs-CZ' }],
    ]) {
      const plan = Option.getOrThrow(
        yield* build(rowsOf(product({ lifecycle: 'ACTIVE', localized })), { template: readyTemplate }),
      );
      const axes = effectOf(plan, 'product-0', 'readiness-axes');
      for (const [index, text] of localized.entries()) {
        const effectKey = `product-facts-${index}`;
        expect(axes.dependsOn).toContainEqual({ effectKey, itemKey: 'product-0' });
        expect(textRequestOf(effectOf(plan, 'product-0', effectKey))).toMatchObject({
          facts: {
            ...('name' in text ? { name: text.name } : {}),
            ...('description' in text ? { description: text.description } : {}),
          },
          locale: text.locale,
        });
      }
      // Every later readiness step waits for AXES, so NAME and activation cannot bypass a pending source text.
      for (const step of ['confirm', 'name', 'activate', 'unit', 'untyped']) {
        expect(effectOf(plan, 'product-0', `readiness-${step}`).dependsOn).toContainEqual({
          effectKey: 'readiness-axes',
          itemKey: 'product-0',
        });
      }
      expect(effectOf(plan, 'product-0', 'readiness-name').intent).toMatchObject({
        request: { locale: 'cs-CZ', name: 'Chair', step: 'NAME' },
      });
    }
  }),
);

it('rejects noncanonical readiness locales at route enrollment', () => {
  for (const locale of ['x', 'cs-cz', ' cs-CZ', 'cs-CZ ']) {
    expect(() =>
      decodeTemplate({
        ...templateInput(),
        catalogReadiness: { divisible: false, kind: 'AXIS_FREE_UNTYPED', locale, unitRef },
      }),
    ).toThrow();
  }
  expect(
    decodeTemplate({
      ...templateInput(),
      catalogReadiness: { divisible: false, kind: 'AXIS_FREE_UNTYPED', locale: 'cs-CZ', unitRef },
    }).catalogReadiness?.locale,
  ).toBe('cs-CZ');
});

it.effect('keeps eligible SKU work when another ACTIVE row cannot satisfy the readiness policy', () =>
  Effect.gen(function* mixedReadiness() {
    const readyTemplate = decodeTemplate({
      ...templateInput(priceDefaults),
      catalogReadiness: { divisible: false, kind: 'AXIS_FREE_UNTYPED', locale: 'cs-CZ', unitRef },
      items: [
        enroll('PRODUCT', 'enrolled-product', createProduct, ...readinessOperations),
        enroll('VARIANT', 'enrolled-variant', createVariant, variantFacts),
        enroll('PRICE', 'enrolled-price', priceDefine),
      ],
    });
    for (const ineligible of [
      product({ lifecycle: 'ACTIVE', unsupported: ['AttributeHint'] }, [variant({ prices: [price()] })]),
      product({ lifecycle: 'ACTIVE', unsupported: ['ClassificationHint'] }, [variant({ prices: [price()] })]),
      product({ lifecycle: 'ACTIVE' }, [variant({ prices: [price()] }), variant({ prices: [price()] })]),
    ]) {
      const plan = Option.getOrThrow(
        yield* build(rowsOf(ineligible, product({ lifecycle: 'ACTIVE' }, [variant({ prices: [price()] })])), {
          template: readyTemplate,
        }),
      );
      expect(itemOf(plan, 'product-0').effects.map(({ effectKey }) => effectKey)).toEqual(['product-create']);
      expect(itemOf(plan, 'product-0').unsupportedBranches).toEqual(
        expect.arrayContaining([
          { branchKey: 'PriceHint', kind: 'PriceHint' },
          {
            branchKey: ineligible.unsupported[0] ?? 'ClassificationHint',
            kind: ineligible.unsupported[0] ?? 'ClassificationHint',
          },
        ]),
      );
      expect(itemKeys(plan).some((key) => key.startsWith('product-0-variant-') && key.includes('-price-'))).toBe(false);
      expect(effectOf(plan, 'product-1', 'readiness-untyped').operation.entrypointKey).toBe(
        'commerce.catalog.decide-product-type-unnecessary',
      );
      expect(itemOf(plan, 'product-1-variant-0-price-0').effects[0]?.dependsOn).toContainEqual({
        effectKey: 'readiness-untyped',
        itemKey: 'product-1',
      });
    }
  }),
);
const variantCreateOf = (effect: Effect_) =>
  Option.getOrUndefined(
    Match.value(effect.intent).pipe(
      Match.when({ _tag: 'CatalogCreateVariantFromProductEffect' }, (intent) => intent),
      Match.option,
    ),
  );

describe('Symmy product plan from the public rows', () => {
  it.effect('maps a plain product to one Product create with a derived initial variant', () =>
    Effect.gen(function* maps() {
      const plan = Option.getOrThrow(
        yield* build(
          rowsOf(
            product({ description: 'A chair', identifier: { type: 'sku', value: 'CHAIR-1' } }, [
              variant({ identifier: { type: 'sku', value: 'CHAIR-1-RED' } }),
            ]),
          ),
        ),
      );
      expect(itemKeys(plan)).toEqual(['product-0']);
      const [item] = plan.items;
      expect(item?.source).toEqual({
        entityKind: 'PRODUCT',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-namespace',
        sourceRecordId: 'product:sku:CHAIR-1',
      });
      expect(item?.unsupportedBranches).toBeUndefined();
      const effect = effectOf(plan, 'product-0', 'product-create');
      expect(effect.operation).toEqual(createProduct);
      expect(effect.dependsOn).toBeUndefined();
      const payload = createPayloadOf(effect);
      expect(payload).toMatchObject({
        classification: { kind: 'INDEPENDENT_PRODUCT' },
        description: 'A chair',
        name: 'Chair',
        reason: 'Symmy product import',
        sourceCorrelation: {
          initialVariantRecordId: 'variant:sku:CHAIR-1-RED',
          issuerId: 'route-issuer',
          mappingRevision: 'mapping-v1',
          recordId: 'product:sku:CHAIR-1',
          recordNamespace: 'route-namespace',
          routeScope: '66666666-6666-4666-8666-666666666666',
        },
      });
      expect(payload?.variantId).toMatch(/^[0-9a-f-]{36}$/u);
    }),
  );

  it.effect('derives every identity from the idempotency key and the position, so a replay is the same plan', () =>
    Effect.gen(function* derives() {
      const rows = rowsOf(product({}, [variant({ prices: [price()] }), variant()]), product());
      const first = Option.getOrThrow(yield* build(rows));
      const second = Option.getOrThrow(yield* build(rows));
      const other = Option.getOrThrow(yield* build(rows, { idempotencyKey: 'product-key-2' }));
      const encode = Schema.encodeSync(SymmyFixtureExecutionPlanSchema);
      expect(encode(second)).toEqual(encode(first));
      expect(encode(other)).not.toEqual(encode(first));
      expect(first.items[0]?.source.sourceRecordId).toMatch(/^symmy-product:[0-9a-f]{64}$/u);
    }),
  );

  it.effect('keeps the business intent of a named product the same under another key, so a re-send is a replay', () =>
    Effect.gen(function* replays() {
      const rows = rowsOf(
        product({ identifier: { type: 'erpId', value: 'P-1' } }, [
          variant({ identifier: { type: 'variantId', value: 'V-1' } }),
          variant({ identifier: { type: 'variantId', value: 'V-2' } }),
        ]),
      );
      const first = Option.getOrThrow(yield* build(rows));
      const again = Option.getOrThrow(yield* build(rows, { idempotencyKey: 'another-key' }));
      expect(effectOf(again, 'product-0', 'product-create').intent).toEqual(
        effectOf(first, 'product-0', 'product-create').intent,
      );
      expect(effectOf(again, 'product-0-variant-1', 'variant-create').intent).toEqual(
        effectOf(first, 'product-0-variant-1', 'variant-create').intent,
      );
    }),
  );

  it.effect('keeps one native Price source fact across new-key deliveries without reusing request identities', () =>
    Effect.gen(function* replaysPriceSourceFact() {
      const rows = rowsOf(
        product({ identifier: { type: 'erpId', value: 'P-1' } }, [
          variant({
            identifier: { type: 'variantId', value: 'V-1' },
            prices: [price({ effectiveFrom: '2026-01-01T10:00:00.000Z' })],
          }),
        ]),
      );
      const first = Option.getOrThrow(yield* build(rows));
      const again = Option.getOrThrow(
        yield* build(rows, {
          idempotencyKey: 'another-key',
          receivedAt: DateTime.makeUnsafe('2026-01-02T12:00:00.000Z'),
        }),
      );
      const original = priceRequestOf(effectOf(first, 'product-0-variant-0-price-0', 'price-define'));
      const replay = priceRequestOf(effectOf(again, 'product-0-variant-0-price-0', 'price-define'));
      if (original === undefined || replay === undefined) {
        return yield* Effect.die('Expected both admitted Price requests');
      }
      const originalAssertion = yield* Schema.decodeUnknownEffect(PriceSourceAssertionInputSchema)(
        original.sourceAssertion,
      );
      const replayAssertion = yield* Schema.decodeUnknownEffect(PriceSourceAssertionInputSchema)(
        replay.sourceAssertion,
      );

      expect(replay.priceRef).not.toEqual(original.priceRef);
      expect(replayAssertion.sourceAssertionId).not.toBe(originalAssertion.sourceAssertionId);
      expect(replayAssertion.timing.importedAt).not.toBe(originalAssertion.timing.importedAt);
      expect(replayAssertion.sourceRecord).toEqual(originalAssertion.sourceRecord);
      expect(priceSourceFactFingerprint(replayAssertion)).toBe(priceSourceFactFingerprint(originalAssertion));
      expect(replayAssertion).toEqual({
        ...originalAssertion,
        sourceAssertionId: replayAssertion.sourceAssertionId,
        timing: { ...originalAssertion.timing, importedAt: replayAssertion.timing.importedAt },
      });
      // A real source change is not a delivery replay, even when it names the same native Price.
      for (const changed of [
        { ...replayAssertion, sourceAuthority: { ...replayAssertion.sourceAuthority, sourceAuthorityVersion: '2' } },
        { ...replayAssertion, mapping: { ...replayAssertion.mapping, mappingContractVersion: 'mapping-v2' } },
        {
          ...replayAssertion,
          sourceRecord: {
            ...replayAssertion.sourceRecord,
            sourceSystem: { ...replayAssertion.sourceRecord.sourceSystem, sourceSystemRef: 'OTHER_PRICES' },
          },
        },
        {
          ...replayAssertion,
          originalAssertion: {
            ...replayAssertion.originalAssertion,
            monetaryAmount: { ...replayAssertion.originalAssertion.monetaryAmount, amount: '26' },
          },
        },
      ]) {
        expect(priceSourceFactFingerprint(changed)).not.toBe(priceSourceFactFingerprint(originalAssertion));
      }
      return yield* Effect.void;
    }),
  );

  it.effect('orders the effects and names what each one waits for', () =>
    Effect.gen(function* orders() {
      const plan = Option.getOrThrow(
        yield* build(
          rowsOf(
            product({ lifecycle: 'ACTIVE' }, [
              variant({ localized: [{ locale: 'en', name: 'Chair' }], prices: [price()] }),
              variant({ localized: [{ locale: 'cs', name: 'Zidle' }], prices: [price()] }),
            ]),
          ),
        ),
      );
      expect(itemKeys(plan)).toEqual([
        'product-0',
        'product-0-variant-0',
        'product-0-variant-1',
        'product-0-variant-0-price-0',
        'product-0-variant-1-price-0',
      ]);
      const parent = { effectKey: 'product-create', itemKey: 'product-0' };
      const further = { effectKey: 'variant-create', itemKey: 'product-0-variant-1' };
      const update = { effectKey: 'product-update', itemKey: 'product-0' };
      expect(effectOf(plan, 'product-0', 'product-update').dependsOn).toEqual(['product-create', further]);
      const initialFacts = effectOf(plan, 'product-0-variant-0', 'variant-facts-0');
      expect(initialFacts.dependsOn).toEqual([parent]);
      expect(initialFacts.originalTarget).toBeUndefined();
      expect(dependentOf(initialFacts)?.variantParent).toBeUndefined();
      expect(dependentOf(effectOf(plan, 'product-0-variant-1', 'variant-facts-0'))?.variantParent).toEqual(further);
      const create = effectOf(plan, 'product-0-variant-1', 'variant-create');
      expect(create.dependsOn).toEqual([parent]);
      expect(variantCreateOf(create)).toBeDefined();
      expect(effectOf(plan, 'product-0-variant-1', 'variant-facts-0').dependsOn).toEqual([parent, 'variant-create']);
      expect(effectOf(plan, 'product-0-variant-0-price-0', 'price-define').dependsOn).toEqual([parent, update]);
      expect(effectOf(plan, 'product-0-variant-1-price-0', 'price-define').dependsOn).toEqual([
        parent,
        further,
        update,
      ]);
    }),
  );

  it.effect('links a price to its variant and the Product created by the same job', () =>
    Effect.gen(function* links() {
      const plan = Option.getOrThrow(
        yield* build(rowsOf(product({}, [variant({ prices: [price()] }), variant({ prices: [price()] })]))),
      );
      expect(itemKeys(plan)).toEqual([
        'product-0',
        'product-0-variant-1',
        'product-0-variant-0-price-0',
        'product-0-variant-1-price-0',
      ]);
      // The poll folds variants and prices back into their product: items[n] is product n.
      expect(new Set(itemKeys(plan).map(symmyRequestItemKey))).toEqual(new Set(['product-0']));
      const initial = effectOf(plan, 'product-0-variant-0-price-0', 'price-define');
      expect(initial.operation).toEqual(priceDefine);
      expect(dependentOf(initial)?.parent).toEqual({ effectKey: 'product-create', itemKey: 'product-0' });
      expect(dependentOf(initial)?.variantParent).toBeUndefined();
      const request = priceRequestOf(initial);
      expect(request?.identityKey).toMatchObject({
        commercialScope: { channelId: 'B2B', marketId: 'cz-market', sellingLegalEntityId: legalEntityId },
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' },
        unitBasis: { quantity: '1' },
      });
      expect(request?.identityKey).not.toHaveProperty('catalogSelection');
      expect(request?.reason).toBe('Symmy price import');
      expect(request?.effectiveFrom).toBe('2026-01-01T12:00:00.000Z');
      expect(request?.priceRef).toEqual(initial.originalTarget);
      expect(dependentOf(effectOf(plan, 'product-0-variant-1-price-0', 'price-define'))?.variantParent).toEqual({
        effectKey: 'variant-create',
        itemKey: 'product-0-variant-1',
      });
    }),
  );

  it.effect('names the price list of a price group code the route resolved, and refuses an unknown one', () =>
    Effect.gen(function* groups() {
      const rows = rowsOf(
        product({}, [
          variant({ prices: [price({ priceGroupCode: 'wholesale' }), price({ priceGroupCode: 'other' })] }),
        ]),
      );
      const plan = Option.getOrThrow(yield* build(rows, { groups: [{ code: 'wholesale', priceGroupRef: groupRef }] }));
      expect(itemKeys(plan)).toEqual(['product-0', 'product-0-variant-0-price-0']);
      const request = priceRequestOf(effectOf(plan, 'product-0-variant-0-price-0', 'price-define'));
      expect(request?.identityKey.priceGroupSelector).toEqual({ kind: 'PRICE_GROUP', priceGroupRef: groupRef });
      expect(itemOf(plan, 'product-0').unsupportedBranches).toEqual([{ branchKey: 'PriceHint', kind: 'PriceHint' }]);
    }),
  );

  it.effect('takes the route default for a missing scope or unit basis and reports a price it cannot name', () =>
    Effect.gen(function* defaults() {
      const rows = rowsOf(
        product({}, [
          variant({
            prices: [
              price({ commercialScope: { channelId: 'B2C' } }),
              price({ unitBasis: { quantity: '2', unitRef } }),
            ],
          }),
        ]),
      );
      const plan = Option.getOrThrow(yield* build(rows));
      const [scoped, unit] = [0, 1].map(
        (position) =>
          priceRequestOf(effectOf(plan, `product-0-variant-0-price-${position}`, 'price-define'))?.identityKey,
      );
      expect(scoped).toMatchObject({ commercialScope: { channelId: 'B2C', marketId: 'cz-market' } });
      expect(unit).toMatchObject({ unitBasis: { quantity: '2' } });
      const bare = Option.getOrThrow(
        yield* build(rowsOf(product({}, [variant({ prices: [price()] })])), {
          template: decodeTemplate(templateInput()),
        }),
      );
      expect(itemKeys(bare)).toEqual(['product-0']);
      expect(itemOf(bare, 'product-0').unsupportedBranches).toEqual([{ branchKey: 'PriceHint', kind: 'PriceHint' }]);
    }),
  );

  it.effect('reports a price for another selling legal entity instead of writing it', () =>
    Effect.gen(function* foreign() {
      const rows = rowsOf(
        product({}, [variant({ prices: [price({ commercialScope: { sellingLegalEntityId: tenantId } })] })]),
      );
      const plan = Option.getOrThrow(yield* build(rows));
      expect(itemKeys(plan)).toEqual(['product-0']);
      expect(itemOf(plan, 'product-0').unsupportedBranches?.map(({ kind }) => kind)).toEqual(['PriceHint']);
    }),
  );

  it.effect('reports every unsupported group of the product on its item, once', () =>
    Effect.gen(function* reports() {
      const kinds = [
        'AttributeHint',
        'MediaHint',
        'VariantUpdateHint',
        'DescriptiveHint',
        'ClassificationHint',
      ] as const;
      const plan = Option.getOrThrow(yield* build(rowsOf(product({ unsupported: kinds }))));
      expect(itemOf(plan, 'product-0').unsupportedBranches).toEqual(kinds.map((kind) => ({ branchKey: kind, kind })));
    }),
  );

  it.effect('yields no plan when the route does not enroll an operation the rows need', () =>
    Effect.gen(function* refuses() {
      const narrow = decodeTemplate({
        ...templateInput(priceDefaults),
        items: [enroll('PRODUCT', 'enrolled-product', createProduct)],
      });
      expect(Option.isSome(yield* build(rowsOf(product()), { template: narrow }))).toBe(true);
      for (const rows of [
        rowsOf(product({ lifecycle: 'ACTIVE' })),
        rowsOf(product({}, [variant(), variant()])),
        rowsOf(product({}, [variant({ localized: [{ locale: 'en', name: 'Chair' }] })])),
        rowsOf(product({ localized: [{ locale: 'cs-CZ', name: 'Židle' }] })),
        rowsOf(product({}, [variant({ sku: 'CHAIR-RED' })])),
        rowsOf(product({}, [variant({ prices: [price()] })])),
      ]) {
        expect(Option.isNone(yield* build(rows, { template: narrow }))).toBe(true);
      }
      expect(
        Option.isNone(
          yield* build(rowsOf(product({}, [variant({ prices: [price()] })])), { withoutLegalEntity: true }),
        ),
      ).toBe(true);
    }),
  );

  it.effect('builds a plan the admission payload accepts and the execution plan decodes', () =>
    Effect.gen(function* decodes() {
      const rows = rowsOf(product({ lifecycle: 'DRAFT' }, [variant({ localized: [{ locale: 'en', name: 'Chair' }] })]));
      expect(Option.isSome(yield* build(rows))).toBe(true);
      const payload = Schema.decodeUnknownResult(AdmitSymmyJobPayloadSchema)({
        idempotencyKey: 'product-key-1',
        priceGroupFacts: [],
        products: Schema.encodeSync(SymmyProductRowsSchema)(rows),
        routeKey: 'productsBatch',
      });
      expect(Result.isSuccess(payload)).toBe(true);
      const withoutFacts = Schema.decodeUnknownResult(AdmitSymmyJobPayloadSchema)({
        idempotencyKey: 'product-key-1',
        products: Schema.encodeSync(SymmyProductRowsSchema)(rows),
        routeKey: 'productsBatch',
      });
      expect(Result.isFailure(withoutFacts)).toBe(true);
    }),
  );

  it.effect('uses only the owner-known request kinds', () =>
    Effect.gen(function* kinds() {
      const plan = Option.getOrThrow(
        yield* build(
          rowsOf(
            product({ lifecycle: 'ACTIVE' }, [
              variant({ localized: [{ locale: 'en', name: 'Chair' }], prices: [price()] }),
            ]),
          ),
        ),
      );
      expect(requestTagOf(effectOf(plan, 'product-0', 'product-update'))).toBe('UpdateProduct');
      expect(requestTagOf(effectOf(plan, 'product-0-variant-0', 'variant-facts-0'))).toBe('SetVariantLocalizedFacts');
      expect(requestTagOf(effectOf(plan, 'product-0-variant-0-price-0', 'price-define'))).toBe('DefinePrice');
    }),
  );

  it.effect('plans one product and its initial variant without localized texts or prices', () =>
    Effect.gen(function* noProductTexts() {
      for (const extra of [{}, { localized: [] }]) {
        const plan = Option.getOrThrow(yield* build(rowsOf(product(extra))));
        expect(itemKeys(plan)).toEqual(['product-0']);
        expect(itemOf(plan, 'product-0').effects.map(({ effectKey }) => effectKey)).toEqual(['product-create']);
        expect(createPayloadOf(effectOf(plan, 'product-0', 'product-create'))?.name).toBe('Chair');
        expect(Result.isSuccess(Schema.decodeUnknownResult(SymmyFixtureExecutionPlanSchema)(plan))).toBe(true);
      }
    }),
  );

  it.effect('writes each text of the product as its localized facts, on the first import and on every re-send', () =>
    Effect.gen(function* productTexts() {
      const rows = rowsOf(
        product(
          {
            identifier: { type: 'erpId', value: 'AKROS-1' },
            lifecycle: 'ACTIVE',
            localized: [
              { description: 'Ocelové kladivo', locale: 'cs-CZ', name: 'Kladivo' },
              { locale: 'en', name: 'Hammer' },
            ],
          },
          [variant({ identifier: { type: 'variantId', value: 'AKROS-1-A' } })],
        ),
      );
      const plan = Option.getOrThrow(yield* build(rows));
      expect(itemKeys(plan)).toEqual(['product-0']);
      const parent = { effectKey: 'product-create', itemKey: 'product-0' };
      const czech = effectOf(plan, 'product-0', 'product-facts-0');
      expect(czech.operation).toEqual(productFacts);
      expect(czech.dependsOn).toEqual(['product-create']);
      expect(czech.originalTarget).toBeUndefined();
      expect(dependentOf(czech)?.parent).toEqual(parent);
      expect(dependentOf(czech)?.variantParent).toBeUndefined();
      expect(requestTagOf(czech)).toBe('SetProductLocalizedFacts');
      expect(textRequestOf(czech)).toEqual({
        evidenceRefs: textRequestOf(effectOf(plan, 'product-0', 'product-facts-1'))?.evidenceRefs,
        facts: { description: 'Ocelové kladivo', name: 'Kladivo' },
        locale: 'cs-CZ',
        reason: 'Symmy product import',
      });
      // The owner's current revision is read when the text is written, never planned.
      expect(textRequestOf(czech)).not.toHaveProperty('expectedRevision');
      expect(textRequestOf(effectOf(plan, 'product-0', 'product-facts-1'))?.facts).toEqual({ name: 'Hammer' });
      // An activation needs a localized name, so the lifecycle waits for the texts.
      expect(effectOf(plan, 'product-0', 'product-update').dependsOn).toEqual([
        'product-create',
        'product-facts-0',
        'product-facts-1',
      ]);
      expect(itemOf(plan, 'product-0').unsupportedBranches).toBeUndefined();
      const resent = Option.getOrThrow(yield* build(rows, { idempotencyKey: 'product-key-2' }));
      expect(effectOf(resent, 'product-0', 'product-facts-0').intent).toEqual(czech.intent);
      expect(effectOf(resent, 'product-0', 'product-create').intent).toEqual(
        effectOf(plan, 'product-0', 'product-create').intent,
      );
    }),
  );

  it.effect('plans the SKU of each variant as its Catalog SKU assignment, the same on every re-send', () =>
    Effect.gen(function* variantSkus() {
      const rows = rowsOf(
        product({ identifier: { type: 'erpId', value: 'AKROS-10001' } }, [
          variant({ identifier: { type: 'variantId', value: 'AKROS-10001-V1' }, sku: 'DIN933-M8x40-ZN' }),
          variant({ identifier: { type: 'variantId', value: 'AKROS-10001-V2' }, sku: 'DIN933-M8x40-A2' }),
        ]),
      );
      const plan = Option.getOrThrow(yield* build(rows));
      // A SKU alone makes the initial variant an item of its own: its source record is the Variant's.
      expect(itemKeys(plan)).toEqual(['product-0', 'product-0-variant-0', 'product-0-variant-1']);
      expect(itemOf(plan, 'product-0-variant-0').source).toMatchObject({
        entityKind: 'VARIANT',
        sourceRecordId: 'variant:variantId:AKROS-10001-V1',
      });
      const parent = { effectKey: 'product-create', itemKey: 'product-0' };
      const initial = effectOf(plan, 'product-0-variant-0', 'variant-sku');
      expect(initial.operation).toEqual(variantSku);
      expect(initial.dependsOn).toEqual([parent]);
      expect(initial.originalTarget).toBeUndefined();
      expect(dependentOf(initial)?.variantParent).toBeUndefined();
      // The request names the code and its evidence only: the Variant and its source record are resolved later.
      expect(skuRequestOf(initial)).toEqual({
        code: 'DIN933-M8x40-ZN',
        evidenceRefs: skuRequestOf(effectOf(plan, 'product-0-variant-1', 'variant-sku'))?.evidenceRefs,
        reason: 'Symmy product import',
      });
      // A further variant's SKU waits for its own create and names it.
      const further = effectOf(plan, 'product-0-variant-1', 'variant-sku');
      expect(further.dependsOn).toEqual([parent, 'variant-create']);
      expect(dependentOf(further)?.variantParent).toEqual({
        effectKey: 'variant-create',
        itemKey: 'product-0-variant-1',
      });
      expect(itemOf(plan, 'product-0').unsupportedBranches).toBeUndefined();
      const resent = Option.getOrThrow(yield* build(rows, { idempotencyKey: 'product-key-2' }));
      expect(effectOf(resent, 'product-0-variant-0', 'variant-sku').intent).toEqual(initial.intent);
    }),
  );

  it.effect('plans a variant text without a revision, so a later change is written at the current one', () =>
    Effect.gen(function* variantTexts() {
      const plan = Option.getOrThrow(
        yield* build(rowsOf(product({}, [variant({ localized: [{ locale: 'cs-CZ', name: 'Červená' }] })]))),
      );
      const text = textRequestOf(effectOf(plan, 'product-0-variant-0', 'variant-facts-0'));
      expect(text).toEqual({
        evidenceRefs: text?.evidenceRefs,
        facts: { name: 'Červená' },
        locale: 'cs-CZ',
        reason: 'Symmy product import',
      });
      expect(text).not.toHaveProperty('expectedRevision');
    }),
  );
});

describe('Symmy product plan size', () => {
  it.effect('reports route-generated readiness overflow as a size error, not an unenrolled route', () =>
    Effect.gen(function* generatedReadinessLimit() {
      const categories = Array.from({ length: 26 }, (_, index) => ({
        moduleId: 'commerce.catalog',
        resourceId: `99990000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        resourceType: 'commerce.catalog.product-category',
        tenantId,
      }));
      const source = templateInput(priceDefaults);
      const selected = decodeTemplate({
        ...source,
        catalogReadiness: { divisible: false, kind: 'AXIS_FREE_UNTYPED', locale: 'cs-CZ', unitRef },
        items: [
          enroll('PRODUCT', 'enrolled-product', createProduct, categoryAssignment, ...readinessOperations),
          ...source.items.slice(1),
        ],
      });
      const rows = rowsOf(product({ categories, lifecycle: 'ACTIVE' }));
      expect(symmyProductPlanSize(rows[0]).effects).toBe(28);
      const result = yield* build(rows, { template: selected }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Schema.is(SymmyProductPlanLimitError)(Option.getOrThrow(Cause.findErrorOption(result.cause)))).toBe(
          true,
        );
      }
      const fits = Option.getOrThrow(
        yield* build(rowsOf(product({ categories: categories.slice(0, 25), lifecycle: 'ACTIVE' })), {
          template: selected,
        }),
      );
      expect(itemOf(fits, 'product-0').effects).toHaveLength(32);
      const pricedFits = Option.getOrThrow(
        yield* build(
          rowsOf(
            product({ categories: categories.slice(0, 25), lifecycle: 'ACTIVE' }, [variant({ prices: [price()] })]),
          ),
          { template: selected },
        ),
      );
      expect(itemOf(pricedFits, 'product-0').effects).toHaveLength(32);
      expect(pricedFits.items).toHaveLength(2);
      const withoutReadiness = decodeTemplate({
        ...source,
        items: [
          enroll('PRODUCT', 'enrolled-product', createProduct, updateProduct, categoryAssignment),
          ...source.items.slice(1),
        ],
      });
      const ordinary = Option.getOrThrow(yield* build(rows, { template: withoutReadiness }));
      expect(itemOf(ordinary, 'product-0').effects).toHaveLength(28);
    }),
  );

  it.effect('counts generated Inventory provisioning at the actual 32-effect boundary', () =>
    Effect.gen(function* generatedProvisioningLimit() {
      const categories = Array.from({ length: 31 }, (_, index) => ({
        moduleId: 'commerce.catalog',
        resourceId: `99990000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        resourceType: 'commerce.catalog.product-category',
        tenantId,
      }));
      const source = templateInput(priceDefaults);
      const selected = decodeTemplate({
        ...source,
        inventoryBackendId: 'budget-backend',
        inventorySource: {
          customerConfigurationId: 'budget-configuration',
          externalScope: 'budget-stock',
          issuer: { backendId: 'budget-backend', backendKind: 'external_business_system' },
          locations: [
            {
              locationKey: 'warehouse',
              stockLocationRef: {
                moduleId: 'commerce.inventory',
                resourceId: '88880000-0000-4000-8000-000000000001',
                resourceType: 'commerce.inventory.stock-location',
                tenantId,
              },
            },
          ],
          namespace: 'budget-stock',
          policyRef: {
            moduleId: 'commerce.inventory',
            resourceId: '88880000-0000-4000-8000-000000000002',
            resourceType: 'commerce.inventory.source-provisioning-policy',
            tenantId,
          },
          unitRef,
        },
        items: [
          enroll('PRODUCT', 'enrolled-product', createProduct, categoryAssignment, provisionStockItemOperation),
          ...source.items.slice(1),
        ],
      });
      const input = (count: number) =>
        rowsOf(product({ categories: categories.slice(0, count), identifier: { type: 'sku', value: 'budget-sku' } }));
      const failure = yield* build(input(31), { template: selected }).pipe(Effect.flip);
      expect(Schema.is(SymmyProductPlanLimitError)(failure)).toBe(true);
      const fits = Option.getOrThrow(yield* build(input(30), { template: selected }));
      expect(itemOf(fits, 'product-0').effects).toHaveLength(32);
      expect(effectOf(fits, 'product-0', 'inventory-provision-0')).toBeDefined();
    }),
  );

  it('projects plan capacity as an actionable invalid request rather than route authorization', () => {
    const problem = mapAdmitSymmyJobBusinessProblem(
      new AdmitSymmyJobRejected({ code: 'symmy_job_plan_limit_exceeded', reason: 'not public diagnostic detail' }),
    );
    expect(problem).toMatchObject({
      code: 'symmy_job_plan_limit_exceeded',
      status: 400,
    });
    expect(problem.detail).toContain('32 owner effects');
    expect(problem.detail).toContain('Split the batch');
    expect(problem.detail).not.toContain('not public diagnostic detail');
  });

  it('counts a create, a lifecycle update, each further variant, each text and each price as an effect', () => {
    expect(symmyProductPlanSize({ variants: [{}] })).toEqual({ effects: 1, items: 1 });
    expect(
      symmyProductPlanSize({
        lifecycle: 'ACTIVE',
        variants: [{ localized: texts(2), prices: [{}] }, { prices: [{}, {}] }],
      }),
    ).toEqual({ effects: 1 + 1 + 1 + 2 + 3, items: 1 + 2 + 3 });
    expect(symmyProductPlanSize({ localized: texts(2), variants: [{}] })).toEqual({ effects: 1 + 2, items: 1 });
    // A SKU is one effect of its variant's item, and makes the initial variant an item when nothing else does.
    expect(symmyProductPlanSize({ variants: [{ sku: 'A' }] })).toEqual({ effects: 2, items: 2 });
    expect(symmyProductPlanSize({ variants: [{ localized: texts(1), prices: [{}], sku: 'A' }] })).toEqual({
      effects: 1 + 1 + 1 + 1,
      items: 1 + 1 + 1,
    });
  });

  it('accepts a product of 32 effects and rejects one of 33', () => {
    const decode = Schema.decodeUnknownResult(SymmyProductRowsSchema);
    expect(Result.isSuccess(decode([product({}, [variant({ localized: texts(31) })])]))).toBe(true);
    expect(Result.isFailure(decode([product({}, [variant({ localized: texts(32) })])]))).toBe(true);
    expect(Result.isFailure(decode([product({ localized: texts(16) }, [variant({ localized: texts(16) })])]))).toBe(
      true,
    );
  });

  it('rejects a request that needs more than sixteen plan items', () => {
    const decode = Schema.decodeUnknownResult(SymmyProductRowsSchema);
    expect(Result.isSuccess(decode(Array.from({ length: 16 }, () => product())))).toBe(true);
    const priced = Array.from({ length: 9 }, () => product({}, [variant({ prices: [price()] })]));
    expect(Result.isFailure(decode(priced))).toBe(true);
  });
});
