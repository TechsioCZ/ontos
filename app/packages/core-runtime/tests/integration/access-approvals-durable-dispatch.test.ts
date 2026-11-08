import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Context, Crypto, DateTime, Deferred, Effect, Exit, FileSystem, Layer, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import type { ActionProposalParkInput } from '../../src/access/approvals/action-mandate-dispatch.ts';
import {
  MandateDispatchPorts,
  makeDrizzleActionMandateDispatch,
} from '../../src/access/approvals/action-mandate-dispatch.ts';
import { freezeCommand } from '../../src/access/approvals/command.ts';
import {
  ApprovalStore,
  ApprovalStoreLive,
  makeJoinedDrizzleApprovalStore,
} from '../../src/access/approvals/drizzle-store.ts';
import { ActionInvocationRefSchema } from '../../src/access/approvals/execution.ts';
import { ActionKeySchema, FrozenCommands } from '../../src/access/approvals/frozen-command.ts';
import { makeDrizzleFrozenCommandStore } from '../../src/access/approvals/frozen-command-drizzle-store.ts';
import { proposalIdForInvocation } from '../../src/access/approvals/proposal-invocation-id.ts';
import type { ApprovalsPorts } from '../../src/access/approvals/service.ts';
import { makeApprovalsService } from '../../src/access/approvals/service.ts';
import { makeDrizzleAccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
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
  ProposalId,
  TenantId,
} from '../../src/access/ids.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import type { AccessMode, AuthorityWitness, Holder, Proposal, WitnessPurpose } from '../../src/access/model.ts';
import { CellSchema } from '../../src/access/model.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import type { DatabaseConfigValue } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../src/db/types.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import {
  makeInMemoryApprovalCatalog,
  makeMutableApprovalClock,
  makeScriptedApprovalIdentifiers,
  makeScriptedProjection,
  makeScriptedScopeAdministration,
} from '../unit/access-approvals-support.ts';

/*
 * The durable propose/execute path against a real PostgreSQL (O75, O90). Everything that touches SQL
 * here is the shipped store, the shipped frozen-command repository and the shipped mandate-dispatch
 * adapter, run as `ontos_runtime` under the migration's row-level security. Only the authority
 * projection (the gate's evidence), the published catalog, the clock and the scope administration are
 * scripted: those are external authority ports, not storage, and this suite says so instead of
 * pretending the engine answered.
 *
 * What this proves:
 *
 * - a proposal, its append-only frozen command and the Action invocation's terminal `proposed`
 *   receipt commit or roll back together;
 * - a duplicate proposal insert is a skipped row, so the second propose inside one transaction still
 *   reads its own record instead of hitting PostgreSQL's aborted-transaction state (SQLSTATE 25P02);
 * - a stored proposal is answered only to the same invocation, scope, capability, target, digest and
 *   requester; any other binding is a conflict and writes nothing;
 * - the mandate's approved→executed CAS and its receipt commit or roll back with the owner write, one
 *   mandate executes at most once, and the proposal keeps the invocation it was proposed by.
 *
 * It does not prove the owner Action's own handler, crash recovery or the live gate's composition:
 * those belong to the Action runtime lane and to the integration rollup.
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
const EXECUTION_INVOCATION = ActionInvocationRefSchema.make(uid(52));
/** Every instant is far in the future so the suite never depends on the machine clock (O60). */
const PARKED_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'));
const APPROVED_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2099-01-01T00:05:00.000Z'));
const EXECUTED_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2099-01-01T00:30:00.000Z'));

const PAYLOAD = { invoice: 'invoice-1', reason: 'freeze' } as const;
/** The mandate brand the Action transport carries; the schema itself stays owned by the Action lane. */
const mandateIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('MandateId'));
const decodeMandateId = Schema.decodeSync(mandateIdSchema);
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

const approvalWitness = witnessOf({
  assignmentIncarnationId: EVA_ASSIGNMENT,
  capabilityKey: VOID_KEY,
  grantIncarnationId: GRANTS['void:approve'],
  holderId: holder(EVA),
  purpose: 'approval',
});

const executionWitness = witnessOf({
  assignmentIncarnationId: EVA_ASSIGNMENT,
  capabilityKey: VOID_KEY,
  grantIncarnationId: GRANTS['void:run'],
  holderId: holder(EVA),
  purpose: 'execution',
});

const parentReadWitness = witnessOf({
  assignmentIncarnationId: EVA_ASSIGNMENT,
  capabilityKey: READ_KEY,
  grantIncarnationId: GRANTS['read:run'],
  holderId: holder(EVA),
  purpose: 'parent_record_read',
});

const boundWitnesses = [requesterWitness, approvalWitness, executionWitness, parentReadWitness] as const;

/** The gate's propose-mode answer for this command: one live propose cell in the proposal's scope. */
const gateDecision = (): AccessDecision => ({
  evidence: [
    {
      assignedAt: PARKED_AT,
      assignedBy: EVA,
      mode: 'propose',
      roleId: ROLE,
      roleRevisionId: ROLE_REVISION_ID,
      selector: 'all',
      side: 'principal',
      witness: requesterWitness,
    },
  ],
  outcome: 'NEEDS_APPROVAL',
  reasons: [{ code: 'approval.required' }],
  selectors: [{ selector: 'all', side: 'principal' }],
});

const approvedProposal = (proposal: Proposal): Proposal => ({
  ...proposal,
  approval: {
    approvalAssignmentIncarnationId: EVA_ASSIGNMENT,
    approvedAt: APPROVED_AT,
    approverId: EVA,
    executionAssignmentIncarnationId: EVA_ASSIGNMENT,
    expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe('2099-01-02T00:05:00.000Z')),
  },
  status: 'approved',
  witnesses: boundWitnesses,
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
      /*
       * A test-owned probe standing in for the owner Action's business write. It is the only table in
       * this suite that is not shipped SQL, and it exists to show one commit boundary, nothing more.
       */
      `create table public.action_owner_write (
         owner_write_id uuid primary key default gen_random_uuid(),
         tenant_id uuid not null,
         action_invocation_id uuid not null
       )`,
      'grant usage on schema core to ontos_runtime',
      'grant select on all tables in schema core to ontos_runtime',
      'grant update on core.action_invocations to ontos_runtime',
      'grant insert, update on core.access_proposals to ontos_runtime',
      'grant insert on core.access_mandates, core.access_mandate_grants, core.access_decision_logs to ontos_runtime',
      'grant execute on all functions in schema core to ontos_runtime',
      'grant select, insert on public.action_owner_write to ontos_runtime',
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

const publishedCapability = {
  capabilityKey: VOID_KEY,
  kind: 'action' as const,
  modes: ['run', 'propose', 'approve'] as const,
  parentRecordReadCapabilityKey: READ_KEY,
  risk: 'sensitive' as const,
  selectors: ['all'] as const,
};

/**
 * The production propose/execute adapter over the shipped stores. Only the external authority ports
 * are scripted; a fact the projection does not hold answers a lost witness, never a lenient allow.
 *
 * `inTransaction` is the one capability the mandate paths require (O75): the records a claim reads are
 * rebuilt over the caller's own transaction, and the scripted projection — which holds no database
 * fact at all — answers the same inside any transaction. Without it, parking into an owner
 * transaction and claiming a mandate are both unavailable.
 */
const dispatchFixture = Effect.fn('durableDispatchFixture')(function* dispatchFixtureEffect() {
  const { admin, executor, frozenCommands, store } = yield* durableDatabase;
  const crypto = yield* Crypto.Crypto;
  yield* seedAccess(admin);
  const projection = makeScriptedProjection(ROLE_REVISION_ID);
  projection.bind(requesterWitness, 'propose');
  projection.bind(approvalWitness, 'approve');
  projection.bind(executionWitness, 'run');
  projection.bind(parentReadWitness, 'run');
  const clock = makeMutableApprovalClock(PARKED_AT);
  const portsOf = (scope: OperationalScope, transaction?: CoreTransaction): ApprovalsPorts => {
    const records =
      transaction === undefined
        ? store.recordsFor(scope)
        : makeJoinedDrizzleApprovalStore(
            { enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, frozenCommands, transaction },
            crypto,
          ).recordsFor(scope);
    const ports: ApprovalsPorts = {
      administrators: makeScriptedScopeAdministration([]),
      authority: projection,
      catalog: makeInMemoryApprovalCatalog([publishedCapability]),
      clock,
      identifiers: makeScriptedApprovalIdentifiers([ProposalIdSchema.make(uid(90))]),
      store: records,
    };
    return { ...ports, inTransaction: (ownerTransaction) => portsOf(scope, ownerTransaction) };
  };
  const dispatch = yield* makeDrizzleActionMandateDispatch().pipe(
    Effect.provideService(MandateDispatchPorts, {
      approvalsFor: (scope: OperationalScope) => makeApprovalsService(portsOf(scope)),
      database: { executor },
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      frozenCommands,
      principalKinds: makeDrizzleAccessPrincipalKinds({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor }),
    }),
  );
  return { admin, clock, dispatch, executor, projection, store };
});

type Dispatch = Effect.Success<ReturnType<typeof dispatchFixture>>['dispatch'];

const parkInput = (
  scope: OperationalScope,
  transaction: CoreTransaction,
  input: Partial<ActionProposalParkInput> = {},
): ActionProposalParkInput => ({
  actionInvocationId: INVOCATION,
  actionKey: ACTION_KEY,
  capabilityKey: VOID_KEY,
  decision: gateDecision(),
  now: PARKED_AT,
  payload: PAYLOAD,
  scope,
  target: RECORD,
  transaction,
  ...input,
});

/** Propose inside the caller's transaction, exactly as the owner Action's runner does (O80, O90). */
const parkIn = (
  dispatch: Dispatch,
  scope: OperationalScope,
  transaction: CoreTransaction,
  input: Partial<ActionProposalParkInput> = {},
) =>
  installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
    Effect.andThen(() => dispatch.parkProposal(parkInput(scope, transaction, input))),
  );

const countOf = (admin: PgClient.PgClient, table: string, tenantId: string = TENANT) =>
  admin.unsafe<{ count: string }>(`select count(*)::text as count from ${table} where tenant_id = '${tenantId}'`).pipe(
    Effect.orDie,
    Effect.map((rows) => Number(rows[0]?.count ?? '0')),
  );

const invocationRow = (admin: PgClient.PgClient, actionInvocationId: string) =>
  admin
    .unsafe<{ completed_at: Date | null; status: string }>(
      `select status, completed_at from core.action_invocations where action_invocation_id = '${actionInvocationId}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    );

const proposalReceipt = (admin: PgClient.PgClient, proposalId: ProposalId) =>
  admin
    .unsafe<{ action_invocation_id: string | null; execution_operation_id: string | null; status: string }>(
      `select status, action_invocation_id, execution_operation_id
         from core.access_proposals where proposal_id = '${proposalId}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    );

const mandateIdOf = (admin: PgClient.PgClient, proposalId: ProposalId) =>
  admin
    .unsafe<{ mandate_id: string }>(`select mandate_id from core.access_mandates where proposal_id = '${proposalId}'`)
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]?.mandate_id ?? ''),
    );

const ownerWrites = (admin: PgClient.PgClient) => countOf(admin, 'public.action_owner_write');

const backendPid = (transaction: CoreTransaction) =>
  transaction
    .execute<{ readonly pid: number }>(sql`select pg_backend_pid() as pid`, 'objects')
    .pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.die(new Error('Expected the transaction backend PID'))
          : Effect.succeed(rows[0].pid),
      ),
    );

const competingProposalInsert = (input: {
  readonly dispatch: Dispatch;
  readonly executor: CoreDatabaseExecutor;
  readonly firstParked: Deferred.Deferred<number>;
  readonly scope: OperationalScope;
  readonly secondStarted: Deferred.Deferred<{ readonly holderPid: number; readonly waiterPid: number }>;
}) =>
  Effect.gen(function* competingProposal() {
    const holderPid = yield* Deferred.await(input.firstParked);
    return yield* input.executor.transaction((transaction) =>
      Effect.gen(function* insertInCompetingTransaction() {
        const waiterPid = yield* backendPid(transaction);
        yield* Deferred.succeed(input.secondStarted, { holderPid, waiterPid });
        return yield* parkIn(input.dispatch, input.scope, transaction);
      }),
    );
  });

/** Observe an actual blocked proposal INSERT, not merely a scheduled concurrent fiber. */
const awaitBlockedProposalInsert = (admin: PgClient.PgClient, holderPid: number, waiterPid: number) =>
  admin
    .unsafe<{ readonly blocked: boolean }>(
      `select $1::integer = any(pg_blocking_pids(pid)) and query like $3 as blocked
       from pg_stat_activity where pid = $2::integer`,
      [holderPid, waiterPid, '%insert into "core"."access_proposals"%'],
    )
    .pipe(
      Effect.repeat({ until: (rows) => rows[0]?.blocked === true }),
      Effect.timeout('5 seconds'),
      TestClock.withLive,
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

/** A test-owned probe standing in for the owner Action's business write in the same transaction. */
const ownerWrite = (transaction: CoreTransaction, actionInvocationId: string) =>
  transaction
    .execute(
      sql`insert into public.action_owner_write (tenant_id, action_invocation_id)
          values (${TENANT}, ${actionInvocationId})`,
    )
    .pipe(Effect.asVoid);

/** One assertion for every immutable-binding mismatch (O90.4). */
const expectStorageConflict = (code: string) => expect(code).toBe('approval_storage_conflict');

const proposalIdOf = proposalIdForInvocation(TENANT, INVOCATION);
const secondProposalId = proposalIdForInvocation(TENANT, SECOND_INVOCATION);

it.layer(NodeServices.layer)('durable propose and execute dispatch', (suite) => {
  suite.effect('commits the proposal, its frozen command and the proposed receipt together (O90.3)', () =>
    Effect.gen(function* parkedTogether() {
      const { admin, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      const parked = yield* executor.transaction((transaction) => parkIn(dispatch, scope, transaction));

      expect(parked.proposalId).toBe(proposalIdOf);
      const stored = Option.getOrThrow(yield* store.load(scope, { proposalId: proposalIdOf }));
      expect(stored.status).toBe('pending');
      expect(stored.commandDigest).toBe(COMMAND_DIGEST);
      expect(yield* countOf(admin, 'core.access_frozen_commands')).toBe(1);
      const receipt = yield* proposalReceipt(admin, proposalIdOf);
      expect(receipt?.action_invocation_id).toBe(INVOCATION);
      expect(receipt?.execution_operation_id).toBeNull();
      const invocation = yield* invocationRow(admin, INVOCATION);
      expect(invocation?.status).toBe('proposed');
      expect(invocation?.completed_at).toBeInstanceOf(Date);
      const [privileges] = yield* admin.unsafe<{ readonly canDelete: boolean; readonly canUpdate: boolean }>(
        `select has_table_privilege('ontos_runtime', 'core.access_frozen_commands', 'DELETE') as "canDelete",
                has_table_privilege('ontos_runtime', 'core.access_frozen_commands', 'UPDATE') as "canUpdate"`,
      );
      expect(privileges).toEqual({ canDelete: false, canUpdate: false });
    }),
  );

  suite.effect('rolls the proposal, its frozen command and the receipt back together (O90.5)', () =>
    Effect.gen(function* rolledBack() {
      const { admin, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      const exit = yield* Effect.exit(
        executor.transaction((transaction) =>
          parkIn(dispatch, scope, transaction).pipe(Effect.andThen(Effect.fail('owner write failed'))),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Option.isNone(yield* store.load(scope, { proposalId: proposalIdOf }))).toBe(true);
      expect(yield* countOf(admin, 'core.access_proposals')).toBe(0);
      expect(yield* countOf(admin, 'core.access_frozen_commands')).toBe(0);
      const invocation = yield* invocationRow(admin, INVOCATION);
      // The retry the same idempotency key needs: the invocation never left `received`.
      expect(invocation?.status).toBe('received');
      expect(invocation?.completed_at).toBeNull();
    }),
  );

  suite.effect('replays a matching propose inside one transaction without aborting it (O90.4)', () =>
    Effect.gen(function* replayInTransaction() {
      const { admin, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      const outcome = yield* executor.transaction((transaction) =>
        Effect.gen(function* twice() {
          const first = yield* parkIn(dispatch, scope, transaction);
          const second = yield* parkIn(dispatch, scope, transaction);
          // The 25P02 regression: a statement after the duplicate still runs in this transaction.
          const afterwards = yield* store.load(scope, { proposalId: proposalIdOf });
          return { afterwards, first, second };
        }),
      );
      expect(outcome.first.proposalId).toBe(proposalIdOf);
      expect(outcome.second.proposalId).toBe(proposalIdOf);
      expect(Option.getOrThrow(outcome.afterwards).status).toBe('pending');
      expect(yield* countOf(admin, 'core.access_proposals')).toBe(1);
      expect(yield* countOf(admin, 'core.access_frozen_commands')).toBe(1);
      expect((yield* invocationRow(admin, INVOCATION))?.status).toBe('proposed');
    }),
  );

  suite.effect('answers a committed propose with its own receipt, never a second proposal', () =>
    Effect.gen(function* replayCommitted() {
      const { admin, dispatch, executor } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      yield* executor.transaction((transaction) => parkIn(dispatch, scope, transaction));
      const replay = yield* executor.transaction((transaction) => parkIn(dispatch, scope, transaction));
      expect(replay.proposalId).toBe(proposalIdOf);
      expect(yield* countOf(admin, 'core.access_proposals')).toBe(1);
      expect(yield* countOf(admin, 'core.access_frozen_commands')).toBe(1);

      const parked = yield* dispatch.loadParkedProposal({ actionInvocationId: INVOCATION, scope });
      expect(Option.getOrThrow(parked).proposalId).toBe(proposalIdOf);
      // No receipt, no answer: an invocation that never finished proposing has no stored 202.
      expect(Option.isNone(yield* dispatch.loadParkedProposal({ actionInvocationId: SECOND_INVOCATION, scope }))).toBe(
        true,
      );
    }),
  );

  suite.effect('refuses a stored proposal unless every immutable binding matches (O90.4)', () =>
    Effect.gen(function* bindingMatrix() {
      const { admin, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      const approverScope = yield* scopeFor(EVA);
      yield* executor.transaction((transaction) => parkIn(dispatch, scope, transaction));
      const stored = Option.getOrThrow(yield* store.load(scope, { proposalId: proposalIdOf }));

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

  suite.effect('answers the propose that lost the duplicate race with the same receipt (O90.4)', () =>
    Effect.gen(function* racingProposes() {
      const { admin, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      const firstParked = yield* Deferred.make<number>();
      const secondStarted = yield* Deferred.make<{ readonly holderPid: number; readonly waiterPid: number }>();
      const releaseFirst = yield* Deferred.make<null>();
      // The first transaction cannot commit until PostgreSQL itself reports the second INSERT
      // blocked by it. The bounded observation loop fails if that interleaving never happens.
      const first = executor.transaction((transaction) =>
        Effect.gen(function* holdingProposalInsert() {
          const pid = yield* backendPid(transaction);
          const parked = yield* parkIn(dispatch, scope, transaction);
          yield* Deferred.succeed(firstParked, pid);
          yield* Deferred.await(releaseFirst);
          return parked;
        }),
      );
      const second = competingProposalInsert({ dispatch, executor, firstParked, scope, secondStarted });
      const observedWait = Deferred.await(secondStarted).pipe(
        Effect.flatMap(({ holderPid, waiterPid }) => awaitBlockedProposalInsert(admin, holderPid, waiterPid)),
        Effect.andThen(Deferred.succeed(releaseFirst, null)),
      );
      const [winner, loser] = yield* Effect.all([first, second, observedWait], { concurrency: 3 });

      expect(winner.proposalId).toBe(proposalIdOf);
      expect(loser.proposalId).toBe(proposalIdOf);
      expect(yield* countOf(admin, 'core.access_proposals')).toBe(1);
      expect(yield* countOf(admin, 'core.access_frozen_commands')).toBe(1);
      expect((yield* invocationRow(admin, INVOCATION))?.status).toBe('proposed');
      expect(Option.getOrThrow(yield* store.load(scope, { proposalId: proposalIdOf })).status).toBe('pending');
    }),
  );

  suite.effect('refuses a stored 202 for a proposal the invocation did not finish proposing', () =>
    Effect.gen(function* staleProposalIsNoReceipt() {
      const { admin, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      // A proposal row bound to the invocation without its terminal receipt: the crash window a
      // recovery sweep would leave behind. It must never be answered as a finished propose.
      const parkedOnDisk = yield* store.createWithFrozenCommand(scope, {
        actionInvocationId: SECOND_INVOCATION,
        frozen: {
          actionKey: ACTION_KEY,
          command: COMMAND,
          commandDigest: COMMAND_DIGEST,
          proposalId: secondProposalId,
          scopeId: SCOPE,
          tenantId: TENANT,
        },
        proposal: {
          capabilityKey: VOID_KEY,
          commandDigest: COMMAND_DIGEST,
          createdAt: PARKED_AT,
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe('2099-01-08T00:00:00.000Z')),
          id: secondProposalId,
          requester: { _tag: 'Principal', principalId: JANA },
          scopeId: SCOPE,
          status: 'pending',
          target: RECORD,
          tenantId: TENANT,
          witnesses: [requesterWitness],
        },
      });
      expect(parkedOnDisk.id).toBe(secondProposalId);
      expect(yield* countOf(admin, 'core.access_proposals')).toBe(1);
      expect(Option.isNone(yield* dispatch.loadParkedProposal({ actionInvocationId: SECOND_INVOCATION, scope }))).toBe(
        true,
      );
      // And proposing it for real completes the receipt the invocation was missing.
      const parked = yield* executor.transaction((transaction) =>
        parkIn(dispatch, scope, transaction, { actionInvocationId: SECOND_INVOCATION }),
      );
      expect(parked.proposalId).toBe(secondProposalId);
      expect((yield* invocationRow(admin, SECOND_INVOCATION))?.status).toBe('proposed');
      expect(yield* countOf(admin, 'core.access_proposals')).toBe(1);
    }),
  );

  suite.effect('refuses replay when a terminal proposal has no frozen command, or belongs to another requester', () =>
    Effect.gen(function* incompleteReceipt() {
      const { admin, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      yield* executor.transaction((transaction) => parkIn(dispatch, scope, transaction));
      expect(
        Option.isNone(
          yield* dispatch.loadParkedProposal({ actionInvocationId: INVOCATION, scope: yield* scopeFor(EVA) }),
        ),
      ).toBe(true);
      const stored = Option.getOrThrow(yield* store.load(scope, { proposalId: proposalIdOf }));
      // Deliberately incomplete recovery state: a generic proposal linked to a terminal invocation,
      // but never given a frozen command. A terminal status alone cannot certify a stored 202.
      yield* store.create(scope, { ...stored, id: secondProposalId });
      yield* admin.unsafe(
        `update core.access_proposals set action_invocation_id = '${SECOND_INVOCATION}' where proposal_id = '${secondProposalId}'`,
      );
      yield* admin.unsafe(
        `update core.action_invocations set status = 'proposed', completed_at = now() where action_invocation_id = '${SECOND_INVOCATION}'`,
      );
      expect(Option.isNone(yield* dispatch.loadParkedProposal({ actionInvocationId: SECOND_INVOCATION, scope }))).toBe(
        true,
      );
      const refused = yield* executor.transaction((transaction) =>
        refusalOf(parkIn(dispatch, scope, transaction, { actionInvocationId: SECOND_INVOCATION })),
      );
      expect(refused).toBe('action_permission_check_failed');
      expect(yield* countOf(admin, 'core.access_frozen_commands')).toBe(1);
    }),
  );

  suite.effect('executes one mandate in the approval transaction and rolls the receipt back with it (O75)', () =>
    Effect.gen(function* executeOnce() {
      const { admin, clock, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      const approverScope = yield* scopeFor(EVA);
      yield* executor.transaction((transaction) => parkIn(dispatch, scope, transaction));
      const stored = Option.getOrThrow(yield* store.load(scope, { proposalId: proposalIdOf }));
      clock.set(APPROVED_AT);
      yield* store.recordsFor(approverScope).save({ expectedStatus: 'pending', proposal: approvedProposal(stored) });
      const mandateId = yield* mandateIdOf(admin, proposalIdOf);
      expect(mandateId.length).toBeGreaterThan(0);

      const prepared = yield* dispatch
        .prepare({
          actionKey: ACTION_KEY,
          capabilityKey: VOID_KEY,
          legalEntityScope: 'optional',
          mandateId: decodeMandateId(mandateId),
          requestPayload: null,
          scope: approverScope,
        })
        .pipe(Effect.orDie);

      const claimIn = (transaction: CoreTransaction, actionInvocationId: typeof EXECUTION_INVOCATION) =>
        dispatch.claim({
          actionInvocationId,
          now: EXECUTED_AT,
          prepared,
          scope: approverScope,
          transaction,
        });
      // A failed owner write leaves the mandate approved, with no receipt and no owner row.
      const rolledBack = yield* Effect.exit(
        executor.transaction((transaction) =>
          installOperationalScope(transaction, approverScope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
            Effect.andThen(() => claimIn(transaction, EXECUTION_INVOCATION)),
            Effect.andThen(() => ownerWrite(transaction, EXECUTION_INVOCATION)),
            Effect.andThen(Effect.fail('owner write failed')),
          ),
        ),
      );
      expect(Exit.isFailure(rolledBack)).toBe(true);
      expect((yield* proposalReceipt(admin, proposalIdOf))?.status).toBe('approved');
      expect((yield* proposalReceipt(admin, proposalIdOf))?.execution_operation_id).toBeNull();
      expect(yield* ownerWrites(admin)).toBe(0);

      // The retry commits the CAS, the receipt and the owner write together.
      yield* executor.transaction((transaction) =>
        installOperationalScope(transaction, approverScope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
          Effect.andThen(() => claimIn(transaction, EXECUTION_INVOCATION)),
          Effect.andThen(() => ownerWrite(transaction, EXECUTION_INVOCATION)),
        ),
      );
      const executed = yield* proposalReceipt(admin, proposalIdOf);
      expect(executed?.status).toBe('executed');
      expect(executed?.execution_operation_id).toBe(EXECUTION_INVOCATION);
      // The proposal keeps the invocation it was PROPOSED by; execution has its own receipt (O90).
      expect(executed?.action_invocation_id).toBe(INVOCATION);
      expect(yield* ownerWrites(admin)).toBe(1);

      // A second mandate execution with another invocation loses the compare-and-set.
      const second = yield* refusalOf(
        executor.transaction((transaction) =>
          installOperationalScope(transaction, approverScope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
            Effect.andThen(() => claimIn(transaction, INVOCATION)),
            Effect.andThen(() => ownerWrite(transaction, INVOCATION)),
          ),
        ),
      );
      expect(second).toBe('action_permission_denied');
      expect((yield* proposalReceipt(admin, proposalIdOf))?.execution_operation_id).toBe(EXECUTION_INVOCATION);
      expect(yield* ownerWrites(admin)).toBe(1);
    }),
  );

  suite.effect('binds the mandate dispatch to the approved frozen command and its approver', () =>
    Effect.gen(function* dispatchBindings() {
      const { admin, clock, dispatch, executor, store } = yield* dispatchFixture();
      const scope = yield* scopeFor(JANA);
      const approverScope = yield* scopeFor(EVA);
      yield* executor.transaction((transaction) => parkIn(dispatch, scope, transaction));
      const stored = Option.getOrThrow(yield* store.load(scope, { proposalId: proposalIdOf }));
      clock.set(APPROVED_AT);
      yield* store.recordsFor(approverScope).save({ expectedStatus: 'pending', proposal: approvedProposal(stored) });
      const mandateId = yield* mandateIdOf(admin, proposalIdOf);
      const prepare = (overrides: {
        readonly actionKey: string;
        readonly capabilityKey: string;
        readonly requestPayload?: unknown;
        readonly scope: OperationalScope;
      }) =>
        dispatch.prepare({
          actionKey: overrides.actionKey,
          capabilityKey: overrides.capabilityKey,
          legalEntityScope: 'optional',
          mandateId: decodeMandateId(mandateId),
          requestPayload: overrides.requestPayload ?? null,
          scope: overrides.scope,
        });

      const prepared = yield* prepare({ actionKey: ACTION_KEY, capabilityKey: VOID_KEY, scope: approverScope }).pipe(
        Effect.orDie,
      );
      expect(prepared.approverId).toBe(EVA);
      expect(prepared.commandDigest).toBe(COMMAND_DIGEST);
      expect(prepared.proposalId).toBe(proposalIdOf);
      // Another Action, another capability, another person and a request-supplied command are refused.
      expect(
        yield* refusalOf(prepare({ actionKey: 'finance.invoice.read', capabilityKey: VOID_KEY, scope: approverScope })),
      ).toBe('action_permission_denied');
      expect(yield* refusalOf(prepare({ actionKey: ACTION_KEY, capabilityKey: READ_KEY, scope: approverScope }))).toBe(
        'action_permission_denied',
      );
      expect(yield* refusalOf(prepare({ actionKey: ACTION_KEY, capabilityKey: VOID_KEY, scope }))).toBe(
        'action_permission_denied',
      );
      expect(
        yield* refusalOf(
          prepare({
            actionKey: ACTION_KEY,
            capabilityKey: VOID_KEY,
            requestPayload: { invoice: 'invoice-2' },
            scope: approverScope,
          }),
        ),
      ).toBe('action_permission_denied');
    }),
  );
});
