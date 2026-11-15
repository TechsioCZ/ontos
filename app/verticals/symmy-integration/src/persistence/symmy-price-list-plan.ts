import { Array as EffectArray, DateTime, Effect, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import {
  SYMMY_PRICE_GROUP_COMPATIBILITY_CONTRACTS,
  SYMMY_PRICE_LIST_REASON,
  SYMMY_PRICE_REASON,
} from '../../shared/domain/symmy-price-list-batch.ts';
import type { SymmyPriceListPrice, SymmyPriceListRows } from '../../shared/domain/symmy-price-list-batch.ts';
import { uuidFromDigest } from './derived-identity.ts';

const groupOperation = {
  entrypointKey: 'pricing.price-group-catalog.create-price-group',
  moduleId: 'pricing.price-group-catalog',
  schemaVersion: '1',
} as const;
const priceOperation = {
  entrypointKey: 'commerce.pricing.define-price',
  moduleId: 'commerce.pricing',
  schemaVersion: '2',
} as const;
const groupEffectKey = 'group-create';
const priceEffectKey = 'price-define';

/** Every instant the owner receives has the canonical millisecond form, whether or not Symmy sent it. */
const instant = (value: string): string => DateTime.formatIso(DateTime.makeUnsafe(value));

type TemplateItem = SymmyFixtureExecutionPlan['items'][number];
/** The template item that enrolls this kind of record together with the exact owner operation. */
const enrolledItem = (
  template: SymmyFixtureExecutionPlan,
  entityKind: TemplateItem['source']['entityKind'],
  operation: typeof groupOperation | typeof priceOperation,
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

type Digest<Failure> = (value: string) => Effect.Effect<string, Failure>;
type TemplateSource = Pick<TemplateItem['source'], 'issuerId' | 'sourceNamespace'>;

/** What every price of a request shares: the route enrollment, the selling legal entity and the first admission. */
interface PriceContext {
  readonly legalEntityId: string;
  readonly priceSource: NonNullable<SymmyFixtureExecutionPlan['priceSource']>;
  readonly source: TemplateSource;
  readonly sourceSystem: NonNullable<SymmyFixtureExecutionPlan['pricingSourceSystem']>;
}

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
  readonly catalogHead: number;
  readonly digest: Digest<Failure>;
  readonly group: GroupContext;
  readonly idempotencyKey: string;
  readonly importedAt: DateTime.Utc;
  readonly index: number;
  readonly prices: Option.Option<PriceContext>;
  readonly row: SymmyPriceListRows[number];
}

/** One list item and the items of its prices. List i fences on the head plus i and waits for list i - 1. */
const buildList = Effect.fn('SymmyPriceListPlan.list')(function* buildList<Failure>(facts: ListFacts<Failure>) {
  const { catalogHead, digest, group, idempotencyKey, importedAt, index, prices, row } = facts;
  const occurrence = yield* digest(`price-list-occurrence\u0000${idempotencyKey}\u0000${index}`);
  const priceItems = Option.isNone(prices)
    ? []
    : yield* Effect.forEach(
        row.prices ?? [],
        (price, position) =>
          buildPrice({
            context: prices.value,
            digest,
            idempotencyKey,
            importedAt,
            index: [index, position],
            listCode: row.code,
            price,
          }),
        { concurrency: 1 },
      );
  const effect = {
    effectKey: groupEffectKey,
    intent: {
      _tag: 'PriceGroupCreate',
      payload: {
        businessCode: row.businessCode,
        classificationPurpose: row.purpose,
        compatibilityContracts: SYMMY_PRICE_GROUP_COMPATIBILITY_CONTRACTS,
        description: row.description,
        displayName: row.name,
        effectiveFrom: instant(row.effectiveFrom),
        effectiveTo: null,
        expectedCatalogRevision: catalogHead + index,
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
  const dependsOn = index === 0 ? [] : [{ effectKey: groupEffectKey, itemKey: `price-list-${index - 1}` }];
  const listItem = {
    effects: [dependsOn.length === 0 ? effect : { ...effect, dependsOn }],
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
  /** The tenant ledger head. The first created list fences on it, each later list on the head plus its position. */
  readonly catalogHead: number;
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  /** The selling legal entity of every price. It comes from the route scope, never from the body. */
  readonly legalEntityId: string | undefined;
  /** The instant of the first admission. A replay never reaches this builder, it reads the saved plan. */
  readonly receivedAt: DateTime.Utc;
  readonly route: { readonly mappingVersion: string; readonly routeId: string };
  readonly rows: SymmyPriceListRows;
  readonly template: SymmyFixtureExecutionPlan;
}

const priceContextOf = (
  template: SymmyFixtureExecutionPlan,
  legalEntityId: string | undefined,
): Option.Option<PriceContext> => {
  const { priceSource, pricingSourceSystem } = template;
  const priceItem = enrolledItem(template, 'PRICE', priceOperation);
  return Option.isSome(priceItem) &&
    legalEntityId !== undefined &&
    priceSource !== undefined &&
    pricingSourceSystem !== undefined
    ? Option.some({ legalEntityId, priceSource, source: priceItem.value.source, sourceSystem: pricingSourceSystem })
    : Option.none();
};

/**
 * Maps the public price lists to one internal plan: a Price Group create per list and a Price define per
 * price, named by the list it belongs to. The lists are chained, because each create moves the tenant
 * catalog head by one and the next list fences on the value its predecessor leaves. A route that does not
 * enroll the owner operations, the price source or the selling legal entity yields no plan at all.
 */
export const buildSymmyPriceListPlan = Effect.fn('SymmyPriceListPlan.build')(function* buildSymmyPriceListPlan<Failure>(
  input: SymmyPriceListPlanInput<Failure>,
) {
  const { catalogHead, digest, idempotencyKey, legalEntityId, receivedAt, route, rows, template } = input;
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
    (row, index) =>
      buildList({ catalogHead, digest, group, idempotencyKey, importedAt: receivedAt, index, prices, row }),
    { concurrency: 1 },
  );
  return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items: EffectArray.flatten(lists) });
});
