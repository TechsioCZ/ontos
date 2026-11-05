import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Cause, Crypto, Effect, Exit, FileSystem, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { freezeCommand } from '../../src/access/approvals/command.ts';
import { makeDrizzleFrozenCommandStore } from '../../src/access/approvals/frozen-command-drizzle-store.ts';
import { ActionKeySchema, verifyFrozenCommand } from '../../src/access/approvals/frozen-command.ts';
import type { FrozenCommandRecord } from '../../src/access/approvals/frozen-command.ts';
import { AccessScopeIdSchema, CapabilityKeySchema, ProposalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { loadDatabaseConnectionPair, parseDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

const migrationPath = new URL(
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  import.meta.url,
).pathname;
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const tenant = TenantIdSchema.make(uid(1));
const foreignTenant = TenantIdSchema.make(uid(2));
const scopeId = AccessScopeIdSchema.make(uid(3));
const principalId = uid(4);
const proposalId = ProposalIdSchema.make(uid(5));
const capabilityKey = CapabilityKeySchema.make('finance.invoice.void');
const command = { capabilityKey, payload: { invoice: uid(12), reason: 'Approved' } };
const digest = Result.getOrThrow(freezeCommand(command));
const record: FrozenCommandRecord = {
  actionKey: ActionKeySchema.make('finance.invoice.void'),
  command,
  commandDigest: digest,
  proposalId,
  scopeId,
  tenantId: tenant,
};

const scopeFor = (tenantId: typeof tenant): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: uid(7),
    authContextRef: 'better-auth-session:frozen-commands-test',
    authMethod: 'session',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'frozen-command-integration' })),
    Effect.orDie,
  );

const urlFor = (connection: string, database: string) => {
  const url = new URL(connection);
  url.pathname = `/${database}`;
  return url.href;
};

const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* refusalEffect() {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
  });

const seed = (admin: PgClient.PgClient) =>
  Effect.gen(function* seedEffect() {
    for (const statement of [
      `insert into core.tenants (tenant_id) values ('${tenant}'), ('${foreignTenant}')`,
      `insert into core.principals (tenant_id, principal_id, kind) values ('${tenant}', '${principalId}', 'human')`,
      `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id) values ('${scopeId}', '${tenant}', '${tenant}')`,
      `insert into core.access_proposals
      (proposal_id, tenant_id, scope_id, capability_key, command_digest, created_at, expires_at,
       requester_json, requester_principal_id, requester_authority_json, status)
     values ('${proposalId}', '${tenant}', '${scopeId}', '${capabilityKey}', '${digest}', now(), now() + interval '7 days',
       '{"_tag":"Principal","principalId":"${principalId}"}'::jsonb, '${principalId}',
       '[{"purpose":"requester"}]'::jsonb, 'pending')`,
    ]) {
      yield* admin.unsafe(statement);
    }
  });

const database = Effect.gen(function* databaseEffect() {
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const name = `c29_frozen_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const bootstrap = yield* makeTestPgClient(connections.admin.connectionString);
  yield* bootstrap.unsafe(`create database "${name}"`);
  yield* Effect.addFinalizer(() =>
    bootstrap.unsafe(`drop database if exists "${name}" with (force)`).pipe(Effect.orDie),
  );
  const isolated = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: urlFor(connections.admin.connectionString, name),
    DATABASE_URL: urlFor(connections.runtime.connectionString, name),
  });
  const admin = yield* makeTestPgClient(isolated.admin.connectionString);
  for (const statement of [
    'create schema core',
    'create table core.tenants (tenant_id uuid primary key)',
    'create table core.legal_entities (tenant_id uuid not null, legal_entity_id uuid primary key, unique (tenant_id, legal_entity_id))',
    'create table core.principals (tenant_id uuid not null, principal_id uuid primary key, kind text not null, unique (tenant_id, principal_id))',
    'create schema trust',
    `create function trust.current_tenant_id() returns uuid language sql stable as $$
      select nullif(current_setting('ontos.tenant_id', true), '')::uuid $$`,
  ]) {
    yield* admin.unsafe(statement);
  }
  const migration = yield* fileSystem.readFileString(migrationPath);
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim().length > 0) {
      yield* admin.unsafe(statement);
    }
  }
  yield* admin.unsafe('grant usage on schema core to ontos_runtime');
  yield* admin.unsafe('grant select, insert on core.access_frozen_commands to ontos_runtime');
  const runtime = yield* makeTestPgClient(isolated.runtime.connectionString);
  const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { admin, executor, store: makeDrizzleFrozenCommandStore({ executor }) };
});

it.layer(NodeServices.layer)('frozen-command PostgreSQL repository', (suite) => {
  suite.effect(
    'appends, loads and verifies one command; another tenant sees nothing',
    Effect.fnUntraced(function* appendLoad() {
      const { admin, store } = yield* database;
      yield* seed(admin);
      const own = yield* scopeFor(tenant);
      const foreign = yield* scopeFor(foreignTenant);
      yield* store.append(own, record);
      const loaded = yield* store.load(own, { proposalId, scopeId });
      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isSome(loaded)) {
        expect(Result.isSuccess(verifyFrozenCommand(loaded.value))).toBe(true);
        expect(loaded.value.frozenAt).toBeInstanceOf(Date);
      }
      expect(Option.isNone(yield* store.load(foreign, { proposalId, scopeId }))).toBe(true);
      expect((yield* refusal(store.append(own, record)))?.code).toBe('frozen_command_conflict');
      expect((yield* refusal(store.append(foreign, record)))?.code).toBe('approval_storage_conflict');
      const corrupted = { ...record, command: { ...command, payload: { invoice: uid(13) } } };
      expect((yield* refusal(store.append(own, corrupted)))?.code).toBe('frozen_command_integrity');
    }),
  );

  suite.effect(
    'refuses mutations and a mismatched proposal FK',
    Effect.fnUntraced(function* immutableAndBound() {
      const { admin, store } = yield* database;
      yield* seed(admin);
      const own = yield* scopeFor(tenant);
      yield* store.append(own, record);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            admin.unsafe(
              `update core.access_frozen_commands set action_key = 'other' where proposal_id = '${proposalId}'`,
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            admin.unsafe(`delete from core.access_frozen_commands where proposal_id = '${proposalId}'`),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            admin.unsafe(`insert into core.access_frozen_commands
      (tenant_id, proposal_id, scope_id, capability_key, action_key, command_digest, command_json)
      values ('${tenant}', '${uid(99)}', '${scopeId}', '${capabilityKey}', 'finance.invoice.void', '${digest}', '{}'::jsonb)`),
          ),
        ),
      ).toBe(true);
      // Even privileged corruption outside the public writer must fail closed on the next read.
      yield* admin.unsafe(
        'alter table core.access_frozen_commands disable trigger core_access_frozen_commands_append_only',
      );
      yield* admin.unsafe(
        `update core.access_frozen_commands set command_json = '{"capabilityKey":"finance.invoice.void","payload":{"invoice":"changed"}}'::jsonb where proposal_id = '${proposalId}'`,
      );
      yield* admin.unsafe(
        'alter table core.access_frozen_commands enable trigger core_access_frozen_commands_append_only',
      );
      expect((yield* refusal(store.load(own, { proposalId, scopeId })))?.code).toBe('frozen_command_integrity');
    }),
  );

  suite.effect(
    'joins the caller transaction: rollback stores nothing',
    Effect.fnUntraced(function* rollbackAppend() {
      const { admin, executor, store } = yield* database;
      yield* seed(admin);
      const own = yield* scopeFor(tenant);
      const exit = yield* Effect.exit(
        executor.transaction((transaction) =>
          store.appendInTransaction(own, record, transaction).pipe(Effect.andThen(Effect.fail('rollback'))),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Option.isNone(yield* store.load(own, { proposalId, scopeId }))).toBe(true);
    }),
  );
});
