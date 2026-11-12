// A 25-hour Tax outage on the test clock, through the same steps a staff read and a write take: what this process
// knows from Tax (`prepareStaffTaxRates`, `prepareCommandTax`), the decision against the company's stored rates
// (`decideTaxRates`), and the notice staff see. The confirmation time stays at Tax's last real answer however often the
// company is read, the notice says so, and a new price is refused once that answer is older than 24 hours.
import { randomUUID } from 'node:crypto';

import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Duration, Effect, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { companyVatOf, taxLabelsOf } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { prepareCommandTax, prepareStaffTaxRates, priceRefusalOf } from '../../src/services/persistence.service.ts';
import type { PreparedTax } from '../../src/services/persistence.service.ts';
import { TaxRateSource, TaxRatesFailure, decideTaxRates, taxRateViews } from '../../src/services/tax-rates.ts';
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

it.effect('a 25-hour outage keeps the confirmation at the last answer and refuses new prices after 24 hours', () =>
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
    /** One staff read: Tax's answer as known, decided against the stored rates, materialised when the decision says. */
    const staffRead = Effect.gen(function* staffRead() {
      const prepared = yield* prepareStaffTaxRates(company);
      const decision = decideTaxRates((yield* Ref.get(stored)).state, answerOf(prepared), yield* DateTime.now);
      if (decision.materialise !== undefined) {
        yield* Ref.set(stored, { state: decision.materialise });
      }
      yield* Effect.yieldNow;
    }).pipe(Effect.provideService(TaxRateSource, source));
    /** Whether a write entering a new price may price it now. */
    const newPriceUsable = Effect.gen(function* newPriceUsable() {
      const prepared = yield* prepareCommandTax(newPrice, company);
      return decideTaxRates((yield* Ref.get(stored)).state, answerOf(prepared), yield* DateTime.now).usable;
    }).pipe(Effect.provideService(TaxRateSource, source));

    yield* staffRead;
    yield* Effect.yieldNow;
    yield* staffRead;
    const answeredAt = yield* DateTime.now;
    expect((yield* Ref.get(stored)).state?.syncedAt).toEqual(answeredAt);
    yield* Ref.set(down, true);
    // Read every 10 minutes for 23 h 50 min: a new price is still priced at the rates confirmed then.
    for (const _read of Array.from({ length: 143 })) {
      yield* TestClock.adjust('10 minutes');
      yield* staffRead;
    }
    expect(yield* newPriceUsable).toBe(true);
    for (const _read of Array.from({ length: 7 })) {
      yield* TestClock.adjust('10 minutes');
      yield* staffRead;
    }
    const now = yield* DateTime.now;
    expect(Duration.equals(DateTime.distance(answeredAt, now), Duration.hours(25))).toBe(true);
    const { state } = yield* Ref.get(stored);
    expect(state?.syncedAt).toEqual(answeredAt);
    // Staff are told when Tax last confirmed the rates, and a new price is refused.
    const shown = companyVatOf({
      sellerVatRegime: 'VAT_PAYER',
      taxRates: taxRateViews(TEST_TAX_BOOK, now),
      taxRatesConfirmedAt: state?.syncedAt ?? null,
      taxRatesSource: state?.source ?? null,
    });
    expect(taxLabelsOf(translateIn('cs')).confirmation(shown, now)).toContain(
      'Sazby DPH naposledy potvrdil modul Daně',
    );
    expect(yield* newPriceUsable).toBe(false);
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
