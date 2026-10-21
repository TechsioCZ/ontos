// @effect-diagnostics *:off
// S07.R5 data repair: approval now requires "Připraveno ke schválení" first. Issued invoices that were imported
// already approved (seed fixtures, rental corrections) carry no preparation or approval record, so their history
// shows the "Připraveno" step as missing. This records both steps at the time the document entered OntOS, labelled
// as the initial import (no invented person). Payments, exports and reminders are left untouched.
//
//   node --env-file=.env verticals/siampark-billing-finance/scripts/repair-prepared-step.mts [--apply]
//
// Idempotent: invoices that already have `preparedAt` are skipped. Without --apply it only lists what would change.
import { PgClient } from '@effect/sql-pg';
import { NodeRuntime } from '@effect/platform-node';
import { Config, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../shared/apis/records.ts';

const TENANT = '70000000-0000-4000-8000-000000000020';
const IMPORT_LABEL = 'Úvodní import dokladů';
const APPLY = process.argv.includes('--apply');

const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* () {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));

/** An issued invoice approved without a recorded preparation step. */
const needsPreparedStep = (invoice: Invoice) =>
  invoice.direction === 'OUTGOING' && invoice.businessState === 'CONFIRMED' && invoice.preparedAt === undefined;

const withPreparedStep = (state: FinanceState): FinanceState => ({
  ...state,
  invoices: state.invoices.map((invoice) => {
    if (!needsPreparedStep(invoice)) return invoice;
    const approvedAt = invoice.approvedAt ?? invoice.createdAt;
    const approvedByLabel = invoice.approvedByLabel ?? IMPORT_LABEL;
    return {
      ...invoice,
      approvedAt,
      approvedByLabel,
      preparedAt: approvedAt,
      preparedByLabel: approvedByLabel,
    };
  }),
});

const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{
    legal_entity_id: string;
    revision: number;
    state: unknown;
  }>`select legal_entity_id, revision, state from siampark_billing_finance.finance_states where tenant_id=${TENANT}`;
  for (const row of rows) {
    const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state);
    const targets = state.invoices.filter(needsPreparedStep);
    console.log(
      `${row.legal_entity_id} rev ${row.revision}: ${targets.length} issued invoices without the preparation step` +
        (targets.length === 0 ? '' : ` (${targets.map((invoice) => invoice.number ?? invoice.documentNumber).join(', ')})`),
    );
    if (!APPLY || targets.length === 0) continue;
    const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(withPreparedStep(state));
    const updated =
      yield* sql`update siampark_billing_finance.finance_states set state=${JSON.stringify(encoded)}::jsonb,revision=revision+1,updated_at=now() where tenant_id=${TENANT} and legal_entity_id=${row.legal_entity_id} and revision=${row.revision} returning revision`;
    if (updated.length !== 1) return yield* Effect.die(`Finance ${row.legal_entity_id} changed concurrently; rerun`);
    console.log(`  applied -> rev ${row.revision + 1}`);
  }
  if (!APPLY) console.log('Dry run; pass --apply to write.');
});

NodeRuntime.runMain(program.pipe(Effect.provide(admin)));
