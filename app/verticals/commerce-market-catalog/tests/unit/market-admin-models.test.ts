import { MarketSettingsSchema } from '@app/merchandise/domain/market-offers';
import { StorefrontApplicationSummarySchema } from '@app/storefront-registry/api/storefront-applications';
import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { MarketHistoryResponseSchema } from '../../shared/apis/market-history.ts';
import { MarketRetirementOutcomeSchema } from '../../shared/domain/market-retirement-intent.ts';
import { MarketDefinitionSchema, StorefrontAssociationDefinitionSchema } from '../../shared/market-contracts.ts';
import { eshopsOverview, storefrontName, storefrontUrl } from '../../src/market-admin/eshops-model.ts';
import {
  confirmsMarketCode,
  currentDefinition,
  lifecycleActions,
  marketAssociations,
  retirementView,
  revisionRows,
  storefrontChoices,
} from '../../src/market-admin/market-detail-model.ts';
import {
  configureMarketCommand,
  createMarketInput,
  definitionFormOf,
  definitionIssues,
  effectivePeriodOf,
  emptyDefinitionForm,
  parseLocales,
  pricingIssues,
  reasonValid,
  reviseMarketInput,
} from '../../src/market-admin/market-form.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const skMarketId = '33333333-3333-4333-8333-333333333333';
const czMarketId = '44444444-4444-4444-8444-444444444444';
const plMarketId = '55555555-5555-4555-8555-555555555555';

const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.market-catalog',
  resourceId,
  resourceType: `commerce.market-catalog.${resourceType}`,
  tenantId,
});
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
};

const market = (input: {
  readonly code: string;
  readonly definitionId: string;
  readonly lifecycle?: 'ACTIVE' | 'RETIRED' | 'SUSPENDED';
  readonly locales: readonly string[];
  readonly marketId: string;
  readonly purpose?: string;
  readonly revision?: number;
  readonly startsAt?: string;
}) =>
  Schema.decodeUnknownSync(MarketDefinitionSchema)({
    channels: ['B2C'],
    definitionRevisionRef: ref('market-definition-revision', input.definitionId),
    effectivePeriod: { startsAt: input.startsAt ?? '2026-01-01T00:00:00.000Z' },
    jurisdictions: [{ code: input.code.slice(-2), kind: 'COUNTRY' }],
    lifecycle: input.lifecycle ?? 'ACTIVE',
    marketCode: input.code,
    marketRef: ref('market', input.marketId),
    purpose: input.purpose ?? `${input.code} market`,
    revision: input.revision ?? 1,
    sellingLegalEntityRef: sellerRef,
    supportedLocales: input.locales,
  });

const sk = market({
  code: 'AKROS-SK',
  definitionId: '66666666-6666-4666-8666-666666666661',
  locales: ['sk-SK'],
  marketId: skMarketId,
});
const cz = market({
  code: 'AKROS-CZ',
  definitionId: '66666666-6666-4666-8666-666666666662',
  locales: ['cs-CZ'],
  marketId: czMarketId,
});
const pl = market({
  code: 'AKROS-PL',
  definitionId: '66666666-6666-4666-8666-666666666663',
  locales: ['pl-PL'],
  marketId: plMarketId,
});

const association = (appId: string, target: typeof sk, associationId: string) =>
  Schema.decodeUnknownSync(StorefrontAssociationDefinitionSchema)({
    associationRef: ref('storefront-association', associationId),
    channel: 'B2C',
    effectivePeriod: { startsAt: '2026-01-01T00:00:00.000Z' },
    marketDefinitionRevisionRef: Schema.encodeSync(MarketDefinitionSchema)(target).definitionRevisionRef,
    marketRef: Schema.encodeSync(MarketDefinitionSchema)(target).marketRef,
    provenance: { kind: 'CONFIGURATION_ACTION', reference: 'test' },
    revision: 1,
    sellingLegalEntityRef: sellerRef,
    storefrontRef: { appId, tenantId },
  });

const storefront = (
  appId: string,
  resourceId: string,
  lifecycle: 'ACTIVE' | 'RETIRED' = 'ACTIVE',
  channels = ['B2C'],
) =>
  Schema.decodeUnknownSync(StorefrontApplicationSummarySchema)({
    allowedChannels: channels,
    effectiveInterval: { effectiveFrom: '2026-01-01T00:00:00.000Z' },
    lifecycle,
    revision: 1,
    storefrontAppId: appId,
    storefrontApplicationRef: {
      moduleId: 'commerce.storefront-registry',
      resourceId,
      resourceType: 'commerce.storefront-registry.storefront-application',
      tenantId,
    },
  });

const akros = storefront('akros-storefront', '77777777-7777-4777-8777-777777777771');
const kavarna = storefront('kavarna-doma-eshop', '77777777-7777-4777-8777-777777777772');
const other = storefront('pilot-shop', '77777777-7777-4777-8777-777777777773', 'ACTIVE', ['B2B']);

const eurSettings = Schema.decodeUnknownSync(MarketSettingsSchema)({
  currency: 'EUR',
  exceptionCounts: { notOffered: 0, offered: 0 },
  exchangeRate: '0.04',
  marketCode: 'AKROS-SK',
  marketId: skMarketId,
  offerMode: 'WHOLE_CATALOGUE',
  revision: 3,
  roundingMinor: 10,
  updatedAt: '2026-02-01T00:00:00.000Z',
});

describe('E-shops overview model', () => {
  it('names the demo e-shops and numbers any other registration', () => {
    expect(storefrontName('akros-storefront', 1, () => 'x')).toBe('AKROS e-shop');
    expect(storefrontName('kavarna-doma-eshop', 2, () => 'x')).toBe('Kavárna doma e-shop');
    expect(storefrontName('pilot-shop', 3, (position) => `E-shop ${String(position)}`)).toBe('E-shop 3');
  });

  it('links the deployed AKROS e-shop per market language', () => {
    expect(storefrontUrl('akros-storefront', 'sk-SK')).toBe('https://ontos-stage-akros.web-revolution.cz/sk');
    expect(storefrontUrl('akros-storefront')).toBe('https://ontos-stage-akros.web-revolution.cz');
    expect(storefrontUrl('kavarna-doma-eshop', 'cs-CZ')).toBeUndefined();
  });

  it('joins e-shops, their market chips and the markets without an e-shop', () => {
    const overview = eshopsOverview({
      associations: [
        association('akros-storefront', sk, '88888888-8888-4888-8888-888888888881'),
        association('akros-storefront', cz, '88888888-8888-4888-8888-888888888882'),
      ],
      legalEntityId: '71000000-0000-4000-8000-000000000023',
      markets: [sk, cz, pl],
      settings: [eurSettings],
      storefronts: [kavarna, akros, other],
      unnamed: (position) => `E-shop ${String(position)}`,
    });
    expect(overview.eshops.map((eshop) => eshop.name)).toEqual(['AKROS e-shop', 'E-shop 3', 'Kavárna doma e-shop']);
    const [akrosCard] = overview.eshops;
    expect(akrosCard?.markets.map((chip) => [chip.code, chip.currency, chip.url])).toEqual([
      ['AKROS-CZ', undefined, 'https://ontos-stage-akros.web-revolution.cz/cs'],
      ['AKROS-SK', 'EUR', 'https://ontos-stage-akros.web-revolution.cz/sk'],
    ]);
    expect(akrosCard?.url).toBe('https://ontos-stage-akros.web-revolution.cz/cs');
    expect(overview.unassigned.map((chip) => chip.code)).toEqual(['AKROS-PL']);
    expect(overview.unassigned[0]?.url).toBeUndefined();
  });

  it("hides another company's e-shop none of the company's markets sells in", () => {
    const overview = eshopsOverview({
      associations: [],
      legalEntityId: '71000000-0000-4000-8000-000000000023',
      markets: [],
      settings: [],
      storefronts: [kavarna, akros],
      unnamed: (position) => `E-shop ${String(position)}`,
    });
    expect(overview.eshops.map((eshop) => eshop.name)).toEqual(['Kavárna doma e-shop']);
  });
});

describe('market form model', () => {
  const valid = {
    ...emptyDefinitionForm(),
    code: ' akros-hu ',
    jurisdictionCodes: 'hu',
    locales: 'hu_hu, hu-HU',
    purpose: 'Maďarský trh',
  };

  it('accepts a complete definition and normalizes code, locales and jurisdictions', () => {
    expect(definitionIssues(valid)).toEqual([]);
    expect(parseLocales('cs, en-gb;EN-GB')).toEqual(['cs', 'en-GB']);
    const now = DateTime.makeUnsafe('2026-03-10T09:30:00.000Z');
    const payload = createMarketInput({
      form: valid,
      launchNow: false,
      legalEntityId: sellerId,
      marketId: plMarketId,
      now,
      reason: ' Nový trh ',
      tenantId,
    });
    expect(payload).toMatchObject({
      effectivePeriod: { startsAt: '2026-03-10T09:30:00.000Z' },
      jurisdictions: [{ code: 'HU', kind: 'COUNTRY' }],
      lifecycle: 'SUSPENDED',
      marketCode: 'AKROS-HU',
      reason: 'Nový trh',
      supportedLocales: ['hu-HU'],
    });
  });

  it('names every invalid field', () => {
    expect(
      definitionIssues({
        ...emptyDefinitionForm(),
        channels: [],
        code: 'x',
        locales: 'Czech!',
        validFrom: '2026-05-01',
        validTo: '2026-04-01',
      }),
    ).toEqual(['code', 'purpose', 'channels', 'jurisdictions', 'locales', 'validTo']);
    expect(definitionIssues({ ...valid, validFrom: '2026-02-31x' })).toEqual(['validFrom']);
  });

  it('starts a past or empty validity now and a future one at midnight UTC', () => {
    const now = DateTime.makeUnsafe('2026-03-10T09:30:00.000Z');
    expect(effectivePeriodOf({ validFrom: '2026-03-01', validTo: '' }, now)).toEqual({
      startsAt: '2026-03-10T09:30:00.000Z',
    });
    expect(effectivePeriodOf({ validFrom: '2026-04-01', validTo: '2026-05-01' }, now)).toEqual({
      endsAt: '2026-05-01T00:00:00.000Z',
      startsAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('keeps the observed start of an unchanged validity when revising', () => {
    const now = DateTime.makeUnsafe('2026-03-10T09:30:00.000Z');
    const form = { ...definitionFormOf(sk), purpose: 'Slovenský trh B2C' };
    const payload = reviseMarketInput({ current: sk, form, now, reason: 'Upřesnění účelu' });
    expect(payload.effectivePeriod).toEqual({ startsAt: '2026-01-01T00:00:00.000Z' });
    expect(payload.expectedRevision).toBe(1);
    expect(payload.purpose).toBe('Slovenský trh B2C');
  });

  it('validates the price list and builds ConfigureMarket', () => {
    expect(
      pricingIssues({ currency: 'EUR', exchangeRate: '0,04', offerMode: 'WHOLE_CATALOGUE', roundingMinor: '10' }),
    ).toEqual([]);
    expect(
      pricingIssues({ currency: 'EUR', exchangeRate: '0', offerMode: 'WHOLE_CATALOGUE', roundingMinor: '0' }),
    ).toEqual(['exchangeRate', 'roundingMinor']);
    const command = configureMarketCommand({
      expectedRevision: 3,
      form: { currency: 'EUR', exchangeRate: '0,04', offerMode: 'SELECTED_PRODUCTS', roundingMinor: ' 10 ' },
      marketCode: 'AKROS-SK',
      marketId: skMarketId,
    });
    expect(command).toMatchObject({
      currency: 'EUR',
      exchangeRate: '0.04',
      expectedRevision: 3,
      marketCode: 'AKROS-SK',
      marketId: skMarketId,
      offerMode: 'SELECTED_PRODUCTS',
      roundingMinor: 10,
    });
  });

  it('requires a reason', () => {
    expect(reasonValid('  ')).toBe(false);
    expect(reasonValid('Rozšíření o B2B')).toBe(true);
    expect(reasonValid('x'.repeat(501))).toBe(false);
  });
});

describe('market detail model', () => {
  const revised = market({
    code: 'AKROS-SK',
    definitionId: '66666666-6666-4666-8666-666666666664',
    locales: ['sk-SK', 'cs-CZ'],
    marketId: skMarketId,
    purpose: 'Slovenský trh B2C',
    revision: 2,
  });
  const history = Schema.decodeUnknownSync(MarketHistoryResponseSchema)({
    associations: [],
    definitions: [Schema.encodeSync(MarketDefinitionSchema)(sk), Schema.encodeSync(MarketDefinitionSchema)(revised)],
    marketRef: ref('market', skMarketId),
  });

  it('prefers the catalog definition and otherwise takes the newest revision', () => {
    expect(currentDefinition(sk, history)).toBe(sk);
    expect(currentDefinition(undefined, history)?.revision).toBe(2);
  });

  it('lists revisions newest first with what changed', () => {
    expect(revisionRows(history).map((row) => [row.revision, row.changes])).toEqual([
      [2, ['locales', 'purpose']],
      [1, []],
    ]);
  });

  it('offers only the allowed lifecycle transitions', () => {
    expect(lifecycleActions('ACTIVE', false)).toEqual(['suspend', 'retire']);
    expect(lifecycleActions('SUSPENDED', false)).toEqual(['activate', 'retire']);
    expect(lifecycleActions('RETIRED', false)).toEqual([]);
    expect(lifecycleActions('ACTIVE', true)).toEqual([]);
  });

  it('reads a durable retirement outcome', () => {
    const decode = Schema.decodeUnknownSync(MarketRetirementOutcomeSchema);
    const base = { marketRef: ref('market', skMarketId), retirementIntentId: '99999999-9999-4999-8999-999999999999' };
    expect(retirementView()).toEqual({ kind: 'none' });
    expect(retirementView(decode({ ...base, outcome: 'pending', stage: 'RESERVED' }))).toEqual({
      kind: 'pending',
      stage: 'RESERVED',
    });
    expect(retirementView(decode({ ...base, outcome: 'failed', reason: 'impact_assessment_stale' }))).toEqual({
      kind: 'failed',
      reason: 'impact_assessment_stale',
    });
  });

  it('confirms the retirement only with the market code', () => {
    expect(confirmsMarketCode(' akros-sk ', 'AKROS-SK')).toBe(true);
    expect(confirmsMarketCode('AKROS', 'AKROS-SK')).toBe(false);
  });

  it('offers e-shops that are not retired and share a channel', () => {
    const retired = storefront('old-shop', '77777777-7777-4777-8777-777777777774', 'RETIRED');
    expect(storefrontChoices([akros, other, retired], sk).map((choice) => choice.appId)).toEqual(['akros-storefront']);
  });

  it('keeps the associations of the market', () => {
    const own = association('akros-storefront', sk, '88888888-8888-4888-8888-888888888881');
    const foreign = association('akros-storefront', cz, '88888888-8888-4888-8888-888888888882');
    expect(marketAssociations([own, foreign], skMarketId)).toEqual([own]);
  });
});
