import type { PgClient } from '@effect/sql-pg';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConstraintError } from 'effect/sql/SqlError';

import { loadDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { makeTestPgSession } from '../../packages/core-runtime/tests/support/database.ts';
import {
  ACCESS_FENCE_SWEEP_ROUTINE,
  explicitEntries,
  grantExplicitRole,
  grantSharedRuntimeRole,
  grantTrustAuthority,
  legacySharedEntries,
  revokePublicStatementStatistics,
} from '../postgres/runtime-role-bootstrap.mts';

/*
 * The fence sweep's one cross-tenant read, on a database prepared the way a deploy prepares it: the migrations applied
 * by the migrator's role (`DATABASE_ADMIN_URL`, the database's administrative role, as on stage), then the deploy's
 * runtime-role bootstrap. The access tables force row-level security and their policies name only the runtime roles,
 * so the runtime role sees no other tenant's fence; the SECURITY DEFINER function, owned by the migrator's role, must
 * still find lapsed holds in every tenant and hand back tenant ids only.
 */
const TENANTS = ['00000000-0000-4000-8000-0000000fe101', '00000000-0000-4000-8000-0000000fe102'] as const;
const scopeOf = (index: number) => `00000000-0000-4000-8000-0000000fe2${String(index).padStart(2, '0')}`;
const operationOf = (index: number) => `00000000-0000-4000-8000-0000000fe3${String(index).padStart(2, '0')}`;
const MISSING_OPERATION = '00000000-0000-4000-8000-0000000fe399';

const run = (session: PgClient.PgClient, statements: readonly string[]) =>
  Effect.forEach(statements, (statement) => session.unsafe(statement).pipe(Effect.orDie), { discard: true });

/** One tenant whose access fence is held by an operation whose lease lapsed a minute ago. */
const plantLapsedHold = (session: PgClient.PgClient, tenantId: string, index: number) =>
  run(session, [
    `insert into core.tenants (tenant_id, slug, name, status, default_locale)
       values ('${tenantId}', 'fence-sweep-${String(index)}', 'Fence sweep ${String(index)}', 'active', 'cs')`,
    `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id)
       values ('${scopeOf(index)}', '${tenantId}', '${tenantId}')`,
    `insert into core.access_operation_journals
       (operation_id, tenant_id, scope_id, command_digest, phase, started_at, updated_at)
       values ('${operationOf(index)}', '${tenantId}', '${scopeOf(index)}', '${'f'.repeat(64)}', 'fenced',
               now() - interval '10 minutes', now() - interval '10 minutes')`,
    `insert into core.access_scope_fences (scope_id, tenant_id, state, owning_operation_id, revision, lease_expires_at)
       values ('${scopeOf(index)}', '${tenantId}', 'Changing', '${operationOf(index)}', 1, now() - interval '1 minute')`,
  ]);

const removePlanted = (session: PgClient.PgClient) =>
  Effect.forEach(
    [
      `delete from core.access_scope_fences where tenant_id in ('${TENANTS.join("', '")}')`,
      `delete from core.access_operation_journals where tenant_id in ('${TENANTS.join("', '")}')`,
      `delete from core.access_scopes where tenant_id in ('${TENANTS.join("', '")}')`,
      `delete from core.tenants where tenant_id in ('${TENANTS.join("', '")}')`,
    ],
    (statement) => session.unsafe(statement).pipe(Effect.ignore),
    { discard: true },
  );

/** The PostgreSQL error's own constraint name, as the driver reports it. */
const ConstraintSchema = Schema.Struct({ constraint: Schema.String });

const RowsSchema = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const rowsOf = (session: PgClient.PgClient, statement: string) =>
  session.unsafe(statement).pipe(Effect.orDie, Effect.flatMap(Schema.decodeUnknownEffect(RowsSchema)), Effect.orDie);

it.live('finds lapsed fences of every tenant for the runtime role, which itself sees no other tenant', () =>
  Effect.scoped(
    Effect.gen(function* lapsedFencesAcrossTenants() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* makeTestPgSession(connections.admin.connectionString);
      const runtime = yield* makeTestPgSession(connections.runtime.connectionString);
      // The deploy's runtime-role bootstrap, exactly as the migrator runs it after the migrations.
      yield* revokePublicStatementStatistics(admin);
      yield* Effect.forEach(legacySharedEntries, (entry) => grantSharedRuntimeRole(admin, entry), { discard: true });
      yield* Effect.forEach(explicitEntries, (entry) => grantExplicitRole(admin, entry), { discard: true });
      yield* grantTrustAuthority(admin);

      // The function belongs to the role that ran the migrations, which owns the tables and is exempt from their RLS.
      expect(
        yield* rowsOf(
          admin,
          `select pg_get_userbyid(p.proowner) = current_user as owned_by_migrator, r.rolsuper or r.rolbypassrls as exempt,
                  p.prosecdef as definer
             from pg_proc p join pg_roles r on r.oid = p.proowner
            where p.proname = 'lapsed_access_fence_tenants'`,
        ),
      ).toEqual([{ definer: true, exempt: true, owned_by_migrator: true }]);
      expect(
        yield* rowsOf(
          admin,
          `select relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) = current_user as owned
             from pg_class where relnamespace = 'core'::regnamespace
              and relname in ('access_operation_journals', 'access_scope_fences') order by relname`,
        ),
      ).toEqual([
        { owned: true, relforcerowsecurity: true, relname: 'access_operation_journals', relrowsecurity: true },
        { owned: true, relforcerowsecurity: true, relname: 'access_scope_fences', relrowsecurity: true },
      ]);

      yield* Effect.addFinalizer(() => removePlanted(admin));
      yield* removePlanted(admin);
      yield* Effect.forEach(TENANTS, (tenantId, index) => plantLapsedHold(admin, tenantId, index + 1), {
        discard: true,
      });

      // A held fence always names a journal row: the foreign key refuses a holder that has none.
      const orphan = yield* admin
        .unsafe(
          `update core.access_scope_fences set owning_operation_id = '${MISSING_OPERATION}' where scope_id = '${scopeOf(1)}'`,
        )
        .pipe(Effect.flip);
      expect(Schema.is(ConstraintError)(orphan.cause)).toBe(true);
      expect(Schema.decodeUnknownOption(ConstraintSchema)(orphan.cause.cause)).toEqual(
        Option.some({ constraint: 'access_scope_fences_operation_fk' }),
      );

      expect(
        yield* rowsOf(runtime, `select current_user as role, current_setting('ontos.tenant_id', true) as tenant`),
      ).toEqual([{ role: 'ontos_runtime', tenant: null }]);
      // Without a tenant the runtime role reads no fence at all ...
      expect(
        yield* rowsOf(
          runtime,
          `select count(*)::int as visible from core.access_scope_fences where tenant_id in ('${TENANTS.join("', '")}')`,
        ),
      ).toEqual([{ visible: 0 }]);
      // ... and the sweep's function finds both tenants' lapsed holds, tenant ids only.
      const lapsed = yield* rowsOf(
        runtime,
        `select tenant_id::text as tenant_id from core.lapsed_access_fence_tenants(100, interval '35 minutes', null)`,
      );
      expect(
        lapsed
          .map(({ tenant_id: tenantId }) => tenantId)
          .filter((tenantId) => TENANTS.some((planted) => planted === tenantId))
          .map(String)
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual([...TENANTS]);
      expect(Object.keys(lapsed[0] ?? {})).toEqual(['tenant_id']);
    }),
  ),
);

const bootstrap = (admin: PgClient.PgClient) =>
  Effect.gen(function* deployBootstrap() {
    yield* revokePublicStatementStatistics(admin);
    yield* Effect.forEach(legacySharedEntries, (entry) => grantSharedRuntimeRole(admin, entry), { discard: true });
    yield* Effect.forEach(explicitEntries, (entry) => grantExplicitRole(admin, entry), { discard: true });
    yield* grantTrustAuthority(admin);
  });

/** Every role that may execute the sweep function besides its owner, and the function's whole ACL. */
const executorsOf = (admin: PgClient.PgClient) =>
  rowsOf(
    admin,
    `select coalesce((select string_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, ',')
                         from aclexplode(p.proacl) a
                        where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner), '') as executors,
            p.proacl::text as acl
       from pg_proc p
      where p.oid = '${ACCESS_FENCE_SWEEP_ROUTINE}'::regprocedure`,
  );

it.live('the runtime-role bootstrap grants the sweep function to ontos_runtime alone, even when migrated first', () =>
  Effect.scoped(
    Effect.gen(function* bootstrapOwnsGrant() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* makeTestPgSession(connections.admin.connectionString);
      // A database migrated before `ontos_runtime` existed: the migration's conditional grant was skipped, so the
      // function carries no grant beyond its owner (PUBLIC is revoked by the migration itself).
      yield* admin
        .unsafe(`revoke all on function ${ACCESS_FENCE_SWEEP_ROUTINE} from public, ontos_runtime`)
        .pipe(Effect.orDie);
      const [before] = yield* executorsOf(admin);
      expect(before?.executors).toBe('');
      yield* bootstrap(admin);
      const [granted] = yield* executorsOf(admin);
      expect(granted?.executors).toBe('ontos_runtime');
      // Running the bootstrap again changes nothing.
      yield* bootstrap(admin);
      expect(yield* executorsOf(admin)).toEqual([granted]);
    }),
  ),
);
