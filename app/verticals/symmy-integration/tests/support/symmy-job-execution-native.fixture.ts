import { createHash } from 'node:crypto';

import {
  ActionAuthorizationPreflightDatabaseLive,
  ActiveApplicationCompositionService,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  OntosModuleDeploymentContractSchema,
  ReadHandlerUnavailable,
  TenantModuleStateServiceLive,
  applicationCompositionContentRevision,
  canonicalOntosPublicApiKey,
  defineAction,
  defineOntosModuleManifest,
  defineRead,
  defineTenantModuleEntrypoint,
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  makeActionRuntimeLive,
  makeReadRuntimeLive,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type {
  ActionHandlerContext,
  ActiveApplicationCompositionSnapshot,
  OperationalScope,
  ReadHandlerContext,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { SymmyEffectOutcomeSchema, SymmyOwnerEffectRefSchema } from '@app/shared-contracts/symmy';
import type { SymmyOwnerEffectRef } from '@app/shared-contracts/symmy';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { jsonb, pgSchema, uuid } from 'drizzle-orm/pg-core';
import { assert } from 'effect-rstest';
import { Array as EffectArray, Effect, Layer, Option, Order, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { symmyIntegrationManifest } from '../../vertical.manifest.ts';

const fixtureModuleId = 'integration.symmy';
const fixtureDomainEvents = {};
const digest = (document: string) => createHash('sha256').update(document).digest('hex');
export const fixtureWorkload = 'integration.symmy-fixture-effect';
export const fixtureOperation = {
  entrypointKey: 'integration.symmy.fixture-effect',
  moduleId: fixtureModuleId,
  schemaVersion: '1',
} as const;

// This internal owner is deliberately not a Catalog/Commerce adapter. Its table, operations and
// public contracts exist only in this disposable test deployment.
const receipts = pgSchema('symmy_integration').table('native_effect_receipts', {
  effectId: uuid('effect_id').primaryKey(),
  reference: jsonb('reference').$type<SymmyOwnerEffectRef>().notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

export class NativeEffectUnavailable extends Schema.TaggedError<NativeEffectUnavailable>()('NativeEffectUnavailable', {
  reason: Schema.String,
}) {}

const recoverySchema = Schema.Struct({
  outcome: Schema.OptionFromNullOr(SymmyEffectOutcomeSchema),
});
const sameEffectReference = Schema.toEquivalence(SymmyOwnerEffectRefSchema);

const fixtureServices = (transaction: ScopedTransactionExecutor, scope: OperationalScope) => {
  const find = (reference: SymmyOwnerEffectRef) =>
    transaction
      .select()
      .from(receipts)
      .where(and(eq(receipts.effectId, reference.effectId), eq(receipts.tenantId, scope.tenantId)))
      .pipe(Effect.mapError(() => new NativeEffectUnavailable({ reason: 'Fixture receipt storage is unavailable' })));
  return Effect.succeed({
    accept: Effect.fn('SymmyNativeFixture.accept')(function* accept(reference: SymmyOwnerEffectRef) {
      yield* transaction
        .insert(receipts)
        .values({ effectId: reference.effectId, reference, tenantId: scope.tenantId })
        .onConflictDoNothing()
        .pipe(Effect.mapError(() => new NativeEffectUnavailable({ reason: 'Fixture effect commit is unavailable' })));
      const [receipt] = yield* find(reference);
      if (receipt === undefined || !sameEffectReference(receipt.reference, reference)) {
        return yield* new NativeEffectUnavailable({ reason: 'The original fixture effect does not match' });
      }
      return yield* Schema.decodeEffect(SymmyEffectOutcomeSchema)({
        effectId: reference.effectId,
        owner: reference.operation.moduleId,
        status: 'accepted_change',
      }).pipe(Effect.mapError(() => new NativeEffectUnavailable({ reason: 'Fixture outcome is invalid' })));
    }),
    recover: Effect.fn('SymmyNativeFixture.recover')(function* recover(reference: SymmyOwnerEffectRef) {
      const [receipt] = yield* find(reference);
      if (receipt === undefined) {
        return { outcome: Option.none() };
      }
      if (!sameEffectReference(receipt.reference, reference)) {
        return yield* new NativeEffectUnavailable({ reason: 'The original fixture effect does not match' });
      }
      const outcome = yield* Schema.decodeEffect(SymmyEffectOutcomeSchema)({
        effectId: reference.effectId,
        owner: reference.operation.moduleId,
        status: 'accepted_change',
      }).pipe(Effect.mapError(() => new NativeEffectUnavailable({ reason: 'Fixture outcome is invalid' })));
      return { outcome: Option.some(outcome) };
    }),
  });
};
type FixtureServices = Effect.Success<ReturnType<typeof fixtureServices>>;

export const fixtureEffectAction = defineAction(
  {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'integration.symmy.fixture-effect.access.v1' },
    accessWorkload: {
      reason: 'Internal native effect fixture registered system workload',
      workloads: [fixtureWorkload],
    },
    actionKey: fixtureOperation.entrypointKey,
    auditProfile: 'standard',
    domainErrorSchema: NativeEffectUnavailable,
    domainEvents: fixtureDomainEvents,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: fixtureOperation.entrypointKey,
      moduleKey: fixtureModuleId,
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: fixtureModuleId,
    payloadSchema: SymmyOwnerEffectRefSchema,
    policies: [],
    resultSchema: SymmyEffectOutcomeSchema,
    schemaVersion: '1',
  },
  (reference: SymmyOwnerEffectRef, context: ActionHandlerContext<typeof fixtureDomainEvents, FixtureServices>) =>
    context.services.accept(reference),
  fixtureServices,
);

export const fixtureRecoveryRead = defineRead(
  {
    accessKind: 'detail',
    accessWorkload: { reason: 'Internal native original effect recovery workload', workloads: [fixtureWorkload] },
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'integration.symmy.fixture-original-effect',
      moduleKey: fixtureModuleId,
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'integration.symmy.fixture-original-effect.evidence.v1',
    },
    inputSchema: SymmyOwnerEffectRefSchema,
    legalEntityScope: 'optional',
    owningModuleKey: fixtureModuleId,
    policies: [],
    readKey: 'integration.symmy.fixture-original-effect',
    resultSchema: recoverySchema,
    schemaVersion: '1',
  },
  (reference: SymmyOwnerEffectRef, context: ReadHandlerContext<FixtureServices>) =>
    context.services.recover(reference).pipe(
      Effect.map((result) => ({ evidence: { resultCount: Option.isNone(result.outcome) ? 0 : 1 }, result })),
      Effect.mapError(
        () =>
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'Original fixture effect recovery is unavailable',
          }),
      ),
    ),
  fixtureServices,
);

const fixtureRecoveryApi = HttpApi.make('SymmyNativeFixtureRecovery').add(
  HttpApiGroup.make('fixtureRecovery').add(
    HttpApiEndpoint.post('execute', '/fixture-original-effect', {
      payload: SymmyOwnerEffectRefSchema,
      success: recoverySchema,
    }),
  ),
);

export const makeNativeExecutionRegistration = (
  workers: Parameters<typeof defineVerticalRuntimeRegistration>[0]['outboxWorkers'],
) => {
  const manifest = defineOntosModuleManifest({
    ...symmyIntegrationManifest,
    publicSurface: {
      ...symmyIntegrationManifest.publicSurface,
      actions: [...symmyIntegrationManifest.publicSurface.actions, fixtureEffectAction],
      api: { ...symmyIntegrationManifest.publicSurface.api, 'fixture-original-effect': fixtureRecoveryApi },
      operationContracts: [
        ...symmyIntegrationManifest.publicSurface.operationContracts,
        {
          apiKey: 'fixture-original-effect',
          operationKey: 'fixtureRecovery.execute',
          registration: fixtureRecoveryRead,
        },
      ],
    },
  });
  const registration = defineVerticalRuntimeRegistration({
    actions: [...manifest.publicSurface.actions],
    manifest,
    outboxWorkers: [...workers],
    reads: manifest.publicSurface.operationContracts.map(({ registration: readRegistration }) => readRegistration),
  });
  return { manifest, registration };
};

export const makeNativeExecutionSnapshot = Effect.fn('SymmyNativeFixture.composition')(function* makeSnapshot(
  ownerInput: ReturnType<typeof makeNativeExecutionRegistration>,
) {
  const { appId, buildMarker } = ultramodernApiMarker;
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([appId], buildMarker);
  const owner = extractVerticalRuntimeSafeDescriptors(ownerInput.registration);
  const { manifest } = ownerInput;
  const apis = Object.entries(manifest.publicSurface.api).map(([key, api]) => {
    assert.isOk(HttpApi.isHttpApi(api));
    return {
      key: canonicalOntosPublicApiKey(owner.moduleId, key),
      operationKeys: EffectArray.sort(
        Object.values(api.groups).flatMap((group) =>
          Object.values(group.endpoints).map((endpoint) => `${group.identifier}.${endpoint.identifier}`),
        ),
        Order.String,
      ),
    };
  });
  const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
    deployment: { appId, buildMarker },
    manifest: {
      activation: manifest.activation,
      module: manifest.module,
      publicSurface: {
        actions: owner.actions,
        api: apis,
        components: [],
        events: [],
        operationContracts: owner.operationContracts,
        reports: [],
        resourceTypes: manifest.publicSurface.resourceTypes,
        search: [],
        shellContributions: owner.shellContributions,
      },
      requirements: owner.requirements,
    },
    runtime: { outboxSubscriptions: owner.outboxSubscriptions },
    schemaVersion: '2',
  });
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const sha256 = digest(contractDocument);
  const composition = {
    ...snapshot.composition,
    modules: snapshot.composition.modules.map((module) => ({
      ...module,
      contract: { ...module.contract, sha256 },
      contractDocument,
      moduleId: owner.moduleId,
      publicContract: { id: owner.moduleId, sha256, version: contract.schemaVersion },
    })),
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...snapshot,
    composition: { ...composition, revision: yield* applicationCompositionContentRevision(composition) },
  });
});

/** The identical production runtime graph: only database/configuration and test metadata differ. */
export const nativeGovernedRuntimes = (
  configuration: (typeof DatabaseConfig)['Service'],
  snapshot: ActiveApplicationCompositionSnapshot,
  owner: ReturnType<typeof makeNativeExecutionRegistration>['registration'],
) => {
  const persistence = CorePersistenceLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration)));
  const moduleGate = ModuleStateGateLive.pipe(
    Layer.provide(TenantModuleStateServiceLive.pipe(Layer.provide(persistence))),
  );
  const enforcement = AccessDecisionLive.pipe(
    Layer.provideMerge(AccessEnforcementPortsLive),
    Layer.provide(TenantIntentLoaderLive),
    Layer.provide(persistence),
    Layer.provide(Layer.succeed(DatabaseConfig, configuration)),
    Layer.provide(NodeCrypto.layer),
  );
  const dependencies = Layer.mergeAll(
    persistence,
    ContextAccessLive,
    ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleGate)),
    OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive, enforcement))),
    enforcement,
  );
  const composition = Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) });
  return Layer.mergeAll(
    makeActionRuntimeLive(ultramodernDeliveryUnit, owner).pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          moduleGate,
          ActionRepositoryLive,
          ActionPermissionLive,
          ActionAuthorizationPreflightDatabaseLive.pipe(Layer.provide(persistence)),
          composition,
        ),
      ),
    ),
    makeReadRuntimeLive(ultramodernDeliveryUnit, owner).pipe(Layer.provide(dependencies), Layer.provide(composition)),
    persistence,
  ).pipe(Layer.provideMerge(staffAuthenticationNamespaceRegistryLayer(['symmy-integration'])));
};
