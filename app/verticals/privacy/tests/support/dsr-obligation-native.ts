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
import { Clock, Effect, Layer, Schema } from 'effect';
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

/** Actual running Privacy declarations in a TEST snapshot, never a published owner deployment claim. */
export const makePrivacyDsrCompositionSnapshot = Effect.fn('DsrTests.makePrivacyComposition')(
  function* makePrivacyDsrCompositionSnapshot() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(
      [ultramodernDeliveryUnit.appId],
      ultramodernDeliveryUnit.buildMarker,
    );
    const owner = yield* Effect.try({
      catch: compositionUnavailable,
      try: () => extractVerticalRuntimeSafeDescriptors(privacyRegistration),
    });
    const topologyDocument = yield* Effect.tryPromise({
      catch: compositionUnavailable,
      try: async () =>
        await readFile(new URL('../../../../topology/reference-topology.json', import.meta.url), 'utf-8'),
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
    const { requirements } = owner;
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
        allowedContributions: Object.values(owner.shellContributions).flatMap((items) =>
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
        moduleId: owner.moduleId,
        publicContract: { id: owner.moduleId, sha256: contractDigest, version: contract.schemaVersion },
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
