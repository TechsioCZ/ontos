// A 25-hour Tax outage on the test clock, through the same steps a staff read and a write take: what this process
// knows from Tax (`prepareStaffTaxRates`, `prepareCommandTax`), the decision against the company's stored rates
// (`decideTaxRates`), the staff response's VAT fields (`staffTaxFields`) as the screens read them, and the notice they
// show. The confirmation time stays at Tax's last real answer however often the company is read and across a restart of
// the process, the notice says so, a new price is refused once that answer is older than 24 hours, and all of it ends
// when Tax answers again.
import { randomUUID } from 'node:crypto';

import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Duration, Effect, Logger, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { companyVatOf, taxLabelsOf } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import {
  prepareCommandTax,
  prepareStaffTaxRates,
  priceRefusalOf,
  staffTaxFields,
} from '../../src/services/persistence.service.ts';
import type { PreparedTax } from '../../src/services/persistence.service.ts';
import { TaxRateSource, TaxRatesFailure, decideTaxRates, shownTaxRates } from '../../src/services/tax-rates.ts';
import type { CompanyTaxRates } from '../../src/services/tax-rates.ts';
import { TEST_TAX_BOOK } from '../support/tax-fixtures.ts';
import { translateIn } from './merchandise-translate.ts';

const company: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: randomUUID(),
    authContextRef: 'session:tax-outage-clock',
    authMethod: 'session',
    legalEntityId: randomUUID(),
    principalId: randomUUID(),
    tenantId: randomUUID(),
  }),
  correlationId: 'tax-outage-clock',
};

const newPrice = Schema.decodeSync(MerchandiseCommandPayloadSchema)({
  command: {
    _tag: 'CreateProduct',
    active: true,
    category: 'Šrouby',
    lowStockThreshold: 0,
    name: 'Nový šroub',
    priceMinor: 1000,
    sku: 'NEW-1',
    taxClassificationCode: 'cz.vat.standard',
    unit: 'ks',
  },
  expectedRevision: 1,
}).command;

const answerOf = (tax: PreparedTax) =>
  tax.fetched === undefined ? { refused: tax.refused } : { fetched: tax.fetched, refused: tax.refused };

it.effect('a 25-hour outage, a restart and the recovery, as staff see them and as a new price is priced', () =>
  Effect.gen(function* outage() {
    const down = yield* Ref.make(false);
    const source = {
      read: () =>
        Ref.get(down).pipe(
          Effect.flatMap((isDown) =>
            isDown ? Effect.fail(new TaxRatesFailure({ kind: 'UNAVAILABLE' })) : Effect.succeed(TEST_TAX_BOOK),
          ),
        ),
    };
    const stored = yield* Ref.make<{ readonly state?: CompanyTaxRates }>({});
    // The company as this process knows it; a restart is a process that knows nothing of it yet.
    const process = yield* Ref.make(company);
    const labels = taxLabelsOf(translateIn('cs'));
    /**
     * One staff read as the records read answers it: Tax's answer as known, decided against the stored rates and
     * stored, then the response's VAT fields (`staffTaxFields`) as the screens read them, with the notice they show.
     */
    const staffRead = Effect.gen(function* staffRead() {
      const now = yield* DateTime.now;
      const before = (yield* Ref.get(stored)).state;
      const decision = decideTaxRates(before, answerOf(yield* prepareStaffTaxRates(yield* Ref.get(process))), now);
      if (decision.materialise !== undefined) {
        yield* Ref.set(stored, { state: decision.materialise });
      }
      yield* Effect.yieldNow;
      const vat = companyVatOf(staffTaxFields(shownTaxRates(before, decision, true), now));
      return { notice: labels.confirmation(vat, now), vat };
    }).pipe(Effect.provideService(TaxRateSource, source));
    /** Whether a write entering a new price may price it now. */
    const newPriceUsable = Effect.gen(function* newPriceUsable() {
      const prepared = yield* prepareCommandTax(newPrice, yield* Ref.get(process));
      return decideTaxRates((yield* Ref.get(stored)).state, answerOf(prepared), yield* DateTime.now).usable;
    }).pipe(Effect.provideService(TaxRateSource, source));
    const readEvery10MinutesFor = (reads: number) =>
      Effect.forEach(
        Array.from({ length: reads }),
        () => TestClock.adjust('10 minutes').pipe(Effect.andThen(staffRead)),
        {
          concurrency: 1,
        },
      );

    yield* staffRead;
    const answeredAt = yield* DateTime.now;
    expect((yield* staffRead).vat.confirmedAt).toEqual(answeredAt);
    yield* Ref.set(down, true);
    // Read every 10 minutes for 23 h 50 min: a new price is still priced at the rates confirmed then.
    yield* readEvery10MinutesFor(143);
    expect(yield* newPriceUsable).toBe(true);
    // The process restarts during the outage: it knows nothing of Tax, the stored state still says when Tax last
    // confirmed the rates.
    yield* Ref.set(process, { ...company, legalEntityId: randomUUID() });
    yield* readEvery10MinutesFor(7);
    const now = yield* DateTime.now;
    expect(Duration.equals(DateTime.distance(answeredAt, now), Duration.hours(25))).toBe(true);
    const during = yield* staffRead;
    expect([during.vat.source, during.vat.confirmedAt]).toEqual(['TAX', answeredAt]);
    expect(during.notice).toContain('Sazby DPH naposledy potvrdil modul Daně');
    expect(yield* newPriceUsable).toBe(false);
    // Tax answers again: once the wait after the last attempt passed, a read takes the answer, the notice goes, and
    // a new price is priced again.
    yield* Ref.set(down, false);
    yield* TestClock.adjust('12 minutes');
    yield* staffRead;
    const recovered = yield* staffRead;
    expect(recovered.notice).toBeUndefined();
    expect(
      recovered.vat.confirmedAt === undefined ? false : DateTime.isGreaterThan(recovered.vat.confirmedAt, now),
    ).toBe(true);
    expect(yield* newPriceUsable).toBe(true);
  }),
);

it('a new price is refused while Tax does not answer and no usable rates exist, with the reason that fits', () => {
  const now = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');
  const reasonOf = (stored: CompanyTaxRates | undefined, refused: boolean) =>
    Option.getOrUndefined(priceRefusalOf(decideTaxRates(stored, { refused }, now), refused));
  // Nothing stored and Tax does not answer: refused (before, the price was stored without a gross).
  expect(reasonOf(undefined, false)).toContain('firma zatím nemá žádné sazby DPH');
  // Tax not installed for the company: the price saves without a gross; nothing of it sells.
  expect(reasonOf(undefined, true)).toBeUndefined();
  const confirmed = (hoursAgo: number): CompanyTaxRates => ({
    book: TEST_TAX_BOOK,
    source: 'TAX',
    syncedAt: DateTime.subtract(now, { hours: hoursAgo }),
  });
  expect(reasonOf(confirmed(25), false)).toContain('starší než 24 hodin');
  expect(reasonOf(confirmed(23), false)).toBeUndefined();
});

it.effect('a new price during the wait after a failed attempt says Tax was not asked, and when it will be', () =>
  Effect.gen(function* waitLog() {
    const entries: string[] = [];
    const scope = { ...company, legalEntityId: randomUUID() };
    const source = { read: () => Effect.fail(new TaxRatesFailure({ kind: 'UNAVAILABLE' })) };
    const prepare = prepareCommandTax(newPrice, scope).pipe(
      Effect.provideService(TaxRateSource, source),
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            entries.push(String(options.message));
          }),
        ]),
      ),
    );
    yield* prepare;
    expect(entries.join(' ')).toContain('could not read VAT rates from Tax');
    entries.length = 0;
    yield* TestClock.adjust('10 seconds');
    yield* prepare;
    expect(entries.join(' ')).not.toContain('could not read VAT rates from Tax');
    expect(entries.join(' ')).toContain('Tax was not asked, next attempt at');
  }),
);
