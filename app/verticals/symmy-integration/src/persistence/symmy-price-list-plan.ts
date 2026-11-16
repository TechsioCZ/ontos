import { Array as EffectArray, DateTime, Effect, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import {
  SYMMY_PRICE_GROUP_COMPATIBILITY_CONTRACTS,
  SYMMY_PRICE_LIST_REASON,
  SYMMY_PRICE_REASON,
} from '../../shared/domain/symmy-price-list-batch.ts';
import type {
  SymmyPriceListPrice,
  SymmyPriceListRows,
  SymmyRequestTenant,
} from '../../shared/domain/symmy-price-list-batch.ts';
import { uuidFromDigest } from './derived-identity.ts';

const groupOperation = {
  entrypointKey: 'pricing.price-group-catalog.create-price-group',
  moduleId: 'pricing.price-group-catalog',
  schemaVersion: '1',
} as const;
export const priceOperation = {
  entrypointKey: 'commerce.pricing.define-price',
  moduleId: 'commerce.pricing',
  schemaVersion: '2',
} as const;
const groupEffectKey = 'group-create';
const priceEffectKey = 'price-define';

/** Every instant the owner receives has the canonical millisecond form, whether or not Symmy sent it. */
export const instant = (value: string): string => DateTime.formatIso(DateTime.makeUnsafe(value));

type TemplateItem = SymmyFixtureExecutionPlan['items'][number];
/** The template item that enrolls this kind of record together with the exact owner operation. */
export const enrolledItem = (
  template: SymmyFixtureExecutionPlan,
  entityKind: TemplateItem['source']['entityKind'],
  operation: { readonly entrypointKey: string; readonly moduleId: string; readonly schemaVersion: string },
): Option.Option<TemplateItem> =>
  Option.fromNullishOr(
    template.items.find(
      ({ effects, source }) =>
        source.entityKind === entityKind &&
        effects.some(
          ({ operation: enrolled }) =>
            enrolled.moduleId === operation.moduleId &&
            enrolled.entrypointKey === operation.entrypointKey &&
            enrolled.schemaVersion === operation.schemaVersion,
        ),
    ),
  );

export type Digest<Failure> = (value: string) => Effect.Effect<string, Failure>;
type TemplateSource = Pick<TemplateItem['source'], 'issuerId' | 'sourceNamespace'>;

/** What every price of a request shares: the route enrollment, the selling legal entity and the first admission. */
export interface PriceContext {
  readonly legalEntityId: string;
  readonly priceSource: NonNullable<SymmyFixtureExecutionPlan['priceSource']>;
  readonly source: TemplateSource;
  readonly sourceSystem: NonNullable<SymmyFixtureExecutionPlan['pricingSourceSystem']>;
}

/** Every ref a price names must belong to the tenant of the request. */
export const namesOnlyTenant = (price: SymmyPriceListPrice, tenantId: SymmyRequestTenant): boolean =>
  [price.productRef, price.variantRef, price.unitBasis.unitRef].every((ref) => ref.tenantId === tenantId);

/** The same price with every ref moved into the tenant of the request, so the plan stays one tenant's plan. */
export const inRequestTenant = (price: SymmyPriceListPrice, tenantId: SymmyRequestTenant): SymmyPriceListPrice => ({
  ...price,
  productRef: { ...price.productRef, tenantId },
  unitBasis: { ...price.unitBasis, unitRef: { ...price.unitBasis.unitRef, tenantId } },
  variantRef: { ...price.variantRef, tenantId },
});

/**
 * The item of a price that names another tenant. It keeps its place in the plan and names no original target, which
 * the adapter refuses before any owner call, so the item ends not accepted with nothing written and its siblings run.
 * An original target in another tenant would instead make the pin refuse the whole request.
 */
export const refusedItem = <Item extends { readonly effects: readonly object[] }>(item: Item) => ({
  ...item,
  effects: item.effects.map((effect) =>
    Object.fromEntries(Object.entries(effect).filter(([key]) => key !== 'originalTarget')),
  ),
});

interface PriceFacts<Failure> {
  readonly context: PriceContext;
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  readonly importedAt: DateTime.Utc;
  readonly index: readonly [list: number, price: number];
  readonly listCode: string;
  readonly price: SymmyPriceListPrice;
}

/** The stable identity of a price inside its list, so a replay of the same price keeps one source record. */
const priceIdentity = ({ listCode, price }: Pick<PriceFacts<never>, 'listCode' | 'price'>): string =>
  [
    listCode,
    price.variantRef.resourceId,
    price.currencyCode,
    price.commercialScope.channelId,
    price.commercialScope.marketId,
    price.unitBasis.unitRef.resourceId,
    price.unitBasis.quantity,
  ]
    .map((part) => `${part.length}:${part}`)
    .join('');

const buildPrice = Effect.fn('SymmyPriceListPlan.price')(function* buildPrice<Failure>(facts: PriceFacts<Failure>) {
  const { context, digest, idempotencyKey, importedAt, index, price } = facts;
  const { legalEntityId, priceSource, source, sourceSystem } = context;
  const [list, position] = index;
  const [priceId, occurrence, record] = yield* Effect.all(
    [
      digest(`price\u0000${idempotencyKey}\u0000${list}\u0000${position}`),
      digest(`price-occurrence\u0000${idempotencyKey}\u0000${list}\u0000${position}`),
      digest(`price-record\u0000${priceIdentity(facts)}`),
    ],
    { concurrency: 3 },
  );
  const occurrenceId = uuidFromDigest(occurrence);
  const recordId = `symmy-price:${record}`;
  const effectiveFrom = instant(price.effectiveFrom);
  const monetaryAmount = { amount: price.amount, currencyCode: price.currencyCode };
  const priceRef = {
    moduleId: priceOperation.moduleId,
    resourceId: uuidFromDigest(priceId),
    resourceType: 'commerce.pricing.price',
    tenantId: price.productRef.tenantId,
  };
  const parent = { effectKey: groupEffectKey, itemKey: `price-list-${list}` };
  return {
    effects: [
      {
        dependsOn: [parent],
        effectKey: priceEffectKey,
        intent: {
          _tag: 'PriceDefineFromGroupEffect',
          fromPriceGroupEffect: parent,
          payload: {
            effectiveFrom,
            identityKey: {
              catalogSelection: { productRef: price.productRef, variantRef: price.variantRef },
              commercialScope: { ...price.commercialScope, sellingLegalEntityId: legalEntityId },
              currencyCode: price.currencyCode,
              priceGroupSelector: { kind: 'PRICE_GROUP' },
              unitBasis: price.unitBasis,
            },
            monetaryAmount,
            priceRef,
            reason: SYMMY_PRICE_REASON,
            sourceAssertion: {
              lineage: { kind: 'INITIAL' },
              mapping: priceSource.mapping,
              originalAssertion: { monetaryAmount, monetaryBoundary: 'PRE_TAX', unitBasis: price.unitBasis },
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
        operation: priceOperation,
        originalTarget: priceRef,
      },
    ],
    itemKey: `price-list-${list}-price-${position}`,
    source: {
      entityKind: 'PRICE',
      issuerId: source.issuerId,
      sourceNamespace: source.sourceNamespace,
      sourceRecordId: recordId,
    },
    sourceOccurrenceId: occurrenceId,
  };
});

/** The route facts of the group source correlation: the issuer and namespace it enrolled and its route identity. */
interface GroupContext {
  readonly mappingVersion: string;
  readonly source: TemplateSource;
  readonly sourceRouteId: string;
}

interface ListFacts<Failure> {
  readonly digest: Digest<Failure>;
  readonly group: GroupContext;
  readonly idempotencyKey: string;
  readonly importedAt: DateTime.Utc;
  readonly index: number;
  readonly prices: Option.Option<PriceContext>;
  readonly row: SymmyPriceListRows[number];
  readonly tenantId: SymmyRequestTenant;
}

/** One list item and the items of its prices. A list waits for no other list: each fences on the head it meets. */
const buildList = Effect.fn('SymmyPriceListPlan.list')(function* buildList<Failure>(facts: ListFacts<Failure>) {
  const { digest, group, idempotencyKey, importedAt, index, prices, row, tenantId } = facts;
  const occurrence = yield* digest(`price-list-occurrence\u0000${idempotencyKey}\u0000${index}`);
  const priceItems = Option.isNone(prices)
    ? []
    : yield* Effect.forEach(
        row.prices ?? [],
        (price, position) => {
          const own = namesOnlyTenant(price, tenantId);
          return buildPrice({
            context: prices.value,
            digest,
            idempotencyKey,
            importedAt,
            index: [index, position],
            listCode: row.code,
            price: own ? price : inRequestTenant(price, tenantId),
          }).pipe(Effect.map((item) => (own ? item : refusedItem(item))));
        },
        { concurrency: 1 },
      );
  const effect = {
    effectKey: groupEffectKey,
    intent: {
      _tag: 'PriceGroupCreateAtCatalogHead',
      payload: {
        businessCode: row.businessCode,
        classificationPurpose: row.purpose,
        compatibilityContracts: SYMMY_PRICE_GROUP_COMPATIBILITY_CONTRACTS,
        description: row.description,
        displayName: row.name,
        effectiveFrom: instant(row.effectiveFrom),
        effectiveTo: null,
        reason: SYMMY_PRICE_LIST_REASON,
        sourceCorrelation: {
          issuer: group.source.issuerId,
          mappingVersion: group.mappingVersion,
          namespace: group.source.sourceNamespace,
          recordKey: row.code,
          routeId: group.sourceRouteId,
        },
      },
    },
    operation: groupOperation,
  };
  const listItem = {
    effects: [effect],
    itemKey: `price-list-${index}`,
    source: {
      entityKind: 'PRICE_GROUP',
      issuerId: group.source.issuerId,
      sourceNamespace: group.source.sourceNamespace,
      sourceRecordId: row.code,
    },
    sourceOccurrenceId: uuidFromDigest(occurrence),
  };
  return [listItem, ...priceItems];
});

export interface SymmyPriceListPlanInput<Failure> {
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  /** The selling legal entity of every price. It comes from the route scope, never from the body. */
  readonly legalEntityId: string | undefined;
  /** The instant of the first admission. A replay never reaches this builder, it reads the saved plan. */
  readonly receivedAt: DateTime.Utc;
  readonly route: { readonly mappingVersion: string; readonly routeId: string };
  readonly rows: SymmyPriceListRows;
  readonly template: SymmyFixtureExecutionPlan;
  /** The tenant of the route scope. A price that names another tenant ends not accepted for its item. */
  readonly tenantId: SymmyRequestTenant;
}

export const priceContextOf = (
  template: SymmyFixtureExecutionPlan,
  legalEntityId: string | undefined,
  operation: Parameters<typeof enrolledItem>[2] = priceOperation,
): Option.Option<PriceContext> => {
  const { priceSource, pricingSourceSystem } = template;
  const priceItem = enrolledItem(template, 'PRICE', operation);
  return Option.isSome(priceItem) &&
    legalEntityId !== undefined &&
    priceSource !== undefined &&
    pricingSourceSystem !== undefined
    ? Option.some({ legalEntityId, priceSource, source: priceItem.value.source, sourceSystem: pricingSourceSystem })
    : Option.none();
};

/**
 * Maps the public price lists to one internal plan: a Price Group create per list and a Price define per
 * price, named by the list it belongs to. A create carries no fence: the adapter reads the tenant catalog head
 * right before the owner call, so lists neither wait for nor depend on each other. A route that does not enroll
 * the owner operations, the price source or the selling legal entity yields no plan at all.
 */
export const buildSymmyPriceListPlan = Effect.fn('SymmyPriceListPlan.build')(function* buildSymmyPriceListPlan<Failure>(
  input: SymmyPriceListPlanInput<Failure>,
) {
  const { digest, idempotencyKey, legalEntityId, receivedAt, route, rows, template, tenantId } = input;
  const groupItem = enrolledItem(template, 'PRICE_GROUP', groupOperation);
  const prices = priceContextOf(template, legalEntityId);
  if (Option.isNone(groupItem) || (rows.some((row) => (row.prices?.length ?? 0) > 0) && Option.isNone(prices))) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  const group = {
    mappingVersion: template.sourceMappingVersion ?? route.mappingVersion,
    source: groupItem.value.source,
    sourceRouteId: template.sourceRouteId ?? route.routeId,
  };
  const lists = yield* Effect.forEach(
    rows,
    (row, index) => buildList({ digest, group, idempotencyKey, importedAt: receivedAt, index, prices, row, tenantId }),
    { concurrency: 1 },
  );
  return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items: EffectArray.flatten(lists) });
});
