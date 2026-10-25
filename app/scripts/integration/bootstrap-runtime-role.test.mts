import type { PgClient } from '@effect/sql-pg';
import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { findPostgresFailure } from '../../packages/core-runtime/src/database/postgres-failure.ts';
import { DATABASE_IDENTITIES } from '../../packages/core-runtime/src/db/database-identities.ts';
import { loadDatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import { makeTestPgSession } from '../../packages/core-runtime/tests/support/database.ts';
import { quoteIdentifier } from '../postgres/database-login-roles.mts';
import { manifestEntryForRole } from '../postgres/database-role-manifest.mts';
import {
  assertDatabaseRoleManifestComplete,
  assertExplicitRole,
  explicitEntries,
  grantExplicitRole,
  grantSharedRuntimeRole,
  grantTrustAuthority,
  legacySharedEntries,
  revokePublicStatementStatistics,
} from '../postgres/runtime-role-bootstrap.mts';
import type { ExplicitManifestEntry } from '../postgres/runtime-role-bootstrap.mts';

const qualified = (relation: string): string => relation.split('.').map(quoteIdentifier).join('.');

/** Applies the database-local grant passes inside one transaction that is always rolled back. */
const rolledBack = <Value, Failure>(body: (session: PgClient.PgClient) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* rolledBackBootstrap() {
    const connections = yield* loadDatabaseIdentityConnections();
    const session = yield* makeTestPgSession(connections.admin.connectionString);
    yield* session.unsafe('begin');
    return yield* Effect.gen(function* grantThenRun() {
      yield* revokePublicStatementStatistics(session);
      yield* Effect.forEach(legacySharedEntries, (entry) => grantSharedRuntimeRole(session, entry), { discard: true });
      yield* Effect.forEach(explicitEntries, (entry) => grantExplicitRole(session, entry), { discard: true });
      yield* grantTrustAuthority(session);
      return yield* body(session);
    }).pipe(Effect.ensuring(session.unsafe('rollback').pipe(Effect.ignore)));
  }).pipe(Effect.scoped);

const assertionFailure = (session: PgClient.PgClient, entry: ExplicitManifestEntry) =>
  assertExplicitRole(session, entry).pipe(
    Effect.flip,
    Effect.map(({ reason }) => reason),
  );

const entryWith = (predicate: (entry: ExplicitManifestEntry) => boolean): ExplicitManifestEntry => {
  const entry = explicitEntries.find(predicate);
  if (entry === undefined) {
    throw new Error('Expected a manifest entry for this probe');
  }
  return entry;
};

const isWholeTableSelect = ({ columns, privileges }: ExplicitManifestEntry['grants']['tables'][number]) =>
  privileges.includes('select') && columns?.select === undefined;

it.live('accepts the exact manifest privileges for every explicit role', () =>
  rolledBack((session) =>
    Effect.forEach(explicitEntries, (entry) => assertExplicitRole(session, entry), { discard: true }),
  ),
);

it.live('preserves shared-owner replay receipt permissions after both bootstrap grant passes', () =>
  rolledBack((session) =>
    Effect.gen(function* replayReceiptPrivileges() {
      const rows = yield* session.unsafe<{ schema_name: string; updatable: boolean; usable: boolean }>(
        `select namespace.nspname as schema_name,
                pg_catalog.has_table_privilege('ontos_runtime', relation.oid, 'UPDATE') as updatable,
                (pg_catalog.has_table_privilege('ontos_runtime', relation.oid, 'SELECT')
                 and pg_catalog.has_table_privilege('ontos_runtime', relation.oid, 'INSERT')
                 and pg_catalog.has_table_privilege('ontos_runtime', relation.oid, 'DELETE')) as usable
           from pg_catalog.pg_class as relation
           join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
          where relation.relname = 'gateway_assertion_redemptions'
            and namespace.nspname in ('catalog', 'inventory')
          order by namespace.nspname`,
      );
      expect(rows).toEqual([
        { schema_name: 'catalog', updatable: false, usable: true },
        { schema_name: 'inventory', updatable: false, usable: true },
      ]);
    }),
  ),
);

it.live('bootstraps pre-namespace auth bindings while final readiness rejects the incomplete migration', () =>
  rolledBack((session) =>
    Effect.gen(function* preNamespaceBindings() {
      const entry = entryWith(({ identity }) => identity.role === 'party_registry_runtime');
      yield* assertDatabaseRoleManifestComplete(session);
      yield* session.unsafe('savepoint pre_namespace_bindings');
      // These four columns were introduced by 20260916130129_auth-namespace-bindings.
      yield* session.unsafe(
        `alter table core.principal_auth_bindings
           drop column authentication_namespace_id,
           drop column binding_revision,
           drop column created_by_invocation_id,
           drop column last_transition_ref`,
      );
      yield* grantExplicitRole(session, entry);
      yield* assertExplicitRole(session, entry);
      const incomplete = yield* assertDatabaseRoleManifestComplete(session).pipe(Effect.flip);
      expect(incomplete.reason).toContain('core.principal_auth_bindings.authentication_namespace_id');
      expect(incomplete.reason).toContain('core.principal_auth_bindings.binding_revision');

      // An absent grant on an existing column must still fail the pre-migration assertion.
      yield* session.unsafe(
        'revoke select (principal_auth_binding_id) on core.principal_auth_bindings from party_registry_runtime',
      );
      expect(yield* assertionFailure(session, entry)).toContain(
        'core.principal_auth_bindings.principal_auth_binding_id:SELECT',
      );

      yield* session.unsafe('rollback to savepoint pre_namespace_bindings');
      yield* session.unsafe(
        'revoke select (authentication_namespace_id, binding_revision) on core.principal_auth_bindings from party_registry_runtime',
      );
      const missingGrants = yield* assertDatabaseRoleManifestComplete(session).pipe(Effect.flip);
      expect(missingGrants.reason).toContain('is missing manifest column privileges');
      yield* grantExplicitRole(session, entry);
      yield* assertDatabaseRoleManifestComplete(session);
    }),
  ),
);

it.live('keeps the shared runtime role out of every schema the manifest withholds', () =>
  rolledBack((session) =>
    Effect.all(
      legacySharedEntries.map(({ identity, revokedSchemas }) =>
        session
          .unsafe<{ grant: string }>(
            `select namespace.nspname || '.' || relation.relname || ':' || privilege as grant
             from pg_catalog.pg_class as relation
             join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
            cross join pg_catalog.unnest(array['SELECT','INSERT','UPDATE','DELETE','USAGE']) as privilege
            where namespace.nspname = any($2::text[])
              and case
                    when relation.relkind = 'S' then
                      privilege in ('SELECT', 'UPDATE', 'USAGE')
                      and pg_catalog.has_sequence_privilege($1, relation.oid, privilege)
                    when relation.relkind in ('r', 'p', 'v', 'm', 'f') then
                      privilege <> 'USAGE' and pg_catalog.has_table_privilege($1, relation.oid, privilege)
                    else false
                  end
           union all
           select namespace.nspname || ':USAGE'
             from pg_catalog.pg_namespace as namespace
            where namespace.nspname = any($2::text[])
              and pg_catalog.has_schema_privilege($1, namespace.oid, 'USAGE')`,
            [identity.role, `{${revokedSchemas.join(',')}}`],
          )
          .pipe(Effect.map((rows) => expect(rows.map(({ grant }) => grant)).toEqual([]))),
      ),
      { discard: true },
    ),
  ),
);

it.live('detects a missing manifest table privilege', () =>
  rolledBack((session) =>
    Effect.gen(function* missingTablePrivilege() {
      const entry = entryWith(({ grants }) => grants.tables.some(isWholeTableSelect));
      const table = entry.grants.tables.find(isWholeTableSelect)?.table ?? '';
      yield* session.unsafe(`revoke select on table ${qualified(table)} from ${quoteIdentifier(entry.identity.role)}`);
      expect(yield* assertionFailure(session, entry)).toContain(
        `is missing manifest table privileges: ${table}:SELECT`,
      );
    }),
  ),
);

it.live('detects a missing manifest sequence privilege', () =>
  rolledBack((session) =>
    Effect.gen(function* missingSequencePrivilege() {
      const entry = entryWith(({ grants }) => grants.sequences.length > 0);
      const [grant] = entry.grants.sequences;
      const privilege = grant?.privileges[0] ?? 'usage';
      yield* session.unsafe(
        `revoke ${privilege} on sequence ${qualified(grant?.sequence ?? '')} from ${quoteIdentifier(entry.identity.role)}`,
      );
      expect(yield* assertionFailure(session, entry)).toContain(
        `is missing manifest sequence privileges: ${grant?.sequence}:${privilege.toUpperCase()}`,
      );
    }),
  ),
);

it.live('detects a sequence privilege outside the manifest', () =>
  rolledBack((session) =>
    Effect.gen(function* extraSequencePrivilege() {
      const entry = entryWith(() => true);
      const granted = entry.grants.sequences.map(({ sequence }) => sequence);
      const [sequence] = yield* session.unsafe<{ name: string }>(
        `select namespace.nspname || '.' || relation.relname as name
           from pg_catalog.pg_class as relation
           join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
          where relation.relkind = 'S' and namespace.nspname = 'core'
            and namespace.nspname || '.' || relation.relname <> all($1::text[])
          order by 1
          limit 1`,
        [`{${granted.join(',')}}`],
      );
      expect(sequence).toBeDefined();
      yield* session.unsafe(
        `grant usage on sequence ${qualified(sequence?.name ?? '')} to ${quoteIdentifier(entry.identity.role)}`,
      );
      expect(yield* assertionFailure(session, entry)).toContain(
        `has sequence privileges outside its manifest: ${sequence?.name}:USAGE`,
      );
    }),
  ),
);

for (const scope of ['', 'in schema core']) {
  for (const object of ['tables', 'sequences']) {
    for (const grantee of ['party_registry_runtime', 'public']) {
      it.live(`rejects undeclared default ${object} grants ${scope || 'globally'} to ${grantee}`, () =>
        rolledBack((session) =>
          Effect.gen(function* defaultPrivilegeDrift() {
            const entry = entryWith(({ identity }) => identity.role === 'party_registry_runtime');
            yield* session.unsafe(`alter default privileges ${scope} grant select on ${object} to ${grantee}`);
            // Reconciliation must not bless a latent grant merely because no table exists yet.
            yield* grantExplicitRole(session, entry);
            expect(yield* assertionFailure(session, entry)).toContain('has default privileges outside its manifest');
          }),
        ),
      );
    }
  }
}

it.live('rejects ordinary default grants made by a different object creator', () =>
  rolledBack((session) =>
    Effect.gen(function* otherCreatorDefaults() {
      const entry = entryWith(({ identity }) => identity.role === 'party_registry_runtime');
      yield* session.unsafe(
        'alter default privileges for role ontos_runtime in schema core grant select on tables to public',
      );
      expect(yield* assertionFailure(session, entry)).toContain('ontos_runtime:core:r:SELECT');
    }),
  ),
);

it.live('every runtime login is denied changing protected logging defaults', () =>
  Effect.gen(function* runtimeSelfSettings() {
    const connections = yield* loadDatabaseIdentityConnections();
    for (const { id, role } of DATABASE_IDENTITIES) {
      const session = yield* makeTestPgSession(connections.runtime[id].connectionString);
      // RESET of an absent setting is a harmless no-op. Configured bearer-role defaults must be protected too.
      const clauses = ['set log_parameter_max_length = -1'];
      if (manifestEntryForRole(role)?.roleSettings.includes('log_parameter_max_length=0') === true) {
        clauses.push('reset log_parameter_max_length');
      }
      for (const clause of clauses) {
        yield* session.unsafe('begin');
        yield* session.unsafe(`alter role ${quoteIdentifier(role)} ${clause}`).pipe(
          Effect.flip,
          Effect.map((failure) => expect(Option.getOrUndefined(findPostgresFailure(failure))?.code).toBe('42501')),
          Effect.ensuring(session.unsafe('rollback').pipe(Effect.orDie)),
        );
      }
    }
  }).pipe(Effect.scoped),
);

for (const relation of ['pg_stat_statements', 'pg_stat_statements_info']) {
  it.live(`removes PUBLIC SELECT on public.${relation} before exact role assertions`, () =>
    rolledBack((session) =>
      Effect.gen(function* statisticsPrivilegeDrift() {
        const [existing] = yield* session.unsafe<{ present: boolean }>(
          'select pg_catalog.to_regclass($1) is not null as present',
          [`public.${relation}`],
        );
        if (!existing?.present) {
          yield* session.unsafe(`create view public.${quoteIdentifier(relation)} as select 1 as probe`);
        }
        yield* session.unsafe(`grant select on public.${quoteIdentifier(relation)} to public`);
        const entry = entryWith(() => true);
        expect(yield* assertionFailure(session, entry)).toContain(`public.${relation}:SELECT`);
        yield* revokePublicStatementStatistics(session);
        yield* revokePublicStatementStatistics(session);
        yield* assertExplicitRole(session, entry);
      }),
    ),
  );
}

for (const [statement, missing] of [
  [
    'alter table contacts.gateway_assertion_redemptions rename to missing_redemptions_probe',
    'contacts.gateway_assertion_redemptions',
  ],
  [
    'alter sequence core.domain_event_tenant_sequence_no_seq rename to missing_sequence_probe',
    'core.domain_event_tenant_sequence_no_seq',
  ],
  [
    'drop function contacts.prune_expired_gateway_assertion_redemptions(timestamptz)',
    'contacts.prune_expired_gateway_assertion_redemptions',
  ],
] as const) {
  it.live(`readiness rejects missing ${missing}`, () =>
    rolledBack((session) =>
      Effect.gen(function* missingRequiredObject() {
        yield* assertDatabaseRoleManifestComplete(session);
        yield* session.unsafe(statement);
        const failure = yield* assertDatabaseRoleManifestComplete(session).pipe(Effect.flip);
        expect(failure.reason).toContain('Required database role manifest objects are missing');
        expect(failure.reason).toContain(missing);
      }),
    ),
  );
}

it.live('readiness rejects an audience assigned to the worker identity', () =>
  rolledBack((session) =>
    Effect.gen(function* wrongAudience() {
      yield* session.unsafe(
        "update trust.gateway_audience_roles set role_name = 'party_registry_worker' where audience = 'party-registry'",
      );
      const failure = yield* assertDatabaseRoleManifestComplete(session).pipe(Effect.flip);
      expect(failure.reason).toContain('exactly party-registry -> party_registry_runtime');
    }),
  ),
);
