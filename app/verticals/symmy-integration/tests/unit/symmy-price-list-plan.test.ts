import { createHash } from 'node:crypto';

import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AdmitSymmyJobPayloadSchema } from '../../shared/domain/symmy-job-admission.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyPriceListRowsSchema, SymmyRequestTenantSchema } from '../../shared/domain/symmy-price-list-batch.ts';
import { buildSymmyPriceListPlan } from '../../src/persistence/symmy-price-list-plan.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const otherTenantId = '77777777-7777-4777-8777-777777777777';
const routeId = '55555555-5555-4555-8555-555555555555';
const ref = (moduleId: string, resourceType: string, suffix: string) => ({
  moduleId,
  resourceId: `33333333-3333-4333-8333-${suffix.padStart(12, '0')}`,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog', 'commerce.catalog.product', '1');
const variantRef = ref('commerce.catalog', 'commerce.catalog.variant', '2');
const unitRef = ref('commerce.catalog', 'commerce.catalog.product-unit', '3');
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
const groupCreate = operation('pricing.price-group-catalog', 'pricing.price-group-catalog.create-price-group', '1');
const priceDefine = operation('commerce.pricing', 'commerce.pricing.define-price', '2');
const templateInput = {
  items: [enroll('PRICE_GROUP', 'enrollment', groupCreate), enroll('PRICE', 'price-enrollment', priceDefine)],
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
const price = (suffix: string) => ({
  amount: '25.50',
  commercialScope: { channelId: 'B2B', marketId: 'cz-market' },
  currencyCode: 'CZK',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  productRef,
  unitBasis: { quantity: '1', unitRef },
  variantRef: { ...variantRef, resourceId: `33333333-3333-4333-8333-${suffix.padStart(12, '0')}` },
});
const list = (code: string, prices: readonly ReturnType<typeof price>[] = []) => ({
  businessCode: code.toUpperCase().replaceAll('-', '_'),
  code,
  description: 'Wholesale prices',
  effectiveFrom: '2026-01-01T00:00:00Z',
  name: `List ${code}`,
  prices,
  purpose: `Purpose of ${code}`,
});
const groupCreateOf = (effect: SymmyFixtureExecutionPlan['items'][number]['effects'][number] | undefined) =>
  Match.value(effect?.intent).pipe(
    Match.when({ _tag: 'PriceGroupCreateAtCatalogHead' }, ({ payload }) => payload),
    Match.orElse(() => null),
  );
const priceDefineOf = (effect: SymmyFixtureExecutionPlan['items'][number]['effects'][number] | undefined) =>
  Match.value(effect?.intent).pipe(
    Match.when({ _tag: 'PriceDefineFromGroupEffect' }, (intent) => intent),
    Match.orElse(() => null),
  );
const rowsOf = (...rows: readonly ReturnType<typeof list>[]) =>
  Schema.decodeUnknownSync(SymmyPriceListRowsSchema)(rows);
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
const build = (
  rows: ReturnType<typeof rowsOf>,
  overrides: {
    readonly idempotencyKey?: string;
    readonly receivedAt?: DateTime.Utc;
    readonly template?: SymmyFixtureExecutionPlan;
    readonly tenantId?: string;
    readonly withoutLegalEntity?: boolean;
  } = {},
) =>
  buildSymmyPriceListPlan({
    digest,
    idempotencyKey: overrides.idempotencyKey ?? 'price-key-1',
    legalEntityId: overrides.withoutLegalEntity === true ? undefined : legalEntityId,
    receivedAt: overrides.receivedAt ?? DateTime.makeUnsafe('2026-01-01T12:00:00.000Z'),
    route: { mappingVersion: 'route-mapping', routeId },
    rows,
    template: overrides.template ?? template,
    tenantId: Schema.decodeUnknownSync(SymmyRequestTenantSchema)(overrides.tenantId ?? tenantId),
  });

describe('Symmy price list plan from the public rows', () => {
  it.effect('maps a list without prices to one Price Group create that carries no fence', () =>
    Effect.gen(function* maps() {
      const plan = Option.getOrThrow(yield* build(rowsOf(list('cz-wholesale'))));
      expect(plan.items).toHaveLength(1);
      const [item] = plan.items;
      expect(item?.itemKey).toBe('price-list-0');
      expect(item?.source).toEqual({
        entityKind: 'PRICE_GROUP',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-namespace',
        sourceRecordId: 'cz-wholesale',
      });
      const [effect] = item?.effects ?? [];
      expect(effect?.operation).toEqual(groupCreate);
      expect(effect?.dependsOn).toBeUndefined();
      expect(groupCreateOf(effect)).toEqual({
        businessCode: 'CZ_WHOLESALE',
        classificationPurpose: 'Purpose of cz-wholesale',
        compatibilityContracts: [{ contractId: 'internal.c14-price-group', version: 1 }],
        description: 'Wholesale prices',
        displayName: 'List cz-wholesale',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        reason: 'Symmy price list import',
        sourceCorrelation: {
          issuer: 'route-issuer',
          mappingVersion: 'mapping-v1',
          namespace: 'route-namespace',
          recordKey: 'cz-wholesale',
          routeId: '66666666-6666-4666-8666-666666666666',
        },
      });
    }),
  );

  it.effect('maps a price to a Price define that names the group effect of its own list', () =>
    Effect.gen(function* maps() {
      const plan = Option.getOrThrow(yield* build(rowsOf(list('cz-wholesale', [price('7')]))));
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual(['price-list-0', 'price-list-0-price-0']);
      const [, priceItem] = plan.items;
      expect(priceItem?.source).toMatchObject({
        entityKind: 'PRICE',
        issuerId: 'route-issuer',
        sourceNamespace: 'route-namespace',
      });
      const [effect] = priceItem?.effects ?? [];
      expect(effect?.operation).toEqual(priceDefine);
      expect(effect?.dependsOn).toEqual([{ effectKey: 'group-create', itemKey: 'price-list-0' }]);
      expect(priceDefineOf(effect)).toMatchObject({
        fromPriceGroupEffect: { effectKey: 'group-create', itemKey: 'price-list-0' },
        payload: {
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          identityKey: {
            catalogSelection: { productRef, variantRef: price('7').variantRef },
            commercialScope: { channelId: 'B2B', marketId: 'cz-market', sellingLegalEntityId: legalEntityId },
            currencyCode: 'CZK',
            priceGroupSelector: { kind: 'PRICE_GROUP' },
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
      });
    }),
  );

  it.effect('keeps the lists independent: no list waits for another and none carries a fence', () =>
    Effect.gen(function* independent() {
      const plan = Option.getOrThrow(
        yield* build(rowsOf(list('a-list', [price('7')]), list('b-list'), list('c-list'))),
      );
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual([
        'price-list-0',
        'price-list-0-price-0',
        'price-list-1',
        'price-list-2',
      ]);
      const groups = plan.items.filter(({ source }) => source.entityKind === 'PRICE_GROUP');
      expect(groups.map(({ effects: [effect] }) => effect?.dependsOn)).toEqual([undefined, undefined, undefined]);
      expect(groups.map(({ effects: [effect] }) => groupCreateOf(effect) !== null)).toEqual([true, true, true]);
      expect(
        groups.map(({ effects: [effect] }) => Object.hasOwn(groupCreateOf(effect) ?? {}, 'expectedCatalogRevision')),
      ).toEqual([false, false, false]);
    }),
  );

  it.effect('refuses only the price that names another tenant and plans the rest of the request', () =>
    Effect.gen(function* refuses() {
      const foreign = { ...price('8'), productRef: { ...productRef, tenantId: otherTenantId } };
      const plan = Option.getOrThrow(
        yield* build(rowsOf(list('a-list', [price('7'), foreign, price('9')]), list('b-list'))),
      );
      expect(plan.items.map(({ itemKey }) => itemKey)).toEqual([
        'price-list-0',
        'price-list-0-price-0',
        'price-list-0-price-1',
        'price-list-0-price-2',
        'price-list-1',
      ]);
      const targets = plan.items.map(({ effects: [effect] }) => effect?.originalTarget?.tenantId ?? null);
      expect(targets).toEqual([null, tenantId, null, tenantId, null]);
      const refused = plan.items[2]?.effects[0];
      expect(priceDefineOf(refused)?.payload.priceRef.tenantId).toBe(tenantId);
      expect(priceDefineOf(refused)?.payload.identityKey.catalogSelection.productRef.tenantId).toBe(tenantId);
      expect(Object.hasOwn(refused ?? {}, 'originalTarget')).toBe(false);
    }),
  );

  it.effect('refuses a price whose variant or unit is of another tenant, not only its product', () =>
    Effect.gen(function* refuses() {
      const variantForeign = { ...price('7'), variantRef: { ...variantRef, tenantId: otherTenantId } };
      const unitForeign = {
        ...price('8'),
        unitBasis: { quantity: '1', unitRef: { ...unitRef, tenantId: otherTenantId } },
      };
      const plan = Option.getOrThrow(yield* build(rowsOf(list('a-list', [variantForeign, unitForeign]))));
      expect(plan.items.slice(1).map(({ effects: [effect] }) => Object.hasOwn(effect ?? {}, 'originalTarget'))).toEqual(
        [false, false],
      );
    }),
  );

  it.effect('derives the same plan for the same Idempotency-Key, and other identities for another key', () =>
    Effect.gen(function* derives() {
      const rows = rowsOf(list('cz-wholesale', [price('7'), price('8')]));
      const first = Option.getOrThrow(yield* build(rows));
      expect(Option.getOrThrow(yield* build(rows))).toEqual(first);
      const other = Option.getOrThrow(yield* build(rows, { idempotencyKey: 'price-key-2' }));
      expect(other).not.toEqual(first);
      expect(new Set(first.items.map(({ sourceOccurrenceId }) => sourceOccurrenceId)).size).toBe(3);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
      expect(first.items.every(({ sourceOccurrenceId }) => uuid.test(sourceOccurrenceId ?? ''))).toBe(true);
    }),
  );

  it.effect('keeps one source record for one price of one list across requests', () =>
    Effect.gen(function* stable() {
      const rows = rowsOf(list('cz-wholesale', [price('7')]));
      const [first, second] = [
        Option.getOrThrow(yield* build(rows)),
        Option.getOrThrow(
          yield* build(rows, {
            idempotencyKey: 'price-key-2',
            receivedAt: DateTime.makeUnsafe('2026-02-02T00:00:00.000Z'),
          }),
        ),
      ];
      expect(second.items[1]?.source).toEqual(first.items[1]?.source);
      const other = Option.getOrThrow(yield* build(rowsOf(list('us-wholesale', [price('7')]))));
      expect(other.items[1]?.source.sourceRecordId).not.toBe(first.items[1]?.source.sourceRecordId);
    }),
  );

  it.effect('admits no plan for a route that does not enroll the Price Group create', () =>
    Effect.gen(function* denies() {
      const priceOnly = decodeTemplate({ ...templateInput, items: [enroll('PRICE', 'price-enrollment', priceDefine)] });
      expect(Option.isNone(yield* build(rowsOf(list('cz-wholesale')), { template: priceOnly }))).toBe(true);
      const wrongOperation = decodeTemplate({
        ...templateInput,
        items: [enroll('PRICE_GROUP', 'enrollment', { ...groupCreate, schemaVersion: '2' })],
      });
      expect(Option.isNone(yield* build(rowsOf(list('cz-wholesale')), { template: wrongOperation }))).toBe(true);
    }),
  );

  it.effect('admits a list without prices on a route that enrolls no price, and no price on such a route', () =>
    Effect.gen(function* denies() {
      const groupsOnly = decodeTemplate({
        ...templateInput,
        items: [enroll('PRICE_GROUP', 'enrollment', groupCreate)],
      });
      expect(Option.isSome(yield* build(rowsOf(list('cz-wholesale')), { template: groupsOnly }))).toBe(true);
      expect(Option.isNone(yield* build(rowsOf(list('cz-wholesale', [price('7')])), { template: groupsOnly }))).toBe(
        true,
      );
    }),
  );

  it.effect('admits no priced plan without a price source, a pricing source system or a selling legal entity', () =>
    Effect.gen(function* denies() {
      const rows = rowsOf(list('cz-wholesale', [price('7')]));
      const { priceSource: _grant, ...withoutGrant } = templateInput;
      const { pricingSourceSystem: _system, ...withoutSystem } = templateInput;
      expect(Option.isNone(yield* build(rows, { template: decodeTemplate(withoutGrant) }))).toBe(true);
      expect(Option.isNone(yield* build(rows, { template: decodeTemplate(withoutSystem) }))).toBe(true);
      expect(Option.isNone(yield* build(rows, { withoutLegalEntity: true }))).toBe(true);
    }),
  );

  it.effect('falls back to the route ids when the route template names no source route', () =>
    Effect.gen(function* fallback() {
      const { sourceMappingVersion: _version, sourceRouteId: _route, ...bare } = templateInput;
      const plan = Option.getOrThrow(yield* build(rowsOf(list('cz-wholesale')), { template: decodeTemplate(bare) }));
      const [effect] = plan.items[0]?.effects ?? [];
      expect(groupCreateOf(effect)?.sourceCorrelation).toMatchObject({
        mappingVersion: 'route-mapping',
        routeId,
      });
    }),
  );
});

describe('Symmy price list admission payload', () => {
  const parse = Schema.decodeUnknownResult(AdmitSymmyJobPayloadSchema, { onExcessProperty: 'error' });
  const rows = Schema.encodeSync(SymmyPriceListRowsSchema)(rowsOf(list('cz-wholesale')));
  const admission = {
    idempotencyKey: 'price-key',
    priceLists: rows,
    routeKey: 'priceListsBatchUpsert',
  };

  it('admits the rows only on the price list route', () => {
    expect(Result.isSuccess(parse(admission))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, routeKey: 'productsBatch' }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, code: 'selected', routeKey: 'priceListPricesBatch' }))).toBe(true);
  });

  it('refuses a missing, empty or oversized list, a catalog head, and a plan or fixture beside the rows', () => {
    const { priceLists: _rows, ...withoutRows } = admission;
    expect(Result.isFailure(parse(withoutRows))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, catalogHead: 0 }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, priceLists: [] }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, priceLists: Array.from({ length: 17 }, () => rows[0]) }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, fixtureId: 'fixture-safe' }))).toBe(true);
    expect(Result.isFailure(parse({ ...admission, contractVersion: 'INTERNAL_C14' }))).toBe(true);
  });

  it('refuses a fixture or an internal plan on the price list route', () => {
    expect(
      Result.isFailure(
        parse({ fixtureId: 'fixture-safe', idempotencyKey: 'price-key', routeKey: 'priceListsBatchUpsert' }),
      ),
    ).toBe(true);
  });
});
