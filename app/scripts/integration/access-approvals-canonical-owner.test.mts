import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { v1 } from '@authzed/authzed-node';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { buildAccessCatalogRelease } from '@app/core-runtime/access/catalog';
import {
  Array as EffectArray,
  Context,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Order,
  Result,
  Schema,
} from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  ActionApprovalLifecycleV2Ports,
  makeActionApprovalLifecycleV2,
} from '../../packages/core-runtime/src/access/approvals/action-lifecycle-v2.ts';
import type { ActionMandateDispatch } from '../../packages/core-runtime/src/access/approvals/action-mandate-dispatch.ts';
import {
  MandateDispatchPorts,
  makeDrizzleActionMandateDispatch,
} from '../../packages/core-runtime/src/access/approvals/action-mandate-dispatch.ts';
import {
  freezeActionCommandV2,
  resolveActionCommandV2,
} from '../../packages/core-runtime/src/access/approvals/action-command-v2.ts';
import {
  ApprovalStore,
  ApprovalStoreLive,
  makeJoinedDrizzleApprovalStore,
} from '../../packages/core-runtime/src/access/approvals/drizzle-store.ts';
import { makeDrizzleFrozenCommandStore } from '../../packages/core-runtime/src/access/approvals/frozen-command-drizzle-store.ts';
import type { FrozenCommandStore } from '../../packages/core-runtime/src/access/approvals/frozen-command.ts';
import { FrozenCommands } from '../../packages/core-runtime/src/access/approvals/frozen-command.ts';
import type { LiveApprovalServices } from '../../packages/core-runtime/src/access/approvals/live-composition.ts';
import { liveMandateDispatchPorts } from '../../packages/core-runtime/src/access/approvals/live-composition.ts';
import type { BoundWitness } from '../../packages/core-runtime/src/access/approvals/proposal.ts';
import type { RegisteredActionOwnerV2 } from '../../packages/core-runtime/src/access/approvals/registered-action-source-v2.ts';
import { liveApprovalsService } from '../../packages/core-runtime/src/access/approvals/service.ts';
import { makeAccessChangesDrizzleStore } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import type { GrantedAuthorityEvidence } from '../../packages/core-runtime/src/access/decision/contract.ts';
import { DecisionCheck } from '../../packages/core-runtime/src/access/decision/engine.ts';
import type { DecisionCheckPort } from '../../packages/core-runtime/src/access/decision/engine.ts';
import { makeSpiceDbDecisionCheckPort } from '../../packages/core-runtime/src/access/decision/spicedb-check-port.ts';
import type { AccessPrincipalKinds } from '../../packages/core-runtime/src/access/enforcement/actor.ts';
import {
  AccessPrincipalKindSource,
  AccessPrincipalKindSourceLive,
  makeDrizzleAccessPrincipalKinds,
} from '../../packages/core-runtime/src/access/enforcement/actor.ts';
import type { AccessDecisionService } from '../../packages/core-runtime/src/access/enforcement/contract.ts';
import { AccessDecisionGate } from '../../packages/core-runtime/src/access/enforcement/contract.ts';
import {
  AccessDecisionLog,
  AccessDecisionLogLive,
} from '../../packages/core-runtime/src/access/enforcement/decision-log.ts';
import { AccessIntent } from '../../packages/core-runtime/src/access/decision/authority.ts';
import { AccessIntentLive } from '../../packages/core-runtime/src/access/enforcement/intent-reader.ts';
import {
  LegalEntityCandidates,
  LegalEntityCandidatesLive,
} from '../../packages/core-runtime/src/access/enforcement/legal-entities.ts';
import { AccessDecisionLive } from '../../packages/core-runtime/src/access/enforcement/service.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
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
import { AccessProjectionCompiler } from '../../packages/core-runtime/src/access/intent/projection-compiler.ts';
import {
  AccessProjectionWriter,
  AccessProjectionWriterLive,
} from '../../packages/core-runtime/src/access/intent/projection-writer.ts';
import {
  TenantIntentLoader,
  makeJoinedTenantIntentLoader,
  makeTenantIntentLoader,
} from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import type { Cell, Holder } from '../../packages/core-runtime/src/access/model.ts';
import { CatalogSnapshotEntrySchema, CellSchema } from '../../packages/core-runtime/src/access/model.ts';
import { TrustedPrincipalContextSchema } from '../../packages/core-runtime/src/actions/principal-context.ts';
import { ActionProposalAcceptedSchema } from '../../packages/core-runtime/src/actions/proposal-accepted.ts';
import { makeActionRepository } from '../../packages/core-runtime/src/actions/repository.ts';
import type { ActionRuntimeService } from '../../packages/core-runtime/src/actions/runtime.ts';
import { makeActionRuntime } from '../../packages/core-runtime/src/actions/runtime.ts';
import type {
  AccessDeclaration,
  AccessDeclarationInput,
} from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { AccessDeclarationSchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import type { DatabaseConfigValue } from '../../packages/core-runtime/src/db/config.ts';
import { loadDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { coreRelations } from '../../packages/core-runtime/src/db/schema.ts';
import type { CoreTransaction } from '../../packages/core-runtime/src/db/types.ts';
import type {
  BoundAccessGate,
  AccessEnforcementPorts,
} from '../../packages/core-runtime/src/operations/access-gate.ts';
import { bindAccessGate } from '../../packages/core-runtime/src/operations/access-gate.ts';
import type { OperationalScope } from '../../packages/core-runtime/src/operations/context.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import {
  newSpiceDbGrpcClient,
  openSpiceDbGrpcRpc,
} from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { createTemplateDatabase } from '../../packages/core-runtime/tests/support/access-scenarios/database.ts';
import { openActionRuntimeOptions } from '../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { testOperationalScopeResolver } from '../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { createBrandAction } from '../../verticals/catalog/src/actions/create-brand.action.ts';
import { catalogRegistration } from '../../verticals/catalog/vertical.registration.ts';
import { publishActualCatalogOwnerComposition } from './support/actual-catalog-owner-composition.ts';

/*
 * The CANONICAL owner-mandate proof (O75, O80, O81, O85, O90). The preceding candidate proved the
 * runner/store protocol but kept the access gate SCRIPTED (`makeScriptedBoundAccessGate`) and handed
 * it hand-built `GrantedAuthorityEvidence`. This suite removes that scripted answer: every outcome it
 * asserts is produced by the shipped canonical gate over live intent and a real projection.
 *
 * What is REAL here:
 *
 * - the gate is `AccessDecisionLive` (the seam's own service) bound through `bindAccessGate` with the
 *   live ports: `AccessIntentLive` over `TenantIntentLoaderLive` (PostgreSQL), the Drizzle principal
 *   kinds, company candidates and decision log, and `makeSpiceDbDecisionCheckPort` over a real gRPC
 *   SpiceDB. No `makeScriptedBoundAccessGate`, no hardcoded `DecisionCheck`, no hand-built witness;
 * - the owner Action is production `createBrandAction` (`commerce.catalog`), and the published entry
 *   is built from its own registration by the one release builder `buildAccessCatalogRelease`;
 * - the SpiceDB graph is written by the production `AccessProjectionWriter` (`reconcileTenant`) over
 *   the intent rows this fixture seeded, so the ALLOWED/NEEDS_APPROVAL/DENIED answers rest on the
 *   same projection a real writer would have left behind;
 * - the proposal, frozen command, mandate and execution are the shipped approvals composition and
 *   `makeDrizzleActionMandateDispatch` over the real stores and the real `createBrand` handler. The
 *   mandate's own authority is the shipped `makeActionApprovalLifecycleV2`, built over this same
 *   canonical seam and ports, so parking, approving and executing run the native current lifecycle
 *   rather than a scalar shortcut;
 * - the `owners` that lifecycle admits registrations through are the ACTUAL Catalog owner release:
 *   `deriveActualCatalogCompositionSnapshot`'s SOURCE projection of the shipped `catalogRegistration`
 *   is published as this disposable database's active Application Composition, so the lifecycle's
 *   composition-authority lock fences the very revision the runner admitted.
 *
 * What is deliberately NOT claimed:
 *
 * - `createBrandAction` declares `selectors: []`, so the command is honestly TARGETLESS. No governing
 *   read or transaction-bound record projection exists, so no record-scoped claim is made.
 * - The gate's intent reads run through `requestTransactions` (its own REPEATABLE READ snapshot on the
 *   pool), while a mandate claim and the parked proposal re-read witnesses through
 *   `callerTransactions(owner)` under the shared fence. This suite does NOT establish that the
 *   separate snapshot is safe against every production writer, nor assert transaction pinning;
 *   both require separate evidence.
 * - The fixture grants broad CRUD privileges on Core and Catalog tables to its non-superuser runtime
 *   role, so it does not prove production least-privilege grants.
 * - The product still binds NO `mandateDispatch` in `makeActionRuntimeLive`, so product execution
 *   stays OFF; this suite binds the adapter explicitly for the proof.
 *
 * The suite lives outside `packages/core-runtime` because it runs a real vertical Action: Core must
 * not gain a vertical dependency for its own proof.
 */

/**
 * A distinct id space of this suite's own. The suite WRITES SpiceDB tuples, so it must not share a
 * tenant, scope, role or grant object with another suite running against the same engine.
 */
const uid = (value: number) => `00000000-0000-4a11-9a00-${value.toString().padStart(12, '0')}`;
/** The one correlation id every request in this suite carries. */
const CORRELATION_ID = 'canonical-owner';
const TENANT = TenantIdSchema.make(uid(1));
const TENANT_SCOPE = AccessScopeIdSchema.make(uid(2));
const JANA = PrincipalIdSchema.make(uid(3));
const EVA = PrincipalIdSchema.make(uid(4));
/** A member of the tenant who holds NO role cell: the "no matching authority" control. */
const MIREK = PrincipalIdSchema.make(uid(14));
/** A declared human with NO membership: the "missing membership" control. */
const NINA = PrincipalIdSchema.make(uid(15));
const BRAND_ID = uid(5);
const REQUESTER_ROLE = RoleIdSchema.make(uid(6));
const REQUESTER_REVISION = RoleRevisionIdSchema.make(uid(7));
const JANA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(8));
const APPROVER_ROLE = RoleIdSchema.make(uid(12));
const APPROVER_REVISION = RoleRevisionIdSchema.make(uid(13));
const EVA_ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(9));
const JANA_MEMBERSHIP = uid(10);
const EVA_MEMBERSHIP = uid(11);
const MIREK_MEMBERSHIP = uid(16);

const CAPABILITY_TEXT = 'commerce.catalog.brand.create';
const CATALOG_MODULE = 'commerce.catalog';
const BRAND_RESOURCE_TYPE = 'commerce.catalog.brand';

const CAPABILITY = CapabilityKeySchema.make(CAPABILITY_TEXT);

const PAYLOAD = {
  brandRef: {
    moduleId: CATALOG_MODULE,
    resourceId: BRAND_ID,
    resourceType: BRAND_RESOURCE_TYPE,
    tenantId: TENANT,
  },
  evidenceRefs: ['evidence:canonical-owner'],
  name: 'Canonical Proof Brand',
  reason: 'Proves the canonical gate over live intent and a real SpiceDB projection',
} as const;

const GRANTS = {
  approve: GrantIncarnationIdSchema.make(uid(20)),
  propose: GrantIncarnationIdSchema.make(uid(21)),
  run: GrantIncarnationIdSchema.make(uid(22)),
} as const;

/**
 * Two roles, never one: the requester holds ONLY `propose`, the approver holds `approve` and `run`.
 * Seeding one shared role would give the requester a `run` cell and the canonical gate would answer
 * ALLOWED where this suite needs NEEDS_APPROVAL — exactly the fabrication this proof exists to avoid.
 */
const REQUESTER_CELLS = [{ capabilityKey: CAPABILITY, grant: GRANTS.propose, mode: 'propose' }] as const;
const APPROVER_CELLS = [
  { capabilityKey: CAPABILITY, grant: GRANTS.approve, mode: 'approve' },
  { capabilityKey: CAPABILITY, grant: GRANTS.run, mode: 'run' },
] as const;
const ALL_CELLS = [...REQUESTER_CELLS, ...APPROVER_CELLS] as const;

const cellOf = (cell: (typeof ALL_CELLS)[number]): Cell => ({
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
 * The real published release of the one registration this proof reads: production `createBrandAction`.
 * The one production builder derives every entry, digest and identifier from that declaration.
 */
const RELEASE = Result.getOrThrow(
  buildAccessCatalogRelease({
    installedModuleKeys: [ModuleKeySchema.make(CATALOG_MODULE)],
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
    ],
    publishedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00.000Z')),
  }),
);
const BRAND_ENTRY = RELEASE.entries.find((entry) => entry.key === CAPABILITY);

const NO_ENVIRONMENT_FILE = `${import.meta.filename}.no-environment-file`;

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
 * The tenant intent the canonical gate and the projection writer read: one tenant-context scope, the
 * real published release, two roles whose cells match the real declaration modes (never widened), the
 * assignments that hold them, the grant incarnations that witness them and the memberships that make
 * the scope resolvable. Mirek is a member with no assignment; Nina is declared but not a member.
 */
const seedAccess = (admin: PgClient.PgClient) =>
  Effect.gen(function* seedAccessEffect() {
    const statements = [
      `insert into core.tenants (tenant_id, slug, name, status, default_locale)
         values ('${TENANT}', 'canonical-owner', 'Canonical Owner', 'active', 'cs')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${TENANT}', '${JANA}', 'human', 'Jana', 'active'),
         ('${TENANT}', '${EVA}', 'human', 'Eva', 'active'),
         ('${TENANT}', '${MIREK}', 'human', 'Mirek', 'active'),
         ('${TENANT}', '${NINA}', 'human', 'Nina', 'active')`,
      ...[JANA, EVA, MIREK, NINA].map(
        (principalId) =>
          `insert into core.principal_auth_bindings
             (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type,
              provider_subject_id, authentication_namespace_id, status)
             values ('${principalId}', '${TENANT}', '${principalId}', 'better_auth', 'user',
                     '${principalId}', 'access-canonical-owner.session.v1', 'active')`,
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
         values ('${REQUESTER_ROLE}', '${TENANT}', '${JANA}', 'Žadatel', null),
                ('${APPROVER_ROLE}', '${TENANT}', '${EVA}', 'Schvalovatel', null)`,
      `insert into core.access_role_revisions
         (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
         values ('${REQUESTER_REVISION}', '${TENANT}', '${REQUESTER_ROLE}', 1, '${RELEASE.id}',
                 '${cellsJson(REQUESTER_CELLS.map(cellOf))}'::jsonb, '${JANA}', 'manual'),
                ('${APPROVER_REVISION}', '${TENANT}', '${APPROVER_ROLE}', 1, '${RELEASE.id}',
                 '${cellsJson(APPROVER_CELLS.map(cellOf))}'::jsonb, '${EVA}', 'manual')`,
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status,
          valid_from, valid_until)
         values
         ('${JANA_ASSIGNMENT}', '${TENANT}', '${TENANT_SCOPE}', '${REQUESTER_ROLE}', '${REQUESTER_REVISION}',
          '${JANA}', '${EVA}', 'active', now() - interval '1 day', null),
         ('${EVA_ASSIGNMENT}', '${TENANT}', '${TENANT_SCOPE}', '${APPROVER_ROLE}', '${APPROVER_REVISION}',
          '${EVA}', '${EVA}', 'active', now() - interval '1 day', null)`,
      ...ALL_CELLS.map(
        (cell) =>
          `insert into core.access_grant_incarnations
             (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
             values ('${cell.grant}', '${TENANT}', '${TENANT_SCOPE}',
                     '${cell.mode === 'propose' ? REQUESTER_ROLE : APPROVER_ROLE}', '${cell.capabilityKey}',
                     '${cell.mode}', 'all', '${cellJson(cellOf(cell))}'::jsonb, 'active')`,
      ),
      `insert into core.tenant_module_states (tenant_id, module_key, state) values
         ('${TENANT}', '${CATALOG_MODULE}', 'active')`,
      membership({ id: JANA_MEMBERSHIP, principalId: JANA, status: 'active' }),
      membership({ id: EVA_MEMBERSHIP, principalId: EVA, status: 'active' }),
      membership({ id: MIREK_MEMBERSHIP, principalId: MIREK, status: 'active' }),
    ];
    yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie, Effect.asVoid), {
      concurrency: 1,
      discard: true,
    });
  });

const disposableDatabase = Effect.gen(function* disposableDatabaseEffect() {
  // This disposable-database suite uses explicit process configuration, never the workspace .env.
  const connections = yield* loadDatabaseConnectionPair({ envPath: NO_ENVIRONMENT_FILE });
  const crypto = yield* Crypto.Crypto;
  const bootstrap = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  const name = `access_canonical_owner_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
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
   * The composition reads on several connections at once: the gate's own intent transactions, the
   * projection writer's reads and the adapter's mandate/scope reads.
   */
  const runtime = yield* makeTestPgClient(replaceDatabase(connections.runtime, name), { maxConnections: 8 });
  const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  // Publishing an Application Composition is administrative: the runtime role holds SELECT only.
  const adminExecutor = yield* makeTestDatabaseFromClient(admin, coreRelations);
  return { admin, adminExecutor, executor };
});

type LiveDatabase = Effect.Success<typeof disposableDatabase>['executor'];

const scopeFor = (principalId: PrincipalId): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: principalId,
    authContextRef: `session:access-canonical-owner:${principalId}`,
    authenticationNamespaceId: 'access-canonical-owner.session.v1',
    authMethod: 'session',
    principalId,
    tenantId: TENANT,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-canonical-owner' })),
    Effect.orDie,
  );

/** The two stores the mandate ports add on top of the approvals sources. */
interface LiveMandateStores {
  readonly frozenCommands: FrozenCommandStore;
  readonly principalKinds: AccessPrincipalKinds;
}

/**
 * The live approvals composition over the shipped stores: `requestTransactions` for the ordinary
 * reads and `callerTransactions(owner)` for the transaction-bound claim. Nothing is scripted.
 */
const liveApprovals = Effect.fn('CanonicalOwnerFixture.liveApprovals')(function* liveApprovalsEffect(
  executor: LiveDatabase,
) {
  const crypto = yield* Crypto.Crypto;
  const frozenCommands = makeDrizzleFrozenCommandStore({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor });
  const changes = makeAccessChangesDrizzleStore({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor });
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
    intent: makeJoinedTenantIntentLoader(transaction, APP_DATABASE_IDENTITY_ENROLLMENT),
    join: joinedServices,
    loadRelease: () => changes.loadPublishedCatalog(transaction),
    records: makeJoinedDrizzleApprovalStore(
      { enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, frozenCommands, transaction },
      crypto,
    ),
    transactions: callerTransactions(transaction, APP_DATABASE_IDENTITY_ENROLLMENT),
  });
  const services: LiveApprovalServices = {
    crypto,
    intent: makeTenantIntentLoader({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor }),
    join: joinedServices,
    loadRelease: () => changes.loadPublishedCatalog(),
    records,
    transactions: requestTransactions({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor }),
  };
  return {
    ...services,
    frozenCommands,
    principalKinds: makeDrizzleAccessPrincipalKinds({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor }),
  } satisfies LiveApprovalServices & LiveMandateStores;
});

const approvalsFor = (live: LiveApprovalServices, scope: OperationalScope) => liveApprovalsService(live, scope);

/**
 * The native Action approval lifecycle over the SAME real gate, stores and owner release as the
 * runner. `makeActionApprovalLifecycleV2` is the shipped constructor: its `owners` are the actual
 * Catalog owner release published for this disposable database, so ordinary module-operation
 * admission admits the real `createBrandAction` and the lifecycle's own composition-authority lock
 * fences the same revision the runner admitted. The result adds `actionCommands`, which both the
 * approvals service and the mandate adapter refuse to work without.
 */
const nativeApprovalServices = (input: {
  readonly enforcement: AccessEnforcementPorts;
  readonly executor: LiveDatabase;
  readonly live: LiveApprovalServices & LiveMandateStores;
  readonly owners: readonly RegisteredActionOwnerV2[];
  readonly seam: AccessDecisionService;
}) =>
  makeActionApprovalLifecycleV2().pipe(
    Effect.provideService(ActionApprovalLifecycleV2Ports, {
      database: { enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor: input.executor },
      enforcement: input.enforcement,
      frozenCommands: input.live.frozenCommands,
      live: input.live,
      owners: input.owners,
    }),
    Effect.provideService(AccessDecisionGate, input.seam),
    Effect.map((actionCommands) => ({ ...input.live, actionCommands })),
  );

const mandateDispatchFor = (live: LiveApprovalServices & LiveMandateStores, executor: LiveDatabase) =>
  makeDrizzleActionMandateDispatch().pipe(
    Effect.provideService(
      MandateDispatchPorts,
      liveMandateDispatchPorts({
        actionCommands: live.actionCommands,
        approvalsFor: (scope) => approvalsFor(live, scope),
        database: { executor },
        enrollment: APP_DATABASE_IDENTITY_ENROLLMENT,
        frozenCommands: live.frozenCommands,
        principalKinds: live.principalKinds,
      }),
    ),
  );

const makeRuntime = (
  executor: LiveDatabase,
  crypto: Crypto.Crypto,
  dispatch: ActionMandateDispatch,
  accessDecision: BoundAccessGate,
  owner: RegisteredActionOwnerV2,
): ActionRuntimeService =>
  makeActionRuntime(
    { executor },
    makeActionRepository(crypto),
    // The legacy Action permission check; the v2 decision is the canonical gate below.
    { checkActionPermission: () => Effect.succeed('allowed' as const) },
    testOperationalScopeResolver,
    {
      accessDecision,
      applicationComposition: owner.applicationComposition,
      databaseIdentities: APP_DATABASE_IDENTITY_ENROLLMENT,
      expectedDeployment: owner.expectedDeployment,
      mandateDispatch: dispatch,
      moduleEntrypointGateway: openActionRuntimeOptions.moduleEntrypointGateway,
      moduleStateGate: openActionRuntimeOptions.moduleStateGate,
      // Module-operation admission refuses a non-Core Action whose owner registration is unbound.
      ownerRegistration: catalogRegistration,
    },
  );

/**
 * The canonical gate: `AccessDecisionLive` over the live ports this composition really binds. The one
 * injected port is the engine check itself — a real `makeSpiceDbDecisionCheckPort` over a real gRPC
 * SpiceDB, never a hardcoded `DecisionCheck`. `bindAccessGate` (not `bindLiveAccessGate`) is used so
 * the check port stays this suite's real transport instead of `DecisionCheckLive`'s ambient config.
 *
 * The raw seam and its five enforcement ports are returned beside the bound gate: the native Action
 * approval lifecycle binds the SAME seam with the SAME ports, so the mandate's authority is the one
 * canonical gate. Nothing unwraps the bound gate; the composition keeps the ports it really built.
 */
const canonicalGate = (executor: LiveDatabase, checkPort: DecisionCheckPort) =>
  Effect.gen(function* canonicalGateEffect() {
    const core = Layer.succeed(CoreDatabase, { executor });
    const loader = Layer.succeed(
      TenantIntentLoader,
      makeTenantIntentLoader({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor }),
    );
    const ports = Layer.mergeAll(
      AccessIntentLive,
      AccessDecisionLogLive,
      AccessPrincipalKindSourceLive,
      LegalEntityCandidatesLive,
      Layer.succeed(DecisionCheck, checkPort),
    ).pipe(Layer.provide(Layer.mergeAll(core, loader, NodeServices.layer)));
    const gateLayer = AccessDecisionLive.pipe(Layer.provide(ports));
    const built = yield* Layer.build(Layer.mergeAll(gateLayer, ports));
    const portsOfComposition: AccessEnforcementPorts = {
      candidates: Context.get(built, LegalEntityCandidates),
      check: Context.get(built, DecisionCheck),
      decisionLog: Context.get(built, AccessDecisionLog),
      intent: Context.get(built, AccessIntent),
      principalKinds: Context.get(built, AccessPrincipalKindSource),
    };
    const seam = Context.get(built, AccessDecisionGate);
    return { bound: bindAccessGate(seam, portsOfComposition), ports: portsOfComposition, seam };
  });

/** The production projection writer over the seeded intent: the graph the canonical gate checks. */
const projectionWriter = (executor: LiveDatabase, compiler: ReturnType<typeof makeAccessProjectionCompiler>) =>
  Effect.gen(function* projectionWriterEffect() {
    const core = Layer.succeed(CoreDatabase, { executor });
    const compilerLayer = Layer.succeed(AccessProjectionCompiler, compiler);
    const platforms = Layer.mergeAll(core, compilerLayer, NodeServices.layer);
    const loader = Layer.succeed(
      TenantIntentLoader,
      makeTenantIntentLoader({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor }),
    );
    const journal = AccessWriteJournalStoreLive.pipe(Layer.provide(platforms));
    const writerLayer = AccessProjectionWriterLive.pipe(Layer.provide(Layer.mergeAll(platforms, loader, journal)));
    const built = yield* Layer.build(writerLayer);
    return Context.get(built, AccessProjectionWriter);
  });

/**
 * One disposable database, its intent projected into a real SpiceDB by the production writer, and the
 * canonical gate over that same intent and graph. Each test gets its own database; sequential tests
 * re-project the suite's fixed SpiceDB namespace. The parent owns the fresh engine and removes it
 * after the suite, including its projected tuples. Do not run these fixtures concurrently.
 */
const withCanonical = Effect.gen(function* canonicalScenario() {
  const { admin, adminExecutor, executor } = yield* disposableDatabase;
  const spiceConfig = yield* loadSpiceDbConfig({ envPath: NO_ENVIRONMENT_FILE });
  // The suite owns the engine's schema, so it starts from exactly the v2 definitions Core serves.
  yield* Effect.acquireUseRelease(
    Effect.sync(() => newSpiceDbGrpcClient(spiceConfig)),
    (client) =>
      Effect.tryPromise(() =>
        client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      ).pipe(Effect.orDie),
    (client) => Effect.sync(() => client.close()),
  );
  const rpc = yield* Effect.acquireRelease(
    Effect.sync(() => openSpiceDbGrpcRpc(spiceConfig, 5000)),
    (current) => Effect.sync(() => current.close()),
  );
  const transport = yield* Effect.acquireRelease(
    Effect.sync(() => makeAccessProjectionTransport(spiceConfig)),
    (current) => Effect.sync(() => current.close()),
  );
  const writer = yield* projectionWriter(executor, makeAccessProjectionCompiler(transport));
  const projectionScope = yield* scopeFor(JANA);
  const report = yield* writer.reconcileTenant({ scope: projectionScope });
  // The graph the gate reads is the production writer's, verified against intent.
  expect(report.verified).toBe(true);
  expect(report.units.length).toBeGreaterThan(0);
  const { bound: gate, ports, seam } = yield* canonicalGate(executor, makeSpiceDbDecisionCheckPort(rpc));
  return { admin, adminExecutor, executor, gate, ports, seam, spiceConfig };
});

/** The real declaration carrier of the production Action, asked the way an entrypoint asks it. */
const CARRIER = { accessDeclaration: createBrandAction.descriptor.accessDeclaration };

const decide = (gate: BoundAccessGate, principal: PrincipalId, mode: 'approve' | 'run') =>
  Effect.gen(function* oneDecision() {
    const scope = yield* scopeFor(principal);
    return yield* gate.decide({
      carrier: CARRIER,
      legalEntityScope: 'forbidden',
      mode,
      now: yield* DateTime.nowAsDate,
      scope,
    });
  });

/** The bound witness a gate evidence row names, in the shape the approvals service takes. */
const boundOf = (evidence: GrantedAuthorityEvidence): BoundWitness => ({
  assignmentIncarnationId: evidence.witness.assignmentIncarnationId,
  capabilityKey: evidence.witness.capabilityKey,
  grantIncarnationId: evidence.witness.grantIncarnationId,
  holderId: evidence.witness.holderId,
  scopeId: evidence.witness.scopeId,
});

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

const proposalCount = (admin: PgClient.PgClient) =>
  admin
    .unsafe<{ readonly count: string }>(
      `select count(*)::text as count from core.access_proposals where tenant_id = '${TENANT}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Number(rows[0]?.count ?? '0')),
    );

/** The parked proposal and the invocation receipt bound to it, read as one fact (O90.3). */
const parkedProposal = (admin: PgClient.PgClient) =>
  admin
    .unsafe<{
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
              p.scope_id, p.target, p.requester_principal_id, i.status as invocation_status
         from core.access_proposals p
         join core.action_invocations i
           on i.tenant_id = p.tenant_id and i.action_invocation_id = p.action_invocation_id
        where p.tenant_id = '${TENANT}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    );

const mandateRequest = (principal: OperationalScope, mandateId: string) => ({
  payload: null,
  principal,
  registration: createBrandAction,
  transport: { correlationId: CORRELATION_ID, mandateId },
});

/**
 * The one propose request shape this suite sends: the real catalog Action, the endpoint's declared
 * `result-or-proposal` success contract (the only contract whose success union carries the 202), and
 * an explicit `propose` intent.
 */
const proposeRequest = (principal: OperationalScope, idempotencyKey: string) => ({
  payload: PAYLOAD,
  principal,
  registration: createBrandAction,
  successContract: 'result-or-proposal' as const,
  transport: { correlationId: CORRELATION_ID, idempotencyKey, intent: 'propose' as const },
});

it('publishes the real registration, never a fabricated declaration', () => {
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
    selectors: [],
  });
});

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT),
  ),
)('access approvals canonical owner over live intent and SpiceDB', (suite) => {
  /*
   * The canonical gate itself, with no runtime around it: every outcome below comes from
   * `AccessDecisionLive` over PostgreSQL intent and the SpiceDB graph the production writer projected.
   */
  suite.effect('answers ALLOWED, NEEDS_APPROVAL and DENIED from live intent and a real projection', () =>
    onLiveClock(
      Effect.gen(function* canonicalOutcomes() {
        const { gate } = yield* withCanonical;
        // The requester holds ONLY `propose`: the run question resolves no cell, the propose
        // question resolves exactly one, and the gate answers NEEDS_APPROVAL with that witness.
        const requester = yield* decide(gate, JANA, 'run');
        expect(requester.outcome).toBe('NEEDS_APPROVAL');
        expect(requester.reasons.map(({ code }) => code)).toContain('approval.required');
        expect(requester.evidence).toHaveLength(1);
        expect(requester.evidence[0]?.witness).toMatchObject({
          assignmentIncarnationId: JANA_ASSIGNMENT,
          capabilityKey: CAPABILITY,
          grantIncarnationId: GRANTS.propose,
          holderId: holder(JANA),
          mode: 'propose',
          scopeId: TENANT_SCOPE,
        });

        // The approver holds `run` and `approve`: the same gate allows the run and the approval.
        const approverRun = yield* decide(gate, EVA, 'run');
        expect(approverRun.outcome).toBe('ALLOWED');
        expect(approverRun.evidence.map(({ witness }) => witness.grantIncarnationId)).toEqual([GRANTS.run]);
        const approverApprove = yield* decide(gate, EVA, 'approve');
        expect(approverApprove.outcome).toBe('ALLOWED');
        expect(approverApprove.evidence.map(({ witness }) => witness.grantIncarnationId)).toEqual([GRANTS.approve]);

        // A member with no cell at all: the gate refuses, and never invents a grant.
        const unauthorized = yield* decide(gate, MIREK, 'run');
        expect(unauthorized.outcome).toBe('DENIED');
        expect(unauthorized.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');

        // A declared human who is not a member of the scope: fail closed, never an implicit allow.
        const unmembered = yield* decide(gate, NINA, 'run');
        expect(unmembered.outcome).toBe('DENIED');
        expect(unmembered.reasons.map(({ code }) => code)).toContain('deny.scope_mismatch');
      }),
    ),
  );

  /*
   * The projection is load-bearing: with the SAME live intent but a real check transport the engine
   * refuses (a real `makeSpiceDbDecisionCheckPort` over the same engine with a wrong pre-shared key),
   * every decision fails closed as UNAVAILABLE rather than falling back to intent alone.
   */
  suite.effect('fails closed as UNAVAILABLE when the real projection engine cannot answer', () =>
    onLiveClock(
      Effect.gen(function* projectionUnavailable() {
        const { executor, spiceConfig } = yield* withCanonical;
        const refusedRpc = yield* Effect.acquireRelease(
          Effect.sync(() => openSpiceDbGrpcRpc({ ...spiceConfig, preSharedKey: 'canonical-owner-invalid-key' }, 2000)),
          (current) => Effect.sync(() => current.close()),
        );
        const { bound: unavailableGate } = yield* canonicalGate(executor, makeSpiceDbDecisionCheckPort(refusedRpc));
        const decision = yield* decide(unavailableGate, EVA, 'run');
        expect(decision.outcome).toBe('UNAVAILABLE');
        expect(decision.evidence).toEqual([]);
      }),
    ),
  );

  /*
   * The owner-mandate path end to end with the canonical gate: the requester's own propose authority
   * parks the command (and writes no owner row), the approver's own approve+run authority — taken from
   * the gate, not hand-built — approves and executes it exactly once, and a member with no matching
   * authority is refused before anything is parked.
   */
  suite.effect('parks on the canonical NEEDS_APPROVAL, then approves and executes exactly once', () =>
    onLiveClock(
      Effect.gen(function* canonicalParkApproveExecute() {
        const { admin, adminExecutor, executor, gate, ports, seam } = yield* withCanonical;
        const { owner, owners } = yield* publishActualCatalogOwnerComposition(adminExecutor);
        const base = yield* liveApprovals(executor);
        const live = yield* nativeApprovalServices({ enforcement: ports, executor, live: base, owners, seam });
        const jana = yield* scopeFor(JANA);
        const eva = yield* scopeFor(EVA);
        const mirek = yield* scopeFor(MIREK);
        const crypto = yield* Crypto.Crypto;
        const dispatch = yield* mandateDispatchFor(live, executor);
        const runtime = makeRuntime(executor, crypto, dispatch, gate, owner);
        const expectedCommand = yield* resolveActionCommandV2({
          payload: PAYLOAD,
          registration: createBrandAction,
          scope: jana,
        });
        const expectedDigest = Result.getOrThrow(freezeActionCommandV2(expectedCommand));

        // No matching authority is refused by the canonical gate before any proposal exists.
        expect(yield* refusalOf(runtime.runAction(proposeRequest(mirek, 'canonical-mirek')))).toBe(
          'action_permission_denied',
        );
        expect(yield* proposalCount(admin)).toBe(0);
        expect(yield* brandCount(admin)).toBe(0);

        // The canonical NEEDS_APPROVAL parks the real command: proposal, frozen command and the
        // invocation's terminal `proposed` receipt commit together, and no owner row is written.
        const parked = yield* runtime.runAction(proposeRequest(jana, 'canonical-propose'));
        if (!Schema.is(ActionProposalAcceptedSchema)(parked)) {
          throw new Error('Expected the canonical parked-proposal 202');
        }
        const receipt = yield* parkedProposal(admin);
        expect(receipt?.proposal_id).toBe(parked.proposalId);
        expect(receipt?.proposal_status).toBe('pending');
        expect(receipt?.invocation_status).toBe('proposed');
        expect(receipt?.capability_key).toBe(CAPABILITY_TEXT);
        expect(receipt?.scope_id).toBe(TENANT_SCOPE);
        expect(receipt?.requester_principal_id).toBe(JANA);
        expect(receipt?.command_digest).toBe(expectedDigest);
        // `createBrandAction` declares `selectors: []`, so the parked command is honestly targetless.
        expect(receipt?.target).toBeNull();
        expect(yield* proposalCount(admin)).toBe(1);
        expect(yield* brandCount(admin)).toBe(0);

        // The approver's authority is the gate's own answer, never a hand-built witness.
        const approverRun = yield* decide(gate, EVA, 'run');
        const approverApprove = yield* decide(gate, EVA, 'approve');
        expect(approverRun.outcome).toBe('ALLOWED');
        expect(approverApprove.outcome).toBe('ALLOWED');
        const [executionEvidence] = approverRun.evidence;
        const [approvalEvidence] = approverApprove.evidence;
        if (executionEvidence === undefined || approvalEvidence === undefined) {
          throw new Error('Expected one evidence row from each approver decision');
        }
        const executionWitness = boundOf(executionEvidence);
        const approvalWitness = boundOf(approvalEvidence);
        expect(executionWitness).toStrictEqual(
          boundWitness({
            assignmentIncarnationId: EVA_ASSIGNMENT,
            capabilityKey: CAPABILITY,
            grantIncarnationId: GRANTS.run,
            holderId: holder(EVA),
          }),
        );
        expect(approvalWitness).toStrictEqual(
          boundWitness({
            assignmentIncarnationId: EVA_ASSIGNMENT,
            capabilityKey: CAPABILITY,
            grantIncarnationId: GRANTS.approve,
            holderId: holder(EVA),
          }),
        );

        const approved = yield* approvalsFor(live, eva).approve({
          approver: { _tag: 'Principal', principalId: EVA },
          approverKind: 'human',
          authority: { approval: approvalWitness, execution: executionWitness, parentRecordRead: [] },
          policy: { selfApproval: 'forbidden' },
          proposalId: parked.proposalId,
          scopeId: TENANT_SCOPE,
          tenantId: TENANT,
        });
        expect(approved.status).toBe('approved');
        expect(yield* brandCount(admin)).toBe(0);

        // The approved mandate executes the real owner handler exactly once.
        const mandateId = yield* mandateIdOf(admin, parked.proposalId);
        expect(mandateId.length).toBeGreaterThan(0);
        const result = yield* runtime.runAction(mandateRequest(eva, mandateId));
        expect(result).toMatchObject({ brandRef: { resourceId: BRAND_ID }, revision: 1 });
        expect(yield* brandCount(admin)).toBe(1);
        expect(yield* proposalReceipt(admin, parked.proposalId)).toStrictEqual({
          executionOperationId: (yield* invocationReceipt(admin, mandateId))?.action_invocation_id ?? null,
          status: 'executed',
        });
        expect((yield* invocationReceipt(admin, mandateId))?.status).toBe('succeeded');

        // A committed retry answers the receipt instead of writing the owner a second time.
        expect(yield* refusalOf(runtime.runAction(mandateRequest(eva, mandateId)))).toBe('action_already_committed');
        expect(yield* brandCount(admin)).toBe(1);
      }),
    ),
  );

  /*
   * A revoked membership is intent, not projection: the canonical gate refuses even though the graph
   * the production writer left behind still carries the requester's grant tuple.
   */
  suite.effect('fails closed once the requester membership is revoked, without re-projecting', () =>
    onLiveClock(
      Effect.gen(function* revokedMembership() {
        const { admin, gate } = yield* withCanonical;
        expect((yield* decide(gate, JANA, 'run')).outcome).toBe('NEEDS_APPROVAL');
        yield* admin
          .unsafe(`update core.access_memberships set status = 'revoked' where membership_id = '${JANA_MEMBERSHIP}'`)
          .pipe(Effect.orDie);
        const afterRevocation = yield* decide(gate, JANA, 'run');
        expect(afterRevocation.outcome).toBe('DENIED');
        expect(afterRevocation.reasons.map(({ code }) => code)).toContain('deny.scope_mismatch');
      }),
    ),
  );
});
