import { Effect, Option, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import type { AnyActionRegistration } from '../../src/actions/definition.ts';
import type { AnyReadRegistration } from '../../src/reads/definition.ts';
import {
  canonicalOntosPublicApiKey,
  defineOntosModuleManifest,
  decodeOntosModuleDeploymentContract,
} from '../../src/modules/manifest.ts';
import type { OntosModuleRequirements } from '../../src/modules/manifest.ts';
import {
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
} from '../../src/modules/runtime-registration.ts';
import {
  buildNativeOutboxWorkerContracts,
  buildNativeOutboxWorkerComposition,
} from './outbox-worker-native-composition.ts';
import { freshOutboxWorkerCompositionSnapshot } from './outbox-worker-composition.ts';

import type { ActionRuntimeOptions } from '../../src/actions/runtime.ts';
import type { ContextAccess } from '../../src/permissions/context-access.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from './database-identities.ts';
import { openModuleEntrypointGateway } from './open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from './open-module-state-gate.ts';

/**
 * Tenant-permission allow for suites that exercise unrelated Action mechanics. Core treats a declared
 * `tenantPermission` as unavailable when no ContextAccess is installed, so a suite running an action that
 * declares one must state the authority it assumes rather than inheriting an implicit allow.
 */
export const allowTenantPermissions: (typeof ContextAccess)['Service'] = {
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

export const openActionRuntimeOptions = {
  databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
  moduleEntrypointGateway: openModuleEntrypointGateway,
  moduleStateGate: openModuleStateGate,
  // These fixtures test unrelated Action boundaries. Composition fencing has its own native
  // PostgreSQL suite; the fixture authority must never become the production default.
  lockCompositionAuthority: () => Effect.succeed([]),
  resolveCompositionRevision: () => Effect.succeed('a'.repeat(64)),
} satisfies Pick<
  ActionRuntimeOptions,
  | 'databaseIdentities'
  | 'moduleEntrypointGateway'
  | 'moduleStateGate'
  | 'lockCompositionAuthority'
  | 'resolveCompositionRevision'
>;

/** Exact TEST registrations and their truthful published projection; never a Core-operation brand. */
const TestOperationOwnerApiError = Schema.TaggedError<unknown>()('TestOperationOwnerApiError', {
  reason: Schema.String,
});

export const makeTestOperationOwner = ({
  actions = [],
  api = {},
  compositionLabel = 'original',
  moduleId,
  reads = [],
  requirements,
}: {
  readonly actions?: readonly AnyActionRegistration[];
  readonly api?: Readonly<Record<string, HttpApi.Constraint>>;
  readonly compositionLabel?: string;
  readonly moduleId: string;
  readonly reads?: readonly AnyReadRegistration[];
  readonly requirements?: OntosModuleRequirements;
}) => {
  const base = Option.getOrThrow(
    Option.fromNullishOr(
      buildNativeOutboxWorkerContracts([
        {
          appId: `${moduleId.replaceAll('.', '-')}-test-owner`,
          buildMarker: 'native-core-operation-test-owner',
          moduleId,
          requirements,
          subscriptions: [],
        },
      ])[0],
    ),
  );
  // `base` is a decoded deployment contract, so its `publicSurface` carries the serialized `mcp`
  // contribution, which is not an authored `OntosMcpContributionInput`. These fixtures test Action
  // mechanics, so the serialized contribution is dropped rather than re-authored.
  const { mcp: _serializedMcp, ...baseSurface } = base.manifest.publicSurface;
  const authored = {
    ...base.manifest,
    publicSurface: {
      ...baseSurface,
      actions,
      api,
      components: {},
      events: [],
      operationContracts: [],
      reports: [],
      search: [],
    },
  };
  const manifest =
    requirements === undefined
      ? defineOntosModuleManifest(authored)
      : defineOntosModuleManifest({ ...authored, requirements });
  const ownerRegistration = defineVerticalRuntimeRegistration({ actions, manifest, outboxWorkers: [], reads });
  const projection = extractVerticalRuntimeSafeDescriptors(ownerRegistration);
  const contract = decodeOntosModuleDeploymentContract({
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        actions: projection.actions,
        api: Object.entries(manifest.publicSurface.api).map(([key, apiContract]) => {
          if (!HttpApi.isHttpApi(apiContract)) {
            throw new TestOperationOwnerApiError({ reason: 'The original owner API must be a genuine HttpApi' });
          }
          return {
            key: canonicalOntosPublicApiKey(moduleId, key),
            operationKeys: Object.values(apiContract.groups).flatMap((group) =>
              Object.values(group.endpoints).map((endpoint) =>
                group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
              ),
            ),
          };
        }),
        operationContracts: projection.operationContracts,
      },
    },
  });
  const composition = buildNativeOutboxWorkerComposition(
    [contract],
    `native-core-operation-test-shell-${compositionLabel}`,
  );
  const snapshot = freshOutboxWorkerCompositionSnapshot(composition);
  return {
    applicationComposition: { load: snapshot },
    composition,
    expectedDeployment: contract.deployment,
    ownerRegistration,
    snapshot,
  };
};
