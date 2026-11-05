import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, DateTime, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import type { DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import { decideAccess } from '../../src/access/decision/engine.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { makeSpiceDbDecisionCheckPort } from '../../src/access/decision/spicedb-check-port.ts';
import { decisionAuthorityOf } from '../../src/access/enforcement/intent-reader.ts';
import type { AccessIntentReads } from '../../src/access/enforcement/intent-reader.ts';
import type { CapabilityKey, LegalEntityId, PrincipalId } from '../../src/access/ids.ts';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { intentUnavailable } from '../../src/access/intent/errors.ts';
import { makeTenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import type { DatabaseConfigValue } from '../../src/db/config.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient, openSpiceDbGrpcRpc } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

/*
 * O81's structural branch on real intent: PostgreSQL holds the memberships, owners and delegations,
 * the committed migration shapes those tables, and the same decision gate answers the admin key from
 * them without a single adopted role cell — so "newly published admin keys reach the owner and admins
 * without adoption" is proven on rows a real writer would have left behind, not on a scripted double.
 * A live SpiceDB answers every role-cell question the same gate still asks beside the basis.
 */
const migrationPath = new URL(
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  import.meta.url,
).pathname;

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const TENANT = TenantIdSchema.make(uid(1));
const OWNER = PrincipalIdSchema.make(uid(2));
const ADMIN = PrincipalIdSchema.make(uid(3));
const DELEGATE = PrincipalIdSchema.make(uid(4));
const MEMBER = PrincipalIdSchema.make(uid(5));
const COMPANY_A = LegalEntityIdSchema.make(uid(6));
const COMPANY_B = LegalEntityIdSchema.make(uid(7));
const SCOPE_TENANT = AccessScopeIdSchema.make(uid(10));
const SCOPE_A = AccessScopeIdSchema.make(uid(11));
const SCOPE_B = AccessScopeIdSchema.make(uid(12));
const ADMIN_KEY: CapabilityKey = CapabilityKeySchema.make('core.access.roles.publish');
const OUTSIDE_KEY: CapabilityKey = CapabilityKeySchema.make('core.access.people.revoke');

const roleId = uid(20);
/** The one end date every management window in this fixture shares, seeded relative to insert time. */
const MANAGEMENT_WINDOW = "now() + interval '1 day'";

const policy: DecisionCapabilityPolicy = {
  capabilityKey: ADMIN_KEY,
  kind: 'admin',
  modes: ['run'],
  risk: 'critical',
  selectors: [],
};

const surfacePolicy = capabilityPolicyOf(
  decodeAccessDeclarationOrThrow(
    {
      admitsAdminSurface: true,
      key: 'core.access.overview.view',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'access', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    { access: 'read', authorization: { kind: 'protected' }, moduleKey: 'core.access', role: 'page' },
  ),
);

const replaceDatabase = (configuration: DatabaseConfigValue, database: string): string => {
  const url = new URL(configuration.connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

/** The committed migration unchanged, with only the Core identity tables it references. */
const applyMigration = (admin: PgClient.PgClient) =>
  Effect.gen(function* applyAccessMigration() {
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
      `create table core.tenant_module_states (
         tenant_module_state_id uuid primary key,
         tenant_id uuid not null,
         module_key text not null,
         state text not null,
         created_at timestamp with time zone default now() not null,
         updated_at timestamp with time zone default now() not null,
         unique (tenant_id, module_key)
       )`,
      `do $$
       begin
         if not exists (select 1 from pg_roles where rolname = 'ontos_runtime') then
           create role ontos_runtime nologin;
         end if;
         if not exists (select 1 from pg_roles where rolname = 'party_registry_runtime') then
           create role party_registry_runtime nologin;
         end if;
       end
       $$`,
      ...migration.split('--> statement-breakpoint'),
      'grant usage on schema core to ontos_runtime',
      'grant select on all tables in schema core to ontos_runtime',
      'grant execute on all functions in schema core to ontos_runtime',
    ]) {
      if (statement.trim().length > 0) {
        yield* admin.unsafe(statement).pipe(Effect.orDie);
      }
    }
  });

/**
 * Two companies, one owner, one company access administrator with an expiring membership, one
 * delegate whose envelope covers exactly the admin key, and one ordinary member. Every holder is a
 * live `member` of the tenant context as well, which is what a real scope resolution rests on (D6).
 */
const seed = (admin: PgClient.PgClient) =>
  Effect.gen(function* seedStructuralIntent() {
    const statements = [
      `insert into core.tenants (tenant_id) values ('${TENANT}')`,
      `insert into core.legal_entities (tenant_id, legal_entity_id) values
         ('${TENANT}', '${COMPANY_A}'),
         ('${TENANT}', '${COMPANY_B}')`,
      `insert into core.principals (tenant_id, principal_id, kind) values
         ('${TENANT}', '${OWNER}', 'human'),
         ('${TENANT}', '${ADMIN}', 'human'),
         ('${TENANT}', '${DELEGATE}', 'human'),
         ('${TENANT}', '${MEMBER}', 'human')`,
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
         ('${uid(21)}', '${TENANT}', 'core.access', 'active')`,
      `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id) values
         ('${SCOPE_TENANT}', '${TENANT}', '${TENANT}')`,
      `insert into core.access_scopes (scope_id, tenant_id, legal_entity_id) values
         ('${SCOPE_A}', '${TENANT}', '${COMPANY_A}'),
         ('${SCOPE_B}', '${TENANT}', '${COMPANY_B}')`,
      `insert into core.access_memberships
         (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, valid_until, recorded_by)
         values
         ('${uid(30)}', '${TENANT}', '${SCOPE_TENANT}', '${OWNER}', 'member', 'active', now() - interval '2 days', null, '${OWNER}'),
         ('${uid(31)}', '${TENANT}', '${SCOPE_TENANT}', '${OWNER}', 'owner', 'active', now() - interval '2 days', null, '${OWNER}'),
         ('${uid(32)}', '${TENANT}', '${SCOPE_TENANT}', '${ADMIN}', 'member', 'active', now() - interval '2 days', null, '${OWNER}'),
         ('${uid(33)}', '${TENANT}', '${SCOPE_A}', '${ADMIN}', 'member', 'active', now() - interval '2 days', now() + interval '12 hours', '${OWNER}'),
         ('${uid(34)}', '${TENANT}', '${SCOPE_A}', '${ADMIN}', 'access_admin', 'active', now() - interval '2 days', ${MANAGEMENT_WINDOW}, '${OWNER}'),
         ('${uid(35)}', '${TENANT}', '${SCOPE_TENANT}', '${DELEGATE}', 'member', 'active', now() - interval '2 days', null, '${OWNER}'),
         ('${uid(36)}', '${TENANT}', '${SCOPE_TENANT}', '${MEMBER}', 'member', 'active', now() - interval '2 days', null, '${OWNER}'),
         ('${uid(37)}', '${TENANT}', '${SCOPE_A}', '${DELEGATE}', 'member', 'active', now() - interval '2 days', null, '${OWNER}'),
         ('${uid(38)}', '${TENANT}', '${SCOPE_A}', '${MEMBER}', 'member', 'active', now() - interval '2 days', null, '${OWNER}')`,
      `insert into core.access_delegations
         (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys, status,
          valid_from, until)
         values ('${uid(40)}', '${TENANT}', '${SCOPE_A}', '${OWNER}', '${DELEGATE}', array['${MEMBER}']::uuid[],
                 array['${roleId}']::uuid[], array['${ADMIN_KEY}']::text[], 'active', now() - interval '2 days',
                 ${MANAGEMENT_WINDOW})`,
    ];
    yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie), {
      concurrency: 1,
      discard: true,
    });
  });

/** A database of this run's own, its migration applied, and the loader reading it as `ontos_runtime`. */
const structuralIntent = Effect.gen(function* structuralIntentEffect() {
  const connections = yield* loadDatabaseConnectionPair({ envPath: `${import.meta.filename}.no-environment-file` });
  const crypto = yield* Crypto.Crypto;
  const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  const name = `access_structural_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  yield* bootstrap.unsafe(`create database "${name}"`).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() =>
    bootstrap.unsafe(`drop database if exists "${name}" with (force)`).pipe(Effect.orDie),
  );
  const admin = yield* makeTestPgClient(replaceDatabase(connections.admin, name), { maxConnections: 2 });
  yield* applyMigration(admin);
  yield* seed(admin);
  const runtime = yield* makeTestPgClient(replaceDatabase(connections.runtime, name), { maxConnections: 2 });
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  const loader = makeTenantIntentLoader({ executor: database });
  // The suite excludes the test services, so every read here uses the real clock: the membership
  // windows are seeded relative to it and each decision passes the same instant as `now`.
  const reads: AccessIntentReads = {
    loadAuthorityCells: (scope, query) => loader.loadAuthorityCells(scope, query),
    loadConfigureBases: (scope, query) => loader.loadConfigureBases(scope, query),
    loadConnection: (scope, query) => loader.loadConnection(scope, query),
    loadScope: (scope, query) => loader.loadScope(scope, query),
    loadTeamIds: (scope, query) => loader.loadTeamIds(scope, query),
  };
  return { admin, reads };
});

/**
 * The trusted request scope one decision runs in: one acting person of this tenant (O66). The scope
 * itself is tenant-level; the company a decision names travels with the request, never in the scope.
 */
const scopeFor = (principalId: PrincipalId): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authContextRef: 'job:access-structural:run:1',
    authMethod: 'system',
    principalId,
    tenantId: TENANT,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-structural' })),
    Effect.orDie,
  );

it.layer(NodeServices.layer, { excludeTestServices: true })(
  'access structural admin on PostgreSQL and SpiceDB',
  (suite) => {
    suite.effect('answers the admin key from live configure bases, never from adoption', () =>
      Effect.gen(function* structuralAdminAgainstRealIntent() {
        const { admin, reads } = yield* structuralIntent;
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const rows = yield* admin
          .unsafe<{ until: Date }>(
            `select valid_until as until from core.access_memberships where membership_id = '${uid(34)}'`,
          )
          .pipe(Effect.orDie);
        // The access-admin membership's own end date, exactly as PostgreSQL stored it.
        const adminDeadline =
          rows[0]?.until ??
          (yield* Effect.die(new Error('the seeded access-admin membership is missing its end date')));
        const memberDeadline = DateTime.toDateUtc(
          DateTime.subtract(DateTime.fromDateUnsafe(adminDeadline), { hours: 12 }),
        );
        const afterMemberExpiry = DateTime.toDateUtc(
          DateTime.add(DateTime.fromDateUnsafe(memberDeadline), { minutes: 1 }),
        );
        const afterExpiry = DateTime.toDateUtc(DateTime.add(DateTime.fromDateUnsafe(adminDeadline), { minutes: 1 }));
        const configuration = yield* loadSpiceDbConfig({ envPath: `${import.meta.filename}.no-environment-file` });
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => newSpiceDbGrpcClient(configuration)),
          (one) => Effect.sync(() => one.close()),
        );
        const rpc = yield* Effect.acquireRelease(
          Effect.sync(() => openSpiceDbGrpcRpc(configuration, 5000)),
          (one) => Effect.sync(() => one.close()),
        );
        yield* Effect.tryPromise(() =>
          client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        ).pipe(Effect.orDie);
        const check = makeSpiceDbDecisionCheckPort(rpc);
        const decide = (who: PrincipalId, legalEntityId?: LegalEntityId, at = now, key = ADMIN_KEY) =>
          Effect.gen(function* oneDecision() {
            const scope = yield* scopeFor(who);
            return yield* decideAccess(decisionAuthorityOf(reads, scope), check, {
              actor: withOptional(
                { actor: { _tag: 'Principal' as const, principalId: who }, tenantId: TENANT },
                'legalEntityId',
                legalEntityId,
              ),
              now: at,
              request: {
                capability: key === surfacePolicy.capabilityKey ? surfacePolicy : { ...policy, capabilityKey: key },
                mode: 'run',
              },
            });
          });

        // The owner holds every scope without a role cell, in the tenant and in both companies.
        for (const company of [undefined, COMPANY_A, COMPANY_B]) {
          const answer = yield* decide(OWNER, company);
          expect(answer.outcome).toBe('ALLOWED');
          expect(answer.evidence).toEqual([]);
          expect(answer.reasons.map(({ code }) => code)).toEqual(['structural.owner']);
        }

        // A company access administrator is management power in their own company only, bounded by
        // the live membership's own end date.
        const ownCompany = yield* decide(ADMIN, COMPANY_A);
        expect(ownCompany.outcome).toBe('ALLOWED');
        expect(ownCompany.reasons.map(({ code }) => code)).toEqual(['structural.access_admin']);
        expect(ownCompany.admissionDeadline).toEqual(memberDeadline);
        const overview = yield* decide(ADMIN, undefined, now, surfacePolicy.capabilityKey);
        expect(overview.outcome).toBe('ALLOWED');
        expect(overview.reasons.map(({ code }) => code)).toEqual(['structural.access_admin_any']);
        expect(overview.admissionDeadline).toEqual(memberDeadline);
        expect((yield* decide(ADMIN, COMPANY_A, afterMemberExpiry)).outcome).toBe('DENIED');
        expect((yield* decide(ADMIN, undefined, afterMemberExpiry, surfacePolicy.capabilityKey)).outcome).toBe(
          'DENIED',
        );
        expect((yield* decide(ADMIN, COMPANY_B)).outcome).toBe('DENIED');
        expect((yield* decide(ADMIN)).outcome).toBe('DENIED');

        // A delegation reaches exactly its own scope and the capability keys it names (D10, P8).
        const delegated = yield* decide(DELEGATE, COMPANY_A);
        expect(delegated.reasons.map(({ code }) => code)).toEqual(['structural.delegation']);
        expect((yield* decide(DELEGATE, COMPANY_B)).outcome).toBe('DENIED');
        expect((yield* decide(DELEGATE, COMPANY_A, now, OUTSIDE_KEY)).outcome).toBe('DENIED');

        // Expiry is intent: the same request after both windows closed proves nothing.
        expect((yield* decide(ADMIN, COMPANY_A, afterExpiry)).outcome).toBe('DENIED');
        expect((yield* decide(DELEGATE, COMPANY_A, afterExpiry)).outcome).toBe('DENIED');

        // An ordinary member of the company holds no management power at all.
        const member = yield* decide(MEMBER, COMPANY_A);
        expect(member.outcome).toBe('DENIED');
        expect(member.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');

        // A live membership elsewhere on the path must not mask suspension. Structural admission
        // skips graph permission checks, so the loader must enforce the same suspension subtraction.
        yield* admin.unsafe(
          `update core.access_memberships set status = 'suspended' where membership_id = '${uid(33)}'`,
        );
        expect((yield* decide(ADMIN, COMPANY_A)).outcome).toBe('DENIED');
        expect((yield* decide(ADMIN, undefined, now, surfacePolicy.capabilityKey)).outcome).toBe('DENIED');
        yield* admin.unsafe(`update core.access_memberships set status = 'active' where membership_id = '${uid(33)}'`);
        expect((yield* decide(ADMIN, COMPANY_A)).outcome).toBe('ALLOWED');

        yield* admin.unsafe(
          `update core.access_memberships set status = 'suspended' where membership_id = '${uid(32)}'`,
        );
        expect((yield* decide(ADMIN, COMPANY_A)).outcome).toBe('DENIED');
        yield* admin.unsafe(`update core.access_memberships set status = 'active' where membership_id = '${uid(32)}'`);
        expect((yield* decide(ADMIN, COMPANY_A)).outcome).toBe('ALLOWED');

        yield* admin.unsafe(
          `update core.access_memberships set status = 'suspended' where membership_id = '${uid(30)}'`,
        );
        expect((yield* decide(OWNER)).outcome).toBe('DENIED');
        expect((yield* decide(OWNER, COMPANY_A)).outcome).toBe('DENIED');
        yield* admin.unsafe(`update core.access_memberships set status = 'active' where membership_id = '${uid(30)}'`);

        // A delegation cannot stand in for the manager's own company membership either.
        yield* admin.unsafe(
          `update core.access_memberships set status = 'suspended' where membership_id = '${uid(37)}'`,
        );
        expect((yield* decide(DELEGATE, COMPANY_A)).outcome).toBe('DENIED');
        yield* admin.unsafe(`update core.access_memberships set status = 'active' where membership_id = '${uid(37)}'`);
        expect((yield* decide(DELEGATE, COMPANY_A)).outcome).toBe('ALLOWED');

        // Revocation is final. The still-live access_admin assignment must not admit even the
        // tenant overview after its prerequisite company membership has been revoked.
        yield* admin.unsafe(`update core.access_memberships set status = 'revoked' where membership_id = '${uid(33)}'`);
        expect((yield* decide(ADMIN, COMPANY_A)).outcome).toBe('DENIED');
        expect((yield* decide(ADMIN, undefined, now, surfacePolicy.capabilityKey)).outcome).toBe('DENIED');

        // An unreadable configure source is UNAVAILABLE, never a denial and never an empty basis set.
        const scope = yield* scopeFor(OWNER);
        const unreadable = yield* decideAccess(
          decisionAuthorityOf(
            { ...reads, loadConfigureBases: () => Effect.fail(intentUnavailable('configure intent unavailable')) },
            scope,
          ),
          check,
          {
            actor: { actor: { _tag: 'Principal', principalId: OWNER }, tenantId: TENANT },
            now,
            request: { capability: policy, mode: 'run' },
          },
        );
        expect(unreadable.outcome).toBe('UNAVAILABLE');
        expect(unreadable.reasons.map(({ code }) => code)).toEqual(['unavailable.intent']);
      }),
    );
  },
);
