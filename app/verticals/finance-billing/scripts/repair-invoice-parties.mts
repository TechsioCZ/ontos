// Idempotent, company-scoped identity repair only. Never reseeds or changes money/payment/export snapshots.
import { PgClient } from '@effect/sql-pg';
import { NodeRuntime } from '@effect/platform-node';
import { Config, Console, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { FinanceStateSchema } from '../shared/apis/records.ts';

const tenant = '70000000-0000-4000-8000-000000000020';
const entity = '71000000-0000-4000-8000-000000000021';
class InvoicePartyRepairRejected extends Schema.TaggedError<InvoicePartyRepairRejected>()(
  'InvoicePartyRepairRejected',
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

const program = Effect.gen(function* repairInvoiceParties() {
  const sql = yield* PgClient.PgClient;
  yield* sql.withTransaction(
    Effect.gen(function* repairScopedParties() {
      const [row] = yield* sql<{ revision: number; state: unknown }>`
      select revision, state from finance_billing.finance_states
      where tenant_id=${tenant} and legal_entity_id=${entity}`;
      if (row === undefined) {
        return yield* new InvoicePartyRepairRejected({ reason: 'Missing Siampark finance state' });
      }
      const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state);
      const parties = yield* sql<{ counterparty_id: string; party_id: string }>`
      select counterparty_id::text, party_id::text from party.counterparties
      where tenant_id=${tenant} and legal_entity_id=${entity}`;
      let repaired = 0;
      const invoices = state.invoices.map((invoice) => {
        if (
          invoice.partyId !== undefined ||
          invoice.counterpartyRef.tenantId !== tenant ||
          invoice.counterpartyRef.moduleId !== 'party.registry' ||
          invoice.counterpartyRef.resourceType !== 'party.registry.counterparty'
        ) {
          return invoice;
        }
        const party = parties.find((entry) => entry.counterparty_id === invoice.counterpartyRef.resourceId);
        if (party === undefined) {
          return invoice;
        }
        repaired += 1;
        return { ...invoice, partyId: party.party_id };
      });
      if (repaired === 0) {
        yield* Console.log('Invoice Party links already complete; no write.');
      } else {
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(FinanceStateSchema))({ ...state, invoices });
        const updated = yield* sql`
      update finance_billing.finance_states
      set state=${encoded}::jsonb, revision=revision+1, updated_at=now()
      where tenant_id=${tenant} and legal_entity_id=${entity} and revision=${row.revision}
      returning revision`;
        if (updated.length !== 1) {
          return yield* new InvoicePartyRepairRejected({
            reason: 'Concurrent finance change; retry scoped identity repair',
          });
        }
        yield* Console.log(
          `Repaired ${repaired} invoice Party links at revision ${row.revision + 1}; money and history unchanged.`,
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
