// VAT rates of the selling company, read from Tax (`commerce.tax`), the only source of rates and of the seller's VAT
// regime. Merchandise asks Tax through a delegated module call for the person (or registered Storefront) it already
// admitted; Tax admits that call because its reads name Merchandise as a caller. A company's rates are kept with their
// effective periods, so the rate at any instant is resolved locally, and every answer fails closed: no rule, a
// conflicting rule, an undeclared regime or a non-integer rate leaves the classification unsellable, never at 0 %.
import type { OperationalScope } from '@app/core-runtime';
import {
  CZ_VAT_REDUCED,
  CZ_VAT_STANDARD,
  CzVatClassificationCodeSchema,
  czVatClassificationCodes,
} from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode, TaxRateView } from '@app/shared-contracts/cz-vat-classifications';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import {
  executeApplicableTaxRuleSetWithAuthorization,
  executeSellerVatRegimeAtInstantWithAuthorization,
  executeTaxRuleHistoryWithAuthorization,
} from '@app/tax/api/client';
import { Clock, Context, Crypto, DateTime, Effect, Match, Option, Redacted, Ref, Schema } from 'effect';

import { TaxRuleRevisionIdSchema, VatPercentSchema } from '../../shared/domain/merchandise-model.ts';

const TAX_AUDIENCE = 'tax';
/** How long one company's rates are reused before Tax is asked again. */
export const TAX_RATE_CACHE_MILLIS = 60_000;
/** Both classifications and the regime are read side by side; nothing else fans out. */
const TAX_READ_CONCURRENCY = 3;

/** One dated rate of one classification, exactly as Tax publishes it (`ratePercent` is an exact decimal). */
export const TaxRatePeriodSchema = Schema.Struct({
  code: CzVatClassificationCodeSchema,
  effectiveFrom: Schema.DateTimeUtcFromString,
  effectiveTo: Schema.optionalKey(Schema.DateTimeUtcFromString),
  ratePercent: Schema.String,
  taxRuleRevisionId: TaxRuleRevisionIdSchema,
});
export type TaxRatePeriod = typeof TaxRatePeriodSchema.Type;

export const TaxRegimeSchema = Schema.Literals(['VAT_PAYER', 'NON_PAYER', 'NOT_DECLARED']);
export type TaxRegime = typeof TaxRegimeSchema.Type;

/** A company's rates and VAT regime from Tax; `fingerprint` changes whenever Tax's answer changes. */
export const TaxRateBookSchema = Schema.Struct({
  fingerprint: Schema.String.check(Schema.isMinLength(1)),
  periods: Schema.Array(TaxRatePeriodSchema),
  regime: TaxRegimeSchema,
});
export type TaxRateBook = typeof TaxRateBookSchema.Type;

/**
 * The integer rate each classification is sold at; a classification without an entry is not sellable. These are the
 * rates the company's stored gross prices were computed with.
 */
export const SellableVatRatesSchema = Schema.Struct({
  [CZ_VAT_REDUCED]: Schema.optionalKey(VatPercentSchema),
  [CZ_VAT_STANDARD]: Schema.optionalKey(VatPercentSchema),
});
export type SellableVatRates = typeof SellableVatRatesSchema.Type;

/** No classification is sellable: what a company that never synced with Tax prices with. */
export const NO_SELLABLE_RATES: SellableVatRates = {};

/**
 * What Merchandise keeps of Tax per company (`catalog_heads.tax_rates`): the rates its stored gross prices were
 * computed with, and the book they were last confirmed against. Without a book nothing is sellable: the rates a
 * migration recorded only say what the stored prices contain until the first sync confirms them with Tax.
 */
export const CompanyTaxRatesSchema = Schema.Struct({
  book: Schema.optionalKey(TaxRateBookSchema),
  priced: SellableVatRatesSchema,
  syncedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type CompanyTaxRates = typeof CompanyTaxRatesSchema.Type;

/** The rates a company sells at now: its priced rates once Tax confirmed them, otherwise none. */
export const sellableRatesOf = (stored: CompanyTaxRates | undefined): SellableVatRates =>
  stored?.book === undefined ? NO_SELLABLE_RATES : stored.priced;

export const NotSellableReasonSchema = Schema.Literals([
  'NO_RULE',
  'NOT_INTEGER',
  'REGIME_NOT_DECLARED',
  'RULE_CONFLICT',
  'TAX_NOT_SYNCED',
]);
export type NotSellableReason = typeof NotSellableReasonSchema.Type;

/** What one classification sells at, at one instant: a rate (with its Tax rule revision), or why it cannot sell. */
export const VatRateResolutionSchema = Schema.Union([
  Schema.TaggedStruct('NotSellable', { reason: NotSellableReasonSchema }),
  Schema.TaggedStruct('Rate', {
    ratePercent: VatPercentSchema,
    /** Absent for a non-payer: no rule applies, the seller charges no VAT. */
    taxRuleRevisionId: Schema.optionalKey(TaxRuleRevisionIdSchema),
  }),
]);
export type VatRateResolution = typeof VatRateResolutionSchema.Type;

const notSellable = (reason: NotSellableReason): VatRateResolution => ({ _tag: 'NotSellable', reason });

const containsInstant = (period: TaxRatePeriod, at: DateTime.Utc) =>
  !DateTime.isLessThan(at, period.effectiveFrom) &&
  (period.effectiveTo === undefined || DateTime.isLessThan(at, period.effectiveTo));

/** The rate of one classification at one instant, resolved from the company's book alone. */
export const resolveVatRate = (
  book: TaxRateBook,
  code: CzVatClassificationCode,
  at: DateTime.Utc,
): VatRateResolution => {
  if (book.regime === 'NOT_DECLARED') {
    return notSellable('REGIME_NOT_DECLARED');
  }
  if (book.regime === 'NON_PAYER') {
    return { _tag: 'Rate', ratePercent: 0 };
  }
  const matching = book.periods.filter((period) => period.code === code && containsInstant(period, at));
  const [period] = matching;
  if (period === undefined) {
    return notSellable('NO_RULE');
  }
  if (matching.length > 1) {
    return notSellable('RULE_CONFLICT');
  }
  const ratePercent = Number(period.ratePercent);
  if (!Number.isInteger(ratePercent) || ratePercent <= 0 || ratePercent > 100) {
    return notSellable('NOT_INTEGER');
  }
  return { _tag: 'Rate', ratePercent, taxRuleRevisionId: period.taxRuleRevisionId };
};

/** The integer rate a resolution sells at, if it sells. */
export const rateOf = (resolution: VatRateResolution): Option.Option<number> =>
  Match.value(resolution).pipe(
    Match.tag('Rate', ({ ratePercent }) => Option.some(ratePercent)),
    Match.tag('NotSellable', () => Option.none<number>()),
    Match.exhaustive,
  );

/** The integer rate of every sellable classification at one instant. */
export const sellableRatesAt = (book: TaxRateBook, at: DateTime.Utc): SellableVatRates =>
  Object.fromEntries(
    czVatClassificationCodes.flatMap((code) =>
      Option.match(rateOf(resolveVatRate(book, code, at)), {
        onNone: () => [],
        onSome: (rate) => [[code, rate] as const],
      }),
    ),
  );

export const sameSellableRates = (left: SellableVatRates, right: SellableVatRates) =>
  czVatClassificationCodes.every((code) => left[code] === right[code]);

const classificationLabels = {
  [CZ_VAT_REDUCED]: 'snížená sazba DPH',
  [CZ_VAT_STANDARD]: 'základní sazba DPH',
} satisfies Readonly<Record<CzVatClassificationCode, string>>;

/** Why a product of this classification cannot be sold now, in the words staff and customers see. */
export const notSellableMessage = (code: CzVatClassificationCode, reason: NotSellableReason): string => {
  const label = classificationLabels[code];
  return Match.value(reason).pipe(
    Match.when('NO_RULE', () => `Produkt nelze prodat: pro ${label} není v daních firmy platné pravidlo.`),
    Match.when('NOT_INTEGER', () => `Produkt nelze prodat: ${label} v daních firmy není celé procento.`),
    Match.when('REGIME_NOT_DECLARED', () => 'Produkt nelze prodat: firma nemá v daních určený režim plátce DPH.'),
    Match.when('RULE_CONFLICT', () => `Produkt nelze prodat: pro ${label} platí v daních firmy více pravidel zároveň.`),
    Match.when('TAX_NOT_SYNCED', () => 'Produkt nelze prodat: sazby DPH firmy ještě nebyly načteny z daní.'),
    Match.exhaustive,
  );
};

const viewOf = (period: TaxRatePeriod): TaxRateView => {
  const view = { code: period.code, effectiveFrom: period.effectiveFrom, ratePercent: Number(period.ratePercent) };
  return period.effectiveTo === undefined ? view : { ...view, effectiveTo: period.effectiveTo };
};

const periodOrder = (left: TaxRatePeriod, right: TaxRatePeriod) =>
  czVatClassificationCodes.indexOf(left.code) - czVatClassificationCodes.indexOf(right.code) ||
  DateTime.toEpochMillis(left.effectiveFrom) - DateTime.toEpochMillis(right.effectiveFrom);

/** The company's current and scheduled rates for staff, oldest first; a non-payer or undeclared regime has none. */
export const taxRateViews = (book: TaxRateBook, at: DateTime.Utc): TaxRateView[] =>
  book.regime === 'VAT_PAYER'
    ? book.periods
        .filter((period) => period.effectiveTo === undefined || DateTime.isLessThan(at, period.effectiveTo))
        .toSorted(periodOrder)
        .map(viewOf)
    : [];

/**
 * Tax could not answer the company's rates. `REFUSED`: Tax is not installed for the tenant, or it does not admit this
 * caller. `UNAVAILABLE`: Tax or the Shell could not answer now; a retry may succeed.
 */
export class TaxRatesFailure extends Schema.TaggedError<TaxRatesFailure>()('TaxRatesFailure', {
  cause: Schema.optionalKey(Schema.Defect()),
  kind: Schema.Literals(['REFUSED', 'UNAVAILABLE']),
}) {}

const StatusSchema = Schema.Struct({ status: Schema.Number });
const classify = (cause: unknown): TaxRatesFailure =>
  new TaxRatesFailure({
    cause,
    kind: Schema.is(StatusSchema)(cause) && (cause.status === 403 || cause.status === 404) ? 'REFUSED' : 'UNAVAILABLE',
  });

interface TaxCallOptions {
  readonly baseUrl: string;
  readonly compositionRevision: string;
}

type TaxRead<A, E> = (authorization: Redacted.Redacted, options: TaxCallOptions) => Effect.Effect<A, E>;

/** A host without a crypto service cannot mint the module call; Tax is then simply unreachable. */
const moduleCallCrypto = Effect.serviceOption(Crypto.Crypto).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.fail(new TaxRatesFailure({ kind: 'UNAVAILABLE' })),
      onSome: Effect.succeed,
    }),
  ),
);

/** One delegated Tax call: a fresh single-use module context from the Shell, then the read with it. */
const callTax = <A, E>(scope: OperationalScope, read: TaxRead<A, E>): Effect.Effect<A, TaxRatesFailure> =>
  moduleCallCrypto.pipe(
    Effect.flatMap((crypto) =>
      acquireDelegatedGatewayContext(
        {
          audience: TAX_AUDIENCE,
          legalEntityScope: 'subject',
          requestCorrelation: scope.correlationId,
          subject: { _tag: 'Assertion', scope },
        },
        crypto,
      ).pipe(Effect.mapError(classify)),
    ),
    Effect.flatMap((issued) =>
      read(Redacted.make(issued.authorization), {
        baseUrl: issued.apiBaseUrl,
        compositionRevision: issued.compositionRevision,
      }).pipe(Effect.mapError(classify)),
    ),
  );

type RuleSet = Effect.Success<ReturnType<typeof executeApplicableTaxRuleSetWithAuthorization>>;
type RuleHistory = Effect.Success<ReturnType<typeof executeTaxRuleHistoryWithAuthorization>>;

/** Every effective period of one rule: corrected revisions are dropped, an end fact shortens its revision. */
const periodsOf = (code: CzVatClassificationCode, history: RuleHistory): TaxRatePeriod[] => {
  const wrong = new Set(history.corrections.map((correction) => correction.wrongRevisionRef.resourceId));
  return history.revisions.flatMap((revision) => {
    if (
      wrong.has(revision.taxRuleRevisionRef.resourceId) ||
      revision.taxClassificationCode !== code ||
      revision.jurisdiction !== 'CZ_DOMESTIC' ||
      revision.treatmentCategory !== 'TAXABLE'
    ) {
      return [];
    }
    const ended = revision.endFact.pipe(Option.map((fact) => fact.endedEffectiveTo));
    const end = Option.isSome(ended) ? ended : revision.effectiveTo;
    if (Option.isSome(end) && !DateTime.isLessThan(revision.effectiveFrom, end.value)) {
      return [];
    }
    const period = {
      code,
      effectiveFrom: revision.effectiveFrom,
      ratePercent: revision.ratePercent,
      taxRuleRevisionId: TaxRuleRevisionIdSchema.make(revision.taxRuleRevisionRef.resourceId),
    };
    return [Option.isSome(end) ? { ...period, effectiveTo: end.value } : period];
  });
};

interface RulePeriods {
  readonly basis: string;
  readonly periods: readonly TaxRatePeriod[];
}

const NO_PERIODS: readonly TaxRatePeriod[] = [];

type RegimeAnswer = Effect.Success<ReturnType<typeof executeSellerVatRegimeAtInstantWithAuthorization>>;

/** The declared regime, or NOT_DECLARED. */
const regimeOf = (answer: RegimeAnswer): TaxRegime =>
  Match.value(answer.selection).pipe(
    Match.tag('DECLARED', (declared) => declared.regime),
    Match.tag('NOT_DECLARED', () => 'NOT_DECLARED' as const),
    Match.exhaustive,
  );

/** Asks Tax for the company's rates (both classifications, with their history) and its VAT regime. */
export const fetchTaxRateBook = Effect.fn('Merchandise.fetchTaxRateBook')(function* fetchTaxRateBook(
  scope: OperationalScope,
) {
  const now = yield* DateTime.now;
  const ruleSet = (code: CzVatClassificationCode) =>
    callTax(scope, (authorization, options) =>
      executeApplicableTaxRuleSetWithAuthorization(
        { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode: code, taxRelevantTime: now },
        Redacted.value(authorization),
        scope.correlationId,
        options,
      ),
    ).pipe(Effect.map((set) => [code, set] as const));
  const [sets, regime] = yield* Effect.all(
    [
      Effect.all(czVatClassificationCodes.map(ruleSet), { concurrency: TAX_READ_CONCURRENCY }),
      callTax(scope, (authorization, options) =>
        executeSellerVatRegimeAtInstantWithAuthorization(
          { instant: now },
          Redacted.value(authorization),
          scope.correlationId,
          options,
        ),
      ),
    ],
    { concurrency: TAX_READ_CONCURRENCY },
  );
  const histories = yield* Effect.forEach(
    sets,
    ([code, set]: readonly [CzVatClassificationCode, RuleSet]) => {
      const [current] = set.applicable;
      return set.outcome !== 'SELECTED' || current === undefined
        ? Effect.succeed<RulePeriods>({ basis: set.outcome, periods: NO_PERIODS })
        : callTax(scope, (authorization, options) =>
            executeTaxRuleHistoryWithAuthorization(
              { taxRuleRef: current.taxRuleRef },
              Redacted.value(authorization),
              scope.correlationId,
              options,
            ),
          ).pipe(
            Effect.map((history): RulePeriods => ({
              basis: history.basisFingerprint,
              periods: periodsOf(code, history),
            })),
          );
    },
    { concurrency: TAX_READ_CONCURRENCY },
  );
  const declared = regimeOf(regime);
  // The head revision moves with every declaration, a scheduled one included.
  const fingerprint = [
    ...sets.map(([code, set]) => `${code}:${set.outcome}:${set.completeness.setFingerprint}`),
    ...histories.map((history) => history.basis),
    `${declared}:${String(regime.headRevision)}`,
  ].join('|');
  return {
    fingerprint,
    periods: histories.flatMap((history) => history.periods),
    regime: declared,
  } satisfies TaxRateBook;
});

/** Where a company's book comes from: Tax through the delegated module call, unless a test host supplies one. */
export interface TaxRateSourceService {
  readonly read: (scope: OperationalScope) => Effect.Effect<TaxRateBook, TaxRatesFailure>;
}

export const TaxRateSource = Context.Reference<TaxRateSourceService>('@app/merchandise/services/TaxRateSource', {
  defaultValue: () => ({ read: fetchTaxRateBook }),
});

interface CachedBook {
  readonly book: TaxRateBook;
  readonly fetchedAtMillis: number;
  /** The source that answered; another source never reuses the entry. */
  readonly source: TaxRateSourceService;
}

/** Per process: one entry per company, replaced on every fetch. Immutable maps, so readers never see a torn entry. */
const cachedBooks = Ref.makeUnsafe<ReadonlyMap<string, CachedBook>>(new Map());
const companyKey = (scope: OperationalScope) => `${scope.tenantId}|${scope.legalEntityId ?? ''}`;

/** Always asks Tax (storefront order placement), and refreshes the cache with the answer. */
export const freshTaxRateBook = Effect.fn('Merchandise.freshTaxRateBook')(function* freshTaxRateBook(
  scope: OperationalScope,
) {
  const source = yield* TaxRateSource;
  const book = yield* source.read(scope);
  const fetchedAtMillis = yield* Clock.currentTimeMillis;
  yield* Ref.update(
    cachedBooks,
    (books) => new Map([...books, [companyKey(scope), { book, fetchedAtMillis, source }]]),
  );
  return book;
});

/** The company's rates, reused for at most {@link TAX_RATE_CACHE_MILLIS}. */
export const cachedTaxRateBook = Effect.fn('Merchandise.cachedTaxRateBook')(function* cachedTaxRateBook(
  scope: OperationalScope,
) {
  const [books, nowMillis, source] = yield* Effect.all([Ref.get(cachedBooks), Clock.currentTimeMillis, TaxRateSource], {
    concurrency: 1,
  });
  const cached = books.get(companyKey(scope));
  if (
    cached !== undefined &&
    cached.source === source &&
    nowMillis >= cached.fetchedAtMillis &&
    nowMillis - cached.fetchedAtMillis < TAX_RATE_CACHE_MILLIS
  ) {
    return cached.book;
  }
  return yield* freshTaxRateBook(scope);
});
