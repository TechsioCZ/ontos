// @effect-diagnostics strictEffectProvide:off
// Owner-local, idempotent sales-demo seed cleanup. Dry-run by default; --apply removes only unchanged fixtures.
// Run from app with DATABASE_ADMIN_URL available. No reseed, revision reset, grants or other-company writes.
import { PgClient } from '@effect/sql-pg';
import { NodeRuntime } from '@effect/platform-node';
import { Config, Console, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { legacyRentalBaseline } from './legacy-rental-baseline.mts';
import { AgreementsStateSchema } from '../shared/apis/records.ts';
import { legacyRentalScope, retireLegacyRental } from './legacy-rental-cleanup.mts';

const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* () {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));

const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const baseline = yield* Schema.decodeUnknownEffect(AgreementsStateSchema)(legacyRentalBaseline);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const { tenantId, legalEntityId } = legacyRentalScope;
      const [row] = yield* sql<{ revision: number; snapshot: unknown }>`
        select revision, snapshot from legal_agreements.state
        where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} for update`;
      if (row === undefined) return yield* Effect.die('Missing Obchodní firma agreements state');
      const state = yield* Schema.decodeUnknownEffect(AgreementsStateSchema)(row.snapshot);
      const next = yield* Effect.try(() => retireLegacyRental(legacyRentalScope, state, baseline));
      if (next === state) {
        yield* Console.log('Legacy rental fixtures already absent; no write.');
        return;
      }
      const counts = {
        contracts: state.contracts.length - next.contracts.length,
        documents: state.documents.length - next.documents.length,
        signatureObservations: state.signatureObservations.length - next.signatureObservations.length,
      };
      if (!process.argv.includes('--apply')) {
        yield* Console.log('Dry run: unchanged legacy rental fixtures to retire', counts);
        return;
      }
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AgreementsStateSchema))(next);
      const updated = yield* sql`
        update legal_agreements.state set snapshot=${encoded}::jsonb, revision=revision+1
        where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and revision=${row.revision}
        returning revision`;
      if (updated.length !== 1) return yield* Effect.die('Concurrent agreements change; retry cleanup');
      yield* Console.log(
        `Retired legacy rental fixtures at revision ${row.revision + 1}; other records untouched.`,
        counts,
      );
    }),
  );
});
NodeRuntime.runMain(program.pipe(Effect.provide(admin)));
