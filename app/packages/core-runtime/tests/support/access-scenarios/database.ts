import type { PgClient } from '@effect/sql-pg';
import { Context, Crypto, Effect, FileSystem, Order } from 'effect';
import { ScenarioMigrationIdentityError } from './scenario-migration-identity-error.ts';

import { CORE_MIGRATION_EQUIVALENCES } from '../../../src/db/migration-equivalence-data.ts';

import {
  SHELL_GATEWAY_ISSUER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  trustRoutinesForIdentities,
} from '../../../src/db/database-identity-manifest.ts';

/** The platform identities' routine vocabulary; owner routines arrive with the owner's enrollment. */
const PLATFORM_TRUST_ROUTINES = trustRoutinesForIdentities([SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY]);

/*
 * The disposable PostgreSQL databases of the access suites. Each one lives beside the integration
 * environment's database (`loadDatabaseConnectionPair`), so a suite runs wherever the other integration
 * suites run. This module holds the SQL and takes an existing admin client for every step, so it imports
 * no runtime factory of its own; the suite creates the clients and any suite-scoped template layer.
 *
 * The schema is the whole committed core migration set plus the three runtime login roles the
 * migrations' row-level-security policies name. A suite builds it into a template once and clones that
 * per case, or builds it straight into one case's own database.
 */

/** The login roles the committed migrations' policies and the runtime connection name. */
const RUNTIME_ROLES = ['ontos_runtime', 'party_registry_runtime', 'party_registry_worker'] as const;

const migrationDirectories = new URL('../../../drizzle/', import.meta.url);

/** A fresh database uses the reviewed main identities, never an arbitrary content-hash deduplication. */
export const coreScenarioMigrationStatements = Effect.fn('coreScenarioMigrationStatements')(
  function* selectScenarioMigrationStatements(sources: ReadonlyMap<string, string>) {
    const crypto = yield* Crypto.Crypto;
    for (const pair of CORE_MIGRATION_EQUIVALENCES) {
      for (const name of [pair.main, pair.demo]) {
        const source = sources.get(name);
        const digest =
          source === undefined
            ? undefined
            : (yield* crypto.digest('SHA-256', new TextEncoder().encode(source)).pipe(Effect.orDie)).toHex();
        if (digest !== pair.hash) {
          return yield* new ScenarioMigrationIdentityError({
            migration: name,
            reason: 'A reviewed historical migration is missing or its immutable bytes changed',
          });
        }
      }
    }
    const excluded: ReadonlySet<string> = new Set(CORE_MIGRATION_EQUIVALENCES.map((pair) => pair.demo));
    const statements: string[] = [];
    for (const [name, source] of [...sources].toSorted(([left], [right]) => Order.String(left, right))) {
      if (excluded.has(name)) {
        continue;
      }
      for (const statement of source.split('--> statement-breakpoint')) {
        if (statement.trim().length > 0) {
          statements.push(statement);
        }
      }
    }
    return statements;
  },
);

/** Every selected migration in committed order, split at Drizzle's statement breakpoints. */
export const scenarioMigrations: Effect.Effect<readonly string[], never, Crypto.Crypto | FileSystem.FileSystem> =
  Effect.gen(function* readMigrations() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directories = yield* fileSystem.readDirectory(migrationDirectories.pathname);
    const sources = new Map<string, string>();
    for (const directory of directories) {
      const path = `${migrationDirectories.pathname}${directory}/migration.sql`;
      if (yield* fileSystem.exists(path)) {
        sources.set(directory, yield* fileSystem.readFileString(path));
      }
    }
    return yield* coreScenarioMigrationStatements(sources);
  }).pipe(Effect.orDie);

/** One connection string pointed at another database of the same server. */
export const replacedDatabase = (connectionString: string, database: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

/** One tenant's identity row with every column the committed schema requires, for a suite that seeds SQL. */
export const insertTenantStatement = (tenantId: string): string =>
  `insert into core.tenants (tenant_id, slug, name, status, default_locale)
     values ('${tenantId}', 'tenant-${tenantId}', 'Tenant ${tenantId.slice(-4)}', 'active', 'cs')`;

const run = (client: PgClient.PgClient, statements: readonly string[]) =>
  Effect.forEach(statements, (statement) => client.unsafe(statement).pipe(Effect.orDie), {
    concurrency: 1,
    discard: true,
  });

const createRoles = (admin: PgClient.PgClient) =>
  Effect.forEach(
    RUNTIME_ROLES,
    (role) =>
      admin
        .unsafe(
          `do $$
           begin
             if not exists (select 1 from pg_roles where rolname = '${role}') then
               create role ${role} login password '${role}';
             end if;
           end
           $$`,
        )
        .pipe(Effect.orDie),
    { concurrency: 1, discard: true },
  );

/** Drops one database, connected to whichever database the caller's admin client serves. */
export const dropDatabase = (admin: PgClient.PgClient, database: string) =>
  admin.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie);

/** Clones the template into one case's own database. */
export const cloneDatabase = (admin: PgClient.PgClient, source: string, database: string) =>
  admin.unsafe(`create database "${database}" template "${source}"`).pipe(Effect.orDie);

/** Builds the template: the full committed core schema, its login roles and their grants. */
export const createTemplateDatabase = (admin: PgClient.PgClient) =>
  Effect.gen(function* createTemplateDatabaseEffect() {
    yield* createRoles(admin);
    yield* run(admin, yield* scenarioMigrations);
    yield* run(admin, [
      'grant usage on schema core to ontos_runtime',
      'grant select, insert, update, delete on all tables in schema core to ontos_runtime',
      'grant usage, select on all sequences in schema core to ontos_runtime',
      'grant execute on all functions in schema core to ontos_runtime',
      // The trust routines the runtime bootstrap lets the shared runtime execute (the Action fence lock).
      'grant usage on schema trust to ontos_runtime',
      ...PLATFORM_TRUST_ROUTINES.flatMap(({ executableBy, signature }) =>
        executableBy.includes('ontos_runtime') ? [`grant execute on function ${signature} to ontos_runtime`] : [],
      ),
    ]);
  });

/** The template the suite builds once and every case clones. */
export class ScenarioTemplate extends Context.Service<ScenarioTemplate, { readonly database: string }>()(
  '@app/core-runtime/tests/support/access-scenarios/database/ScenarioTemplate',
) {}
