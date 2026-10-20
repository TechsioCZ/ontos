// Prints an SQL upsert that reseeds ONLY the `assets` agenda of Siampark (…0021), leaving other agendas alone.
// Usage (demo DB in docker):
//   node verticals/siampark-ops/scripts/seed/assets-sql.mts | docker exec -i ontos-demo-db psql -U ontos_admin -d siampark_demo
// The full reset (all agendas) stays `pnpm demo:seed:siampark-ops`.
import { Schema } from 'effect';
import { AssetsStateSchema } from '../../shared/domain/assets.ts';
import { seedAssetsState } from './assets.mts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const legalEntityId = '71000000-0000-4000-8000-000000000021';

const decoded = Schema.decodeUnknownSync(AssetsStateSchema)(seedAssetsState());
const encoded = JSON.stringify(Schema.encodeSync(AssetsStateSchema)(decoded));
if (encoded.includes('$seed$')) {
  throw new Error('seed contains the SQL dollar-quote tag');
}
process.stdout.write(
  `insert into demo_siampark_ops.agenda_states (tenant_id, legal_entity_id, agenda, revision, state, updated_at)
values ('${tenantId}', '${legalEntityId}', 'assets', 0, $seed$${encoded}$seed$::jsonb, now())
on conflict (tenant_id, legal_entity_id, agenda) do update set revision = 0, state = excluded.state, updated_at = now();
`,
);
