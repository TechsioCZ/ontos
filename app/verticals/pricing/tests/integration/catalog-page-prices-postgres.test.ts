import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { getReadHandler, getReadServiceFactory } from '@app/core-runtime/testing/reads';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import type { ExactPriceResolution } from '@app/pricing-contracts/domain/exact-price-resolution';
import { priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { compareQuantityTierDecimalValues } from '@app/pricing-contracts/domain/quantity-tier';
import type { PriceRef } from '@app/pricing-contracts/resources/price';
import { NodeCrypto } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { CatalogPagePricesRequestSchema } from '../../shared/apis/catalog-page-prices.ts';
import type { CatalogPagePrice, CatalogPagePricesRequest } from '../../shared/apis/catalog-page-prices.ts';
import { catalogPagePricesRead } from '../../src/api/catalog-page-prices.read.ts';
import { resolveCurrentSupportedCurrencies } from '../../src/api/current-supported-currencies.read.ts';
import { currencySupportPersistenceForScope } from '../../src/persistence/currency-support-persistence.ts';
import { exactPriceResolutionServiceForScope } from '../../src/services/exact-price-resolution.service.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import type { DefinePricePersistenceCommand } from '../../src/services/price-persistence.service.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';
import { quantityTierPersistenceForScope } from '../../src/services/quantity-tier-persistence.service.ts';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

const supportFrom = '2026-09-01T00:00:00.000Z';
const priceFrom = '2026-09-01T10:00:00.000Z';
const definedAt = '2026-09-01T10:00:01.000Z';
const retiredAt = '2026-09-15T00:00:00.000Z';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

/** Fresh identities per run: the facts of one run never meet another run's append-only history. */
const fixtureIds = Effect.all({
  companyA: nextId,
  companyB: nextId,
  priceGroupId: nextId,
  principalId: nextId,
  productId: nextId,
  tenantId: nextId,
  unitId: nextId,
  variants: Effect.all({ absent: nextId, priced: nextId, retired: nextId, tiered: nextId }),
});
type FixtureIds = Effect.Success<typeof fixtureIds>;

const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));

const compositionRevision = 'a'.repeat(64);
const NO_GROUP = { kind: 'NO_GROUP' } as const;

const catalogRefOf = <const ResourceType extends string>(
  ids: FixtureIds,
  resourceId: string,
  resourceType: ResourceType,
) => ({ moduleId: 'commerce.catalog' as const, resourceId, resourceType, tenantId: ids.tenantId });
const unitRefOf = (ids: FixtureIds) => catalogRefOf(ids, ids.unitId, 'commerce.catalog.product-unit');
const itemOf = (ids: FixtureIds, variantId: string) => ({
  catalogSelection: {
    productRef: catalogRefOf(ids, ids.productId, 'commerce.catalog.product'),
    variantRef: catalogRefOf(ids, variantId, 'commerce.catalog.variant'),
  },
  unitBasis: { quantity: '1', unitRef: unitRefOf(ids) },
});
const keyOf = (
  ids: FixtureIds,
  variantId: string,
  sellingLegalEntityId: string,
  priceGroupSelector: PriceIdentityKey['priceGroupSelector'] = NO_GROUP,
): PriceIdentityKey => ({
  ...itemOf(ids, variantId),
  commercialScope: { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector,
});
const priceRefOf = (ids: FixtureIds, resourceId: string): PriceRef => ({
  moduleId: 'commerce.pricing',
  resourceId,
  resourceType: 'commerce.pricing.price',
  tenantId: ids.tenantId,
});
const scopeOf = (ids: FixtureIds, legalEntityId: string, authBindingId: string): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId,
    authContextRef: 'session:catalog-page-prices-postgres',
    authMethod: 'session',
    legalEntityId,
    principalId: ids.principalId,
    tenantId: ids.tenantId,
  }),
  correlationId: 'catalog-page-prices-postgres',
});

/** One owner transaction in one company of the run's Tenant, scoped exactly as the runtime scopes it. */
const inScope = Effect.fn('CatalogPagePricesFixture.inScope')(function* inScope<Value, Failure, Requirements>(
  ids: FixtureIds,
  database: PricingTestDatabase,
  legalEntityId: string,
  operation: (
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
  ) => Effect.Effect<Value, Failure, Requirements>,
) {
  const scope = scopeOf(ids, legalEntityId, yield* nextId);
  return yield* database.transaction((transaction: PricingTransaction) =>
    transaction
      .execute(
        sql`select set_config('ontos.tenant_id', ${ids.tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
        'objects',
      )
      .pipe(
        Effect.andThen(installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT)),
        Effect.flatMap((ownerTransaction) => operation(ownerTransaction, scope)),
      ),
  );
});

/** A canonical Price write exactly as the owner admits it: one source assertion proving the first Revision. */
const defineCommand = Effect.fn('CatalogPagePricesFixture.defineCommand')(function* defineCommand(
  ids: FixtureIds,
  identityKey: PriceIdentityKey,
  amount: string,
) {
  const actionInvocationId = yield* nextId;
  const priceId = yield* nextId;
  const monetaryAmount = { amount, currencyCode: 'CZK' };
  const trustedOperationAt = instant(definedAt);
  const sourceAssertion = yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'catalog-page-prices-fixture', mappingContractVersion: '1' },
    originalAssertion: { monetaryAmount, monetaryBoundary: 'PRE_TAX', unitBasis: identityKey.unitBasis },
    sourceAssertionId: actionInvocationId,
    sourceAuthority: { sourceAuthorityRef: 'catalog-page-prices-owner', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: actionInvocationId,
      sourceRecordRef: priceId,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'catalog-page-prices-fixture' },
    },
    timing: { importedAt: definedAt, ownerBusinessEffectiveAt: priceFrom, sourceEffectiveAt: priceFrom },
  });
  const prepared = preparePriceSourceEvidence({
    actingPrincipalId: ids.principalId,
    effectiveFrom: priceFrom,
    identityKey,
    monetaryAmount,
    sourceAssertion,
    tenantId: ids.tenantId,
    trustedOperationAt,
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    return yield* Effect.die(`Expected ready Price source evidence, received ${prepared.outcome}`);
  }
  return {
    actingPrincipalId: ids.principalId,
    actionInvocationId,
    effectiveFrom: priceFrom,
    identityKey,
    monetaryAmount,
    priceRef: priceRefOf(ids, priceId),
    reason: 'Define a catalogue page Price fixture.',
    requestCorrelationId: `catalog-page-prices:${actionInvocationId}`,
    sourceEvidence: prepared.evidence,
    trustedOperationAt,
  } satisfies DefinePricePersistenceCommand;
});

const definePrice = Effect.fn('CatalogPagePricesFixture.definePrice')(function* definePrice(
  ids: FixtureIds,
  database: PricingTestDatabase,
  legalEntityId: string,
  identityKey: PriceIdentityKey,
  amount: string,
) {
  const command = yield* defineCommand(ids, identityKey, amount);
  const outcome = yield* inScope(ids, database, legalEntityId, (transaction, scope) =>
    pricePersistenceForScope(transaction, scope).pipe(Effect.flatMap((prices) => prices.define(command))),
  );
  return outcome.outcome === 'CREATED'
    ? outcome.definition.priceRef
    : yield* Effect.die(`Expected a created Price, received ${outcome.outcome}`);
});

const readPage = (
  ids: FixtureIds,
  database: PricingTestDatabase,
  legalEntityId: string,
  input: CatalogPagePricesRequest,
) =>
  inScope(ids, database, legalEntityId, (transaction, scope) =>
    getReadServiceFactory(catalogPagePricesRead)(transaction, scope, compositionRevision).pipe(
      Effect.flatMap((services) =>
        getReadHandler(catalogPagePricesRead)(input, {
          readKey: catalogPagePricesRead.descriptor.readKey,
          scope,
          services,
        }),
      ),
      Effect.map(({ result }) => result),
    ),
  );

const pricedPage = (result: Effect.Success<ReturnType<typeof readPage>>) =>
  Match.value(result).pipe(
    Match.tag('CATALOG_PAGE_PRICED', ({ effectiveAt, prices }) => Effect.succeed({ effectiveAt, prices })),
    Match.tag('CURRENCY_SUPPORT_NOT_CURRENT', () => Effect.die('Expected a priced catalogue page')),
    Match.exhaustive,
  );

/** One variant's public answer, with its outcome named `kind` so the page and the one-item resolution compare. */
const answerOf = (price: CatalogPagePrice) =>
  Match.value(price).pipe(
    Match.tag('PRICE_FOUND', ({ channelId, priceGroupSelector, priceRef, priceRevision }) => ({
      channelId,
      kind: 'PRICE_FOUND',
      priceGroupSelector,
      priceRef,
      priceRevision,
    })),
    Match.tag('NO_APPLICABLE_PRICE', ({ retryable }) => ({ kind: 'NO_APPLICABLE_PRICE', retryable })),
    Match.tag('PRICING_CONFLICT', ({ reason, retryable }) => ({ kind: 'PRICING_CONFLICT', reason, retryable })),
    Match.tag('PRICING_CONFIGURATION_ERROR', ({ reason, retryable }) => ({
      kind: 'PRICING_CONFIGURATION_ERROR',
      reason,
      retryable,
    })),
    Match.tag('PRICING_INDETERMINATE', ({ reason, retryable }) => ({
      kind: 'PRICING_INDETERMINATE',
      reason,
      retryable,
    })),
    Match.exhaustive,
  );

/** What the one-item exact resolution itself says about a variant, in the same vocabulary. */
const oneItemAnswerOf = (resolution: ExactPriceResolution) =>
  Match.value(resolution.path).pipe(
    Match.tag('NO_GROUP_GUEST', ({ usedPrice }) => ({
      channelId: usedPrice.request.exactKey.commercialScope.channelId,
      kind: 'PRICE_FOUND',
      priceGroupSelector: usedPrice.request.exactKey.priceGroupSelector,
      priceRef: usedPrice.priceRef,
      priceRevision: usedPrice.priceRevision,
    })),
    Match.tag('NO_APPLICABLE_PRICE', () => ({ kind: 'NO_APPLICABLE_PRICE', retryable: false })),
    Match.tag('CONFLICT', ({ reason }) => ({ kind: 'PRICING_CONFLICT', reason, retryable: false })),
    Match.tag('CONFIGURATION_ERROR', ({ reason }) => ({
      kind: 'PRICING_CONFIGURATION_ERROR',
      reason,
      retryable: false,
    })),
    Match.tag('INDETERMINATE', ({ reason }) => ({ kind: 'PRICING_INDETERMINATE', reason, retryable: true })),
    Match.orElse(() => ({ kind: 'NOT_A_GUEST_PATH' })),
  );

/** The amount of a found variant; an unpriced variant has none to compare. */
const amountOf = (price: CatalogPagePrice) =>
  Match.value(price).pipe(
    Match.tag('PRICE_FOUND', ({ priceRevision }) => priceRevision.monetaryAmount.amount),
    Match.orElse(() => ''),
  );

/** The Current Quantity Tiers a found variant carries; none when its Tier set is unavailable or it is unpriced. */
const tiersOf = (price: CatalogPagePrice) =>
  Match.value(price).pipe(
    Match.tag('PRICE_FOUND', ({ quantityTiers }) =>
      Match.value(quantityTiers).pipe(
        Match.tag('QUANTITY_TIERS_CURRENT', ({ tiers }) => ({ current: true, tiers })),
        Match.tag('QUANTITY_TIERS_UNAVAILABLE', () => ({ current: false, tiers: [] })),
        Match.exhaustive,
      ),
    ),
    Match.orElse(() => ({ current: false, tiers: [] })),
  );

/** The variant at one position of the page; a missing one fails the test rather than being skipped. */
const nth = (prices: readonly CatalogPagePrice[], index: number) => {
  const price = prices[index];
  return price === undefined ? Effect.die(`Expected a variant at position ${index}`) : Effect.succeed(price);
};

it.live(
  'prices a page of variants for an anonymous visitor exactly as the one-item exact resolution does, in one company only',
  () =>
    Effect.scoped(
      Effect.gen(function* catalogPagePrices() {
        const crypto = yield* Layer.build(NodeCrypto.layer);
        const ids = yield* fixtureIds.pipe(Effect.provideContext(crypto));
        const { companyA, companyB, principalId, tenantId, variants } = ids;
        const unitRef = unitRefOf(ids);
        const withCrypto = <Value, Failure>(program: Effect.Effect<Value, Failure, Crypto.Crypto>) =>
          program.pipe(Effect.provideContext(crypto));
        const { runtime: runtimeClient } = yield* testDatabaseClients;
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);

        // Tenant Currency Support is Current for CZK from before every Price.
        const supportPayload = yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
          expectedState: { state: 'ABSENT' },
          intendedEffectivePeriod: { effectiveFrom: supportFrom, effectiveTo: null },
          intent: 'ESTABLISH_CURRENT',
          reason: 'Establish Currency Support for catalogue page Prices.',
          schemaVersion: '2',
          supportedCurrencies: ['CZK'],
        });
        const supportInvocationId = yield* withCrypto(nextId);
        const support = yield* withCrypto(
          inScope(ids, runtime, companyA, (transaction, scope) =>
            currencySupportPersistenceForScope(transaction, scope, compositionRevision).pipe(
              Effect.flatMap((currencies) =>
                currencies.setCurrent({
                  ...supportPayload,
                  actingPrincipalId: principalId,
                  actionInvocationId: supportInvocationId,
                  tenantId,
                  trustedOperationAt: instant(supportFrom),
                }),
              ),
            ),
          ),
        );
        expect(support).toMatchObject({ outcome: 'CREATED' });

        // Company A: a public price and a Price Group price of one variant, a retired price and a tiered price.
        const priced = yield* withCrypto(
          definePrice(ids, runtime, companyA, keyOf(ids, variants.priced, companyA), '120.5'),
        );
        yield* withCrypto(
          definePrice(
            ids,
            runtime,
            companyA,
            keyOf(ids, variants.priced, companyA, {
              kind: 'PRICE_GROUP',
              priceGroupRef: {
                moduleId: 'pricing.price-group-catalog',
                resourceId: ids.priceGroupId,
                resourceType: 'pricing.price-group-catalog.price-group',
                tenantId,
              },
            }),
            '99',
          ),
        );
        const retired = yield* withCrypto(
          definePrice(ids, runtime, companyA, keyOf(ids, variants.retired, companyA), '50'),
        );
        const tiered = yield* withCrypto(
          definePrice(ids, runtime, companyA, keyOf(ids, variants.tiered, companyA), '100'),
        );
        // Company B prices the variant company A leaves without a price.
        yield* withCrypto(definePrice(ids, runtime, companyB, keyOf(ids, variants.absent, companyB), '70'));

        const retirementInvocationId = yield* withCrypto(nextId);
        const retirement = yield* withCrypto(
          inScope(ids, runtime, companyA, (transaction, scope) =>
            Effect.gen(function* retireAtBoundary() {
              const prices = yield* pricePersistenceForScope(transaction, scope);
              const schedule = yield* prices.readSchedule(retired, instant(retiredAt));
              if (schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || schedule.schedule.current === undefined) {
                return yield* Effect.die('Expected the retired variant to hold a Current Price before its retirement');
              }
              const { current } = schedule.schedule;
              return yield* prices.revise({
                actingPrincipalId: principalId,
                actionInvocationId: retirementInvocationId,
                expectedCurrent: {
                  effectivePeriod: current.effectivePeriod,
                  priceRef: retired,
                  revision: current.definition.revision.revision,
                  revisionId: current.definition.revision.revisionId,
                  scheduleRevision: schedule.schedule.scheduleRevision,
                },
                intent: 'RETIRE_CURRENT',
                priceRef: retired,
                reason: 'Retire the variant Price before the page is read.',
                requestCorrelationId: `catalog-page-prices:${retirementInvocationId}`,
                trustedOperationAt: instant(retiredAt),
              });
            }),
          ),
        );
        expect(retirement).toMatchObject({ outcome: 'REVISED' });

        const tierInvocationId = yield* withCrypto(nextId);
        const tier = yield* withCrypto(
          inScope(ids, runtime, companyA, (transaction, scope) =>
            quantityTierPersistenceForScope(transaction, scope).pipe(
              Effect.flatMap((tiers) =>
                tiers.define({
                  actingPrincipalId: principalId,
                  actionInvocationId: tierInvocationId,
                  effectivePeriod: { effectiveFrom: priceFrom, effectiveTo: null },
                  expectedState: { state: 'ABSENT' },
                  identityKey: {
                    priceRef: tiered,
                    quantityBasis: {
                      catalogQuantityBasis: {
                        targetDivisibilityRevision: 1,
                        targetRef: catalogRefOf(ids, variants.tiered, 'commerce.catalog.variant'),
                        unitRef,
                        unitRuleRevision: 1,
                      },
                      priceUnitBasis: { quantity: '1', unitRef },
                    },
                    thresholdQuantity: '10',
                  },
                  reason: 'Define the Quantity Tier of the tiered variant.',
                  requestCorrelationId: `catalog-page-prices:${tierInvocationId}`,
                  resultingUnitPrice: { amount: '90', currencyCode: 'CZK' },
                  trustedOperationAt: instant(definedAt),
                }),
              ),
            ),
          ),
        );
        expect(tier.outcome).toBe('QUANTITY_TIER_CREATED');

        const request = yield* Schema.decodeEffect(CatalogPagePricesRequestSchema)({
          channelId: 'B2C',
          currencyCode: 'CZK',
          items: [
            itemOf(ids, variants.priced),
            itemOf(ids, variants.absent),
            itemOf(ids, variants.retired),
            itemOf(ids, variants.tiered),
          ],
          marketId: 'cz',
        });
        const before = DateTime.formatIso(yield* DateTime.now);
        const page = yield* pricedPage(yield* withCrypto(readPage(ids, runtime, companyA, request)));
        const after = DateTime.formatIso(yield* DateTime.now);
        // The page is evaluated at the read's own trusted instant, never a caller-chosen one.
        expect(page.effectiveAt >= before && page.effectiveAt <= after).toBe(true);
        expect(page.prices.map(({ catalogSelection, unitBasis }) => ({ catalogSelection, unitBasis }))).toEqual(
          request.items,
        );
        expect(page.prices.map(answerOf).map(({ kind }) => kind)).toEqual([
          'PRICE_FOUND',
          'NO_APPLICABLE_PRICE',
          'NO_APPLICABLE_PRICE',
          'PRICE_FOUND',
        ]);

        // The anonymous visitor's price is the exact no-group Price; the Price Group price never replaces it.
        const publicPrice = yield* nth(page.prices, 0);
        expect(answerOf(publicPrice)).toMatchObject({
          channelId: 'B2C',
          priceGroupSelector: { kind: 'NO_GROUP' },
          priceRef: priced,
          priceRevision: {
            effectiveFrom: priceFrom,
            monetaryAmount: { currencyCode: 'CZK' },
            monetaryBoundary: 'PRE_TAX',
          },
        });
        expect(priceDecimalValuesEqual(amountOf(publicPrice), '120.5')).toBe(true);
        expect(tiersOf(publicPrice)).toEqual({ current: true, tiers: [] });
        // Company B's price of this variant is not visible to company A, and nothing is guessed in its place.
        expect(answerOf(yield* nth(page.prices, 1))).toEqual({ kind: 'NO_APPLICABLE_PRICE', retryable: false });
        // A Price whose period ended before the instant no longer applies.
        expect(answerOf(yield* nth(page.prices, 2))).toEqual({ kind: 'NO_APPLICABLE_PRICE', retryable: false });
        const tieredPrice = yield* nth(page.prices, 3);
        expect(answerOf(tieredPrice)).toMatchObject({ priceRef: tiered });
        expect(priceDecimalValuesEqual(amountOf(tieredPrice), '100')).toBe(true);
        const tiers = tiersOf(tieredPrice);
        expect(tiers.current).toBe(true);
        expect(tiers.tiers).toHaveLength(1);
        const onlyTier = yield* Effect.fromNullishOr(tiers.tiers[0]).pipe(Effect.orDie);
        expect(onlyTier.monetaryBoundary).toBe('PRE_TAX');
        expect(compareQuantityTierDecimalValues(onlyTier.thresholdQuantity, '10')).toBe(0);
        expect(onlyTier.unitPrice.currencyCode).toBe('CZK');
        expect(priceDecimalValuesEqual(onlyTier.unitPrice.amount, '90')).toBe(true);

        // Every variant answers exactly what the one-item exact resolution answers for the same inputs.
        const direct = yield* withCrypto(
          inScope(ids, runtime, companyA, (transaction, scope) =>
            Effect.gen(function* oneItemResolution() {
              const exactPrice = yield* exactPriceResolutionServiceForScope(transaction, scope, compositionRevision);
              const currencies = yield* currencySupportPersistenceForScope(transaction, scope, compositionRevision);
              const currencySupport = yield* resolveCurrentSupportedCurrencies(
                { effectiveAt: page.effectiveAt, tenantId },
                { tenantId },
                currencies.loadCurrent,
              );
              if (!Schema.is(CurrentSupportedCurrenciesSuccessSchema)(currencySupport)) {
                return yield* Effect.die('Expected Current Tenant Currency Support at the page instant');
              }
              return yield* Effect.forEach(
                request.items,
                (item) =>
                  exactPrice.resolve(
                    {
                      currencySupport,
                      resolutionInput: {
                        _tag: 'GUEST',
                        basis: {
                          catalogSelection: item.catalogSelection,
                          commercialScope: { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: companyA },
                          currencyCode: 'CZK',
                          unitBasis: item.unitBasis,
                        },
                        effectiveAt: page.effectiveAt,
                      },
                    },
                    { legalEntityId: companyA, tenantId, trustedOperationAt: DateTime.makeUnsafe(page.effectiveAt) },
                  ),
                { concurrency: 1 },
              );
            }),
          ),
        );
        expect(page.prices.map(answerOf)).toEqual(direct.map(oneItemAnswerOf));

        // Company B sees its own price of the same variant, and none of company A's.
        const otherPage = yield* pricedPage(
          yield* withCrypto(
            readPage(ids, runtime, companyB, {
              ...request,
              items: [itemOf(ids, variants.absent), itemOf(ids, variants.priced)],
            }),
          ),
        );
        expect(otherPage.prices.map(answerOf).map(({ kind }) => kind)).toEqual(['PRICE_FOUND', 'NO_APPLICABLE_PRICE']);
        expect(priceDecimalValuesEqual(amountOf(yield* nth(otherPage.prices, 0)), '70')).toBe(true);
      }),
    ),
);
