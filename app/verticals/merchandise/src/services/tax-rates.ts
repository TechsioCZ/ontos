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
import {
  Context,
  Crypto,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Match,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
} from 'effect';

import { TaxRuleRevisionIdSchema, VatPercentSchema } from '../../shared/domain/merchandise-model.ts';

const TAX_AUDIENCE = 'tax';
/**
 * How long Tax's answer for a company is used before it is asked again. Rates change by declaration, and a scheduled
 * change is already in the answer's dated periods, so the rate at any instant stays exact in between.
 */
export const TAX_RATE_FRESHNESS = Duration.minutes(12);
/** How long a write that prices something new waits for the company's refresh from Tax. */
export const TAX_REFRESH_TIMEOUT = Duration.seconds(3);
/** While Tax is unreachable, rates it confirmed at most this long ago still price new lines and prices. */
export const CONFIRMED_RATES_MAX_AGE = Duration.hours(24);
/** Both classifications and the regime are read side by side; nothing else fans out. */
const TAX_READ_CONCURRENCY = 3;

/** One dated rate of one classification, exactly as Tax publishes it (`ratePercent` is an exact decimal). */
export const TaxRatePeriodSchema = Schema.Struct({
  code: CzVatClassificationCodeSchema,
  effectiveFrom: Schema.DateTimeUtcFromString,
  effectiveTo: Schema.optionalKey(Schema.DateTimeUtcFromString),
  ratePercent: Schema.String,
  /** Absent only in the state the classification migration seeded: no Tax rule stands behind it yet. */
  taxRuleRevisionId: Schema.optionalKey(TaxRuleRevisionIdSchema),
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

/** The integer rate each classification sells at, at one instant; a classification without an entry is not sellable. */
export const SellableVatRatesSchema = Schema.Struct({
  [CZ_VAT_REDUCED]: Schema.optionalKey(VatPercentSchema),
  [CZ_VAT_STANDARD]: Schema.optionalKey(VatPercentSchema),
});
export type SellableVatRates = typeof SellableVatRatesSchema.Type;

/** No classification is sellable: a company that never synced with Tax. */
export const NO_SELLABLE_RATES: SellableVatRates = {};

/**
 * Where a company's materialised rates come from. `TAX`: Tax's own answer, which is then in charge (a later gap in Tax
 * fails closed). `MIGRATION`: seeded by the classification migration from the rates the products were stored with
 * (standard 21 %, reduced 12 %), not yet confirmed by Tax; Tax's first answer that prices the company replaces it.
 */
export const CompanyTaxRatesSourceSchema = Schema.Literals(['MIGRATION', 'TAX']);
export type CompanyTaxRatesSource = typeof CompanyTaxRatesSourceSchema.Type;

/** Per product, the rate it keeps selling at while the migrated state is unconfirmed (BOOK-IT, stored at 10 %). */
export const HeldProductRatesSchema = Schema.Record(Schema.String, VatPercentSchema);
export type HeldProductRates = typeof HeldProductRatesSchema.Type;
export const NO_HELD_RATES: HeldProductRates = {};

/**
 * What Merchandise keeps of Tax per company (`catalog_heads.tax_rates`): the book of its last sync (or the migrated
 * one), so storefront reads resolve the rate at any instant locally and never call Tax. Stored prices are never derived
 * from it again: a rate entered with a price stays in that price.
 */
export const CompanyTaxRatesSchema = Schema.Struct({
  book: TaxRateBookSchema,
  /** Only in the migrated state: products whose stored rate differs from their classification's seeded rate. */
  heldProductRates: Schema.optionalKey(HeldProductRatesSchema),
  source: CompanyTaxRatesSourceSchema,
  syncedAt: Schema.DateTimeUtcFromString,
});
export type CompanyTaxRates = typeof CompanyTaxRatesSchema.Type;

export const NotSellableReasonSchema = Schema.Literals([
  'NO_RULE',
  'NOT_INTEGER',
  'REGIME_NOT_DECLARED',
  'RULE_CONFLICT',
  'TAX_NOT_AVAILABLE',
  'TAX_NOT_SYNCED',
  'TAX_UNREACHABLE',
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
  // The migrated state has no rule behind its rates: its lines carry no rule revision.
  return period.taxRuleRevisionId === undefined
    ? { _tag: 'Rate', ratePercent }
    : { _tag: 'Rate', ratePercent, taxRuleRevisionId: period.taxRuleRevisionId };
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

/** The rates a company sells at, at one instant, from its last sync with Tax (none before the first sync). */
export const sellableRatesOf = (stored: CompanyTaxRates | undefined, at: DateTime.Utc): SellableVatRates =>
  stored === undefined ? NO_SELLABLE_RATES : sellableRatesAt(stored.book, at);

/** The per-product rates the company still holds from the migration (none once Tax is in charge). */
export const heldRatesOf = (stored: CompanyTaxRates | undefined): HeldProductRates =>
  stored?.source === 'MIGRATION' ? (stored.heldProductRates ?? NO_HELD_RATES) : NO_HELD_RATES;

/**
 * Whether Tax's answer prices the company on its own: a non-payer, or a payer with a usable rate for every
 * classification. Only such an answer replaces the migrated state; until then the stored rates keep selling.
 */
export const pricesCompany = (book: TaxRateBook, at: DateTime.Utc): boolean =>
  book.regime === 'NON_PAYER' ||
  (book.regime === 'VAT_PAYER' &&
    czVatClassificationCodes.every((code) => Option.isSome(rateOf(resolveVatRate(book, code, at)))));

/** The company's rates a read or a write works with, and the state to materialise from Tax's answer. */
export interface TaxRatesDecision {
  /** Absent when no rates exist (nothing stored and no answer, or Tax refused a company it was in charge of). */
  readonly book?: TaxRateBook;
  /** The rates or the regime change with this decision (a new revision of the catalog). */
  readonly changed: boolean;
  readonly held: HeldProductRates;
  /** Present when the stored state must become this one: Tax's answer took over, or confirmed it again. */
  readonly materialise?: CompanyTaxRates;
  /**
   * Whether `book` may price something new (a new order line, a new product price): Tax's answer, the migrated rates
   * (not yet confirmed), or rates Tax confirmed within {@link CONFIRMED_RATES_MAX_AGE} while Tax is unreachable.
   */
  readonly usable: boolean;
}

/** What Merchandise got from Tax for this read or write. */
export interface TaxAnswer {
  readonly book?: TaxRateBook;
  /** Tax refused the company (not installed for it, or no longer admits Merchandise). */
  readonly refused: boolean;
}

const ageOf = (since: DateTime.Utc, at: DateTime.Utc) => DateTime.distance(since, at);
const confirmedRecently = (stored: CompanyTaxRates, at: DateTime.Utc) =>
  Duration.isLessThanOrEqualTo(ageOf(stored.syncedAt, at), CONFIRMED_RATES_MAX_AGE);

const keptStored = (stored: CompanyTaxRates | undefined, at: DateTime.Utc): TaxRatesDecision =>
  stored === undefined
    ? { changed: false, held: NO_HELD_RATES, usable: false }
    : {
        book: stored.book,
        changed: false,
        held: heldRatesOf(stored),
        usable: stored.source === 'MIGRATION' || confirmedRecently(stored, at),
      };

/**
 * Tax's answer is in charge once it prices the company or once Tax has been in charge before (a later gap then fails
 * closed); a company without any stored state takes whatever Tax answers. Otherwise the stored state keeps serving:
 * the migrated rates while Tax is not installed, not reachable or not seeded yet, and Tax's last confirmed answer
 * while Tax is unreachable (for pricing new things only while that confirmation is recent). Tax refusing a company it
 * was in charge of leaves nothing sellable. The same answer again refreshes the confirmation time once per freshness
 * window.
 */
export const decideTaxRates = (
  stored: CompanyTaxRates | undefined,
  answer: TaxAnswer,
  at: DateTime.Utc,
): TaxRatesDecision => {
  const { book } = answer;
  if (book === undefined) {
    return answer.refused && stored?.source === 'TAX'
      ? { changed: false, held: NO_HELD_RATES, usable: false }
      : keptStored(stored, at);
  }
  if (!(stored === undefined || stored.source === 'TAX' || pricesCompany(book, at))) {
    return keptStored(stored, at);
  }
  const confirmed = { book, source: 'TAX', syncedAt: at } satisfies CompanyTaxRates;
  if (stored?.source !== 'TAX' || stored.book.fingerprint !== book.fingerprint) {
    return { book, changed: true, held: NO_HELD_RATES, materialise: confirmed, usable: true };
  }
  const due = Duration.isGreaterThanOrEqualTo(ageOf(stored.syncedAt, at), TAX_RATE_FRESHNESS);
  return due
    ? { book, changed: false, held: NO_HELD_RATES, materialise: confirmed, usable: true }
    : { book, changed: false, held: NO_HELD_RATES, usable: true };
};

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
    Match.when(
      'TAX_NOT_AVAILABLE',
      () => 'Produkt nelze prodat: daně firmy nejsou dostupné (modul Daně není pro firmu aktivní).',
    ),
    Match.when('TAX_NOT_SYNCED', () => 'Produkt nelze prodat: sazby DPH firmy ještě nebyly načteny z daní.'),
    Match.when(
      'TAX_UNREACHABLE',
      () =>
        'Produkt teď nelze prodat: daně firmy nejsou dostupné a jejich poslední ověřené sazby jsou starší než 24 hodin. Zkuste to prosím za chvíli.',
    ),
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

/** What this process last learned from Tax about one company, and the refresh in flight, if any. */
interface CompanyTaxAnswer {
  /** Tax's last answer and when it arrived (kept through a later outage, dropped by a refusal). */
  readonly book?: TaxRateBook;
  readonly fetchedAt?: DateTime.Utc;
  /** The single refresh of this company in flight; every caller joins it instead of asking Tax again. */
  readonly inflight?: Deferred.Deferred<TaxRateBook, TaxRatesFailure>;
  /** Tax refused the company at the last refresh (not installed for it, or no longer admits Merchandise). */
  readonly refused: boolean;
}

/** Per process: one entry per company. Immutable maps, so readers never see a torn entry. */
const companyAnswers = Ref.makeUnsafe<ReadonlyMap<string, CompanyTaxAnswer>>(new Map());
const companyKey = (scope: OperationalScope) => `${scope.tenantId}|${scope.legalEntityId ?? ''}`;
const NO_ANSWER: CompanyTaxAnswer = { refused: false };
const entryOf = (answers: ReadonlyMap<string, CompanyTaxAnswer>, key: string) => answers.get(key) ?? NO_ANSWER;

/** The company's entry after one refresh: the new answer, a refusal, or (an outage) the answer it had before. */
const answerAfter = (
  kept: CompanyTaxAnswer,
  result: Result.Result<TaxRateBook, TaxRatesFailure>,
  at: DateTime.Utc,
): CompanyTaxAnswer => {
  if (Result.isSuccess(result)) {
    return { book: result.success, fetchedAt: at, refused: false };
  }
  if (result.failure.kind === 'REFUSED') {
    return { refused: true };
  }
  return kept.book === undefined || kept.fetchedAt === undefined
    ? { refused: kept.refused }
    : { book: kept.book, fetchedAt: kept.fetchedAt, refused: false };
};

/** Forgets a refresh that ended without an answer (a defect), so the next caller starts a new one. */
const releaseRefresh = (key: string, done: Deferred.Deferred<TaxRateBook, TaxRatesFailure>) =>
  Deferred.interrupt(done).pipe(
    Effect.andThen(
      Ref.update(companyAnswers, (answers) => {
        const entry = entryOf(answers, key);
        if (entry.inflight !== done) {
          return answers;
        }
        const { inflight: _ended, ...rest } = entry;
        void _ended;
        return new Map([...answers, [key, rest]]);
      }),
    ),
  );

/** The leader of a refresh: asks Tax once, records the outcome and releases every caller waiting for it. */
const runRefresh = Effect.fn('Merchandise.runTaxRatesRefresh')(function* runRefresh(
  scope: OperationalScope,
  done: Deferred.Deferred<TaxRateBook, TaxRatesFailure>,
) {
  const source = yield* TaxRateSource;
  const result = yield* Effect.result(source.read(scope));
  const at = yield* DateTime.now;
  const key = companyKey(scope);
  yield* Ref.update(
    companyAnswers,
    (answers) => new Map([...answers, [key, answerAfter(entryOf(answers, key), result, at)]]),
  );
  yield* Result.isSuccess(result) ? Deferred.succeed(done, result.success) : Deferred.fail(done, result.failure);
});

/**
 * Joins the company's refresh in flight or starts one. The refresh runs on its own fiber, so it finishes (and is
 * recorded) even when the caller stops waiting for it; the caller gets the pending answer.
 */
const refreshOf = Effect.fn('Merchandise.refreshTaxRates')(function* refreshOf(scope: OperationalScope) {
  const key = companyKey(scope);
  const created = yield* Deferred.make<TaxRateBook, TaxRatesFailure>();
  const joined = yield* Ref.modify(companyAnswers, (answers) => {
    const current = entryOf(answers, key);
    return current.inflight === undefined
      ? ([undefined, new Map([...answers, [key, { ...current, inflight: created }]])] as const)
      : ([current.inflight, answers] as const);
  });
  if (joined !== undefined) {
    return joined;
  }
  yield* Effect.forkDetach(runRefresh(scope, created).pipe(Effect.ensuring(releaseRefresh(key, created))));
  return created;
});

/** What this process knows from Tax about the company. */
export interface KnownTaxRates {
  readonly book?: TaxRateBook;
  /** Whether the answer is younger than {@link TAX_RATE_FRESHNESS}. */
  readonly fresh: boolean;
  readonly refused: boolean;
}

const known = Effect.fn('Merchandise.knownTaxRates')(function* known(scope: OperationalScope) {
  const [answers, now] = yield* Effect.all([Ref.get(companyAnswers), DateTime.now], { concurrency: 1 });
  const entry = entryOf(answers, companyKey(scope));
  const fresh =
    entry.fetchedAt !== undefined &&
    !DateTime.isGreaterThan(entry.fetchedAt, now) &&
    Duration.isLessThan(ageOf(entry.fetchedAt, now), TAX_RATE_FRESHNESS);
  const answer: KnownTaxRates =
    entry.book === undefined ? { fresh, refused: entry.refused } : { book: entry.book, fresh, refused: false };
  return answer;
});

/**
 * Tax's answer as far as this process knows it, never waiting for Tax (staff reads and writes that price nothing
 * new): when the answer is missing or older than the freshness window a single refresh starts in the background, and
 * the caller works with the company's materialised rates meanwhile.
 */
export const knownTaxRateBook = Effect.fn('Merchandise.knownTaxRateBook')(function* knownTaxRateBook(
  scope: OperationalScope,
) {
  const answer = yield* known(scope);
  if (!answer.fresh) {
    yield* refreshOf(scope);
  }
  return answer;
});

const awaitRefresh = (scope: OperationalScope) =>
  refreshOf(scope).pipe(
    Effect.flatMap((pending) => Deferred.await(pending).pipe(Effect.timeoutOption(TAX_REFRESH_TIMEOUT))),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new TaxRatesFailure({ kind: 'UNAVAILABLE' })),
        onSome: (book) => Effect.succeed(book),
      }),
    ),
  );

/**
 * Tax's answer for a write that prices something new (a new order line, a new product price): the known answer while
 * fresh, else the company's single refresh, waited for at most {@link TAX_REFRESH_TIMEOUT}.
 */
export const currentTaxRateBook = Effect.fn('Merchandise.currentTaxRateBook')(function* currentTaxRateBook(
  scope: OperationalScope,
) {
  const answer = yield* known(scope);
  return answer.fresh && answer.book !== undefined ? answer.book : yield* awaitRefresh(scope);
});

/** Tax's answer now, for an explicit sync: always the single refresh, waited for at most the timeout. */
export const refreshedTaxRateBook = Effect.fn('Merchandise.refreshedTaxRateBook')(function* refreshedTaxRateBook(
  scope: OperationalScope,
) {
  return yield* awaitRefresh(scope);
});
