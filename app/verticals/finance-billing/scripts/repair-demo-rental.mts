// Scoped idempotent fixture repair, not a reseed. Run from app with node --env-file=.env.
import { PgClient } from '@effect/sql-pg';
import { NodeRuntime } from '@effect/platform-node';
import { Config, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import { repairRentalInvoices, rentalInvoiceCorrections, rentalRepairScope } from './repair-rental-invoices.ts';

class RentalRepairRejected extends Schema.TaggedError<RentalRepairRejected>()('RentalRepairRejected', {
  reason: Schema.String,
}) {}
const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
const program = Effect.gen(function* repairDemoRental() {
  const sql = yield* PgClient.PgClient;
  const { legalEntityId, tenantId } = rentalRepairScope;
  yield* sql.withTransaction(
    Effect.gen(function* repairScopedRental() {
      const [row] = yield* sql<{ revision: number; state: unknown }>`
      select revision,state from finance_billing.finance_states
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} for update`;
      if (row === undefined) {
        return yield* new RentalRepairRejected({ reason: 'Missing scoped finance state' });
      }
      const original = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state);
      // Read-only verification of the rental owner's authoritative occupancy, in the same company only.
      const leases = yield* sql<{
        counterparty: string;
        end_date: string;
        id: string;
        start_date: string;
        state: string;
        unit: string;
      }>`
      select o->'occupancyRef'->>'resourceId' as id,
        o->'customerCounterpartyRef'->>'resourceId' as counterparty,
        o->'unitRef'->>'resourceId' as unit, o->>'startDate' as start_date,
        o->>'endDate' as end_date, o->>'state' as state
      from property_leasing.state s, jsonb_array_elements(s.snapshot->'occupancies') o
      where s.tenant_id=${tenantId} and s.legal_entity_id=${legalEntityId}`;
      for (const correction of rentalInvoiceCorrections) {
        const source = original.invoices.find((entry) => entry.documentNumber === correction.sourceDocument);
        const lease = leases.find((entry) => entry.id === source?.occupancyRef?.resourceId);
        if (
          source === undefined ||
          lease === undefined ||
          lease.counterparty !== source.counterpartyRef.resourceId ||
          lease.unit !== source.unitRef?.resourceId ||
          lease.start_date > '2026-10-01' ||
          lease.end_date < '2026-10-31' ||
          !['ACTIVE', 'CONFIRMED'].includes(lease.state)
        ) {
          return yield* new RentalRepairRejected({
            reason: 'Lease evidence does not match the proposed October correction',
          });
        }
      }
      const state = yield* repairRentalInvoices(original, yield* DateTime.now);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(FinanceStateSchema))(state);
      const before = yield* Schema.encodeEffect(Schema.fromJsonString(FinanceStateSchema))(original);
      if (encoded === before) {
        yield* Console.log(`Rental corrections already applied at revision ${row.revision}; no write.`);
      } else {
        const updated = yield* sql`update finance_billing.finance_states
      set state=${encoded}::jsonb,revision=revision+1,updated_at=now()
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and revision=${row.revision} returning revision`;
        if (updated.length !== 1) {
          return yield* new RentalRepairRejected({ reason: 'Concurrent finance change; retry scoped repair' });
        }
        yield* Console.log(
          `Siampark rental repair revision ${row.revision} -> ${row.revision + 1}: two linked replacements; original issued customer/amount snapshots and exports preserved; duplicate draft voided.`,
        );
      }
      return yield* Effect.void;
    }),
  );
});
const mainLive = Layer.effectDiscard(program).pipe(Layer.provide(admin));

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(mainLive).pipe(Effect.scoped));
}
