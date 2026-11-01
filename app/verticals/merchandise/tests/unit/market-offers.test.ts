import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandSchema, merchandiseMarketCommandSchemas } from '../../shared/actions/apply-command.ts';
import {
  AKROS_LEGAL_ENTITY_ID,
  ESHOP_LEGAL_ENTITY_ID,
  assertCommandAllowed,
  assertStorefrontScope,
  staffCommandAllowed,
} from '../../shared/actions/command-guard.ts';
import { RecordsResponseSchema, RecordsViewSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import {
  ExchangeRateSchema,
  MarketIdSchema,
  convertGrossMinor,
  czkBoundsForMarket,
  formatMarketMoney,
  isMarketException,
  isOfferedInMarket,
  normalizeExchangeRate,
} from '../../shared/domain/market-offers.ts';
import type { MarketPricing, OrderMarket } from '../../shared/domain/market-offers.ts';
import { orderCurrency } from '../../shared/domain/merchandise-model.ts';
import { blockedReasonOf } from '../../src/api/agent-review.ts';
import { isMarketCommand, planConfigureMarket } from '../../src/services/market-commands.ts';
import {
  productGrossCzk,
  productInMarketCurrency,
  unconfiguredStorefrontMarket,
} from '../../src/services/market-pricing.ts';
import type { StoredMarket } from '../../src/services/market-store.ts';
import { describeLines, evolveMerchandiseState } from '../../src/services/persistence.service.ts';
import { stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';

const MARKET_ID = Schema.decodeUnknownSync(MarketIdSchema)('6a000000-0000-4000-8000-0000000000a1');
const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
type CommandInput = typeof MerchandiseCommandSchema.Encoded;

const eur: MarketPricing = { currency: 'EUR', exchangeRate: '0.04', roundingMinor: 10 };
const pln: MarketPricing = { currency: 'PLN', exchangeRate: '0.17', roundingMinor: 100 };
const czk: MarketPricing = { currency: 'CZK', exchangeRate: '1', roundingMinor: 1 };
const orderMarket: OrderMarket = {
  currency: 'EUR',
  exchangeRate: '0.04',
  marketCode: 'AKROS-SK',
  marketId: MARKET_ID,
  roundingMinor: 10,
};

it('converts gross CZK into market minor units, rounded half-up to the rounding step', () => {
  expect(convertGrossMinor(28_900, czk)).toBe(28_900);
  // 289 Kč × 0.04 = 11.56 € → 11.60 €
  expect(convertGrossMinor(28_900, eur)).toBe(1160);
  // exactly half a step rounds up: 288.75 Kč × 0.04 = 11.55 € → 11.60 €; just below rounds down
  expect(convertGrossMinor(28_875, eur)).toBe(1160);
  expect(convertGrossMinor(28_874, eur)).toBe(1150);
  // 289 Kč × 0.17 = 49.13 zł → 49 zł
  expect(convertGrossMinor(28_900, pln)).toBe(4900);
  expect(convertGrossMinor(0, eur)).toBe(0);
  // 1 290 Kč × 0.92 = 1 186.80 Kč → 1 187 Kč (B2B price list in CZK)
  expect(convertGrossMinor(129_000, { exchangeRate: '0.92', roundingMinor: 100 })).toBe(118_700);
  // exact decimal math, no binary floating point drift: 0.041 has no exact double
  expect(convertGrossMinor(100_000, { exchangeRate: '0.041', roundingMinor: 1 })).toBe(4100);
});

it('normalizes and validates the exchange rate as a positive decimal string', () => {
  expect(normalizeExchangeRate('0.0400')).toBe('0.04');
  expect(normalizeExchangeRate('001.50')).toBe('1.5');
  expect(normalizeExchangeRate('1.000')).toBe('1');
  expect(normalizeExchangeRate('25')).toBe('25');
  const valid = Schema.is(ExchangeRateSchema);
  for (const rate of ['0.04', '0.041', '1', '25.5', '0.00000001']) {
    expect(valid(rate)).toBe(true);
  }
  for (const rate of ['0', '0.000', '-1', '1e3', 'abc', '.5', '1.123456789', '']) {
    expect(valid(rate)).toBe(false);
  }
});

it('translates market-currency price bounds into exact CZK bounds', () => {
  for (const pricing of [eur, pln, czk, { exchangeRate: '0.92', roundingMinor: 100 }]) {
    for (const minMinor of [0, 1, 150, 1155, 1160, 4900]) {
      for (const maxMinor of [0, 1150, 1160, 4950, 30_000]) {
        const bounds = czkBoundsForMarket({ maxMinor, minMinor }, pricing);
        for (let gross = 0; gross <= 40_000; gross += 37) {
          const converted = convertGrossMinor(gross, pricing);
          expect(gross >= (bounds.minMinor ?? 0)).toBe(converted >= minMinor);
          expect(gross <= (bounds.maxMinor ?? Number.POSITIVE_INFINITY)).toBe(converted <= maxMinor);
        }
      }
    }
  }
  expect(czkBoundsForMarket({}, eur)).toEqual({});
});

it('offers a product by its exception, else by the market mode default', () => {
  expect(isOfferedInMarket('WHOLE_CATALOGUE', Option.none())).toBe(true);
  expect(isOfferedInMarket('WHOLE_CATALOGUE', Option.some(false))).toBe(false);
  expect(isOfferedInMarket('SELECTED_PRODUCTS', Option.none())).toBe(false);
  expect(isOfferedInMarket('SELECTED_PRODUCTS', Option.some(true))).toBe(true);
  expect(isMarketException('WHOLE_CATALOGUE', true)).toBe(false);
  expect(isMarketException('WHOLE_CATALOGUE', false)).toBe(true);
  expect(isMarketException('SELECTED_PRODUCTS', true)).toBe(true);
  expect(isMarketException('SELECTED_PRODUCTS', false)).toBe(false);
});

const stored = (overrides: Partial<StoredMarket> = {}): StoredMarket => ({
  currency: 'EUR',
  exchangeRate: '0.04',
  marketCode: 'AKROS-SK',
  marketId: MARKET_ID,
  offerMode: 'WHOLE_CATALOGUE',
  revision: 3,
  roundingMinor: 10,
  updatedAt: DateTime.makeUnsafe('2026-10-30T10:00:00Z'),
  ...overrides,
});
const decodeConfigure = Schema.decodeUnknownSync(merchandiseMarketCommandSchemas[0]);
/** A decoded ConfigureMarket for the AKROS-SK price list; `overrides` may hold invalid values. */
const configureBase = {
  _tag: 'ConfigureMarket',
  currency: 'EUR',
  exchangeRate: '0.0400',
  marketCode: 'AKROS-SK',
  marketId: MARKET_ID,
  offerMode: 'WHOLE_CATALOGUE',
  roundingMinor: 10,
};
const configure = (overrides: Partial<(typeof merchandiseMarketCommandSchemas)[0]['Encoded']> = {}) =>
  decodeConfigure({ ...configureBase, ...overrides });

it('plans ConfigureMarket against the stored market revision', () => {
  expect(planConfigureMarket(Option.none(), configure({ expectedRevision: 0 }))).toEqual({
    dropExceptions: Option.none(),
    kind: 'write',
    revision: 1,
  });
  expect(planConfigureMarket(Option.none(), configure())).toMatchObject({ kind: 'write', revision: 1 });
  expect(planConfigureMarket(Option.none(), configure({ expectedRevision: 2 }))).toEqual({ kind: 'conflict' });
  expect(planConfigureMarket(Option.some(stored()), configure({ expectedRevision: 2 }))).toEqual({ kind: 'conflict' });
  // "0.0400" equals the stored "0.04": nothing to write
  expect(planConfigureMarket(Option.some(stored()), configure({ expectedRevision: 3 }))).toEqual({
    kind: 'unchanged',
    revision: 3,
  });
  expect(planConfigureMarket(Option.some(stored()), configure({ exchangeRate: '0.041' }))).toEqual({
    dropExceptions: Option.none(),
    kind: 'write',
    revision: 4,
  });
  // Switching to SELECTED_PRODUCTS makes `offered: false` the default: those exceptions are dropped.
  expect(planConfigureMarket(Option.some(stored()), configure({ offerMode: 'SELECTED_PRODUCTS' }))).toEqual({
    dropExceptions: Option.some(false),
    kind: 'write',
    revision: 4,
  });
  expect(planConfigureMarket(Option.some(stored({ offerMode: 'SELECTED_PRODUCTS' })), configure())).toMatchObject({
    dropExceptions: Option.some(true),
    kind: 'write',
  });
});

it('decodes the market commands with their bounds', () => {
  const offers = (count: number) => ({
    _tag: 'SetMarketProductOffers',
    marketId: MARKET_ID,
    offered: false,
    productIds: Array.from({ length: count }, (_, index) => `product-${index}`),
  });
  expect(isMarketCommand(decodeCommand(offers(250)))).toBe(true);
  expect(() => decodeCommand(offers(251))).toThrow();
  expect(() => decodeCommand(offers(0))).toThrow();
  expect(() => decodeCommand({ _tag: 'RemoveMarket', marketId: 'not-a-uuid' })).toThrow();
  expect(() => configure({ roundingMinor: 0 })).toThrow();
  expect(() => configure({ exchangeRate: '0' })).toThrow();
  expect(() => decodeConfigure({ ...configureBase, currency: 'USD' })).toThrow();
  expect(configure().exchangeRate).toBe('0.0400');
  expect(
    isMarketCommand(
      decodeCommand({ _tag: 'SetProductMarketOffer', marketId: MARKET_ID, offered: true, productId: 'p1' }),
    ),
  ).toBe(true);
  expect(isMarketCommand(decodeCommand({ _tag: 'RemoveMarket', marketId: MARKET_ID }))).toBe(true);
});

it.effect('guards market commands like other catalog and money changes', () =>
  Effect.gen(function* guard() {
    for (const tag of ['ConfigureMarket', 'RemoveMarket', 'SetMarketProductOffers']) {
      yield* assertCommandAllowed('non_human', tag).pipe(Effect.flip);
      yield* assertCommandAllowed('human', tag);
    }
    // One product's offer is an ordinary catalog edit an agent key may run (human approval for bulk changes).
    yield* assertCommandAllowed('non_human', 'SetProductMarketOffer');
    for (const tag of ['ConfigureMarket', 'RemoveMarket', 'SetMarketProductOffers', 'SetProductMarketOffer']) {
      yield* assertStorefrontScope('api_key', AKROS_LEGAL_ENTITY_ID, tag).pipe(Effect.flip);
      expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, false, tag)).toBe(false);
      expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, true, tag)).toBe(true);
      expect(staffCommandAllowed(ESHOP_LEGAL_ENTITY_ID, false, tag)).toBe(true);
      expect(blockedReasonOf({ _tag: tag }, { canManageCatalog: false, canWrite: true })).toBeDefined();
      expect(blockedReasonOf({ _tag: tag }, { canManageCatalog: true, canWrite: true })).toBeUndefined();
    }
  }),
);

it('accepts the market views and response shapes', () => {
  const view = Schema.decodeUnknownSync(RecordsViewSchema);
  expect(view({ marketExceptions: { limit: 250, marketId: MARKET_ID }, markets: true }).markets).toBe(true);
  expect(() => view({ marketExceptions: { limit: 251, marketId: MARKET_ID } })).toThrow();
  expect(view({ storefront: true, storefrontCatalog: { marketId: MARKET_ID } }).storefrontCatalog?.marketId).toBe(
    MARKET_ID,
  );
  expect(() => view({ storefrontCatalog: { marketId: 'AKROS-SK' } })).toThrow();
  const response = Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
    market: { configured: true, currency: 'EUR', marketCode: 'AKROS-SK', marketId: MARKET_ID },
    marketExceptions: {
      items: [{ name: 'Etiopie', offered: false, productId: 'p1', sku: 'ETH' }],
      marketId: MARKET_ID,
      total: 1,
    },
    markets: [
      {
        currency: 'EUR',
        exceptionCounts: { notOffered: 1, offered: 0 },
        exchangeRate: '0.04',
        marketCode: 'AKROS-SK',
        marketId: MARKET_ID,
        offerMode: 'WHOLE_CATALOGUE',
        revision: 1,
        roundingMinor: 10,
        updatedAt: '2026-10-30T10:00:00.000Z',
      },
    ],
    movements: [],
    orders: [],
    productMarkets: [
      { currency: 'EUR', grossPriceMinor: 1160, marketCode: 'AKROS-SK', marketId: MARKET_ID, offered: true },
    ],
    products: [],
    revision: 1,
  });
  expect(response.markets?.[0]?.exceptionCounts.notOffered).toBe(1);
  expect(unconfiguredStorefrontMarket(MARKET_ID)).toEqual({ configured: false, currency: 'CZK', marketId: MARKET_ID });
});

it('formats order amounts in the order currency', () => {
  expect(formatMarketMoney(28_900)).toBe('289 Kč');
  expect(formatMarketMoney(1160, 'EUR')).toBe('11,60 €');
  expect(formatMarketMoney(4900, 'PLN')).toBe('49 zł');
  expect(orderCurrency({})).toBe('CZK');
  expect(orderCurrency({ market: { ...orderMarket } })).toBe('EUR');
});

// ------------------------------------------------------------------------------------------------ storefront orders

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const t0 = DateTime.makeUnsafe('2026-10-19T10:00:00Z');
const empty: MerchandiseState = { movements: [], orders: [], products: [] };

const apply = (
  state: MerchandiseState,
  command: CommandInput,
  resourceId: string,
  market?: Parameters<typeof evolveMerchandiseState>[2]['market'],
) =>
  evolveMerchandiseState(
    state,
    decodeCommand(command),
    market === undefined ? { actor, now: t0, resourceId } : { actor, market, now: t0, resourceId },
  );

/** Coffee (12 % VAT) with two real variants: 250 g at gross 289 Kč (11.60 €) and 1 kg at 989 Kč (39.60 €). */
const seeded = Effect.gen(function* seedCoffee() {
  const created = yield* apply(
    empty,
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'Zrnková káva',
      lowStockThreshold: 3,
      name: 'Etiopie',
      priceMinor: 25_804,
      sku: 'ETH',
      unit: 'ks',
      vatRate: 12,
    },
    'p1',
  );
  const withVariants = yield* apply(
    created.state,
    {
      _tag: 'UpdateProduct',
      id: 'p1',
      patch: {
        variants: [
          { attributes: '250 g', name: '250 g / zrnková', priceMinor: 25_804, sku: 'ETH-250' },
          { attributes: '1 kg', name: '1 kg / zrnková', priceMinor: 88_304, sku: 'ETH-1KG' },
        ],
      },
    },
    'u1',
  );
  const stocked = yield* apply(
    withVariants.state,
    { _tag: 'RecordStockMovement', delta: 10, productId: 'p1', reason: 'RECEIPT', variantId: 'u1-v1' },
    'm1',
  );
  return stocked.state;
});

const guestOrder = (overrides: Partial<Extract<CommandInput, { _tag: 'PlaceStorefrontOrder' }>> = {}) =>
  ({
    _tag: 'PlaceStorefrontOrder',
    clientRequestId: 'client-request-market-1',
    contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
    deliveryAddress: { city: 'Bratislava', postalCode: '811 01', street: 'Ukážková 12' },
    lines: [{ expectedUnitPriceMinor: 1160, productId: 'p1', quantity: 2, variantId: 'u1-v1' }],
    marketId: MARKET_ID,
    partyId: 'test-customer-party',
    shippingMethod: 'ZASILKOVNA',
    ...overrides,
  }) satisfies CommandInput;

const offeredContext = { market: Option.some(orderMarket), marketId: MARKET_ID, offeredProductIds: new Set(['p1']) };

/** A missing fixture value fails the test before its fields are read. */
const requireFixture = <T>(value: T | undefined): T => {
  if (value === undefined) {
    expect.unreachable('The fixture must be present before its fields are read');
  }
  return value;
};

it.effect('converts every storefront price of a product into the market currency', () =>
  Effect.gen(function* marketRecord() {
    const state = yield* seeded;
    const product = requireFixture(state.products[0]);
    const record = toProductRecord(product, stockLevelsOf(state.movements, product.id));
    const converted = productInMarketCurrency(record, orderMarket);
    expect(converted.grossPriceMinor).toBe(1160);
    expect(converted.variantRecords?.map((variant) => variant.grossPriceMinor)).toEqual([1160, 3960]);
    expect(productGrossCzk(record)).toEqual(Option.some(28_900));
    const { grossPriceMinor: _gross, ...variantsOnly } = record;
    // 250 g is the lowest active variant price
    expect(productGrossCzk(variantsOnly)).toEqual(Option.some(28_900));
    expect(productGrossCzk({ ...variantsOnly, variantRecords: [] })).toEqual(Option.none());
    expect(productInMarketCurrency(record, czk)).toEqual(record);
  }),
);

it.effect('PlaceStorefrontOrder reprices, totals and stores the order in the market currency', () =>
  Effect.gen(function* placedInMarket() {
    const state = yield* seeded;
    const placed = yield* apply(state, guestOrder(), 'inv-market-1', offeredContext);
    const result = placed.storefrontOrder;
    expect(result?.outcome).toBe('PLACED');
    // shipping 79 Kč × 0.04 = 3.16 € → 3.20 €
    expect(result?.shippingPriceMinor).toBe(320);
    expect(result?.totalMinor).toBe(2 * 1160 + 320);
    expect(result?.market).toEqual({ configured: true, currency: 'EUR', marketCode: 'AKROS-SK', marketId: MARKET_ID });
    const [order] = placed.state.orders;
    expect(order?.market).toEqual(orderMarket);
    expect(order?.lines[0]?.unitPriceMinor).toBe(1160);
    expect(order === undefined ? '' : describeLines(order)).toContain('11,60 €');
    const replay = yield* apply(placed.state, guestOrder(), 'inv-market-2', offeredContext);
    expect(replay.storefrontOrder?.outcome).toBe('REPLAYED');
    expect(replay.storefrontOrder?.market?.currency).toBe('EUR');
  }),
);

it.effect('PlaceStorefrontOrder reports CZK expectations as a changed market price', () =>
  Effect.gen(function* staleCurrency() {
    const state = yield* seeded;
    const rejected = yield* apply(
      state,
      guestOrder({ lines: [{ expectedUnitPriceMinor: 28_900, productId: 'p1', quantity: 1, variantId: 'u1-v1' }] }),
      'inv-market-3',
      offeredContext,
    );
    expect(rejected.storefrontOrder?.outcome).toBe('REJECTED');
    expect(rejected.storefrontOrder?.issues[0]).toMatchObject({ code: 'PRICE_CHANGED', currentUnitPriceMinor: 1160 });
    expect(rejected.storefrontOrder?.issues[0]?.message).toContain('11,60 €');
    expect(rejected.state.orders).toHaveLength(0);
  }),
);

it.effect('PlaceStorefrontOrder rejects products the market does not offer and unconfigured markets', () =>
  Effect.gen(function* notOffered() {
    const state = yield* seeded;
    const withdrawn = yield* apply(state, guestOrder(), 'inv-market-4', {
      ...offeredContext,
      offeredProductIds: new Set<string>(),
    });
    expect(withdrawn.storefrontOrder?.outcome).toBe('REJECTED');
    expect(withdrawn.storefrontOrder?.issues).toEqual([
      expect.objectContaining({ code: 'NOT_OFFERED_IN_MARKET', productId: 'p1', variantId: 'u1-v1' }),
    ]);
    expect(withdrawn.state.orders).toHaveLength(0);
    const unknown = yield* apply(state, guestOrder(), 'inv-market-5', {
      market: Option.none(),
      marketId: MARKET_ID,
      offeredProductIds: new Set<string>(),
    });
    expect(unknown.storefrontOrder?.outcome).toBe('REJECTED');
    expect(unknown.storefrontOrder?.issues[0]?.code).toBe('MARKET_UNAVAILABLE');
    expect(unknown.storefrontOrder?.market?.configured).toBe(false);
    // No resolved market context at all (persistence did not resolve it) is the same unavailable market.
    const unresolved = yield* apply(state, guestOrder(), 'inv-market-6');
    expect(unresolved.storefrontOrder?.issues[0]?.code).toBe('MARKET_UNAVAILABLE');
  }),
);

it.effect('PlaceStorefrontOrder without a market stays in CZK', () =>
  Effect.gen(function* czkOrder() {
    const state = yield* seeded;
    const { marketId: _market, ...withoutMarket } = guestOrder({
      lines: [{ expectedUnitPriceMinor: 28_900, productId: 'p1', quantity: 1, variantId: 'u1-v1' }],
    });
    const placed = yield* apply(state, withoutMarket, 'inv-czk-1');
    expect(placed.storefrontOrder?.outcome).toBe('PLACED');
    expect(placed.storefrontOrder?.market).toBeUndefined();
    expect(placed.state.orders[0]?.market).toBeUndefined();
    expect(placed.storefrontOrder?.totalMinor).toBe(28_900 + 7900);
  }),
);
