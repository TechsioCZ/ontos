import { createHash } from 'node:crypto';

import { Clock, DateTime, Effect, Schema } from 'effect';

import { moduleReleaseWorkerName } from '../http/module-release-identity.ts';
import { validateActiveApplicationCompositionSnapshot } from '../modules/active-application-composition.ts';
import { ActiveApplicationCompositionUnavailableError } from '../modules/active-application-composition-errors.ts';
import {
  ApplicationCompositionCloudflareWorkerBackendSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosShellRuntimeContractSchema,
  canonicalizeApplicationComposition,
} from '../modules/application-composition.ts';
import type { ApplicationComposition, ApplicationCompositionModule } from '../modules/application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../modules/manifest.ts';
import type { OntosModuleDeploymentContract } from '../modules/manifest.ts';

interface ModuleContractFixtureOptions<Subscription extends object> {
  readonly appId: string;
  readonly buildMarker?: string;
  readonly description?: string;
  readonly displayName?: string;
  readonly moduleId: string;
  readonly outboxSubscriptions?: readonly Subscription[];
  readonly supportedStates?: OntosModuleDeploymentContract['manifest']['activation']['supportedStates'];
}

export const makeModuleContractFixture = <Subscription extends object = never>({
  appId,
  buildMarker = `${appId}-build`,
  moduleId,
  description = `${moduleId} module`,
  displayName = moduleId,
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

const digest = (document: string): string => createHash('sha256').update(document, 'utf-8').digest('hex');
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
  buildMarker = 'fixture-build',
) {
  const modules = yield* Effect.forEach(
    appIds,
    Effect.fnUntraced(function* createModuleFixture(appId: string) {
      const moduleId = `${appId.replaceAll('-', '.')}.module`;
      const document = yield* Schema.decodeEffect(OntosModuleDeploymentContractSchema)(
        makeModuleContractFixture({ appId, buildMarker, moduleId }),
      );
      const contractDocument = yield* Schema.encodeEffect(contractJsonSchema)(document);
      const sha256 = digest(contractDocument);
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
        contract: { sha256, url: `https://${appId}.example/.well-known/ontos-module-manifest.json` },
        contractDocument,
        dependencies: [],
        deployment: document.deployment,
        federation: { execution: 'server' },
        moduleId,
        publicContract: { id: moduleId, sha256, version: document.schemaVersion },
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
        sha256: digest(fixtureShellFederationDocument),
        url: `${fixtureShellOrigin}/mf-manifest.json`,
      },
      runtimeContract: {
        sha256: digest(runtimeContractDocument),
        url: `${fixtureShellOrigin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`,
      },
      sharedSingletons: [],
    },
  };
  const now = yield* Clock.currentTimeMillis;
  return yield* validateActiveApplicationCompositionSnapshot({
    composition: { ...input, revision: digest(canonicalizeApplicationComposition(input)) },
    observedAt: DateTime.makeUnsafe(now - 1000),
    validUntil: DateTime.makeUnsafe(now + 3_600_000),
  });
};

/** Test authority uses the same full bundle validation as the receiving runtime. */
export const makeApplicationCompositionSnapshotFixture = Effect.fn(
  'CoreTesting.makeApplicationCompositionSnapshotFixture',
)(buildCompositionSnapshotFixture);
