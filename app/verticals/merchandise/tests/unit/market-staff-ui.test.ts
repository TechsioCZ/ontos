import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { constVoid } from 'effect/Function';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import csResource from '../../locales/cs/merchandise.json';
import enResource from '../../locales/en/merchandise.json';
import { MarketIdSchema } from '../../shared/domain/market-offers.ts';
import type { ProductMarket } from '../../shared/domain/market-offers.ts';
import { formatOrderTotal } from '../../src/list-cells.tsx';
import {
  MarketsPanelView,
  marketPriceText,
  marketsLabelsFrom,
} from '../../src/routes/[lang]/provoz/produkty/product-markets.tsx';
import type { MarketsPanelViewProps } from '../../src/routes/[lang]/provoz/produkty/product-markets.tsx';

type LocaleResource = typeof csResource;

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

const render = (overrides: Partial<MarketsPanelViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(MarketsPanelView, {
      canManage: true,
      error: null,
      labels: labelsOf(csResource),
      markets,
      onToggle: constVoid,
      pendingMarketId: null,
      ...overrides,
    }),
  );

const visibleText = (markup: string) => markup.replaceAll(/<[^>]+>/gu, ' ').replaceAll(/\s+/gu, ' ');
const switchInputs = (markup: string) => markup.match(/<input[^>]*type="checkbox"[^>]*>/gu) ?? [];

it('lists every configured market by its code, currency and converted price, without technical ids', () => {
  const markup = render();
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
});

it('disables the offer switches without catalog management and while one offer is saving', () => {
  for (const overrides of [{ canManage: false }, { pendingMarketId: SK }]) {
    const inputs = switchInputs(render(overrides));
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.includes('disabled'))).toBe(true);
  }
});

it('shows a plain message when the company has no markets and the save failure under the table', () => {
  expect(visibleText(render({ markets: [] }))).toContain('Pro tuto společnost zatím nejsou nastavené trhy.');
  expect(visibleText(render({ error: 'Změnu se nepodařilo uložit.' }))).toContain('Změnu se nepodařilo uložit.');
});

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
