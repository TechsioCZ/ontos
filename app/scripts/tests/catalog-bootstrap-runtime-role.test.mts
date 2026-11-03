import { readFileSync } from 'node:fs';

import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { expect, it, rstest } from 'effect-rstest';

import { DATABASE_IDENTITIES } from '../../packages/core-runtime/src/db/database-identities.ts';
import type { DatabaseRoleGrantManifestEntry } from '../postgres/database-role-manifest.mts';

const normalizeSql = (sql: string): string => sql.replaceAll('"', '').replaceAll(/\s+/gu, ' ').trim().toLowerCase();
const ownerMigration = readFileSync(
  new URL(
    '../../verticals/catalog/drizzle/20261021181412_catalog_gateway_assertion_redemptions/migration.sql',
    import.meta.url,
  ),
  'utf-8',
);
const ownerGrants = ownerMigration
  .split('--> statement-breakpoint')
  .map((statement) => normalizeSql(statement).replace(/;$/u, ''))
  .filter((statement) => /^(?:grant|revoke) /u.test(statement));
const broadGrant = 'grant select, insert, update, delete on all tables in schema catalog to ontos_runtime';
const defaultGrant =
  'alter default privileges in schema catalog grant select, insert, update, delete on tables to ontos_runtime';

const expectOwnerGrants = (statements: readonly string[]): void => {
  expect(statements).toContain(broadGrant);
  expect(statements).toContain(defaultGrant);
  const ledgerGrants = statements.filter((statement) =>
    /^(?:grant|revoke) .* on table catalog\.gateway_assertion_redemptions /u.test(statement),
  );
  expect(ledgerGrants).toEqual(ownerGrants);
  for (const statement of ledgerGrants) {
    expect(statements.indexOf(statement)).toBeGreaterThan(statements.indexOf(defaultGrant));
  }
};

const marketFenceGrants = [
  'revoke all on table commerce_market_catalog.market_retirement_admissions from public, ontos_runtime',
  'grant select on table commerce_market_catalog.market_retirement_admissions to ontos_runtime',
  'grant insert on table commerce_market_catalog.market_retirement_admissions to ontos_runtime',
  'grant update on table commerce_market_catalog.market_retirement_admissions to ontos_runtime',
];

const expectMarketFenceGrants = (statements: readonly string[]): void => {
  expect(
    statements.filter((statement) =>
      /^(?:grant|revoke) .* on table commerce_market_catalog\.market_retirement_admissions /u.test(statement),
    ),
  ).toEqual(marketFenceGrants);
  expect(statements).not.toContain('grant usage on schema commerce_market_catalog to ontos_runtime');
};

it.live(
  'normal and repeated bootstrap restore Catalog redemption and Market fence least grants without reviving withheld schemas',
  Effect.fn(function* catalogBootstrapRegression() {
    const statements: string[] = [];
    let roleExists = false;
    let tableExists = true;
    let marketSchemaExists = true;
    let marketTableExists = true;
    const client = {
      unsafe: (sql: string, values?: readonly string[]) =>
        Effect.sync(() => {
          statements.push(normalizeSql(sql));
          if (sql.startsWith('select exists(select 1 from pg_catalog.pg_roles')) {
            return [{ exists: roleExists }];
          }
          if (sql.startsWith('select exists(select 1 from pg_catalog.pg_namespace')) {
            return [
              {
                exists:
                  new Map<string | undefined, boolean>([
                    ['catalog', true],
                    ['commerce_market_catalog', marketSchemaExists],
                  ]).get(values?.[0]) === true,
              },
            ];
          }
          if (sql.startsWith('select pg_catalog.to_regclass')) {
            return [
              {
                exists:
                  (tableExists && values?.[0] === 'catalog.gateway_assertion_redemptions') ||
                  (marketTableExists && values?.[0] === 'commerce_market_catalog.market_retirement_admissions'),
              },
            ];
          }
          if (sql.startsWith('select rolsuper')) {
            return [
              {
                rolbypassrls: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolinherit: false,
                rolreplication: false,
                rolsuper: false,
              },
            ];
          }
          if (sql.startsWith('select pg_catalog.has_database_privilege')) {
            return [{ allowed: values?.[0] === 'ontos_runtime' }];
          }
          if (sql.startsWith('select coalesce(pg_catalog.string_agg(setting')) {
            return [
              {
                settings:
                  values?.[0] === 'shell_gateway_issuer' || values?.[0] === 'party_registry_runtime'
                    ? 'log_parameter_max_length=0,log_parameter_max_length_on_error=0'
                    : '',
              },
            ];
          }
          return [];
        }),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    };
    rstest.doMock<{ readonly PgClient: unknown }>(import('@effect/sql-pg'), () => {
      const actual = rstest.requireActual<{ readonly PgClient: typeof PgClient }>('@effect/sql-pg');
      return { ...actual, PgClient: { ...actual.PgClient, makeClient: () => Effect.succeed(client) } };
    });
    rstest.doMock('../../packages/core-runtime/src/db/config.ts', () => ({
      loadDatabaseIdentityConnections: () =>
        Effect.succeed({
          admin: { connectionString: 'postgres://admin:fixture@invalid/catalog', database: 'catalog' },
          runtime: Object.fromEntries(
            DATABASE_IDENTITIES.map(({ id, role }) => [
              id,
              {
                connectionString: `postgres://${role}:fixture@invalid/catalog`,
                database: 'catalog',
                user: role,
              },
            ]),
          ),
        }),
    }));
    const previousExitCode = process.exitCode;
    try {
      for (const repeat of [false, true]) {
        statements.length = 0;
        roleExists = repeat;
        rstest.resetModules();
        yield* Effect.promise(() => import('../postgres/bootstrap-runtime-role.mts'));
        expect(process.exitCode).toBe(0);
        for (const { role } of DATABASE_IDENTITIES) {
          expect(
            statements.some((statement) => statement.startsWith(`${repeat ? 'alter' : 'create'} role ${role} login `)),
          ).toBe(true);
        }
        expectOwnerGrants(statements);
        expectMarketFenceGrants(statements);
        const broadened = statements.map((statement) =>
          statement === ownerGrants[1]
            ? statement.replace('select, insert, delete', 'select, insert, update, delete')
            : statement,
        );
        expect(broadened).not.toEqual(statements);
        expect(() => expectOwnerGrants(broadened)).toThrow();
        const deletedFence = statements.map((statement) =>
          statement === marketFenceGrants[3] ? statement.replace('grant update ', 'grant update, delete ') : statement,
        );
        expect(() => expectMarketFenceGrants(deletedFence)).toThrow();
      }
      statements.length = 0;
      tableExists = false;
      rstest.resetModules();
      yield* Effect.promise(() => import('../postgres/bootstrap-runtime-role.mts'));
      expect(process.exitCode).toBe(0);
      expect(statements.some((statement) => statement.includes('on table catalog.gateway_assertion_redemptions'))).toBe(
        false,
      );
      expectMarketFenceGrants(statements);

      // Neither an absent owner schema nor an absent pre-migration table creates new authority.
      for (const ownerState of ['missing-schema', 'missing-table']) {
        statements.length = 0;
        tableExists = true;
        marketSchemaExists = ownerState !== 'missing-schema';
        marketTableExists = ownerState !== 'missing-table';
        rstest.resetModules();
        yield* Effect.promise(() => import('../postgres/bootstrap-runtime-role.mts'));
        expect(process.exitCode).toBe(0);
        expectOwnerGrants(statements);
        expect(statements.some((statement) => statement.includes('on table commerce_market_catalog.'))).toBe(false);
      }

      // An explicit schema revocation takes precedence over its configured table exception.
      marketSchemaExists = true;
      marketTableExists = true;
      rstest.doMock(import('../postgres/database-role-manifest.mts'), () => {
        const actual = rstest.requireActual<{
          readonly DATABASE_ROLE_GRANT_MANIFEST: readonly DatabaseRoleGrantManifestEntry[];
        }>('../postgres/database-role-manifest.mts');
        return {
          ...actual,
          DATABASE_ROLE_GRANT_MANIFEST: actual.DATABASE_ROLE_GRANT_MANIFEST.map((entry) =>
            entry.kind === 'legacy_shared'
              ? { ...entry, revokedSchemas: [...entry.revokedSchemas, 'commerce_market_catalog'] }
              : entry,
          ),
        };
      });
      statements.length = 0;
      rstest.resetModules();
      yield* Effect.promise(() => import('../postgres/bootstrap-runtime-role.mts'));
      expect(process.exitCode).toBe(0);
      expect(statements).toContain('revoke all on schema commerce_market_catalog from ontos_runtime');
      expect(statements.some((statement) => statement.includes('on table commerce_market_catalog.'))).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
      rstest.doUnmock('@effect/sql-pg');
      rstest.doUnmock('../../packages/core-runtime/src/db/config.ts');
      rstest.doUnmock('../postgres/database-role-manifest.mts');
      rstest.resetModules();
    }
  }),
);
