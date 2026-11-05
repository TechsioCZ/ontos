import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Context, Crypto, Effect, Exit, FileSystem, Layer, Option, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { freezeCommand } from '../../src/access/approvals/command.ts';
import {
  MandateDispatchPorts,
  makeDrizzleActionMandateDispatch,
} from '../../src/access/approvals/action-mandate-dispatch.ts';
import {
  ApprovalStore,
  ApprovalStoreLive,
  makeJoinedDrizzleApprovalStore,
} from '../../src/access/approvals/drizzle-store.ts';
import type { WitnessFacts } from '../../src/access/approvals/execution.ts';
import { ActionInvocationRefSchema, witnessAuthorityOf } from '../../src/access/approvals/execution.ts';
import type { FrozenCommandStore } from '../../src/access/approvals/frozen-command.ts';
import { ActionKeySchema, FrozenCommands } from '../../src/access/approvals/frozen-command.ts';
import { makeDrizzleFrozenCommandStore } from '../../src/access/approvals/frozen-command-drizzle-store.ts';
import type { LiveApprovalServices } from '../../src/access/approvals/live-composition.ts';
import { liveApprovalsPorts, liveMandateDispatchPorts } from '../../src/access/approvals/live-composition.ts';
import type { BoundWitness } from '../../src/access/approvals/proposal.ts';
import { witnessOf } from '../../src/access/approvals/proposal.ts';
import type { ApprovalAuthorityInspector, ApprovalsService } from '../../src/access/approvals/service.ts';
import { makeApprovalsService } from '../../src/access/approvals/service.ts';
import { makeAccessChangesDrizzleStore } from '../../src/access/changes/persistence/drizzle-store.ts';
import type { AccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import { makeDrizzleAccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import type { AccessRecordProjectionPort } from '../../src/access/enforcement/record-projection-port.ts';
import type { AccessScopeId, CapabilityKey, PrincipalId, ProposalId, TenantId } from '../../src/access/ids.ts';
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
import { callerTransactions, requestTransactions } from '../../src/access/intent/persistence.ts';
import { makeJoinedTenantIntentLoader, makeTenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import type { AccessMode, AuthorityWitness, Holder } from '../../src/access/model.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { DatabaseConfigValue } from '../../src/db/config.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

/*
 * The live approvals composition against a real PostgreSQL (O61, O75, R2-H1). Everything that reads
 * authority here is shipped: the published release, the intent loader's live cells, the membership
 * rows, the configure bases, the Drizzle proposal store and the frozen-command repository, run as
 * `ontos_runtime` under the migration's row-level security and its witness triggers. No projection,
 * catalog or administrator is scripted: the rows are seeded as intent and the assertions read the
 * composed service's own answers.
 *
 * What this proves:
 *
 * - a proposal, its approval and its execution are decided from that seeded intent alone;
 * - a retired grant incarnation, a suspension, an expired assignment, a witness of another scope, a
 *   witness claiming somebody else's holder and a tenant-only member of a company scope all lose the
 *   authority a mandate binds, while a role edit that keeps the cells keeps it (D1);
 * - an owner and an `access_admin` decide as administrators from Core's own facts, and neither an
 *   `access_admin` without the company's own membership nor a plain member does;
 * - a record-scoped cell's reach is the owner projection's answer: `true`, `false` or unanswered,
 *   never assumed;
 * - a read that fails is retryable unavailability, distinct from a refusal;
 * - the live mandate adapter composes over these ports. Binding it to the Action runner, enabling
 *   production execution, the owner handler, crash recovery and HTTP belong to the Action lane.
 */
const migrationPath = new URL(
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  import.meta.url,
).pathname;

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const TENANT = TenantIdSchema.make(uid(1));
const OTHER_TENANT = TenantIdSchema.make(uid(2));
const LEGAL_ENTITY = uid(3);
const COMPANY_SCOPE = AccessScopeIdSchema.make(uid(4));
const TENANT_SCOPE = AccessScopeIdSchema.make(uid(5));
const JANA = PrincipalIdSchema.make(uid(6));
const EVA = PrincipalIdSchema.make(uid(7));
const PETR = PrincipalIdSchema.make(uid(8));
const MILA = PrincipalIdSchema.make(uid(9));
const VOJTECH = PrincipalIdSchema.make(uid(10));
const LIDA = PrincipalIdSchema.make(uid(11));
const RADEK = PrincipalIdSchema.make(uid(12));
const CATALOG_SNAPSHOT = uid(13);
const ROLE = RoleIdSchema.make(uid(14));
const REVISION = RoleRevisionIdSchema.make(uid(15));
const NEXT_REVISION = RoleRevisionIdSchema.make(uid(16));
const THIRD_REVISION = RoleRevisionIdSchema.make(uid(25));
const CREDIT_ROLE = RoleIdSchema.make(uid(17));
const CREDIT_REVISION = RoleRevisionIdSchema.make(uid(18));
const JANA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(19));
const EVA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(20));
const LIDA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(21));
const RADEK_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(22));
const JANA_CREDIT_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(23));
const EVA_CREDIT_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(24));
const VOID = CapabilityKeySchema.make('finance.invoice.void');
const CREDIT = CapabilityKeySchema.make('finance.invoice.credit');
const UNPUBLISHED = CapabilityKeySchema.make('finance.invoice.unpublished');
const RECORD = RecordKeySchema.make('invoice-1');
const ACTION_KEY = ActionKeySchema.make('finance.invoice.void');
const EXECUTION_INVOCATION = ActionInvocationRefSchema.make(uid(40));

const GRANTS = {
  creditApprove: GrantIncarnationIdSchema.make(uid(30)),
  creditExecution: GrantIncarnationIdSchema.make(uid(31)),
  creditRequester: GrantIncarnationIdSchema.make(uid(32)),
  voidApproval: GrantIncarnationIdSchema.make(uid(33)),
  voidExecution: GrantIncarnationIdSchema.make(uid(34)),
  voidRequester: GrantIncarnationIdSchema.make(uid(35)),
} as const;

const VOID_PAYLOAD = { reason: 'live' } as const;
const VOID_COMMAND = { capabilityKey: VOID, payload: VOID_PAYLOAD } as const;
const VOID_DIGEST = CommandDigestSchema.make(Result.getOrThrow(freezeCommand(VOID_COMMAND)));
const CREDIT_COMMAND = { capabilityKey: CREDIT, payload: VOID_PAYLOAD, target: RECORD } as const;
const CREDIT_DIGEST = CommandDigestSchema.make(Result.getOrThrow(freezeCommand(CREDIT_COMMAND)));

const holder = (principalId: PrincipalId): Holder => ({ _tag: 'Principal', principalId });

/**
 * The live adapters read the Effect clock, so this suite runs them on the wall clock the seeded
 * intent lives on. A test clock would put the witnesses' own membership and validity windows a
 * generation away from `now()`, which is a fixture artefact and not a property of the composition.
 */
const onLiveClock = <A, E, R>(effect: Effect.Effect<A, E, R>) => TestClock.withLive(effect);

const boundWitness = (input: {
  readonly assignmentIncarnationId: typeof JANA_ASSIGNMENT;
  readonly capabilityKey: CapabilityKey;
  readonly grantIncarnationId: (typeof GRANTS)[keyof typeof GRANTS];
  readonly holderId: Holder;
}): BoundWitness => ({ ...input, scopeId: COMPANY_SCOPE });

const requesterWitness = boundWitness({
  assignmentIncarnationId: JANA_ASSIGNMENT,
  capabilityKey: VOID,
  grantIncarnationId: GRANTS.voidRequester,
  holderId: holder(JANA),
});
const approvalWitness = boundWitness({
  assignmentIncarnationId: EVA_ASSIGNMENT,
  capabilityKey: VOID,
  grantIncarnationId: GRANTS.voidApproval,
  holderId: holder(EVA),
});
const executionWitness = boundWitness({
  assignmentIncarnationId: EVA_ASSIGNMENT,
  capabilityKey: VOID,
  grantIncarnationId: GRANTS.voidExecution,
  holderId: holder(EVA),
});
const lidaApprovalWitness = boundWitness({
  assignmentIncarnationId: LIDA_ASSIGNMENT,
  capabilityKey: VOID,
  grantIncarnationId: GRANTS.voidApproval,
  holderId: holder(LIDA),
});
const radekApprovalWitness = boundWitness({
  assignmentIncarnationId: RADEK_ASSIGNMENT,
  capabilityKey: VOID,
  grantIncarnationId: GRANTS.voidApproval,
  holderId: holder(RADEK),
});
const creditRequesterWitness = boundWitness({
  assignmentIncarnationId: JANA_CREDIT_ASSIGNMENT,
  capabilityKey: CREDIT,
  grantIncarnationId: GRANTS.creditRequester,
  holderId: holder(JANA),
});
const creditApprovalWitness = boundWitness({
  assignmentIncarnationId: EVA_CREDIT_ASSIGNMENT,
  capabilityKey: CREDIT,
  grantIncarnationId: GRANTS.creditApprove,
  holderId: holder(EVA),
});
const creditExecutionWitness = boundWitness({
  assignmentIncarnationId: EVA_CREDIT_ASSIGNMENT,
  capabilityKey: CREDIT,
  grantIncarnationId: GRANTS.creditExecution,
  holderId: holder(EVA),
});

/** A witness of one bound cell in the purpose and mode the approvals rules expect (O63). */
const witnessFor = (
  purpose: AuthorityWitness['purpose'],
  bound: BoundWitness,
  mode: AccessMode,
  scopeId: AccessScopeId = COMPANY_SCOPE,
): AuthorityWitness => ({ ...witnessOf(purpose, bound), mode, scopeId });

const cellJson = (capabilityKey: string, mode: string, selector: string) =>
  `'{"capabilityKey": "${capabilityKey}", "mode": "${mode}", "selector": {"_tag": "${selector}"}}'::jsonb`;

const cellsJson = (
  cells: readonly { readonly capabilityKey: string; readonly mode: string; readonly selector: string }[],
): string => {
  const released = cells
    .map(
      (cell) =>
        `{"capabilityKey": "${cell.capabilityKey}", "mode": "${cell.mode}", "selector": {"_tag": "${cell.selector}"}}`,
    )
    .join(', ');
  return `'[${released}]'::jsonb`;
};

const entryJson = (key: string, selectors: readonly string[]): string => {
  const released = selectors.map((selector) => `"${selector}"`).join(', ');
  return `'{"key": "${key}", "kind": "action", "modes": ["run", "propose", "approve"], "moduleKey": "finance",
     "placement": {"group": "Faktury", "level": "extended"}, "risk": "sensitive",
     "selectors": [${released}]}'::jsonb`;
};

/** The cells the invoice role holds: propose, approve and run on the void command (selector `all`). */
const VOID_CELLS = [
  { capabilityKey: VOID, mode: 'propose', selector: 'all' },
  { capabilityKey: VOID, mode: 'approve', selector: 'all' },
  { capabilityKey: VOID, mode: 'run', selector: 'all' },
] as const;

/** The credit role: record-scoped approve and run cells, plus the propose cell that requests them. */
const CREDIT_CELLS = [
  { capabilityKey: CREDIT, mode: 'propose', selector: 'all' },
  { capabilityKey: CREDIT, mode: 'approve', selector: 'assigned' },
  { capabilityKey: CREDIT, mode: 'run', selector: 'assigned' },
] as const;

const replaceDatabase = (configuration: DatabaseConfigValue, database: string): string => {
  const url = new URL(configuration.connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

/** Applies the committed access migration unchanged, over the identity stubs it expects to find. */
const applyAccessMigration = (admin: PgClient.PgClient) =>
  Effect.gen(function* applyAccessMigrationEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const migration = yield* fileSystem.readFileString(migrationPath);
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
      // The tenant projection reads the modules a tenant has installed; the module-state migration
      // owns that table in a deployed database, and this suite installs the same shape.
      `create table core.tenant_module_states (
         tenant_module_state_id uuid primary key default gen_random_uuid(),
         tenant_id uuid not null,
         module_key text not null,
         state text not null,
         last_change_id uuid,
         created_at timestamp with time zone not null default now(),
         updated_at timestamp with time zone not null default now()
       )`,
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
      'grant usage on schema core to ontos_runtime',
      'grant select on all tables in schema core to ontos_runtime',
      // The writes the shipped proposal store performs; the trust grants migration owns them in a
      // deployed database and this suite installs the same shape for its own schema.
      'grant insert, update on core.access_proposals to ontos_runtime',
      'grant insert on core.access_mandates, core.access_mandate_grants, core.access_decision_logs to ontos_runtime',
      'grant execute on all functions in schema core to ontos_runtime',
      // Memberships are written by Core's own access administration in a deployed database, whose trust
      // grants own this privilege. The claim proof below suspends one INSIDE a transaction, so this
      // suite installs the same write for the request role.
      'grant update on core.access_memberships to ontos_runtime',
    ];
    yield* Effect.forEach(
      statements,
      (statement) =>
        statement.trim().length === 0 ? Effect.void : admin.unsafe(statement).pipe(Effect.orDie, Effect.asVoid),
      { concurrency: 1, discard: true },
    );
  });

const membership = (input: {
  readonly id: number;
  readonly kind: string;
  readonly principalId: PrincipalId;
  readonly scopeId: AccessScopeId;
  readonly status: string;
}) =>
  `insert into core.access_memberships
     (membership_id, tenant_id, scope_id, kind, principal_id, recorded_by, status, valid_from)
     values ('${uid(input.id)}', '${TENANT}', '${input.scopeId}', '${input.kind}', '${input.principalId}', '${MILA}',
             '${input.status}', now() - interval '1 day')`;

/**
 * The canonical membership state of the tenant: JANA, EVA, LIDA and RADEK are members of the company
 * and of the tenant context, PETR owns the tenant without joining the company, VOJTECH administers the
 * company without being its member, and MILA administers it with both memberships.
 */
const membershipStatements = [
  membership({ id: 50, kind: 'member', principalId: JANA, scopeId: TENANT_SCOPE, status: 'active' }),
  membership({ id: 51, kind: 'member', principalId: JANA, scopeId: COMPANY_SCOPE, status: 'active' }),
  membership({ id: 52, kind: 'member', principalId: EVA, scopeId: TENANT_SCOPE, status: 'active' }),
  membership({ id: 53, kind: 'member', principalId: EVA, scopeId: COMPANY_SCOPE, status: 'active' }),
  membership({ id: 54, kind: 'member', principalId: PETR, scopeId: TENANT_SCOPE, status: 'active' }),
  membership({ id: 55, kind: 'owner', principalId: PETR, scopeId: TENANT_SCOPE, status: 'active' }),
  membership({ id: 56, kind: 'member', principalId: MILA, scopeId: TENANT_SCOPE, status: 'active' }),
  membership({ id: 57, kind: 'member', principalId: MILA, scopeId: COMPANY_SCOPE, status: 'active' }),
  membership({ id: 58, kind: 'access_admin', principalId: MILA, scopeId: COMPANY_SCOPE, status: 'active' }),
  membership({ id: 59, kind: 'member', principalId: VOJTECH, scopeId: TENANT_SCOPE, status: 'active' }),
  membership({ id: 60, kind: 'access_admin', principalId: VOJTECH, scopeId: COMPANY_SCOPE, status: 'active' }),
  // A tenant-only member with a company assignment: her witness proves no company authority (D6, M2).
  membership({ id: 61, kind: 'member', principalId: LIDA, scopeId: TENANT_SCOPE, status: 'active' }),
  membership({ id: 62, kind: 'member', principalId: RADEK, scopeId: TENANT_SCOPE, status: 'active' }),
  membership({ id: 63, kind: 'member', principalId: RADEK, scopeId: COMPANY_SCOPE, status: 'active' }),
] as const;

/** One tenant whose people hold the roles, memberships and grants a proposal can bind. */
const seedAccess = (admin: PgClient.PgClient, roleScope: 'company' | 'tenant') =>
  Effect.gen(function* seedAccessEffect() {
    const statements = [
      `insert into core.tenants (tenant_id) values ('${TENANT}'), ('${OTHER_TENANT}')`,
      `insert into core.legal_entities (tenant_id, legal_entity_id) values ('${TENANT}', '${LEGAL_ENTITY}')`,
      `insert into core.principals (tenant_id, principal_id, kind) values
         ('${TENANT}', '${JANA}', 'human'),
         ('${TENANT}', '${EVA}', 'human'),
         ('${TENANT}', '${PETR}', 'human'),
         ('${TENANT}', '${MILA}', 'human'),
         ('${TENANT}', '${VOJTECH}', 'human'),
         ('${TENANT}', '${LIDA}', 'human'),
         ('${TENANT}', '${RADEK}', 'human')`,
      `insert into core.access_catalog_snapshots (catalog_snapshot_id, digest, published_at)
         values ('${CATALOG_SNAPSHOT}', '${'a'.repeat(64)}', now())`,
      `insert into core.access_catalog_entries (catalog_snapshot_id, capability_key, entry_json) values
         ('${CATALOG_SNAPSHOT}', '${VOID}', ${entryJson(VOID, ['all'])}),
         ('${CATALOG_SNAPSHOT}', '${CREDIT}', ${entryJson(CREDIT, ['assigned'])})`,
      `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id)
         values ('${TENANT_SCOPE}', '${TENANT}', '${TENANT}')`,
      `insert into core.access_scopes (scope_id, tenant_id, legal_entity_id)
         values ('${COMPANY_SCOPE}', '${TENANT}', '${LEGAL_ENTITY}')`,
      `insert into core.access_roles (role_id, tenant_id, created_by, name, legal_entity_id) values
         ('${ROLE}', '${TENANT}', '${JANA}', 'Účetní', ${roleScope === 'company' ? `'${LEGAL_ENTITY}'` : 'null'}),
         ('${CREDIT_ROLE}', '${TENANT}', '${JANA}', 'Úvěry', '${LEGAL_ENTITY}')`,
      `insert into core.access_role_revisions
         (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
         values
         ('${REVISION}', '${TENANT}', '${ROLE}', 1, '${CATALOG_SNAPSHOT}', ${cellsJson(VOID_CELLS)}, '${JANA}',
          'manual'),
         ('${CREDIT_REVISION}', '${TENANT}', '${CREDIT_ROLE}', 1, '${CATALOG_SNAPSHOT}',
          ${cellsJson(CREDIT_CELLS)}, '${JANA}', 'manual')`,
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status,
          valid_from, valid_until)
         values
         ('${JANA_ASSIGNMENT}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${REVISION}', '${JANA}', '${EVA}',
          'active', now() - interval '1 day', null),
         ('${EVA_ASSIGNMENT}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${REVISION}', '${EVA}', '${EVA}',
          'active', now() - interval '1 day', null),
         ('${LIDA_ASSIGNMENT}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${REVISION}', '${LIDA}', '${EVA}',
          'active', now() - interval '1 day', null),
         ('${RADEK_ASSIGNMENT}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${REVISION}', '${RADEK}', '${EVA}',
          'active', now() - interval '2 days', now() - interval '1 day'),
         ('${JANA_CREDIT_ASSIGNMENT}', '${TENANT}', '${COMPANY_SCOPE}', '${CREDIT_ROLE}', '${CREDIT_REVISION}',
          '${JANA}', '${EVA}', 'active', now() - interval '1 day', null),
         ('${EVA_CREDIT_ASSIGNMENT}', '${TENANT}', '${COMPANY_SCOPE}', '${CREDIT_ROLE}', '${CREDIT_REVISION}',
          '${EVA}', '${EVA}', 'active', now() - interval '1 day', null)`,
      `insert into core.access_grant_incarnations
         (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status) values
         ('${GRANTS.voidRequester}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${VOID}', 'propose', 'all',
          ${cellJson(VOID, 'propose', 'all')}, 'active'),
         ('${GRANTS.voidApproval}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${VOID}', 'approve', 'all',
          ${cellJson(VOID, 'approve', 'all')}, 'active'),
         ('${GRANTS.voidExecution}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${VOID}', 'run', 'all',
          ${cellJson(VOID, 'run', 'all')}, 'active'),
         ('${GRANTS.creditRequester}', '${TENANT}', '${COMPANY_SCOPE}', '${CREDIT_ROLE}', '${CREDIT}', 'propose',
          'all', ${cellJson(CREDIT, 'propose', 'all')}, 'active'),
         ('${GRANTS.creditApprove}', '${TENANT}', '${COMPANY_SCOPE}', '${CREDIT_ROLE}', '${CREDIT}', 'approve',
          'assigned', ${cellJson(CREDIT, 'approve', 'assigned')}, 'active'),
         ('${GRANTS.creditExecution}', '${TENANT}', '${COMPANY_SCOPE}', '${CREDIT_ROLE}', '${CREDIT}', 'run',
          'assigned', ${cellJson(CREDIT, 'run', 'assigned')}, 'active')`,
      `insert into core.tenant_module_states (tenant_id, module_key, state)
         values ('${TENANT}', 'finance', 'active')`,
      ...membershipStatements,
    ];
    yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie, Effect.asVoid), {
      concurrency: 1,
      discard: true,
    });
  });

const disposableDatabaseFor = (roleScope: 'company' | 'tenant') =>
  Effect.gen(function* disposableDatabaseEffect() {
    // This disposable-database suite uses explicit process configuration, never the workspace .env.
    const connections = yield* loadDatabaseConnectionPair({ envPath: `${import.meta.filename}.no-environment-file` });
    const crypto = yield* Crypto.Crypto;
    const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const name = `live_approvals_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrap.unsafe(`create database "${name}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrap.unsafe(`drop database if exists "${name}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replaceDatabase(connections.admin, name), { maxConnections: 2 });
    yield* applyAccessMigration(admin);
    yield* seedAccess(admin, roleScope);
    /*
     * The composition reads on several connections at once: the store's own transaction, the intent
     * loader's per-read transaction and the adapter's scope and membership reads.
     */
    const runtime = yield* makeTestPgClient(replaceDatabase(connections.runtime, name), { maxConnections: 8 });
    const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    return { admin, executor };
  });

const disposableDatabase = disposableDatabaseFor('company');

const scopeFor = (principalId: PrincipalId, tenantId: TenantId = TENANT): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:live-approvals:run:${principalId}`,
    authMethod: 'system',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'live-approvals' })),
    Effect.orDie,
  );

type LiveDatabase = Effect.Success<typeof disposableDatabase>['executor'];

/** The two stores the mandate ports add on top of the approvals sources. */
interface LiveMandateStores {
  readonly frozenCommands: FrozenCommandStore;
  readonly principalKinds: AccessPrincipalKinds;
}

/** The live services over the shipped stores of one disposable database. */
const liveApprovals = Effect.fn('LiveApprovalsFixture.make')(function* liveApprovalsEffect(executor: LiveDatabase) {
  const crypto = yield* Crypto.Crypto;
  const frozenCommands = makeDrizzleFrozenCommandStore({ executor });
  const changes = makeAccessChangesDrizzleStore({ executor });
  const records = Context.get(
    yield* Layer.build(
      ApprovalStoreLive.pipe(
        Layer.provide(
          Layer.mergeAll(Layer.succeed(CoreDatabase, { executor }), Layer.succeed(FrozenCommands, frozenCommands)),
        ),
      ),
    ),
    ApprovalStore,
  );
  /**
   * The same shipped services over the transaction an owner Action already holds (O75): the intent
   * loader, the approvals store and the published release are built over `callerTransactions`, so
   * every read of the joined ports runs in the caller's own transaction. Nothing is scripted and no
   * read is re-decided; only the transaction source changes — and the joined source opens no
   * transaction of its own and claims no isolation level.
   */
  const joinedServices = (transaction: CoreTransaction): LiveApprovalServices => ({
    crypto,
    intent: makeJoinedTenantIntentLoader(transaction),
    join: joinedServices,
    loadRelease: () => changes.loadPublishedCatalog(transaction),
    records: makeJoinedDrizzleApprovalStore({ frozenCommands, transaction }, crypto),
    transactions: callerTransactions(transaction),
  });
  const services: LiveApprovalServices = {
    crypto,
    intent: makeTenantIntentLoader({ executor }),
    join: joinedServices,
    loadRelease: () => changes.loadPublishedCatalog(),
    records,
    transactions: requestTransactions({ executor }),
  };
  return {
    ...services,
    frozenCommands,
    principalKinds: makeDrizzleAccessPrincipalKinds({ executor }),
  } satisfies LiveApprovalServices & LiveMandateStores;
});

/**
 * The approvals service of one request scope over the live ports. The constructor belongs to
 * `service.ts`; a test may call it directly, which is the same single line the owning module owes
 * production (`approvalsOverPorts`).
 */
const approvalsFor = (services: LiveApprovalServices, scope: OperationalScope): ApprovalsService =>
  makeApprovalsService(liveApprovalsPorts(services, scope));

const proposeVoid = (
  service: ApprovalsService,
  input: {
    readonly capabilityKey?: CapabilityKey;
    readonly command?: typeof VOID_COMMAND;
    readonly commandDigest?: typeof VOID_DIGEST;
    readonly requesterAuthority?: readonly BoundWitness[];
  } = {},
) =>
  service.propose({
    actionKey: ACTION_KEY,
    actor: { _tag: 'Principal', principalId: JANA },
    capabilityKey: input.capabilityKey ?? VOID,
    command: input.command ?? VOID_COMMAND,
    commandDigest: input.commandDigest ?? VOID_DIGEST,
    requesterAuthority: input.requesterAuthority ?? [requesterWitness],
    requesterKind: 'human',
    scopeId: COMPANY_SCOPE,
    tenantId: TENANT,
  });

const approveVoid = (service: ApprovalsService, proposalId: ProposalId) =>
  service.approve({
    approver: { _tag: 'Principal', principalId: EVA },
    approverKind: 'human',
    authority: { approval: approvalWitness, execution: executionWitness, parentRecordRead: [] },
    policy: { selfApproval: 'permitted' },
    proposalId,
    scopeId: COMPANY_SCOPE,
    tenantId: TENANT,
  });

const approveCredit = (service: ApprovalsService, proposalId: ProposalId) =>
  service.approve({
    approver: { _tag: 'Principal', principalId: EVA },
    approverKind: 'human',
    authority: { approval: creditApprovalWitness, execution: creditExecutionWitness, parentRecordRead: [] },
    policy: { selfApproval: 'permitted' },
    proposalId,
    scopeId: COMPANY_SCOPE,
    tenantId: TENANT,
  });

/**
 * The mandate execution the runner performs after it locks the proposal row: the SAME call
 * `ActionMandateDispatch.claim` makes, with the owner transaction the runner holds (O75).
 */
const executeVoid = (service: ApprovalsService, transaction: CoreTransaction, proposalId: ProposalId) =>
  service.execute(
    {
      actionInvocationId: EXECUTION_INVOCATION,
      actor: { _tag: 'Principal', principalId: EVA },
      commandDigest: VOID_DIGEST,
      proposalId,
      scopeId: COMPANY_SCOPE,
      tenantId: TENANT,
    },
    { transaction },
  );

/** One proposal row as an administrator reads it: the receipt columns the claim writes or leaves alone. */
const proposalRow = (admin: PgClient.PgClient, proposalId: ProposalId) =>
  admin
    .unsafe<{ readonly execution_operation_id: string | null; readonly status: string }>(
      `select status, execution_operation_id from core.access_proposals where proposal_id = '${proposalId}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => ({
        executionOperationId: rows[0]?.execution_operation_id ?? null,
        status: rows[0]?.status ?? 'missing',
      })),
    );

const rejectAs = (service: ApprovalsService, proposalId: ProposalId, approver: PrincipalId) =>
  service.reject({
    approveAuthority: [],
    approver: { _tag: 'Principal', principalId: approver },
    approverKind: 'human',
    proposalId,
    scopeId: COMPANY_SCOPE,
    tenantId: TENANT,
  });

/** The stable refusal code a failure carries; anything else is a defect this suite never expects. */
const codeOf = <Failure>(failure: Failure): string =>
  Schema.is(Schema.Struct({ code: Schema.String }))(failure) ? failure.code : 'untyped_failure';

/** The refusal code of a call that must fail. */
const refusalOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  Effect.result(effect).pipe(
    Effect.flatMap(
      Result.match({
        onFailure: (failure) => Effect.succeed(codeOf(failure)),
        onSuccess: () => Effect.die('Expected a typed refusal, but the operation succeeded'),
      }),
    ),
  );

/** The verdict the shipped rule reaches for one inspected witness. */
const verdictOf = (
  facts: readonly WitnessFacts[],
  expectation: { readonly expectedHolder: Holder; readonly scopeId: AccessScopeId; readonly target?: typeof RECORD },
) => {
  const [first] = facts;
  if (first === undefined) {
    return 'missing';
  }
  return expectation.target === undefined
    ? witnessAuthorityOf(first, { expectedHolder: expectation.expectedHolder, scopeId: expectation.scopeId })
    : witnessAuthorityOf(first, {
        expectedHolder: expectation.expectedHolder,
        scopeId: expectation.scopeId,
        target: expectation.target,
      });
};

const approveWitnesses = [
  witnessFor('approval', approvalWitness, 'approve'),
  witnessFor('execution', executionWitness, 'run'),
] as const;

/** The one live verdict this suite asks: the approver's own `approve` cell in the company scope. */
const inspectVoidApproval =
  (authority: ApprovalAuthorityInspector) => (): ReturnType<ApprovalAuthorityInspector['inspect']> =>
    authority.inspect({
      expectedHolder: holder(EVA),
      scopeId: COMPANY_SCOPE,
      tenantId: TENANT,
      witnesses: [witnessFor('approval', approvalWitness, 'approve')],
    });

it.layer(NodeServices.layer)('live approvals composition', (suite) => {
  suite.effect('proposes and approves a mandate from Core intent alone', () =>
    onLiveClock(
      Effect.gen(function* liveMandate() {
        const { executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);

        const proposed = yield* proposeVoid(approvalsFor(live, jana));
        expect(proposed.status).toBe('pending');
        expect(proposed.witnesses.map(({ purpose }) => purpose)).toStrictEqual(['requester']);
        expect(proposed.tenantId).toBe(TENANT);
        expect(proposed.scopeId).toBe(COMPANY_SCOPE);

        // The approver's own cells, the membership path and the role binding are all read live, so a
        // mandate exists only on authority Core's own rows state (R2-H1, O49).
        const approved = yield* approveVoid(approvalsFor(live, eva), proposed.id);
        expect(approved.status).toBe('approved');
        expect(approved.witnesses.map(({ purpose }) => purpose)).toStrictEqual(['requester', 'approval', 'execution']);
        expect(approved.approval?.approverId).toBe(EVA);

        // A second approval of the same mandate is no second decision (P10).
        expect(yield* refusalOf(approveVoid(approvalsFor(live, eva), proposed.id))).toBe('proposal_not_pending');
      }),
    ),
  );

  suite.effect('claims the mandate in the owner transaction, from what that transaction sees (O75)', () =>
    onLiveClock(
      Effect.gen(function* claimInsideOwnerTransaction() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);
        const proposed = yield* proposeVoid(approvalsFor(live, jana));
        yield* approveVoid(approvalsFor(live, eva), proposed.id);
        const approver = approvalsFor(live, eva);
        const claimIn = (transaction: CoreTransaction) =>
          installOperationalScope(transaction, eva).pipe(
            Effect.andThen(() => executeVoid(approver, transaction, proposed.id)),
          );

        /*
         * The claim re-checks every bound witness — the live cells, the membership path, the role
         * binding and the stored proposal — inside the owner transaction, holding its proposal lock.
         * A read that opened a transaction of its own would be refused by PostgreSQL on that same
         * connection (SQLSTATE 25001), so a claim that reaches the executed receipt is a claim whose
         * every authority fact came from the caller's transaction.
         */
        // Rollback first: a failed owner write takes the receipt with it and releases the mandate.
        const rolledBack = yield* Effect.exit(
          executor.transaction((transaction) =>
            claimIn(transaction).pipe(Effect.andThen(Effect.fail('owner write failed'))),
          ),
        );
        expect(Exit.isFailure(rolledBack)).toBe(true);
        expect(yield* proposalRow(admin, proposed.id)).toStrictEqual({
          executionOperationId: null,
          status: 'approved',
        });

        /*
         * The visibility half: a suspension written INSIDE the claiming transaction — and never
         * committed — subtracts the approver's authority, because the membership rows and the live
         * cells the claim reads are that transaction's. A pool read would answer the committed state
         * and execute the mandate, which is exactly what this case rules out.
         */
        const suspended = yield* Effect.result(
          executor.transaction((transaction) =>
            installOperationalScope(transaction, eva).pipe(
              Effect.andThen(() =>
                transaction.execute(
                  sql`update core.access_memberships set status = 'suspended'
                      where tenant_id = ${TENANT} and principal_id = ${EVA}`,
                ),
              ),
              Effect.andThen(() => executeVoid(approver, transaction, proposed.id)),
            ),
          ),
        );
        expect(Result.isFailure(suspended) ? codeOf(suspended.failure) : 'executed').toBe('authority_lost');
        // The suspension was rolled back with the refused claim, so the mandate is still approved.
        expect(yield* proposalRow(admin, proposed.id)).toStrictEqual({
          executionOperationId: null,
          status: 'approved',
        });

        // The same claim without the in-transaction change commits its receipt and the owner write.
        yield* executor.transaction((transaction) => claimIn(transaction));
        expect(yield* proposalRow(admin, proposed.id)).toStrictEqual({
          executionOperationId: EXECUTION_INVOCATION,
          status: 'executed',
        });
      }),
    ),
  );

  suite.effect('pins a role binding only from the live assignments of the proposal own scope', () =>
    onLiveClock(
      Effect.gen(function* pinnedBindingScope() {
        // Only a tenant-wide role can legally have assignments in both of these scopes.
        const { admin, executor } = yield* disposableDatabaseFor('tenant');
        const live = yield* liveApprovals(executor);
        const eva = yield* scopeFor(EVA);
        const { authority } = liveApprovalsPorts(live, eva);
        const outOfScopeRevision = RoleRevisionIdSchema.make(uid(26));
        const outOfWindowRevision = RoleRevisionIdSchema.make(uid(27));
        /*
         * Two assignments of the SAME role that a read without the scope and the assignment window
         * would fold into the company's binding: one in the tenant context, where this role is not
         * bound at all, and one in the company scope that ENDED yesterday while its status still says
         * `active`. Neither may pin the binding a mandate is proved against (O49, R2-H1).
         */
        yield* admin
          .unsafe(`insert into core.access_role_revisions
                     (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by,
                      provenance)
                     values
                     ('${outOfScopeRevision}', '${TENANT}', '${ROLE}', 2, '${CATALOG_SNAPSHOT}',
                      ${cellsJson(VOID_CELLS)}, '${PETR}', 'manual'),
                     ('${outOfWindowRevision}', '${TENANT}', '${ROLE}', 3, '${CATALOG_SNAPSHOT}',
                      ${cellsJson(VOID_CELLS)}, '${PETR}', 'manual')`)
          .pipe(Effect.orDie);
        yield* admin
          .unsafe(`insert into core.access_assignments
                     (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by,
                      status, valid_from, valid_until)
                     values
                     ('${uid(28)}', '${TENANT}', '${TENANT_SCOPE}', '${ROLE}', '${outOfScopeRevision}', '${PETR}',
                      '${EVA}', 'active', now() - interval '1 day', null),
                     ('${uid(29)}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${outOfWindowRevision}', '${PETR}',
                      '${EVA}', 'active', now() - interval '3 days', now() - interval '1 day')`)
          .pipe(Effect.orDie);

        const facts = yield* authority.inspect({
          expectedHolder: holder(EVA),
          scopeId: COMPANY_SCOPE,
          tenantId: TENANT,
          witnesses: [witnessFor('approval', approvalWitness, 'approve')],
        });
        // The company binding still pins the one revision its LIVE company assignments pin.
        expect(facts.map(({ grantRoleRevisionId }) => grantRoleRevisionId)).toStrictEqual([REVISION]);
        expect(verdictOf(facts, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('live');

        /*
         * The control: a live assignment of another revision IN this scope is what the projection
         * refuses (two revisions of one role would widen the binding), and then no binding is proven.
         */
        yield* admin
          .unsafe(`insert into core.access_assignments
                     (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by,
                      status, valid_from, valid_until)
                     values ('${uid(30)}', '${TENANT}', '${COMPANY_SCOPE}', '${ROLE}', '${outOfWindowRevision}',
                             '${MILA}', '${EVA}', 'active', now() - interval '1 hour', null)`)
          .pipe(Effect.orDie);
        const ambiguous = yield* authority.inspect({
          expectedHolder: holder(EVA),
          scopeId: COMPANY_SCOPE,
          tenantId: TENANT,
          witnesses: [witnessFor('approval', approvalWitness, 'approve')],
        });
        expect(ambiguous.map(({ grantRoleRevisionId }) => grantRoleRevisionId)).toStrictEqual([null]);
      }),
    ),
  );

  suite.effect('states every live witness fact, and keeps the mandate across a role edit that keeps its cells', () =>
    onLiveClock(
      Effect.gen(function* witnessFacts() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const eva = yield* scopeFor(EVA);
        const { authority } = liveApprovalsPorts(live, eva);

        const facts = yield* authority.inspect({
          expectedHolder: holder(EVA),
          scopeId: COMPANY_SCOPE,
          tenantId: TENANT,
          witnesses: [...approveWitnesses],
        });
        expect(facts.map(({ assignmentRoleRevisionId }) => assignmentRoleRevisionId)).toStrictEqual([
          REVISION,
          REVISION,
        ]);
        expect(facts.map(({ assignmentState }) => assignmentState)).toStrictEqual(['live', 'live']);
        expect(facts.map(({ grantState }) => grantState)).toStrictEqual(['live', 'live']);
        expect(facts.map(({ grantRoleRevisionId }) => grantRoleRevisionId)).toStrictEqual([REVISION, REVISION]);
        expect(facts.map(({ holderId }) => holderId)).toStrictEqual([holder(EVA), holder(EVA)]);
        expect(facts.map(({ assignmentScopeId }) => assignmentScopeId)).toStrictEqual([COMPANY_SCOPE, COMPANY_SCOPE]);
        expect(verdictOf(facts, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('live');

        // D1: the role edit re-points every live holder at a successor revision that keeps the cells, so
        // the bound incarnations stay the live authority they were approved on.
        yield* admin
          .unsafe(`insert into core.access_role_revisions
                   (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by,
                    provenance)
                   values ('${NEXT_REVISION}', '${TENANT}', '${ROLE}', 2, '${CATALOG_SNAPSHOT}',
                           ${cellsJson(VOID_CELLS)}, '${JANA}', 'manual')`)
          .pipe(Effect.orDie);
        yield* admin
          .unsafe(`update core.access_assignments set role_revision_id = '${NEXT_REVISION}'
                   where tenant_id = '${TENANT}' and role_id = '${ROLE}' and status = 'active'`)
          .pipe(Effect.orDie);
        const afterEdit = yield* authority.inspect({
          expectedHolder: holder(EVA),
          scopeId: COMPANY_SCOPE,
          tenantId: TENANT,
          witnesses: [...approveWitnesses],
        });
        expect(afterEdit.map(({ assignmentRoleRevisionId }) => assignmentRoleRevisionId)).toStrictEqual([
          NEXT_REVISION,
          NEXT_REVISION,
        ]);
        expect(afterEdit.map(({ grantRoleRevisionId }) => grantRoleRevisionId)).toStrictEqual([
          NEXT_REVISION,
          NEXT_REVISION,
        ]);
        expect(verdictOf(afterEdit, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('live');

        // Two pinned revisions of one role is intent the projection refuses (it would widen the shared
        // binding), so the binding is not proved and the verdict is unavailable — never live.
        yield* admin
          .unsafe(`insert into core.access_role_revisions
                   (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by,
                    provenance)
                   values ('${THIRD_REVISION}', '${TENANT}', '${ROLE}', 3, '${CATALOG_SNAPSHOT}',
                           ${cellsJson(VOID_CELLS)}, '${JANA}', 'manual')`)
          .pipe(Effect.orDie);
        yield* admin
          .unsafe(`update core.access_assignments set role_revision_id = '${THIRD_REVISION}'
                   where tenant_id = '${TENANT}' and incarnation_id = '${JANA_ASSIGNMENT}'`)
          .pipe(Effect.orDie);
        const ambiguous = yield* authority.inspect({
          expectedHolder: holder(EVA),
          scopeId: COMPANY_SCOPE,
          tenantId: TENANT,
          witnesses: [...approveWitnesses],
        });
        expect(ambiguous.map(({ grantRoleRevisionId }) => grantRoleRevisionId)).toStrictEqual([null, null]);
        expect(verdictOf(ambiguous, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('unavailable');
      }),
    ),
  );

  suite.effect('loses the authority a retired grant incarnation carried', () =>
    onLiveClock(
      Effect.gen(function* retiredGrant() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const eva = yield* scopeFor(EVA);
        const { authority } = liveApprovalsPorts(live, eva);
        const inspect = inspectVoidApproval(authority);
        expect(verdictOf(yield* inspect(), { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('live');
        yield* admin
          .unsafe(`update core.access_grant_incarnations set status = 'retired'
                   where tenant_id = '${TENANT}' and grant_incarnation_id = '${GRANTS.voidApproval}'`)
          .pipe(Effect.orDie);
        const retired = yield* inspect();
        expect(verdictOf(retired, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('lost');
        // The service refuses the approval for that definite loss, and the proposal stays pending.
        const proposed = yield* proposeVoid(approvalsFor(live, yield* scopeFor(JANA)));
        expect(yield* refusalOf(approveVoid(approvalsFor(live, eva), proposed.id))).toBe('approval_authority_missing');
      }),
    ),
  );

  suite.effect('subtracts authority when the company membership is suspended', () =>
    onLiveClock(
      Effect.gen(function* suspension() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const eva = yield* scopeFor(EVA);
        const { authority } = liveApprovalsPorts(live, eva);
        const inspect = inspectVoidApproval(authority);
        expect(verdictOf(yield* inspect(), { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('live');
        yield* admin
          .unsafe(`update core.access_memberships set status = 'suspended'
                   where tenant_id = '${TENANT}' and scope_id = '${COMPANY_SCOPE}' and principal_id = '${EVA}'
                     and kind = 'member'`)
          .pipe(Effect.orDie);
        const suspended = yield* inspect();
        expect(suspended.map(({ assignmentState }) => assignmentState)).toStrictEqual(['lost']);
        expect(verdictOf(suspended, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('lost');
        const proposed = yield* proposeVoid(approvalsFor(live, yield* scopeFor(JANA)));
        expect(yield* refusalOf(approveVoid(approvalsFor(live, eva), proposed.id))).toBe('approval_authority_missing');
      }),
    ),
  );

  suite.effect('refuses a foreign scope, a foreign holder, a tenant-only member and an expired assignment', () =>
    onLiveClock(
      Effect.gen(function* witnessMatrix() {
        const { executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const eva = yield* scopeFor(EVA);
        const { authority } = liveApprovalsPorts(live, eva);
        const inspect = (witnesses: readonly AuthorityWitness[], expectedHolder: Holder = holder(EVA)) =>
          authority.inspect({ expectedHolder, scopeId: COMPANY_SCOPE, tenantId: TENANT, witnesses });

        // A witness naming another scope than the proposal's is no company authority (O49).
        const foreignScope = yield* inspect([witnessFor('approval', approvalWitness, 'approve', TENANT_SCOPE)]);
        expect(verdictOf(foreignScope, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE })).toBe('lost');

        // A witness that claims somebody else's holder is refused by the rule, not by a SQL error.
        const foreignClaim = yield* inspect([witnessFor('approval', approvalWitness, 'approve')], holder(LIDA));
        expect(foreignClaim.map(({ assignmentState }) => assignmentState)).toStrictEqual(['lost']);
        expect(verdictOf(foreignClaim, { expectedHolder: holder(LIDA), scopeId: COMPANY_SCOPE })).toBe('lost');

        // A tenant-only member holds the assignment but no company membership, so nothing is proven.
        const tenantOnly = yield* inspect([witnessFor('approval', lidaApprovalWitness, 'approve')], holder(LIDA));
        expect(tenantOnly.map(({ assignmentState }) => assignmentState)).toStrictEqual(['lost']);
        expect(verdictOf(tenantOnly, { expectedHolder: holder(LIDA), scopeId: COMPANY_SCOPE })).toBe('lost');

        // An assignment whose period ended at the read instant is no live cell at all (D6).
        const expired = yield* inspect([witnessFor('approval', radekApprovalWitness, 'approve')], holder(RADEK));
        expect(expired.map(({ assignmentState }) => assignmentState)).toStrictEqual(['lost']);
        expect(verdictOf(expired, { expectedHolder: holder(RADEK), scopeId: COMPANY_SCOPE })).toBe('lost');
      }),
    ),
  );

  suite.effect('decides administration from Core owner and access-admin facts with the exact membership path', () =>
    onLiveClock(
      Effect.gen(function* administration() {
        const { executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const { administrators } = liveApprovalsPorts(live, jana);

        const isAdministrator = (principalId: PrincipalId) =>
          administrators.isAdministrator({ principalId, scopeId: COMPANY_SCOPE, tenantId: TENANT });
        // A tenant owner administers every scope of its tenant from the tenant membership alone.
        expect(yield* isAdministrator(PETR)).toBe(true);
        // A company access admin needs the company's `access_admin` AND the company membership.
        expect(yield* isAdministrator(MILA)).toBe(true);
        // The same basis without the company's own membership administers nothing (no member row).
        expect(yield* isAdministrator(VOJTECH)).toBe(false);
        // A plain company member is no administrator.
        expect(yield* isAdministrator(LIDA)).toBe(false);
        // A tenant-context scope accepts no company administrator at all (O81).
        expect(
          yield* administrators.isAdministrator({ principalId: MILA, scopeId: TENANT_SCOPE, tenantId: TENANT }),
        ).toBe(false);

        const first = yield* proposeVoid(approvalsFor(live, jana));
        const rejectedByOwner = yield* rejectAs(approvalsFor(live, yield* scopeFor(PETR)), first.id, PETR);
        expect(rejectedByOwner.status).toBe('rejected');
        expect(rejectedByOwner.rejectedBy).toBe(PETR);

        const second = yield* proposeVoid(approvalsFor(live, jana));
        const rejectedByAdmin = yield* rejectAs(approvalsFor(live, yield* scopeFor(MILA)), second.id, MILA);
        expect(rejectedByAdmin.status).toBe('rejected');

        const third = yield* proposeVoid(approvalsFor(live, jana));
        expect(yield* refusalOf(rejectAs(approvalsFor(live, yield* scopeFor(VOJTECH)), third.id, VOJTECH))).toBe(
          'rejection_not_permitted',
        );

        const fourth = yield* proposeVoid(approvalsFor(live, jana));
        expect(yield* refusalOf(rejectAs(approvalsFor(live, yield* scopeFor(LIDA)), fourth.id, LIDA))).toBe(
          'rejection_not_permitted',
        );
      }),
    ),
  );

  suite.effect('takes a record-scoped reach from the owner projection, and nowhere else', () =>
    onLiveClock(
      Effect.gen(function* recordReach() {
        const { executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const eva = yield* scopeFor(EVA);
        const witness = witnessFor('approval', creditApprovalWitness, 'approve');
        const projectionOf =
          (assigned: PrincipalId, seen: string[]): AccessRecordProjectionPort =>
          (query) => {
            seen.push(query.moduleKey);
            return Effect.succeed(Option.some({ assigned: holder(assigned), recordKey: query.recordKey, teamIds: [] }));
          };

        const inspect = (sources: LiveApprovalServices) =>
          liveApprovalsPorts(sources, eva).authority.inspect({
            expectedHolder: holder(EVA),
            scopeId: COMPANY_SCOPE,
            target: RECORD,
            tenantId: TENANT,
            witnesses: [witness],
          });

        // No owner projection is bound: the reach is unanswered, and the verdict is unavailability.
        const unanswered = yield* inspect(live);
        expect(unanswered.map(({ reachesTarget }) => reachesTarget)).toStrictEqual([null]);
        expect(verdictOf(unanswered, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE, target: RECORD })).toBe(
          'unavailable',
        );

        // The owner projects the record to this holder: the cell reaches it.
        const mine: string[] = [];
        const reached = yield* inspect({ ...live, recordProjection: projectionOf(EVA, mine) });
        expect(reached.map(({ reachesTarget }) => reachesTarget)).toStrictEqual([true]);
        expect(verdictOf(reached, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE, target: RECORD })).toBe(
          'live',
        );
        // The module the record is projected in is the one the published release declares (D32).
        expect(mine).toStrictEqual(['finance']);

        // The record belongs to somebody else: the same live cell no longer reaches it (P5, N6).
        const theirs = yield* inspect({ ...live, recordProjection: projectionOf(JANA, []) });
        expect(theirs.map(({ reachesTarget }) => reachesTarget)).toStrictEqual([false]);
        expect(verdictOf(theirs, { expectedHolder: holder(EVA), scopeId: COMPANY_SCOPE, target: RECORD })).toBe('lost');
      }),
    ),
  );

  suite.effect('refuses a record-scoped approval while the release names no governing read (D30)', () =>
    onLiveClock(
      Effect.gen(function* governingReadGap() {
        const { executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        // The owner projects the record to the approver, so the only fact still missing is the read the
        // published release would have to name.
        const withProjection: LiveApprovalServices = {
          ...live,
          recordProjection: (query) =>
            Effect.succeed(Option.some({ assigned: holder(EVA), recordKey: query.recordKey, teamIds: [] })),
        };
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);
        const proposed = yield* approvalsFor(withProjection, jana).propose({
          actionKey: ACTION_KEY,
          actor: { _tag: 'Principal', principalId: JANA },
          capabilityKey: CREDIT,
          command: CREDIT_COMMAND,
          commandDigest: CREDIT_DIGEST,
          requesterAuthority: [creditRequesterWitness],
          requesterKind: 'human',
          scopeId: COMPANY_SCOPE,
          target: RECORD,
          tenantId: TENANT,
        });
        expect(proposed.status).toBe('pending');
        /*
         * The published entry cannot name the read that governs the record yet, so the policy refuses
         * this approval instead of inventing one. Publishing that field is a catalog/declaration change
         * (the release entry carries no governed-read column today), not a composition one.
         */
        expect(yield* refusalOf(approveCredit(approvalsFor(withProjection, eva), proposed.id))).toBe(
          'parent_record_read_missing',
        );
        const stored = yield* liveApprovalsPorts(live, eva).store.load({
          proposalId: proposed.id,
          scopeId: COMPANY_SCOPE,
          tenantId: TENANT,
        });
        expect(Option.getOrThrow(stored).status).toBe('pending');
      }),
    ),
  );

  suite.effect('refuses to propose a capability the published release does not name', () =>
    onLiveClock(
      Effect.gen(function* unpublishedCapability() {
        const { executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const unpublishedWitness: BoundWitness = { ...requesterWitness, capabilityKey: UNPUBLISHED };
        expect(
          yield* refusalOf(
            proposeVoid(approvalsFor(live, jana), {
              capabilityKey: UNPUBLISHED,
              command: { capabilityKey: UNPUBLISHED, payload: VOID_PAYLOAD },
              commandDigest: VOID_DIGEST,
              requesterAuthority: [unpublishedWitness],
            }),
          ),
        ).toBe('capability_not_proposable');
      }),
    ),
  );

  suite.effect('reports a failed authority read as retryable unavailability, never as a denial', () =>
    onLiveClock(
      Effect.gen(function* unavailableAuthority() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const eva = yield* scopeFor(EVA);
        const ports = liveApprovalsPorts(live, eva);

        // Another tenant's question is answered before any read: unavailability, not a denial.
        expect(
          yield* refusalOf(
            ports.authority.inspect({
              expectedHolder: holder(EVA),
              scopeId: COMPANY_SCOPE,
              tenantId: OTHER_TENANT,
              witnesses: [...approveWitnesses],
            }),
          ),
        ).toBe('approval_authority_unavailable');

        // The live cells cannot be read at all: the same retryable failure, never `lost`.
        yield* admin.unsafe(`revoke select on core.access_assignments from ontos_runtime`).pipe(Effect.orDie);
        expect(
          yield* refusalOf(
            ports.authority.inspect({
              expectedHolder: holder(EVA),
              scopeId: COMPANY_SCOPE,
              tenantId: TENANT,
              witnesses: [...approveWitnesses],
            }),
          ),
        ).toBe('approval_authority_unavailable');

        // The membership rows cannot be read either, so administration is unanswered, never `false`.
        yield* admin.unsafe(`revoke select on core.access_memberships from ontos_runtime`).pipe(Effect.orDie);
        expect(
          yield* refusalOf(
            ports.administrators.isAdministrator({ principalId: MILA, scopeId: COMPANY_SCOPE, tenantId: TENANT }),
          ),
        ).toBe('approval_authority_unavailable');
      }),
    ),
  );

  suite.effect('composes the live mandate adapter over Core ports without binding it to a runner', () =>
    onLiveClock(
      Effect.gen(function* liveMandateAdapter() {
        const { executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const eva = yield* scopeFor(EVA);
        // The runner owner supplies `approvalsFor` and provides these ports; nothing here binds the
        // adapter to a runner or enables production execution.
        const dispatch = yield* makeDrizzleActionMandateDispatch().pipe(
          Effect.provideService(
            MandateDispatchPorts,
            liveMandateDispatchPorts({
              approvalsFor: (scope) => approvalsFor(live, scope),
              database: { executor },
              frozenCommands: live.frozenCommands,
              principalKinds: live.principalKinds,
            }),
          ),
        );
        expect(Object.isFrozen(dispatch)).toBe(true);
        expect(Object.keys(dispatch).toSorted()).toStrictEqual([
          'claim',
          'commit',
          'loadParkedProposal',
          'parkProposal',
          'prepare',
        ]);
        // The composed service is the live one: it answers this tenant and refuses another.
        const ports = liveApprovalsPorts(live, eva);
        expect(Option.getOrThrow(yield* ports.catalog.lookup(VOID)).capabilityKey).toBe(VOID);
      }),
    ),
  );
});
