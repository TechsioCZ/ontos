import { createHash } from 'node:crypto';

import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AdmitSymmyJobPayloadSchema } from '../../shared/domain/symmy-job-admission.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyPriceBatchSchema, SymmyPriceReviseFactsSchema } from '../../shared/domain/symmy-price-batch.ts';
import { SymmyRequestTenantSchema } from '../../shared/domain/symmy-price-list-batch.ts';
import { buildSymmyPriceBatchPlan } from '../../src/persistence/symmy-price-batch-plan.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const otherTenantId = '77777777-7777-4777-8777-777777777777';
const ref = (moduleId: string, resourceType: string, suffix: string) => ({
  moduleId,
  resourceId: `33333333-3333-4333-8333-${suffix.padStart(12, '0')}`,
  resourceType,
  tenantId,
});
const priceGroupRef = ref('pricing.price-group-catalog', 'pricing.price-group-catalog.price-group', '9');
const productRef = ref('commerce.catalog', 'commerce.catalog.product', '1');
const variantRef = ref('commerce.catalog', 'commerce.catalog.variant', '2');
const unitRef = ref('commerce.catalog', 'commerce.catalog.product-unit', '3');
const existingPriceRef = ref('commerce.pricing', 'commerce.pricing.price', '40');
const operation = (moduleId: string, entrypointKey: string, schemaVersion: string) => ({
  entrypointKey,
  moduleId,
  schemaVersion,
});
const priceDefine = operation('commerce.pricing', 'commerce.pricing.define-price', '2');
const priceRevise = operation('commerce.pricing', 'commerce.pricing.revise-price', '2');
const enroll = (...operations: ReturnType<typeof operation>[]) => ({
  effects: operations.map((enrolled, index) => ({ effectKey: `authority-${index}`, operation: enrolled })),
  itemKey: 'price-enrollment',
  source: {
    entityKind: 'PRICE',
    issuerId: 'route-issuer',
    sourceNamespace: 'route-namespace',
    sourceRecordId: 'price-enrollment',
  },
});
const templateInput = {
  items: [enroll(priceDefine, priceRevise)],
  priceSource: {
    mapping: { mappingContractRef: 'SYMMY_PRICE_MAPPING', mappingContractVersion: 'mapping-v1' },
    sourceAuthority: { sourceAuthorityRef: 'SYMMY_PRICE_AUTHORITY', sourceAuthorityVersion: '1' },
  },
  pricingSourceSystem: { ownerModuleId: 'external.symmy', sourceSystemRef: 'SYMMY_PRICES' },
  sourceMappingVersion: 'mapping-v1',
  sourceRouteId: '66666666-6666-4666-8666-666666666666',
};
const decodeTemplate = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema);
const template = decodeTemplate(templateInput);
const define = (suffix: string, channelId = 'B2B') => ({
  amount: '25.50',
  commercialScope: { channelId, marketId: 'cz-market' },
  currencyCode: 'CZK',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  operation: 'DEFINE',
  productRef,
  unitBasis: { quantity: '1', unitRef },
  variantRef: { ...variantRef, resourceId: `33333333-3333-4333-8333-${suffix.padStart(12, '0')}` },
});
const revise = (amount = '30') => ({
  amount,
  currencyCode: 'CZK',
  expectedRevision: { revision: 1, revisionId: '44444444-4444-4444-8444-444444444444' },
  operation: 'REVISE',
  priceRef: existingPriceRef,
});
const batchOf = (...prices: readonly unknown[]) =>
  Schema.decodeUnknownSync(SymmyPriceBatchSchema)({ priceGroupRef, prices });
const factsOf = () =>
  Schema.decodeUnknownSync(SymmyPriceReviseFactsSchema)({
    currentSourceAssertionId: '55555555-5555-4555-8555-555555555555',
    effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
    priceRef: existingPriceRef,
    scheduleRevision: 3,
    sourceRecordRef: 'symmy-price:existing-record',
    unitBasis: { quantity: '1', unitRef },
  });
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
const build = (
  batch: ReturnType<typeof batchOf>,
  overrides: {
    readonly idempotencyKey?: string;
    readonly reviseFacts?: readonly ReturnType<typeof factsOf>[];
    readonly template?: SymmyFixtureExecutionPlan;
    readonly tenantId?: string;
    readonly withoutLegalEntity?: boolean;
  } = {},
) =>
  buildSymmyPriceBatchPlan({
    batch,
    digest,
    idempotencyKey: overrides.idempotencyKey ?? 'price-key-1',
    legalEntityId: overrides.withoutLegalEntity === true ? undefined : legalEntityId,
    receivedAt: DateTime.makeUnsafe('2026-01-01T12:00:00.000Z'),
    reviseFacts: overrides.reviseFacts ?? [factsOf()],
    template: overrides.template ?? template,
    tenantId: Schema.decodeUnknownSync(SymmyRequestTenantSchema)(overrides.tenantId ?? tenantId),
  });
type Effect_ = SymmyFixtureExecutionPlan['items'][number]['effects'][number];
const defineOf = (effect: Effect_ | undefined) =>
  Match.value(effect?.intent).pipe(
    Match.tag('PriceDefine', (intent) => intent),
    Match.orElse(() => null),
  );
const reviseOf = (effect: Effect_ | undefined) =>
  Match.value(effect?.intent).pipe(
    Match.tag('PriceRevise', (intent) => intent),
    Match.orElse(() => null),
  );

describe('Symmy price batch plan from the public body', () => {
  it.effect('maps a DEFINE to a Price define that names the list of the request and the route legal entity', () =>
    Effect.gen(function* maps() {
      const plan = Option.getOrThrow(yield* build(batchOf(define('7'))));
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual(['price-0']);
      const [item] = plan.items;
      expect(item?.source).toMatchObject({
        entityKind: 'PRICE',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-namespace',
      });
      const [effect] = item?.effects ?? [];
      expect(effect?.operation).toEqual(priceDefine);
      expect(effect?.dependsOn).toBeUndefined();
      expect(defineOf(effect)).toMatchObject({
        payload: {
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          identityKey: {
            catalogSelection: { productRef, variantRef: define('7').variantRef },
            commercialScope: { channelId: 'B2B', marketId: 'cz-market', sellingLegalEntityId: legalEntityId },
            currencyCode: 'CZK',
            priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
            unitBasis: { quantity: '1', unitRef },
          },
          monetaryAmount: { amount: '25.50', currencyCode: 'CZK' },
          reason: 'Symmy price import',
          sourceAssertion: {
            lineage: { kind: 'INITIAL' },
            mapping: templateInput.priceSource.mapping,
            originalAssertion: { monetaryBoundary: 'PRE_TAX' },
            sourceAuthority: templateInput.priceSource.sourceAuthority,
            sourceRecord: { sourceRecordVersion: '1', sourceSystem: templateInput.pricingSourceSystem },
            timing: {
              importedAt: '2026-01-01T12:00:00.000Z',
              ownerBusinessEffectiveAt: '2026-01-01T00:00:00.000Z',
              sourceEffectiveAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      });
      expect(effect?.originalTarget).toMatchObject({
        moduleId: 'commerce.pricing',
        resourceType: 'commerce.pricing.price',
        tenantId,
      });
    }),
  );

  it.effect('maps a REVISE to a value-only revise fenced by the revision of the body and the owner schedule', () =>
    Effect.gen(function* maps() {
      const plan = Option.getOrThrow(yield* build(batchOf(revise('30'))));
      const [item] = plan.items;
      const [effect] = item?.effects ?? [];
      expect(effect?.operation).toEqual(priceRevise);
      expect(effect?.originalTarget).toEqual(existingPriceRef);
      expect(item?.source.sourceRecordId).toBe('symmy-price:existing-record');
      expect(reviseOf(effect)).toMatchObject({
        payload: {
          expectedCurrent: {
            effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
            priceRef: existingPriceRef,
            revision: 1,
            revisionId: '44444444-4444-4444-8444-444444444444',
            scheduleRevision: 3,
          },
          intent: 'VALUE_ONLY_CURRENT',
          monetaryAmount: { amount: '30', currencyCode: 'CZK' },
          priceRef: existingPriceRef,
          reason: 'Symmy price import',
          sourceAssertion: {
            lineage: { kind: 'SUPERSESSION', supersededSourceAssertionId: '55555555-5555-4555-8555-555555555555' },
            originalAssertion: { monetaryAmount: { amount: '30', currencyCode: 'CZK' }, monetaryBoundary: 'PRE_TAX' },
            sourceRecord: {
              sourceRecordRef: 'symmy-price:existing-record',
              sourceSystem: templateInput.pricingSourceSystem,
            },
          },
        },
        priceGroupRef,
      });
    }),
  );

  it.effect('keeps a REVISE the owner returned no facts for as an item that names the list, never dropping it', () =>
    Effect.gen(function* keeps() {
      const plan = Option.getOrThrow(yield* build(batchOf(define('7'), revise()), { reviseFacts: [] }));
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual(['price-0', 'price-1']);
      const [, item] = plan.items;
      expect(reviseOf(item?.effects[0])).toMatchObject({ priceGroupRef });
    }),
  );

  it.effect('refuses only the DEFINE that names another tenant and plans the rest of the request', () =>
    Effect.gen(function* refuses() {
      const foreign = { ...define('8'), productRef: { ...productRef, tenantId: otherTenantId } };
      const plan = Option.getOrThrow(yield* build(batchOf(define('7'), foreign, define('9'))));
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual(['price-0', 'price-1', 'price-2']);
      expect(plan.items.map(({ effects: [effect] }) => Object.hasOwn(effect ?? {}, 'originalTarget'))).toEqual([
        true,
        false,
        true,
      ]);
      expect(defineOf(plan.items[1]?.effects[0])?.payload.priceRef.tenantId).toBe(tenantId);
    }),
  );

  it.effect('refuses only the REVISE that names a price of another tenant, and trusts no facts for it', () =>
    Effect.gen(function* refuses() {
      const foreignRef = { ...existingPriceRef, tenantId: otherTenantId };
      const foreign = { ...revise('31'), priceRef: foreignRef };
      const plan = Option.getOrThrow(yield* build(batchOf(define('7'), foreign, revise('32'))));
      expect(plan.items.map(({ effects: [effect] }) => Object.hasOwn(effect ?? {}, 'originalTarget'))).toEqual([
        true,
        false,
        true,
      ]);
      const refused = reviseOf(plan.items[1]?.effects[0]);
      expect(refused?.payload.priceRef.tenantId).toBe(tenantId);
      expect(refused).toMatchObject({ payload: { expectedCurrent: { priceRef: { tenantId } } } });
      expect(plan.items[1]?.source.sourceRecordId).not.toBe('symmy-price:existing-record');
    }),
  );

  it.effect('admits no plan when the price list of the request is of another tenant', () =>
    Effect.gen(function* denies() {
      expect(Option.isNone(yield* build(batchOf(define('7')), { tenantId: otherTenantId }))).toBe(true);
    }),
  );

  it.effect('mixes DEFINE and REVISE in request order, one item each', () =>
    Effect.gen(function* mixes() {
      const plan = Option.getOrThrow(yield* build(batchOf(define('7'), revise(), define('8'))));
      expect(plan.items.map(({ effects }) => effects[0]?.operation.entrypointKey)).toEqual([
        'commerce.pricing.define-price',
        'commerce.pricing.revise-price',
        'commerce.pricing.define-price',
      ]);
    }),
  );

  it.effect('derives the same plan for the same Idempotency-Key, and other identities for another key', () =>
    Effect.gen(function* derives() {
      const batch = batchOf(define('7'), define('8'), revise());
      const first = Option.getOrThrow(yield* build(batch));
      expect(Option.getOrThrow(yield* build(batch))).toEqual(first);
      const other = Option.getOrThrow(yield* build(batch, { idempotencyKey: 'price-key-2' }));
      expect(other).not.toEqual(first);
      expect(new Set(first.items.map(({ sourceOccurrenceId }) => sourceOccurrenceId)).size).toBe(3);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
      expect(first.items.every(({ sourceOccurrenceId }) => uuid.test(sourceOccurrenceId ?? ''))).toBe(true);
    }),
  );

  it.effect('keeps one source record for one price of one list across requests, and one per list', () =>
    Effect.gen(function* stable() {
      const [first, second] = [
        Option.getOrThrow(yield* build(batchOf(define('7')))),
        Option.getOrThrow(yield* build(batchOf(define('7')), { idempotencyKey: 'price-key-2' })),
      ];
      expect(second.items[0]?.source).toEqual(first.items[0]?.source);
      const otherGroup = Schema.decodeUnknownSync(SymmyPriceBatchSchema)({
        priceGroupRef: { ...priceGroupRef, resourceId: '33333333-3333-4333-8333-000000000010' },
        prices: [define('7')],
      });
      const other = Option.getOrThrow(yield* build(otherGroup));
      expect(other.items[0]?.source.sourceRecordId).not.toBe(first.items[0]?.source.sourceRecordId);
      const otherPrice = Option.getOrThrow(yield* build(batchOf(define('7', 'B2C'))));
      expect(otherPrice.items[0]?.source.sourceRecordId).not.toBe(first.items[0]?.source.sourceRecordId);
    }),
  );

  it.effect('admits no plan for a route that does not enroll the owner operation of one of its items', () =>
    Effect.gen(function* denies() {
      const defineOnly = decodeTemplate({ ...templateInput, items: [enroll(priceDefine)] });
      const reviseOnly = decodeTemplate({ ...templateInput, items: [enroll(priceRevise)] });
      expect(Option.isSome(yield* build(batchOf(define('7')), { template: defineOnly }))).toBe(true);
      expect(Option.isNone(yield* build(batchOf(revise()), { template: defineOnly }))).toBe(true);
      expect(Option.isNone(yield* build(batchOf(define('7')), { template: reviseOnly }))).toBe(true);
      expect(Option.isNone(yield* build(batchOf(define('7'), revise()), { template: reviseOnly }))).toBe(true);
    }),
  );

  it.effect('admits no plan without a price source, a pricing source system or a selling legal entity', () =>
    Effect.gen(function* denies() {
      const batch = batchOf(define('7'));
      const { priceSource: _grant, ...withoutGrant } = templateInput;
      const { pricingSourceSystem: _system, ...withoutSystem } = templateInput;
      expect(Option.isNone(yield* build(batch, { template: decodeTemplate(withoutGrant) }))).toBe(true);
      expect(Option.isNone(yield* build(batch, { template: decodeTemplate(withoutSystem) }))).toBe(true);
      expect(Option.isNone(yield* build(batch, { withoutLegalEntity: true }))).toBe(true);
    }),
  );
});

describe('Symmy price batch admission payload', () => {
  const parse = Schema.decodeUnknownResult(AdmitSymmyJobPayloadSchema, { onExcessProperty: 'error' });
  const priceBatch = Schema.encodeSync(SymmyPriceBatchSchema)(batchOf(define('7')));
  const admission = { idempotencyKey: 'price-key', priceBatch, reviseFacts: [], routeKey: 'priceListPricesBatch' };

  it('admits the batch with its facts only on the prices route', () => {
    expect(Result.isSuccess(parse(admission))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, routeKey: 'priceListsBatchUpsert' }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, routeKey: 'productsBatch' }))).toBe(true);
    expect(
      Result.isSuccess(
        parse({ ...admission, reviseFacts: [Schema.encodeSync(SymmyPriceReviseFactsSchema)(factsOf())] }),
      ),
    ).toBe(true);
  });

  it('refuses a batch without facts, facts without a batch, a code, a fixture, a plan or an empty or oversized batch', () => {
    const { reviseFacts: _facts, ...withoutFacts } = admission;
    const { priceBatch: _batch, ...withoutBatch } = admission;
    expect(Result.isFailure(parse(withoutFacts))).toBe(true);
    expect(Result.isFailure(parse(withoutBatch))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, code: 'price-list' }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, fixtureId: 'fixture-safe' }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, contractVersion: 'INTERNAL_C14' }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, priceBatch: { ...priceBatch, prices: [] } }))).toBe(true);
    expect(
      Result.isFailure(
        parse({
          ...admission,
          priceBatch: { ...priceBatch, prices: Array.from({ length: 17 }, () => priceBatch.prices[0]) },
        }),
      ),
    ).toBe(true);
  });

  it('refuses a fixture alone on the prices route', () => {
    expect(
      Result.isFailure(
        parse({ fixtureId: 'fixture-safe', idempotencyKey: 'price-key', routeKey: 'priceListPricesBatch' }),
      ),
    ).toBe(true);
  });
});
