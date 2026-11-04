import { PrivacyPartyNativeIdentityError } from './privacy-party-native-identity-error.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  TenantModuleStateServiceLive,
  canonicalizeApplicationComposition,
  canonicalOntosPublicApiKey,
  extractVerticalRuntimeSafeDescriptors,
  makeActionRuntimeLive,
  makeReadRuntimeLive,
  validateActiveApplicationCompositionSnapshot,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { Clock, Effect, Layer, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { Pool } from 'pg';
import { HttpApi } from 'effect/http-api';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { privacyManifest } from '../../vertical.manifest.ts';
import { privacyRegistration } from '../../vertical.registration.ts';

const compositionDigest = (document: string): string => createHash('sha256').update(document, 'utf-8').digest('hex');
const compositionUnavailable = (cause: unknown) =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'The DSR fixture owner contract or published Shell metadata is unavailable',
  });

export const readPrivacyFixtureShellObservation = Effect.fn('PrivacyTests.readShellObservation')(
  function* readPrivacyFixtureShellObservation() {
    const shellRuntimeDocument = yield* Effect.tryPromise({
      catch: compositionUnavailable,
      try: async () =>
        await readFile(
          new URL('../../../../apps/shell-super-app/dist/public/.well-known/ontos-shell-runtime.json', import.meta.url),
          'utf-8',
        ),
    });
    const shellRuntime = yield* Schema.decodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
      shellRuntimeDocument,
    ).pipe(Effect.mapError(compositionUnavailable));
    const shellFederationDocument = yield* Effect.tryPromise({
      catch: compositionUnavailable,
      try: async () =>
        await readFile(new URL('../../../../apps/shell-super-app/.output/mf-manifest.json', import.meta.url), 'utf-8'),
    });
    const shellFederation = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          shared: Schema.Array(
            Schema.Struct({
              name: Schema.NonEmptyString,
              requiredVersion: Schema.optionalKey(Schema.NonEmptyString),
              singleton: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        }),
      ),
    )(shellFederationDocument).pipe(Effect.mapError(compositionUnavailable));
    const sharedSingletons = yield* Effect.forEach(
      shellFederation.shared.filter(({ singleton }) => singleton === true),
      (entry) =>
        entry.requiredVersion === undefined
          ? Effect.fail(compositionUnavailable('Published Shell singleton has no version'))
          : Effect.succeed({ packageName: entry.name, version: entry.requiredVersion }),
    );
    return { sharedSingletons, shellFederationDocument, shellRuntime, shellRuntimeDocument };
  },
);

/** Full source contract from this exact bundle's own declarations and running delivery identity. */
export const derivePrivacyDsrOwnerContract = Effect.fn('PrivacyTests.deriveOwnerContract')(
  function* derivePrivacyDsrOwnerContract(workspaceRoot: string = new URL('../../../../', import.meta.url).pathname) {
    const owner = yield* Effect.try({
      catch: compositionUnavailable,
      try: () => extractVerticalRuntimeSafeDescriptors(privacyRegistration),
    });
    const topologyDocument = yield* Effect.tryPromise({
      catch: compositionUnavailable,
      try: async () => await readFile(`${workspaceRoot}/topology/reference-topology.json`, 'utf-8'),
    });
    const topology = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          verticals: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              moduleFederation: Schema.optionalKey(
                Schema.Struct({
                  exposes: Schema.Array(Schema.String),
                  name: Schema.NonEmptyString,
                }),
              ),
              path: Schema.String,
            }),
          ),
        }),
      ),
    )(topologyDocument).pipe(Effect.mapError(compositionUnavailable));
    const declaredOwners = topology.verticals.filter(
      (entry) => entry.id === ultramodernDeliveryUnit.appId && entry.path === 'verticals/privacy',
    );
    const [declaredOwner] = declaredOwners;
    if (
      declaredOwners.length !== 1 ||
      declaredOwner?.moduleFederation === undefined ||
      owner.requirements === undefined
    ) {
      return yield* Effect.fail(compositionUnavailable('Exact Privacy declaration and topology are required'));
    }
    const federation = declaredOwner.moduleFederation;
    const components = yield* Effect.forEach(Object.keys(privacyManifest.publicSurface.components), (key) => {
      const componentKey = `${owner.moduleId}.${key}`;
      const bindings = [...owner.shellContributions.pages, ...owner.shellContributions.publicComponents].filter(
        (binding) => binding.componentKey === componentKey,
      );
      const [binding] = bindings;
      if (bindings.length !== 1 || binding === undefined || !federation.exposes.includes(binding.expose)) {
        return Effect.fail(compositionUnavailable('Privacy component has no exact declared Federation exposure'));
      }
      return Effect.succeed({ expose: binding.expose, key: componentKey, mfBoundaryId: federation.name });
    });
    const events = yield* Effect.all(
      privacyManifest.publicSurface.events.map((event) =>
        Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
          Schema.toJsonSchemaDocument(event.payloadSchema),
        ).pipe(
          Effect.map((payloadDocument) => ({
            key: event.key,
            owningModuleId: event.owningModuleId,
            payloadContract: compositionDigest(`${payloadDocument}\n`),
            referencesResourceTypes: event.referencesResourceTypes,
            tense: event.tense,
            visibility: event.visibility,
          })),
        ),
      ),
    ).pipe(Effect.mapError(compositionUnavailable));
    const apis = yield* Effect.all(
      Object.entries(privacyManifest.publicSurface.api).map(([key, api]) => {
        if (!HttpApi.isHttpApi(api)) {
          return Effect.fail(compositionUnavailable('The actual Privacy API is not an HttpApi'));
        }
        return Effect.succeed({
          key: canonicalOntosPublicApiKey(owner.moduleId, key),
          operationKeys: Object.values(api.groups).flatMap((group) =>
            Object.values(group.endpoints).map((endpoint) =>
              group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
            ),
          ),
        });
      }),
    );
    const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
      deployment: { appId: ultramodernDeliveryUnit.appId, buildMarker: ultramodernDeliveryUnit.buildMarker },
      manifest: {
        activation: privacyManifest.activation,
        module: privacyManifest.module,
        publicSurface: {
          actions: owner.actions,
          api: apis,
          businessPermissions: privacyManifest.publicSurface.businessPermissions ?? [],
          components,
          events,
          operationContracts: owner.operationContracts,
          reports: privacyManifest.publicSurface.reports,
          resourceTypes: privacyManifest.publicSurface.resourceTypes,
          search: privacyManifest.publicSurface.search,
          shellContributions: owner.shellContributions,
        },
        requirements: owner.requirements,
      },
      runtime: { outboxSubscriptions: owner.outboxSubscriptions },
      schemaVersion: '2',
    }).pipe(Effect.mapError(compositionUnavailable));
    const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
      contract,
    ).pipe(Effect.mapError(compositionUnavailable));
    return { contract, contractDocument, federation };
  },
);

/** Actual running Privacy declarations in a TEST snapshot, never a published owner deployment claim. */
export const makePrivacyDsrCompositionSnapshot = Effect.fn('DsrTests.makePrivacyComposition')(
  function* makePrivacyDsrCompositionSnapshot() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(
      [ultramodernDeliveryUnit.appId],
      ultramodernDeliveryUnit.buildMarker,
    );
    const { contract, contractDocument, federation } = yield* derivePrivacyDsrOwnerContract();
    const { requirements } = contract.manifest;
    if (requirements === undefined) {
      return yield* Effect.fail(compositionUnavailable('The actual Privacy requirements are required'));
    }
    const contractDigest = compositionDigest(contractDocument);
    const { sharedSingletons, shellFederationDocument, shellRuntime, shellRuntimeDocument } =
      yield* readPrivacyFixtureShellObservation();
    // Metadata for the actual declared exposure, without a browser execution/build claim.
    const federationDocument = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          exposes: Schema.Array(Schema.String),
          name: Schema.String,
          shared: Schema.Array(Schema.Never),
        }),
      ),
    )({ exposes: federation.exposes, name: federation.name, shared: [] }).pipe(Effect.mapError(compositionUnavailable));
    const composition = {
      ...snapshot.composition,
      modules: snapshot.composition.modules.map((module) => ({
        ...module,
        allowedContributions: Object.values(contract.manifest.publicSurface.shellContributions).flatMap((items) =>
          items.map(({ contributionKey }) => contributionKey),
        ),
        contract: { ...module.contract, sha256: contractDigest },
        contractDocument,
        dependencies: requirements.intrinsic.map(({ moduleId }) => moduleId),
        deployment: contract.deployment,
        federation: {
          execution: 'browser' as const,
          exposes: federation.exposes,
          manifest: {
            sha256: compositionDigest(federationDocument),
            url: new URL('__fixture__/mf-manifest.json', module.contract.url).href,
          },
          remoteName: federation.name,
        },
        moduleId: contract.manifest.module.id,
        publicContract: { id: contract.manifest.module.id, sha256: contractDigest, version: contract.schemaVersion },
        requiredCoreCapabilities: requirements.coreCapabilities,
        requiredShellAbi: shellRuntime.contributionAbi,
      })),
      revision: '0'.repeat(64),
      shell: {
        ...snapshot.composition.shell,
        contributionAbi: shellRuntime.contributionAbi,
        coreCapabilities: shellRuntime.coreCapabilities,
        deployment: shellRuntime.deployment,
        federationManifest: {
          ...snapshot.composition.shell.federationManifest,
          sha256: compositionDigest(shellFederationDocument),
        },
        runtimeContract: {
          ...snapshot.composition.shell.runtimeContract,
          sha256: compositionDigest(shellRuntimeDocument),
        },
        sharedSingletons,
      },
    };
    return yield* validateActiveApplicationCompositionSnapshot({
      ...snapshot,
      composition: { ...composition, revision: compositionDigest(canonicalizeApplicationComposition(composition)) },
    });
  },
);

/** Existing production constructors with the same real database and grants supplied by the caller. */
export const privacyDsrOwnerRuntimeLive = (snapshot: ActiveApplicationCompositionSnapshot) =>
  Layer.unwrap(
    Effect.gen(function* selectPrivacyOwnerRuntime() {
      const modules = snapshot.composition.modules.filter(
        (module) =>
          module.moduleId === privacyManifest.module.id && module.deployment.appId === ultramodernDeliveryUnit.appId,
      );
      const [owner] = modules;
      if (modules.length !== 1 || owner === undefined) {
        return yield* Effect.fail(compositionUnavailable('Exactly one actual Privacy owner is required'));
      }
      const expectedDeployment = owner.deployment;
      const access = ContextAccessLive;
      const state = TenantModuleStateServiceLive;
      const gate = ModuleStateGateLive.pipe(Layer.provide(state));
      const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
      const scope = OperationalScopeResolverLive.pipe(Layer.provide(access));
      return Layer.mergeAll(
        makeActionRuntimeLive(expectedDeployment, privacyRegistration),
        makeReadRuntimeLive(expectedDeployment, privacyRegistration),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            access,
            ActionAuthorizationPreflightDatabaseLive,
            ActionPermissionLive,
            ActionRepositoryLive,
            gate,
            gateway,
            scope,
            Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
          ),
        ),
      );
    }),
  );

const appRoot = new URL('../../../../', import.meta.url).pathname;
const digest = compositionDigest;

export const identityFailure = (stage: string) => new PrivacyPartyNativeIdentityError({ stage });

// The normal owner emitter and canonical SDK identity run in their supported owner-loading process.
// No foreign private registration is imported by this consumer fixture.
export const describeControllerContracts = Effect.fn('ControllerOwnerTest.describeContracts')(
  function* describeControllerContracts() {
    const program = `import { Effect, FileSystem, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
    import { deriveOntosModuleDeploymentContract } from './scripts/generate-ontos-module-contract.mts';
    import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
    const runtime = ManagedRuntime.make(NodeServices.layer);
    const ownerIds = ['party-registry', 'privacy'];
    const identitySchema = Schema.Struct({buildMarker: Schema.String, sourceRevision: Schema.String});
    const ownerSchema = Schema.Struct({id: Schema.String,
      deliveryUnit: Schema.Struct({buildMarker: Schema.String, unitId: Schema.String})});
    const descriptionSchema = Schema.Struct({
      contracts: Schema.Array(OntosModuleDeploymentContractSchema),
      buildIdentities: Schema.Record(Schema.Literals(['party-registry', 'privacy']), identitySchema)
    });
    try { const text = await runtime.runPromise(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
        verticals: Schema.Array(ownerSchema)
      })))(yield* fs.readFileString('./topology/reference-topology.json'));
      const buildIdentities = {};
      for (const owner of topology.verticals) {
        if (!ownerIds.includes(owner.id)) continue;
        buildIdentities[owner.id] = yield* Effect.try(() => resolveUltramodernReleaseIdentity({
          generationBuildMarker: owner.deliveryUnit.buildMarker,
          unitId: owner.deliveryUnit.unitId, workspaceRoot: process.cwd()
        }));
      }
      const contracts = yield* Effect.forEach(ownerIds,
        vertical => deriveOntosModuleDeploymentContract({vertical}), {concurrency:1});
      return yield* Schema.encodeEffect(Schema.fromJsonString(descriptionSchema))({contracts, buildIdentities});
    })); process.stdout.write(text); } finally { await runtime.dispose(); }`;
    const child = yield* ChildProcess.make(
      'mise',
      ['exec', '--', 'node', '--experimental-strip-types', '--input-type=module', '--eval', program],
      { cwd: appRoot, env: { APP_ENV_PATH: '/dev/null' }, extendEnv: true, stderr: 'pipe', stdout: 'pipe' },
    );
    const [code, output] = yield* Effect.all(
      [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stderr)],
      { concurrency: 3 },
    );
    if (Number(code) !== 0) {
      return yield* identityFailure('Canonical owner contract derivation failed');
    }
    const description = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          buildIdentities: Schema.Record(
            Schema.Literals(['party-registry', 'privacy']),
            Schema.Struct({
              buildMarker: Schema.NonEmptyString,
              sourceRevision: Schema.NonEmptyString,
            }),
          ),
          contracts: Schema.Array(OntosModuleDeploymentContractSchema),
        }),
      ),
    )([...output].join(''));
    const partyContract = description.contracts.find(({ deployment }) => deployment.appId === 'party-registry');
    const privacyContract = description.contracts.find(({ deployment }) => deployment.appId === 'privacy');
    if (
      description.contracts.length !== 2 ||
      partyContract === undefined ||
      privacyContract === undefined ||
      partyContract.deployment.buildMarker !== description.buildIdentities['party-registry'].buildMarker ||
      privacyContract.deployment.buildMarker !== description.buildIdentities.privacy.buildMarker
    ) {
      return yield* identityFailure('Canonical owner projection and SDK identities disagree');
    }
    return { ...description, partyContract, privacyContract };
  },
);

export const makePrivacyPartyCompositionSnapshot = Effect.fn('PrivacyTests.makePartyComposition')(
  function* makePrivacyPartyCompositionSnapshot(
    description: Effect.Success<ReturnType<typeof describeControllerContracts>>,
  ) {
    const base = yield* makeApplicationCompositionSnapshotFixture(
      description.contracts.map(({ deployment }) => deployment.appId),
      Object.fromEntries(description.contracts.map(({ deployment }) => [deployment.appId, deployment.buildMarker])),
    );
    const { sharedSingletons, shellFederationDocument, shellRuntime, shellRuntimeDocument } =
      yield* readPrivacyFixtureShellObservation();
    const modules = yield* Effect.forEach(
      base.composition.modules,
      Effect.fn('ControllerOwnerTest.moduleContract')(function* moduleContract(module) {
        const owner = description.contracts.find(({ deployment }) => deployment.appId === module.deployment.appId);
        if (owner === undefined) {
          return yield* identityFailure('Exact owner contract is missing');
        }
        const document = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(owner);
        const hash = digest(document);
        const { requirements } = owner.manifest;
        if (requirements === undefined) {
          return yield* identityFailure('Actual owner requirements are missing');
        }
        const { components } = owner.manifest.publicSurface;
        const [component] = components;
        // Only immutable declared exposure metadata is claimed here, never browser execution.
        const federationDocument = yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              exposes: Schema.Array(Schema.String),
              name: Schema.String,
              shared: Schema.Array(Schema.Never),
            }),
          ),
        )({
          exposes: components.map(({ expose }) => expose),
          name: component?.mfBoundaryId ?? owner.deployment.appId,
          shared: [],
        });
        return {
          ...module,
          allowedContributions: Object.values(owner.manifest.publicSurface.shellContributions).flatMap((items) =>
            items.map(({ contributionKey }) => contributionKey),
          ),
          backend: {
            baseUrl: `https://${module.deployment.appId}.fixture.example.test/`,
            transport: 'node-http' as const,
          },
          contract: { ...module.contract, sha256: hash },
          contractDocument: document,
          dependencies: requirements.intrinsic.map(({ moduleId }) => moduleId),
          deployment: owner.deployment,
          federation:
            component === undefined
              ? { execution: 'server' as const }
              : {
                  execution: 'browser' as const,
                  exposes: components.map(({ expose }) => expose),
                  manifest: {
                    sha256: digest(federationDocument),
                    url: new URL('__fixture__/mf-manifest.json', module.contract.url).href,
                  },
                  remoteName: component.mfBoundaryId,
                },
          moduleId: owner.manifest.module.id,
          publicContract: { id: owner.manifest.module.id, sha256: hash, version: owner.schemaVersion },
          requiredCoreCapabilities: requirements.coreCapabilities,
          requiredShellAbi: shellRuntime.contributionAbi,
        };
      }),
      { concurrency: 2 },
    );
    const composition = {
      ...base.composition,
      modules,
      shell: {
        ...base.composition.shell,
        contributionAbi: shellRuntime.contributionAbi,
        coreCapabilities: shellRuntime.coreCapabilities,
        deployment: shellRuntime.deployment,
        federationManifest: { ...base.composition.shell.federationManifest, sha256: digest(shellFederationDocument) },
        runtimeContract: { ...base.composition.shell.runtimeContract, sha256: digest(shellRuntimeDocument) },
        sharedSingletons,
      },
    };
    return yield* validateActiveApplicationCompositionSnapshot({
      ...base,
      composition: {
        ...composition,
        revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
      },
    });
  },
);

class DsrTestRedemptionSetupFailure extends Schema.TaggedError<DsrTestRedemptionSetupFailure>()(
  'DsrTestRedemptionSetupFailure',
  { reason: Schema.String },
) {}
const setupFailure = () => new DsrTestRedemptionSetupFailure({ reason: 'Exact owned TEST replay storage is required' });
const nativeIdentity = Schema.Struct({
  bypass: Schema.Boolean,
  database: Schema.String,
  effectiveRole: Schema.String,
  sessionRole: Schema.String,
  superuser: Schema.Boolean,
});
const privileges = Schema.Struct({
  delete: Schema.Boolean,
  insert: Schema.Boolean,
  references: Schema.Boolean,
  select: Schema.Boolean,
  trigger: Schema.Boolean,
  truncate: Schema.Boolean,
  update: Schema.Boolean,
});
const loopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
const postgresProtocol = (protocol: string): boolean => protocol === 'postgres:' || protocol === 'postgresql:';

interface EndpointMetadata {
  readonly hash: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly port: string;
  readonly protocol: string;
  readonly queryKeys: readonly string[];
  readonly username: string;
}
const endpointMetadata = (url: URL): EndpointMetadata => ({
  hash: url.hash,
  hostname: url.hostname,
  pathname: url.pathname,
  port: url.port,
  protocol: url.protocol,
  queryKeys: [...url.searchParams.keys()],
  username: url.username,
});

/** Pure TEST guard controls. These metadata predicates never accept I/O or configure the factory. */
export const dsrTestStorageGuards = {
  endpoints: (admin: EndpointMetadata, runtime: EndpointMetadata, database: string): boolean =>
    postgresProtocol(admin.protocol) &&
    admin.protocol === runtime.protocol &&
    loopback(admin.hostname) &&
    admin.hostname === runtime.hostname &&
    (admin.port || '5432') === (runtime.port || '5432') &&
    database.startsWith('ontos_test_party_gateway_') &&
    admin.pathname === `/${database}` &&
    runtime.pathname === `/${database}` &&
    /^[a-z_][a-z0-9_]*$/u.test(runtime.username) &&
    admin.username !== runtime.username &&
    [...admin.queryKeys, ...runtime.queryKeys].every((key) => key === 'sslmode') &&
    admin.hash === '' &&
    runtime.hash === '',
  privileges: (allowed: typeof privileges.Type): boolean =>
    allowed.select &&
    allowed.insert &&
    !allowed.update &&
    !allowed.delete &&
    !allowed.truncate &&
    !allowed.references &&
    !allowed.trigger,
  roles: (
    admin: typeof nativeIdentity.Type,
    runtime: typeof nativeIdentity.Type,
    database: string,
    adminRole: string,
    runtimeRole: string,
  ): boolean =>
    admin.database === database &&
    admin.effectiveRole === adminRole &&
    admin.sessionRole === adminRole &&
    runtime.database === database &&
    runtime.effectiveRole === runtimeRole &&
    runtime.sessionRole === runtimeRole &&
    !runtime.superuser &&
    !runtime.bypass,
};

/** TEST-only authority bound to a database this factory itself creates. No caller-selected connections or SQL. */
export const makeDsrObligationNative = Effect.fn('DsrObligation.TEST.native')(function* makeDsrObligationNative(
  compositionSnapshot: ActiveApplicationCompositionSnapshot,
  purpose:
    | 'stabilization-1265-dsr-multi-owner'
    | 'stabilization-1261-retained-purpose-withdrawal'
    | 'stabilization-1271-exact-obligation-deadline' = 'stabilization-1265-dsr-multi-owner',
) {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot,
    mode: 'schema-only',
    purpose,
  });
  // Capture primitives from the actual creator result before exposing its public fixture object.
  const { database } = isolated.connections.admin;
  const adminConnection = isolated.connections.admin.connectionString;
  const runtimeConnection = isolated.connections.runtime.connectionString;
  const adminUrl = new URL(adminConnection);
  const runtimeUrl = new URL(runtimeConnection);
  const runtimeRole = runtimeUrl.username;
  if (
    database !== isolated.connections.runtime.database ||
    !dsrTestStorageGuards.endpoints(endpointMetadata(adminUrl), endpointMetadata(runtimeUrl), database)
  ) {
    return yield* setupFailure();
  }
  const makeRedemption = Effect.fn('DsrObligation.TEST.boundRedemption')(function* makeRedemption() {
    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: adminConnection, max: 1 })),
      (pool) => Effect.promise(async () => await pool.end()),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: runtimeConnection, max: 2 })),
      (pool) => Effect.promise(async () => await pool.end()),
    );
    // Both probes precede TEST schema/grant writes. Ownership comes from creation above,
    // not the prefix. Effective role checks independently reject elevated runtime clients.
    const identities = yield* Effect.tryPromise({
      catch: setupFailure,
      try: async () => {
        const query =
          'select current_database() as database,current_user as "effectiveRole",session_user as "sessionRole",rolsuper as superuser,rolbypassrls as bypass from pg_catalog.pg_roles where rolname=current_user';
        const adminRows = await admin.query(query);
        const runtimeRows = await runtime.query(query);
        return { admin: adminRows.rows[0], runtime: runtimeRows.rows[0] };
      },
    });
    const adminIdentity = yield* Schema.decodeUnknownEffect(nativeIdentity)(identities.admin).pipe(
      Effect.mapError(setupFailure),
    );
    const runtimeIdentity = yield* Schema.decodeUnknownEffect(nativeIdentity)(identities.runtime).pipe(
      Effect.mapError(setupFailure),
    );
    if (!dsrTestStorageGuards.roles(adminIdentity, runtimeIdentity, database, adminUrl.username, runtimeRole)) {
      return yield* setupFailure();
    }
    yield* Effect.tryPromise({
      catch: setupFailure,
      try: async () => {
        await admin.query('create schema if not exists privacy_dsr_obligation_test');
        await admin.query(
          'create table if not exists privacy_dsr_obligation_test.redemptions (issuer text not null, audience text not null, jti text not null, primary key (issuer,audience,jti))',
        );
        await admin.query(`grant usage on schema privacy_dsr_obligation_test to "${runtimeRole}"`);
        await admin.query(`grant insert, select on privacy_dsr_obligation_test.redemptions to "${runtimeRole}"`);
      },
    });
    const effectivePrivileges = yield* Effect.tryPromise({
      catch: setupFailure,
      try: async () => {
        const result = await runtime.query(
          `select has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','SELECT') as "select",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','INSERT') as "insert",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','UPDATE') as "update",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','DELETE') as "delete",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','TRUNCATE') as "truncate",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','REFERENCES') as "references",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','TRIGGER') as "trigger"`,
        );
        return result.rows[0];
      },
    });
    const allowed = yield* Schema.decodeUnknownEffect(privileges)(effectivePrivileges).pipe(
      Effect.mapError(setupFailure),
    );
    if (!dsrTestStorageGuards.privileges(allowed)) {
      return yield* setupFailure();
    }
    return Layer.succeed(GatewayAssertionRedemptionService, {
      consume: Effect.fn('DsrObligation.TEST.consume')(function* consume(input) {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= now) {
          return yield* new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
        }
        const inserted = yield* Effect.tryPromise({
          catch: () =>
            new GatewayAssertionRedemptionUnavailableError({ reason: 'TEST native replay storage is unavailable' }),
          try: async () =>
            await runtime.query(
              'insert into privacy_dsr_obligation_test.redemptions (issuer,audience,jti) values ($1,$2,$3) on conflict do nothing returning jti',
              [input.issuer, input.audience, input.jti],
            ),
        });
        return inserted.rowCount === 1
          ? yield* Effect.void
          : yield* new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
      }),
    });
  });
  return { isolated, makeRedemption };
});
