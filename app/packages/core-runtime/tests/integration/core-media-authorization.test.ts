import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { sha256 } from '@noble/hashes/sha2.js';
import { Cause, Context, Crypto, DateTime, Effect, Exit, Layer, Option, Ref, Schema, Stream } from 'effect';
import type { Scope } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { spiceDbTransport } from '#spicedb-transport';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessChangesStore } from '../../src/access/changes/persistence/store.ts';
import type { AccessChangesStoreService } from '../../src/access/changes/persistence/store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { assignmentObjectId, objectTypeOf } from '../../src/access/compiler/object-id.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { makeSpiceDbDecisionCheckPort } from '../../src/access/decision/spicedb-check-port.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { OwnerAuthorizationOverlay } from '../../src/access/enforcement/owner-overlay.ts';
import type { OwnerAccessFacts } from '../../src/access/enforcement/owner-overlay.ts';
import { LegalEntityIdSchema, ModuleKeySchema, RecordKeySchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { TenantId } from '../../src/access/ids.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import {
  AccessDecisionLogLive,
  AccessEnforcementPortsLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  LegalEntityCandidatesLive,
} from '../../src/actions/runtime-wiring.ts';
import {
  ActionAlreadyCommitted,
  ActionPermissionCheckError,
  ActionPermissionDenied,
} from '../../src/actions/errors.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeService } from '../../src/actions/runtime.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { assetMetadataRead } from '../../src/generated-reads/asset-metadata.ts';
import { streamMediaObject } from '../../src/media/byte-stream.ts';
import { MediaAssetNotFound } from '../../src/media/errors.ts';
import { ObjectStorage } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { StoredMediaObjectVerification, verifyStoredMediaObject } from '../../src/media/verification.ts';
import { confirmAssetAction } from '../../src/modules/actions/confirm-asset.action.ts';
import { renameDisplayFilenameAction } from '../../src/modules/actions/rename-display-filename.action.ts';
import { uploadAssetAction } from '../../src/modules/actions/upload-asset.action.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { bindLiveAccessGate } from '../../src/operations/access-gate.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import { loadSpiceDbConfig, parseSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { MediaAssetRefSchema } from '../../src/resources/media-asset.ts';
import { ReadHandlerNotFound, ReadPermissionDenied, ReadPermissionUnavailable } from '../../src/reads/errors.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import type { ReadRuntimeService } from '../../src/reads/runtime.ts';
import { makeInMemoryObjectStorage } from '../../src/testing/media-object-storage.ts';
import type { InMemoryObjectStorage } from '../../src/testing/media-object-storage.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import {
  ScenarioTemplate,
  cloneDatabase,
  createTemplateDatabase,
  dropDatabase,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import {
  insertAssignment,
  insertMembership,
  insertRoleWithCells,
  legalEntityScopeIdOf,
  scenarioOf,
  scopeOf,
  seedTenantRows,
  tenantScopeIdOf,
} from '../support/access-scenarios/scenario.ts';
import type { AccessScenario } from '../support/access-scenarios/scenario.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from '../support/open-module-state-gate.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

/*
 * The single Core/SpiceDB gate over every Core Media capability that exists, proven against a REAL SpiceDB and a
 * REAL PostgreSQL (lane d20-08). Each case runs the real Action and Read definitions through the real runtimes,
 * the real access seam (AccessDecisionLive over AccessEnforcementPortsLive and the tenant intent loader), and a
 * database of its own cloned beside the integration environment's. No scripted gate is installed: the answer
 * comes from the engine, through the seam, into the runner, and a refused request leaves the handler's effect
 * (a row, a name, a status) untouched. The provider is the in-memory double, never storage proof.
 *
 * Grants here are fixtures written into a throwaway database; nothing ships a default grant.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const OWNER = uid(2);
const PLAIN = uid(3);
const ADMIN_ONLY = uid(4);
const AGENT = uid(8);
const COMPANY_A = uid(5);
const COMPANY_B = uid(6);
const FOREIGN_OWNER = uid(9);
const UPLOAD_HOLDER = uid(10);
const CONFIRM_HOLDER = uid(11);
const METADATA_HOLDER = uid(12);
const RENAME_HOLDER = uid(13);
const PROPOSE_HOLDER = uid(14);
const SYSTEM_MACHINE = uid(20);
const INTEGRATION_MACHINE = uid(21);
const IMPORT_MACHINE = uid(22);

const UPLOAD = 'core.media.asset.upload';
const CONFIRM = 'core.media.asset.confirm';
const METADATA = 'core.media.asset-metadata.read';
const RENAME = 'core.media.display-filename.rename';
const INGEST = 'core.media.ingest';

/** The catalog a bootstrap releases: the four real Core Media declarations, taken from the real descriptors. */
const mediaModules: readonly AccessCatalogModule[] = [
  {
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
  },
];

const encoder = new TextEncoder();
const content = encoder.encode('the bytes of one governed media asset');
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));

const failureOf = <Value, Failure>(exit: Exit.Exit<Value, Failure>): Failure | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

/** The refusal an Action ended with, or none when it ran (or failed for another reason). */
const refusalOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      const failure = failureOf(exit);
      return Schema.is(ActionPermissionDenied)(failure) || Schema.is(ActionPermissionCheckError)(failure)
        ? failure
        : undefined;
    }),
  );
/** The gate's reason codes of an Action refusal; empty when the effect did not end in a denial. */
const reasonsOfAction = (
  refusal: ActionPermissionDenied | ActionPermissionCheckError | undefined,
): readonly string[] => (Schema.is(ActionPermissionDenied)(refusal) ? (refusal.reasons ?? []) : []);

const readRefusalOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      const failure = failureOf(exit);
      return Schema.is(ReadPermissionDenied)(failure) || Schema.is(ReadPermissionUnavailable)(failure)
        ? failure
        : undefined;
    }),
  );

/** The engine port of a REAL transport whose endpoint refuses connections, with every other port as in production. */
const unreachableEnginePorts = Effect.fn('CoreMediaAuthorizationTest.unreachableEngine')(function* unreachable(
  live: Effect.Success<ReturnType<typeof loadSpiceDbConfig>>,
  rpcEndpoint: string,
) {
  const dead = yield* parseSpiceDbConfig(
    withOptional(
      { SPICEDB_ENDPOINT: rpcEndpoint, SPICEDB_PRESHARED_KEY: live.preSharedKey },
      'SPICEDB_CA_CERT',
      live.caCertificate,
    ),
  ).pipe(Effect.orDie);
  const rpc = yield* Effect.acquireRelease(
    Effect.sync(() => spiceDbTransport.open(dead, 1500)),
    (opened) => Effect.sync(() => opened.close()),
  );
  return Layer.mergeAll(
    AccessIntentLive,
    AccessDecisionLogLive,
    AccessPrincipalKindSourceLive,
    LegalEntityCandidatesLive,
    Layer.succeed(DecisionCheck, makeSpiceDbDecisionCheckPort(rpc)),
  );
});

interface ComposedRuntime {
  readonly bootstrap: (typeof TenantAccessBootstrap)['Service'];
  readonly boundGate: BoundAccessGate;
  readonly changes: AccessChangesStoreService;
  readonly gate: (typeof AccessDecisionGate)['Service'];
  readonly runAction: ActionRuntimeService['runAction'];
  readonly runRead: ReadRuntimeService['runRead'];
  readonly writer: (typeof AccessProjectionWriter)['Service'];
}

type Engine =
  | { readonly kind: 'live' }
  /** A REAL SpiceDB client pointed at an address nothing listens on: a transport failure, not a scripted outcome. */
  | { readonly kind: 'unreachable'; readonly rpcEndpoint: string };

/**
 * The real graph a deployment composes: the seam over the tenant intent loader and the engine port, and the Action
 * and Read runtimes wired to the bound gate. Only the engine port differs between the live and the unreachable
 * runtime, so the same composition answers 503 when the engine cannot be reached.
 */
const buildRuntime = (input: {
  readonly engine: Engine;
  readonly executor: CoreDatabaseExecutor;
}): Effect.Effect<ComposedRuntime, never, Crypto.Crypto | Scope.Scope> =>
  Effect.gen(function* buildRuntimeEffect() {
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig().pipe(Effect.orDie);
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const ownerOverlayFacts = yield* Ref.make<readonly (OwnerAccessFacts | undefined)[]>([]);
    const overlay: (typeof OwnerAuthorizationOverlay)['Service'] = {
      authorize: (_transaction, authorizationInput) =>
        Ref.update(ownerOverlayFacts, (facts) => [...facts, authorizationInput.ownerFacts]).pipe(
          Effect.as('allowed' as const),
        ),
    };
    const core = Layer.succeed(CoreDatabase, { executor: input.executor });
    const platforms = Layer.mergeAll(
      core,
      Layer.succeed(AccessProjectionCompiler, compiler),
      Layer.succeed(OwnerAuthorizationOverlay, overlay),
      NodeServices.layer,
    );
    const intent = TenantIntentLoaderLive.pipe(Layer.provide(platforms));
    const journal = AccessWriteJournalStoreLive.pipe(Layer.provide(platforms));
    const changes = AccessChangesStoreLive.pipe(Layer.provide(platforms));
    const memberships = AccessMembershipStoreLive.pipe(Layer.provide(platforms));
    const stores = Layer.mergeAll(platforms, intent, journal, changes, memberships);
    const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
    const writer = AccessProjectionWriterLive.pipe(Layer.provide(stores));
    const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, catalog, writer)));
    const base = Layer.mergeAll(stores, catalog, writer, bootstrap);
    const ports =
      input.engine.kind === 'live'
        ? AccessEnforcementPortsLive
        : yield* unreachableEnginePorts(configuration, input.engine.rpcEndpoint);
    const enforcement = AccessDecisionLive.pipe(Layer.provideMerge(ports), Layer.provide(base));
    const context = yield* Layer.build(Layer.mergeAll(base, enforcement));
    const boundGate = yield* bindLiveAccessGate.pipe(Effect.provideContext(context));
    // Like the Shell host: no owner registration, so every Core Media operation must be a genuine Core one to run.
    const actions = makeActionRuntime(
      { executor: input.executor },
      makeActionRepository(crypto),
      { checkActionPermission: () => Effect.succeed('allowed' as const) },
      testOperationalScopeResolver,
      {
        accessDecision: boundGate,
        lockCompositionAuthority: () => Effect.succeed([]),
        moduleEntrypointGateway: openModuleEntrypointGateway,
        moduleStateGate: openModuleStateGate,
        ownerAuthorizationOverlay: overlay,
        resolveCompositionRevision: () => Effect.succeed('a'.repeat(64)),
      },
    );
    const reads = makeReadRuntime(
      { executor: input.executor },
      openModuleEntrypointGateway,
      testOperationalScopeResolver,
      {
        legalEntities: () => Effect.succeed([]),
        modules: () => Effect.succeed([]),
        resources: () => Effect.succeed([]),
        tenants: () => Effect.succeed([]),
      },
      { accessDecision: boundGate, ownerAuthorizationOverlay: overlay },
    );
    return {
      bootstrap: Context.get(context, TenantAccessBootstrap),
      boundGate,
      changes: Context.get(context, AccessChangesStore),
      gate: Context.get(context, AccessDecisionGate),
      runAction: actions.runAction,
      runRead: reads.runRead,
      writer: Context.get(context, AccessProjectionWriter),
    };
  });

const bootstrapTenant = (
  runtime: ComposedRuntime,
  tenantId: TenantId,
  input: {
    readonly legalEntityIds: readonly string[];
    readonly modules: readonly AccessCatalogModule[];
    readonly principalId: string;
  },
) =>
  scopeOf({ principalId: input.principalId, tenantId }).pipe(
    Effect.flatMap((scope) =>
      runtime.bootstrap.bootstrapTenantAccess({
        legalEntityIds: input.legalEntityIds.map((value) => LegalEntityIdSchema.make(value)),
        modules: input.modules,
        scope,
      }),
    ),
    Effect.orDie,
  );

const buildScenarioTemplate = Effect.gen(function* buildScenarioTemplateEffect() {
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const database = `d20_media_template_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const admin = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  yield* admin.unsafe(`create database "${database}"`);
  yield* Effect.addFinalizer(() => dropDatabase(admin, database));
  yield* Effect.scoped(
    Effect.gen(function* migrateScenarioTemplate() {
      const template = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
        maxConnections: 1,
      });
      yield* createTemplateDatabase(template);
    }),
  );
  return { database };
}).pipe(Effect.orDie);

const suiteLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.effect(ScenarioTemplate, buildScenarioTemplate).pipe(Layer.provide(NodeServices.layer)),
);

const acquireDatabase = Effect.gen(function* acquireDatabaseEffect() {
  const { database: template } = yield* ScenarioTemplate;
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const database = `d20_media_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const admin = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  yield* cloneDatabase(admin, template, database);
  yield* Effect.addFinalizer(() => dropDatabase(admin, database));
  const adminClient = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
    maxConnections: 2,
  });
  const runtimeClient = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
    maxConnections: 2,
  });
  return { admin: adminClient, runtime: runtimeClient } as const;
}).pipe(Effect.orDie);

interface MediaWorld {
  readonly bootstrapForeign: (input: {
    readonly legalEntityIds: readonly string[];
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<void>;
  readonly dead: ComposedRuntime;
  readonly live: ComposedRuntime;
  readonly scenario: AccessScenario;
  readonly spiceDb: Effect.Success<ReturnType<typeof loadSpiceDbConfig>>;
  readonly storage: InMemoryObjectStorage;
}

const withMediaWorld = <Value, Failure>(run: (world: MediaWorld) => Effect.Effect<Value, Failure, Crypto.Crypto>) =>
  Effect.scoped(
    Effect.gen(function* mediaWorld() {
      const configuration = yield* loadSpiceDbConfig().pipe(Effect.orDie);
      const { admin, runtime: runtimeClient } = yield* acquireDatabase;
      const executor = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => newSpiceDbGrpcClient(configuration)),
        (client) =>
          Effect.tryPromise(() =>
            client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
          ).pipe(Effect.orDie),
        (client) => Effect.sync(() => client.close()),
      );
      const live = yield* buildRuntime({ engine: { kind: 'live' }, executor });
      const dead = yield* buildRuntime({ engine: { kind: 'unreachable', rpcEndpoint: '127.0.0.1:1' }, executor });
      const storage = yield* makeInMemoryObjectStorage();
      const crypto = yield* Crypto.Crypto;
      const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
      const scenario = scenarioOf({
        admin,
        bootstrap: (input) => bootstrapTenant(live, tenantId, input),
        changes: live.changes,
        gate: (input: GateInput): Effect.Effect<AccessDecision> => live.gate.decide(input),
        ownerOverlayFacts: yield* Ref.make<readonly (OwnerAccessFacts | undefined)[]>([]),
        runAction: live.runAction,
        runActionUnavailable: dead.runAction,
        runRead: live.runRead,
        runReadUnavailable: dead.runRead,
        tenantId,
        unavailableGate: dead.boundGate,
        writer: live.writer,
      });
      return yield* run({
        bootstrapForeign: (input) =>
          seedTenantRows(admin, {
            legalEntityIds: input.legalEntityIds,
            moduleKeys: ['core.media'],
            principals: [{ kind: 'human', principalId: input.principalId }],
            tenantId: input.tenantId,
          }).pipe(
            Effect.andThen(
              bootstrapTenant(live, TenantIdSchema.make(input.tenantId), {
                legalEntityIds: input.legalEntityIds,
                modules: mediaModules,
                principalId: input.principalId,
              }),
            ),
            Effect.asVoid,
          ),
        dead,
        live,
        scenario,
        spiceDb: configuration,
        storage,
      });
    }),
  );

/** One seeded, bootstrapped tenant with a principal of every kind the matrix needs. */
const seedMediaTenant = Effect.fn('CoreMediaAuthorizationTest.seed')(function* seedMediaTenant(
  world: MediaWorld,
  options: { readonly installCoreMedia?: boolean } = {},
) {
  const { scenario } = world;
  yield* scenario.seedTenant({
    legalEntityIds: [COMPANY_A, COMPANY_B],
    moduleKeys: options.installCoreMedia === false ? [] : ['core.media'],
    principals: [
      { kind: 'human', principalId: OWNER },
      { kind: 'human', principalId: PLAIN },
      { kind: 'human', principalId: ADMIN_ONLY },
      { kind: 'agent', principalId: AGENT },
      { kind: 'human', principalId: UPLOAD_HOLDER },
      { kind: 'human', principalId: CONFIRM_HOLDER },
      { kind: 'human', principalId: METADATA_HOLDER },
      { kind: 'human', principalId: RENAME_HOLDER },
      { kind: 'human', principalId: PROPOSE_HOLDER },
      { kind: 'system', principalId: SYSTEM_MACHINE },
      { kind: 'integration', principalId: INTEGRATION_MACHINE },
      { kind: 'service', principalId: IMPORT_MACHINE },
    ],
  });
  const bootstrapped = yield* scenario.bootstrap({
    legalEntityIds: [COMPANY_A, COMPANY_B],
    modules: mediaModules,
    principalId: OWNER,
  });
  const tenantScope = yield* tenantScopeIdOf(scenario.admin, scenario.tenantId);
  return { bootstrapped, tenantScope };
});
type SeededTenant = Effect.Success<ReturnType<typeof seedMediaTenant>>;

const reconcile = (scenario: AccessScenario) =>
  scenario.scopeFor(OWNER).pipe(
    Effect.flatMap((scope) => scenario.writer.reconcileTenant({ scope })),
    Effect.tapError((failure) => Effect.logWarning(`media reconcile refused: ${failure.code} ${failure.reason}`)),
    Effect.orDie,
  );

const BOOTSTRAP_INSTANT = "'1970-01-01T00:00:00Z'::timestamptz";

/** Gives one human exactly the named capabilities as a role of their own, assigned in one scope. */
const grantOnly = Effect.fn('CoreMediaAuthorizationTest.grant')(function* grantOnly(
  world: MediaWorld,
  seeded: SeededTenant,
  input: {
    readonly keys: readonly string[];
    readonly legalEntityId?: string;
    readonly mode?: 'propose' | 'run';
    readonly principalId: string;
    readonly selector?: Parameters<typeof insertRoleWithCells>[2]['selector'];
    readonly slot: number;
  },
) {
  const { scenario } = world;
  const base = 1000 + input.slot * 10;
  const scopeId =
    input.legalEntityId === undefined
      ? seeded.tenantScope
      : yield* legalEntityScopeIdOf(scenario.admin, scenario.tenantId, input.legalEntityId);
  const role = withOptional(
    withOptional(
      withOptional(
        {
          capabilityKeys: input.keys,
          catalogSnapshotId: seeded.bootstrapped.catalogSnapshotId,
          createdBy: OWNER,
          roleId: uid(base),
          roleRevisionId: uid(base + 1),
          scopeId,
        },
        'legalEntityId',
        input.legalEntityId,
      ),
      'mode',
      input.mode,
    ),
    'selector',
    input.selector,
  );
  yield* insertRoleWithCells(scenario.admin, scenario.tenantId, role);
  // A holder is a member of the tenant (and of the company a company role lives in), once.
  for (const memberScope of new Set([seeded.tenantScope, scopeId])) {
    const existing = yield* scenario.admin.unsafe<{ count: string }>(
      `select count(*)::text as count from core.access_memberships
       where tenant_id = $1 and scope_id = $2 and principal_id = $3 and kind = 'member'`,
      [scenario.tenantId, memberScope, input.principalId],
    );
    if (existing[0]?.count === '0') {
      yield* insertMembership(scenario.admin, scenario.tenantId, {
        kind: 'member',
        principalId: input.principalId,
        recordedBy: OWNER,
        scopeId: memberScope,
        validFrom: BOOTSTRAP_INSTANT,
      });
    }
  }
  yield* insertAssignment(scenario.admin, scenario.tenantId, {
    assignedBy: OWNER,
    incarnationId: uid(base + 2),
    principalId: input.principalId,
    roleId: uid(base),
    roleRevisionId: uid(base + 1),
    scopeId,
  });
  return { assignmentId: uid(base + 2), roleId: uid(base), scopeId };
});

/** A member of the tenant who holds no role: the tenant membership is real, so a denial is the missing grant. */
const memberWithoutRole = (
  world: MediaWorld,
  seeded: SeededTenant,
  principalId: string,
  kind: 'access_admin' | 'member' | 'owner',
) =>
  insertMembership(world.scenario.admin, world.scenario.tenantId, {
    kind,
    principalId,
    recordedBy: OWNER,
    scopeId: seeded.tenantScope,
    validFrom: BOOTSTRAP_INSTANT,
  });

/** The carrier a descriptor hands the gate: only what it declares, so a missing declaration stays missing. */
const carrierOf = (descriptor: {
  readonly accessDeclaration?: GateInput['carrier']['accessDeclaration'];
  readonly accessWorkload?: GateInput['carrier']['accessWorkload'];
}): GateInput['carrier'] =>
  withOptional(
    withOptional({}, 'accessDeclaration', descriptor.accessDeclaration),
    'accessWorkload',
    descriptor.accessWorkload,
  );

const targetOf = (recordKey: string) => ({
  moduleKey: ModuleKeySchema.make('core.media'),
  recordKey: RecordKeySchema.make(recordKey),
});

const DECISION_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));

const transport = (key: string) => ({ correlationId: `d20-${key}`, idempotencyKey: `d20-${key}` });

interface UploadOptions {
  readonly ingestionSource?: 'import' | 'integration' | 'system' | 'user';
  readonly legalEntityId?: string;
  readonly runtime?: 'dead' | 'live';
  readonly savedReply?: 'answer';
}

/** One reserve through the real upload Action. */
const reserve = (world: MediaWorld, principalId: string, key: string, options: UploadOptions = {}) =>
  world.scenario.scopeFor(principalId, options.legalEntityId).pipe(
    Effect.flatMap((principal) =>
      (options.runtime === 'dead' ? world.dead : world.live).runAction(
        withOptional(
          {
            payload: {
              declaredByteSize: content.byteLength,
              declaredContentSha256: digestOf(content),
              displayFilename: 'Brochure.pdf',
              ingestionSource: options.ingestionSource ?? 'user',
              mimeType: 'application/pdf',
            },
            principal,
            registration: uploadAssetAction,
            transport: transport(key),
          },
          'savedReply',
          options.savedReply,
        ),
      ),
    ),
    Effect.provideService(ObjectStorage, world.storage.service),
  );

const displayFilenameOf = (name: string) =>
  Schema.decodeUnknownSync(renameDisplayFilenameAction.descriptor.payloadSchema.fields.displayFilename)(name);

const renameAs = (
  world: MediaWorld,
  principalId: string,
  mediaAssetRef: MediaRef,
  key: string,
  options: { readonly legalEntityId?: string; readonly name?: string; readonly runtime?: 'dead' | 'live' } = {},
) =>
  world.scenario.scopeFor(principalId, options.legalEntityId).pipe(
    Effect.flatMap((principal) =>
      (options.runtime === 'dead' ? world.dead : world.live).runAction({
        payload: {
          displayFilename: displayFilenameOf(options.name ?? 'Renamed.pdf'),
          mediaAssetRef,
        },
        principal,
        registration: renameDisplayFilenameAction,
        transport: transport(key),
      }),
    ),
  );

const readAs = (
  world: MediaWorld,
  principalId: string,
  mediaAssetRef: MediaRef,
  options: { readonly legalEntityId?: string; readonly runtime?: 'dead' | 'live' } = {},
) =>
  world.scenario.scopeFor(principalId, options.legalEntityId).pipe(
    Effect.flatMap((principal) =>
      (options.runtime === 'dead' ? world.dead : world.live).runRead({
        input: { mediaAssetRef },
        principal,
        registration: assetMetadataRead,
        transport: { correlationId: `d20-read-${mediaAssetRef.resourceId}` },
      }),
    ),
  );

type MediaRef = typeof MediaAssetRefSchema.Type;

const refOf = (tenantId: string, mediaAssetId: string): MediaRef =>
  Schema.decodeUnknownSync(MediaAssetRefSchema)({
    moduleId: 'core.media',
    resourceId: mediaAssetId,
    resourceType: 'core.media.asset',
    tenantId,
  });

interface AssetRow {
  readonly display_filename: string;
  readonly ingested_by_principal_id: string | null;
  readonly ingestion_source: string;
  readonly processing_status: string;
}

const rowOf = (world: MediaWorld, mediaAssetId: string, tenantId: string = world.scenario.tenantId) =>
  world.scenario.admin
    .unsafe<AssetRow>(
      `select display_filename, ingested_by_principal_id, ingestion_source, processing_status
       from core.media_assets where tenant_id = $1 and media_asset_id = $2`,
      [tenantId, mediaAssetId],
    )
    .pipe(Effect.map((rows) => rows[0]));

const assetCount = (world: MediaWorld, tenantId: string = world.scenario.tenantId) =>
  world.scenario.admin
    .unsafe<{ count: string }>(`select count(*)::text as count from core.media_assets where tenant_id = $1`, [tenantId])
    .pipe(Effect.map((rows) => Number(rows[0]?.count ?? '0')));

/** An asset row exactly as the upload Actions leave it, so a rename or a read has something to act on. */
const seedAsset = Effect.fn('CoreMediaAuthorizationTest.seedAsset')(function* seedAsset(
  world: MediaWorld,
  options: { readonly ingestedBy?: string; readonly legalEntityId?: string; readonly tenantId?: string } = {},
) {
  const crypto = yield* Crypto.Crypto;
  const mediaAssetId = yield* crypto.randomUUIDv4();
  const tenantId = options.tenantId ?? world.scenario.tenantId;
  yield* world.scenario.admin.unsafe(
    `insert into core.media_assets (media_asset_id, tenant_id, legal_entity_id, ingestion_source, ingested_by_principal_id, storage_provider,
       storage_key, storage_object_version_ref, display_filename, mime_type, byte_size, content_sha256, sealed_at, processing_status)
     values ($1, $2, $3, 'integration', $4, 'secret-provider', $5, 'secret-version', 'Brochure.pdf', 'application/pdf', 4096, $6, now(), 'ready')`,
    [
      mediaAssetId,
      tenantId,
      options.legalEntityId ?? null,
      options.ingestedBy ?? null,
      deriveMediaStorageKey({ mediaAssetId, tenantId }),
      'b'.repeat(64),
    ],
  );
  return refOf(tenantId, mediaAssetId);
});

/** Stores the reserved bytes through the real byte hop and reads them back: the evidence the confirm Action consumes. */
const storeAndVerify = Effect.fn('CoreMediaAuthorizationTest.storeAndVerify')(function* storeAndVerify(
  world: MediaWorld,
  principalId: string,
  mediaAssetRef: MediaRef,
) {
  const row = yield* world.scenario.admin.unsafe<{
    byte_size: bigint;
    content_sha256: string | null;
    ingested_by_principal_id: string | null;
    mime_type: string;
    processing_status: string;
    sealed_at: Date | null;
    storage_key: string;
    storage_provider: string;
  }>(`select * from core.media_assets where tenant_id = $1 and media_asset_id = $2`, [
    world.scenario.tenantId,
    mediaAssetRef.resourceId,
  ]);
  const [asset] = row;
  if (asset === undefined) {
    return yield* Effect.die('The reserved asset row is missing');
  }
  yield* streamMediaObject({
    asset: {
      byteSize: asset.byte_size,
      contentSha256: asset.content_sha256,
      ingestedByPrincipalId: asset.ingested_by_principal_id,
      mimeType: asset.mime_type,
      processingStatus: asset.processing_status,
      sealedAt: asset.sealed_at,
      storageKey: asset.storage_key,
      storageProvider: asset.storage_provider,
    },
    body: Stream.fromIterable([content]),
    principalId,
  }).pipe(Effect.provideService(ObjectStorage, world.storage.service), Effect.orDie);
  return yield* verifyStoredMediaObject({
    expected: { byteSize: Number(asset.byte_size), contentSha256: asset.content_sha256 ?? undefined },
    storageKey: deriveMediaStorageKey({
      mediaAssetId: mediaAssetRef.resourceId,
      tenantId: world.scenario.tenantId,
    }),
    storageProvider: asset.storage_provider,
  }).pipe(Effect.provideService(ObjectStorage, world.storage.service));
});

const confirmAs = (
  world: MediaWorld,
  principalId: string,
  mediaAssetRef: MediaRef,
  verification: Effect.Success<ReturnType<typeof storeAndVerify>>,
  key: string,
  options: { readonly runtime?: 'dead' | 'live' } = {},
) =>
  world.scenario.scopeFor(principalId).pipe(
    Effect.flatMap((principal) =>
      (options.runtime === 'dead' ? world.dead : world.live).runAction({
        payload: { mediaAssetRef },
        principal,
        registration: confirmAssetAction,
        transport: transport(key),
      }),
    ),
    Effect.provideService(StoredMediaObjectVerification, verification),
  );

/**
 * The result of one operation of the matrix: did the handler run, and if not, was the stop the gate's own refusal.
 * An Action's refusal carries the gate's reason codes; a read's refusal is the typed denial without them.
 */
interface Attempt {
  readonly gateRefused: boolean;
  readonly ran: boolean;
  readonly reasons: readonly string[];
}

/** Which operations of one round ran their handler. */
const ranOf = (attempts: Readonly<Record<string, Attempt>>) =>
  Object.fromEntries(Object.entries(attempts).map(([operation, attempt]) => [operation, attempt.ran]));

const attemptOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>): Effect.Effect<Attempt> =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) {
        return { gateRefused: false, ran: true, reasons: [] };
      }
      const failure = failureOf(exit);
      if (Schema.is(ActionPermissionDenied)(failure)) {
        return { gateRefused: true, ran: false, reasons: failure.reasons ?? [] };
      }
      return { gateRefused: Schema.is(ReadPermissionDenied)(failure), ran: false, reasons: [] };
    }),
  );

it.layer(suiteLayer, { excludeTestServices: true })(
  'core media authorization against SpiceDB and PostgreSQL',
  (suite) => {
    suite.effect(
      'each capability is its own permission: the holder of one runs it and is refused every other, and a member, an admin and an owner without a role are refused all four',
      () =>
        withMediaWorld((world) =>
          Effect.gen(function* separateCapabilities() {
            const seeded = yield* seedMediaTenant(world);
            const { scenario } = world;
            yield* grantOnly(world, seeded, { keys: [UPLOAD], principalId: UPLOAD_HOLDER, slot: 1 });
            yield* grantOnly(world, seeded, { keys: [CONFIRM], principalId: CONFIRM_HOLDER, slot: 2 });
            yield* grantOnly(world, seeded, { keys: [METADATA], principalId: METADATA_HOLDER, slot: 3 });
            yield* grantOnly(world, seeded, { keys: [RENAME], principalId: RENAME_HOLDER, slot: 4 });
            yield* memberWithoutRole(world, seeded, PLAIN, 'member');
            // Administration is structural: an owner of the tenant and an access admin of a company still hold no use
            // of any capability without a role.
            yield* memberWithoutRole(world, seeded, ADMIN_ONLY, 'member');
            yield* memberWithoutRole(world, seeded, ADMIN_ONLY, 'owner');
            yield* insertMembership(scenario.admin, scenario.tenantId, {
              kind: 'access_admin',
              principalId: ADMIN_ONLY,
              recordedBy: OWNER,
              scopeId: yield* legalEntityScopeIdOf(scenario.admin, scenario.tenantId, COMPANY_A),
              validFrom: BOOTSTRAP_INSTANT,
            });
            yield* reconcile(scenario);

            // The owner reserves and stores one file for the confirm cases, and one ready asset serves the read and rename.
            const reserved = yield* reserve(world, OWNER, 'owner-reserve');
            const verification = yield* storeAndVerify(world, OWNER, reserved.mediaAssetRef);
            const readyRef = yield* seedAsset(world);

            const attempts = (principalId: string) => {
              const stamp = principalId.slice(-2);
              return {
                confirm: attemptOf(
                  confirmAs(world, principalId, reserved.mediaAssetRef, verification, `confirm-${stamp}`),
                ),
                metadata: attemptOf(readAs(world, principalId, readyRef)),
                rename: attemptOf(
                  renameAs(world, principalId, readyRef, `rename-${stamp}`, { name: `By-${stamp}.pdf` }),
                ),
                upload: attemptOf(reserve(world, principalId, `upload-${stamp}`)),
              };
            };
            const matrix = [
              { holds: 'none', principalId: PLAIN },
              { holds: 'none', principalId: ADMIN_ONLY },
              { holds: 'upload', principalId: UPLOAD_HOLDER },
              { holds: 'metadata', principalId: METADATA_HOLDER },
              { holds: 'rename', principalId: RENAME_HOLDER },
              // The confirm holder goes last: its confirm is the one that moves the file to ready.
              { holds: 'confirm', principalId: CONFIRM_HOLDER },
            ] as const;
            const before = yield* assetCount(world);
            let allowedUploads = 0;
            for (const { holds, principalId } of matrix) {
              const asked = attempts(principalId);
              for (const operation of ['upload', 'confirm', 'metadata', 'rename'] as const) {
                const attempt = yield* asked[operation];
                expect(attempt.ran, `${principalId.slice(-2)} ${operation}`).toBe(holds === operation);
                if (holds !== operation) {
                  // The stop is the gate's own refusal, never a handler failure; an Action names the missing grant.
                  expect(attempt.gateRefused, `${principalId.slice(-2)} ${operation}`).toBe(true);
                  if (operation !== 'metadata') {
                    expect(attempt.reasons, `${principalId.slice(-2)} ${operation}`).toContain(
                      'deny.insufficient_grant',
                    );
                  }
                } else if (operation === 'upload') {
                  allowedUploads += 1;
                }
              }
            }
            // Only the allowed upload reserved a row; every refused one left no asset behind.
            expect(yield* assetCount(world)).toBe(before + allowedUploads);
            // Only the rename holder's rename ran, and only the confirm holder's confirm moved the file.
            expect((yield* rowOf(world, readyRef.resourceId))?.display_filename).toBe(
              `By-${RENAME_HOLDER.slice(-2)}.pdf`,
            );
            expect((yield* rowOf(world, reserved.mediaAssetRef.resourceId))?.processing_status).toBe('ready');
          }),
        ),
    );

    suite.effect('the bootstrapped owner holds all four capabilities and a whole upload runs end to end', () =>
      withMediaWorld((world) =>
        Effect.gen(function* ownerRunsAll() {
          yield* seedMediaTenant(world);
          const reserved = yield* reserve(world, OWNER, 'happy-reserve');
          expect(reserved.processingStatus).toBe('uploaded');
          const verification = yield* storeAndVerify(world, OWNER, reserved.mediaAssetRef);
          const confirmed = yield* confirmAs(world, OWNER, reserved.mediaAssetRef, verification, 'happy-confirm');
          expect(confirmed.processingStatus).toBe('ready');
          const metadata = yield* readAs(world, OWNER, reserved.mediaAssetRef);
          expect(metadata).toMatchObject({ displayFilename: 'Brochure.pdf', processingStatus: 'ready' });
          yield* renameAs(world, OWNER, reserved.mediaAssetRef, 'happy-rename', { name: 'Final.pdf' });
          expect((yield* rowOf(world, reserved.mediaAssetRef.resourceId))?.display_filename).toBe('Final.pdf');
        }),
      ),
    );

    suite.effect('a rename that may only be proposed needs approval and never runs, while a run grant does', () =>
      withMediaWorld((world) =>
        Effect.gen(function* needsApproval() {
          const seeded = yield* seedMediaTenant(world);
          yield* grantOnly(world, seeded, { keys: [RENAME], mode: 'propose', principalId: PROPOSE_HOLDER, slot: 5 });
          yield* grantOnly(world, seeded, { keys: [RENAME], principalId: RENAME_HOLDER, slot: 6 });
          yield* reconcile(world.scenario);
          const ref = yield* seedAsset(world);
          const refusal = yield* refusalOf(
            renameAs(world, PROPOSE_HOLDER, ref, 'propose-rename', { name: 'Parked.pdf' }),
          );
          expect(Schema.is(ActionPermissionDenied)(refusal) ? refusal.code : undefined).toBe(
            'action_approval_required',
          );
          expect((yield* rowOf(world, ref.resourceId))?.display_filename).toBe('Brochure.pdf');
          // The negative control: a run grant for the very same Action runs it.
          yield* renameAs(world, RENAME_HOLDER, ref, 'run-rename', { name: 'Run.pdf' });
          expect((yield* rowOf(world, ref.resourceId))?.display_filename).toBe('Run.pdf');
        }),
      ),
    );

    suite.effect(
      'an engine that cannot be reached stops every capability: a retryable refusal, no handler effect, and the same grants run on the live engine',
      () =>
        withMediaWorld((world) =>
          Effect.gen(function* engineUnavailable() {
            yield* seedMediaTenant(world);
            const reserved = yield* reserve(world, OWNER, 'unavailable-prepare');
            const verification = yield* storeAndVerify(world, OWNER, reserved.mediaAssetRef);
            const readyRef = yield* seedAsset(world);
            const before = yield* assetCount(world);

            const upload = yield* refusalOf(reserve(world, OWNER, 'unavailable-upload', { runtime: 'dead' }));
            const confirm = yield* refusalOf(
              confirmAs(world, OWNER, reserved.mediaAssetRef, verification, 'unavailable-confirm', { runtime: 'dead' }),
            );
            const rename = yield* refusalOf(
              renameAs(world, OWNER, readyRef, 'unavailable-rename', { runtime: 'dead' }),
            );
            const read = yield* readRefusalOf(readAs(world, OWNER, readyRef, { runtime: 'dead' }));
            for (const refusal of [upload, confirm, rename]) {
              expect(Schema.is(ActionPermissionCheckError)(refusal)).toBe(true);
            }
            expect(Schema.is(ReadPermissionUnavailable)(read)).toBe(true);
            // Nothing moved: no row, no new status, no new name.
            expect(yield* assetCount(world)).toBe(before);
            expect((yield* rowOf(world, reserved.mediaAssetRef.resourceId))?.processing_status).toBe('uploaded');
            expect((yield* rowOf(world, readyRef.resourceId))?.display_filename).toBe('Brochure.pdf');
            const decision = yield* world.dead.boundGate.decide({
              carrier: carrierOf(renameDisplayFilenameAction.descriptor),
              legalEntityScope: 'optional',
              now: DECISION_AT,
              scope: yield* world.scenario.scopeFor(OWNER),
              target: targetOf(readyRef.resourceId),
            });
            expect(decision.outcome).toBe('UNAVAILABLE');

            // The negative control: the same owner on the live engine runs each of them.
            yield* reserve(world, OWNER, 'unavailable-upload-live');
            yield* confirmAs(world, OWNER, reserved.mediaAssetRef, verification, 'unavailable-confirm-live');
            yield* renameAs(world, OWNER, readyRef, 'unavailable-rename-live', { name: 'Live.pdf' });
            expect(yield* readAs(world, OWNER, readyRef)).toMatchObject({ displayFilename: 'Live.pdf' });

            // A machine is stopped too while the engine is unreachable, bound or not: the outage is never an allow.
            const beforeMachine = yield* assetCount(world);
            const unbound = yield* refusalOf(
              reserve(world, INTEGRATION_MACHINE, 'machine-dead-unbound', { runtime: 'dead' }),
            );
            expect(Schema.is(ActionPermissionCheckError)(unbound)).toBe(true);
            expect(yield* assetCount(world)).toBe(beforeMachine);
            yield* world.scenario.bindWorkload({ principalId: INTEGRATION_MACHINE, workloadKey: INGEST });
            const boundDead = yield* Effect.exit(
              reserve(world, INTEGRATION_MACHINE, 'machine-dead-bound', { runtime: 'dead' }),
            );
            expect(Schema.is(ActionPermissionCheckError)(failureOf(boundDead))).toBe(true);
            expect(yield* assetCount(world)).toBe(beforeMachine);
          }),
        ),
    );

    suite.effect(
      'a missing declaration, an entry the tenant release never published and a missing installation row are not allows',
      () =>
        withMediaWorld((world) =>
          Effect.gen(function* notAnAllow() {
            yield* seedMediaTenant(world);
            const { scenario } = world;
            const ref = yield* seedAsset(world);

            // A protected entrypoint that reached the gate with no carrier at all is refused by the seam itself.
            const missing = yield* scenario.decide({ carrier: {}, legalEntityScope: 'optional', principalId: OWNER });
            expect(missing.outcome).toBe('DENIED');
            expect(missing.reasons.map(({ code }) => code)).toContain('deny.declaration_missing');

            // A well-formed declaration whose capability no release published gives even the full-access owner nothing.
            const unreleasedEntrypoint = defineSystemModuleEntrypoint({
              access: 'read',
              authorization: { kind: 'protected' },
              entrypointKey: 'core.media.api.asset-unreleased',
              moduleKey: 'core.media',
              role: 'api',
            });
            const unreleased = decodeAccessDeclarationOrThrow(
              {
                key: 'core.media.asset-unreleased.read',
                kind: 'read',
                modes: ['run'],
                placement: { group: 'media', level: 'basic' },
                risk: 'routine',
                selectors: ['all'],
              },
              unreleasedEntrypoint,
            );
            const unreleasedDecision = yield* world.live.gate.decide({
              carrier: { accessDeclaration: unreleased },
              legalEntityScope: 'optional',
              now: DECISION_AT,
              scope: yield* scenario.scopeFor(OWNER),
              target: targetOf(ref.resourceId),
            });
            expect(unreleasedDecision.outcome).toBe('DENIED');

            // The negative control: the declarations that were released do allow the owner.
            const released = yield* scenario.decide({
              carrier: carrierOf(uploadAssetAction.descriptor),
              legalEntityScope: 'optional',
              principalId: OWNER,
            });
            expect(released.outcome).toBe('ALLOWED');

            // Ending the tenant's core.media installation stops all four capabilities for the very owner who held them.
            const reservedBefore = yield* reserve(world, OWNER, 'inst-reserve-live');
            const confirmVerification = yield* storeAndVerify(world, OWNER, reservedBefore.mediaAssetRef);
            yield* scenario.admin.unsafe(
              `update core.tenant_module_states set state = 'suspended', updated_at = now()
             where tenant_id = $1 and module_key = 'core.media'`,
              [scenario.tenantId],
            );
            yield* reconcile(scenario);
            const uploadCount = yield* assetCount(world);
            const refused = {
              confirm: yield* attemptOf(
                confirmAs(world, OWNER, reservedBefore.mediaAssetRef, confirmVerification, 'inst-confirm'),
              ),
              metadata: yield* attemptOf(readAs(world, OWNER, ref)),
              rename: yield* attemptOf(renameAs(world, OWNER, ref, 'inst-rename', { name: 'Installed.pdf' })),
              upload: yield* attemptOf(reserve(world, OWNER, 'inst-upload')),
            };
            for (const [operation, attempt] of Object.entries(refused)) {
              expect(attempt.ran, operation).toBe(false);
              expect(attempt.gateRefused, operation).toBe(true);
            }
            expect(yield* assetCount(world)).toBe(uploadCount);
            expect((yield* rowOf(world, ref.resourceId))?.display_filename).toBe('Brochure.pdf');

            // Reinstalling restores exactly what the owner held, and nothing the owner did not.
            yield* scenario.admin.unsafe(
              `update core.tenant_module_states set state = 'active', updated_at = now()
             where tenant_id = $1 and module_key = 'core.media'`,
              [scenario.tenantId],
            );
            yield* reconcile(scenario);
            expect((yield* attemptOf(readAs(world, OWNER, ref))).ran).toBe(true);
          }),
        ),
    );

    suite.effect('a tenant that never installed core.media has no capability to allow, even for its owner', () =>
      withMediaWorld((world) =>
        Effect.gen(function* neverInstalled() {
          yield* seedMediaTenant(world, { installCoreMedia: false });
          const ref = yield* seedAsset(world);
          const before = yield* assetCount(world);
          for (const attempt of [
            yield* attemptOf(reserve(world, OWNER, 'never-upload')),
            yield* attemptOf(renameAs(world, OWNER, ref, 'never-rename')),
            yield* attemptOf(readAs(world, OWNER, ref)),
          ]) {
            expect(attempt.ran).toBe(false);
            expect(attempt.gateRefused).toBe(true);
          }
          expect(yield* assetCount(world)).toBe(before);
          expect((yield* rowOf(world, ref.resourceId))?.display_filename).toBe('Brochure.pdf');
        }),
      ),
    );

    suite.effect(
      'machine origins hold no implicit grant: the ingest workload binding admits the two upload legs only, per principal and per key',
      () =>
        withMediaWorld((world) =>
          Effect.gen(function* machineWorkloads() {
            const seeded = yield* seedMediaTenant(world);
            const { scenario } = world;
            const readyRef = yield* seedAsset(world);
            const machines = [
              { origin: 'system', principalId: SYSTEM_MACHINE },
              { origin: 'integration', principalId: INTEGRATION_MACHINE },
              { origin: 'import', principalId: IMPORT_MACHINE },
            ] as const;
            // Someone else's reservation: a machine that was never bound must not confirm it either.
            const foreign = yield* reserve(world, OWNER, 'machine-owner-reserve');
            const foreignVerification = yield* storeAndVerify(world, OWNER, foreign.mediaAssetRef);
            for (const { origin, principalId } of machines) {
              const before = yield* assetCount(world);
              // Unbound: the principal kind and the stated origin alone grant nothing, on either leg.
              const unboundUpload = yield* refusalOf(
                reserve(world, principalId, `${origin}-unbound`, { ingestionSource: origin }),
              );
              expect(reasonsOfAction(unboundUpload)).toContain('deny.workload_unbound');
              const unboundConfirm = yield* refusalOf(
                confirmAs(world, principalId, foreign.mediaAssetRef, foreignVerification, `${origin}-unbound-confirm`),
              );
              expect(reasonsOfAction(unboundConfirm)).toContain('deny.workload_unbound');
              expect(yield* assetCount(world)).toBe(before);

              // A binding for another workload key does not admit the carrier that names core.media.ingest.
              yield* scenario.bindWorkload({ principalId, workloadKey: `core.media.${origin}-other` });
              const otherKey = yield* refusalOf(
                reserve(world, principalId, `${origin}-other-key`, { ingestionSource: origin }),
              );
              expect(reasonsOfAction(otherKey)).toContain('deny.workload_unbound');

              // The binding of the carrier's own key admits both legs of an upload, and the origin stays provenance.
              yield* scenario.bindWorkload({ principalId, workloadKey: INGEST });
              const reserved = yield* reserve(world, principalId, `${origin}-bound`, { ingestionSource: origin });
              expect(yield* rowOf(world, reserved.mediaAssetRef.resourceId)).toMatchObject({
                ingested_by_principal_id: principalId,
                ingestion_source: origin,
                processing_status: 'uploaded',
              });
              const verification = yield* storeAndVerify(world, principalId, reserved.mediaAssetRef);
              const confirmed = yield* confirmAs(
                world,
                principalId,
                reserved.mediaAssetRef,
                verification,
                `${origin}-confirm`,
              );
              expect(confirmed.processingStatus).toBe('ready');

              // The workload carrier is the upload's alone: rename and metadata read are people's declarations, so a
              // bound machine is refused there whatever it is bound to.
              const rename = yield* refusalOf(renameAs(world, principalId, readyRef, `${origin}-rename`));
              expect(reasonsOfAction(rename)).toContain('deny.workload_forbidden');
              const read = yield* attemptOf(readAs(world, principalId, readyRef));
              expect(read).toMatchObject({ gateRefused: true, ran: false });
              expect((yield* rowOf(world, readyRef.resourceId))?.display_filename).toBe('Brochure.pdf');

              // Revoking the binding ends the admission for the very next request.
              yield* scenario.revokeWorkload({ principalId, workloadKey: INGEST });
              const revoked = yield* refusalOf(
                reserve(world, principalId, `${origin}-revoked`, { ingestionSource: origin }),
              );
              expect(reasonsOfAction(revoked)).toContain('deny.workload_unbound');
            }

            // A human is never admitted by the machine carrier's binding: with no declared grant, the stated origin is
            // only a label and a human without a role is refused for every origin.
            yield* memberWithoutRole(world, seeded, PLAIN, 'member');
            yield* reconcile(scenario);
            const before = yield* assetCount(world);
            for (const origin of ['user', 'system', 'integration', 'import'] as const) {
              const refusal = yield* refusalOf(reserve(world, PLAIN, `plain-${origin}`, { ingestionSource: origin }));
              expect(reasonsOfAction(refusal)).toContain('deny.insufficient_grant');
            }
            expect(yield* assetCount(world)).toBe(before);
          }),
        ),
    );

    suite.effect('an agent is refused every capability in this wave, even holding all four through a role', () =>
      withMediaWorld((world) =>
        Effect.gen(function* agentRefused() {
          const seeded = yield* seedMediaTenant(world);
          const { scenario } = world;
          yield* insertRoleWithCells(scenario.admin, scenario.tenantId, {
            capabilityKeys: [UPLOAD, CONFIRM, METADATA, RENAME],
            catalogSnapshotId: seeded.bootstrapped.catalogSnapshotId,
            createdBy: OWNER,
            roleId: uid(900),
            roleRevisionId: uid(901),
            scopeId: seeded.tenantScope,
          });
          yield* insertMembership(scenario.admin, scenario.tenantId, {
            agentId: AGENT,
            kind: 'member',
            recordedBy: OWNER,
            scopeId: seeded.tenantScope,
          });
          yield* insertAssignment(scenario.admin, scenario.tenantId, {
            agentId: AGENT,
            assignedBy: OWNER,
            incarnationId: uid(902),
            roleId: uid(900),
            roleRevisionId: uid(901),
            scopeId: seeded.tenantScope,
          });
          yield* reconcile(scenario);
          const ref = yield* seedAsset(world);
          const reserved = yield* reserve(world, OWNER, 'agent-owner-reserve');
          const verification = yield* storeAndVerify(world, OWNER, reserved.mediaAssetRef);
          const before = yield* assetCount(world);
          const upload = yield* refusalOf(reserve(world, AGENT, 'agent-upload'));
          const rename = yield* refusalOf(renameAs(world, AGENT, ref, 'agent-rename'));
          const confirm = yield* refusalOf(
            confirmAs(world, AGENT, reserved.mediaAssetRef, verification, 'agent-confirm'),
          );
          const read = yield* attemptOf(readAs(world, AGENT, ref));
          expect(reasonsOfAction(upload)).toContain('deny.agent_forbidden');
          expect(reasonsOfAction(confirm)).toContain('deny.agent_forbidden');
          expect((yield* rowOf(world, reserved.mediaAssetRef.resourceId))?.processing_status).toBe('uploaded');
          expect(reasonsOfAction(rename)).toContain('deny.agent_forbidden');
          expect(read).toMatchObject({ gateRefused: true, ran: false });
          expect(yield* assetCount(world)).toBe(before);
          expect((yield* rowOf(world, ref.resourceId))?.display_filename).toBe('Brochure.pdf');
          // The negative control: the human who administers the same tenant runs the same capabilities.
          expect((yield* attemptOf(readAs(world, OWNER, ref))).ran).toBe(true);
        }),
      ),
    );

    suite.effect(
      'an existing asset, its uploader and a media link grant nothing: only a granted capability reads or renames it',
      () =>
        withMediaWorld((world) =>
          Effect.gen(function* noImplicitGrant() {
            const seeded = yield* seedMediaTenant(world);
            const { scenario } = world;
            yield* grantOnly(world, seeded, { keys: [UPLOAD], principalId: UPLOAD_HOLDER, slot: 1 });
            yield* grantOnly(world, seeded, { keys: [METADATA], principalId: METADATA_HOLDER, slot: 3 });
            yield* memberWithoutRole(world, seeded, PLAIN, 'member');
            yield* reconcile(scenario);

            // The uploader reserves a file of their own: they ingested it, but that is a fact, not a permission.
            const reserved = yield* reserve(world, UPLOAD_HOLDER, 'uploader-reserve');
            const own = reserved.mediaAssetRef;
            expect((yield* rowOf(world, own.resourceId))?.ingested_by_principal_id).toBe(UPLOAD_HOLDER);
            // A business reference to the asset (a media link written by another owner's flow) is also only a fact.
            yield* scenario.admin.unsafe(
              `insert into core.media_links (tenant_id, media_asset_id, action_invocation_id, link_source, target_module_key,
               target_resource_type, target_resource_id, link_kind)
             values ($1, $2, $2, 'user', 'commerce.catalog', 'commerce.catalog.product', 'product-1', 'image')`,
              [scenario.tenantId, own.resourceId],
            );
            const beforeName = (yield* rowOf(world, own.resourceId))?.display_filename;

            const uploaderRead = yield* attemptOf(readAs(world, UPLOAD_HOLDER, own));
            const uploaderRename = yield* refusalOf(renameAs(world, UPLOAD_HOLDER, own, 'uploader-rename'));
            const plainRead = yield* attemptOf(readAs(world, PLAIN, own));
            const readerRename = yield* refusalOf(renameAs(world, METADATA_HOLDER, own, 'reader-rename'));
            expect(uploaderRead).toMatchObject({ gateRefused: true, ran: false });
            expect(plainRead).toMatchObject({ gateRefused: true, ran: false });
            expect(reasonsOfAction(uploaderRename)).toContain('deny.insufficient_grant');
            expect(reasonsOfAction(readerRename)).toContain('deny.insufficient_grant');
            expect((yield* rowOf(world, own.resourceId))?.display_filename).toBe(beforeName);

            // The negative control: the metadata capability itself reads the very same asset.
            expect(yield* readAs(world, METADATA_HOLDER, own)).toMatchObject({ processingStatus: 'uploaded' });
          }),
        ),
    );

    suite.effect(
      'a foreign tenant and a foreign company get nothing: refs, identities and grants stay inside the trusted scope',
      () =>
        withMediaWorld((world) =>
          Effect.gen(function* tenantAndCompanyScope() {
            const seeded = yield* seedMediaTenant(world);
            const { scenario } = world;
            const foreignTenantId = uid(7000);
            yield* world.bootstrapForeign({
              legalEntityIds: [uid(7001)],
              principalId: FOREIGN_OWNER,
              tenantId: foreignTenantId,
            });
            const own = yield* seedAsset(world);
            const foreign = yield* seedAsset(world, { tenantId: foreignTenantId });

            // The foreign tenant's owner holds every capability in THEIR tenant, yet their trusted scope can neither
            // read nor rename an asset of this one: the ref of another tenant is the answer a missing asset gets.
            const foreignScope = yield* scopeOf({
              principalId: FOREIGN_OWNER,
              tenantId: TenantIdSchema.make(foreignTenantId),
            });
            const read = yield* Effect.exit(
              world.live.runRead({
                input: { mediaAssetRef: own },
                principal: foreignScope,
                registration: assetMetadataRead,
                transport: { correlationId: 'foreign-read' },
              }),
            );
            expect(Schema.is(ReadHandlerNotFound)(failureOf(read))).toBe(true);
            const rename = yield* Effect.exit(
              world.live.runAction({
                payload: {
                  displayFilename: displayFilenameOf('Stolen.pdf'),
                  mediaAssetRef: own,
                },
                principal: foreignScope,
                registration: renameDisplayFilenameAction,
                transport: transport('foreign-rename'),
              }),
            );
            expect(Schema.is(MediaAssetNotFound)(failureOf(rename))).toBe(true);
            expect((yield* rowOf(world, own.resourceId))?.display_filename).toBe('Brochure.pdf');
            // And the reverse: this tenant's owner meets the same answer for the foreign asset.
            const reverse = yield* Effect.exit(readAs(world, OWNER, foreign));
            expect(Schema.is(ReadHandlerNotFound)(failureOf(reverse))).toBe(true);
            expect((yield* rowOf(world, foreign.resourceId, foreignTenantId))?.display_filename).toBe('Brochure.pdf');

            // The foreign owner's identity is no principal of this tenant: asked in this tenant's scope the gate refuses.
            const decision = yield* scenario.decide({
              carrier: carrierOf(assetMetadataRead.descriptor),
              legalEntityScope: 'optional',
              principalId: FOREIGN_OWNER,
            });
            expect(decision.outcome).toBe('DENIED');

            // The four capabilities declare an OPTIONAL legal entity, so the gate decides in the tenant context: a role held
            // only inside one company never authorizes them, whichever company the request names (or none).
            yield* grantOnly(world, seeded, {
              keys: [UPLOAD, METADATA, RENAME],
              legalEntityId: COMPANY_A,
              principalId: UPLOAD_HOLDER,
              slot: 1,
            });
            yield* reconcile(scenario);
            const before = yield* assetCount(world);
            for (const legalEntityId of [COMPANY_A, COMPANY_B, undefined]) {
              const named = withOptional({}, 'legalEntityId', legalEntityId);
              const stamp = legalEntityId ?? 'none';
              const refused = yield* refusalOf(reserve(world, UPLOAD_HOLDER, `company-role-${stamp}`, named));
              expect(reasonsOfAction(refused)).toContain('deny.insufficient_grant');
              const renameRefused = yield* refusalOf(
                renameAs(world, UPLOAD_HOLDER, own, `company-rename-${stamp}`, named),
              );
              expect(reasonsOfAction(renameRefused)).toContain('deny.insufficient_grant');
              expect(yield* attemptOf(readAs(world, UPLOAD_HOLDER, own, named))).toMatchObject({
                gateRefused: true,
                ran: false,
              });
            }
            expect((yield* rowOf(world, own.resourceId))?.display_filename).toBe('Brochure.pdf');
            expect(yield* assetCount(world)).toBe(before);
            // The negative control: the same capability granted in the tenant context runs for any named company, and
            // the company stays an attribute of the asset, never an authorization input.
            yield* grantOnly(world, seeded, { keys: [UPLOAD], principalId: UPLOAD_HOLDER, slot: 2 });
            yield* reconcile(scenario);
            const inB = yield* reserve(world, UPLOAD_HOLDER, 'tenant-role-b', { legalEntityId: COMPANY_B });
            expect(yield* rowOf(world, inB.mediaAssetRef.resourceId)).toMatchObject({ processing_status: 'uploaded' });
          }),
        ),
    );

    suite.effect(
      'knowing a media asset id grants nothing: a grant on named records reaches exactly those records',
      () =>
        withMediaWorld((world) =>
          Effect.gen(function* exactTargets() {
            const seeded = yield* seedMediaTenant(world);
            const { scenario } = world;
            const assetA = yield* seedAsset(world, { legalEntityId: COMPANY_A });
            const assetB = yield* seedAsset(world, { legalEntityId: COMPANY_A });
            // The existing target mechanism of the declaration's `all` selector: one role names one exact asset id.
            yield* grantOnly(world, seeded, {
              keys: [METADATA],
              principalId: METADATA_HOLDER,
              selector: { _tag: 'targets', recordKeys: [RecordKeySchema.make(assetA.resourceId)] },
              slot: 3,
            });
            yield* reconcile(scenario);
            expect(yield* readAs(world, METADATA_HOLDER, assetA)).toMatchObject({ processingStatus: 'ready' });
            // The same person holds the capability, knows the other asset's exact ref, and still gets nothing of it.
            const other = yield* attemptOf(readAs(world, METADATA_HOLDER, assetB));
            expect(other).toMatchObject({ gateRefused: true, ran: false });
          }),
        ),
    );

    suite.effect(
      'a revoked grant stops the next request: unassigning, removing the engine relationship and revoking one cell each take effect at once, and no earlier result or decision is reused',
      () =>
        withMediaWorld((world) =>
          Effect.gen(function* revocation() {
            const seeded = yield* seedMediaTenant(world);
            const { scenario } = world;
            const granted = yield* grantOnly(world, seeded, {
              keys: [UPLOAD, METADATA, RENAME],
              principalId: UPLOAD_HOLDER,
              slot: 1,
            });
            yield* reconcile(scenario);
            const ref = yield* seedAsset(world);
            const runAll = (suffix: string) =>
              Effect.all(
                {
                  metadata: attemptOf(readAs(world, UPLOAD_HOLDER, ref)),
                  rename: attemptOf(renameAs(world, UPLOAD_HOLDER, ref, `rename-${suffix}`, { name: `${suffix}.pdf` })),
                  upload: attemptOf(reserve(world, UPLOAD_HOLDER, `upload-${suffix}`)),
                },
                { concurrency: 1 },
              );
            const allRan = { metadata: true, rename: true, upload: true };
            const noneRan = { metadata: false, rename: false, upload: false };

            expect(ranOf(yield* runAll('first'))).toEqual(allRan);
            // While granted, a lost reply is answered again from the saved reply: the control for the refusal below.
            const saved = yield* reserve(world, UPLOAD_HOLDER, 'upload-saved', { savedReply: 'answer' });
            expect(yield* reserve(world, UPLOAD_HOLDER, 'upload-saved', { savedReply: 'answer' })).toEqual(saved);

            // Unassigning the role: the very next request of each capability is refused, and the earlier upload result is
            // not replayed to a holder who no longer has the permission.
            yield* scenario.admin.unsafe(
              `update core.access_assignments set status = 'revoked' where tenant_id = $1 and incarnation_id = $2`,
              [scenario.tenantId, granted.assignmentId],
            );
            yield* reconcile(scenario);
            const countAfterRevoke = yield* assetCount(world);
            expect(ranOf(yield* runAll('revoked'))).toEqual(noneRan);
            const replay = yield* Effect.exit(reserve(world, UPLOAD_HOLDER, 'upload-saved', { savedReply: 'answer' }));
            expect(Schema.is(ActionAlreadyCommitted)(failureOf(replay))).toBe(true);
            expect(yield* assetCount(world)).toBe(countAfterRevoke);
            expect((yield* rowOf(world, ref.resourceId))?.display_filename).toBe('first.pdf');

            // A fresh assignment of the same role restores the capabilities: the refusal was the revocation, nothing else.
            yield* insertAssignment(scenario.admin, scenario.tenantId, {
              assignedBy: OWNER,
              incarnationId: uid(1013),
              principalId: UPLOAD_HOLDER,
              roleId: granted.roleId,
              roleRevisionId: uid(1011),
              scopeId: granted.scopeId,
            });
            yield* reconcile(scenario);
            expect(ranOf(yield* runAll('regranted'))).toEqual(allRan);

            // Removing the engine relationship of the assignment, without any reconcile, stops the next request too.
            const client = newSpiceDbGrpcClient(world.spiceDb);
            yield* Effect.tryPromise(() =>
              client.promises.deleteRelationships(
                v1.DeleteRelationshipsRequest.create({
                  relationshipFilter: v1.RelationshipFilter.create({
                    optionalResourceId: assignmentObjectId(scenario.tenantId, granted.scopeId, uid(1013)),
                    resourceType: objectTypeOf('assignment'),
                  }),
                }),
              ),
            ).pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => client.close())));
            expect(ranOf(yield* runAll('unrelated'))).toEqual(noneRan);
            yield* reconcile(scenario);
            expect(ranOf(yield* runAll('reconciled'))).toEqual(allRan);

            // Revoking one cell removes that capability alone: the rename stops while the upload and the read still run.
            yield* scenario.admin.unsafe(
              `update core.access_grant_incarnations set status = 'retired'
             where tenant_id = $1 and role_id = $2 and capability_key = $3`,
              [scenario.tenantId, granted.roleId, RENAME],
            );
            yield* reconcile(scenario);
            expect(ranOf(yield* runAll('cell'))).toEqual({ metadata: true, rename: false, upload: true });
            expect((yield* rowOf(world, ref.resourceId))?.display_filename).toBe('reconciled.pdf');
          }),
        ),
    );
  },
);
