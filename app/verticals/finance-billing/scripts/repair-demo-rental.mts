// @effect-diagnostics *:off
// Scoped idempotent fixture repair, not a reseed. Run from app with node --env-file=.env.
import { PgClient } from '@effect/sql-pg';
import { NodeRuntime } from '@effect/platform-node';
import { Config, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import { repairRentalInvoices, rentalInvoiceCorrections, rentalRepairScope } from './repair-rental-invoices.ts';
const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* () {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const { tenantId, legalEntityId } = rentalRepairScope;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const [row] = yield* sql<{ revision: number; state: unknown }>`
      select revision,state from finance_billing.finance_states
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} for update`;
      if (row === undefined) return yield* Effect.die('Missing scoped finance state');
      const original = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state);
      // Read-only verification of the rental owner's authoritative occupancy, in the same company only.
      const leases = yield* sql<{
        id: string;
        counterparty: string;
        unit: string;
        start_date: string;
        end_date: string;
        state: string;
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
          return yield* Effect.die('Lease evidence does not match the proposed October correction');
        }
      }
      const state = yield* repairRentalInvoices(original, yield* DateTime.now);
      const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(state);
      const before = yield* Schema.encodeEffect(FinanceStateSchema)(original);
      if (JSON.stringify(encoded) === JSON.stringify(before)) {
        console.log(`Rental corrections already applied at revision ${row.revision}; no write.`);
        return;
      }
      const updated = yield* sql`update finance_billing.finance_states
      set state=${JSON.stringify(encoded)}::jsonb,revision=revision+1,updated_at=now()
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and revision=${row.revision} returning revision`;
      if (updated.length !== 1) return yield* Effect.die('Concurrent finance change; retry scoped repair');
      console.log(
        `Siampark rental repair revision ${row.revision} -> ${row.revision + 1}: two linked replacements; original issued customer/amount snapshots and exports preserved; duplicate draft voided.`,
      );
    }),
  );
});
NodeRuntime.runMain(program.pipe(Effect.provide(admin)));
