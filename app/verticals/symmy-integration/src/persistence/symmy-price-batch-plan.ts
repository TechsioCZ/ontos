import { DateTime, Effect, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SYMMY_PRICE_BATCH_REASON } from '../../shared/domain/symmy-price-batch.ts';
import type {
  SymmyPriceBatch,
  SymmyPriceBatchRevise,
  SymmyPriceReviseFacts,
} from '../../shared/domain/symmy-price-batch.ts';
import type { SymmyPriceListPrice } from '../../shared/domain/symmy-price-list-batch.ts';
import { uuidFromDigest } from './derived-identity.ts';
import { instant, priceContextOf, priceOperation } from './symmy-price-list-plan.ts';
import type { Digest, PriceContext } from './symmy-price-list-plan.ts';

const reviseOperation = {
  entrypointKey: 'commerce.pricing.revise-price',
  moduleId: 'commerce.pricing',
  schemaVersion: '2',
} as const;

type PriceGroupRef = SymmyPriceBatch['priceGroupRef'];

const trimTrailingZeros = (quantity: string) =>
  quantity.includes('.') ? quantity.replace(/0+$/u, '').replace(/\.$/u, '') : quantity;

/** The stable identity of a new price in its list, so a replay of the same price keeps one source record. */
const priceIdentity = (priceGroupRef: PriceGroupRef, price: SymmyPriceListPrice): string =>
  [
    priceGroupRef.resourceId,
    price.variantRef.resourceId,
    price.currencyCode,
    price.commercialScope.channelId,
    price.commercialScope.marketId,
    price.unitBasis.unitRef.resourceId,
    trimTrailingZeros(price.unitBasis.quantity),
  ]
    .map((part) => `${part.length}:${part}`)
    .join('');

interface ItemFacts<Failure> {
  readonly context: PriceContext;
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  readonly importedAt: DateTime.Utc;
  readonly index: number;
  readonly priceGroupRef: PriceGroupRef;
}

/** The ids every item derives from the request: the same key and position always give the same ones. */
const itemIdentity = Effect.fn('SymmyPriceBatchPlan.identity')(function* itemIdentity<Failure>(
  facts: Pick<ItemFacts<Failure>, 'digest' | 'idempotencyKey' | 'index'>,
) {
  const { digest, idempotencyKey, index } = facts;
  const [price, occurrence] = yield* Effect.all(
    [
      digest(`price-batch-price\u0000${idempotencyKey}\u0000${index}`),
      digest(`price-batch-occurrence\u0000${idempotencyKey}\u0000${index}`),
    ],
    { concurrency: 2 },
  );
  return { occurrenceId: uuidFromDigest(occurrence), priceId: uuidFromDigest(price) };
});

const buildDefine = Effect.fn('SymmyPriceBatchPlan.define')(function* buildDefine<Failure>(
  facts: ItemFacts<Failure> & { readonly price: SymmyPriceListPrice },
) {
  const { context, digest, importedAt, index, price, priceGroupRef } = facts;
  const { legalEntityId, priceSource, source, sourceSystem } = context;
  const [{ occurrenceId, priceId }, record] = yield* Effect.all(
    [itemIdentity(facts), digest(`price-batch-record\u0000${priceIdentity(priceGroupRef, price)}`)],
    { concurrency: 2 },
  );
  const recordId = `symmy-price:${record}`;
  const effectiveFrom = instant(price.effectiveFrom);
  const monetaryAmount = { amount: price.amount, currencyCode: price.currencyCode };
  const priceRef = {
    moduleId: priceOperation.moduleId,
    resourceId: priceId,
    resourceType: 'commerce.pricing.price',
    tenantId: price.productRef.tenantId,
  };
  return {
    effects: [
      {
        effectKey: 'price-define',
        intent: {
          _tag: 'PriceDefine',
          payload: {
            effectiveFrom,
            identityKey: {
              catalogSelection: { productRef: price.productRef, variantRef: price.variantRef },
              commercialScope: { ...price.commercialScope, sellingLegalEntityId: legalEntityId },
              currencyCode: price.currencyCode,
              priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
              unitBasis: price.unitBasis,
            },
            monetaryAmount,
            priceRef,
            reason: SYMMY_PRICE_BATCH_REASON,
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
    itemKey: `price-${index}`,
    source: {
      entityKind: 'PRICE',
      issuerId: source.issuerId,
      sourceNamespace: source.sourceNamespace,
      sourceRecordId: recordId,
    },
    sourceOccurrenceId: occurrenceId,
  };
});

/**
 * What a REVISE item carries when the owner returned nothing about its price: a price that does not exist or
 * has no source record. The values are structural only. The adapter finds no such price in the named list, or
 * the owner finds no matching predecessor, so the item ends not accepted and nothing is written.
 */
const unknownPriceFacts = (priceRef: SymmyPriceBatchRevise['priceRef'], placeholderId: string, importedAt: string) => ({
  currentSourceAssertionId: placeholderId,
  effectivePeriod: { effectiveFrom: importedAt, effectiveTo: null },
  scheduleRevision: 1,
  sourceRecordRef: `symmy-price-unknown:${priceRef.resourceId}`,
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: priceRef.resourceId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId: priceRef.tenantId,
    },
  },
});

const buildRevise = Effect.fn('SymmyPriceBatchPlan.revise')(function* buildRevise<Failure>(
  facts: ItemFacts<Failure> & {
    readonly current: Option.Option<SymmyPriceReviseFacts>;
    readonly price: SymmyPriceBatchRevise;
  },
) {
  const { context, current, importedAt, index, price, priceGroupRef } = facts;
  const { priceSource, source, sourceSystem } = context;
  const { occurrenceId, priceId } = yield* itemIdentity(facts);
  const imported = DateTime.formatIso(importedAt);
  const known = Option.getOrElse(current, () => unknownPriceFacts(price.priceRef, priceId, imported));
  const monetaryAmount = { amount: price.amount, currencyCode: price.currencyCode };
  return {
    effects: [
      {
        effectKey: 'price-revise',
        intent: {
          _tag: 'PriceRevise',
          payload: {
            expectedCurrent: {
              effectivePeriod: known.effectivePeriod,
              priceRef: price.priceRef,
              revision: price.expectedRevision.revision,
              revisionId: price.expectedRevision.revisionId,
              scheduleRevision: known.scheduleRevision,
            },
            intent: 'VALUE_ONLY_CURRENT',
            monetaryAmount,
            priceRef: price.priceRef,
            reason: SYMMY_PRICE_BATCH_REASON,
            sourceAssertion: {
              lineage: {
                kind: 'SUPERSESSION',
                reason: SYMMY_PRICE_BATCH_REASON,
                supersededSourceAssertionId: known.currentSourceAssertionId,
              },
              mapping: priceSource.mapping,
              originalAssertion: { monetaryAmount, monetaryBoundary: 'PRE_TAX', unitBasis: known.unitBasis },
              sourceAssertionId: occurrenceId,
              sourceAuthority: priceSource.sourceAuthority,
              sourceRecord: {
                sourceChangeCorrelation: occurrenceId,
                sourceRecordRef: known.sourceRecordRef,
                sourceRecordVersion: occurrenceId,
                sourceSystem,
              },
              timing: { importedAt: imported, ownerBusinessEffectiveAt: imported, sourceEffectiveAt: imported },
            },
          },
          priceGroupRef,
        },
        operation: reviseOperation,
        originalTarget: price.priceRef,
      },
    ],
    itemKey: `price-${index}`,
    source: {
      entityKind: 'PRICE',
      issuerId: source.issuerId,
      sourceNamespace: source.sourceNamespace,
      sourceRecordId: known.sourceRecordRef,
    },
    sourceOccurrenceId: occurrenceId,
  };
});

export interface SymmyPriceBatchPlanInput<Failure> {
  readonly batch: SymmyPriceBatch;
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  /** The selling legal entity of every price. It comes from the route scope, never from the body. */
  readonly legalEntityId: string | undefined;
  /** The instant of the first admission. A replay never reaches this builder, it reads the saved plan. */
  readonly receivedAt: DateTime.Utc;
  /** What the owner held about each REVISE price when the request arrived. A price it did not answer for is absent. */
  readonly reviseFacts: readonly SymmyPriceReviseFacts[];
  readonly template: SymmyFixtureExecutionPlan;
}

/**
 * Maps the public price batch to one internal plan: one item per price, a Price define for a new one and a
 * value-only Price revise for an existing one, every item naming the price list of the request. A route that
 * does not enroll the owner operation of one of its items, the price source or the selling legal entity
 * yields no plan at all.
 */
export const buildSymmyPriceBatchPlan = Effect.fn('SymmyPriceBatchPlan.build')(function* buildSymmyPriceBatchPlan<
  Failure,
>(input: SymmyPriceBatchPlanInput<Failure>): Effect.fn.Return<Option.Option<SymmyFixtureExecutionPlan>, Failure> {
  const { batch, digest, idempotencyKey, legalEntityId, receivedAt, reviseFacts, template } = input;
  const { priceGroupRef, prices } = batch;
  const defineContext = priceContextOf(template, legalEntityId, priceOperation);
  const reviseContext = priceContextOf(template, legalEntityId, reviseOperation);
  const items = yield* Effect.forEach(
    prices,
    (price, index) => {
      const context = price.operation === 'DEFINE' ? defineContext : reviseContext;
      if (Option.isNone(context)) {
        return Effect.succeed(Option.none());
      }
      const facts = { context: context.value, digest, idempotencyKey, importedAt: receivedAt, index, priceGroupRef };
      const item: Effect.Effect<unknown, Failure> =
        price.operation === 'DEFINE'
          ? buildDefine({ ...facts, price })
          : buildRevise({
              ...facts,
              current: Option.fromNullishOr(
                reviseFacts.find(({ priceRef }) => priceRef.resourceId === price.priceRef.resourceId),
              ),
              price,
            });
      return item.pipe(Effect.map(Option.some));
    },
    { concurrency: 1 },
  );
  return Option.flatMap(Option.all(items), (planned) =>
    Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items: planned }),
  );
});
