// Market definition and price-list forms of the staff screens (DESIGN 4): what the person types, its validation, and
// the Action/command inputs it becomes. Pure; the dialogs decode the result with the owners' schemas before sending.
import { DateTime, Option, Schema } from 'effect';
import type { MarketCurrency, MarketOfferMode, MarketSettings } from '@app/merchandise/domain/market-offers';
import type { CurrentMarket, MarketChannel } from './eshops-model.ts';

export const marketChannels: readonly MarketChannel[] = ['B2C', 'B2B'];
export const jurisdictionKinds = ['COUNTRY', 'REGION', 'JURISDICTION'] as const;
export type JurisdictionKind = (typeof jurisdictionKinds)[number];
export const marketCurrencies: readonly MarketCurrency[] = ['CZK', 'EUR', 'PLN'];
export const offerModes: readonly MarketOfferMode[] = ['WHOLE_CATALOGUE', 'SELECTED_PRODUCTS'];

export interface MarketDefinitionForm {
  readonly channels: readonly MarketChannel[];
  readonly code: string;
  readonly jurisdictionCodes: string;
  readonly jurisdictionKind: JurisdictionKind;
  readonly locales: string;
  readonly purpose: string;
  /** `YYYY-MM-DD`; empty or not later than today means "from now". */
  readonly validFrom: string;
  /** `YYYY-MM-DD`; empty means open-ended. */
  readonly validTo: string;
}

export interface MarketPricingForm {
  readonly currency: MarketCurrency;
  readonly exchangeRate: string;
  readonly offerMode: MarketOfferMode;
  readonly roundingMinor: string;
}

export const DefinitionFieldSchema = Schema.Literals([
  'channels',
  'code',
  'jurisdictions',
  'locales',
  'purpose',
  'validFrom',
  'validTo',
]);
export type DefinitionField = typeof DefinitionFieldSchema.Type;
export const PricingFieldSchema = Schema.Literals(['exchangeRate', 'roundingMinor']);
export type PricingField = typeof PricingFieldSchema.Type;

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/u;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,7})*$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const RATE_PATTERN = /^[0-9]{1,6}(?:\.[0-9]{1,8})?$/u;

const unique = <A>(values: readonly A[]): readonly A[] => [...new Set(values)];
const tokens = (value: string): readonly string[] =>
  value
    .split(/[\s,;]+/u)
    .map((token) => token.trim())
    .filter((token) => token !== '');

/** Market codes are upper case business codes such as `AKROS-SK`. */
export const normalizeMarketCode = (value: string): string => value.trim().toUpperCase();

/** `cs, en-gb` → `['cs', 'en-GB']`: language lower case, region upper case, duplicates dropped. */
export const parseLocales = (value: string): readonly string[] =>
  unique(
    tokens(value).map((token) => {
      const [language = '', ...rest] = token.replaceAll('_', '-').split('-');
      return [language.toLowerCase(), ...rest.map((part) => part.toUpperCase())].join('-');
    }),
  );

export const parseJurisdictionCodes = (value: string): readonly string[] =>
  unique(tokens(value).map((token) => token.toUpperCase()));

/** `0,04` and `0.0400` are the same rate; the merchandise owner stores it normalized. */
export const normalizeRate = (value: string): string => value.trim().replace(',', '.');

const isDate = (value: string) => DATE_PATTERN.test(value) && Option.isSome(DateTime.make(`${value}T00:00:00.000Z`));

export const definitionIssues = (form: MarketDefinitionForm): readonly DefinitionField[] => {
  const issues: DefinitionField[] = [];
  if (!CODE_PATTERN.test(normalizeMarketCode(form.code))) {
    issues.push('code');
  }
  if (form.purpose.trim() === '' || form.purpose.trim().length > 500) {
    issues.push('purpose');
  }
  if (form.channels.length === 0) {
    issues.push('channels');
  }
  const codes = parseJurisdictionCodes(form.jurisdictionCodes);
  if (codes.length === 0 || codes.some((code) => code.length < 2 || code.length > 40)) {
    issues.push('jurisdictions');
  }
  const locales = parseLocales(form.locales);
  if (locales.length === 0 || locales.some((locale) => !LOCALE_PATTERN.test(locale))) {
    issues.push('locales');
  }
  if (form.validFrom !== '' && !isDate(form.validFrom)) {
    issues.push('validFrom');
  }
  if (form.validTo !== '' && (!isDate(form.validTo) || (form.validFrom !== '' && form.validTo <= form.validFrom))) {
    issues.push('validTo');
  }
  return issues;
};

export const pricingIssues = (form: MarketPricingForm): readonly PricingField[] => {
  const issues: PricingField[] = [];
  const rate = normalizeRate(form.exchangeRate);
  if (!RATE_PATTERN.test(rate) || !/[1-9]/u.test(rate)) {
    issues.push('exchangeRate');
  }
  const rounding = Number(form.roundingMinor.trim());
  if (!Number.isInteger(rounding) || rounding < 1 || rounding > 100_000) {
    issues.push('roundingMinor');
  }
  return issues;
};

/** The UTC calendar day of an instant, as the date inputs show it. */
export const dateOf = (instant: DateTime.Utc): string => DateTime.formatIso(instant).slice(0, 10);

/** Encoded effective period: a start not later than today starts now; an end is the start of that day (UTC). */
export const effectivePeriodOf = (form: Pick<MarketDefinitionForm, 'validFrom' | 'validTo'>, now: DateTime.Utc) => {
  const startsAt =
    form.validFrom === '' || form.validFrom <= dateOf(now)
      ? DateTime.formatIso(now)
      : `${form.validFrom}T00:00:00.000Z`;
  return form.validTo === '' ? { startsAt } : { endsAt: `${form.validTo}T00:00:00.000Z`, startsAt };
};

const definitionFields = (form: MarketDefinitionForm, now: DateTime.Utc) => ({
  channels: marketChannels.filter((channel) => form.channels.includes(channel)),
  effectivePeriod: effectivePeriodOf(form, now),
  jurisdictions: parseJurisdictionCodes(form.jurisdictionCodes).map((code) => ({ code, kind: form.jurisdictionKind })),
  purpose: form.purpose.trim(),
  supportedLocales: parseLocales(form.locales),
});

/** Encoded `create-market` payload for the signed-in company. */
export const createMarketInput = (input: {
  readonly form: MarketDefinitionForm;
  readonly launchNow: boolean;
  readonly legalEntityId: string;
  readonly marketId: string;
  readonly now: DateTime.Utc;
  readonly reason: string;
  readonly tenantId: string;
}) => ({
  ...definitionFields(input.form, input.now),
  lifecycle: input.launchNow ? ('ACTIVE' as const) : ('SUSPENDED' as const),
  marketCode: normalizeMarketCode(input.form.code),
  marketId: input.marketId,
  reason: input.reason.trim(),
  sellingLegalEntityRef: {
    moduleId: 'core.identity' as const,
    resourceId: input.legalEntityId,
    resourceType: 'core.identity.legal-entity' as const,
    tenantId: input.tenantId,
  },
});

/** Encoded `revise-market-definition` payload: a new definition revision over the observed current one. */
export const reviseMarketInput = (input: {
  readonly current: CurrentMarket;
  readonly form: MarketDefinitionForm;
  readonly now: DateTime.Utc;
  readonly reason: string;
}) => {
  const fields = definitionFields(input.form, input.now);
  const unchangedStart = input.form.validFrom === dateOf(input.current.effectivePeriod.startsAt);
  return {
    ...fields,
    effectivePeriod: unchangedStart
      ? { ...fields.effectivePeriod, startsAt: DateTime.formatIso(input.current.effectivePeriod.startsAt) }
      : fields.effectivePeriod,
    expectedCurrentDefinitionRevisionRef: input.current.definitionRevisionRef,
    expectedRevision: input.current.revision,
    marketRef: input.current.marketRef,
    reason: input.reason.trim(),
  };
};

/** The form prefilled from the current definition (the edit dialog). */
export const definitionFormOf = (market: CurrentMarket): MarketDefinitionForm => {
  const [first] = market.jurisdictions;
  return {
    channels: market.channels,
    code: market.marketCode,
    jurisdictionCodes: market.jurisdictions.map((jurisdiction) => jurisdiction.code).join(', '),
    jurisdictionKind: first?.kind ?? 'COUNTRY',
    locales: market.supportedLocales.join(', '),
    purpose: market.purpose,
    validFrom: dateOf(market.effectivePeriod.startsAt),
    validTo: market.effectivePeriod.endsAt === undefined ? '' : dateOf(market.effectivePeriod.endsAt),
  };
};

/** A new market starts now (empty "valid from") and is open-ended. */
export const emptyDefinitionForm = (): MarketDefinitionForm => ({
  channels: ['B2C'],
  code: '',
  jurisdictionCodes: '',
  jurisdictionKind: 'COUNTRY',
  locales: '',
  purpose: '',
  validFrom: '',
  validTo: '',
});

/** CZK markets sell at catalogue prices; other currencies need a rate and round to whole units by default. */
export const defaultPricingForm = (currency: MarketCurrency = 'CZK'): MarketPricingForm => ({
  currency,
  exchangeRate: '1',
  offerMode: 'WHOLE_CATALOGUE',
  roundingMinor: currency === 'CZK' ? '100' : '10',
});

export const pricingFormOf = (settings: MarketSettings): MarketPricingForm => ({
  currency: settings.currency,
  exchangeRate: settings.exchangeRate,
  offerMode: settings.offerMode,
  roundingMinor: String(settings.roundingMinor),
});

/** The merchandise `ConfigureMarket` command; `expectedRevision` 0 creates the settings. */
export const configureMarketCommand = (input: {
  readonly expectedRevision: number;
  readonly form: MarketPricingForm;
  readonly marketCode: string;
  readonly marketId: string;
}) => ({
  _tag: 'ConfigureMarket' as const,
  currency: input.form.currency,
  exchangeRate: normalizeRate(input.form.exchangeRate),
  expectedRevision: input.expectedRevision,
  marketCode: input.marketCode,
  marketId: input.marketId,
  offerMode: input.form.offerMode,
  roundingMinor: Number(input.form.roundingMinor.trim()),
});
/** The mandatory reason of a recorded change. */
export const reasonValid = (value: string): boolean => value.trim() !== '' && value.trim().length <= 500;
