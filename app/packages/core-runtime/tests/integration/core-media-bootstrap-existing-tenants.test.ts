import { v1 } from '@authzed/authzed-node';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';
import { expect, it } from 'effect-rstest';

import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { TenantAccessBootstrapLive } from '../../src/access/bootstrap/bootstrap-tenant-access.ts';
import {
  AccessDecisionLogLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  LegalEntityCandidatesLive,
} from '../../src/actions/runtime-wiring.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { makeSpiceDbDecisionCheckPort } from '../../src/access/decision/spicedb-check-port.ts';
import { spiceDbTransport } from '#spicedb-transport';
import { ModuleKeySchema, RecordKeySchema } from '../../src/access/ids.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import type { ModuleKey, RecordKey } from '../../src/access/ids.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { assetMetadataRead } from '../../src/generated-reads/asset-metadata.ts';
import { confirmAssetAction } from '../../src/modules/actions/confirm-asset.action.ts';
import { renameDisplayFilenameAction } from '../../src/modules/actions/rename-display-filename.action.ts';
import { uploadAssetAction } from '../../src/modules/actions/upload-asset.action.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { reconcileStageContextBootstraps } from '../../src/install/stage-context-bootstrap.ts';
import type { StageTenantBootstrap } from '../../src/install/stage-context-bootstrap.ts';
import { createTemplateDatabase, replacedDatabase } from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

/*
 * A tenant that existed before Core Media, against the stage bootstrap path (lane d20-08, fnd-bootstrap-existing-tenants).
 * Core Media is a Core-owned capability: its `core.media` installation row is DERIVED from the access catalog, never
 * activated as a business module. This suite runs the real stage bootstrap twice over one real PostgreSQL and one
 * real SpiceDB, first with the catalog of the release before Core Media and then with the catalog that carries it, and
 * states exactly what the second run does and does not give a tenant that already holds a published release.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const MODULE = 'party.registry';
const READ = 'party.registry.party.read';
const ACTION = 'party.registry.party.change';
const CORE_READ = 'core.shell.composition.read';

const readEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'party.registry.api.party-list',
  moduleKey: MODULE,
  role: 'api',
});
const actionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'party.registry.action.change-party',
  moduleKey: MODULE,
  role: 'action',
});
const coreReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'core.shell.api.composition',
  moduleKey: 'core.shell',
  role: 'api',
});

const read: AccessDeclarationInput = {
  key: READ,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'parties', level: 'basic' },
  risk: 'routine',
  selectors: [],
};
const action: AccessDeclarationInput = {
  key: ACTION,
  kind: 'action',
  // A sensitive Action must support proposing it, so "Plný přístup" holds both modes (O10, O67-Q6).
  modes: ['run', 'propose'],
  placement: { group: 'parties', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
};
const coreRead: AccessDeclarationInput = {
  key: CORE_READ,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'shell', level: 'basic' },
  risk: 'routine',
  selectors: [],
};

/** The composition of the release BEFORE Core Media: the tenant's module and Core's own (O69). */
const modules: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: read, entrypoint: readEntrypoint },
      { accessDeclaration: action, entrypoint: actionEntrypoint },
    ],
    moduleId: MODULE,
  },
  { descriptors: [{ accessDeclaration: coreRead, entrypoint: coreReadEntrypoint }], moduleId: 'core.shell' },
];

const readCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(read, readEntrypoint) };

const owner = uid(2);
const colleague = uid(3);
const unassigned = uid(4);
const company = uid(5);

/** One operator accounts file entry: an owner, a colleague who holds "Plný přístup", and a plain account. */
const tenantBootstrap = (tenantId: string): StageTenantBootstrap => ({
  accounts: [
    {
      authBindingId: uid(11),
      displayName: 'Owner',
      owner: true,
      principalId: owner,
      providerUserId: `auth-owner-${tenantId}`,
      roles: [],
    },
    {
      authBindingId: uid(12),
      displayName: 'Colleague',
      owner: false,
      principalId: colleague,
      providerUserId: `auth-colleague-${tenantId}`,
      roles: ['full_access'],
    },
    // A named account the operator gave no role: it is a person of the tenant file and holds nothing.
    {
      authBindingId: uid(13),
      displayName: 'Unassigned',
      owner: false,
      principalId: unassigned,
      providerUserId: `auth-unassigned-${tenantId}`,
      roles: [],
    },
  ],
  tenant: {
    defaultLocale: 'cs',
    displayName: 'Stage tenant',
    legalEntity: {
      legalEntityId: company,
      legalName: 'Stage tenant s.r.o.',
      registrationCountry: 'CZ',
      registrationNumber: 'STAGE-0001',
    },
    moduleKey: MODULE,
    moduleStateId: uid(21),
    slug: `stage-tenant-${tenantId.slice(-4)}`,
    tenantId,
  },
});

/** One trusted request scope: the acting person in the tenant context (O66). */
const scopeFor = (tenantId: string, principalId: string) =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: uid(300),
    authContextRef: `session:stage-context-bootstrap:${principalId}`,
    authMethod: 'session' as const,
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'stage-context-bootstrap' }) satisfies OperationalScope),
    Effect.orDie,
  );

const decisionAt = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));

/** A failure travels as text: a bootstrap or a reconcile reports a phase plus the reason it recorded. */
class StageFailure extends Schema.TaggedError<StageFailure>()('StageFailure', { reason: Schema.String }) {}

const asStageFailure = (cause: { readonly code: string; readonly reason: string }): StageFailure =>
  new StageFailure({ reason: `${cause.code}: ${cause.reason}` });

/** A refused stage run fails the case with the phase and reason the bootstrap recorded. */
const failClosed = <A>(effect: Effect.Effect<A, StageFailure>): Effect.Effect<A> =>
  effect.pipe(
    Effect.catchTag('StageFailure', (refused) => Effect.die(new Error(`stage bootstrap refused: ${refused.reason}`))),
  );

interface Stage {
  readonly admin: PgClient.PgClient;
  /** One protected capability of the release, asked the way an entrypoint asks it. */
  readonly decide: (input: {
    readonly carrier: { readonly accessDeclaration: ReturnType<typeof decodeAccessDeclarationOrThrow> };
    readonly principalId: string;
    readonly target?: { readonly moduleKey: ModuleKey; readonly recordKey: RecordKey };
    readonly tenantId: string;
  }) => Effect.Effect<AccessDecision>;
  /** One reconcile of the tenant through the single Core writer, as the bootstrap calls it. */
  readonly project: (
    scope: OperationalScope,
  ) => Effect.Effect<
    { readonly deletions: number; readonly touches: number; readonly verified: boolean },
    StageFailure
  >;
  /** The stage bootstrap of one operator accounts file, over this suite's tenant runtime. */
  readonly reconcile: (
    input: Parameters<typeof reconcileStageContextBootstraps>[0],
    release: readonly AccessCatalogModule[],
  ) => Effect.Effect<readonly { readonly owner: boolean; readonly principalId: string }[], StageFailure>;
  /** The case's own tenant: random, so no case reads another case's tuples in the shared engine. */
  readonly tenantId: string;
}

const withStage = <Value, Failure>(run: (stage: Stage) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* stageScenario() {
    const crypto = yield* SecureRandom.SecureRandom;
    const [connections, spiceDb] = yield* Effect.all([loadDatabaseConnectionPair(), loadSpiceDbConfig()], {
      concurrency: 2,
    }).pipe(Effect.orDie);
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `stage_bootstrap_${(yield* crypto.uuidV4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    // The whole committed schema; the stage bootstrap creates the tenant's identity rows itself, so the suite
    // seeds nothing.
    yield* createTemplateDatabase(admin);
    const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
      maxConnections: 2,
    });
    const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    // The suite owns the engine's schema, so it starts from exactly the v2 definitions Core serves.
    yield* Effect.acquireUseRelease(
      Effect.sync(() => newSpiceDbGrpcClient(spiceDb)),
      (client) =>
        Effect.tryPromise(() =>
          client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        ).pipe(Effect.orDie),
      (client) => Effect.sync(() => client.close()),
    );
    // The engine port over the integration SpiceDB: the runtime's transport reads the deployment's
    // environment, which a suite never owns, so the suite hands the gate its own transport instead.
    const rpc = spiceDbTransport.open(spiceDb, 10_000);
    yield* Effect.addFinalizer(() => Effect.sync(() => rpc.close()));
    const check = Layer.succeed(DecisionCheck, makeSpiceDbDecisionCheckPort(rpc));
    const engine = Layer.effect(
      AccessProjectionCompiler,
      Effect.sync(() => makeAccessProjectionCompiler(makeAccessProjectionTransport(spiceDb))),
    );
    const core = Layer.succeed(CoreDatabase, { executor });
    const platforms = Layer.mergeAll(core, engine, NodeServices.layer);
    const intent = TenantIntentLoaderLive.pipe(Layer.provide(platforms));
    const journal = AccessWriteJournalStoreLive.pipe(Layer.provide(platforms));
    const changes = AccessChangesStoreLive.pipe(Layer.provide(platforms));
    const memberships = AccessMembershipStoreLive.pipe(Layer.provide(platforms));
    const stores = Layer.mergeAll(platforms, intent, journal, changes, memberships);
    const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
    const writer = AccessProjectionWriterLive.pipe(Layer.provide(stores));
    const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, catalog, writer)));
    const base = Layer.mergeAll(stores, catalog, writer, bootstrap);
    const ports = Layer.mergeAll(
      AccessIntentLive,
      AccessDecisionLogLive,
      AccessPrincipalKindSourceLive,
      LegalEntityCandidatesLive,
      check,
    );
    const context = yield* Layer.build(
      Layer.mergeAll(base, AccessDecisionLive.pipe(Layer.provide(ports), Layer.provide(base))),
    );
    const gate = Context.get(context, AccessDecisionGate);
    const projectionWriter = Context.get(context, AccessProjectionWriter);
    return yield* run({
      admin,
      decide: ({ carrier, principalId, target, tenantId }) =>
        Effect.flatMap(scopeFor(tenantId, principalId), (scope) =>
          gate.decide(
            withOptional({ carrier, legalEntityScope: 'optional', now: decisionAt, scope }, 'target', target),
          ),
        ).pipe(Effect.provide(context)),
      project: (scope) =>
        projectionWriter.reconcileTenant({ scope }).pipe(Effect.mapError(asStageFailure), Effect.provide(context)),
      reconcile: (input, release) =>
        reconcileStageContextBootstraps(input, { authenticationNamespaceId: 'staff', modules: release }).pipe(
          Effect.mapError(asStageFailure),
          Effect.provide(context),
        ),
      tenantId: yield* crypto.uuidV4(),
    });
  }).pipe(Effect.scoped);

/** A release's Core Media module: the real upload, confirm, rename and metadata read declarations. */
const mediaModule: AccessCatalogModule = {
  descriptors: [
    uploadAssetAction.descriptor,
    confirmAssetAction.descriptor,
    renameDisplayFilenameAction.descriptor,
    assetMetadataRead.descriptor,
  ].flatMap((descriptor) =>
    descriptor.accessDeclaration === undefined
      ? []
      : [{ accessDeclaration: descriptor.accessDeclaration, entrypoint: descriptor.entrypoint }],
  ),
  moduleId: 'core.media',
};
const releaseWithMedia: readonly AccessCatalogModule[] = [...modules, mediaModule];

/** A carrier of the real descriptor's own declaration: the declaration exists, so its absence would be a defect here. */
const carrierOf = (descriptor: {
  readonly accessDeclaration?: AccessDeclarationInput;
  readonly entrypoint: Parameters<typeof decodeAccessDeclarationOrThrow>[1];
}) => ({
  accessDeclaration: decodeAccessDeclarationOrThrow(
    Option.getOrThrow(Option.fromUndefinedOr(descriptor.accessDeclaration)),
    descriptor.entrypoint,
  ),
});
const uploadCarrier = carrierOf(uploadAssetAction.descriptor);
const renameCarrier = carrierOf(renameDisplayFilenameAction.descriptor);
const assetTarget = { moduleKey: ModuleKeySchema.make('core.media'), recordKey: RecordKeySchema.make(uid(900)) };

const decisionInputs: readonly Pick<Parameters<Stage['decide']>[0], 'carrier' | 'target'>[] = [
  { carrier: uploadCarrier },
  { carrier: renameCarrier, target: assetTarget },
];

const mediaStates = (stage: Stage, tenantId: string) =>
  stage.admin
    .unsafe<{ state: string }>(
      `select state from core.tenant_module_states where tenant_id = '${tenantId}' and module_key = 'core.media'`,
    )
    .pipe(Effect.orDie);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  'core media on tenants bootstrapped before it',
  (suite) => {
    suite.effect(
      'a first bootstrap that already carries Core Media derives the installation and lets the owner upload and rename',
      () =>
        withStage((stage) =>
          Effect.gen(function* freshEnvironment() {
            const { tenantId } = stage;
            yield* stage
              .reconcile({ retiredTenants: [], tenants: [tenantBootstrap(tenantId)] }, releaseWithMedia)
              .pipe(failClosed);
            // The row is derived from the catalog, never named by the tenant file (its own module list is party.registry).
            expect(yield* mediaStates(stage, tenantId)).toEqual([{ state: 'active' }]);
            for (const input of decisionInputs) {
              const decision = yield* stage.decide({ ...input, principalId: owner, tenantId });
              expect(decision.outcome).toBe('ALLOWED');
            }
            // The negative control: a named account without a role holds nothing, Core Media included.
            const denied = yield* stage.decide({ carrier: uploadCarrier, principalId: unassigned, tenantId });
            expect(denied.outcome).toBe('DENIED');
          }),
        ),
    );

    suite.effect(
      'a tenant bootstrapped before Core Media gets the derived installation row on a re-run, but never a capability of a release it already pinned',
      () =>
        withStage((stage) =>
          Effect.gen(function* existingTenant() {
            const { tenantId } = stage;
            // The tenant existed before D20: its release has no Core Media entry and no installation row.
            yield* stage
              .reconcile({ retiredTenants: [], tenants: [tenantBootstrap(tenantId)] }, modules)
              .pipe(failClosed);
            expect(yield* mediaStates(stage, tenantId)).toEqual([]);
            expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe(
              'ALLOWED',
            );

            // The operator re-runs the stage bootstrap with the catalog of this build, which now carries Core Media.
            yield* stage
              .reconcile({ retiredTenants: [], tenants: [tenantBootstrap(tenantId)] }, releaseWithMedia)
              .pipe(failClosed);
            // The derived installation is written (and a second run adds nothing: one row, not two).
            expect(yield* mediaStates(stage, tenantId)).toEqual([{ state: 'active' }]);
            yield* stage
              .reconcile({ retiredTenants: [], tenants: [tenantBootstrap(tenantId)] }, releaseWithMedia)
              .pipe(failClosed);
            expect(yield* mediaStates(stage, tenantId)).toEqual([{ state: 'active' }]);
            // What the earlier release already granted is untouched.
            expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe(
              'ALLOWED',
            );

            // But the bootstrap never rewrites a published release (it is global and pinned by every role revision):
            // the Core Media capabilities are not in it, so even the full-access owner holds none of them. They reach
            // an existing environment only through a later release and its adoption (Novinky), never from this re-run.
            for (const input of decisionInputs) {
              const decision = yield* stage.decide({ ...input, principalId: owner, tenantId });
              expect(decision.outcome).toBe('DENIED');
              expect(decision.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
            }
          }),
        ),
    );
  },
);
