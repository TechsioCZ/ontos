import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { Clock, DateTime, Effect, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { moduleReleaseWorkerName } from '../http/module-release-identity.ts';
import { validateActiveApplicationCompositionSnapshot } from '../modules/active-application-composition.ts';
import { ActiveApplicationCompositionUnavailableError } from '../modules/active-application-composition-errors.ts';
import {
  ApplicationCompositionCloudflareWorkerBackendSchema,
  ApplicationCompositionSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosShellRuntimeContractSchema,
  canonicalizeApplicationComposition,
} from '../modules/application-composition.ts';
import type { ApplicationComposition, ApplicationCompositionModule } from '../modules/application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../modules/manifest.ts';
import type { OntosModuleActivation, OntosModuleDeploymentContract } from '../modules/manifest.ts';

interface ModuleContractFixtureOptions<Subscription extends object> {
  readonly appId: string;
  readonly buildMarker?: string;
  readonly description?: string;
  readonly displayName?: string;
  readonly moduleId: string;
  /** The Action keys the module may act for as an Originator; absent declares none. */
  readonly originatorActions?: readonly string[];
  readonly outboxSubscriptions?: readonly Subscription[];
  readonly supportedStates?: OntosModuleActivation['supportedStates'];
}

export const makeModuleContractFixture = <Subscription extends object = never>({
  appId,
  buildMarker = `${appId}-build`,
  moduleId,
  description = `${moduleId} module`,
  displayName = moduleId,
  originatorActions = [],
  outboxSubscriptions = [],
  supportedStates = ['inactive', 'active'],
}: ModuleContractFixtureOptions<Subscription>) => ({
  deployment: { appId, buildMarker },
  manifest: {
    activation: {
      defaultState: 'inactive' as const,
      preservesHistoryWhenInactive: true as const,
      scope: 'tenant' as const,
      supportedStates,
    },
    module: {
      description,
      displayName,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical' as const,
      kind: 'business_module' as const,
    },
    originatorActions,
    publicSurface: {
      actions: [],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions },
  schemaVersion: '2' as const,
});

export const compositionFixtureContentDigest = (document: string): string => Hex.encode(sha256(utf8ToBytes(document)));
const contractJsonSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const shellRuntimeJsonSchema = Schema.fromJsonString(OntosShellRuntimeContractSchema);
const fixtureShellOrigin = 'https://shell-fixture.example';
const fixtureShellFederationDocument = '{"name":"shell","shared":[]}';
const fixtureUnavailable = (cause: unknown): ActiveApplicationCompositionUnavailableError =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'The test Application Composition fixture is invalid',
  });

const buildCompositionSnapshotFixture = function* buildCompositionSnapshotFixture(
  appIds: readonly string[] = [],
  buildMarker: string | Readonly<Record<string, string>> = 'fixture-build',
) {
  const modules = yield* Effect.forEach(
    appIds,
    Effect.fnUntraced(function* createModuleFixture(appId: string) {
      const moduleId = `${appId.replaceAll('-', '.')}.module`;
      const selectedBuildMarker = Schema.is(Schema.String)(buildMarker) ? buildMarker : buildMarker[appId];
      if (selectedBuildMarker === undefined) {
        return yield* fixtureUnavailable('Missing exact Application Composition fixture build marker');
      }
      const document = yield* Schema.decodeEffect(OntosModuleDeploymentContractSchema)(
        makeModuleContractFixture({ appId, buildMarker: selectedBuildMarker, moduleId }),
      );
      const contractDocument = yield* Schema.encodeEffect(contractJsonSchema)(document);
      const contractSha256 = compositionFixtureContentDigest(contractDocument);
      const workerName = yield* moduleReleaseWorkerName(appId, document.deployment.buildMarker);
      const versionId = yield* Schema.decodeEffect(
        ApplicationCompositionCloudflareWorkerBackendSchema.fields.versionId,
      )('023e105f-2a42-4f8b-a1c1-73f6a2a30c0f');
      const module: ApplicationCompositionModule = {
        allowedContributions: [],
        backend: {
          baseUrl: `https://${workerName}.fixture.workers.dev/`,
          transport: 'cloudflare-worker',
          versionId,
          workerName,
        },
        contract: { sha256: contractSha256, url: `https://${appId}.example/.well-known/ontos-module-manifest.json` },
        contractDocument,
        dependencies: [],
        deployment: document.deployment,
        federation: { execution: 'server' },
        moduleId,
        publicContract: { id: moduleId, sha256: contractSha256, version: document.schemaVersion },
        requiredCoreCapabilities: [],
        requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
        sharedSingletons: [],
      };
      return module;
    }, Effect.mapError(fixtureUnavailable)),
    { concurrency: 8 },
  );
  const shellDeployment = { appId: 'shell-super-app', buildMarker: 'shell-fixture-build' } as const;
  const runtimeContractDocument = yield* Schema.encodeEffect(shellRuntimeJsonSchema)({
    contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    coreCapabilities: [],
    deployment: shellDeployment,
    schemaVersion: '2',
  }).pipe(Effect.mapError(fixtureUnavailable));
  const input: ApplicationComposition = {
    modules,
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: [],
      deployment: shellDeployment,
      federationManifest: {
        sha256: compositionFixtureContentDigest(fixtureShellFederationDocument),
        url: `${fixtureShellOrigin}/mf-manifest.json`,
      },
      runtimeContract: {
        sha256: compositionFixtureContentDigest(runtimeContractDocument),
        url: `${fixtureShellOrigin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`,
      },
      sharedSingletons: [],
    },
  };
  const now = yield* Clock.currentTimeMillis;
  return yield* validateActiveApplicationCompositionSnapshot({
    composition: { ...input, revision: compositionFixtureContentDigest(canonicalizeApplicationComposition(input)) },
    observedAt: DateTime.makeUnsafe(now - 1000),
    validUntil: DateTime.makeUnsafe(now + 3_600_000),
  });
};

/** Test authority uses the same full bundle validation as the receiving runtime. */
export const makeApplicationCompositionSnapshotFixture = Effect.fn(
  'CoreTesting.makeApplicationCompositionSnapshotFixture',
)(buildCompositionSnapshotFixture);

/** A deterministic TEST fixture seal over typed composition data. */
export const sealApplicationCompositionFixture = (composition: ApplicationComposition): ApplicationComposition => ({
  ...composition,
  revision: compositionFixtureContentDigest(
    canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) }),
  ),
});

const publishedFixtureModule = (
  contract: OntosModuleDeploymentContract,
  contractDocument: string,
): ApplicationCompositionModule => {
  const contractSha256 = compositionFixtureContentDigest(contractDocument);
  const { components, shellContributions } = contract.manifest.publicSurface;
  const [component] = components;
  return {
    allowedContributions: Object.values(shellContributions).flatMap((items) =>
      items.map(({ contributionKey }) => contributionKey),
    ),
    backend: { baseUrl: `https://${contract.deployment.appId}.example.test/`, transport: 'node-http' },
    contract: {
      sha256: contractSha256,
      url: `https://${contract.deployment.appId}.example.test/.well-known/ontos-module-manifest.json`,
    },
    contractDocument,
    dependencies: (contract.manifest.requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId).toSorted(),
    deployment: contract.deployment,
    federation:
      component === undefined
        ? { execution: 'server' }
        : {
            execution: 'browser',
            exposes: components.map(({ expose }) => expose),
            manifest: {
              sha256: compositionFixtureContentDigest(`${contract.deployment.buildMarker}-manifest`),
              url: `https://${contract.deployment.appId}.example.test/releases/${contract.deployment.buildMarker}/mf-manifest.json`,
            },
            remoteName: component.mfBoundaryId,
          },
    moduleId: contract.manifest.module.id,
    publicContract: { id: contract.manifest.module.id, sha256: contractSha256, version: contract.schemaVersion },
    requiredCoreCapabilities: contract.manifest.requirements?.coreCapabilities ?? [],
    requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    sharedSingletons: [],
  };
};

/** Build TEST composition DTOs from exact published contracts and an explicit receiving Shell release. */
export const makePublishedApplicationCompositionSnapshotFixture = Effect.fn(
  'CoreTesting.makePublishedApplicationCompositionSnapshotFixture',
)(function* makePublishedSnapshot(input: {
  readonly contractInputs: readonly unknown[];
  readonly publishedShellRuntime: {
    readonly document: string;
    readonly receiverDeployment: ApplicationComposition['shell']['deployment'];
  };
  readonly validityMs: number;
}) {
  const { contractInputs, publishedShellRuntime, validityMs } = input;
  if (!Number.isFinite(validityMs) || validityMs <= 0) {
    return yield* fixtureUnavailable('The fixture validity must be a positive finite duration');
  }
  const modules = yield* Effect.forEach(
    contractInputs,
    Effect.fnUntraced(function* publishedModule(contractInput) {
      if (Schema.is(Schema.String)(contractInput)) {
        const contract = yield* Schema.decodeUnknownEffect(contractJsonSchema)(contractInput).pipe(
          Effect.mapError(fixtureUnavailable),
        );
        return publishedFixtureModule(contract, contractInput);
      }
      const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(contractInput).pipe(
        Effect.mapError(fixtureUnavailable),
      );
      const document = yield* Schema.encodeEffect(contractJsonSchema)(contract).pipe(
        Effect.mapError(fixtureUnavailable),
      );
      return publishedFixtureModule(contract, document);
    }),
    { concurrency: 8 },
  );
  const { document: runtimeDocument, receiverDeployment } = publishedShellRuntime;
  const runtimeContract = yield* Schema.decodeUnknownEffect(shellRuntimeJsonSchema)(runtimeDocument).pipe(
    Effect.mapError(fixtureUnavailable),
  );
  if (
    runtimeContract.deployment.appId !== receiverDeployment.appId ||
    runtimeContract.deployment.buildMarker !== receiverDeployment.buildMarker
  ) {
    return yield* new ActiveApplicationCompositionUnavailableError({
      reason: 'The actual Shell runtime document must match the compiled fixture receiver',
    });
  }
  const receiverReleaseUrl = `https://${receiverDeployment.appId}.example.test/releases/${receiverDeployment.buildMarker}/`;
  const shellFederationManifestDocument = '{"exposes":[],"name":"shellSuperApp","shared":[]}';
  const composition = yield* Schema.decodeUnknownEffect(ApplicationCompositionSchema)({
    modules,
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: runtimeContract.coreCapabilities,
      deployment: receiverDeployment,
      federationManifest: {
        sha256: compositionFixtureContentDigest(shellFederationManifestDocument),
        url: new URL('mf-manifest.json', receiverReleaseUrl).href,
      },
      runtimeContract: {
        sha256: compositionFixtureContentDigest(runtimeDocument),
        url: new URL(ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1), receiverReleaseUrl).href,
      },
      sharedSingletons: [],
    },
  }).pipe(Effect.mapError(fixtureUnavailable));
  const observedAt = yield* DateTime.now;
  const validUntil = yield* Effect.try({
    catch: fixtureUnavailable,
    try: () => DateTime.add(observedAt, { milliseconds: validityMs }),
  });
  return { composition: sealApplicationCompositionFixture(composition), observedAt, validUntil };
});
