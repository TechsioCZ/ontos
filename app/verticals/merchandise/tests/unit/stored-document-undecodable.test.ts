// A stored Merchandise document that does not decode on a read: the read stays unavailable, and one WARN per company and
// document per minute names the module, tenant, company, document, field path and reason, never a value of the
// document (it may hold prices).
import { Effect, Logger, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { storedDocumentUndecodable } from '../../src/services/merchandise-store.ts';
import { CompanyTaxRatesSchema } from '../../src/services/tax-rates.ts';

const scope = {
  legalEntityId: '31000000-0000-4000-8000-000000000011',
  tenantId: '21000000-0000-4000-8000-000000000011',
};
/** As stage stored it: the migrated state with `"heldProductRates": null`, and a price-like value elsewhere. */
const stored = {
  book: { fingerprint: 'migration', periods: [], regime: 'VAT_PAYER' },
  heldProductRates: null,
  source: 'MIGRATION',
  syncedAt: '2026-11-13T13:06:00.000Z',
};

const LineSchema = Schema.Struct({ annotations: Schema.Json, level: Schema.String, message: Schema.Json });

it.effect('a stored document that does not decode answers unavailable with one WARN a minute per company', () =>
  Effect.gen(function* undecodable() {
    const lines: string[] = [];
    const capture = Logger.make((options) => {
      lines.push(JSON.stringify(Logger.formatStructured.log(options)));
    });
    const read = Schema.decodeUnknownEffect(CompanyTaxRatesSchema)(stored).pipe(
      Effect.tapError(storedDocumentUndecodable(scope, 'catalog_heads.tax_rates')),
      Effect.flip,
      Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
    );
    const failure = yield* read;
    // The read keeps its failure: the caller maps it to unavailable, exactly as before.
    expect(Schema.isSchemaError(failure)).toBe(true);
    // Three more reads within the minute: still unavailable, nothing more logged.
    yield* TestClock.adjust('20 seconds');
    yield* read;
    yield* read;
    yield* read;
    expect(lines).toHaveLength(1);
    // A minute after the first line, the next failure logs once, counting the ones it stands for.
    yield* TestClock.adjust('41 seconds');
    yield* read;
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(LineSchema))(line));
    expect(first?.level).toBe('WARN');
    expect(first?.annotations).toEqual({
      company: scope.legalEntityId,
      document: 'catalog_heads.tax_rates',
      failures: 1,
      issues: [{ path: 'heldProductRates', reason: expect.stringMatching(/^Expected /u) }],
      module: 'demo.merchandise',
      tenant: scope.tenantId,
    });
    expect(second?.annotations).toMatchObject({ failures: 4 });
    // No value of the document reaches the line.
    expect(lines.join('\n')).not.toContain('got null');
    expect(lines.join('\n')).not.toContain('migration');
  }),
);
