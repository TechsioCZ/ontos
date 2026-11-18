import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NodeServices, NodeSocketServer } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, Match, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';
import { NetAddress } from 'effect/net';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';

import { DATABASE_IDENTITIES } from '../../packages/core-runtime/src/db/database-identities.ts';
import type { DatabaseIdentity } from '../../packages/core-runtime/src/db/database-identities.ts';
import {
  scriptedPgClientLayer,
  testSqlConnection,
} from '../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import {
  bootstrapRuntimeRoles,
  grantSharedRuntimeRole,
  legacySharedEntries,
} from '../postgres/runtime-role-bootstrap.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const bootstrapScript = fileURLToPath(new URL('../postgres/bootstrap-runtime-role.mts', import.meta.url));
const identityFlag = '--identities';
const passwords = new Map(DATABASE_IDENTITIES.map(({ role }) => [role, Redacted.make('fixture')]));

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

/** The catalog an administrative PostgreSQL session observes; every statement it receives is recorded. */
const makeCatalog = () => {
  const statements: string[] = [];
  const catalog = {
    marketSchemaExists: true,
    marketTableExists: true,
    roleExists: false,
    statements,
    tableExists: true,
    trustExists: false,
  };
  const answer = (sql: string, values: readonly unknown[]): readonly object[] => {
    const { marketSchemaExists, marketTableExists, roleExists, tableExists, trustExists } = catalog;
    catalog.statements.push(normalizeSql(sql));
    if (sql.startsWith('select exists(select 1 from pg_catalog.pg_roles')) {
      return [{ exists: roleExists }];
    }
    if (sql.startsWith('select exists(select 1 from pg_catalog.pg_namespace')) {
      return [
        {
          exists:
            new Map<unknown, boolean>([
              ['trust', trustExists],
              ['catalog', true],
              ['commerce_market_catalog', marketSchemaExists],
            ]).get(values[0]) === true,
        },
      ];
    }
    if (sql.startsWith('select pg_catalog.to_regclass')) {
      return [
        {
          exists:
            new Map<unknown, boolean>([
              ['trust.scope_sealing_keys', trustExists],
              ['trust.gateway_scope_grants', trustExists],
              ['trust.gateway_audience_roles', trustExists],
              ['catalog.gateway_assertion_redemptions', tableExists],
              ['commerce_market_catalog.market_retirement_admissions', marketTableExists],
            ]).get(values[0]) === true,
        },
      ];
    }
    if (sql.startsWith('select pg_catalog.to_regprocedure')) {
      return [{ exists: trustExists }];
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
      return [{ allowed: values[0] === 'ontos_runtime' }];
    }
    if (sql.startsWith('select coalesce(pg_catalog.string_agg(setting')) {
      return [
        {
          settings:
            values[0] === 'shell_gateway_issuer' || values[0] === 'party_registry_runtime'
              ? 'log_parameter_max_length=0,log_parameter_max_length_on_error=0'
              : '',
        },
      ];
    }
    return [];
  };
  // The real Effect SQL client and PostgreSQL compiler over one scripted session.
  const client = PgClient.PgClient.pipe(
    Effect.provide(
      scriptedPgClientLayer(Effect.succeed(testSqlConnection((sql, values) => Effect.sync(() => answer(sql, values))))),
    ),
    Effect.provide(Reactivity.layer),
  );
  return { catalog, client };
};

it.effect(
  'normal and repeated bootstrap restore Catalog redemption and Market fence least grants without reviving withheld schemas',
  Effect.fn(function* catalogBootstrapRegression() {
    const { catalog, client: makeClient } = makeCatalog();
    const client = yield* makeClient;
    const bootstrap = (identities?: readonly DatabaseIdentity['id'][]) => {
      catalog.statements.length = 0;
      return identities === undefined
        ? bootstrapRuntimeRoles(client, { database: 'catalog', passwords })
        : bootstrapRuntimeRoles(client, { database: 'catalog', identities, passwords });
    };
    for (const repeat of [false, true]) {
      catalog.roleExists = repeat;
      yield* bootstrap();
      const { statements } = catalog;
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
    }
    catalog.tableExists = false;
    yield* bootstrap();
    expect(
      catalog.statements.some((statement) => statement.includes('on table catalog.gateway_assertion_redemptions')),
    ).toBe(false);
    expectMarketFenceGrants(catalog.statements);

    // Neither an absent owner schema nor an absent pre-migration table creates new authority.
    for (const ownerState of ['missing-schema', 'missing-table']) {
      catalog.tableExists = true;
      catalog.marketSchemaExists = ownerState !== 'missing-schema';
      catalog.marketTableExists = ownerState !== 'missing-table';
      yield* bootstrap();
      expectOwnerGrants(catalog.statements);
      expect(catalog.statements.some((statement) => statement.includes('on table commerce_market_catalog.'))).toBe(
        false,
      );
    }

    // A selected identity refresh must not reset or grant any unrelated login.
    catalog.trustExists = true;
    catalog.marketSchemaExists = true;
    catalog.marketTableExists = true;
    for (const identityId of ['shared_runtime', 'party_registry_request'] as const) {
      yield* bootstrap([identityId]);
      const { statements } = catalog;
      for (const identity of DATABASE_IDENTITIES) {
        const mutations = statements.filter(
          (statement) =>
            /^(?:alter|create|grant|revoke) /u.test(statement) &&
            new RegExp(`\\b${identity.role}\\b`, 'u').test(statement),
        );
        expect(mutations.length > 0).toBe(identity.id === identityId);
      }
      expect(statements).toContain('revoke temporary on database catalog from public');
      expect(statements).toContain(
        'delete from trust.gateway_audience_roles where role_name = any($1::text[]) and audience <> all($2::text[])',
      );
      expect(
        statements.some((statement) => statement.startsWith('delete from trust.gateway_audience_roles where audience')),
      ).toBe(false);
      if (identityId === 'shared_runtime') {
        expectOwnerGrants(statements);
        expectMarketFenceGrants(statements);
      }
    }
  }),
);

it.effect('an explicit schema revocation takes precedence over its configured table exception', () =>
  Effect.gen(function* revokedSchemaWinsOverTableException() {
    const { catalog, client: makeClient } = makeCatalog();
    const client = yield* makeClient;
    const [legacy] = legacySharedEntries;
    if (legacy === undefined) {
      return yield* Effect.die('The manifest must declare the legacy shared runtime role');
    }
    expect(legacy.tableGrantExceptions?.some(({ table }) => table.startsWith('commerce_market_catalog.'))).toBe(true);
    yield* grantSharedRuntimeRole(client, {
      ...legacy,
      revokedSchemas: [...legacy.revokedSchemas, 'commerce_market_catalog'],
    });
    expect(catalog.statements).toContain('revoke all on schema commerce_market_catalog from ontos_runtime');
    expect(catalog.statements.some((statement) => statement.includes('on table commerce_market_catalog.'))).toBe(false);
    return yield* Effect.void;
  }),
);

/** A loopback PostgreSQL address that refuses every connection: the port is bound, read and released. */
const refusedAddress = Effect.scoped(
  Effect.gen(function* closedListener() {
    const server = yield* NodeSocketServer.make({ host: '127.0.0.1', port: 0 });
    return yield* Match.value(server.address).pipe(
      Match.when(NetAddress.isInetAddress, (inetAddress) => Effect.succeed(inetAddress)),
      Match.orElse(() => Effect.die('The PostgreSQL listener did not bind to TCP')),
    );
  }),
);
const connectionAttempt = 'Unable to connect to the administrative PostgreSQL database';

it.live(
  'the bootstrap CLI connects only for a valid selection whose selected credentials carry passwords',
  () =>
    Effect.gen(function* bootstrapCliSelection() {
      const address = yield* refusedAddress;
      const url = (user: string, password = 'fixture') =>
        `postgres://${user}:${password}@127.0.0.1:${address.port}/catalog`;
      const environment = (selectedWithoutPassword?: string): Record<string, string> =>
        Object.fromEntries<string>([
          ['DATABASE_ADMIN_URL', url('admin')] as const,
          ...DATABASE_IDENTITIES.map(({ id, role, urlKey }): [string, string] => [
            urlKey,
            id === 'party_registry_request' ? url(role, id === selectedWithoutPassword ? '' : 'fixture') : 'not-a-url',
          ]),
        ]);
      const run = (args: readonly string[], selectedWithoutPassword?: string) =>
        collectToolingProcess(
          ChildProcess.make(process.execPath, ['--no-warnings', bootstrapScript, ...args], {
            cwd: appRoot,
            env: environment(selectedWithoutPassword),
            extendEnv: true,
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
          }),
        ).pipe(
          Effect.scoped,
          Effect.map(({ status, stderr, stdout }) => ({ output: `${stdout}${stderr}`, status })),
        );

      // Invalid selections fail before any credential is read or any connection is attempted.
      for (const args of [
        [identityFlag],
        [identityFlag, ''],
        ['--unknown'],
        [identityFlag, 'shared_runtime,shared_runtime'],
        [identityFlag, 'unknown'],
      ]) {
        const result = yield* run(args);
        expect(result.status, result.output).toBe(1);
        expect(result.output).not.toContain(connectionAttempt);
      }
      const missingPassword = yield* run([identityFlag, 'party_registry_request'], 'party_registry_request');
      expect(missingPassword.status).toBe(1);
      expect(missingPassword.output).toContain('must include the party_registry_runtime login password');
      expect(missingPassword.output).not.toContain(connectionAttempt);

      // Only the selected identity's credential is read: every other identity URL is malformed.
      const selected = yield* run([identityFlag, 'party_registry_request']);
      expect(selected.status).toBe(1);
      expect(selected.output).toContain(connectionAttempt);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
