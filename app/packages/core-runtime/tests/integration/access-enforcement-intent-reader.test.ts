import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, DateTime, Effect, FileSystem, Match, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decisionAuthorityOf } from '../../src/access/enforcement/intent-reader.ts';
import type { AccessIntentReads } from '../../src/access/enforcement/intent-reader.ts';
import { makeTenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  CapabilityKeySchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { CapabilityKey, PrincipalId } from '../../src/access/ids.ts';
import type { AccessScope } from '../../src/access/model.ts';
import type { AccessIntentSource, AccessTeamId } from '../../src/access/decision/authority.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import type { DatabaseConfigValue } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

/*
 * The decision intent reader is the seam between Core's intent rows and the engine's ports
 * (CUTOVER-PLAN §3.1 step 6). This suite runs it against a real PostgreSQL with the committed
 * migration: one tenant, one company, one delegated assignment, one future-dated assignment, one
 * revoked one and one stale grant incarnation, so every read the engine performs is proven on the
 * rows a real writer would have left behind.
 *
 * The reader runs as `ontos_runtime` — the role the row-level security policies name — so tenant
 * isolation is part of every assertion instead of an assumption, and the fixtures are seeded with the
 * administrative login the other Core integration suites use.
 */
const migrationPath = new URL(
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  import.meta.url,
).pathname;

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const TENANT_A = TenantIdSchema.make(uid(1));
const TENANT_B = TenantIdSchema.make(uid(2));
const JANA = PrincipalIdSchema.make(uid(3));
const EVA = PrincipalIdSchema.make(uid(4));
const JANA_AGENT = PrincipalIdSchema.make(uid(5));
const COMPANY = uid(6);
const SCOPE_TENANT = AccessScopeIdSchema.make(uid(10));
const SCOPE_COMPANY = AccessScopeIdSchema.make(uid(11));
const SCOPE_TENANT_B = AccessScopeIdSchema.make(uid(12));
const SNAPSHOT = uid(20);
const ROLE = uid(30);
const REVISION = uid(31);
const DELEGATED_ROLE = uid(32);
const DELEGATED_REVISION = uid(33);
const ASSIGNMENT = uid(40);
const FUTURE_ASSIGNMENT = uid(41);
const DELEGATED_ASSIGNMENT = uid(42);
const REVOKED_ASSIGNMENT = uid(43);
const DELEGATION = uid(44);
const GRANT_VOID = uid(50);
const GRANT_READ = uid(51);
const GRANT_STALE = uid(52);
const GRANT_PAY = uid(53);
const MEMBER_TENANT = uid(60);
const OWNER_TENANT = uid(61);
const MEMBER_COMPANY = uid(62);
const TEAM_JANA = uid(70);
const TEAM_EVA = uid(71);
const TEAM_MEMBER_JANA = uid(72);
const TEAM_MEMBER_EVA = uid(73);
const CONNECTION = AgentConnectionIdSchema.make(uid(80));
const STALE_CONNECTION = AgentConnectionIdSchema.make(uid(81));

const VOID: CapabilityKey = CapabilityKeySchema.make('finance.invoice.void');
const READ: CapabilityKey = CapabilityKeySchema.make('finance.invoice.read');
const EXPORT: CapabilityKey = CapabilityKeySchema.make('finance.invoice.export');
const PAY: CapabilityKey = CapabilityKeySchema.make('finance.invoice.pay');

const assignmentEnd = DateTime.toDateUtc(DateTime.makeUnsafe('2027-06-01T00:00:00.000Z'));
const delegationEnd = DateTime.toDateUtc(DateTime.makeUnsafe('2027-01-01T00:00:00.000Z'));
const membershipEnd = DateTime.toDateUtc(DateTime.makeUnsafe('2027-03-01T00:00:00.000Z'));
const companyMembershipEnd = DateTime.toDateUtc(DateTime.makeUnsafe('2027-05-01T00:00:00.000Z'));
const janaHolder = { _tag: 'Principal' as const, principalId: JANA };

type Json = Schema.Schema.Type<typeof Schema.Json>;

const cell = (capabilityKey: CapabilityKey, mode: string, selector: Json): Json => ({ capabilityKey, mode, selector });
const voidCell = cell(VOID, 'run', { _tag: 'all' });
const readCell = cell(READ, 'run', { _tag: 'assigned' });
const payCell: Json = {
  amountCeiling: { currency: 'CZK', limitMinor: 500_000 },
  capabilityKey: PAY,
  mode: 'run',
  selector: { _tag: 'all' },
};
const cellsJson = (cells: readonly Json[]) =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)))(cells);
const cellJson = (value: Json) => Schema.encodeSync(Schema.fromJsonString(Schema.Json))(value);
/** One published catalog entry; only PAY moves money, so only PAY declares an amount input. */
const entryJson = (key: CapabilityKey, kind: string, extra: Readonly<Record<string, Json>> = {}) =>
  cellJson({
    key,
    kind,
    modes: ['run'],
    moduleKey: 'finance.invoice',
    placement: { group: 'finance', level: 'basic' },
    risk: 'routine',
    selectors: [],
    ...extra,
  });

/** Which context a resolved scope names, read through the one tagged union Core declares. */
const scopeTagOf = (scope: AccessScope): string =>
  Match.value(scope).pipe(
    Match.tags({ LegalEntity: () => 'LegalEntity', TenantContext: () => 'TenantContext' }),
    Match.exhaustive,
  );

/** One tenant with the intent the reader has to serve, plus a second tenant for isolation. */
const seedFixtures = (admin: PgClient.PgClient): Effect.Effect<void> =>
  Effect.gen(function* seedAccessEnforcementFixtures() {
    const statements = [
      `insert into core.tenants (tenant_id) values ('${TENANT_A}'), ('${TENANT_B}')`,
      `insert into core.legal_entities (tenant_id, legal_entity_id) values ('${TENANT_A}', '${COMPANY}')`,
      `insert into core.principals (tenant_id, principal_id, kind) values
         ('${TENANT_A}', '${JANA}', 'human'),
         ('${TENANT_A}', '${EVA}', 'human'),
         ('${TENANT_A}', '${JANA_AGENT}', 'agent')`,
      `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id) values
         ('${SCOPE_TENANT}', '${TENANT_A}', '${TENANT_A}'),
         ('${SCOPE_TENANT_B}', '${TENANT_B}', '${TENANT_B}')`,
      `insert into core.access_scopes (scope_id, tenant_id, legal_entity_id)
         values ('${SCOPE_COMPANY}', '${TENANT_A}', '${COMPANY}')`,
      `insert into core.access_catalog_snapshots (catalog_snapshot_id, digest, published_at)
         values ('${SNAPSHOT}', '${'a'.repeat(64)}', now())`,
      `insert into core.access_catalog_entries (catalog_snapshot_id, capability_key, entry_json) values
         ('${SNAPSHOT}', '${VOID}', '${entryJson(VOID, 'action')}'::jsonb),
         ('${SNAPSHOT}', '${READ}', '${entryJson(READ, 'read', { selectors: ['assigned'] })}'::jsonb),
         ('${SNAPSHOT}', '${EXPORT}', '${entryJson(EXPORT, 'read')}'::jsonb),
         ('${SNAPSHOT}', '${PAY}', '${entryJson(PAY, 'action', { amountInput: 'amount' })}'::jsonb)`,
      `insert into core.access_roles (role_id, tenant_id, created_by, name) values
         ('${ROLE}', '${TENANT_A}', '${JANA}', 'Účetní'),
         ('${DELEGATED_ROLE}', '${TENANT_A}', '${JANA}', 'Schvalovatel plateb')`,
      `insert into core.access_role_revisions
         (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
         values ('${REVISION}', '${TENANT_A}', '${ROLE}', 1, '${SNAPSHOT}', '${cellsJson([voidCell, readCell])}'::jsonb, '${JANA}', 'manual'),
                ('${DELEGATED_REVISION}', '${TENANT_A}', '${DELEGATED_ROLE}', 1, '${SNAPSHOT}', '${cellsJson([payCell])}'::jsonb, '${JANA}', 'manual')`,
      `insert into core.access_delegations
         (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys, status, valid_from, until)
         values ('${DELEGATION}', '${TENANT_A}', '${SCOPE_TENANT}', '${JANA}', '${EVA}', array['${JANA}']::uuid[],
                 array['${DELEGATED_ROLE}']::uuid[], array['${PAY}']::text[], 'active', now() - interval '1 day',
                 '${delegationEnd.toISOString()}')`,
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from, valid_until, delegated_by, delegation_envelope_json)
         values ('${ASSIGNMENT}', '${TENANT_A}', '${SCOPE_TENANT}', '${ROLE}', '${REVISION}', '${JANA}', '${EVA}', 'active',
                 now() - interval '10 days', '${assignmentEnd.toISOString()}', null, null),
                ('${FUTURE_ASSIGNMENT}', '${TENANT_A}', '${SCOPE_TENANT}', '${ROLE}', '${REVISION}', '${EVA}', '${EVA}', 'active',
                 '2099-01-01T00:00:00Z', '2099-06-01T00:00:00Z', null, null),
                ('${REVOKED_ASSIGNMENT}', '${TENANT_A}', '${SCOPE_TENANT}', '${ROLE}', '${REVISION}', '${JANA}', '${EVA}', 'revoked',
                 now() - interval '10 days', '${assignmentEnd.toISOString()}', null, null),
                ('${DELEGATED_ASSIGNMENT}', '${TENANT_A}', '${SCOPE_TENANT}', '${DELEGATED_ROLE}', '${DELEGATED_REVISION}', '${JANA}', '${EVA}', 'active',
                 now() - interval '10 days', '${assignmentEnd.toISOString()}', '${DELEGATION}',
                 '${cellJson({ amountCeiling: { currency: 'CZK', limitMinor: 120_000 }, capabilityKeys: [PAY], delegationId: DELEGATION, until: delegationEnd.toISOString() })}'::jsonb)`,
      `insert into core.access_grant_incarnations
         (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
         values ('${GRANT_VOID}', '${TENANT_A}', '${SCOPE_TENANT}', '${ROLE}', '${VOID}', 'run', 'all', '${cellJson(voidCell)}'::jsonb, 'active'),
                ('${GRANT_READ}', '${TENANT_A}', '${SCOPE_TENANT}', '${ROLE}', '${READ}', 'run', 'assigned', '${cellJson(readCell)}'::jsonb, 'active'),
                ('${GRANT_STALE}', '${TENANT_A}', '${SCOPE_TENANT}', '${ROLE}', '${EXPORT}', 'run', 'all', '${cellJson(cell(EXPORT, 'run', { _tag: 'all' }))}'::jsonb, 'active'),
                ('${GRANT_PAY}', '${TENANT_A}', '${SCOPE_TENANT}', '${DELEGATED_ROLE}', '${PAY}', 'run', 'all', '${cellJson(payCell)}'::jsonb, 'active')`,
      `insert into core.access_memberships
         (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, valid_until, recorded_by)
         values ('${MEMBER_TENANT}', '${TENANT_A}', '${SCOPE_TENANT}', '${JANA}', 'member', 'active', now() - interval '30 days', '${membershipEnd.toISOString()}', '${EVA}'),
                ('${OWNER_TENANT}', '${TENANT_A}', '${SCOPE_TENANT}', '${JANA}', 'owner', 'active', now() - interval '30 days', null, '${EVA}'),
                ('${MEMBER_COMPANY}', '${TENANT_A}', '${SCOPE_COMPANY}', '${JANA}', 'member', 'active', now() - interval '30 days', '${companyMembershipEnd.toISOString()}', '${EVA}')`,
      `insert into core.access_teams (team_id, tenant_id, scope_id, name, created_by) values
         ('${TEAM_JANA}', '${TENANT_A}', '${SCOPE_TENANT}', 'Obchod', '${EVA}'),
         ('${TEAM_EVA}', '${TENANT_A}', '${SCOPE_TENANT}', 'Sklad', '${EVA}')`,
      `insert into core.access_team_members (team_member_id, tenant_id, team_id, principal_id, added_by, added_at) values
         ('${TEAM_MEMBER_JANA}', '${TENANT_A}', '${TEAM_JANA}', '${JANA}', '${EVA}', now()),
         ('${TEAM_MEMBER_EVA}', '${TENANT_A}', '${TEAM_EVA}', '${EVA}', '${EVA}', now())`,
      `insert into core.access_agent_connections
         (connection_id, tenant_id, scope_id, agent_id, principal_id, revision, status, valid_from, valid_until, ceiling_json)
         values ('${CONNECTION}', '${TENANT_A}', '${SCOPE_TENANT}', '${JANA_AGENT}', '${JANA}', 2, 'active',
                 now() - interval '1 day', '${delegationEnd.toISOString()}', '{"cells": []}'::jsonb),
                ('${STALE_CONNECTION}', '${TENANT_A}', '${SCOPE_TENANT}', '${JANA_AGENT}', '${JANA}', 1, 'active',
                 now() - interval '1 day', '${delegationEnd.toISOString()}', '{}'::jsonb)`,
      `insert into core.access_consent_snapshots (tenant_id, connection_id, revision, ceiling_json, granted_at, granted_by) values
         ('${TENANT_A}', '${CONNECTION}', 2, '{"cells": []}'::jsonb, now() - interval '1 day', '${JANA}'),
         ('${TENANT_A}', '${STALE_CONNECTION}', 1, '{}'::jsonb, now() - interval '1 day', '${JANA}')`,
    ];
    yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie), {
      concurrency: 1,
      discard: true,
    });
  });

/**
 * Applies the committed migration unchanged, with only the Core identity tables it references. The
 * suite therefore tests the shipped SQL, including any amendment a later lane makes to it.
 */
const applyAccessMigration = (admin: PgClient.PgClient) =>
  Effect.gen(function* applyAccessMigrationEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const migration = yield* fileSystem.readFileString(migrationPath);
    for (const statement of [
      'create schema core',
      'create schema trust',
      `create function trust.current_tenant_id() returns uuid language sql stable as $$
         select nullif(current_setting('ontos.tenant_id', true), '')::uuid
       $$`,
      'create table core.tenants (tenant_id uuid primary key)',
      `create table core.legal_entities (
         tenant_id uuid not null,
         legal_entity_id uuid primary key,
         unique (tenant_id, legal_entity_id)
       )`,
      `create table core.principals (
         tenant_id uuid not null,
         principal_id uuid primary key,
         kind text not null,
         unique (tenant_id, principal_id)
       )`,
      `do $$
       begin
         if not exists (select 1 from pg_roles where rolname = 'ontos_runtime') then
           create role ontos_runtime nologin;
         end if;
       end
       $$`,
      ...migration.split('--> statement-breakpoint'),
      'grant usage on schema core to ontos_runtime',
      'grant select, insert, update, delete on all tables in schema core to ontos_runtime',
      'grant execute on all functions in schema core to ontos_runtime',
    ]) {
      if (statement.trim().length > 0) {
        yield* admin.unsafe(statement).pipe(Effect.orDie);
      }
    }
  });

const replaceDatabase = (configuration: DatabaseConfigValue, database: string): string => {
  const url = new URL(configuration.connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

/** A database of this run's own, with the migration applied as the first thing that ever touches it. */
const enforcementDatabase = Effect.gen(function* enforcementDatabaseEffect() {
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  const name = `access_enforcement_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  yield* bootstrap.unsafe(`create database "${name}"`).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() =>
    bootstrap.unsafe(`drop database if exists "${name}" with (force)`).pipe(Effect.orDie),
  );
  const admin = yield* makeTestPgClient(replaceDatabase(connections.admin, name), { maxConnections: 2 });
  yield* applyAccessMigration(admin);
  yield* seedFixtures(admin);
  const runtime = yield* makeTestPgClient(replaceDatabase(connections.runtime, name), { maxConnections: 2 });
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  const loader = makeTenantIntentLoader({ executor: database });
  // `TestClock` starts at the epoch, so only the loader's own read of "now" is taken live — exactly
  // as the intent loader suite does it (C02a).
  const reads: AccessIntentReads = {
    loadAuthorityCells: (scope, query) => TestClock.withLive(loader.loadAuthorityCells(scope, query)),
    loadConfigureBases: (scope, query) => TestClock.withLive(loader.loadConfigureBases(scope, query)),
    loadConnection: (scope, query) => TestClock.withLive(loader.loadConnection(scope, query)),
    loadScope: (scope, query) => TestClock.withLive(loader.loadScope(scope, query)),
    loadTeamIds: (scope, query) => TestClock.withLive(loader.loadTeamIds(scope, query)),
  };
  const intent: AccessIntentSource = { authorityFor: (scope) => decisionAuthorityOf(reads, scope) };
  return intent;
});

/** The trusted request scope the reader runs in: one acting person of one tenant (O66). */
const scopeFor = (
  principalId: PrincipalId,
  legalEntityId?: ReturnType<typeof LegalEntityIdSchema.make>,
): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined
      ? {
          authContextRef: 'job:access-enforcement-intent:run:1',
          authMethod: 'system',
          principalId,
          tenantId: TENANT_A,
        }
      : {
          authContextRef: 'job:access-enforcement-intent:run:1',
          authMethod: 'system',
          legalEntityId,
          principalId,
          tenantId: TENANT_A,
        },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-enforcement-intent' })),
    Effect.orDie,
  );

it.layer(NodeServices.layer)('access enforcement intent reader', (suite) => {
  suite.effect('reads the scope of one context with the membership that bounds it', () =>
    Effect.gen(function* readsScope() {
      const intent = yield* enforcementDatabase;
      const scope = yield* scopeFor(JANA);
      const tenantScope = yield* intent.authorityFor(scope).readScope({ holders: [janaHolder], tenantId: TENANT_A });
      const resolved = Option.getOrThrow(tenantScope);
      expect(resolved.scopeId).toBe(SCOPE_TENANT);
      expect(scopeTagOf(resolved.scope)).toBe('TenantContext');
      expect(resolved.holderDeadlines[0]?.deadlines.map(({ until }) => until)).toEqual([membershipEnd]);

      const company = yield* intent
        .authorityFor(scope)
        .readScope({ holders: [janaHolder], legalEntityId: LegalEntityIdSchema.make(COMPANY), tenantId: TENANT_A });
      const companyScope = Option.getOrThrow(company);
      expect(companyScope.scopeId).toBe(SCOPE_COMPANY);
      // A company decision rests on two memberships: the company's and the tenant's (D6).
      expect(new Set(companyScope.holderDeadlines[0]?.deadlines.map(({ until }) => until))).toEqual(
        new Set([membershipEnd, companyMembershipEnd]),
      );

      const unknownCompany = yield* intent
        .authorityFor(scope)
        .readScope({ holders: [janaHolder], legalEntityId: LegalEntityIdSchema.make(uid(99)), tenantId: TENANT_A });
      expect(Option.isNone(unknownCompany)).toBe(true);
    }),
  );

  suite.effect('reads the live cells of the holder and drops every assignment that grants nothing', () =>
    Effect.gen(function* readsCells() {
      const intent = yield* enforcementDatabase;
      const scope = yield* scopeFor(JANA);
      const query = {
        capabilityKey: VOID,
        holder: janaHolder,
        mode: 'run' as const,
        scopeId: SCOPE_TENANT,
        tenantId: TENANT_A,
      };
      const cells = yield* intent.authorityFor(scope).readCells(query);
      expect(cells.length).toBe(1);
      expect(cells[0]?.grantIncarnationId).toBe(GRANT_VOID);
      expect(cells[0]?.roleRevisionId).toBe(REVISION);
      expect(cells[0]?.deadline).toEqual(assignmentEnd);

      // An incarnation the pinned revision does not declare proves nothing (O51).
      expect((yield* intent.authorityFor(scope).readCells({ ...query, capabilityKey: EXPORT })).length).toBe(0);
      // A future-dated and a revoked assignment are not live.
      expect(
        (yield* intent.authorityFor(scope).readCells({ ...query, holder: { _tag: 'Principal', principalId: EVA } }))
          .length,
      ).toBe(0);
      // A cell of another scope is not this scope's authority (guarantee 3).
      expect((yield* intent.authorityFor(scope).readCells({ ...query, scopeId: SCOPE_COMPANY })).length).toBe(0);
    }),
  );

  suite.effect('narrows a delegated cell to the envelope it keeps forever', () =>
    Effect.gen(function* readsDelegatedCell() {
      const intent = yield* enforcementDatabase;
      const scope = yield* scopeFor(JANA);
      const cells = yield* intent.authorityFor(scope).readCells({
        capabilityKey: PAY,
        holder: janaHolder,
        mode: 'run',
        scopeId: SCOPE_TENANT,
        tenantId: TENANT_A,
      });
      expect(cells.length).toBe(1);
      expect(cells[0]?.deadline).toEqual(delegationEnd);
      // The decision sees the narrower of the cell's own 500 000 limit and the 120 000 the envelope
      // froze, so a delegated limit bounds the money the cell may move (D10b, R3a-M2).
      expect(cells[0]?.amountCeiling).toEqual({ currency: 'CZK', limitMinor: 120_000 });
    }),
  );

  suite.effect('reads a fresh agent connection and refuses one whose frozen ceiling does not decode', () =>
    Effect.gen(function* readsConnection() {
      const intent = yield* enforcementDatabase;
      const scope = yield* scopeFor(JANA);
      const fresh = yield* intent.authorityFor(scope).readConnection({ connectionId: CONNECTION, tenantId: TENANT_A });
      const connection = Option.getOrThrow(fresh);
      expect(connection.consentRevision).toBe(2);
      expect(connection.scopeId).toBe(SCOPE_TENANT);
      expect(connection.deadline).toEqual(delegationEnd);

      // A consent snapshot whose ceiling no longer decodes is never a fallback: the read refuses.
      const stale = yield* Effect.matchEffect(
        intent.authorityFor(scope).readConnection({ connectionId: STALE_CONNECTION, tenantId: TENANT_A }),
        { onFailure: (failure) => Effect.succeed(failure._tag), onSuccess: () => Effect.succeed('answered') },
      );
      expect(stale).toBe('AccessDecisionUnavailable');
    }),
  );

  suite.effect('reads the teams a holder takes part in inside this scope only', () =>
    Effect.gen(function* readsTeams() {
      const intent = yield* enforcementDatabase;
      const scope = yield* scopeFor(JANA);
      const teams: readonly AccessTeamId[] = yield* intent
        .authorityFor(scope)
        .readTeamIds({ holder: janaHolder, scopeId: SCOPE_TENANT, tenantId: TENANT_A });
      expect(teams).toEqual([TEAM_JANA]);
    }),
  );

  suite.effect("never answers another tenant's intent, whatever ids the query names", () =>
    Effect.gen(function* isolatesTenants() {
      const intent = yield* enforcementDatabase;
      const otherScope = yield* scopeFor(JANA);
      const scopeB: OperationalScope = {
        ...otherScope,
        tenantId: TENANT_B,
      };
      // A query naming another tenant than the installed scope is a conflict the port reports as
      // UNAVAILABLE, never a quiet empty answer that would read as a denial.
      const crossTenantCells = yield* Effect.matchEffect(
        intent.authorityFor(scopeB).readCells({
          capabilityKey: VOID,
          holder: janaHolder,
          mode: 'run',
          scopeId: SCOPE_TENANT,
          tenantId: TENANT_A,
        }),
        { onFailure: (failure) => Effect.succeed(failure._tag), onSuccess: () => Effect.succeed('answered') },
      );
      expect(crossTenantCells).toBe('AccessDecisionUnavailable');
      const crossTenantScope = yield* Effect.matchEffect(
        intent.authorityFor(scopeB).readScope({ holders: [janaHolder], tenantId: TENANT_A }),
        { onFailure: (failure) => Effect.succeed(failure._tag), onSuccess: () => Effect.succeed('answered') },
      );
      expect(crossTenantScope).toBe('AccessDecisionUnavailable');
      // The tenant-B scope exists, but Jana is not its member: a foreign holder is refused (R5a-1).
      const ownScope = yield* intent.authorityFor(scopeB).readScope({ holders: [janaHolder], tenantId: TENANT_B });
      expect(Option.isNone(ownScope)).toBe(true);
    }),
  );

  suite.effect('refuses a non-member of the second tenant context', () =>
    Effect.gen(function* readsSecondTenantScope() {
      const intent = yield* enforcementDatabase;
      const scope = yield* scopeFor(JANA);
      const scopeB: OperationalScope = { ...scope, tenantId: TENANT_B };
      const resolved = yield* intent.authorityFor(scopeB).readScope({ holders: [janaHolder], tenantId: TENANT_B });
      expect(Option.isNone(resolved)).toBe(true);
    }),
  );
});
