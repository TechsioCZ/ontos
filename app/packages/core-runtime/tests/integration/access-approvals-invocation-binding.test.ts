import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Context, Crypto, DateTime, Effect, FileSystem, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { freezeCommand } from '../../src/access/approvals/command.ts';
import { ApprovalStore, ApprovalStoreLive } from '../../src/access/approvals/drizzle-store.ts';
import { ActionInvocationRefSchema } from '../../src/access/approvals/execution.ts';
import { ActionKeySchema, FrozenCommands } from '../../src/access/approvals/frozen-command.ts';
import { makeDrizzleFrozenCommandStore } from '../../src/access/approvals/frozen-command-drizzle-store.ts';
import { proposalIdForInvocation } from '../../src/access/approvals/proposal-invocation-id.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
  RecordKeySchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type {
  AccessScopeId,
  AssignmentIncarnationId,
  CapabilityKey,
  GrantIncarnationId,
  PrincipalId,
  TenantId,
} from '../../src/access/ids.ts';
import type { AccessMode, AuthorityWitness, Holder, Proposal, WitnessPurpose } from '../../src/access/model.ts';
import { CellSchema } from '../../src/access/model.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import type { DatabaseConfigValue } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * One proposal per Action invocation against a real PostgreSQL (O90.4). Everything that touches SQL here is
 * the shipped approval store and frozen-command repository, run as `ontos_runtime` under the migration's
 * row-level security. A stored proposal is answered only to the same invocation, requester, scope,
 * capability, Action, target and command digest; any other binding is a conflict and writes nothing.
 *
 * The durable propose/execute dispatch over the registered forward Action (atomic receipt, replay, race,
 * rollback, mandate binding) is proved end to end by the Shell's native suites
 * `action-live-v2-dispatch` and `action-live-v2-durable-dispatch`.
 */
const migrationPath = new URL(
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  import.meta.url,
).pathname;
const authorityV2MigrationPath = new URL(
  '../../drizzle/20261107110051_full-target-action-authority-v2/migration.sql',
  import.meta.url,
).pathname;

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const TENANT = TenantIdSchema.make(uid(1));
const OTHER_TENANT = TenantIdSchema.make(uid(2));
const SCOPE = AccessScopeIdSchema.make(uid(3));
const OTHER_SCOPE = AccessScopeIdSchema.make(uid(30));
const JANA = PrincipalIdSchema.make(uid(4));
const EVA = PrincipalIdSchema.make(uid(5));
const CATALOG_SNAPSHOT = uid(6);
const ROLE = RoleIdSchema.make(uid(7));
const ROLE_REVISION_ID = RoleRevisionIdSchema.make(uid(8));
const JANA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(9));
const EVA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(10));
const VOID_KEY = CapabilityKeySchema.make('finance.invoice.void');
const READ_KEY = CapabilityKeySchema.make('finance.invoice.read');
const ACTION_KEY = ActionKeySchema.make('finance.invoice.void');
const RECORD = RecordKeySchema.make('invoice-1');
const INVOCATION = ActionInvocationRefSchema.make(uid(50));
const SECOND_INVOCATION = ActionInvocationRefSchema.make(uid(51));
/** Every instant is far in the future so the suite never depends on the machine clock (O60). */
const PARKED_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'));

const PAYLOAD = { invoice: 'invoice-1', reason: 'freeze' } as const;
const COMMAND = { capabilityKey: VOID_KEY, payload: PAYLOAD, target: RECORD } as const;
const COMMAND_DIGEST = CommandDigestSchema.make(Result.getOrThrow(freezeCommand(COMMAND)));

const cellJson = Schema.encodeSync(Schema.fromJsonString(CellSchema));
const cellsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CellSchema)));

const replaceDatabase = (configuration: DatabaseConfigValue, database: string): string => {
  const url = new URL(configuration.connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

const GRANTS = {
  'read:run': GrantIncarnationIdSchema.make(uid(20)),
  'void:approve': GrantIncarnationIdSchema.make(uid(21)),
  'void:propose': GrantIncarnationIdSchema.make(uid(22)),
  'void:run': GrantIncarnationIdSchema.make(uid(23)),
} as const;

const CELLS = [
  { capabilityKey: READ_KEY, grant: GRANTS['read:run'], mode: 'run' },
  { capabilityKey: VOID_KEY, grant: GRANTS['void:approve'], mode: 'approve' },
  { capabilityKey: VOID_KEY, grant: GRANTS['void:propose'], mode: 'propose' },
  { capabilityKey: VOID_KEY, grant: GRANTS['void:run'], mode: 'run' },
] as const;

const cellOf = (cell: (typeof CELLS)[number]) => ({
  capabilityKey: cell.capabilityKey,
  mode: cell.mode,
  selector: { _tag: 'all' as const },
});

const holder = (principalId: PrincipalId): Holder => ({ _tag: 'Principal', principalId });

const modeOfPurpose = (purpose: WitnessPurpose): AccessMode => {
  if (purpose === 'approval') {
    return 'approve';
  }
  return purpose === 'requester' ? 'propose' : 'run';
};

const witnessOf = (input: {
  readonly assignmentIncarnationId: AssignmentIncarnationId;
  readonly capabilityKey: CapabilityKey;
  readonly grantIncarnationId: GrantIncarnationId;
  readonly holderId: Holder;
  readonly purpose: WitnessPurpose;
}): AuthorityWitness => ({
  assignmentIncarnationId: input.assignmentIncarnationId,
  capabilityKey: input.capabilityKey,
  grantIncarnationId: input.grantIncarnationId,
  holderId: input.holderId,
  mode: modeOfPurpose(input.purpose),
  purpose: input.purpose,
  scopeId: SCOPE,
});

const requesterWitness = witnessOf({
  assignmentIncarnationId: JANA_ASSIGNMENT,
  capabilityKey: VOID_KEY,
  grantIncarnationId: GRANTS['void:propose'],
  holderId: holder(JANA),
  purpose: 'requester',
});

/** Applies the committed access migration unchanged, over the identity stubs it expects to find. */
const applyAccessMigration = (admin: PgClient.PgClient) =>
  Effect.gen(function* applyAccessMigrationEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const migration = yield* fileSystem.readFileString(migrationPath);
    const authorityV2Migration = yield* fileSystem.readFileString(authorityV2MigrationPath);
    const statements = [
      'create schema core',
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
      /*
       * The status vocabulary of `core.action_invocations` BEFORE the access migration amends it: a
       * propose receipt is not a state this table knew, so the migration's own ALTER is what makes
       * O90.3 storable here.
       */
      `create table core.action_invocations (
         action_invocation_id uuid primary key default gen_random_uuid(),
         tenant_id uuid not null,
         principal_id uuid,
         action_key text not null,
         idempotency_key text,
         status text not null,
         request_hash text not null,
         started_at timestamp with time zone not null default now(),
         completed_at timestamp with time zone,
         constraint core_action_invocations_status_ck
           check (status in ('received', 'rejected', 'running', 'succeeded', 'failed', 'indeterminate', 'replayed'))
       )`,
      'alter table core.action_invocations enable row level security',
      'alter table core.action_invocations force row level security',
      `create policy action_invocations_tenant_isolation on core.action_invocations
         using (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid)
         with check (tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid)`,
      // The migration's gateway policies call this function; a real database has it from the trust
      // migration, and this suite installs the same tenant-setting stand-in the other access suites do.
      'create schema trust',
      `create function trust.current_tenant_id() returns uuid language sql stable as $$
         select nullif(current_setting('ontos.tenant_id', true), '')::uuid $$`,
      // The migration's policies name these roles; the real database holds them from bootstrap.
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
      ...authorityV2Migration.split('--> statement-breakpoint'),
      'grant usage on schema core to ontos_runtime',
      'grant select on all tables in schema core to ontos_runtime',
      'grant update on core.action_invocations to ontos_runtime',
      'grant insert, update on core.access_proposals to ontos_runtime',
      'grant insert on core.access_mandates, core.access_mandate_grants, core.access_decision_logs to ontos_runtime',
      'grant execute on all functions in schema core to ontos_runtime',
    ];
    yield* Effect.forEach(
      statements,
      (statement) =>
        statement.trim().length === 0 ? Effect.void : admin.unsafe(statement).pipe(Effect.orDie, Effect.asVoid),
      { concurrency: 1, discard: true },
    );
  });

/** One tenant whose role holds the propose, approve and run cells a mandate binds. */
const seedAccess = (admin: PgClient.PgClient) =>
  Effect.gen(function* seedAccessEffect() {
    const statements = [
      `insert into core.tenants (tenant_id) values ('${TENANT}'), ('${OTHER_TENANT}')`,
      `insert into core.principals (tenant_id, principal_id, kind) values
         ('${TENANT}', '${JANA}', 'human'),
         ('${TENANT}', '${EVA}', 'human')`,
      `insert into core.access_catalog_snapshots (catalog_snapshot_id, digest, published_at)
         values ('${CATALOG_SNAPSHOT}', '${'a'.repeat(64)}', now())`,
      `insert into core.access_catalog_entries (catalog_snapshot_id, capability_key, entry_json) values
         ('${CATALOG_SNAPSHOT}', '${VOID_KEY}', '{"key": "${VOID_KEY}"}'::jsonb),
         ('${CATALOG_SNAPSHOT}', '${READ_KEY}', '{"key": "${READ_KEY}"}'::jsonb)`,
      `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id)
         values ('${SCOPE}', '${TENANT}', '${TENANT}'),
                ('${OTHER_SCOPE}', '${OTHER_TENANT}', '${OTHER_TENANT}')`,
      `insert into core.access_roles (role_id, tenant_id, created_by, name)
         values ('${ROLE}', '${TENANT}', '${JANA}', 'Účetní')`,
      `insert into core.access_role_revisions
         (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
         values ('${ROLE_REVISION_ID}', '${TENANT}', '${ROLE}', 1, '${CATALOG_SNAPSHOT}',
                 '${cellsJson(CELLS.map(cellOf))}'::jsonb, '${JANA}', 'manual')`,
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
         values ('${JANA_ASSIGNMENT}', '${TENANT}', '${SCOPE}', '${ROLE}', '${ROLE_REVISION_ID}', '${JANA}', '${EVA}', 'active', now()),
                ('${EVA_ASSIGNMENT}', '${TENANT}', '${SCOPE}', '${ROLE}', '${ROLE_REVISION_ID}', '${EVA}', '${EVA}', 'active', now())`,
      ...CELLS.map(
        (cell) =>
          `insert into core.access_grant_incarnations
             (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
             values ('${cell.grant}', '${TENANT}', '${SCOPE}', '${ROLE}', '${cell.capabilityKey}', '${cell.mode}',
                     'all', '${cellJson(cellOf(cell))}'::jsonb, 'active')`,
      ),
      // The invocation rows the owner runner receives before it proposes anything.
      `insert into core.action_invocations
         (action_invocation_id, tenant_id, principal_id, action_key, idempotency_key, status, request_hash)
         values ('${INVOCATION}', '${TENANT}', '${JANA}', '${ACTION_KEY}', 'idem-1', 'received', '${'c'.repeat(64)}'),
                ('${SECOND_INVOCATION}', '${TENANT}', '${JANA}', '${ACTION_KEY}', 'idem-2', 'received', '${'d'.repeat(64)}')`,
    ];
    yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie, Effect.asVoid), {
      concurrency: 1,
      discard: true,
    });
  });

const durableDatabase = Effect.gen(function* durableDatabaseEffect() {
  // This disposable-database suite uses explicit process configuration, never the workspace .env.
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const crypto = yield* Crypto.Crypto;
  const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  const name = `access_durable_dispatch_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  yield* bootstrap.unsafe(`create database "${name}"`).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() =>
    bootstrap.unsafe(`drop database if exists "${name}" with (force)`).pipe(Effect.orDie),
  );
  const admin = yield* makeTestPgClient(replaceDatabase(connections.admin, name), { maxConnections: 2 });
  yield* applyAccessMigration(admin);
  /*
   * Parking holds one transaction of its own and opens a second one for the acting principal kind,
   * and a claim opens one for the proposal read, so the pool must serve both without starving itself.
   */
  const runtime = yield* makeTestPgClient(replaceDatabase(connections.runtime, name), { maxConnections: 8 });
  const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  const frozenCommands = makeDrizzleFrozenCommandStore({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor });
  const store = Context.get(
    yield* Layer.build(
      ApprovalStoreLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CoreDatabase, { executor }),
            Layer.succeed(FrozenCommands, frozenCommands),
            Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
          ),
        ),
      ),
    ),
    ApprovalStore,
  );
  return { admin, executor, frozenCommands, store };
});

/** The trusted request scope a store or dispatch call runs in: one acting person of one tenant (O66). */
const scopeFor = (principalId: PrincipalId, tenantId: TenantId = TENANT): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authContextRef: 'job:access-durable-dispatch:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-durable-dispatch' })),
    Effect.orDie,
  );

const countOf = (admin: PgClient.PgClient, table: string, tenantId: string = TENANT) =>
  admin.unsafe<{ count: string }>(`select count(*)::text as count from ${table} where tenant_id = '${tenantId}'`).pipe(
    Effect.orDie,
    Effect.map((rows) => Number(rows[0]?.count ?? '0')),
  );

/** The stable refusal code a failure carries; anything else is a defect this suite never expects. */
const codeOf = <Failure>(failure: Failure): string =>
  Schema.is(Schema.Struct({ code: Schema.String }))(failure) ? failure.code : 'untyped_failure';

/** The refusal code of a call that must fail. */
const refusalOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  Effect.result(effect).pipe(
    Effect.flatMap(
      Result.match({
        onFailure: (failure) => Effect.succeed(codeOf(failure)),
        onSuccess: () => Effect.die(new Error('Expected a typed refusal, but the operation succeeded')),
      }),
    ),
  );

/** One assertion for every immutable-binding mismatch (O90.4). */
const expectStorageConflict = (code: string) => expect(code).toBe('approval_storage_conflict');

const proposalIdOf = proposalIdForInvocation(TENANT, INVOCATION);

/** The pending proposal one invocation stored with its frozen command, as the propose path writes it. */
const storeProposal = (store: (typeof ApprovalStore)['Service'], scope: OperationalScope) =>
  store.createWithFrozenCommand(scope, {
    actionInvocationId: INVOCATION,
    frozen: {
      actionKey: ACTION_KEY,
      command: COMMAND,
      commandDigest: COMMAND_DIGEST,
      proposalId: proposalIdOf,
      scopeId: SCOPE,
      tenantId: TENANT,
    },
    proposal: {
      capabilityKey: VOID_KEY,
      commandDigest: COMMAND_DIGEST,
      createdAt: PARKED_AT,
      expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe('2099-01-08T00:00:00.000Z')),
      id: proposalIdOf,
      requester: { _tag: 'Principal', principalId: JANA },
      scopeId: SCOPE,
      status: 'pending',
      target: RECORD,
      tenantId: TENANT,
      witnesses: [requesterWitness],
    },
  });

it.layer(NodeServices.layer)('proposal invocation binding', (suite) => {
  suite.effect('refuses a stored proposal unless every immutable binding matches (O90.4)', () =>
    Effect.gen(function* bindingMatrix() {
      const { admin, executor, store } = yield* durableDatabase;
      yield* seedAccess(admin);
      const scope = yield* scopeFor(JANA);
      const approverScope = yield* scopeFor(EVA);
      const stored = yield* storeProposal(store, scope);
      // The same request again is the same row, never a second proposal.
      expect((yield* storeProposal(store, scope)).id).toBe(stored.id);

      const attempt = (
        transaction: CoreTransaction,
        change: {
          readonly actionKey?: typeof ACTION_KEY;
          readonly capabilityKey?: CapabilityKey;
          readonly payload?: Schema.Json;
          readonly scopeId?: AccessScopeId;
          readonly target?: typeof RECORD;
        },
      ) => {
        const capabilityKey = change.capabilityKey ?? VOID_KEY;
        const target = change.target ?? RECORD;
        const command = { capabilityKey, payload: change.payload ?? PAYLOAD, target };
        const commandDigest = CommandDigestSchema.make(Result.getOrThrow(freezeCommand(command)));
        const proposal: Proposal = {
          ...stored,
          capabilityKey,
          commandDigest,
          scopeId: change.scopeId ?? SCOPE,
          target,
        };
        return store.createWithFrozenCommand(scope, {
          actionInvocationId: INVOCATION,
          frozen: {
            actionKey: change.actionKey ?? ACTION_KEY,
            command,
            commandDigest,
            proposalId: proposalIdOf,
            scopeId: proposal.scopeId,
            tenantId: TENANT,
          },
          proposal,
          transaction,
        });
      };

      yield* executor.transaction((transaction) =>
        Effect.gen(function* mismatches() {
          // Every attempt below is internally consistent and differs from the stored row in exactly
          // one immutable binding, so only PostgreSQL's duplicate check can refuse it.
          expectStorageConflict(yield* refusalOf(attempt(transaction, { payload: { ...PAYLOAD, reason: 'changed' } })));
          expectStorageConflict(yield* refusalOf(attempt(transaction, { capabilityKey: READ_KEY })));
          expectStorageConflict(
            yield* refusalOf(attempt(transaction, { actionKey: ActionKeySchema.make('finance.invoice.other-action') })),
          );
          expectStorageConflict(yield* refusalOf(attempt(transaction, { target: RecordKeySchema.make('invoice-2') })));
          expectStorageConflict(yield* refusalOf(attempt(transaction, { scopeId: OTHER_SCOPE })));
          // A foreign person may not even claim the invocation: the scope is refused before SQL.
          expectStorageConflict(
            yield* refusalOf(
              store.createWithFrozenCommand(approverScope, {
                actionInvocationId: INVOCATION,
                frozen: {
                  actionKey: ACTION_KEY,
                  command: COMMAND,
                  commandDigest: COMMAND_DIGEST,
                  proposalId: proposalIdOf,
                  scopeId: SCOPE,
                  tenantId: TENANT,
                },
                proposal: stored,
                transaction,
              }),
            ),
          );
        }),
      );
      expect(yield* countOf(admin, 'core.access_proposals')).toBe(1);
      expect(yield* countOf(admin, 'core.access_frozen_commands')).toBe(1);
    }),
  );
});
