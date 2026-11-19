import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { buildAccessCatalogRelease } from '@app/core-runtime/access/catalog';
import { makeScriptedBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { sql } from 'drizzle-orm';
import {
  Array as EffectArray,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Order,
  Ref,
  Result,
  Schedule,
  Schema,
} from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import type { ActionMandateDispatch } from '../../packages/core-runtime/src/access/approvals/action-mandate-dispatch.ts';
import {
  lockActionAccessFence,
  MandateDispatchPorts,
  makeDrizzleActionMandateDispatch,
} from '../../packages/core-runtime/src/access/approvals/action-mandate-dispatch.ts';
import { freezeCommand } from '../../packages/core-runtime/src/access/approvals/command.ts';
import {
  ApprovalStore,
  ApprovalStoreLive,
  makeJoinedDrizzleApprovalStore,
} from '../../packages/core-runtime/src/access/approvals/drizzle-store.ts';
import { makeDrizzleFrozenCommandStore } from '../../packages/core-runtime/src/access/approvals/frozen-command-drizzle-store.ts';
import type { FrozenCommandStore } from '../../packages/core-runtime/src/access/approvals/frozen-command.ts';
import { ActionKeySchema, FrozenCommands } from '../../packages/core-runtime/src/access/approvals/frozen-command.ts';
import type { LiveApprovalServices } from '../../packages/core-runtime/src/access/approvals/live-composition.ts';
import { liveMandateDispatchPorts } from '../../packages/core-runtime/src/access/approvals/live-composition.ts';
import type { BoundWitness } from '../../packages/core-runtime/src/access/approvals/proposal.ts';
import { liveApprovalsService } from '../../packages/core-runtime/src/access/approvals/service.ts';
import { makeAccessChangesDrizzleStore } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import type {
  DecisionReasonCode,
  GrantedAuthorityEvidence,
} from '../../packages/core-runtime/src/access/decision/contract.ts';
import type { AccessPrincipalKinds } from '../../packages/core-runtime/src/access/enforcement/actor.ts';
import { makeDrizzleAccessPrincipalKinds } from '../../packages/core-runtime/src/access/enforcement/actor.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  GrantIncarnationIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../packages/core-runtime/src/access/ids.ts';
import type {
  AssignmentIncarnationId,
  CapabilityKey,
  PrincipalId,
} from '../../packages/core-runtime/src/access/ids.ts';
import { callerTransactions, requestTransactions } from '../../packages/core-runtime/src/access/intent/persistence.ts';
import {
  makeJoinedTenantIntentLoader,
  makeTenantIntentLoader,
} from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import type { Cell, DecisionOutcome, Holder } from '../../packages/core-runtime/src/access/model.ts';
import { CatalogSnapshotEntrySchema, CellSchema } from '../../packages/core-runtime/src/access/model.ts';
import { ActionPermissionCheckError } from '../../packages/core-runtime/src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../packages/core-runtime/src/actions/principal-context.ts';
import { ActionProposalAcceptedSchema } from '../../packages/core-runtime/src/actions/proposal-accepted.ts';
import { makeActionRepository } from '../../packages/core-runtime/src/actions/repository.ts';
import type { ActionRuntimeService, ActionRuntimeStage } from '../../packages/core-runtime/src/actions/runtime.ts';
import { makeActionRuntime } from '../../packages/core-runtime/src/actions/runtime.ts';
import type {
  AccessDeclaration,
  AccessDeclarationInput,
} from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { AccessDeclarationSchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import type { DatabaseConfigValue } from '../../packages/core-runtime/src/db/config.ts';
import { loadDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { coreRelations } from '../../packages/core-runtime/src/db/schema.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import type { CoreTransaction } from '../../packages/core-runtime/src/db/types.ts';
import { changePrincipalStatusAction } from '../../packages/core-runtime/src/modules/actions/change-principal-status.action.ts';
import { createNonHumanPrincipalAction } from '../../packages/core-runtime/src/modules/actions/create-non-human-principal.action.ts';
import type { BoundAccessGate } from '../../packages/core-runtime/src/operations/access-gate.ts';
import type { OperationalScope } from '../../packages/core-runtime/src/operations/context.ts';
import { createTemplateDatabase } from '../../packages/core-runtime/tests/support/access-scenarios/database.ts';
import { openActionRuntimeOptions } from '../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { testOperationalScopeResolver } from '../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { createBrandAction } from '../../verticals/catalog/src/actions/create-brand.action.ts';
import { catalogRegistration } from '../../verticals/catalog/vertical.registration.ts';

/*
 * The Action runner's owner-mandate proof against a real PostgreSQL and a REAL production owner Action
 * (O75, O80, O85, O90). The preceding candidate was rejected because it fabricated a proposable
 * declaration: it seeded `createNonHumanPrincipalAction`'s capability with modes
 * `['run','propose','approve']` although the shipped declaration is `kind: 'admin', modes: ['run']`.
 * This suite replaces that fabrication with the real thing:
 *
 * - the owner Action is production `createBrandAction` (`commerce.catalog`), whose shipped
 *   declaration really is `kind: 'action', modes: ['run','propose','approve'], selectors: []`;
 * - the published catalog entry is built from that registration by the one release builder,
 *   `buildAccessCatalogRelease`, and inserted as the real `entry_json` — nothing here hand-writes a
 *   mode, kind, selector, module key or capability key;
 * - the role, revision, assignments, grant incarnations and memberships are genuine Core intent
 *   rows for the capability the release publishes, in the tenant context scope the Action's
 *   `legalEntityScope: 'forbidden'` and tenant entrypoint require;
 * - the mandate is `makeDrizzleActionMandateDispatch` over the shipped stores; its authority is the
 *   live approvals composition over Core's own intent, and the approved frozen command reaches the
 *   real `createBrand` handler and its real catalog persistence (`catalog.brands` +
 *   `catalog.brand_revisions` + `catalog.catalog_result_snapshots`).
 *
 * The record-scoped half is deliberately absent: `createBrandAction` declares `selectors: []`, so the
 * command is honestly targetless. No governing-read metadata or transaction-bound record projection
 * exists, so no record-scoped claim is made.
 *
 * Controlled, non-authority ports (labelled where they are installed):
 *
 * - the access gate is scripted; the mandate's witness reads use the live approvals composition
 *   inside the owner transaction. This suite does not establish the canonical gate's snapshot,
 *   projection freshness or concurrent-writer fence guarantees; those need separate proof;
 * - `checkActionPermission` is the legacy Action permission check; the v2 decision is the gate;
 * - the module entrypoint/state gate, the composition-authority lock and the composition revision
 *   are unrelated owner seams, opened exactly as the shipped Action fixtures open them.
 *
 * The fixture grants broad CRUD privileges on Core and Catalog tables to its non-superuser runtime
 * role. It therefore does not prove production least-privilege grants.
 * Proposal parking and both fence-lock race orders are covered with the scripted gate and real
 * runner/stores. The concurrent writer is direct SQL, not the production AccessChanges pipeline.
 * What is NOT proved here: crash recovery, canonical-gate/production-writer concurrency, or SpiceDB. The
 * production `makeActionRuntimeLive` still has NO `mandateDispatch` binding, so product execution
 * stays OFF; this suite binds the adapter explicitly for the proof.
 *
 * This suite lives outside `packages/core-runtime` because it runs a real vertical Action: Core must
 * not gain a vertical dependency for its own proof.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
/** The one correlation id every request in this suite carries. */
const CORRELATION_ID = 'owner-runner';
/** The one failure code the injected transient faults and their assertions share. */
const PERMISSION_CHECK_FAILED = 'action_permission_check_failed';
/** The one defect message the proposal-parking assertions throw when the runner answers no 202. */
const PARKED_EXPECTED = 'Expected the parked-proposal 202';
const TENANT = TenantIdSchema.make(uid(1));
const TENANT_SCOPE = AccessScopeIdSchema.make(uid(2));
const JANA = PrincipalIdSchema.make(uid(3));
const EVA = PrincipalIdSchema.make(uid(4));
const BRAND_ID = uid(5);
const ROLE = RoleIdSchema.make(uid(6));
const REVISION = RoleRevisionIdSchema.make(uid(7));
const JANA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(8));
const EVA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(9));
const JANA_MEMBERSHIP = uid(10);
const EVA_MEMBERSHIP = uid(11);

const CAPABILITY_TEXT = 'commerce.catalog.brand.create';
const CORE_CAPABILITY_TEXT = 'core.identity.principal.create-non-human';
const CATALOG_MODULE = 'commerce.catalog';
const CORE_MODULE = 'core.identity';
const BRAND_RESOURCE_TYPE = 'commerce.catalog.brand';

const CAPABILITY = CapabilityKeySchema.make(CAPABILITY_TEXT);
const ACTION_KEY = ActionKeySchema.make('commerce.catalog.create-brand');
const CORE_CAPABILITY = CapabilityKeySchema.make(CORE_CAPABILITY_TEXT);
const CORE_ACTION_KEY = ActionKeySchema.make('core.identity.create-non-human-principal');

const PAYLOAD = {
  brandRef: {
    moduleId: CATALOG_MODULE,
    resourceId: BRAND_ID,
    resourceType: BRAND_RESOURCE_TYPE,
    tenantId: TENANT,
  },
  evidenceRefs: ['evidence:mandate-proof'],
  name: 'Mandate Proof Brand',
  reason: 'Proves the owner mandate path over the real catalog Action',
} as const;
const COMMAND = { capabilityKey: CAPABILITY, payload: PAYLOAD } as const;
const COMMAND_DIGEST = CommandDigestSchema.make(Result.getOrThrow(freezeCommand(COMMAND)));

const CORE_COMMAND = {
  capabilityKey: CORE_CAPABILITY,
  payload: { displayName: 'Mandate Proof Service', kind: 'service' },
} as const;
const CORE_COMMAND_DIGEST = CommandDigestSchema.make(Result.getOrThrow(freezeCommand(CORE_COMMAND)));

const GRANTS = {
  approve: GrantIncarnationIdSchema.make(uid(20)),
  corePropose: GrantIncarnationIdSchema.make(uid(21)),
  propose: GrantIncarnationIdSchema.make(uid(22)),
  run: GrantIncarnationIdSchema.make(uid(23)),
} as const;

/**
 * The role's cells. The first three are the real `createBrandAction` modes (run, propose, approve).
 * The fourth is deliberately artificial: a `propose` cell for the run-only Core admin capability,
 * seeded only so the negative test can prove the PUBLISHED CATALOG still refuses it. A grant can never
 * widen a declaration (O43/O44).
 */
const CELLS = [
  { capabilityKey: CAPABILITY, grant: GRANTS.propose, mode: 'propose' },
  { capabilityKey: CAPABILITY, grant: GRANTS.approve, mode: 'approve' },
  { capabilityKey: CAPABILITY, grant: GRANTS.run, mode: 'run' },
  { capabilityKey: CORE_CAPABILITY, grant: GRANTS.corePropose, mode: 'propose' },
] as const;

const cellOf = (cell: (typeof CELLS)[number]): Cell => ({
  capabilityKey: cell.capabilityKey,
  mode: cell.mode,
  selector: { _tag: 'all' },
});

const cellJson = Schema.encodeSync(Schema.fromJsonString(CellSchema));
const cellsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CellSchema)));
const entryJson = Schema.encodeSync(Schema.fromJsonString(CatalogSnapshotEntrySchema));

const holder = (principalId: PrincipalId): Holder => ({ _tag: 'Principal', principalId });

const boundWitness = (input: {
  readonly assignmentIncarnationId: AssignmentIncarnationId;
  readonly capabilityKey: CapabilityKey;
  readonly grantIncarnationId: (typeof GRANTS)[keyof typeof GRANTS];
  readonly holderId: Holder;
}): BoundWitness => ({ ...input, scopeId: TENANT_SCOPE });

const requesterWitness = boundWitness({
  assignmentIncarnationId: JANA_ASSIGNMENT,
  capabilityKey: CAPABILITY,
  grantIncarnationId: GRANTS.propose,
  holderId: holder(JANA),
});
const approvalWitness = boundWitness({
  assignmentIncarnationId: EVA_ASSIGNMENT,
  capabilityKey: CAPABILITY,
  grantIncarnationId: GRANTS.approve,
  holderId: holder(EVA),
});
const executionWitness = boundWitness({
  assignmentIncarnationId: EVA_ASSIGNMENT,
  capabilityKey: CAPABILITY,
  grantIncarnationId: GRANTS.run,
  holderId: holder(EVA),
});
const coreRequesterWitness = boundWitness({
  assignmentIncarnationId: JANA_ASSIGNMENT,
  capabilityKey: CORE_CAPABILITY,
  grantIncarnationId: GRANTS.corePropose,
  holderId: holder(JANA),
});

/**
 * SCRIPTED gate evidence, not a canonical decision: the propose cell the gate resolved for Jana. It
 * names exactly the seeded assignment, grant incarnation, role revision and tenant scope, so the
 * live approvals service can re-read them from Core's own rows — but the answer itself is a double.
 * This suite therefore does not prove the canonical gate, SpiceDB, or a real engine decision; it
 * proves the runner/store protocol over a real Action once such an answer is given.
 */
const requesterEvidence: GrantedAuthorityEvidence = {
  assignedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2029-12-01T00:00:00.000Z')),
  assignedBy: EVA,
  mode: 'propose',
  roleId: ROLE,
  roleRevisionId: REVISION,
  selector: 'all',
  side: 'principal',
  witness: {
    assignmentIncarnationId: JANA_ASSIGNMENT,
    capabilityKey: CAPABILITY,
    grantIncarnationId: GRANTS.propose,
    holderId: holder(JANA),
    mode: 'propose',
    purpose: 'requester',
    scopeId: TENANT_SCOPE,
  },
};

const REASON_FOR = {
  ALLOWED: 'allow.granted',
  DENIED: 'deny.insufficient_grant',
  NEEDS_APPROVAL: 'approval.required',
  UNAVAILABLE: 'unavailable.intent',
} as const satisfies Readonly<Record<DecisionOutcome, DecisionReasonCode>>;

/**
 * The one scripted gate answer this suite's propose requests receive, carrying the requester witness
 * above. Everything else about the run — the catalog release, the proposal, the frozen command and
 * the invocation receipt — is the shipped code.
 */
const gateAnswering = (
  outcome: DecisionOutcome,
  evidence: readonly GrantedAuthorityEvidence[] = [],
): BoundAccessGate => ({
  ...makeScriptedBoundAccessGate('needs_approval').bound,
  decide: () => Effect.succeed({ evidence, outcome, reasons: [{ code: REASON_FOR[outcome] }], selectors: [] }),
});

/** The authored declaration shape of one real registration, re-encoded for the release builder. */
const accessDeclarationInput = (
  declaration: AccessDeclaration | undefined,
  actionKey: string,
): AccessDeclarationInput => {
  if (declaration === undefined) {
    throw new Error(`${actionKey} carries no accessDeclaration`);
  }
  return Schema.encodeSync(AccessDeclarationSchema)(declaration);
};

/**
 * The real published release of the two registrations this proof reads: the proposable catalog
 * `createBrandAction` and the run-only Core admin Action the rejected candidate fabricated. The one
 * production builder derives every entry, digest and identifier from those declarations.
 */
const RELEASE = Result.getOrThrow(
  buildAccessCatalogRelease({
    installedModuleKeys: [ModuleKeySchema.make(CATALOG_MODULE), ModuleKeySchema.make(CORE_MODULE)],
    modules: [
      {
        descriptors: [
          {
            accessDeclaration: accessDeclarationInput(
              createBrandAction.descriptor.accessDeclaration,
              createBrandAction.descriptor.actionKey,
            ),
            entrypoint: createBrandAction.descriptor.entrypoint,
          },
        ],
        moduleId: CATALOG_MODULE,
      },
      {
        descriptors: [
          {
            accessDeclaration: accessDeclarationInput(
              createNonHumanPrincipalAction.descriptor.accessDeclaration,
              createNonHumanPrincipalAction.descriptor.actionKey,
            ),
            entrypoint: createNonHumanPrincipalAction.descriptor.entrypoint,
          },
        ],
        moduleId: CORE_MODULE,
      },
    ],
    publishedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00.000Z')),
  }),
);
const BRAND_ENTRY = RELEASE.entries.find((entry) => entry.key === CAPABILITY);
const CORE_ENTRY = RELEASE.entries.find((entry) => entry.key === CORE_CAPABILITY);

const replaceDatabase = (configuration: DatabaseConfigValue, database: string): string => {
  const url = new URL(configuration.connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

const catalogMigrationsDirectory = new URL('../../verticals/catalog/drizzle/', import.meta.url);

/** The committed catalog schema, so the real `createBrand` handler has its own tables to write. */
const applyCatalogMigrations = (admin: PgClient.PgClient) =>
  Effect.gen(function* applyCatalogMigrationsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directories = EffectArray.sort(
      yield* fileSystem.readDirectory(catalogMigrationsDirectory.pathname),
      Order.String,
    );
    const statements: string[] = [];
    for (const directory of directories) {
      const path = `${catalogMigrationsDirectory.pathname}${directory}/migration.sql`;
      if (!(yield* fileSystem.exists(path))) {
        continue;
      }
      for (const statement of (yield* fileSystem.readFileString(path)).split('--> statement-breakpoint')) {
        if (statement.trim().length > 0) {
          statements.push(statement);
        }
      }
    }
    statements.push(
      'grant usage on schema catalog to ontos_runtime',
      'grant select, insert, update, delete on all tables in schema catalog to ontos_runtime',
      'grant usage, select on all sequences in schema catalog to ontos_runtime',
      'grant execute on all functions in schema catalog to ontos_runtime',
    );
    yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie, Effect.asVoid), {
      concurrency: 1,
      discard: true,
    });
  });

const membership = (input: { readonly id: string; readonly principalId: PrincipalId; readonly status: string }) =>
  `insert into core.access_memberships
     (membership_id, tenant_id, scope_id, kind, principal_id, recorded_by, status, valid_from)
     values ('${input.id}', '${TENANT}', '${TENANT_SCOPE}', 'member', '${input.principalId}', '${EVA}',
             '${input.status}', now() - interval '1 day')`;

/**
 * One tenant-context scope whose role holds the real createBrand cells plus one artificial propose
 * cell for the run-only Core capability. The scope is the tenant context because `createBrandAction`
 * is tenant-scoped and `legalEntityScope: 'forbidden'`, so the fence and the membership path are the
 * tenant's own.
 */
const seedAccess = (admin: PgClient.PgClient) =>
  Effect.gen(function* seedAccessEffect() {
    const statements = [
      `insert into core.tenants (tenant_id, slug, name, status, default_locale)
         values ('${TENANT}', 'mandate-proof', 'Mandate Proof', 'active', 'cs')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${TENANT}', '${JANA}', 'human', 'Jana', 'active'),
         ('${TENANT}', '${EVA}', 'human', 'Eva', 'active')`,
      ...[JANA, EVA].map(
        (principalId) =>
          `insert into core.principal_auth_bindings
             (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type,
              provider_subject_id, authentication_namespace_id, status)
             values ('${principalId}', '${TENANT}', '${principalId}', 'better_auth', 'user',
                     '${principalId}', 'access-owner-runner.session.v1', 'active')`,
      ),
      `insert into core.access_catalog_snapshots (catalog_snapshot_id, digest, published_at)
         values ('${RELEASE.id}', '${RELEASE.digest}', '${RELEASE.publishedAt.toISOString()}')`,
      ...RELEASE.entries.map(
        (entry) =>
          `insert into core.access_catalog_entries (catalog_snapshot_id, capability_key, entry_json)
             values ('${RELEASE.id}', '${entry.key}', '${entryJson(entry).replaceAll("'", "''")}'::jsonb)`,
      ),
      `insert into core.access_scopes (scope_id, tenant_id, tenant_context_id)
         values ('${TENANT_SCOPE}', '${TENANT}', '${TENANT}')`,
      `insert into core.access_scope_fences (scope_id, tenant_id, state, revision)
         values ('${TENANT_SCOPE}', '${TENANT}', 'Ready', 1)`,
      `insert into core.access_roles (role_id, tenant_id, created_by, name, legal_entity_id)
         values ('${ROLE}', '${TENANT}', '${JANA}', 'Účetní', null)`,
      `insert into core.access_role_revisions
         (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
         values ('${REVISION}', '${TENANT}', '${ROLE}', 1, '${RELEASE.id}',
                 '${cellsJson(CELLS.map(cellOf))}'::jsonb, '${JANA}', 'manual')`,
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status,
          valid_from, valid_until)
         values
         ('${JANA_ASSIGNMENT}', '${TENANT}', '${TENANT_SCOPE}', '${ROLE}', '${REVISION}', '${JANA}', '${EVA}',
          'active', now() - interval '1 day', null),
         ('${EVA_ASSIGNMENT}', '${TENANT}', '${TENANT_SCOPE}', '${ROLE}', '${REVISION}', '${EVA}', '${EVA}',
          'active', now() - interval '1 day', null)`,
      ...CELLS.map(
        (cell) =>
          `insert into core.access_grant_incarnations
             (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
             values ('${cell.grant}', '${TENANT}', '${TENANT_SCOPE}', '${ROLE}', '${cell.capabilityKey}',
                     '${cell.mode}', 'all', '${cellJson(cellOf(cell))}'::jsonb, 'active')`,
      ),
      `insert into core.tenant_module_states (tenant_id, module_key, state) values
         ('${TENANT}', '${CATALOG_MODULE}', 'active'),
         ('${TENANT}', '${CORE_MODULE}', 'active')`,
      membership({ id: JANA_MEMBERSHIP, principalId: JANA, status: 'active' }),
      membership({ id: EVA_MEMBERSHIP, principalId: EVA, status: 'active' }),
    ];
    yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie, Effect.asVoid), {
      concurrency: 1,
      discard: true,
    });
  });

const disposableDatabase = Effect.gen(function* disposableDatabaseEffect() {
  // This disposable-database suite uses explicit process configuration, never the workspace .env.
  const connections = yield* loadDatabaseConnectionPair({ envPath: `${import.meta.filename}.no-environment-file` });
  const crypto = yield* Crypto.Crypto;
  const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  const name = `access_owner_runner_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  yield* bootstrap.unsafe(`create database "${name}"`).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() =>
    bootstrap.unsafe(`drop database if exists "${name}" with (force)`).pipe(Effect.orDie),
  );
  const admin = yield* makeTestPgClient(replaceDatabase(connections.admin, name), { maxConnections: 2 });
  // The whole committed Core migration set, then the committed catalog schema for the owner write.
  yield* createTemplateDatabase(admin);
  yield* applyCatalogMigrations(admin);
  yield* seedAccess(admin);
  /*
   * The composition reads on several connections at once: the store's own transaction, the intent
   * loader's per-read transaction and the adapter's mandate/scope reads.
   */
  const runtime = yield* makeTestPgClient(replaceDatabase(connections.runtime, name), { maxConnections: 8 });
  const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { admin, executor };
});

const scopeFor = (principalId: PrincipalId): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: principalId,
    authContextRef: `session:access-owner-runner:${principalId}`,
    authenticationNamespaceId: 'access-owner-runner.session.v1',
    authMethod: 'session',
    principalId,
    tenantId: TENANT,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-owner-runner' })),
    Effect.orDie,
  );

type LiveDatabase = Effect.Success<typeof disposableDatabase>['executor'];

/** The two stores the mandate ports add on top of the approvals sources. */
interface LiveMandateStores {
  readonly frozenCommands: FrozenCommandStore;
  readonly principalKinds: AccessPrincipalKinds;
}

/**
 * The live approvals composition over the shipped stores: `requestTransactions` for the ordinary
 * reads and `callerTransactions(owner)` for the transaction-bound claim. Nothing is scripted and no
 * read is re-decided.
 */
const liveApprovals = Effect.fn('OwnerRunnerFixture.liveApprovals')(function* liveApprovalsEffect(
  executor: LiveDatabase,
) {
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

const approvalsFor = (live: LiveApprovalServices, scope: OperationalScope) => liveApprovalsService(live, scope);

/**
 * The canonical proposal: the requester's own live propose witness, the published capability, the
 * frozen command. `propose` re-reads the witness and the release through the live composition, so a
 * proposal exists only on authority Core's own rows state.
 */
const proposeAndApprove = Effect.fn('OwnerRunnerFixture.proposeAndApprove')(function* proposeAndApproveEffect(
  live: LiveApprovalServices,
  jana: OperationalScope,
  eva: OperationalScope,
) {
  const proposed = yield* approvalsFor(live, jana).propose({
    actionKey: ACTION_KEY,
    actor: { _tag: 'Principal', principalId: JANA },
    capabilityKey: CAPABILITY,
    command: COMMAND,
    commandDigest: COMMAND_DIGEST,
    requesterAuthority: [requesterWitness],
    requesterKind: 'human',
    scopeId: TENANT_SCOPE,
    tenantId: TENANT,
  });
  const approved = yield* approvalsFor(live, eva).approve({
    approver: { _tag: 'Principal', principalId: EVA },
    approverKind: 'human',
    authority: { approval: approvalWitness, execution: executionWitness, parentRecordRead: [] },
    policy: { selfApproval: 'forbidden' },
    proposalId: proposed.id,
    scopeId: TENANT_SCOPE,
    tenantId: TENANT,
  });
  return { approved, proposed };
});

/** A propose of the run-only Core admin capability, with the artificial propose cell seeded above. */
const proposeRunOnlyCoreAction = (live: LiveApprovalServices, scope: OperationalScope) =>
  approvalsFor(live, scope).propose({
    actionKey: CORE_ACTION_KEY,
    actor: { _tag: 'Principal', principalId: JANA },
    capabilityKey: CORE_CAPABILITY,
    command: CORE_COMMAND,
    commandDigest: CORE_COMMAND_DIGEST,
    requesterAuthority: [coreRequesterWitness],
    requesterKind: 'human',
    scopeId: TENANT_SCOPE,
    tenantId: TENANT,
  });

const mandateDispatchFor = (live: LiveApprovalServices & LiveMandateStores, executor: LiveDatabase) =>
  makeDrizzleActionMandateDispatch().pipe(
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

/**
 * The real adapter with one injected transient failure in `commit`: the handler has already written
 * the Brand inside the transaction, and the failure lands BEFORE the receipt CAS. Every read and
 * write still uses the real adapter.
 */
const faultyCommitDispatch = (
  dispatch: ActionMandateDispatch,
  failNextCommit: Ref.Ref<boolean>,
): ActionMandateDispatch => ({
  ...dispatch,
  commit: (input) =>
    Ref.getAndSet(failNextCommit, false).pipe(
      Effect.flatMap((fail) =>
        fail
          ? Effect.fail(
              new ActionPermissionCheckError({
                code: PERMISSION_CHECK_FAILED,
                reason: 'TEST: transient commit failure injected after the owner write',
              }),
            )
          : dispatch.commit(input),
      ),
    ),
});

/**
 * The two owner seams a race test may wrap for synchronization: the runner's own fence lock (never
 * bypassed — the wrapper always delegates to the real one) and the stage notifier that records which
 * lifecycle stages the runner actually reached.
 */
interface RuntimeSeams {
  readonly lockAccessExecutionFence?: typeof lockActionAccessFence;
  readonly onStage?: (stage: ActionRuntimeStage) => void;
}

const makeRuntime = (
  executor: LiveDatabase,
  crypto: Crypto.Crypto,
  dispatch: ActionMandateDispatch,
  accessDecision: BoundAccessGate = makeScriptedBoundAccessGate('allowed').bound,
  seams: RuntimeSeams = {},
): ActionRuntimeService =>
  makeActionRuntime(
    { executor },
    makeActionRepository(crypto),
    // The legacy Action permission check; the v2 decision is the scripted pre-flight gate below.
    { checkActionPermission: () => Effect.succeed('allowed' as const) },
    testOperationalScopeResolver,
    {
      // The suite's declared pre-flight; the mandate's authority is the live approvals composition.
      accessDecision,
      ...openActionRuntimeOptions,
      mandateDispatch: dispatch,
      // Module-operation admission refuses a non-Core Action whose owner registration is unbound.
      ownerRegistration: catalogRegistration,
      ...seams,
    },
  );

/**
 * The real adapter with one injected transient failure in `parkProposal`: the real park has already
 * written the proposal, its frozen command and the invocation's terminal receipt inside the owner
 * transaction, and the failure lands BEFORE that transaction commits. `parksReached` proves the real
 * seam was reached, so the rollback assertions are not the absence of writes from a failure before
 * the seam. This is the only scripted fault in the proposal half; every read and write is real.
 */
const faultyParkDispatch = (
  dispatch: ActionMandateDispatch,
  failNextPark: Ref.Ref<boolean>,
  parksReached: Ref.Ref<number>,
): ActionMandateDispatch => ({
  ...dispatch,
  parkProposal: (input) =>
    dispatch.parkProposal(input).pipe(
      Effect.tap(() => Ref.update(parksReached, (count) => count + 1)),
      Effect.flatMap((parked) =>
        Ref.getAndSet(failNextPark, false).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(
                  new ActionPermissionCheckError({
                    code: PERMISSION_CHECK_FAILED,
                    reason: 'TEST: transient park failure injected after the real proposal write',
                  }),
                )
              : Effect.succeed(parked),
          ),
        ),
      ),
    ),
});

/**
 * The backend PID of the connection a real Core transaction runs on. A race proof compares it with
 * `pg_blocking_pids`, so the lock's owner is a known backend, never an inference from timing.
 */
const transactionBackendPid = (transaction: CoreTransaction) =>
  transaction.execute<{ readonly pid: number }>(sql`select pg_backend_pid() as pid`, 'objects').pipe(
    Effect.orDie,
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.die(new Error('Expected the transaction backend PID'))
        : Effect.succeed(rows[0].pid),
    ),
  );

/** PostgreSQL's own report of who blocks a given backend, read from `pg_stat_activity`. */
const readBlocking = (admin: PgClient.PgClient, waiterPid: number) =>
  admin
    .unsafe<{ readonly blockerPids: readonly number[]; readonly waitEventType: string | null }>(
      `select pg_blocking_pids($1::integer) as "blockerPids", wait_event_type as "waitEventType"
         from pg_stat_activity where pid = $1::integer`,
      [waiterPid],
    )
    .pipe(Effect.orDie);

/** Bounded live-clock observation of a real block: never a sleep, never a race-lucky assertion. */
const awaitBlockedBy = (admin: PgClient.PgClient, waiterPid: number, blockerPid: number) =>
  readBlocking(admin, waiterPid).pipe(
    Effect.repeat({
      schedule: Schedule.spaced('10 millis'),
      until: (rows) => rows[0]?.blockerPids?.includes(blockerPid) ?? false,
    }),
    Effect.timeout('10 seconds'),
  );

/** The tenant scope fence's own row, so a transition is asserted instead of inferred. */
const fenceOf = (admin: PgClient.PgClient) =>
  admin
    .unsafe<{ readonly owningOperationId: string | null; readonly revision: number; readonly state: string }>(
      `select owning_operation_id as "owningOperationId", revision, state
         from core.access_scope_fences
        where tenant_id = '${TENANT}' and scope_id = '${TENANT_SCOPE}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    );

/**
 * The real mandate adapter with its `claim` seam wrapped for synchronization: the REAL claim runs
 * first, so the owner transaction is admitted and holds the real shared fence lock, and only then
 * the fiber reports its backend and waits. The wait is released by the observer and by a finalizer,
 * so a failing assertion can never leave the transaction parked.
 */
const mandateClaimPausingDispatch = (
  dispatch: ActionMandateDispatch,
  claimedPid: Deferred.Deferred<number>,
  release: Deferred.Deferred<null>,
): ActionMandateDispatch => ({
  ...dispatch,
  claim: (input) =>
    Effect.gen(function* pausingClaim() {
      yield* dispatch.claim(input);
      const pid = yield* transactionBackendPid(input.transaction);
      yield* Deferred.succeed(claimedPid, pid);
      yield* Deferred.await(release);
    }),
});

/**
 * The REAL fence lock, wrapped strictly to report the runner's backend before delegating. The lock
 * itself is never replaced, relaxed or skipped: the wrapper always calls the shipped
 * `lockActionAccessFence` on the same transaction.
 */
const fencePidLatchingLock =
  (atFence: Deferred.Deferred<number>): typeof lockActionAccessFence =>
  (transaction, scope, legalEntityScope, administrative) =>
    Effect.gen(function* latchingFenceLock() {
      const pid = yield* transactionBackendPid(transaction);
      yield* Deferred.succeed(atFence, pid);
      return yield* lockActionAccessFence(transaction, scope, legalEntityScope, administrative);
    });

const mandateRequest = (
  principal: OperationalScope,
  mandateId: string,
  overrides: { readonly payload?: unknown } = {},
) => ({
  payload: overrides.payload ?? null,
  principal,
  registration: createBrandAction,
  transport: { correlationId: CORRELATION_ID, mandateId },
});

/**
 * The one propose request shape this suite sends: the real catalog Action, the endpoint's declared
 * `result-or-proposal` success contract (the only contract whose success union carries the 202), and
 * an explicit `propose` intent. The payload is what the Action's own schema decodes.
 */
const proposeRequest = (
  principal: OperationalScope,
  idempotencyKey: string,
  overrides: { readonly payload?: unknown } = {},
) => ({
  payload: overrides.payload ?? PAYLOAD,
  principal,
  registration: createBrandAction,
  successContract: 'result-or-proposal' as const,
  transport: { correlationId: CORRELATION_ID, idempotencyKey, intent: 'propose' as const },
});

const mandateIdOf = (admin: PgClient.PgClient, proposalId: string) =>
  admin
    .unsafe<{ readonly mandate_id: string }>(
      `select mandate_id from core.access_mandates where proposal_id = '${proposalId}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]?.mandate_id ?? ''),
    );

const proposalReceipt = (admin: PgClient.PgClient, proposalId: string) =>
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

const invocationReceipt = (admin: PgClient.PgClient, mandateId: string) =>
  admin
    .unsafe<{ readonly action_invocation_id: string; readonly status: string }>(
      `select action_invocation_id, status from core.action_invocations
         where tenant_id = '${TENANT}' and idempotency_key = 'mandate:${mandateId}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    );

const brandCount = (admin: PgClient.PgClient) =>
  admin
    .unsafe<{ readonly count: string }>(
      `select count(*)::text as count from catalog.brands where tenant_id = '${TENANT}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Number(rows[0]?.count ?? '0')),
    );

const frozenCommandCount = (admin: PgClient.PgClient) =>
  admin
    .unsafe<{ readonly count: string }>(
      `select count(*)::text as count from core.access_frozen_commands where tenant_id = '${TENANT}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Number(rows[0]?.count ?? '0')),
    );

const proposalCount = (admin: PgClient.PgClient) =>
  admin
    .unsafe<{ readonly count: string }>(
      `select count(*)::text as count from core.access_proposals where tenant_id = '${TENANT}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Number(rows[0]?.count ?? '0')),
    );

/**
 * The parked proposal and the invocation receipt bound to it, read as one fact: a proposal row alone
 * is not a receipt, and an invocation alone is not a proposal (O90.3).
 */
const parkedProposal = (admin: PgClient.PgClient) =>
  admin
    .unsafe<{
      readonly action_invocation_id: string;
      readonly capability_key: string;
      readonly command_digest: string;
      readonly invocation_status: string;
      readonly proposal_id: string;
      readonly proposal_status: string;
      readonly requester_principal_id: string;
      readonly scope_id: string;
      readonly target: string | null;
    }>(
      `select p.proposal_id, p.capability_key, p.command_digest, p.status as proposal_status,
              p.scope_id, p.target, p.requester_principal_id, p.action_invocation_id,
              i.status as invocation_status
         from core.access_proposals p
         join core.action_invocations i
           on i.tenant_id = p.tenant_id and i.action_invocation_id = p.action_invocation_id
        where p.tenant_id = '${TENANT}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    );

const frozenCommandOf = (admin: PgClient.PgClient, proposalId: string) =>
  admin
    .unsafe<{
      readonly action_key: string;
      readonly capability_key: string;
      readonly command_digest: string;
    }>(
      `select action_key, capability_key, command_digest from core.access_frozen_commands
         where tenant_id = '${TENANT}' and proposal_id = '${proposalId}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    );

const invocationStatusOf = (admin: PgClient.PgClient, idempotencyKey: string) =>
  admin
    .unsafe<{ readonly action_invocation_id: string; readonly status: string }>(
      `select action_invocation_id, status from core.action_invocations
         where tenant_id = '${TENANT}' and idempotency_key = '${idempotencyKey}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    );

/** The stable refusal code a failure carries; anything else is a defect this suite never expects. */
const codeOf = <Failure,>(failure: Failure): string =>
  Schema.is(Schema.Struct({ code: Schema.String }))(failure) ? failure.code : 'untyped_failure';

const refusalOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  Effect.result(effect).pipe(
    Effect.flatMap(
      Result.match({
        onFailure: (failure) => Effect.succeed(codeOf(failure)),
        onSuccess: () => Effect.die(new Error('Expected a typed refusal, but the operation succeeded')),
      }),
    ),
  );

/** SQL validity windows use PostgreSQL's live clock rather than the test clock. */
const onLiveClock = <A, E, R>(effect: Effect.Effect<A, E, R>) => TestClock.withLive(effect);

it('publishes the real registration of each Action, never a fabricated declaration', () => {
  expect(createBrandAction.descriptor.accessDeclaration).toMatchObject({
    key: CAPABILITY_TEXT,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'brand', level: 'basic' },
    risk: 'routine',
    selectors: [],
  });
  expect(BRAND_ENTRY).toMatchObject({
    key: CAPABILITY_TEXT,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    moduleKey: CATALOG_MODULE,
    placement: { group: 'brand', level: 'basic' },
    risk: 'routine',
    selectors: [],
  });
  // The rejected candidate's Action is published as what it really is: a run-only admin declaration.
  expect(createNonHumanPrincipalAction.descriptor.accessDeclaration).toMatchObject({
    key: CORE_CAPABILITY_TEXT,
    kind: 'admin',
    modes: ['run'],
    selectors: [],
  });
  expect(CORE_ENTRY).toMatchObject({
    key: CORE_CAPABILITY_TEXT,
    kind: 'admin',
    modes: ['run'],
    moduleKey: CORE_MODULE,
    selectors: [],
  });
});

it.layer(NodeServices.layer)('access approvals owner runner over a real catalog Action', (suite) => {
  suite.effect('runs the real owner Action once and answers a committed retry with its receipt', () =>
    onLiveClock(
      Effect.gen(function* ownerRunsOnce() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);
        const { approved, proposed } = yield* proposeAndApprove(live, jana, eva);
        expect(approved.status).toBe('approved');
        const mandateId = yield* mandateIdOf(admin, proposed.id);
        expect(mandateId.length).toBeGreaterThan(0);

        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const runtime = makeRuntime(executor, crypto, dispatch);

        // The Action's own result: the real createBrand handler ran, not a scripted stand-in.
        const result = yield* runtime.runAction(mandateRequest(eva, mandateId));
        expect(result).toMatchObject({ brandRef: { resourceId: BRAND_ID }, revision: 1 });
        expect(yield* brandCount(admin)).toBe(1);
        expect(yield* proposalReceipt(admin, proposed.id)).toStrictEqual({
          executionOperationId: (yield* invocationReceipt(admin, mandateId))?.action_invocation_id ?? null,
          status: 'executed',
        });
        expect((yield* invocationReceipt(admin, mandateId))?.status).toBe('succeeded');
        expect(yield* frozenCommandCount(admin)).toBe(1);

        // The retry resolves the SAME deterministic invocation and reports its receipt, no second write.
        expect(yield* refusalOf(runtime.runAction(mandateRequest(eva, mandateId)))).toBe('action_already_committed');
        expect(yield* brandCount(admin)).toBe(1);
        expect((yield* proposalReceipt(admin, proposed.id))?.status).toBe('executed');
      }),
    ),
  );

  suite.effect('rolls the owner write and the claim back together when commit fails, then retries once', () =>
    onLiveClock(
      Effect.gen(function* ownerRollbackThenRetry() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);
        const { proposed } = yield* proposeAndApprove(live, jana, eva);
        const mandateId = yield* mandateIdOf(admin, proposed.id);

        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const failNextCommit = yield* Ref.make(true);
        const runtime = makeRuntime(executor, crypto, faultyCommitDispatch(dispatch, failNextCommit));

        // The fault lands after the handler's real Brand write and before the receipt CAS.
        expect(yield* refusalOf(runtime.runAction(mandateRequest(eva, mandateId)))).toBe(PERMISSION_CHECK_FAILED);
        expect(yield* Ref.get(failNextCommit)).toBe(false);
        // The owner write and the claim receipt went back together; the mandate was never consumed.
        expect(yield* brandCount(admin)).toBe(0);
        expect(yield* proposalReceipt(admin, proposed.id)).toStrictEqual({
          executionOperationId: null,
          status: 'approved',
        });
        expect((yield* invocationReceipt(admin, mandateId))?.status).toBe('received');

        // The same mandate is still approved and live, and the retry writes the owner exactly once.
        const result = yield* runtime.runAction(mandateRequest(eva, mandateId));
        expect(result).toMatchObject({ brandRef: { resourceId: BRAND_ID }, revision: 1 });
        expect(yield* brandCount(admin)).toBe(1);
        expect((yield* proposalReceipt(admin, proposed.id))?.status).toBe('executed');
        expect((yield* invocationReceipt(admin, mandateId))?.status).toBe('succeeded');
      }),
    ),
  );

  suite.effect('refuses a run-only declaration, foreign bindings and a closed fence before any owner write', () =>
    onLiveClock(
      Effect.gen(function* negativeBindings() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);

        // The published catalog refuses the run-only admin capability even though a propose cell was
        // seeded for it: a grant never widens a declaration (O43/O44).
        expect(yield* refusalOf(proposeRunOnlyCoreAction(live, jana))).toBe('capability_not_proposable');

        const { proposed } = yield* proposeAndApprove(live, jana, eva);
        const mandateId = yield* mandateIdOf(admin, proposed.id);

        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const runtime = makeRuntime(executor, crypto, dispatch);

        // The mandate binds the approving human; another person in the tenant cannot execute it (O63).
        expect(yield* refusalOf(runtime.runAction(mandateRequest(jana, mandateId)))).toBe('action_permission_denied');
        // A random locator matches no mandate: never an implicit grant.
        expect(yield* refusalOf(runtime.runAction(mandateRequest(eva, uid(999))))).toBe('action_permission_denied');
        // A mandate takes only its stored frozen command, never a request-supplied one.
        expect(yield* refusalOf(runtime.runAction(mandateRequest(eva, mandateId, { payload: PAYLOAD })))).toBe(
          'action_payload_invalid',
        );
        // A different Action's registration cannot consume this mandate's frozen command.
        expect(
          yield* refusalOf(
            runtime.runAction({
              payload: null,
              principal: eva,
              registration: changePrincipalStatusAction,
              transport: { correlationId: CORRELATION_ID, mandateId },
            }),
          ),
        ).toBe('action_permission_denied');
        expect(yield* brandCount(admin)).toBe(0);
        expect((yield* proposalReceipt(admin, proposed.id))?.status).toBe('approved');

        // Close the durable fence legally: an in-flight operation owns it; records are never deleted.
        yield* admin
          .unsafe(`insert into core.access_operation_journals
            (operation_id, tenant_id, scope_id, command_digest, phase, started_at, updated_at)
            values ('${uid(998)}', '${TENANT}', '${TENANT_SCOPE}', '${COMMAND_DIGEST}', 'fenced', now(), now())`)
          .pipe(Effect.orDie);
        yield* admin
          .unsafe(`update core.access_scope_fences
            set state = 'Changing', owning_operation_id = '${uid(998)}', revision = revision + 1
            where tenant_id = '${TENANT}' and scope_id = '${TENANT_SCOPE}'`)
          .pipe(Effect.orDie);
        expect(yield* refusalOf(runtime.runAction(mandateRequest(eva, mandateId)))).toBe(PERMISSION_CHECK_FAILED);
        expect(yield* brandCount(admin)).toBe(0);
        expect((yield* proposalReceipt(admin, proposed.id))?.status).toBe('approved');
      }),
    ),
  );

  /*
   * The REAL fence race, first direction. An admitted owner transaction (a real `createBrandAction`
   * mandate run) holds `lockActionAccessFence`'s shared row lock after its real `claim`. A concurrent
   * writer — this file's own SQL journal insert and fence `UPDATE`, explicitly a SQL-lock writer and
   * NOT the production AccessChanges/projection writer — tries to take the fence exclusive.
   * PostgreSQL blocks it, and the block is observed from `pg_blocking_pids`/`pg_stat_activity` for the
   * two known backend IDs. Only when the owner commits does the writer's valid Changing transition
   * land. This proves the row-lock ordering the production writer relies on; it does not run that
   * writer, the canonical gate or SpiceDB.
   */
  suite.effect('blocks an exclusive fence writer behind an admitted owner transaction holding the shared fence', () =>
    onLiveClock(
      Effect.gen(function* ownerHoldsFenceAgainstWriter() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);
        const { proposed } = yield* proposeAndApprove(live, jana, eva);
        const mandateId = yield* mandateIdOf(admin, proposed.id);
        const writerOperation = uid(997);

        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const ownerClaimed = yield* Deferred.make<number>();
        const writerStarted = yield* Deferred.make<number>();
        const releaseOwner = yield* Deferred.make<null>();
        // A failing assertion still frees the admitted owner, so the suite can never deadlock.
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseOwner, null));
        const runtime = makeRuntime(
          executor,
          crypto,
          mandateClaimPausingDispatch(dispatch, ownerClaimed, releaseOwner),
        );

        const owner = runtime.runAction(mandateRequest(eva, mandateId)).pipe(Effect.result);
        const writer = Effect.gen(function* exclusiveFenceWriter() {
          const ownerPid = yield* Deferred.await(ownerClaimed);
          yield* admin.withTransaction(
            Effect.gen(function* writerTransaction() {
              yield* admin.unsafe(
                `insert into core.access_operation_journals
                   (operation_id, tenant_id, scope_id, command_digest, phase, started_at, updated_at)
                   values ('${writerOperation}', '${TENANT}', '${TENANT_SCOPE}', '${COMMAND_DIGEST}',
                           'fenced', now(), now())`,
              );
              const [backend] = yield* admin.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
              yield* Deferred.succeed(writerStarted, backend?.pid ?? 0);
              // This UPDATE must wait for the owner's shared row lock rather than pass or fail fast.
              yield* admin.unsafe(
                `update core.access_scope_fences
                    set state = 'Changing', owning_operation_id = '${writerOperation}', revision = revision + 1
                  where tenant_id = '${TENANT}' and scope_id = '${TENANT_SCOPE}'`,
              );
            }),
          );
          return ownerPid;
        });
        const observer = Effect.gen(function* fenceContentionObserver() {
          const ownerPid = yield* Deferred.await(ownerClaimed);
          const writerPid = yield* Deferred.await(writerStarted);
          yield* awaitBlockedBy(admin, writerPid, ownerPid);
          const [observed] = yield* readBlocking(admin, writerPid);
          expect(observed?.blockerPids).toContain(ownerPid);
          expect(observed?.waitEventType).toBe('Lock');
          yield* Deferred.succeed(releaseOwner, null);
        }).pipe(Effect.timeout('20 seconds'), Effect.ensuring(Deferred.succeed(releaseOwner, null)));

        const [ownerOutcome] = yield* Effect.all([owner, writer, observer], { concurrency: 3 });

        expect(Result.isSuccess(ownerOutcome)).toBe(true);
        expect(Result.getOrThrow(ownerOutcome)).toMatchObject({ brandRef: { resourceId: BRAND_ID }, revision: 1 });
        // Exactly one owner write and its receipt committed, before the fence ever moved.
        expect(yield* brandCount(admin)).toBe(1);
        expect((yield* proposalReceipt(admin, proposed.id))?.status).toBe('executed');
        expect((yield* invocationReceipt(admin, mandateId))?.status).toBe('succeeded');
        expect(yield* fenceOf(admin)).toStrictEqual({
          owningOperationId: writerOperation,
          revision: 2,
          state: 'Changing',
        });
      }),
    ),
  );

  /*
   * The REAL fence race, second direction. A SQL-lock writer (this file's own journal insert and
   * fence `UPDATE`, explicitly not the production AccessChanges writer) closes the fence to Changing
   * and holds its exclusive row lock uncommitted. An overlapping real mandate runner must reach
   * `lockActionAccessFence`, block on the shared lock — observed with `pg_blocking_pids` for the two
   * known backend IDs — then, once the writer commits, refuse rather than execute on stale Ready
   * authority (including a serialization abort) with `action_permission_check_failed`. No
   * Brand exists, while the proposal stays approved.
   */
  suite.effect('refuses an overlapping runner once a committing fence writer holds the exclusive lock', () =>
    onLiveClock(
      Effect.gen(function* writerClosesFenceUnderRunner() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);
        const { proposed } = yield* proposeAndApprove(live, jana, eva);
        const mandateId = yield* mandateIdOf(admin, proposed.id);
        const writerOperation = uid(997);

        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const writerHolding = yield* Deferred.make<number>();
        const runnerAtFence = yield* Deferred.make<number>();
        const releaseWriter = yield* Deferred.make<null>();
        const stages = new Set<ActionRuntimeStage>();
        // A failing assertion still frees the writer, so the suite can never deadlock.
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseWriter, null));
        const runtime = makeRuntime(executor, crypto, dispatch, makeScriptedBoundAccessGate('allowed').bound, {
          lockAccessExecutionFence: fencePidLatchingLock(runnerAtFence),
          onStage: (stage) => {
            stages.add(stage);
          },
        });

        const writer = Effect.gen(function* exclusiveFenceWriter() {
          yield* admin.withTransaction(
            Effect.gen(function* writerTransaction() {
              yield* admin.unsafe(
                `insert into core.access_operation_journals
                   (operation_id, tenant_id, scope_id, command_digest, phase, started_at, updated_at)
                   values ('${writerOperation}', '${TENANT}', '${TENANT_SCOPE}', '${COMMAND_DIGEST}',
                           'fenced', now(), now())`,
              );
              const [backend] = yield* admin.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
              yield* admin.unsafe(
                `update core.access_scope_fences
                    set state = 'Changing', owning_operation_id = '${writerOperation}', revision = revision + 1
                  where tenant_id = '${TENANT}' and scope_id = '${TENANT_SCOPE}'`,
              );
              // The exclusive row lock is held now; only then may the overlapping runner start.
              yield* Deferred.succeed(writerHolding, backend?.pid ?? 0);
              yield* Deferred.await(releaseWriter);
            }),
          );
        });
        const runner = Deferred.await(writerHolding).pipe(
          Effect.andThen(runtime.runAction(mandateRequest(eva, mandateId)).pipe(Effect.result)),
        );
        const observer = Effect.gen(function* fenceContentionObserver() {
          const writerPid = yield* Deferred.await(writerHolding);
          const runnerPid = yield* Deferred.await(runnerAtFence);
          yield* awaitBlockedBy(admin, runnerPid, writerPid);
          const [observed] = yield* readBlocking(admin, runnerPid);
          expect(observed?.blockerPids).toContain(writerPid);
          expect(observed?.waitEventType).toBe('Lock');
          yield* Deferred.succeed(releaseWriter, null);
        }).pipe(Effect.timeout('20 seconds'), Effect.ensuring(Deferred.succeed(releaseWriter, null)));

        const [, runnerOutcome] = yield* Effect.all([writer, runner, observer], { concurrency: 3 });

        expect(Result.isFailure(runnerOutcome)).toBe(true);
        expect(Result.isFailure(runnerOutcome) ? codeOf(runnerOutcome.failure) : 'unexpected_success').toBe(
          PERMISSION_CHECK_FAILED,
        );
        // The runner never reached the owner handler, and no owner write exists.
        expect(stages.has('handler_executed')).toBe(false);
        expect(yield* brandCount(admin)).toBe(0);
        expect((yield* proposalReceipt(admin, proposed.id))?.status).toBe('approved');
        expect(yield* fenceOf(admin)).toStrictEqual({
          owningOperationId: writerOperation,
          revision: 2,
          state: 'Changing',
        });
      }),
    ),
  );

  /*
   * Action runtime proposal parking (O80, O85, O90) over the SAME real stores, release and joined
   * transactions as the owner proof above, with the real production `createBrandAction`. The one
   * controlled input is the access gate: it is SCRIPTED to answer NEEDS_APPROVAL with the requester
   * witness tied to the seeded assignment, grant incarnation, role revision and membership. That is
   * not the canonical gate, SpiceDB, a concurrency fence or a crash proof; it is the runner/store
   * protocol over a real Action once such an answer is given. The shipped `makeActionRuntimeLive`
   * still binds NO mandateDispatch, so product parking and execution stay OFF.
   */
  suite.effect('parks an explicitly proposed real catalog command and answers its retry with one receipt', () =>
    onLiveClock(
      Effect.gen(function* ownerParksProposal() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const runtime = makeRuntime(executor, crypto, dispatch, gateAnswering('NEEDS_APPROVAL', [requesterEvidence]));

        const first = yield* runtime.runAction(proposeRequest(jana, 'owner-runner-propose'));
        if (!Schema.is(ActionProposalAcceptedSchema)(first)) {
          throw new Error(PARKED_EXPECTED);
        }

        // Exactly one proposal, its frozen command and the invocation's terminal receipt, bound together.
        const parked = yield* parkedProposal(admin);
        expect(parked?.proposal_id).toBe(first.proposalId);
        expect(parked?.proposal_status).toBe('pending');
        expect(parked?.invocation_status).toBe('proposed');
        expect(parked?.capability_key).toBe(CAPABILITY_TEXT);
        expect(parked?.scope_id).toBe(TENANT_SCOPE);
        expect(parked?.requester_principal_id).toBe(JANA);
        // `createBrandAction` declares `selectors: []`, so the parked command is honestly targetless.
        expect(parked?.target).toBeNull();
        expect(yield* proposalCount(admin)).toBe(1);
        expect(yield* frozenCommandCount(admin)).toBe(1);
        expect(yield* frozenCommandOf(admin, first.proposalId)).toStrictEqual({
          action_key: ACTION_KEY,
          capability_key: CAPABILITY_TEXT,
          command_digest: COMMAND_DIGEST,
        });
        // A proposal is not an execution: the owner Brand is never written.
        expect(yield* brandCount(admin)).toBe(0);

        // The retry resolves the same deterministic invocation, answers its stored 202 and parks nothing new.
        const second = yield* runtime.runAction(proposeRequest(jana, 'owner-runner-propose'));
        if (!Schema.is(ActionProposalAcceptedSchema)(second)) {
          throw new Error(PARKED_EXPECTED);
        }
        expect(second.proposalId).toBe(first.proposalId);
        expect(DateTime.toEpochMillis(second.expiresAt)).toBe(DateTime.toEpochMillis(first.expiresAt));
        expect(yield* proposalCount(admin)).toBe(1);
        expect(yield* frozenCommandCount(admin)).toBe(1);
        expect(yield* brandCount(admin)).toBe(0);
      }),
    ),
  );

  suite.effect('refuses a changed payload on a retried proposal key and preserves the parked binding', () =>
    onLiveClock(
      Effect.gen(function* changedProposalRetry() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const runtime = makeRuntime(executor, crypto, dispatch, gateAnswering('NEEDS_APPROVAL', [requesterEvidence]));

        const first = yield* runtime.runAction(proposeRequest(jana, 'owner-runner-conflict'));
        if (!Schema.is(ActionProposalAcceptedSchema)(first)) {
          throw new Error(PARKED_EXPECTED);
        }

        const changedPayload = { ...PAYLOAD, name: 'Changed Mandate Proof Brand' };
        expect(
          yield* refusalOf(
            runtime.runAction(proposeRequest(jana, 'owner-runner-conflict', { payload: changedPayload })),
          ),
        ).toBe('action_request_hash_conflict');

        // The original proposal, frozen command and receipt are untouched; no second binding exists.
        expect(yield* proposalCount(admin)).toBe(1);
        expect(yield* frozenCommandCount(admin)).toBe(1);
        const parked = yield* parkedProposal(admin);
        expect(parked?.proposal_id).toBe(first.proposalId);
        expect(parked?.proposal_status).toBe('pending');
        expect(parked?.invocation_status).toBe('proposed');
        expect((yield* frozenCommandOf(admin, first.proposalId))?.command_digest).toBe(COMMAND_DIGEST);
        expect(yield* brandCount(admin)).toBe(0);
      }),
    ),
  );

  suite.effect('rolls the proposal, frozen command and receipt back when the real park fails, then retries once', () =>
    onLiveClock(
      Effect.gen(function* proposalRollbackThenRetry() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const failNextPark = yield* Ref.make(true);
        const parksReached = yield* Ref.make(0);
        const rollbackKey = 'owner-runner-rollback';
        const runtime = makeRuntime(
          executor,
          crypto,
          faultyParkDispatch(dispatch, failNextPark, parksReached),
          gateAnswering('NEEDS_APPROVAL', [requesterEvidence]),
        );

        // The fault lands after the real park wrote inside the owner transaction and before its commit.
        expect(yield* refusalOf(runtime.runAction(proposeRequest(jana, rollbackKey)))).toBe(PERMISSION_CHECK_FAILED);
        // The real seam was reached, so the absence of rows below is a rollback, not a pre-seam failure.
        expect(yield* Ref.get(parksReached)).toBe(1);
        expect(yield* proposalCount(admin)).toBe(0);
        expect(yield* frozenCommandCount(admin)).toBe(0);
        // The invocation was created before the owner transaction, so it stays 'received' and retryable.
        expect((yield* invocationStatusOf(admin, rollbackKey))?.status).toBe('received');
        expect(yield* brandCount(admin)).toBe(0);

        // The same idempotency key parks exactly once now that the transient fault is gone.
        const accepted = yield* runtime.runAction(proposeRequest(jana, rollbackKey));
        if (!Schema.is(ActionProposalAcceptedSchema)(accepted)) {
          throw new Error(PARKED_EXPECTED);
        }
        expect(yield* Ref.get(parksReached)).toBe(2);
        expect(yield* proposalCount(admin)).toBe(1);
        expect(yield* frozenCommandCount(admin)).toBe(1);
        const parked = yield* parkedProposal(admin);
        expect(parked?.invocation_status).toBe('proposed');
        expect(parked?.proposal_id).toBe(accepted.proposalId);
        expect(yield* brandCount(admin)).toBe(0);
      }),
    ),
  );

  suite.effect('refuses a NEEDS_APPROVAL request without an explicit propose intent and parks nothing', () =>
    onLiveClock(
      Effect.gen(function* approvalRequiredWithoutPropose() {
        const { admin, executor } = yield* disposableDatabase;
        const live = yield* liveApprovals(executor);
        const jana = yield* scopeFor(JANA);
        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const runtime = makeRuntime(executor, crypto, dispatch, gateAnswering('NEEDS_APPROVAL', [requesterEvidence]));

        // A normal request (no propose intent) still refuses: NEEDS_APPROVAL alone never parks (O80).
        expect(
          yield* refusalOf(
            runtime.runAction({
              payload: PAYLOAD,
              principal: jana,
              registration: createBrandAction,
              transport: { correlationId: CORRELATION_ID, idempotencyKey: 'owner-runner-normal' },
            }),
          ),
        ).toBe('action_approval_required');
        expect(yield* proposalCount(admin)).toBe(0);
        expect(yield* frozenCommandCount(admin)).toBe(0);
        expect(yield* brandCount(admin)).toBe(0);

        // A propose intent on a transport whose declared contract carries no 202 is refused first (O85).
        expect(
          yield* refusalOf(
            runtime.runAction({
              payload: PAYLOAD,
              principal: jana,
              registration: createBrandAction,
              transport: { correlationId: CORRELATION_ID, idempotencyKey: 'owner-runner-narrow', intent: 'propose' },
            }),
          ),
        ).toBe('action_permission_denied');
        expect(yield* proposalCount(admin)).toBe(0);
        expect(yield* frozenCommandCount(admin)).toBe(0);
      }),
    ),
  );
});
