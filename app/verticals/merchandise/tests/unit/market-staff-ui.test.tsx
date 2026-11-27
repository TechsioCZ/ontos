// @rstest-environment happy-dom
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import csResource from '../../locales/cs/merchandise.json';
import enResource from '../../locales/en/merchandise.json';
import { MarketIdSchema } from '../../shared/domain/market-offers.ts';
import type { ProductMarket } from '../../shared/domain/market-offers.ts';
import { formatOrderTotal } from '../../src/list-format.ts';
import { MarketsOffersForm, MarketsPanelView } from '../../src/routes/[lang]/provoz/produkty/product-markets.tsx';
import {
  marketPriceText,
  marketsLabelsFrom,
} from '../../src/routes/[lang]/provoz/produkty/product-market-view-model.ts';
import type { MarketsPanelViewProps } from '../../src/routes/[lang]/provoz/produkty/product-markets.tsx';
import { mountInRoute } from '../support/module-ui.ts';

type LocaleResource = typeof csResource | typeof enResource;

const SK = Schema.decodeUnknownSync(MarketIdSchema)('6a000000-0000-4000-8000-0000000000a1');
const PL = Schema.decodeUnknownSync(MarketIdSchema)('6a000000-0000-4000-8000-0000000000a2');
const slovakia: ProductMarket = {
  currency: 'EUR',
  grossPriceMinor: 1160,
  marketCode: 'AKROS-SK',
  marketId: SK,
  offered: true,
};
const poland: ProductMarket = { currency: 'PLN', marketCode: 'AKROS-PL', marketId: PL, offered: false };
const markets: readonly ProductMarket[] = [slovakia, poland];

/** Market section labels of a locale; a missing key fails the test instead of showing the raw key. */
const labelsOf = (resource: LocaleResource) => {
  const { columns, ...texts } = resource.merchandise.pages.products.markets;
  const byPath = new Map<string, string>([
    ...Object.entries(texts),
    ...Object.entries(columns).map(([name, text]): [string, string] => [`columns.${name}`, text]),
  ]);
  return marketsLabelsFrom((path) => {
    const text = byPath.get(path);
    if (text === undefined) {
      throw new TypeError(`Missing markets label: ${path}`);
    }
    return text;
  });
};

/** The section as the offers form shows it, rendered in the module's real route; its markup. */
const render = (overrides: Partial<MarketsPanelViewProps> = {}) => {
  const props = { canManage: true, labels: labelsOf(csResource), markets, saving: false, ...overrides };
  return mountInRoute(
    <MarketsOffersForm markets={props.markets}>
      <MarketsPanelView {...props} />
    </MarketsOffersForm>,
    { path: 'provoz/produkty', url: '/cs/provoz/produkty' },
  ).pipe(
    Effect.map(() => {
      const markup = new XMLSerializer().serializeToString(document.body);
      unmountAll();
      // The DOM serializes a no-break space as an entity; the static markup this test read printed the character.
      return markup.replaceAll('&#160;', '\u00A0').replaceAll('&nbsp;', '\u00A0');
    }),
  );
};

afterEach(unmountAll);

const visibleText = (markup: string) => markup.replaceAll(/<[^>]+>/gu, ' ').replaceAll(/\s+/gu, ' ');
const switchInputs = (markup: string) => markup.match(/<input[^>]*type="checkbox"[^>]*>/gu) ?? [];

it.live('lists every configured market by its code, currency and converted price, without technical ids', () =>
  Effect.gen(function* listsMarkets() {
    const markup = yield* render();
    const text = visibleText(markup);
    expect(text).toContain('Trhy');
    expect(text).toContain('AKROS-SK');
    expect(text).toContain('AKROS-PL');
    expect(text).toContain('EUR');
    expect(text).toContain('PLN');
    expect(text).toMatch(/11,60\s€/u);
    expect(text).toContain('V nabídce');
    expect(text).toContain('Není v nabídce');
    expect(text).toContain('cena není dostupná');
    expect(markup).not.toContain(SK);
    expect(markup).not.toContain(PL);
    expect(switchInputs(markup)).toHaveLength(2);
    expect(switchInputs(markup).some((input) => input.includes('disabled'))).toBe(false);
  }),
);

it.live('disables the offer switches without catalog management and while the offers are saving', () =>
  Effect.gen(function* disablesSwitches() {
    for (const overrides of [{ canManage: false }, { saving: true }]) {
      const inputs = switchInputs(yield* render(overrides));
      expect(inputs).toHaveLength(2);
      expect(inputs.every((input) => input.includes('disabled'))).toBe(true);
    }
  }),
);

it.live('shows a plain message when the company has no markets', () =>
  Effect.gen(function* noMarkets() {
    expect(visibleText(yield* render({ markets: [] }))).toContain('Pro tuto společnost zatím nejsou nastavené trhy.');
  }),
);

it('has every market label in Czech and English', () => {
  const cs = labelsOf(csResource);
  const en = labelsOf(enResource);
  expect(cs.title).toBe('Trhy');
  expect(en.title).toBe('Markets');
  expect(Object.keys(en)).toEqual(Object.keys(cs));
  expect(en.offered).toBe('Offered');
  expect(enResource.merchandise.pages.products.markets.offeredSaved).toContain('{{code}}');
  expect(csResource.merchandise.pages.products.markets.withdrawnSaved).toContain('{{code}}');
  expect(csResource.merchandise.pages.orders.detail.market).toBe('Trh');
  expect(enResource.merchandise.pages.orders.detail.market).toBe('Market');
  expect(csResource.merchandise.ui.currencyUnit).toEqual({ CZK: 'Kč', EUR: '€', PLN: 'zł' });
  expect(Object.keys(enResource.merchandise.ui.currencyUnit)).toEqual(['CZK', 'EUR', 'PLN']);
  expect(csResource.merchandise.ui.shippingPriceInclVat).toContain('{{currency}}');
});

it('formats market prices and order totals in their own currency', () => {
  expect(marketPriceText(slovakia, '—')).toMatch(/11,60\s€/u);
  expect(marketPriceText(poland, '—')).toBe('—');
  expect(formatOrderTotal(1_234_560, 'CZK')).toMatch(/12\s346\sKč/u);
  expect(formatOrderTotal(4964, 'EUR')).toMatch(/49,64\s€/u);
  expect(formatOrderTotal(4900, 'PLN')).toMatch(/^49\s(?:PLN|zł)$/u);
});
