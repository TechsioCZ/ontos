// Prints an SQL upsert that reseeds ONLY the `assets` agenda of Siampark (…0021), leaving other agendas alone.
// Usage (demo DB in docker):
//   node verticals/facility-operations/scripts/seed/assets-sql.mts | docker exec -i ontos-demo-db psql -U ontos_admin -d siampark_demo
// The full reset (all agendas) stays `pnpm demo:seed:facility-operations`.
import { NodeRuntime } from '@effect/platform-node';
import { Console, Effect, Schema } from 'effect';
import { AssetsStateSchema } from '../../shared/domain/assets.ts';
import { seedAssetsState } from './assets.mts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const legalEntityId = '71000000-0000-4000-8000-000000000021';

class SeedSqlInvalid extends Schema.TaggedError<SeedSqlInvalid>()('SeedSqlInvalid', {
  reason: Schema.String,
}) {}

const program = Effect.gen(function* printAssetSeedSql() {
  const decoded = yield* Schema.decodeUnknownEffect(AssetsStateSchema)(seedAssetsState());
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AssetsStateSchema))(decoded);
  if (encoded.includes('$seed$')) {
    return yield* new SeedSqlInvalid({ reason: 'seed contains the SQL dollar-quote tag' });
  }
  return yield* Console.log(
    `insert into facility_operations.agenda_states (tenant_id, legal_entity_id, agenda, revision, state, updated_at)
values ('${tenantId}', '${legalEntityId}', 'assets', 0, $seed$${encoded}$seed$::jsonb, now())
on conflict (tenant_id, legal_entity_id, agenda) do update set revision = 0, state = excluded.state, updated_at = now();`,
  );
});
NodeRuntime.runMain(program);
