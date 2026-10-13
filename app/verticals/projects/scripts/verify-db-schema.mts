import { PgClient } from '@effect/sql-pg';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { PROJECTS_TABLE_INVENTORY, projects, projectsRelations } from '../src/db/schema.ts';

class ProjectsSchemaVerificationError extends Schema.TaggedError<ProjectsSchemaVerificationError>()(
  'ProjectsSchemaVerificationError',
  { reason: Schema.String },
) {}

const verification = Effect.scoped(
  Effect.gen(function* verifyProjectsSchema() {
    const client = yield* PgClient.PgClient;
    const database = yield* makeWithDefaults({ relations: projectsRelations });
    yield* database.select().from(projects).limit(0);
    // PostgreSQL catalogs are infrastructure metadata, not a business-query escape hatch.
    const catalog = yield* client<{ enabled: boolean; forced: boolean; table_name: string }>`
    select c.relname as table_name, c.relforcerowsecurity as forced, c.relrowsecurity as enabled
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'projects' and c.relkind in ('r', 'p') order by c.relname
  `;
    if (
      catalog.length !== PROJECTS_TABLE_INVENTORY.length ||
      catalog[0]?.table_name !== PROJECTS_TABLE_INVENTORY[0] ||
      !catalog[0].forced ||
      !catalog[0].enabled
    ) {
      yield* new ProjectsSchemaVerificationError({ reason: 'Projects table inventory or forced RLS mismatch' });
    }
    const journals = yield* client<{
      exists: boolean;
    }>`select to_regclass('drizzle.__drizzle_migrations_projects') is not null as exists`;
    if (!journals[0]?.exists) {
      yield* new ProjectsSchemaVerificationError({ reason: 'Projects migration journal is missing' });
    }
  }),
);

const adminClientLive = Layer.unwrap(
  loadDatabaseConnectionPair().pipe(
    Effect.map((connections) => PgClient.layer({ url: Redacted.make(connections.admin.connectionString) })),
  ),
);
await Effect.runPromise(verification.pipe(Effect.provide(Layer.mergeAll(adminClientLive, Reactivity.layer))));
