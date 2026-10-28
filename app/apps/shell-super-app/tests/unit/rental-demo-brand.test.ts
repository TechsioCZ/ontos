import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { PrincipalResolver } from '@app/core-runtime';
import { demoCompanyTenantId, rentalDemoBrandProfiles } from '@app/core-runtime/demo-company-profiles';
import { NodeCrypto } from '@effect/platform-node';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';
import { rebrandRentalDemoAccounts } from '../../api/auth/rental-demo-brand-runtime-infrastructure.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';

const originalRows = () =>
  rentalDemoBrandProfiles.map((profile) => ({
    email: profile.legacyEmail,
    id: profile.authUserId,
    name: profile.legacyDisplayName,
  }));
interface Row {
  email: string;
  id: string;
  name: string;
}
const foreignTenant = '10000000-0000-4000-8000-000000000099';
const fixture = (
  initial: readonly Row[] = originalRows(),
  options: {
    readonly foreignBinding?: boolean;
    readonly retainedIds?: boolean;
    readonly sqlFailure?: boolean;
  } = {},
) =>
  Effect.gen(function* nativeAuthBrandFixture() {
    const rows = initial.map((row) => ({
      ...row,
      id: options.retainedIds === true ? `retained-stage-${row.id}` : row.id,
    }));
    const queries: string[] = [];
    const resolved: string[] = [];
    const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
      Effect.provide(
        scriptedPgClientLayer(
          Effect.succeed(
            testSqlConnection((sql, params) => {
              queries.push(sql);
              expect(sql).not.toContain('"core".');
              expect(sql).not.toContain('"auth"."account"');
              expect(sql).not.toContain('"auth"."session"');
              expect(sql.toLowerCase()).not.toContain('delete');
              expect(sql.toLowerCase()).not.toContain('insert');
              if (options.sqlFailure === true) {
                return Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'controlled outage' }) }));
              }
              if (sql.toLowerCase().startsWith('select')) {
                expect(sql).toContain('for update');
                return Effect.succeed(rows);
              }
              if (sql.toLowerCase().startsWith('update')) {
                const row = rows.find(({ id }) => params.includes(id));
                const emailIndex = /"email" = \$(?<parameter>\d+)/u.exec(sql)?.groups?.['parameter'];
                const nameIndex = /"name" = \$(?<parameter>\d+)/u.exec(sql)?.groups?.['parameter'];
                if (row === undefined || emailIndex === undefined || nameIndex === undefined) {
                  return Effect.die('Unexpected native Auth update');
                }
                row.email = Schema.decodeUnknownSync(Schema.String)(params[Number(emailIndex) - 1]);
                row.name = Schema.decodeUnknownSync(Schema.String)(params[Number(nameIndex) - 1]);
                return Effect.succeed([{ id: row.id }]);
              }
              return Effect.succeed([]);
            }),
          ),
        ).pipe(Layer.provideMerge(Reactivity.layer)),
      ),
    );
    const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema);
    const resolver = makePrincipalResolverDouble({
      resolveBetterAuthUserForPrincipal: ({ principalId, tenantId }) => {
        resolved.push(principalId);
        expect(tenantId).toBe(demoCompanyTenantId);
        const profile = rentalDemoBrandProfiles.find((entry) => entry.principalId === principalId);
        return profile === undefined
          ? Effect.die('Unexpected principal subject')
          : Effect.succeed(
              options.foreignBinding === true
                ? 'duplicate-provider-subject'
                : `${options.retainedIds === true ? 'retained-stage-' : ''}${profile.authUserId}`,
            );
      },
    });
    return {
      queries,
      resolved,
      rows,
      run: (tenantId = demoCompanyTenantId) =>
        rebrandRentalDemoAccounts(tenantId).pipe(
          Effect.provideService(AuthDatabase, { adapter, executor }),
          Effect.provideService(PrincipalResolver, resolver),
        ),
    };
  }).pipe(Effect.provide(NodeCrypto.layer));

it.effect('renames exact rental Auth labels and emails once without touching credentials, sessions or subjects', () =>
  Effect.gen(function* nativeRentalAuthRebrand() {
    const state = yield* fixture();
    expect(yield* state.run()).toEqual({ renamed: 4 });
    expect(yield* state.run()).toEqual({ renamed: 0 });
    expect(state.rows).toEqual(
      rentalDemoBrandProfiles.map(({ authUserId, displayName, email }) => ({
        email,
        id: authUserId,
        name: displayName,
      })),
    );
    expect(state.queries.filter((sql) => sql.toLowerCase().startsWith('update'))).toHaveLength(4);
  }),
);

it.effect('refuses foreign tenant scope or duplicate retained Core subjects before opening Auth SQL', () =>
  Effect.gen(function* rejectsForeignBrandScope() {
    const foreign = yield* fixture();
    const invalid = yield* foreign.run(foreignTenant).pipe(Effect.flip);
    expect(Predicate.isTagged(invalid, 'IdentityTargetInvalidError')).toBe(true);
    expect(foreign.resolved).toEqual([]);
    expect(foreign.queries).toEqual([]);
    const binding = yield* fixture(originalRows(), { foreignBinding: true });
    const conflict = yield* binding.run().pipe(Effect.flip);
    expect(Predicate.isTagged(conflict, 'IdentityLifecycleConflictError')).toBe(true);
    expect(binding.queries).toEqual([]);
  }),
);

it.effect('preserves stage provider subjects that differ from the fresh local fixture IDs', () =>
  Effect.gen(function* preservesRetainedProviderSubjects() {
    const state = yield* fixture(originalRows(), { retainedIds: true });
    const before = state.rows.map(({ id }) => id);
    expect(yield* state.run()).toEqual({ renamed: 4 });
    expect(state.rows.map(({ id }) => id)).toEqual(before);
    expect(state.rows.map(({ email }) => email)).toEqual(rentalDemoBrandProfiles.map(({ email }) => email));
  }),
);

it.effect('refuses missing users, custom labels and target-email collisions before any Auth write', () =>
  Effect.gen(function* preservesConflictingAuthAccounts() {
    const [first] = rentalDemoBrandProfiles;
    for (const rows of [
      originalRows().slice(1),
      originalRows().map((row) => ({ ...row, name: 'Custom user name' })),
      [...originalRows(), { email: first.email, id: 'foreign-user', name: first.displayName }],
    ]) {
      const state = yield* fixture(rows);
      const conflict = yield* state.run().pipe(Effect.flip);
      expect(Predicate.isTagged(conflict, 'IdentityLifecycleConflictError')).toBe(true);
      expect(state.queries.some((sql) => sql.toLowerCase().startsWith('update'))).toBe(false);
      expect(state.rows).toEqual(rows);
    }
  }),
);

it.effect('reports a typed persistence failure without resetting accounts after an Auth outage', () =>
  Effect.gen(function* preservesOutage() {
    const state = yield* fixture(originalRows(), { sqlFailure: true });
    const failure = yield* state.run().pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'IdentityPersistenceUnavailableError')).toBe(true);
    expect(state.rows).toEqual(originalRows());
  }),
);
