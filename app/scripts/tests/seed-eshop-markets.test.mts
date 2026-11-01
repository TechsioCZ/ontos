import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CreateMarketPayloadSchema } from '../../verticals/commerce-market-catalog/shared/action-contracts.ts';
import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { demoTenantId } from '../demo/fixture-ids.mts';
import { akrosOfferPlan, eshopMarketSeed, seededMarketId } from '../demo/seed-eshop-markets.mts';

const markets = eshopMarketSeed.flatMap((company) =>
  company.markets.map((market) => ({ legalEntityId: company.legalEntityId, market })),
);

it('every seeded Market is a valid Market creation and merchandise configuration', () => {
  for (const { legalEntityId, market } of markets) {
    const marketId = seededMarketId(market.key);
    expect(
      Schema.is(Schema.toEncoded(CreateMarketPayloadSchema))({
        channels: [market.channel],
        effectivePeriod: { startsAt: '2026-10-01T00:00:00.000Z' },
        jurisdictions: [market.jurisdiction],
        lifecycle: market.lifecycle,
        marketCode: market.code,
        marketId,
        purpose: market.purpose,
        reason: 'E-shop markets demo',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: demoTenantId,
        },
        supportedLocales: [market.locale],
      }),
    ).toBe(true);
    expect(
      Schema.is(Schema.toEncoded(MerchandiseCommandSchema))({
        _tag: 'ConfigureMarket',
        currency: market.currency,
        exchangeRate: market.exchangeRate,
        marketCode: market.code,
        marketId,
        offerMode: market.offerMode,
        roundingMinor: market.roundingMinor,
      }),
    ).toBe(true);
  }
  expect(new Set(markets.map(({ market }) => market.code)).size).toBe(markets.length);
  expect(new Set(markets.map(({ market }) => seededMarketId(market.key))).size).toBe(markets.length);
});

it('the AKROS offer plan has products only in Czechia, only in Slovakia, and outside the EU market', () => {
  const products = Array.from({ length: 40 }, (_, index) => `product-${String(index).padStart(2, '0')}`);
  const plan = akrosOfferPlan(products, ['product-30']);
  const czOnly = plan['akros-sk'].notOffered;
  const skOnly = plan['akros-cz'].notOffered;
  expect(czOnly).toHaveLength(10);
  expect(czOnly).toContain('product-30');
  expect(skOnly).toHaveLength(5);
  expect(skOnly.some((id) => czOnly.includes(id))).toBe(false);
  expect(plan['akros-eu'].notOffered).toHaveLength(18);
  expect(plan['akros-pl'].offered).toHaveLength(3);
  expect(plan['akros-pl'].offered.some((id) => plan['akros-eu'].notOffered.includes(id))).toBe(false);
});
