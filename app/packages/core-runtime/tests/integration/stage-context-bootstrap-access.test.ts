import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Context, Crypto, DateTime, Effect, Layer, Schema } from 'effect';
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
import { tenantContextScopeId } from '../../src/access/bootstrap/persistence.ts';
import {
  AccessDecisionLogLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  LegalEntityCandidatesLive,
} from '../../src/actions/runtime-wiring.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { makeSpiceDbDecisionCheckPort } from '../../src/access/decision/spicedb-check-port.ts';
import { spiceDbTransport } from '#spicedb-transport';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { reconcileStageContextBootstraps } from '../../src/install/stage-context-bootstrap.ts';
import type { StageTenantBootstrap } from '../../src/install/stage-context-bootstrap.ts';
import { createTemplateDatabase, replacedDatabase } from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

/*
 * The stage bootstrap, end to end (CUTOVER-PLAN §3.5, ADR-0028, O67-Q6). An operator accounts file
 * creates a tenant the way a product tenant is created — identity rows, then `bootstrapTenantAccess`,
 * then one reconcile through the single Core writer — and the real gate answers the capabilities of the
 * release. Every claim carries its negative control: a named account without a role holds nothing, and a
 * retired tenant stops deciding.
 *
 * Each case gets its own database beside the integration environment's, and its own random tenant in the
 * environment's SpiceDB.
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

/** The composition the stage run is handed: the tenant's module and Core's own (O69). */
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
const actionCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(action, actionEntrypoint) };
const coreReadCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(coreRead, coreReadEntrypoint) };

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

const INSTALLATION_OPTIONS = { authenticationNamespaceId: 'staff', modules } as const;

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
  ) => Effect.Effect<readonly { readonly owner: boolean; readonly principalId: string }[], StageFailure>;
  /** The case's own tenant: random, so no case reads another case's tuples in the shared engine. */
  readonly tenantId: string;
}

const withStage = <Value, Failure>(run: (stage: Stage) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* stageScenario() {
    const crypto = yield* Crypto.Crypto;
    const [connections, spiceDb] = yield* Effect.all([loadDatabaseConnectionPair(), loadSpiceDbConfig()], {
      concurrency: 2,
    }).pipe(Effect.orDie);
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `stage_bootstrap_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
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
      decide: ({ carrier, principalId, tenantId }) =>
        Effect.flatMap(scopeFor(tenantId, principalId), (scope) =>
          gate.decide({ carrier, legalEntityScope: 'forbidden', now: decisionAt, scope }),
        ).pipe(Effect.provide(context)),
      project: (scope) =>
        projectionWriter.reconcileTenant({ scope }).pipe(Effect.mapError(asStageFailure), Effect.provide(context)),
      reconcile: (input) =>
        reconcileStageContextBootstraps(input, INSTALLATION_OPTIONS).pipe(
          Effect.mapError(asStageFailure),
          Effect.provide(context),
        ),
      tenantId: yield* crypto.randomUUIDv4(),
    });
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)('stage context bootstrap', (suite) => {
  suite.effect('creates the tenant for its owner, its full-access colleague and nobody else', () =>
    withStage((stage) =>
      Effect.gen(function* createsStageTenant() {
        const { tenantId } = stage;
        const results = yield* stage
          .reconcile({ retiredTenants: [], tenants: [tenantBootstrap(tenantId)] })
          .pipe(failClosed);
        expect(results.map(({ owner: isOwner, principalId }) => ({ owner: isOwner, principalId }))).toEqual([
          { owner: true, principalId: owner },
          { owner: false, principalId: colleague },
          { owner: false, principalId: unassigned },
        ]);
        // The owner holds the release: both the module's capabilities and Core's own.
        for (const carrier of [readCarrier, actionCarrier, coreReadCarrier]) {
          const decision = yield* stage.decide({ carrier, principalId: owner, tenantId });
          expect(decision.outcome).toBe('ALLOWED');
        }
        // The colleague the file names with `full_access` holds it too — a second assignment of the same
        // role in the same scope, which is what the stage bootstrap adds beside the owner's.
        expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
          'ALLOWED',
        );
        // The negative control: a named account without a role holds nothing, and no member default exists.
        // The stage bootstrap gives it identity rows but no membership, so the gate refuses it at the scope
        // before any grant is read (R5a-1).
        const denied = yield* stage.decide({ carrier: readCarrier, principalId: unassigned, tenantId });
        expect(denied.outcome).toBe('DENIED');
        expect(denied.reasons.map(({ code }) => code)).toContain('deny.scope_mismatch');
        // The tenant is a real scope of the v2 model, not a legacy tuple set.
        const scopes = yield* stage.admin
          .unsafe<{ scope_id: string }>(`select scope_id from core.access_scopes where tenant_id = '${tenantId}'`)
          .pipe(Effect.orDie);
        expect(scopes.map(({ scope_id: scopeId }) => scopeId)).toContain(
          tenantContextScopeId(TenantIdSchema.make(tenantId)),
        );
      }),
    ),
  );

  suite.effect('reconciles an unchanged stage tenant to nothing, so a re-run is a no-op', () =>
    withStage((stage) =>
      Effect.gen(function* reconcilesIdempotently() {
        const { tenantId } = stage;
        yield* stage.reconcile({ retiredTenants: [], tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
        const scope = yield* scopeFor(tenantId, owner);
        const repeated = yield* stage.project(scope).pipe(failClosed);
        // The intent did not move, so the plan and the graph are equal: nothing is written and the writer
        // records the intent it verified.
        expect(repeated.touches).toBe(0);
        expect(repeated.deletions).toBe(0);
        expect(repeated.verified).toBe(true);
        // Running the whole stage bootstrap again resumes what it wrote instead of adding to it.
        yield* stage.reconcile({ retiredTenants: [], tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
        const after = yield* stage.project(scope).pipe(failClosed);
        expect(after.touches).toBe(0);
        expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('a retired stage tenant stops deciding', () =>
    withStage((stage) =>
      Effect.gen(function* retiresTenant() {
        const { tenantId } = stage;
        yield* stage.reconcile({ retiredTenants: [], tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
        expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe('ALLOWED');
        // The operator removes the tenant from the file and names it as retired: its memberships and
        // assignments are revoked in intent and the reconcile takes the tuples with them.
        const retired = yield* stage
          .reconcile({
            retiredTenants: [
              {
                legalEntityId: LegalEntityIdSchema.make(company),
                principalIds: [PrincipalIdSchema.make(owner)],
                tenantId: TenantIdSchema.make(tenantId),
              },
            ],
            tenants: [],
          })
          .pipe(failClosed);
        expect(retired).toEqual([]);
        // The negative control: nothing of the retired tenant answers any more.
        for (const principalId of [owner, colleague]) {
          const decision = yield* stage.decide({ carrier: readCarrier, principalId, tenantId });
          expect(decision.outcome).toBe('DENIED');
        }
        const counts = yield* stage.admin
          .unsafe<{ count: string }>(
            `select count(*)::text as count from core.access_assignments
             where tenant_id = '${tenantId}' and status = 'active'`,
          )
          .pipe(Effect.orDie);
        expect(counts.map(({ count }) => count)).toEqual(['0']);
      }),
    ),
  );
});
