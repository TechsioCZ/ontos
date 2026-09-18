import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Console, Effect, Exit, Order, Redacted, Schema } from 'effect';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';

import { loadCommercePortalAuthDatabaseConfig } from './portal-auth-database-config.mts';
import type {
  CommercePortalAuthDatabaseConnection,
  CommercePortalAuthDatabaseConnectionPair,
} from './portal-auth-database-config.mts';
import {
  COMMERCE_PORTAL_AUTH_SCHEMA_NAME,
  COMMERCE_PORTAL_AUTH_TABLES,
} from '../src/portal-auth/persistence/portal-auth-tables.ts';

const PORTAL_AUTH_MIGRATION_JOURNAL = '__drizzle_migrations_commerce_portal_auth';

export class CommercePortalAuthDatabaseVerificationError extends Schema.TaggedError<CommercePortalAuthDatabaseVerificationError>()(
  'CommercePortalAuthDatabaseVerificationError',
  { reason: Schema.String },
) {}

export interface CommercePortalAuthTableCatalogDifference {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export interface CommercePortalAuthTablePrivilegeRow extends QueryResultRow {
  readonly database_create: boolean | null;
  readonly relation_name: string;
  readonly role_bypass_rls: boolean | null;
  readonly role_create_database: boolean | null;
  readonly role_create_role: boolean | null;
  readonly role_super: boolean | null;
  readonly runtime_create: boolean | null;
  readonly runtime_delete: boolean | null;
  readonly runtime_insert: boolean | null;
  readonly runtime_references: boolean | null;
  readonly runtime_select: boolean | null;
  readonly runtime_table_owner: string | null;
  readonly runtime_trigger: boolean | null;
  readonly runtime_truncate: boolean | null;
  readonly runtime_update: boolean | null;
  readonly runtime_usage: boolean | null;
}

interface CatalogRow extends QueryResultRow {
  readonly table_name: string;
}

interface DatabaseIdentityRow extends QueryResultRow {
  readonly database_name: string;
  readonly role_name: string;
}

interface JournalRow extends QueryResultRow {
  readonly journal_count: number;
}

const expectedCommercePortalAuthTableNames = EffectArray.sort(
  COMMERCE_PORTAL_AUTH_TABLES.map((table) => {
    const config = getTableConfig(table);
    return `${config.schema ?? COMMERCE_PORTAL_AUTH_SCHEMA_NAME}.${config.name}`;
  }),
  Order.String,
);

export const COMMERCE_PORTAL_AUTH_EXPECTED_TABLE_NAMES = expectedCommercePortalAuthTableNames;

const countValues = (values: readonly string[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

export const compareCommercePortalAuthCatalog = (
  qualifiedTableNames: readonly string[],
): CommercePortalAuthTableCatalogDifference => {
  const expectedCounts = countValues(expectedCommercePortalAuthTableNames);
  const actualCounts = countValues(qualifiedTableNames);
  const missing = expectedCommercePortalAuthTableNames.filter(
    (name) => (actualCounts.get(name) ?? 0) < (expectedCounts.get(name) ?? 0),
  );
  const unexpected = EffectArray.sort(
    qualifiedTableNames.filter((name) => (actualCounts.get(name) ?? 0) > (expectedCounts.get(name) ?? 0)),
    Order.String,
  );
  return { missing, unexpected };
};

const verificationFailure = (reason: string): CommercePortalAuthDatabaseVerificationError =>
  new CommercePortalAuthDatabaseVerificationError({ reason });

const query = <Row extends QueryResultRow>(client: Client, text: string, values: readonly unknown[], reason: string) =>
  Effect.tryPromise({
    catch: () => verificationFailure(reason),
    // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
    try: () => client.query<Row>(text, [...values]),
  });

const connect = (connection: CommercePortalAuthDatabaseConnection, roleDescription: string) =>
  Effect.tryPromise({
    catch: () => verificationFailure(`Unable to connect to PostgreSQL as the ${roleDescription}`),
    // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
    try: () => {
      const client = new Client({ connectionString: Redacted.value(connection.connectionString) });
      return client.connect().then(() => client);
    },
  });

const close = (client: Client, roleDescription: string) =>
  Effect.tryPromise({
    catch: () => verificationFailure(`Unable to close the ${roleDescription} PostgreSQL connection`),
    // oxlint-disable-next-line typescript/promise-function-async -- Effect.tryPromise owns the PostgreSQL Promise boundary.
    try: () => client.end(),
  });

const readIdentity = (client: Client, roleDescription: string) =>
  query<DatabaseIdentityRow>(
    client,
    'select current_database() as database_name, current_user as role_name',
    [],
    `Unable to read the ${roleDescription} PostgreSQL connection identity`,
  ).pipe(
    Effect.flatMap((result) => {
      const [identity] = result.rows;
      return identity === undefined
        ? Effect.fail(verificationFailure(`The ${roleDescription} PostgreSQL connection returned no identity`))
        : Effect.succeed(identity);
    }),
  );

const verifyIdentities = (connections: CommercePortalAuthDatabaseConnectionPair, admin: Client, runtime: Client) =>
  Effect.gen(function* verifyConnectionIdentities() {
    const adminIdentity = yield* readIdentity(admin, 'administrative');
    const runtimeIdentity = yield* readIdentity(runtime, 'runtime');

    if (
      adminIdentity.database_name !== connections.admin.database ||
      runtimeIdentity.database_name !== connections.runtime.database ||
      adminIdentity.database_name !== runtimeIdentity.database_name ||
      adminIdentity.role_name !== connections.admin.user ||
      runtimeIdentity.role_name !== connections.runtime.user ||
      adminIdentity.role_name === runtimeIdentity.role_name
    ) {
      return yield* verificationFailure(
        'Administrative and runtime PostgreSQL connections do not resolve to the configured identities and one physical database',
      );
    }
    return yield* Effect.void;
  });

const verifyCatalog = (client: Client) =>
  Effect.gen(function* verifyTypedCatalog() {
    const result = yield* query<CatalogRow>(
      client,
      `select relation.relname as table_name
         from pg_catalog.pg_class as relation
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = $1 and relation.relkind in ('r', 'p')
        order by relation.relname`,
      [COMMERCE_PORTAL_AUTH_SCHEMA_NAME],
      'Unable to read the Commerce portal authentication table catalog',
    );
    const difference = compareCommercePortalAuthCatalog(
      result.rows.map(({ table_name }) => `${COMMERCE_PORTAL_AUTH_SCHEMA_NAME}.${table_name}`),
    );
    if (difference.missing.length > 0 || difference.unexpected.length > 0) {
      return yield* verificationFailure(
        `Commerce portal authentication table catalog mismatch; missing=[${difference.missing.join(',')}], unexpected=[${difference.unexpected.join(',')}]`,
      );
    }
    return yield* Effect.void;
  });

const verifyPrivileges = (client: Client, runtimeUser: string, ownerUser: string) =>
  Effect.gen(function* verifyRuntimePrivileges() {
    const result = yield* query<CommercePortalAuthTablePrivilegeRow>(
      client,
      `select
          relation.relname as relation_name,
          pg_get_userbyid(relation.relowner) as runtime_table_owner,
          has_schema_privilege($1, namespace.oid, 'USAGE') as runtime_usage,
          has_schema_privilege($1, namespace.oid, 'CREATE') as runtime_create,
          has_table_privilege($1, relation.oid, 'SELECT') as runtime_select,
          has_table_privilege($1, relation.oid, 'INSERT') as runtime_insert,
          has_table_privilege($1, relation.oid, 'UPDATE') as runtime_update,
          has_table_privilege($1, relation.oid, 'DELETE') as runtime_delete,
          has_table_privilege($1, relation.oid, 'TRUNCATE') as runtime_truncate,
          has_table_privilege($1, relation.oid, 'REFERENCES') as runtime_references,
          has_table_privilege($1, relation.oid, 'TRIGGER') as runtime_trigger,
          has_database_privilege($1, current_database(), 'CREATE') as database_create,
          runtime.rolsuper as role_super,
          runtime.rolbypassrls as role_bypass_rls,
          runtime.rolcreatedb as role_create_database,
          runtime.rolcreaterole as role_create_role
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        left join pg_catalog.pg_roles as runtime on runtime.rolname = $1
       where namespace.nspname = $2 and relation.relkind in ('r', 'p')
       order by relation.relname`,
      [runtimeUser, COMMERCE_PORTAL_AUTH_SCHEMA_NAME],
      'Unable to verify Commerce portal authentication runtime privileges',
    );
    const expectedNames = new Set(
      expectedCommercePortalAuthTableNames.map((name) => name.slice(name.indexOf('.') + 1)),
    );
    const wrongRows = result.rows.filter(
      (row) =>
        !expectedNames.has(row.relation_name) ||
        row.runtime_table_owner !== ownerUser ||
        row.runtime_usage !== true ||
        row.runtime_create !== false ||
        row.runtime_select !== true ||
        row.runtime_insert !== true ||
        row.runtime_update !== true ||
        row.runtime_delete !== true ||
        row.runtime_truncate !== false ||
        row.runtime_references !== false ||
        row.runtime_trigger !== false ||
        row.database_create !== false ||
        row.role_super !== false ||
        row.role_bypass_rls !== false ||
        row.role_create_database !== false ||
        row.role_create_role !== false,
    );
    if (
      result.rows.length !== COMMERCE_PORTAL_AUTH_TABLES.length ||
      new Set(result.rows.map(({ relation_name }) => relation_name)).size !== result.rows.length ||
      wrongRows.length > 0
    ) {
      return yield* verificationFailure('Commerce portal authentication runtime privileges are unsafe');
    }
    return yield* Effect.void;
  });

const verifyJournal = (client: Client) =>
  Effect.gen(function* verifyMigrationJournal() {
    const result = yield* query<JournalRow>(
      client,
      `select count(*)::integer as journal_count
         from pg_catalog.pg_class as journal
         join pg_catalog.pg_namespace as namespace on namespace.oid = journal.relnamespace
        where namespace.nspname = 'drizzle'
          and journal.relname = $1
          and journal.relkind in ('r', 'p')`,
      [PORTAL_AUTH_MIGRATION_JOURNAL],
      'Unable to verify the Commerce portal authentication migration journal',
    );
    if (result.rows[0]?.journal_count !== 1) {
      return yield* verificationFailure('Commerce portal authentication migration journal is missing or duplicated');
    }
    return yield* Effect.void;
  });

const verify = Effect.gen(function* verifyCommercePortalAuthDatabase() {
  const connections = yield* loadCommercePortalAuthDatabaseConfig().pipe(
    Effect.mapError((failure) => verificationFailure(failure.reason)),
  );

  yield* Effect.acquireUseRelease(
    connect(connections.admin, 'administrative'),
    (admin) =>
      Effect.acquireUseRelease(
        connect(connections.runtime, 'runtime'),
        (runtime) =>
          verifyIdentities(connections, admin, runtime).pipe(
            Effect.andThen(verifyCatalog(admin)),
            Effect.andThen(verifyPrivileges(admin, connections.runtime.user, connections.admin.user)),
            Effect.andThen(verifyJournal(admin)),
          ),
        (runtime) => close(runtime, 'runtime'),
      ),
    (admin) => close(admin, 'administrative'),
  );

  yield* Console.log(
    `Verified ${COMMERCE_PORTAL_AUTH_TABLES.length} typed Commerce portal authentication tables, one migration journal, and least-privilege runtime access`,
  );
});

const exit = await Effect.runPromiseExit(verify.pipe(Effect.tapError((failure) => Console.error(failure.reason))));
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
