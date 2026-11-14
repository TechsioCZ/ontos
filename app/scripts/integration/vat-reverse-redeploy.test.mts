// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * Rollback, third part: the new release deploys again on the database the release before classifications rewrote
 * (`tests/vat-reverse.old-release.mts` wrote what it then charged and how the window trigger classified and held each
 * product). Every product is classified from the rate the old release wrote (21 standard, 10 or 12 reduced), no hold is
 * added by its rewrite, and the new release sells
 * every product and variant at exactly what the old release charged: no price changes on the way back. It runs only
 * inside the rehearsal (`ONTOS_VAT_REVERSE_REPORT`).
 */
import { readFileSync } from 'node:fs';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { Config, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { LegalEntityIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { merchandiseRelations } from '../../verticals/merchandise/src/database/schema.ts';
import { currentPricingOf, loadProducts } from '../../verticals/merchandise/src/services/merchandise-store.ts';
import { stockLevelsOf, toProductRecord } from '../../verticals/merchandise/src/services/stock-levels.ts';

const PricesSchema = Schema.Record(Schema.String, Schema.Array(Schema.OptionFromNullOr(Schema.Number)));
const RollbackSchema = Schema.Struct({
  chargedAfter: PricesSchema,
  classified: Schema.Array(Schema.Struct({ classification: Schema.String, id: Schema.String, rate: Schema.Number })),
  held: Schema.OptionFromNullOr(Schema.Record(Schema.String, Schema.Number)),
  source: Schema.OptionFromNullOr(Schema.String),
});
const ReportSchema = Schema.Struct({ companyId: LegalEntityIdSchema, tenantId: TenantIdSchema });

it.live('the new release deployed again sells everything at what the old release charged after the rollback', () =>
  Effect.gen(function* redeployAfterRollback() {
    const reportPath = yield* Config.option(Config.String('ONTOS_VAT_REVERSE_REPORT'));
    if (Option.isNone(reportPath)) {
      return yield* Effect.logWarning('Not run: the VAT deploy rehearsal sets ONTOS_VAT_REVERSE_REPORT');
    }
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReportSchema))(
      readFileSync(reportPath.value, 'utf-8'),
    );
    const rollback = Schema.decodeUnknownSync(Schema.fromJsonString(RollbackSchema))(
      readFileSync(`${reportPath.value}.rollback.json`, 'utf-8'),
    );
    // The window trigger classified every product the old release rewrote from the rate it wrote.
    for (const row of rollback.classified) {
      expect([row.id, row.rate, row.classification]).toEqual([
        row.id,
        row.rate,
        row.rate === 21 ? 'cz.vat.standard' : 'cz.vat.reduced',
      ]);
    }
    // A rewrite never adds a hold: once Tax priced the company there are none; while migrated only products held since
    // before the deploy and written at 10 % again keep theirs.
    if (Option.contains(rollback.source, 'MIGRATION')) {
      const tenPercent = new Set(rollback.classified.filter((row) => row.rate === 10).map((row) => row.id));
      expect(Object.keys(Option.getOrElse(rollback.held, () => ({}))).filter((id) => !tenPercent.has(id))).toEqual([]);
    } else {
      expect(Option.isNone(rollback.held)).toBe(true);
    }

    // The new release reads that state and sells at exactly what the old release charged.
    const connections = yield* loadDatabaseConnectionPair();
    const adminDb = yield* makeTestDatabaseFromClient(
      yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 }),
      merchandiseRelations,
    );
    const scope = { legalEntityId: report.companyId, tenantId: report.tenantId };
    const { held, rates } = yield* currentPricingOf(adminDb, scope);
    const loaded = yield* loadProducts(adminDb, scope, undefined, { variants: true });
    const selling = Object.fromEntries(
      loaded.map(({ product }) => {
        const record = toProductRecord(product, stockLevelsOf([], product.id), rates, held);
        return [
          product.id,
          [
            Option.fromNullishOr(record.grossPriceMinor),
            ...(record.variantRecords ?? []).map((entry) => Option.fromNullishOr(entry.grossPriceMinor)),
          ],
        ];
      }),
    );
    for (const [id, charged] of Object.entries(rollback.chargedAfter)) {
      expect([id, selling[id]]).toEqual([id, charged]);
    }
    return yield* Effect.void;
  }),
);
