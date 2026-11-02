import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Effect, FileSystem, Path } from 'effect';

import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import { ApplicationCompositionAuthorityError } from '../packages/core-runtime/src/modules/application-composition-authority.ts';

// Compatible opt-in Core expansions, in journal order. The dead-delivery resolution ledger must exist while
// the old release drains, because an operator may need it to redrive or release a dead tracked delivery.
const additiveMigrations = [
  '20261019161320_outbox-composition-completion',
  '20261029194254_outbox-delivery-resolution',
] as const;
const unavailable = (cause: unknown) =>
  new ApplicationCompositionAuthorityError({
    cause,
    code: 'application_composition_authority_unavailable',
    reason: 'The additive Application Composition completion schema could not be installed',
  });

/** Expand only the compatible opt-in Core schema, using the normal migration identity/hash/journal.
 * The full owner migrator still runs only after the old authority has been verified and sealed.
 */
export const installApplicationCompositionCompletionSchema = Effect.fn(
  'ApplicationCompositionAuthority.expandCompletionSchema',
)(function* installApplicationCompositionCompletionSchema() {
  const database = yield* CoreDatabase;
  // A committed expansion is immutable journaled schema, not reusable work-absence evidence.
  const [schema] = yield* database.executor.execute<{ readonly completionSchemaInstalled: boolean }>(
    sql`
      select (select count(*)=2 from information_schema.columns
        where table_schema='core' and table_name='outbox_messages'
          and column_name in ('completion_consumer_module_key','completion_original_revision'))
        and (select count(distinct name)=${additiveMigrations.length} from drizzle.__drizzle_migrations_core
          where name in (${sql.join(
            additiveMigrations.map((name) => sql`${name}`),
            sql`,`,
          )}))
        as "completionSchemaInstalled"`,
    'objects',
  );
  if (schema !== undefined && schema.completionSchemaInstalled) {
    return yield* Effect.void;
  }
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.scoped(
    Effect.gen(function* stageAdditiveMigration() {
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: 'composition-schema-expansion-' });
      // The Drizzle journal skips an expansion that is already applied by name.
      for (const migrationName of additiveMigrations) {
        const migrationDirectory = path.join(directory, migrationName);
        yield* filesystem.makeDirectory(migrationDirectory);
        const source = yield* filesystem.readFileString(
          new URL(`../packages/core-runtime/drizzle/${migrationName}/migration.sql`, import.meta.url).pathname,
        );
        yield* filesystem.writeFileString(path.join(migrationDirectory, 'migration.sql'), source);
      }
      // Drizzle's native reader is synchronous; suspend its construction in the typed I/O boundary.
      const migration = yield* Effect.try({
        catch: unavailable,
        try: () =>
          migrate(database.executor, {
            migrationsFolder: directory,
            migrationsSchema: 'drizzle',
            migrationsTable: '__drizzle_migrations_core',
          }),
      });
      yield* migration;
    }),
  ).pipe(Effect.mapError(unavailable));
});
