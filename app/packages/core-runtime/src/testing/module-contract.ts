import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { Clock, DateTime, Effect, Schema } from 'effect';
import { Hex } from 'effect/encoding';

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
import type { OntosModuleActivation } from '../modules/manifest.ts';
import { extractVerticalRuntimeSafeDescriptors } from '../modules/runtime-registration.ts';
import type { VerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY } from '../modules/module-dependency-contracts.ts';

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

const digest = (document: string): string => Hex.encode(sha256(utf8ToBytes(document)));
const contractJsonSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const shellRuntimeJsonSchema = Schema.fromJsonString(OntosShellRuntimeContractSchema);
const fixtureShellOrigin = 'https://shell-fixture.example';
const fixtureShellFederationDocument = '{"name":"shell","shared":[]}';
const fixtureUnavailable = (cause: unknown): ActiveApplicationCompositionUnavailableError =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'The test Application Composition fixture is invalid',
  });

const operationApiClaims = (
  operations: ReturnType<typeof extractVerticalRuntimeSafeDescriptors>['operationContracts'],
) => {
  const byKey = new Map<string, string[]>();
  for (const { apiKey, operationKey } of operations) {
    byKey.set(apiKey, [...(byKey.get(apiKey) ?? []), operationKey]);
  }
  return [...byKey].map(([key, operationKeys]) => ({ key, operationKeys }));
};

const buildCompositionSnapshotFixture = Effect.fn('CoreTesting.buildCompositionSnapshotFixture')(
  function* buildCompositionSnapshotFixture(
    input: {
      readonly appIds?: readonly string[];
      readonly buildMarker?: string | Readonly<Record<string, string>>;
      readonly coreCapabilities?: (typeof OntosShellRuntimeContractSchema.Type)['coreCapabilities'];
      readonly owners?: ReadonlyMap<string, VerticalRuntimeRegistration>;
    } = {},
  ) {
    const {
      appIds = [],
      buildMarker = 'fixture-build',
      coreCapabilities = [],
      owners = new Map<string, VerticalRuntimeRegistration>(),
    } = input;
    const modules = yield* Effect.forEach(
      appIds,
      Effect.fnUntraced(function* createModuleFixture(appId: string) {
        const owner = owners.get(appId);
        const projection = owner === undefined ? undefined : extractVerticalRuntimeSafeDescriptors(owner);
        const moduleId = projection?.moduleId ?? `${appId.replaceAll('-', '.')}.module`;
        const selectedBuildMarker = Schema.is(Schema.String)(buildMarker) ? buildMarker : buildMarker[appId];
        if (selectedBuildMarker === undefined) {
          return yield* fixtureUnavailable('Missing exact Application Composition fixture build marker');
        }
        const base = makeModuleContractFixture({ appId, buildMarker: selectedBuildMarker, moduleId });
        // This is an operation-only fixture, not a replacement owner manifest. The official projection
        // carries the actual Actions and published operation contracts. No executable registration,
        // access declaration or requirement is manufactured from a key supplied by a test.
        const projected =
          projection === undefined
            ? base
            : {
                ...base,
                manifest: {
                  ...base.manifest,
                  publicSurface: {
                    ...base.manifest.publicSurface,
                    actions: projection.actions,
                    api: operationApiClaims(projection.operationContracts),
                    operationContracts: projection.operationContracts,
                  },
                },
                runtime: { outboxSubscriptions: projection.outboxSubscriptions },
              };
        const authored =
          projection?.requirements === undefined
            ? projected
            : {
                ...projected,
                manifest: { ...projected.manifest, requirements: projection.requirements },
              };
        const document = yield* Schema.decodeEffect(OntosModuleDeploymentContractSchema)(authored);
        const contractDocument = yield* Schema.encodeEffect(contractJsonSchema)(document);
        const contractSha256 = digest(contractDocument);
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
          dependencies: (projection?.requirements?.intrinsic ?? [])
            .map(({ moduleId: dependency }) => dependency)
            .toSorted(),
          deployment: document.deployment,
          federation: { execution: 'server' },
          moduleId,
          publicContract: { id: moduleId, sha256: contractSha256, version: document.schemaVersion },
          requiredCoreCapabilities: projection?.requirements?.coreCapabilities ?? [],
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
      coreCapabilities,
      deployment: shellDeployment,
      schemaVersion: '2',
    }).pipe(Effect.mapError(fixtureUnavailable));
    const composition: ApplicationComposition = {
      modules,
      revision: '0'.repeat(64),
      schemaVersion: '2',
      shell: {
        contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
        coreCapabilities,
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
      composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
      observedAt: DateTime.makeUnsafe(now - 1000),
      validUntil: DateTime.makeUnsafe(now + 3_600_000),
    });
  },
);

/** Test authority uses the same full bundle validation as the receiving runtime. */
export const makeApplicationCompositionSnapshotFixture = Effect.fn(
  'CoreTesting.makeApplicationCompositionSnapshotFixture',
)(function* makeApplicationCompositionSnapshotFixture(
  appIds: readonly string[] = [],
  buildMarker: string | Readonly<Record<string, string>> = 'fixture-build',
) {
  return yield* buildCompositionSnapshotFixture({ appIds, buildMarker });
});

/**
 * Public operation-lifecycle fixture for genuine owner registrations. The caller retains the same
 * private registration identities; only their official safe projections enter the validated catalog.
 * Missing dependency owners or required Shell capabilities fail ordinary bundle validation.
 */
export const makeOwnerApplicationCompositionFixture = Effect.fn('CoreTesting.makeOwnerApplicationCompositionFixture')(
  function* makeOwnerApplicationCompositionFixture(input: {
    readonly additionalOwners?: readonly {
      readonly appId: string;
      readonly ownerRegistration: VerticalRuntimeRegistration;
    }[];
    readonly appId?: string;
    readonly buildMarker?: string;
    readonly ownerRegistration: VerticalRuntimeRegistration;
    /** Hosts the actual Core Action runtime; unavailable is a negative-control option only. */
    readonly runtime?: 'native-action' | 'unavailable';
  }) {
    const appId = input.appId ?? input.ownerRegistration.moduleId.replaceAll('.', '-');
    const buildMarker = input.buildMarker ?? 'fixture-owner-build';
    const owners = new Map([
      [appId, input.ownerRegistration] as const,
      ...(input.additionalOwners ?? []).map((owner) => [owner.appId, owner.ownerRegistration] as const),
    ]);
    if (owners.size !== 1 + (input.additionalOwners?.length ?? 0)) {
      return yield* fixtureUnavailable('Owner fixture deployment identities must be unique');
    }
    // The production Shell contract advertises this same Core-defined capability. Its actual
    // module-operation lease and closure enforcement run in the native Action lifecycle. Never
    // derive supported capabilities from whatever the consuming owner happens to require.
    const coreCapabilities = input.runtime === 'unavailable' ? [] : [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY];
    const snapshot = yield* buildCompositionSnapshotFixture({
      appIds: [...owners.keys()],
      buildMarker,
      coreCapabilities,
      owners,
    });
    return Object.freeze({
      applicationComposition: Object.freeze({ load: Effect.succeed(snapshot) }),
      expectedDeployment: Object.freeze({ appId, buildMarker }),
      ownerRegistration: input.ownerRegistration,
      snapshot,
    });
  },
);
