// S07.R5 data repair: approval now requires "Připraveno ke schválení" first. Issued invoices that were imported
// already approved (seed fixtures, rental corrections) carry no preparation or approval record, so their history
// shows the "Připraveno" step as missing. This records both steps at the time the document entered OntOS, labelled
// as the initial import (no invented person). Payments, exports and reminders are left untouched.
//
//   node --env-file=.env verticals/finance-billing/scripts/repair-prepared-step.mts [--apply]
//
// Idempotent: invoices that already have `preparedAt` are skipped. Without --apply it only lists what would change.
import { PgClient } from '@effect/sql-pg';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Reactivity } from 'effect/unstable/reactivity';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../shared/apis/records.ts';

const TENANT = '70000000-0000-4000-8000-000000000020';
const IMPORT_LABEL = 'Úvodní import dokladů';
class PreparedStepRepairRejected extends Schema.TaggedError<PreparedStepRepairRejected>()(
  'PreparedStepRepairRejected',
  {
    reason: Schema.String,
  },
) {}

const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));

/** An issued invoice approved without a recorded preparation step. */
const needsPreparedStep = (invoice: Invoice) =>
  invoice.direction === 'OUTGOING' && invoice.businessState === 'CONFIRMED' && invoice.preparedAt === undefined;

const withPreparedStep = (state: FinanceState): FinanceState => ({
  ...state,
  invoices: state.invoices.map((invoice) => {
    if (!needsPreparedStep(invoice)) {
      return invoice;
    }
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

const program = Effect.fn('Finance.repairPreparedStep')(function* repairPreparedStep(apply: boolean) {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{
    legal_entity_id: string;
    revision: number;
    state: unknown;
  }>`select legal_entity_id, revision, state from finance_billing.finance_states where tenant_id=${TENANT}`;
  for (const row of rows) {
    const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state);
    const targets = state.invoices.filter(needsPreparedStep);
    yield* Console.log(
      `${row.legal_entity_id} rev ${row.revision}: ${targets.length} issued invoices without the preparation step${
        targets.length === 0
          ? ''
          : ` (${targets.map((invoice) => invoice.number ?? invoice.documentNumber).join(', ')})`
      }`,
    );
    if (!apply || targets.length === 0) {
      continue;
    }
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(FinanceStateSchema))(withPreparedStep(state));
    const updated =
      yield* sql`update finance_billing.finance_states set state=${encoded}::jsonb,revision=revision+1,updated_at=now() where tenant_id=${TENANT} and legal_entity_id=${row.legal_entity_id} and revision=${row.revision} returning revision`;
    if (updated.length !== 1) {
      return yield* new PreparedStepRepairRejected({
        reason: `Finance ${row.legal_entity_id} changed concurrently; rerun`,
      });
    }
    yield* Console.log(`  applied -> rev ${row.revision + 1}`);
  }
  if (!apply) {
    yield* Console.log('Dry run; pass --apply to write.');
  }
  return yield* Effect.void;
});

const cli = Command.make(
  'repair-prepared-step',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
  },
  ({ apply }) => program(apply),
);

const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.merge(admin, NodeServices.layer)),
);

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(mainLive).pipe(Effect.scoped));
}
