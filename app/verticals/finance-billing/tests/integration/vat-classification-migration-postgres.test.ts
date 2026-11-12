/*
 * The VAT classification migration on PostgreSQL, run on a private temporary copy of the Finance state table inside
 * one transaction (the shared database is never migrated). Its rows follow what Finance holds on stage: an
 * Obchodní firma ledger with 21 % lines and documents mixing 10 % and 21 % lines, a Nájempark ledger with 21 % rent
 * lines and one 21 % price-list item, and no recurring templates. Ledgers nobody could read are covered by a row
 * with every odd stored value the migration might meet. The only change allowed is naming the classification of a
 * numeric 21 % or 12 % rate; every rate, amount, total and VAT recap stays exactly as stored. Its functions and trigger
 * are created in the session's own schema, so nothing outlives the test. The release still serving rewrites a whole
 * ledger without the classifications it does not know: the trigger classifies that write exactly as the backfill did.
 */
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, FileSystem, Path, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

const MIGRATION = 'drizzle/20261112010615_vat-classification/migration.sql';
const PROBE_TABLE = 'pg_temp.finance_states_vat_probe';

interface Ledger {
  readonly after: string;
  readonly before: string;
  readonly name: string;
}

/** Each stored ledger and exactly what it must hold after the migration, as JSON. */
const ledgers: readonly Ledger[] = [
  {
    after: `{"financialPlanEntries":[],"invoices":[
      {"number":"FV-2026-0001","businessState":"CONFIRMED","subtotalMinor":190000,"vatMinor":39900,"totalMinor":229900,
       "vatRecap":[{"rate":21,"baseMinor":190000,"vatMinor":39900}],
       "lines":[{"description":"Notebook","quantity":1,"unitPriceMinor":100000,"vatRate":21,"vatClassification":"cz.vat.standard"},
                {"description":"Monitor","quantity":1,"unitPriceMinor":100000,"vatRate":21,"vatClassification":"cz.vat.standard",
                 "discount":{"kind":"PERCENT","reason":"Akce","value":10}}]},
      {"number":"FV-2026-0004","businessState":"CONFIRMED","subtotalMinor":200000,"vatMinor":31000,"totalMinor":231000,
       "vatRecap":[{"rate":21,"baseMinor":100000,"vatMinor":21000},{"rate":10,"baseMinor":100000,"vatMinor":10000}],
       "lines":[{"description":"Kniha","quantity":1,"unitPriceMinor":100000,"vatRate":10},
                {"description":"Kabel","quantity":1,"unitPriceMinor":100000,"vatRate":21,"vatClassification":"cz.vat.standard"}]}]}`,
    before: `{"financialPlanEntries":[],"invoices":[
      {"number":"FV-2026-0001","businessState":"CONFIRMED","subtotalMinor":190000,"vatMinor":39900,"totalMinor":229900,
       "vatRecap":[{"rate":21,"baseMinor":190000,"vatMinor":39900}],
       "lines":[{"description":"Notebook","quantity":1,"unitPriceMinor":100000,"vatRate":21},
                {"description":"Monitor","quantity":1,"unitPriceMinor":100000,"vatRate":21,
                 "discount":{"kind":"PERCENT","reason":"Akce","value":10}}]},
      {"number":"FV-2026-0004","businessState":"CONFIRMED","subtotalMinor":200000,"vatMinor":31000,"totalMinor":231000,
       "vatRecap":[{"rate":21,"baseMinor":100000,"vatMinor":21000},{"rate":10,"baseMinor":100000,"vatMinor":10000}],
       "lines":[{"description":"Kniha","quantity":1,"unitPriceMinor":100000,"vatRate":10},
                {"description":"Kabel","quantity":1,"unitPriceMinor":100000,"vatRate":21}]}]}`,
    name: 'trading company with 21 % lines and mixed 10 % documents',
  },
  {
    after: `{"financialPlanEntries":[],"invoices":[
      {"number":"FV-2026-0101","businessState":"CONFIRMED","subtotalMinor":4500000,"vatMinor":945000,"totalMinor":5445000,
       "vatRecap":[{"rate":21,"baseMinor":4500000,"vatMinor":945000}],
       "lines":[{"description":"Nájemné R101 – říjen 2026","quantity":1,"unitPriceMinor":4500000,"vatRate":21,
                 "vatClassification":"cz.vat.standard"}]}],
      "priceList":[{"active":true,"id":"price-office-rent","name":"Nájem kanceláře","unitPriceMinor":1850050,"vatRate":21,
                    "vatClassification":"cz.vat.standard"}]}`,
    before: `{"financialPlanEntries":[],"invoices":[
      {"number":"FV-2026-0101","businessState":"CONFIRMED","subtotalMinor":4500000,"vatMinor":945000,"totalMinor":5445000,
       "vatRecap":[{"rate":21,"baseMinor":4500000,"vatMinor":945000}],
       "lines":[{"description":"Nájemné R101 – říjen 2026","quantity":1,"unitPriceMinor":4500000,"vatRate":21}]}],
      "priceList":[{"active":true,"id":"price-office-rent","name":"Nájem kanceláře","unitPriceMinor":1850050,"vatRate":21}]}`,
    name: 'rental company with 21 % rent lines and a 21 % price-list item, no recurring templates',
  },
  {
    after: `{"financialPlanEntries":[],"invoices":[
      {"number":"FV-2026-0201","subtotalMinor":1,"vatMinor":0,"totalMinor":1,"lines":[
        {"vatRate":12,"vatClassification":"cz.vat.reduced"},{"vatRate":0},{"vatRate":15},{"vatRate":10.5},{"vatRate":"21"},
        {"vatRate":null},{"vatRate":21.0,"vatClassification":"cz.vat.standard"},{"description":"Bez sazby"},
        {"vatRate":21,"vatClassification":"cz.vat.reduced"},{"vatRate":0,"vatTreatment":"EXEMPT"},"not a line",[21]]},
      {"number":"FV-2026-0202","totalMinor":5,"lines":{"vatRate":21}},
      {"number":"FV-2026-0203","totalMinor":7},
      "not an invoice"],
      "priceList":[{"vatRate":12,"vatClassification":"cz.vat.reduced"},{"vatRate":"12"},"not an item"],
      "recurringTemplates":[{"name":"Nájem","lines":[{"vatRate":21,"vatClassification":"cz.vat.standard"},{"vatRate":10}]},
                            {"name":"Bez řádků"}]}`,
    before: `{"financialPlanEntries":[],"invoices":[
      {"number":"FV-2026-0201","subtotalMinor":1,"vatMinor":0,"totalMinor":1,"lines":[
        {"vatRate":12},{"vatRate":0},{"vatRate":15},{"vatRate":10.5},{"vatRate":"21"},
        {"vatRate":null},{"vatRate":21.0},{"description":"Bez sazby"},
        {"vatRate":21,"vatClassification":"cz.vat.reduced"},{"vatRate":0,"vatTreatment":"EXEMPT"},"not a line",[21]]},
      {"number":"FV-2026-0202","totalMinor":5,"lines":{"vatRate":21}},
      {"number":"FV-2026-0203","totalMinor":7},
      "not an invoice"],
      "priceList":[{"vatRate":12},{"vatRate":"12"},"not an item"],
      "recurringTemplates":[{"name":"Nájem","lines":[{"vatRate":21},{"vatRate":10}]},{"name":"Bez řádků"}]}`,
    name: 'unknown ledger with every odd stored value',
  },
  {
    after: '{"financialPlanEntries":[],"invoices":"legacy","priceList":null}',
    before: '{"financialPlanEntries":[],"invoices":"legacy","priceList":null}',
    name: 'ledger whose parts are not lists',
  },
];

const ComparisonSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    revision: Schema.Number,
    rewritten_wanted: Schema.Boolean,
    unchanged_after_rerun: Schema.Boolean,
    wanted: Schema.Boolean,
  }),
);

const migrateProbe = Effect.fn('VatClassificationMigration.probe')(function* migrateProbe(probe: string) {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) }).pipe(
    Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make),
  );
  return yield* admin.withTransaction(
    Effect.gen(function* inTransaction() {
      // A session-private table of the same shape, dropped with the transaction.
      yield* admin.unsafe(
        'create temp table finance_states_vat_probe (tenant_id uuid, legal_entity_id uuid, name text, revision integer, state jsonb not null, wanted jsonb not null) on commit drop',
      );
      for (const ledger of ledgers) {
        yield* admin.unsafe(
          `insert into ${PROBE_TABLE} (tenant_id, legal_entity_id, name, revision, state, wanted) values (gen_random_uuid(), gen_random_uuid(), $1, 7, $2::jsonb, $3::jsonb)`,
          [ledger.name, ledger.before, ledger.after],
        );
      }
      // One statement per query, as the migrator sends them.
      for (const statement of probe.split('--> statement-breakpoint')) {
        yield* admin.unsafe(statement);
      }
      yield* admin.unsafe(
        `create temp table finance_states_vat_once on commit drop as select name, state from ${PROBE_TABLE}`,
      );
      // A second backfill through the same function finds nothing left to name and changes no row.
      yield* admin.unsafe(`update ${PROBE_TABLE} set state = pg_temp.vat_classified_state(state)`);
      yield* admin.unsafe(
        `create temp table finance_states_vat_twice on commit drop as select name, state from ${PROBE_TABLE}`,
      );
      // The old release rewrites each ledger as it knew it, without any classification: the trigger classifies it.
      for (const ledger of ledgers) {
        yield* admin.unsafe(`update ${PROBE_TABLE} set state = $2::jsonb where name = $1`, [
          ledger.name,
          ledger.before,
        ]);
      }
      return yield* admin.unsafe(
        `select probe.name, probe.revision, once.state = probe.wanted as wanted,
                twice.state = once.state as unchanged_after_rerun, probe.state = probe.wanted as rewritten_wanted
           from ${PROBE_TABLE} as probe
           join pg_temp.finance_states_vat_once as once using (name)
           join pg_temp.finance_states_vat_twice as twice using (name)
          order by probe.name`,
      );
    }),
  );
});

it.layer(NodeServices.layer, { excludeTestServices: true })('VAT classification migration', (suite) => {
  suite.effect(
    'names the classification of stored 21 % and 12 % rates and changes nothing else, for any stored value',
    () =>
      Effect.scoped(
        Effect.gen(function* vatClassificationMigration() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const migration = yield* fs.readFileString(path.join(import.meta.dirname, '..', '..', MIGRATION));
          expect(migration).toContain('"finance_billing"."finance_states"');
          // The table becomes the probe; the functions and the trigger live in this session's own schema.
          const probe = migration
            .replaceAll('"finance_billing"."finance_states"', PROBE_TABLE)
            .replaceAll('"finance_billing".', 'pg_temp.');
          expect(probe).not.toContain('finance_billing');
          const rows = yield* Schema.decodeUnknownEffect(ComparisonSchema)(yield* migrateProbe(probe));
          expect(rows.map((row) => row.name).toSorted()).toEqual(ledgers.map((ledger) => ledger.name).toSorted());
          for (const row of rows) {
            expect([row.name, row.wanted, row.unchanged_after_rerun, row.rewritten_wanted]).toEqual([
              row.name,
              true,
              true,
              true,
            ]);
            // The Finance revision the next command names is untouched.
            expect(row.revision).toBe(7);
          }
        }),
      ),
    60_000,
  );
});
