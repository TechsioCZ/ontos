import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../src/db/schema.ts';
import { demoCompanyTenantId } from '../../src/install/demo-company-profiles.ts';
import { rentalDemoBrandProfiles } from '../../src/install/demo-rental-brand-profiles.ts';
import { rebrandRentalDemoPrincipals } from '../../src/install/demo-rental-principal-brand.ts';
import { scriptedPgClientLayer } from '../../src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../support/sql-connection.ts';

interface PrincipalBrandRow {
  displayName: string;
  kind: string;
  principalId: string;
}
class PrincipalBrandFixture extends Context.Service<
  PrincipalBrandFixture,
  {
    readonly queries: string[];
    readonly rows: PrincipalBrandRow[];
    readonly run: (tenantId?: string) => ReturnType<typeof rebrandRentalDemoPrincipals>;
  }
>()('@app/core-runtime/tests/unit/demo-rental-principal-brand.test/PrincipalBrandFixture') {}

const originalRows = (): PrincipalBrandRow[] =>
  rentalDemoBrandProfiles.map(({ legacyDisplayName, principalId }) => ({
    displayName: legacyDisplayName,
    kind: 'human',
    principalId,
  }));
const fixture = (initial = originalRows()) => {
  const rows = initial.map((row) => ({ ...row }));
  const queries: string[] = [];
  return Layer.effect(
    PrincipalBrandFixture,
    Effect.gen(function* nativePrincipalBrandFixture() {
      const executor = yield* makeWithDefaults({ relations: coreRelations });
      return {
        queries,
        rows,
        run: (tenantId = demoCompanyTenantId) => rebrandRentalDemoPrincipals(executor, tenantId),
      };
    }),
  ).pipe(
    Layer.provide(
      scriptedPgClientLayer(
        Effect.succeed(
          testSqlConnection((sql, params) => {
            queries.push(sql);
            expect(sql).not.toContain('"auth".');
            expect(sql).not.toContain('"principal_auth_bindings"');
            expect(sql).not.toContain('"principal_company_memberships"');
            expect(sql).not.toContain('"status" =');
            if (sql.toLowerCase().startsWith('select')) {
              expect(sql).toContain('for update');
              expect(params).toContain(demoCompanyTenantId);
              return Effect.succeed(rows);
            }
            if (sql.toLowerCase().startsWith('update')) {
              const row = rows.find(({ principalId }) => params.includes(principalId));
              const nameIndex = /"display_name" = \$(?<parameter>\d+)/u.exec(sql)?.groups?.['parameter'];
              if (row === undefined || nameIndex === undefined) {
                return Effect.die('Unexpected native principal update');
              }
              row.displayName = Schema.decodeUnknownSync(Schema.String)(params[Number(nameIndex) - 1]);
              return Effect.succeed([{ principalId: row.principalId }]);
            }
            return Effect.succeed([]);
          }),
        ),
      ).pipe(Layer.provideMerge(Reactivity.layer)),
    ),
  );
};

it.layer(fixture())((test) => {
  test.effect('renames known principal labels once while preserving IDs, status, bindings and memberships', () =>
    Effect.gen(function* nativePrincipalRebrand() {
      const state = yield* PrincipalBrandFixture;
      expect(yield* state.run()).toEqual({ inspected: 4, renamed: 3 });
      expect(yield* state.run()).toEqual({ inspected: 4, renamed: 0 });
      expect(state.rows).toEqual(
        rentalDemoBrandProfiles.map(({ displayName, principalId }) => ({
          displayName,
          kind: 'human',
          principalId,
        })),
      );
      expect(state.queries.filter((sql) => sql.toLowerCase().startsWith('update'))).toHaveLength(3);
    }),
  );
});

it.layer(fixture())((test) => {
  test.effect('refuses another tenant before any Core SQL', () =>
    Effect.gen(function* refusesOtherTenant() {
      const state = yield* PrincipalBrandFixture;
      const failure = yield* state.run('10000000-0000-4000-8000-000000000099').pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'IdentityTargetInvalidError')).toBe(true);
      expect(state.queries).toEqual([]);
    }),
  );
});

for (const kind of ['custom-label', 'non-human']) {
  const initial = originalRows().map((row) =>
    kind === 'custom-label' ? { ...row, displayName: 'Custom principal' } : { ...row, kind: 'service' },
  );
  it.layer(fixture(initial))((test) => {
    test.effect(`refuses ${kind} principals before changing any label`, () =>
      Effect.gen(function* preservesCustomPrincipals() {
        const state = yield* PrincipalBrandFixture;
        const failure = yield* state.run().pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'IdentityLifecycleConflictError')).toBe(true);
        expect(state.queries.some((sql) => sql.toLowerCase().startsWith('update'))).toBe(false);
        expect(state.rows).toEqual(initial);
      }),
    );
  });
}

it.layer(fixture([]))((test) => {
  test.effect('does not create absent principals in a fresh synthetic company', () =>
    Effect.gen(function* preservesAbsentAccounts() {
      const state = yield* PrincipalBrandFixture;
      expect(yield* state.run()).toEqual({ inspected: 0, renamed: 0 });
      expect(state.queries).toHaveLength(1);
      expect(state.rows).toEqual([]);
    }),
  );
});
