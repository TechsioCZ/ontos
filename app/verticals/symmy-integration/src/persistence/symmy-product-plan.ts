import { DateTime, Effect, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SYMMY_PRICE_REASON } from '../../shared/domain/symmy-price-list-batch.ts';
import { SYMMY_PRODUCT_REASON } from '../../shared/domain/symmy-product-batch.ts';
import type {
  SymmyProductHintKind,
  SymmyProductPriceGroupFacts,
  SymmyProductRow,
  SymmyProductRows,
} from '../../shared/domain/symmy-product-batch.ts';
import { uuidFromDigest } from './derived-identity.ts';
import { enrolledItem, instant, priceContextOf, priceOperation } from './symmy-price-list-plan.ts';
import type { Digest, PriceContext } from './symmy-price-list-plan.ts';

const catalogModule = 'commerce.catalog';
export const createProductOperation = {
  entrypointKey: 'commerce.catalog.create-product',
  moduleId: catalogModule,
  schemaVersion: '2',
} as const;
export const createVariantOperation = {
  entrypointKey: 'commerce.catalog.create-variant',
  moduleId: catalogModule,
  schemaVersion: '2',
} as const;
export const updateProductOperation = {
  entrypointKey: 'commerce.catalog.update-product',
  moduleId: catalogModule,
  schemaVersion: '1',
} as const;
export const categoryAssignmentOperation = {
  entrypointKey: 'commerce.catalog.add-product-category-assignment',
  moduleId: catalogModule,
  schemaVersion: '1',
} as const;
export const variantFactsOperation = {
  entrypointKey: 'commerce.catalog.set-variant-localized-facts',
  moduleId: catalogModule,
  schemaVersion: '1',
} as const;
const readinessOperation = (entrypointKey: string) => ({
  entrypointKey: `commerce.catalog.${entrypointKey}`,
  moduleId: catalogModule,
  schemaVersion: '1',
});
export const readinessOperations = [
  readinessOperation('govern-variant-axes'),
  readinessOperation('confirm-variant-combination'),
  readinessOperation('set-product-localized-facts'),
  updateProductOperation,
  readinessOperation('set-product-unit-target-divisibility'),
  readinessOperation('decide-product-type-unnecessary'),
] as const;

export const provisionStockItemOperation = {
  entrypointKey: 'commerce.inventory.provision-source-stock-item',
  moduleId: 'commerce.inventory',
  schemaVersion: '1',
} as const;

const productCreateKey = 'product-create';
const productUpdateKey = 'product-update';
const variantCreateKey = 'variant-create';
const priceDefineKey = 'price-define';
const MAX_RECORD_LENGTH = 300;

type Source = Pick<SymmyFixtureExecutionPlan['items'][number]['source'], 'issuerId' | 'sourceNamespace'>;
type Variant = SymmyProductRow['variants'][number];
type VariantPrice = Variant['prices'][number];

/** A literal key that only exists when it has a value, so no absent value is ever written as undefined. */
const present = <Value>(key: string, value: Value | undefined): Readonly<Record<string, Value>> =>
  value === undefined ? {} : { [key]: value };

/** What the route enrolls for the products: where each kind of record lives, and the price grants when it has them. */
interface Enrollment {
  readonly catalogReadiness: SymmyFixtureExecutionPlan['catalogReadiness'];
  readonly inventorySource: SymmyFixtureExecutionPlan['inventorySource'];
  readonly mappingRevision: string;
  readonly prices: Option.Option<PriceContext>;
  readonly routeScope: string;
  readonly source: Source;
}

const sameSource = (left: Source, right: Source) =>
  left.issuerId === right.issuerId && left.sourceNamespace === right.sourceNamespace;

/** The one issuer and namespace every catalog record of the request shares, or none when the route enrolls less. */
const catalogSource = (rows: SymmyProductRows, template: SymmyFixtureExecutionPlan): Option.Option<Source> => {
  const variants = rows.flatMap(({ variants: rowVariants }) => rowVariants);
  const updates = rows.some((row) => row.lifecycle === 'ACTIVE' || row.lifecycle === 'RETIRED');
  const texts = variants.some(({ localized }) => localized.length > 0);
  const further = rows.some(({ variants: rowVariants }) => rowVariants.length > 1);
  const product = enrolledItem(template, 'PRODUCT', createProductOperation);
  const required = [
    ...(rows.some(({ categories }) => (categories?.length ?? 0) > 0)
      ? [enrolledItem(template, 'PRODUCT', categoryAssignmentOperation)]
      : []),
    ...(updates ? [enrolledItem(template, 'PRODUCT', updateProductOperation)] : []),
    ...(further ? [enrolledItem(template, 'VARIANT', createVariantOperation)] : []),
    ...(texts ? [enrolledItem(template, 'VARIANT', variantFactsOperation)] : []),
  ];
  return Option.isSome(product) &&
    required.every((item) => Option.isSome(item) && sameSource(item.value.source, product.value.source))
    ? Option.some({ issuerId: product.value.source.issuerId, sourceNamespace: product.value.source.sourceNamespace })
    : Option.none();
};

/** A source record id for an identifier the body names, or the one derived from the request when it names none. */
const recordIdOf = Effect.fn('SymmyProductPlan.recordId')(function* recordIdOf<Failure>(
  entity: 'product' | 'variant',
  identifier: { readonly type: string; readonly value: string } | undefined,
  digest: Digest<Failure>,
  derived: string,
) {
  const named = identifier === undefined ? undefined : `${entity}:${identifier.type}:${identifier.value}`;
  if (named !== undefined && named.length <= MAX_RECORD_LENGTH && named === named.trim()) {
    return named;
  }
  return `symmy-${entity}:${yield* digest(named ?? derived)}`;
});

const trimTrailingZeros = (quantity: string) =>
  quantity.includes('.') ? quantity.replace(/0+$/u, '').replace(/\.$/u, '') : quantity;

/** The facts of one price once the route and the body together have named every part of its identity. */
interface ResolvedPrice {
  readonly channelId: NonNullable<NonNullable<VariantPrice['commercialScope']>['channelId']>;
  readonly groupCode: string | undefined;
  readonly marketId: NonNullable<NonNullable<VariantPrice['commercialScope']>['marketId']>;
  readonly price: VariantPrice;
  readonly priceGroupRef: SymmyProductPriceGroupFacts[number]['priceGroupRef'] | undefined;
  readonly unitBasis: NonNullable<VariantPrice['unitBasis']>;
}

/**
 * Names every part of a price identity from the body, then the route default. A price that cannot be named
 * completely, names another selling legal entity than the route's or names a price group the route's source
 * did not create is not written: it is reported as unsupported, never given a guess.
 */
const resolvePrice = (
  price: VariantPrice,
  context: PriceContext,
  groups: SymmyProductPriceGroupFacts,
): Option.Option<ResolvedPrice> => {
  const { defaults } = context.priceSource;
  const channelId = price.commercialScope?.channelId ?? defaults?.commercialScope.channelId;
  const marketId = price.commercialScope?.marketId ?? defaults?.commercialScope.marketId;
  const unitBasis = price.unitBasis ?? defaults?.unitBasis;
  const group =
    price.priceGroupCode === undefined ? undefined : groups.find(({ code }) => code === price.priceGroupCode);
  const sellingLegalEntityId = price.commercialScope?.sellingLegalEntityId;
  return channelId === undefined ||
    marketId === undefined ||
    unitBasis === undefined ||
    (sellingLegalEntityId !== undefined && sellingLegalEntityId !== context.legalEntityId) ||
    (price.priceGroupCode !== undefined && group === undefined)
    ? Option.none()
    : Option.some({
        channelId,
        groupCode: price.priceGroupCode,
        marketId,
        price,
        priceGroupRef: group?.priceGroupRef,
        unitBasis,
      });
};

/** The stable identity of a price of a variant, so a replay of the same price keeps one source record. */
const priceIdentity = (variantRecord: string, resolved: ResolvedPrice): string =>
  [
    variantRecord,
    resolved.price.currencyCode,
    resolved.groupCode ?? '',
    resolved.channelId,
    resolved.marketId,
    resolved.unitBasis.unitRef.resourceId,
    trimTrailingZeros(resolved.unitBasis.quantity),
  ]
    .map((part) => `${part.length}:${part}`)
    .join('');

interface ProductFacts<Failure> {
  readonly digest: Digest<Failure>;
  readonly enrollment: Enrollment;
  readonly groups: SymmyProductPriceGroupFacts;
  readonly idempotencyKey: string;
  readonly importedAt: DateTime.Utc;
  readonly index: number;
  readonly row: SymmyProductRow;
  readonly tenantId: string;
}

/** A variant with the identities the request gives it: all derived from the key and the positions. */
interface PlannedVariant {
  readonly occurrenceId: string;
  readonly record: string;
  readonly ref: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  };
  readonly row: Variant;
}

const plannedVariant = Effect.fn('SymmyProductPlan.variant')(function* plannedVariant<Failure>(
  facts: ProductFacts<Failure>,
  position: number,
  row: Variant,
  productRecord: string,
) {
  const { digest, idempotencyKey, index, tenantId } = facts;
  const record = yield* recordIdOf(
    'variant',
    row.identifier,
    digest,
    `variant-record\u0000${productRecord}\u0000${position}`,
  );
  // A variant id is a fact of its source record, not of the request, so a re-sent product asks the owner for
  // the same Variant and the create is a semantic replay instead of a conflict.
  const [variantId, occurrence] = yield* Effect.all(
    [
      digest(`variant\u0000${tenantId}\u0000${productRecord}\u0000${record}`),
      digest(`variant-occurrence\u0000${idempotencyKey}\u0000${index}\u0000${position}`),
    ],
    { concurrency: 2 },
  );
  return {
    occurrenceId: uuidFromDigest(occurrence),
    record,
    ref: {
      moduleId: catalogModule,
      resourceId: uuidFromDigest(variantId),
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
    row,
  } satisfies PlannedVariant;
});

const buildPriceItem = Effect.fn('SymmyProductPlan.price')(function* buildPriceItem<Failure>(
  facts: ProductFacts<Failure> & {
    readonly context: PriceContext;
    readonly dependsOn: readonly unknown[];
    readonly parent: { readonly effectKey: string; readonly itemKey: string };
    readonly position: readonly [variant: number, price: number];
    readonly resolved: ResolvedPrice;
    readonly variant: PlannedVariant;
    readonly variantParent: Option.Option<{ readonly effectKey: string; readonly itemKey: string }>;
  },
) {
  const {
    context,
    dependsOn,
    digest,
    idempotencyKey,
    importedAt,
    index,
    parent,
    position,
    resolved,
    tenantId,
    variant,
    variantParent,
  } = facts;
  const { legalEntityId, priceSource, source, sourceSystem } = context;
  const { price } = resolved;
  const parts = `${idempotencyKey}\u0000${index}\u0000${position[0]}\u0000${position[1]}`;
  const [priceId, occurrence, record] = yield* Effect.all(
    [
      digest(`product-price\u0000${parts}`),
      digest(`product-price-occurrence\u0000${parts}`),
      digest(`product-price-record\u0000${priceIdentity(variant.record, resolved)}`),
    ],
    { concurrency: 3 },
  );
  const occurrenceId = uuidFromDigest(occurrence);
  const recordId = `symmy-price:${record}`;
  const effectiveFrom = instant(price.effectiveFrom ?? DateTime.formatIso(importedAt));
  const monetaryAmount = { amount: price.amount, currencyCode: price.currencyCode };
  const priceRef = {
    moduleId: priceOperation.moduleId,
    resourceId: uuidFromDigest(priceId),
    resourceType: 'commerce.pricing.price',
    tenantId,
  };
  return {
    effects: [
      {
        dependsOn,
        effectKey: priceDefineKey,
        intent: {
          _tag: 'CatalogProductDependentEffect',
          parent,
          request: {
            _tag: 'DefinePrice',
            payload: {
              effectiveFrom,
              identityKey: {
                commercialScope: {
                  channelId: resolved.channelId,
                  marketId: resolved.marketId,
                  sellingLegalEntityId: legalEntityId,
                },
                currencyCode: price.currencyCode,
                priceGroupSelector:
                  resolved.priceGroupRef === undefined
                    ? { kind: 'NO_GROUP' }
                    : { kind: 'PRICE_GROUP', priceGroupRef: resolved.priceGroupRef },
                unitBasis: resolved.unitBasis,
              },
              monetaryAmount,
              priceRef,
              reason: SYMMY_PRICE_REASON,
              sourceAssertion: {
                lineage: { kind: 'INITIAL' },
                mapping: priceSource.mapping,
                originalAssertion: { monetaryAmount, monetaryBoundary: 'PRE_TAX', unitBasis: resolved.unitBasis },
                sourceAssertionId: occurrenceId,
                sourceAuthority: priceSource.sourceAuthority,
                sourceRecord: {
                  sourceChangeCorrelation: occurrenceId,
                  sourceRecordRef: recordId,
                  sourceRecordVersion: '1',
                  sourceSystem,
                },
                timing: {
                  importedAt: DateTime.formatIso(importedAt),
                  ownerBusinessEffectiveAt: effectiveFrom,
                  sourceEffectiveAt: effectiveFrom,
                },
              },
            },
          },
          ...present('variantParent', Option.getOrUndefined(variantParent)),
        },
        operation: priceOperation,
        originalTarget: priceRef,
      },
    ],
    itemKey: `product-${index}-variant-${position[0]}-price-${position[1]}`,
    source: {
      entityKind: 'PRICE',
      issuerId: source.issuerId,
      sourceNamespace: source.sourceNamespace,
      sourceRecordId: recordId,
    },
    sourceOccurrenceId: occurrenceId,
  };
});

/** The variant item: its own create when it is not the initial variant, and one text effect per localized text. */
const buildVariantItem = (
  facts: Pick<ProductFacts<never>, 'enrollment' | 'index' | 'idempotencyKey'> & {
    readonly evidenceRefs: readonly [string, ...string[]];
    readonly parent: { readonly effectKey: string; readonly itemKey: string };
    readonly position: number;
    readonly productRecord: string;
    readonly variant: PlannedVariant;
  },
) => {
  const { enrollment, evidenceRefs, index, parent, position, productRecord, variant } = facts;
  const { mappingRevision, routeScope, source } = enrollment;
  const correlation = (recordId: string) => ({
    issuerId: source.issuerId,
    mappingRevision,
    recordId,
    recordNamespace: source.sourceNamespace,
    routeScope,
  });
  const created = position > 0;
  const own = created ? [{ effectKey: variantCreateKey, itemKey: `product-${index}-variant-${position}` }] : [];
  const create = created
    ? [
        {
          dependsOn: [parent],
          effectKey: variantCreateKey,
          intent: {
            _tag: 'CatalogCreateVariantFromProductEffect',
            parent,
            payload: {
              classification: {
                affectsOpenSelection: true,
                evidenceRefs,
                kind: 'NEW_REALIZATION',
                newVariantRef: variant.ref,
                reason: SYMMY_PRODUCT_REASON,
              },
              evidenceRefs,
              expectedProductRevision: 1,
              reason: SYMMY_PRODUCT_REASON,
              sourceCorrelation: correlation(variant.record),
              variantRef: variant.ref,
            },
            productSource: correlation(productRecord),
          },
          operation: createVariantOperation,
        },
      ]
    : [];
  const texts = variant.row.localized.map((text, textIndex) => ({
    dependsOn: created ? [parent, variantCreateKey] : [parent],
    effectKey: `variant-facts-${textIndex}`,
    intent: {
      _tag: 'CatalogProductDependentEffect',
      parent,
      request: {
        _tag: 'SetVariantLocalizedFacts',
        payload: {
          evidenceRefs,
          expectedRevision: 0,
          facts: { ...present('description', text.description), ...present('name', text.name) },
          locale: text.locale,
          reason: SYMMY_PRODUCT_REASON,
        },
      },
      ...present('variantParent', created ? own[0] : undefined),
    },
    operation: variantFactsOperation,
  }));
  return {
    created: own,
    item:
      create.length + texts.length === 0
        ? Option.none()
        : Option.some({
            effects: [...create, ...texts],
            itemKey: `product-${index}-variant-${position}`,
            source: {
              entityKind: 'VARIANT',
              issuerId: source.issuerId,
              sourceNamespace: source.sourceNamespace,
              sourceRecordId: variant.record,
            },
            sourceOccurrenceId: variant.occurrenceId,
          }),
  };
};

const inventoryItemKey = (row: SymmyProductRow, variant: PlannedVariant, initial: boolean) => {
  const { identifier } = variant.row;
  if (identifier !== undefined && identifier.type !== 'ean') {
    return Option.some(identifier.value);
  }
  if (initial && row.identifier !== undefined && row.identifier.type !== 'ean') {
    return Option.some(row.identifier.value);
  }
  return Option.none<string>();
};

const hintBranches = (kinds: readonly (SymmyProductHintKind | 'PriceHint' | 'StockProvisioningHint')[]) =>
  kinds.map((kind) => ({ branchKey: kind, kind }));

const readinessIneligibleFor = (row: SymmyProductRow, policy: Enrollment['catalogReadiness']) =>
  row.lifecycle === 'ACTIVE' &&
  policy !== undefined &&
  (row.variants.length !== 1 ||
    row.unsupported.includes('AttributeHint') ||
    row.unsupported.includes('ClassificationHint'));

const categoryAssignmentEffects = (
  categories: SymmyProductRow['categories'],
  parent: { readonly effectKey: string; readonly itemKey: string },
) =>
  (categories ?? []).map((categoryRef, position) => ({
    dependsOn: [parent],
    effectKey: `category-assign-${position}`,
    intent: {
      _tag: 'CatalogProductDependentEffect',
      parent,
      request: { _tag: 'AddProductCategoryAssignment', payload: { categoryRef, reason: SYMMY_PRODUCT_REASON } },
    },
    operation: categoryAssignmentOperation,
  }));

/** One product: its item, the items of its variants and prices, and the unsupported groups it names. */
const buildProduct = Effect.fn('SymmyProductPlan.product')(function* buildProduct<Failure>(
  facts: ProductFacts<Failure>,
) {
  const { digest, enrollment, groups, idempotencyKey, index, row, tenantId } = facts;
  const { mappingRevision, prices, routeScope, source } = enrollment;
  const productItemKey = `product-${index}`;
  const parent = { effectKey: productCreateKey, itemKey: productItemKey };
  const categoryEffects = categoryAssignmentEffects(row.categories, parent);
  const [productOccurrence, productRecord] = yield* Effect.all(
    [
      digest(`product-occurrence\u0000${idempotencyKey}\u0000${index}`),
      recordIdOf('product', row.identifier, digest, `product-record\u0000${idempotencyKey}\u0000${index}`),
    ],
    { concurrency: 2 },
  );
  // The evidence names the source record, not the request: a product sent again under a new key is then the same
  // business intent, which the owner answers as a semantic replay instead of a conflict.
  const evidence = yield* digest(`evidence\u0000${tenantId}\u0000${productRecord}`);
  const evidenceRefs = [`symmy-product:${evidence}`] as const;
  const variants = yield* Effect.forEach(
    row.variants,
    (variant, position) => plannedVariant(facts, position, variant, productRecord),
    { concurrency: 1 },
  );
  const [initial] = variants;
  if (initial === undefined) {
    return Option.none();
  }
  const variantItems = variants.map((variant, position) =>
    buildVariantItem({ ...facts, enrollment, evidenceRefs, parent, position, productRecord, variant }),
  );
  const readinessIneligible = readinessIneligibleFor(row, enrollment.catalogReadiness);
  const updates = !readinessIneligible && (row.lifecycle === 'ACTIVE' || row.lifecycle === 'RETIRED');
  const ready = row.lifecycle === 'ACTIVE' && !readinessIneligible ? enrollment.catalogReadiness : undefined;
  const readinessSteps = ['AXES', 'CONFIRM', 'NAME', 'ACTIVATE', 'UNIT', 'UNTYPED'] as const;
  const readinessEffects =
    ready === undefined
      ? []
      : readinessSteps.map((step, position) => ({
          dependsOn: [
            parent,
            ...readinessSteps.slice(0, position).map((previous) => ({
              effectKey: `readiness-${previous.toLowerCase()}`,
              itemKey: productItemKey,
            })),
          ],
          effectKey: `readiness-${step.toLowerCase()}`,
          intent: {
            _tag: 'CatalogProductDependentEffect',
            parent,
            request: { _tag: 'CatalogReadiness', ...ready, evidenceRefs, name: row.name, step },
          },
          operation: readinessOperations[position],
        }));
  const updateEffect =
    updates && ready === undefined
      ? [
          {
            dependsOn: [productCreateKey, ...variantItems.flatMap(({ created }) => created)],
            effectKey: productUpdateKey,
            intent: {
              _tag: 'CatalogProductDependentEffect',
              parent,
              request: {
                _tag: 'UpdateProduct',
                payload: { expectedRevision: 1, reason: SYMMY_PRODUCT_REASON, targetLifecycle: row.lifecycle },
              },
            },
            operation: updateProductOperation,
          },
        ]
      : [];
  const priceDependencies = (variantPosition: number) => [
    parent,
    ...categoryEffects.map(({ effectKey }) => ({ effectKey, itemKey: productItemKey })),
    ...variantItems.flatMap(({ created }, position) => (position === variantPosition ? created : [])),
    ...(ready === undefined && updates ? [{ effectKey: productUpdateKey, itemKey: productItemKey }] : []),
    ...(ready === undefined ? [] : [{ effectKey: 'readiness-untyped', itemKey: productItemKey }]),
  ];
  const priceItems = (readinessIneligible ? Option.none<PriceContext>() : prices).pipe(
    Option.match({
      onNone: () => Effect.succeed([]),
      onSome: (context) =>
        Effect.forEach(
          variants.flatMap((variant, variantPosition) =>
            variant.row.prices.map((price, pricePosition) => ({ price, pricePosition, variant, variantPosition })),
          ),
          ({ price, pricePosition, variant, variantPosition }) =>
            resolvePrice(price, context, groups).pipe(
              Option.match({
                onNone: () => Effect.succeed(Option.none()),
                onSome: (resolved) =>
                  buildPriceItem({
                    ...facts,
                    context,
                    dependsOn: priceDependencies(variantPosition),
                    parent,
                    position: [variantPosition, pricePosition],
                    resolved,
                    variant,
                    variantParent: Option.fromNullishOr(variantItems[variantPosition]?.created[0]),
                  }).pipe(Effect.map(Option.some)),
              }),
            ),
          { concurrency: 1 },
        ),
    }),
  );
  const planned = yield* priceItems;
  const written = planned.length - planned.filter(Option.isNone).length;
  const unsupported = [
    ...new Set([
      ...row.unsupported,
      ...(readinessIneligible && variants.length > 1 ? ['ClassificationHint' as const] : []),
    ]),
    ...(written < variants.reduce((total, { row: variantRow }) => total + variantRow.prices.length, 0)
      ? ['PriceHint' as const]
      : []),
  ];
  const provisionEffects = [];
  let stockKeyMissing = false;
  if (enrollment.inventorySource !== undefined) {
    for (const [position, variant] of variants.entries()) {
      const itemKey = inventoryItemKey(row, variant, position === 0);
      if (Option.isNone(itemKey)) {
        stockKeyMissing = true;
        continue;
      }
      provisionEffects.push({
        dependsOn: [
          parent,
          ...variantItems.flatMap(({ created }, variantPosition) => (variantPosition === position ? created : [])),
        ],
        effectKey: `inventory-provision-${position}`,
        intent: {
          _tag: 'CatalogProductDependentEffect',
          parent,
          request: { _tag: 'ProvisionSourceStockItem', itemKey: itemKey.value, source: enrollment.inventorySource },
          ...present('variantParent', variantItems[position]?.created[0]),
        },
        operation: provisionStockItemOperation,
      });
    }
  }
  const productItem = {
    effects: [
      {
        effectKey: productCreateKey,
        intent: {
          _tag: 'CatalogCreateProduct',
          payload: {
            classification: { kind: 'INDEPENDENT_PRODUCT' },
            ...present('description', row.description),
            name: row.name,
            reason: SYMMY_PRODUCT_REASON,
            sourceCorrelation: {
              initialVariantRecordId: initial.record,
              issuerId: source.issuerId,
              mappingRevision,
              recordId: productRecord,
              recordNamespace: source.sourceNamespace,
              routeScope,
            },
            variantId: initial.ref.resourceId,
          },
        },
        operation: createProductOperation,
      },
      ...updateEffect,
      ...categoryEffects,
      ...readinessEffects,
      ...provisionEffects,
    ],
    itemKey: productItemKey,
    source: {
      entityKind: 'PRODUCT',
      issuerId: source.issuerId,
      sourceNamespace: source.sourceNamespace,
      sourceRecordId: productRecord,
    },
    sourceOccurrenceId: uuidFromDigest(productOccurrence),
    ...present(
      'unsupportedBranches',
      unsupported.length === 0 && !stockKeyMissing
        ? undefined
        : hintBranches([...unsupported, ...(stockKeyMissing ? ['StockProvisioningHint' as const] : [])]),
    ),
  };
  return Option.some([
    productItem,
    ...variantItems.flatMap(({ item }) => (Option.isSome(item) ? [item.value] : [])),
    ...planned.flatMap((item) => (Option.isSome(item) ? [item.value] : [])),
  ]);
});

export interface SymmyProductPlanInput<Failure> {
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  /** The selling legal entity of every price. It comes from the route scope, never from the body. */
  readonly legalEntityId: string | undefined;
  /** The price list each price group code of the rows names, read for the route when the request arrived. */
  readonly priceGroups: SymmyProductPriceGroupFacts;
  /** The instant of the first admission. A replay never reaches this builder, it reads the saved plan. */
  readonly receivedAt: DateTime.Utc;
  readonly route: { readonly mappingVersion: string; readonly routeId: string };
  readonly rows: SymmyProductRows;
  readonly template: SymmyFixtureExecutionPlan;
  readonly tenantId: string;
}

/**
 * Maps the public products to one internal plan. A product is an item with its create (and its lifecycle update),
 * each variant that has effects of its own is an item (a source record belongs to one item) and so is each
 * price. Everything that needs the Product reference the same job creates waits for that create and takes the
 * reference from its receipt. Every field no intent can write is an unsupported branch of the product item. A
 * route that does not enroll an operation the rows need yields no plan at all.
 */
export const buildSymmyProductPlan = Effect.fn('SymmyProductPlan.build')(function* buildSymmyProductPlan<Failure>(
  input: SymmyProductPlanInput<Failure>,
): Effect.fn.Return<Option.Option<SymmyFixtureExecutionPlan>, Failure> {
  const { digest, idempotencyKey, legalEntityId, priceGroups, receivedAt, route, rows, template, tenantId } = input;
  if (rows.some(({ categories }) => categories?.some((ref) => ref.tenantId !== tenantId) === true)) {
    return Option.none();
  }
  const source = catalogSource(rows, template);
  const prices = priceContextOf(template, legalEntityId);
  const priced = rows.some(({ variants }) => variants.some((variant) => variant.prices.length > 0));
  if (Option.isNone(source) || (priced && Option.isNone(prices))) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  if (
    template.inventorySource !== undefined &&
    (template.inventorySource.policyRef.tenantId !== tenantId ||
      template.inventoryBackendId !== template.inventorySource.issuer.backendId ||
      Option.isNone(enrolledItem(template, 'PRODUCT', provisionStockItemOperation)))
  ) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  if (
    template.catalogReadiness !== undefined &&
    (template.catalogReadiness.unitRef.tenantId !== tenantId ||
      (rows.some(({ lifecycle }) => lifecycle === 'ACTIVE') &&
        readinessOperations.some((operation) => Option.isNone(enrolledItem(template, 'PRODUCT', operation)))))
  ) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  const enrollment = {
    catalogReadiness: template.catalogReadiness,
    inventorySource: template.inventorySource,
    mappingRevision: template.sourceMappingVersion ?? route.mappingVersion,
    prices,
    routeScope: template.sourceRouteId ?? route.routeId,
    source: source.value,
  };
  const products = yield* Effect.forEach(
    rows,
    (row, index) =>
      buildProduct({
        digest,
        enrollment,
        groups: priceGroups,
        idempotencyKey,
        importedAt: receivedAt,
        index,
        row,
        tenantId,
      }),
    { concurrency: 1 },
  );
  return Option.flatMap(Option.all(products), (items) =>
    Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items: items.flat() }),
  );
});
