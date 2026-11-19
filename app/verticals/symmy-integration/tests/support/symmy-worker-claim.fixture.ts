import {
  ONTOS_SHELL_CONTRIBUTION_ABI,
  OntosModuleDeploymentContractSchema,
  canonicalOntosPublicApiKey,
  defineTenantModuleEntrypoint,
  extractVerticalRuntimeSafeDescriptors,
  validateActiveApplicationCompositionSnapshot,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionServiceContract, ApplicationComposition } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import {
  compositionFixtureContentDigest,
  makeModuleContractFixture,
  sealApplicationCompositionFixture,
} from '@app/core-runtime/testing/module-contract';
import { Array as EffectArray, DateTime, Effect, Order, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';

import {
  attestNativeOutboxClaim,
  prepareNativeOutboxClaimAdmission,
  withNativeOutboxClaimExecution,
  withWorkerRuntimeBinding,
} from '../../../../packages/core-runtime/src/outbox/worker-runtime-binding.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { executeSymmyJobWorker } from '../../src/workers/execute-symmy-job.worker.ts';
import { symmyIntegrationManifest } from '../../vertical.manifest.ts';
import { symmyIntegrationRegistration } from '../../vertical.registration.ts';

/**
 * The genuine Core worker claim the Symmy job worker runs under. Its conditional owner operation
 * requirements are resolved by Core against a sealed Application Composition holding the actual Symmy
 * contract and the three owner deployments it delegates to; only the Core claim SQL is not run.
 */
type ModuleContract = typeof OntosModuleDeploymentContractSchema.Type;
const decodeContract = Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema, { onExcessProperty: 'error' });
const encodeContract = Schema.encodeSync(Schema.fromJsonString(OntosModuleDeploymentContractSchema));

const owner = extractVerticalRuntimeSafeDescriptors(symmyIntegrationRegistration);
const symmyContract = decodeContract({
  deployment: { appId: ultramodernApiMarker.appId, buildMarker: ultramodernApiMarker.buildMarker },
  manifest: {
    activation: symmyIntegrationManifest.activation,
    module: symmyIntegrationManifest.module,
    originatorActions: symmyIntegrationManifest.originatorActions,
    publicSurface: {
      actions: owner.actions,
      api: Object.entries(symmyIntegrationManifest.publicSurface.api).flatMap(([key, api]) =>
        HttpApi.isHttpApi(api)
          ? [
              {
                key: canonicalOntosPublicApiKey(owner.moduleId, key),
                operationKeys: EffectArray.sort(
                  Object.values(api.groups).flatMap((group) =>
                    Object.values(group.endpoints).map((endpoint) => `${group.identifier}.${endpoint.identifier}`),
                  ),
                  Order.String,
                ),
              },
            ]
          : [],
      ),
      components: [],
      events: [],
      operationContracts: owner.operationContracts,
      reports: [],
      resourceTypes: symmyIntegrationManifest.publicSurface.resourceTypes,
      search: [],
      shellContributions: owner.shellContributions,
    },
    requirements: owner.requirements,
  },
  runtime: { outboxSubscriptions: owner.outboxSubscriptions },
  schemaVersion: '2',
});

/** Each owner deployment publishes exactly the operation contracts Symmy requires of it. */
const ownerDeployments = [
  { appId: 'party-registry', moduleId: 'party.registry' },
  { appId: 'commerce-customer-context', moduleId: 'commerce.customer-context' },
  { appId: 'privacy', moduleId: 'privacy.core' },
] as const;
const providerContract = (appId: string, moduleId: string): ModuleContract => {
  const base = makeModuleContractFixture({ appId, moduleId });
  const required = new Map(
    (owner.requirements?.operations ?? [])
      .filter(({ provider }) => provider.moduleId === moduleId)
      .map(({ provider }) => [provider.entrypointKey, provider.schemaVersion]),
  );
  const operationContracts = [...required].map(([entrypointKey, schemaVersion], index) => {
    const action = !entrypointKey.startsWith(`${moduleId}.api.`);
    return {
      apiKey: `${moduleId}.operation-${index}`,
      entrypoint: defineTenantModuleEntrypoint({
        access: action ? 'write' : 'read',
        authorization: { kind: 'protected' },
        entrypointKey,
        moduleKey: moduleId,
        role: action ? 'action' : 'api',
      }),
      operationKey: `operation${index}.execute`,
      schemaVersion,
    };
  });
  return decodeContract({
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        api: operationContracts.map(({ apiKey, operationKey }) => ({ key: apiKey, operationKeys: [operationKey] })),
        operationContracts,
      },
    },
  });
};

const compositionModule = (contract: ModuleContract) => {
  const contractDocument = encodeContract(contract);
  const sha256 = compositionFixtureContentDigest(contractDocument);
  const { appId } = contract.deployment;
  return {
    allowedContributions: [],
    backend: { baseUrl: `https://${appId}.example.test/`, transport: 'node-http' as const },
    contract: { sha256, url: `https://${appId}.example.test/.well-known/ontos-module-manifest.json` },
    contractDocument,
    dependencies: [],
    deployment: contract.deployment,
    federation: { execution: 'server' as const },
    moduleId: contract.manifest.module.id,
    publicContract: { id: contract.manifest.module.id, sha256, version: contract.schemaVersion },
    requiredCoreCapabilities: [],
    requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    sharedSingletons: [],
  };
};

const composition: ApplicationComposition = sealApplicationCompositionFixture({
  modules: [symmyContract, ...ownerDeployments.map(({ appId, moduleId }) => providerContract(appId, moduleId))].map(
    compositionModule,
  ),
  revision: '0'.repeat(64),
  schemaVersion: '2',
  shell: {
    contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    coreCapabilities: [],
    deployment: { appId: 'shell-super-app', buildMarker: 'symmy-worker-claim-shell' },
    federationManifest: {
      sha256: 'a'.repeat(64),
      url: 'https://shell.example.test/releases/symmy-worker-claim-shell/mf-manifest.json',
    },
    runtimeContract: {
      sha256: 'b'.repeat(64),
      url: 'https://shell.example.test/releases/symmy-worker-claim-shell/ontos-shell-runtime.json',
    },
    sharedSingletons: [],
  },
});

/** The admitted release every Symmy worker delivery of these tests was claimed under. */
export const symmyWorkerCompositionRevision = composition.revision;

const authority: ActiveApplicationCompositionServiceContract = makeActiveApplicationCompositionService(
  DateTime.now.pipe(
    Effect.flatMap((observedAt) =>
      validateActiveApplicationCompositionSnapshot({
        composition,
        observedAt,
        validUntil: DateTime.add(observedAt, { hours: 1 }),
      }),
    ),
  ),
);

/** Runs `effect` as the Symmy job worker holding the native claim of `context`'s delivery. */
export const withSymmyWorkerClaim =
  (context: OutboxWorkerHandlerContext) =>
  <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    withWorkerRuntimeBinding(
      {
        authority,
        expectedDeployment: symmyContract.deployment,
        ownerRegistration: symmyIntegrationRegistration,
        registrations: [executeSymmyJobWorker],
      },
      prepareNativeOutboxClaimAdmission([executeSymmyJobWorker], context.compositionRevision).pipe(
        Effect.orDie,
        Effect.flatMap((admission) =>
          withNativeOutboxClaimExecution(
            attestNativeOutboxClaim(
              {
                ...context,
                attemptId: context.claimId,
                consumerModuleKey: executeSymmyJobWorker.descriptor.consumerModuleKey,
                payloadJson: {},
                retryPolicy: executeSymmyJobWorker.descriptor.retryPolicy,
              },
              executeSymmyJobWorker,
              admission,
            ),
            executeSymmyJobWorker,
            context,
            effect,
          ),
        ),
      ),
    );
