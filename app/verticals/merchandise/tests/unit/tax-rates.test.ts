// How Merchandise reads a company's VAT from its book of Tax rules (and from the migrated state until Tax takes over): the rate of a classification at an instant, the
// non-payer and undeclared regimes, the failures that make goods unsellable, the staff view of the rates, the
// 12-minute reuse of Tax's answer with a growing wait while Tax does not answer, and the shared rule other modules apply to the staff records response.
import { randomUUID } from 'node:crypto';

import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { GATEWAY_MODULE_NOT_INSTALLED_TYPE } from '@app/shared-contracts';
import { vatRateAt } from '@app/shared-contracts/cz-vat-classifications';
import { NodeCrypto } from '@effect/platform-node';
import {
  ConfigProvider,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Ref,
  Result,
  Scheduler,
  Schema,
} from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';

import { TaxRuleRevisionIdSchema } from '../../shared/domain/merchandise-model.ts';
import { grossPriceOf } from '../../src/services/stock-levels.ts';
import {
  TaxRateSource,
  TaxRatesFailure,
  currentTaxRateBook,
  decideTaxRates,
  fetchTaxRateBook,
  knownTaxRateBook,
  pricesCompany,
  refreshedTaxRateBook,
  resolveVatRate,
  sellableRatesAt,
  shownTaxRates,
  taxCallFailureOf,
  taxRateViews,
} from '../../src/services/tax-rates.ts';
import type { CompanyTaxRates, TaxRateBook, TaxRatePeriod } from '../../src/services/tax-rates.ts';
import { TEST_SINCE, TEST_TAX_BOOK, testTaxBook } from '../support/tax-fixtures.ts';

const at = (iso: string) => DateTime.makeUnsafe(iso);
const NOW = at('2026-11-12T10:00:00.000Z');
const revision = (id: string) => TaxRuleRevisionIdSchema.make(id);

/** The standard rate moving from 21 to 23 at UTC midnight of 2027-01-01, the reduced one unchanged. */
const RATE_CHANGE = at('2027-01-01T00:00:00.000Z');
const changingBook: TaxRateBook = {
  fingerprint: 'test:changing',
  periods: [
    {
      code: 'cz.vat.standard',
      effectiveFrom: TEST_SINCE,
      effectiveTo: RATE_CHANGE,
      ratePercent: '21',
      taxRuleRevisionId: revision('standard-21'),
    },
    {
      code: 'cz.vat.standard',
      effectiveFrom: RATE_CHANGE,
      ratePercent: '23',
      taxRuleRevisionId: revision('standard-23'),
    },
    { code: 'cz.vat.reduced', effectiveFrom: TEST_SINCE, ratePercent: '12', taxRuleRevisionId: revision('reduced-12') },
  ],
  regime: 'VAT_PAYER',
};

it('a VAT payer sells at the rate in force and names the rule revision it came from', () => {
  expect(resolveVatRate(TEST_TAX_BOOK, 'cz.vat.standard', NOW)).toEqual({
    _tag: 'Rate',
    ratePercent: 21,
    taxRuleRevisionId: revision('revision-standard'),
  });
  expect(resolveVatRate(TEST_TAX_BOOK, 'cz.vat.reduced', NOW)).toEqual({
    _tag: 'Rate',
    ratePercent: 12,
    taxRuleRevisionId: revision('revision-reduced'),
  });
});

it('periods are half-open and change at UTC midnight', () => {
  const lastMoment = at('2026-12-31T23:59:59.999Z');
  expect(resolveVatRate(changingBook, 'cz.vat.standard', lastMoment)).toMatchObject({ ratePercent: 21 });
  expect(resolveVatRate(changingBook, 'cz.vat.standard', RATE_CHANGE)).toMatchObject({
    ratePercent: 23,
    taxRuleRevisionId: revision('standard-23'),
  });
  // Midnight in Prague (UTC+1 in winter) is still the old year in UTC: the old rate applies.
  expect(resolveVatRate(changingBook, 'cz.vat.standard', at('2026-12-31T23:30:00.000Z'))).toMatchObject({
    ratePercent: 21,
  });
  expect(sellableRatesAt(changingBook, RATE_CHANGE)).toEqual({ 'cz.vat.reduced': 12, 'cz.vat.standard': 23 });
});

it('a non-payer sells every classification at 0 % without a rule revision', () => {
  const nonPayer = testTaxBook({}, 'NON_PAYER');
  expect(resolveVatRate(nonPayer, 'cz.vat.standard', NOW)).toEqual({ _tag: 'Rate', ratePercent: 0 });
  expect(resolveVatRate(nonPayer, 'cz.vat.reduced', NOW)).toEqual({ _tag: 'Rate', ratePercent: 0 });
  expect(sellableRatesAt(nonPayer, NOW)).toEqual({ 'cz.vat.reduced': 0, 'cz.vat.standard': 0 });
  expect(taxRateViews(nonPayer, NOW)).toEqual([]);
});

it('fails closed: no regime, a missing rule, two rules at once or a fractional rate sell nothing', () => {
  expect(resolveVatRate(testTaxBook(undefined, 'NOT_DECLARED'), 'cz.vat.standard', NOW)).toEqual({
    _tag: 'NotSellable',
    reason: 'REGIME_NOT_DECLARED',
  });
  const standardOnly = testTaxBook({ standard: '21' });
  expect(resolveVatRate(standardOnly, 'cz.vat.reduced', NOW)).toEqual({ _tag: 'NotSellable', reason: 'NO_RULE' });
  expect(sellableRatesAt(standardOnly, NOW)).toEqual({ 'cz.vat.standard': 21 });
  // Before the first rule took effect there is no rate either.
  expect(resolveVatRate(TEST_TAX_BOOK, 'cz.vat.standard', at('1999-12-31T23:59:59.999Z'))).toEqual({
    _tag: 'NotSellable',
    reason: 'NO_RULE',
  });
  const overlapping: TaxRatePeriod = {
    code: 'cz.vat.standard',
    effectiveFrom: at('2026-01-01T00:00:00.000Z'),
    ratePercent: '20',
    taxRuleRevisionId: revision('standard-20'),
  };
  expect(
    resolveVatRate({ ...TEST_TAX_BOOK, periods: [...TEST_TAX_BOOK.periods, overlapping] }, 'cz.vat.standard', NOW),
  ).toEqual({ _tag: 'NotSellable', reason: 'RULE_CONFLICT' });
  expect(resolveVatRate(testTaxBook({ standard: '21.5' }), 'cz.vat.standard', NOW)).toEqual({
    _tag: 'NotSellable',
    reason: 'NOT_INTEGER',
  });
});

it('staff see the current and scheduled rates of a payer, ended ones dropped, standard first', () => {
  expect(taxRateViews(changingBook, NOW)).toEqual([
    { code: 'cz.vat.standard', effectiveFrom: TEST_SINCE, effectiveTo: RATE_CHANGE, ratePercent: 21 },
    { code: 'cz.vat.standard', effectiveFrom: RATE_CHANGE, ratePercent: 23 },
    { code: 'cz.vat.reduced', effectiveFrom: TEST_SINCE, ratePercent: 12 },
  ]);
  expect(taxRateViews(changingBook, at('2027-03-01T00:00:00.000Z'))).toEqual([
    { code: 'cz.vat.standard', effectiveFrom: RATE_CHANGE, ratePercent: 23 },
    { code: 'cz.vat.reduced', effectiveFrom: TEST_SINCE, ratePercent: 12 },
  ]);
});

it('other modules apply the same rule to the staff response', () => {
  const views = taxRateViews(changingBook, NOW);
  const payer = { sellerVatRegime: 'VAT_PAYER' as const, taxRates: views };
  expect(vatRateAt(payer, 'cz.vat.standard', NOW)).toBe(21);
  expect(vatRateAt(payer, 'cz.vat.standard', RATE_CHANGE)).toBe(23);
  expect(vatRateAt(payer, 'cz.vat.reduced', NOW)).toBe(12);
  expect(vatRateAt(payer, undefined, NOW)).toBeUndefined();
  expect(vatRateAt({ sellerVatRegime: 'VAT_PAYER', taxRates: [] }, 'cz.vat.standard', NOW)).toBeUndefined();
  expect(vatRateAt({ sellerVatRegime: 'NON_PAYER', taxRates: [] }, 'cz.vat.reduced', NOW)).toBe(0);
  expect(vatRateAt({ sellerVatRegime: null, taxRates: views }, 'cz.vat.standard', NOW)).toBeUndefined();
  expect(vatRateAt({}, 'cz.vat.standard', NOW)).toBeUndefined();
});

it('a stored gross price is the price; it is derived from the net only when nothing is stored', () => {
  // As on stage: off by one, off by a lot, and 0 beside a net price. A rate never moves any of them.
  expect(grossPriceOf({ grossPriceMinor: 1211 }, 1000, 21)).toBe(1211);
  expect(grossPriceOf({ grossPriceMinor: 1_062_380 }, 1_878_000, 21)).toBe(1_062_380);
  expect(grossPriceOf({ grossPriceMinor: 0 }, 500, 21)).toBe(0);
  // The first tier wins over the stored gross; with nothing stored the net gets VAT at the rate given.
  expect(
    grossPriceOf(
      { grossPriceMinor: 999, priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 1000, priceMinor: 1210 }] },
      1000,
      21,
    ),
  ).toBe(1210);
  expect(grossPriceOf({}, 49_000, 12)).toBe(54_880);
  // A classification without a rule has no rate: nothing stored, no price, never one at 0 %.
  const noRule = sellableRatesAt(testTaxBook({}), NOW)['cz.vat.standard'];
  expect(grossPriceOf({}, 49_000, noRule)).toBeUndefined();
});

const scopeOf = (tenantId: string): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: randomUUID(),
    authContextRef: 'session:tax-rate-cache',
    authMethod: 'session',
    legalEntityId: randomUUID(),
    principalId: randomUUID(),
    tenantId,
  }),
  correlationId: 'tax-rate-cache',
});

/** A Tax that answers only when the test releases it, counting how often it was asked. */
const gatedSource = Effect.gen(function* gatedSource() {
  const calls = yield* Ref.make(0);
  const release = yield* Deferred.make<TaxRateBook>();
  const source = { read: () => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Deferred.await(release))) };
  return { calls, release, source };
});

it.effect('asks Tax once per company however many reads and writes want its answer at the same time', () =>
  Effect.gen(function* singleFlight() {
    const { calls, release, source } = yield* gatedSource;
    const company = scopeOf(randomUUID());
    const waiting = yield* Effect.forkChild(
      Effect.all([currentTaxRateBook(company), currentTaxRateBook(company), currentTaxRateBook(company)], {
        concurrency: 'unbounded',
      }).pipe(Effect.provideService(TaxRateSource, source)),
    );
    // Staff reads meanwhile join nothing and wait for nothing: they answer from the materialised rates.
    expect(yield* knownTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source))).toEqual({
      refused: false,
      waiting: false,
    });
    yield* Effect.yieldNow;
    expect(yield* Ref.get(calls)).toBe(1);
    yield* Deferred.succeed(release, TEST_TAX_BOOK);
    const fetched = { book: TEST_TAX_BOOK, fetchedAt: yield* DateTime.now };
    expect(yield* Fiber.join(waiting)).toEqual([fetched, fetched, fetched]);
    expect(yield* Ref.get(calls)).toBe(1);
  }),
);

it.effect('a write waits for Tax at most 3 seconds; the refresh still lands for the next caller', () =>
  Effect.gen(function* timeout() {
    const { calls, release, source } = yield* gatedSource;
    const company = scopeOf(randomUUID());
    const asked = yield* DateTime.now;
    const write = yield* Effect.forkChild(
      currentTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source), Effect.flip),
    );
    yield* TestClock.adjust('3 seconds');
    expect((yield* Fiber.join(write)).kind).toBe('UNAVAILABLE');
    yield* Deferred.succeed(release, TEST_TAX_BOOK);
    yield* Effect.yieldNow;
    expect(yield* knownTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source))).toEqual({
      // Tax answered for the instant it was asked about.
      fetched: { book: TEST_TAX_BOOK, fetchedAt: asked },
      refused: false,
      waiting: false,
    });
    expect(yield* Ref.get(calls)).toBe(1);
  }),
);

it.effect('reuses Tax answer for 12 minutes per company and refreshes it afterwards in the background', () =>
  Effect.gen(function* freshness() {
    const calls = yield* Ref.make(0);
    const source = { read: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(TEST_TAX_BOOK)) };
    const company = scopeOf(randomUUID());
    const other = scopeOf(randomUUID());
    const write = (scope: OperationalScope) =>
      currentTaxRateBook(scope).pipe(Effect.provideService(TaxRateSource, source));
    const read = (scope: OperationalScope) =>
      knownTaxRateBook(scope).pipe(Effect.provideService(TaxRateSource, source));
    const answeredAt = yield* DateTime.now;
    expect(yield* write(company)).toEqual({ book: TEST_TAX_BOOK, fetchedAt: answeredAt });
    yield* TestClock.adjust('11 minutes');
    yield* write(company);
    // Within the window the answer keeps the time Tax gave it.
    expect(yield* read(company)).toMatchObject({ fetched: { book: TEST_TAX_BOOK, fetchedAt: answeredAt } });
    expect(yield* Ref.get(calls)).toBe(1);
    // Another company has its own entry.
    yield* write(other);
    expect(yield* Ref.get(calls)).toBe(2);
    // Past the window a read gets no answer from Tax (the stored rates serve) and starts one refresh.
    yield* TestClock.adjust('1 minute');
    expect(yield* read(company)).toEqual({ refused: false, waiting: false });
    yield* Effect.yieldNow;
    expect(yield* Ref.get(calls)).toBe(3);
    expect(yield* read(company)).toMatchObject({ fetched: { fetchedAt: yield* DateTime.now } });
  }),
);

it.effect('never hands over an answer older than 12 minutes, and drops it when Tax refuses the company', () =>
  Effect.gen(function* outage() {
    const outcome = yield* Ref.make<Effect.Effect<TaxRateBook, TaxRatesFailure>>(Effect.succeed(TEST_TAX_BOOK));
    const source = { read: () => Effect.flatten(Ref.get(outcome)) };
    const company = scopeOf(randomUUID());
    const write = currentTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source), Effect.result);
    const read = knownTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source));
    yield* write;
    yield* TestClock.adjust('13 minutes');
    yield* Ref.set(outcome, Effect.fail(new TaxRatesFailure({ kind: 'UNAVAILABLE' })));
    // The refresh fails: the 13-minute-old answer is not Tax's answer any more.
    expect(Result.isFailure(yield* write)).toBe(true);
    expect(yield* read).toMatchObject({ refused: false, waiting: true });
    yield* Ref.set(outcome, Effect.fail(new TaxRatesFailure({ kind: 'REFUSED' })));
    yield* TestClock.adjust('1 minute');
    yield* write;
    expect(yield* read).toMatchObject({ refused: true, waiting: true });
  }),
);

it.effect('while Tax does not answer, reads and writes ask it at most once per wait, which grows to 12 minutes', () =>
  Effect.gen(function* backoff() {
    const calls = yield* Ref.make(0);
    const outcome = yield* Ref.make<TaxRatesFailure['kind']>('UNAVAILABLE');
    const source = {
      read: () =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(Ref.get(outcome)),
          Effect.flatMap((kind) => Effect.fail(new TaxRatesFailure({ kind }))),
        ),
    };
    const company = scopeOf(randomUUID());
    const burst = Effect.all(
      [
        Effect.replicateEffect(knownTaxRateBook(company), 10),
        Effect.replicateEffect(currentTaxRateBook(company).pipe(Effect.result), 10),
      ],
      { concurrency: 1 },
    ).pipe(Effect.provideService(TaxRateSource, source), Effect.andThen(Effect.yieldNow));
    const callsAfter = (wait: Duration.Duration) =>
      TestClock.adjust(wait).pipe(Effect.andThen(burst), Effect.andThen(Ref.get(calls)));
    yield* burst;
    expect(yield* Ref.get(calls)).toBe(1);
    // Waits of 1, 2, 4, 8 and then 12 minutes: a burst just before each ends asks nothing, one right after asks once.
    const asked = [];
    for (const minutes of [1, 2, 4, 8, 12, 12]) {
      asked.push(yield* callsAfter(Duration.seconds(minutes * 60 - 1)), yield* callsAfter(Duration.seconds(1)));
    }
    expect(asked).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7]);
    // A company Tax is not installed for: asked again only after the whole freshness window, writes refused at once.
    yield* Ref.set(outcome, 'REFUSED');
    const other = scopeOf(randomUUID());
    const write = currentTaxRateBook(other).pipe(Effect.provideService(TaxRateSource, source), Effect.flip);
    yield* Ref.set(calls, 0);
    expect((yield* write).kind).toBe('REFUSED');
    expect([(yield* write).kind, yield* Ref.get(calls)]).toEqual(['REFUSED', 1]);
    yield* TestClock.adjust('11 minutes');
    yield* write;
    expect(yield* Ref.get(calls)).toBe(1);
    yield* TestClock.adjust('1 minute');
    yield* write;
    expect(yield* Ref.get(calls)).toBe(2);
  }),
);

it.live('a caller interrupted while it starts the refresh never leaves one that nobody runs', () =>
  Effect.gen(function* interruptedLeader() {
    const source = { read: () => Effect.succeed(TEST_TAX_BOOK) };
    // The first caller may yield every few steps and is interrupted after a growing number of turns, so the
    // interruption lands at every point of starting the refresh (with a budget of 3 steps, after 36 turns it hit
    // between registering the refresh and starting it). A leaked refresh keeps the second caller waiting for nothing.
    const cases = [2, 3, 4, 5].flatMap((budget) =>
      Array.from({ length: 120 }, (_unused, turns) => [budget, turns] as const),
    );
    for (const [budget, turns] of cases) {
      const company = scopeOf(randomUUID());
      const first = yield* Effect.forkChild(
        currentTaxRateBook(company).pipe(
          Effect.provideService(TaxRateSource, source),
          Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
        ),
      );
      yield* Effect.replicateEffect(Effect.yieldNow, turns);
      yield* Fiber.interrupt(first);
      const second = yield* currentTaxRateBook(company).pipe(
        Effect.provideService(TaxRateSource, source),
        Effect.result,
      );
      expect([budget, turns, Result.isSuccess(second)]).toEqual([budget, turns, true]);
    }
  }),
);

const MIGRATED: CompanyTaxRates = {
  book: {
    fingerprint: 'migration:cz.vat.standard=21;cz.vat.reduced=12',
    periods: [
      { code: 'cz.vat.standard', effectiveFrom: at('1970-01-01T00:00:00.000Z'), ratePercent: '21' },
      { code: 'cz.vat.reduced', effectiveFrom: at('1970-01-01T00:00:00.000Z'), ratePercent: '12' },
    ],
    regime: 'VAT_PAYER',
  },
  heldProductRates: { 'book-it': 10 },
  source: 'MIGRATION',
  syncedAt: at('2026-11-12T00:00:00.000Z'),
};
const CONFIRMED: CompanyTaxRates = { book: TEST_TAX_BOOK, source: 'TAX', syncedAt: NOW };
const confirmedMinutesAgo = (minutes: number): CompanyTaxRates => ({
  ...CONFIRMED,
  syncedAt: DateTime.subtract(NOW, { minutes }),
});

/** Tax's answer given at `fetchedAt` (by default now). */
const answered = (book: TaxRateBook, fetchedAt: DateTime.Utc = NOW) => ({
  fetched: { book, fetchedAt },
  refused: false,
});
const unreachable = { refused: false };
const refusedByTax = { refused: true };

it('the migrated state keeps selling until Tax prices the company, and holds BOOK-IT at its stored 10 %', () => {
  // Tax not installed, unreachable, or installed without a regime or without every rule yet: the stored rates serve.
  for (const answer of [
    unreachable,
    refusedByTax,
    answered(testTaxBook(undefined, 'NOT_DECLARED')),
    answered(testTaxBook({ standard: '21' })),
  ]) {
    expect(decideTaxRates(MIGRATED, answer, NOW)).toEqual({
      book: MIGRATED.book,
      changed: false,
      held: { 'book-it': 10 },
      usable: true,
    });
  }
  // The migrated periods name no Tax rule: lines sell at 21 / 12 % without a rule revision.
  expect(resolveVatRate(MIGRATED.book, 'cz.vat.reduced', NOW)).toEqual({ _tag: 'Rate', ratePercent: 12 });
  // Tax's first answer that prices the company replaces it, held rates included.
  expect(decideTaxRates(MIGRATED, answered(TEST_TAX_BOOK), NOW)).toEqual({
    book: TEST_TAX_BOOK,
    changed: true,
    held: {},
    materialise: { book: TEST_TAX_BOOK, source: 'TAX', syncedAt: NOW },
    usable: true,
  });
  const nonPayer = testTaxBook({}, 'NON_PAYER');
  expect(decideTaxRates(MIGRATED, answered(nonPayer), NOW).materialise?.book).toBe(nonPayer);
});

it('once Tax is in charge its answer rules: a gap fails closed, an outage keeps a recently confirmed answer', () => {
  expect(decideTaxRates(confirmedMinutesAgo(5), answered(TEST_TAX_BOOK), NOW)).toEqual({
    book: TEST_TAX_BOOK,
    changed: false,
    held: {},
    materialise: CONFIRMED,
    usable: true,
  });
  const standardOnly = testTaxBook({ standard: '21' });
  const gap = decideTaxRates(confirmedMinutesAgo(5), answered(standardOnly), NOW);
  expect([gap.book, gap.changed, gap.materialise?.source]).toEqual([standardOnly, true, 'TAX']);
  expect(resolveVatRate(standardOnly, 'cz.vat.reduced', NOW)).toEqual({ _tag: 'NotSellable', reason: 'NO_RULE' });
  // Tax unreachable: rates it confirmed within 24 hours still price new lines; older ones are shown, never used.
  const confirmedAt = (hoursAgo: number): CompanyTaxRates => ({
    ...CONFIRMED,
    syncedAt: DateTime.subtract(NOW, { hours: hoursAgo }),
  });
  expect(decideTaxRates(confirmedAt(23), unreachable, NOW)).toMatchObject({ book: TEST_TAX_BOOK, usable: true });
  expect(decideTaxRates(confirmedAt(25), unreachable, NOW)).toMatchObject({ book: TEST_TAX_BOOK, usable: false });
  // Tax refusing a company it was in charge of: nothing is sellable.
  expect(decideTaxRates(CONFIRMED, refusedByTax, NOW)).toEqual({ changed: false, held: {}, usable: false });
  // A company that never had rates takes whatever Tax answers.
  expect(decideTaxRates(undefined, answered(standardOnly), NOW).materialise?.book).toBe(standardOnly);
  expect(decideTaxRates(undefined, refusedByTax, NOW)).toEqual({ changed: false, held: {}, usable: false });
});

it('the confirmation time is when Tax gave the answer, and an older answer never replaces a newer one', () => {
  // The same answer again moves the confirmation to when Tax gave it, not to when it was used.
  const givenAt = DateTime.subtract(NOW, { minutes: 3 });
  expect(decideTaxRates(confirmedMinutesAgo(13), answered(TEST_TAX_BOOK, givenAt), NOW)).toEqual({
    book: TEST_TAX_BOOK,
    changed: false,
    held: {},
    materialise: { book: TEST_TAX_BOOK, source: 'TAX', syncedAt: givenAt },
    usable: true,
  });
  // The stored state is already that answer, or a later one (another process stored it): nothing changes.
  expect(decideTaxRates(CONFIRMED, answered(TEST_TAX_BOOK), NOW)).toEqual({
    book: TEST_TAX_BOOK,
    changed: false,
    held: {},
    usable: true,
  });
  const standardOnly = testTaxBook({ standard: '21' });
  expect(decideTaxRates(CONFIRMED, answered(standardOnly, givenAt), NOW)).toEqual({
    book: TEST_TAX_BOOK,
    changed: false,
    held: {},
    usable: true,
  });
});

it('prices the company only with a non-payer regime or a usable rate for every classification', () => {
  expect(pricesCompany(TEST_TAX_BOOK, NOW)).toBe(true);
  expect(pricesCompany(testTaxBook({}, 'NON_PAYER'), NOW)).toBe(true);
  expect(pricesCompany(testTaxBook({ standard: '21' }), NOW)).toBe(false);
  expect(pricesCompany(testTaxBook(undefined, 'NOT_DECLARED'), NOW)).toBe(false);
});

/** The instant a Czech calendar day starts (Prague midnight), as Finance turns an issue date into Tax's instant. */
const pragueMidnight = (year: number, month: number, day: number) =>
  Option.getOrThrow(
    DateTime.makeZoned(
      { day, hour: 0, millisecond: 0, minute: 0, month, second: 0, year },
      { adjustForTimeZone: true, timeZone: 'Europe/Prague' },
    ).pipe(Option.map(DateTime.toUtc)),
  );
const ruleFrom = (start: DateTime.Utc, ratePercent: string): TaxRateBook => ({
  fingerprint: `test:from-${DateTime.formatIso(start)}`,
  periods: [
    {
      code: 'cz.vat.standard',
      effectiveFrom: TEST_SINCE,
      effectiveTo: start,
      ratePercent: '21',
      taxRuleRevisionId: revision('standard-21'),
    },
    { code: 'cz.vat.standard', effectiveFrom: start, ratePercent, taxRuleRevisionId: revision('standard-new') },
  ],
  regime: 'VAT_PAYER',
});

it('a rule starting at Prague midnight applies from that Czech day, in winter and across a DST change', () => {
  // 1 January 2027 (CET, UTC+1): the day starts at 23:00 UTC the evening before.
  const newYear = pragueMidnight(2027, 1, 1);
  expect(DateTime.formatIso(newYear)).toBe('2026-12-31T23:00:00.000Z');
  const winter = ruleFrom(newYear, '23');
  expect(resolveVatRate(winter, 'cz.vat.standard', DateTime.subtract(newYear, { milliseconds: 1 }))).toMatchObject({
    ratePercent: 21,
  });
  expect(resolveVatRate(winter, 'cz.vat.standard', newYear)).toMatchObject({ ratePercent: 23 });
  // 29 March 2027, the day after clocks go forward (CEST, UTC+2): the day starts at 22:00 UTC.
  const afterSwitch = pragueMidnight(2027, 3, 29);
  expect(DateTime.formatIso(afterSwitch)).toBe('2027-03-28T22:00:00.000Z');
  const summer = ruleFrom(afterSwitch, '23');
  // 23:30 UTC on 28 March is already 29 March in Prague: the new rate; an hour earlier it is still 28 March.
  expect(resolveVatRate(summer, 'cz.vat.standard', at('2027-03-28T23:30:00.000Z'))).toMatchObject({ ratePercent: 23 });
  expect(resolveVatRate(summer, 'cz.vat.standard', at('2027-03-28T21:30:00.000Z'))).toMatchObject({ ratePercent: 21 });
  // A whole Czech day of 23 hours (28 March) keeps the old rate up to its last millisecond.
  expect(resolveVatRate(summer, 'cz.vat.standard', DateTime.subtract(afterSwitch, { milliseconds: 1 }))).toMatchObject({
    ratePercent: 21,
  });
});

it("a staff read shows one whole state: the stored one, the one it stored, or Tax's while nothing is stored", () => {
  const newer = testTaxBook({ reduced: '12', standard: '23' });
  const takeover = decideTaxRates(MIGRATED, answered(newer), NOW);
  // Stored by this read: the new state, with its own source and confirmation time.
  expect(shownTaxRates(MIGRATED, takeover, true)).toEqual({ book: newer, source: 'TAX', syncedAt: NOW });
  // Storing skipped (a write holds the company): the stored state, never Tax's rates beside the stored source.
  expect(shownTaxRates(MIGRATED, takeover, false)).toBe(MIGRATED);
  // Nothing stored at all (no head row yet): Tax's answer, stated as Tax's with the time Tax gave it.
  expect(shownTaxRates(undefined, decideTaxRates(undefined, answered(newer), NOW), false)).toEqual({
    book: newer,
    source: 'TAX',
    syncedAt: NOW,
  });
  // No answer: the stored state; Tax refusing a company it was in charge of: nothing.
  expect(shownTaxRates(CONFIRMED, decideTaxRates(CONFIRMED, unreachable, NOW), false)).toBe(CONFIRMED);
  expect(shownTaxRates(CONFIRMED, decideTaxRates(CONFIRMED, refusedByTax, NOW), false)).toBeUndefined();
});

/** A refusal of the call as the Shell or Tax answers it (problem details). */
const problem = (tag: string, status: number, type: string) => ({
  _tag: tag,
  detail: 'Refused',
  status,
  title: 'Refused',
  type,
});

it('only the Shell saying Tax is not installed for the tenant reads as not installed; every other refusal is an outage', () => {
  expect(taxCallFailureOf(problem('GatewayForbiddenProblem', 403, GATEWAY_MODULE_NOT_INSTALLED_TYPE))).toMatchObject({
    kind: 'REFUSED',
  });
  // A retired or wrong module credential, another release, a requester not admitted, and Tax installed but suspended,
  // quarantined, inactive or archived for the tenant (`audience_module_not_active`): the Shell's plain 403, an outage.
  expect(
    taxCallFailureOf(problem('GatewayForbiddenProblem', 403, 'https://ontos.dev/problems/gateway-forbidden')),
  ).toMatchObject({
    kind: 'UNAVAILABLE',
    refusal: 'GatewayForbiddenProblem 403 https://ontos.dev/problems/gateway-forbidden',
  });
  // A missing module credential: the Shell asks for authentication.
  expect(
    taxCallFailureOf(problem('GatewayAuthenticationRequiredProblem', 401, 'https://ontos.dev/problems/auth')),
  ).toMatchObject({
    kind: 'UNAVAILABLE',
    refusal: 'GatewayAuthenticationRequiredProblem 401 https://ontos.dev/problems/auth',
  });
  // Tax itself not admitting the caller or not finding what was asked.
  for (const refused of [
    problem('ApplicableTaxRuleSetForbiddenProblem', 403, 'about:blank'),
    problem('TaxRuleHistoryNotFoundProblem', 404, 'about:blank'),
  ]) {
    expect(taxCallFailureOf(refused).kind).toBe('UNAVAILABLE');
  }
  // No module credential configured at all, or no answer: an outage without a refusal.
  expect(taxCallFailureOf(new Error('Gateway delegation transport is unavailable'))).toEqual(
    expect.objectContaining({ kind: 'UNAVAILABLE' }),
  );
  expect(taxCallFailureOf(new Error('timeout')).refusal).toBeUndefined();
});

it.effect(
  'a refresh that dies counts as an attempt without an answer: waiters get unavailable, the wait is recorded',
  () =>
    Effect.gen(function* defect() {
      const calls = yield* Ref.make(0);
      const source = {
        read: () => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.die('Tax client bug'))),
      };
      const company = scopeOf(randomUUID());
      const write = currentTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source), Effect.flip);
      expect((yield* write).kind).toBe('UNAVAILABLE');
      // The wait after it runs: the next write fails at once without asking Tax again.
      expect((yield* write).kind).toBe('UNAVAILABLE');
      expect(yield* Ref.get(calls)).toBe(1);
      yield* TestClock.adjust('1 minute');
      yield* write;
      expect(yield* Ref.get(calls)).toBe(2);
    }),
);

it.effect('an explicit sync that fails during an outage leaves the automatic wait as it was', () =>
  Effect.gen(function* explicitSync() {
    const calls = yield* Ref.make(0);
    const source = {
      read: () =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(Effect.fail(new TaxRatesFailure({ kind: 'UNAVAILABLE' }))),
        ),
    };
    const company = scopeOf(randomUUID());
    const read = knownTaxRateBook(company).pipe(
      Effect.provideService(TaxRateSource, source),
      Effect.andThen(Effect.yieldNow),
    );
    yield* read;
    // The automatic attempt failed: the next one is due a minute later.
    yield* TestClock.adjust('30 seconds');
    yield* refreshedTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source), Effect.result);
    expect(yield* Ref.get(calls)).toBe(2);
    yield* TestClock.adjust('30 seconds');
    yield* read;
    expect(yield* Ref.get(calls)).toBe(3);
  }),
);

it('a stored confirmation time ahead of the clock never keeps a newer answer of Tax out', () => {
  const ahead: CompanyTaxRates = { ...CONFIRMED, syncedAt: DateTime.add(NOW, { hours: 2 }) };
  const newer = testTaxBook({ reduced: '12', standard: '23' });
  expect(decideTaxRates(ahead, answered(newer), NOW)).toMatchObject({
    book: newer,
    changed: true,
    materialise: { book: newer, source: 'TAX', syncedAt: NOW },
  });
});

it.effect('the confirmation time is the instant Tax was asked, not when its slow answer arrived', () =>
  Effect.gen(function* askedAt() {
    const { release, source } = yield* gatedSource;
    const company = scopeOf(randomUUID());
    const asked = yield* DateTime.now;
    const sync = yield* Effect.forkChild(
      refreshedTaxRateBook(company).pipe(Effect.provideService(TaxRateSource, source)),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust('2 seconds');
    yield* Deferred.succeed(release, TEST_TAX_BOOK);
    expect(yield* Fiber.join(sync)).toEqual({ book: TEST_TAX_BOOK, fetchedAt: asked });
  }),
);

it.effect('a module that holds no module credential reads as an outage that names it, before any request', () =>
  Effect.gen(function* noModuleKey() {
    const failure = yield* fetchTaxRateBook(scopeOf(randomUUID())).pipe(
      Effect.flip,
      Effect.provide(NodeCrypto.layer),
      // The host handed this process no key of Merchandise; the Shell's address is set, but no request may be sent.
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ONTOS_SHELL_GATEWAY_BASE_URL: 'http://shell.test/api' }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, () => Promise.reject(new Error('No request may be sent'))),
    );
    expect([failure.kind, failure.refusal]).toEqual([
      'UNAVAILABLE',
      'GatewayDelegationSourceError: No module credential of merchandise in this process: the host has not handed one over',
    ]);
  }),
);
