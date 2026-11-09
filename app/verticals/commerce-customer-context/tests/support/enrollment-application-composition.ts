import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  canonicalizeApplicationComposition,
  canonicalOntosPublicApiKey,
  extractVerticalRuntimeSafeDescriptors,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { Array as EffectArray, ConfigProvider, Effect, Layer, Order, Schema } from 'effect';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { FetchHttpClient } from 'effect/http';
import { HttpApi } from 'effect/http-api';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { commerceCustomerContextManifest } from '../../vertical.manifest.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const digest = (document: string): string => createHash('sha256').update(document, 'utf-8').digest('hex');
const contractJson = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const unavailable = (cause: unknown) =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'The enrollment fixture owner contract or compiled Shell/provider metadata is unavailable',
  });

/** INTERNAL_CONTRACT: actual owner source and compiled Shell metadata; no promotable release is claimed. */
export const makeEnrollmentApplicationCompositionSnapshot = Effect.fn('EnrollmentTests.makeApplicationComposition')(
  function* makeEnrollmentApplicationComposition(buildMarker: string, additionalAppIds: readonly string[]) {
    const providers = yield* Effect.forEach(
      Effect.fn('EnrollmentTests.compiledProviderContract')(function* compiledProviderContract(appId) {
        const contractDocument = yield* Effect.tryPromise({
          catch: unavailable,
          try: async () =>
            await readFile(
              new URL(
                `../../../../verticals/${appId}/dist/public/.well-known/ontos-module-manifest.json`,
                import.meta.url,
              ),
              'utf-8',
            ),
        });
        const contract = yield* Schema.decodeEffect(contractJson)(contractDocument).pipe(Effect.mapError(unavailable));
        if (contract.deployment.appId !== appId) {
          return yield* unavailable('The compiled provider contract does not match the selected deployment');
        }
        const { components, shellContributions } = contract.manifest.publicSurface;
        const contributionKeys = Object.values(shellContributions).flatMap((entries) =>
          entries.map(({ contributionKey }) => contributionKey),
        );
        const [component] = components;
        const federation =
          component === undefined
            ? { execution: 'server' as const }
            : {
                execution: 'browser' as const,
                exposes: components.map(({ expose }) => expose),
                manifest: {
                  sha256: digest(
                    yield* Effect.tryPromise({
                      catch: unavailable,
                      try: async () =>
                        await readFile(
                          new URL(`../../../../verticals/${appId}/dist/bundles/mf-manifest.json`, import.meta.url),
                          'utf-8',
                        ),
                    }),
                  ),
                  url: `https://${appId}.compiled-fixture.example/mf-manifest.json`,
                },
                remoteName: component.mfBoundaryId,
              };
        return { appId, contract, contractDocument, contributionKeys, federation, sha256: digest(contractDocument) };
      }),
    )(additionalAppIds);
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(
      [ultramodernApiMarker.appId, ...additionalAppIds],
      {
        [ultramodernApiMarker.appId]: buildMarker,
        ...Object.fromEntries(providers.map(({ appId, contract }) => [appId, contract.deployment.buildMarker])),
      },
    );
    const owner = yield* Effect.try({
      catch: unavailable,
      try: () => extractVerticalRuntimeSafeDescriptors(commerceCustomerContextRegistration),
    });
    const manifest = commerceCustomerContextManifest;
    const events = yield* Effect.all(
      manifest.publicSurface.events.map((event) =>
        Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
          Schema.toJsonSchemaDocument(event.payloadSchema),
        ).pipe(
          Effect.map((payloadDocument) => ({
            key: event.key,
            owningModuleId: event.owningModuleId,
            payloadContract: digest(`${payloadDocument}\n`),
            referencesResourceTypes: event.referencesResourceTypes,
            tense: event.tense,
            visibility: event.visibility,
          })),
        ),
      ),
    ).pipe(Effect.mapError(unavailable));
    const apis = yield* Effect.all(
      Object.entries(manifest.publicSurface.api).map(([key, api]) => {
        if (!HttpApi.isHttpApi(api)) {
          return Effect.fail(unavailable('The actual owner API is not an HttpApi'));
        }
        return Effect.succeed({
          key: canonicalOntosPublicApiKey(owner.moduleId, key),
          operationKeys: EffectArray.sort(
            Object.values(api.groups).flatMap((group) =>
              Object.values(group.endpoints).map((endpoint) =>
                group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
              ),
            ),
            Order.make<string>((left, right) => {
              const compared = left.localeCompare(right);
              if (compared < 0) {
                return -1;
              }
              if (compared > 0) {
                return 1;
              }
              return 0;
            }),
          ),
        });
      }),
    );
    const authoredManifest = {
      activation: manifest.activation,
      module: manifest.module,
      originatorActions: manifest.originatorActions,
      publicSurface: {
        actions: owner.actions,
        api: apis,
        businessPermissions: manifest.publicSurface.businessPermissions ?? [],
        components: Object.values(manifest.publicSurface.components),
        events,
        operationContracts: owner.operationContracts,
        reports: manifest.publicSurface.reports,
        resourceTypes: manifest.publicSurface.resourceTypes,
        search: manifest.publicSurface.search,
        shellContributions: owner.shellContributions,
      },
    };
    if (owner.requirements !== undefined) {
      Object.assign(authoredManifest, { requirements: owner.requirements });
    }
    const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
      deployment: { appId: ultramodernApiMarker.appId, buildMarker },
      manifest: authoredManifest,
      runtime: { outboxSubscriptions: owner.outboxSubscriptions },
      schemaVersion: '2',
    }).pipe(Effect.mapError(unavailable));
    const contractDocument = yield* Schema.encodeEffect(contractJson)(contract).pipe(Effect.mapError(unavailable));
    const sha256 = digest(contractDocument);
    const shellRuntimeDocument = yield* Effect.tryPromise({
      catch: unavailable,
      try: async () =>
        await readFile(
          new URL('../../../../apps/shell-super-app/dist/public/.well-known/ontos-shell-runtime.json', import.meta.url),
          'utf-8',
        ),
    });
    const shellRuntime = yield* Schema.decodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
      shellRuntimeDocument,
    ).pipe(Effect.mapError(unavailable));
    const shellFederationDocument = yield* Effect.tryPromise({
      catch: unavailable,
      try: async () =>
        await readFile(new URL('../../../../apps/shell-super-app/dist/mf-manifest.json', import.meta.url), 'utf-8'),
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
    )(shellFederationDocument).pipe(Effect.mapError(unavailable));
    const sharedSingletons = yield* Effect.forEach(
      shellFederation.shared.filter(({ singleton }) => singleton === true),
      (entry) =>
        entry.requiredVersion === undefined
          ? Effect.fail(unavailable('Published Shell singleton has no version'))
          : Effect.succeed({ packageName: entry.name, version: entry.requiredVersion }),
    );
    const composition = {
      ...snapshot.composition,
      modules: snapshot.composition.modules.map((module) =>
        module.deployment.appId === ultramodernApiMarker.appId
          ? {
              ...module,
              allowedContributions: Object.values(owner.shellContributions).flatMap((items) =>
                items.map(({ contributionKey }) => contributionKey),
              ),
              contract: { ...module.contract, sha256 },
              contractDocument,
              dependencies: (owner.requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId),
              deployment: contract.deployment,
              moduleId: contract.manifest.module.id,
              publicContract: { id: contract.manifest.module.id, sha256, version: contract.schemaVersion },
              requiredCoreCapabilities: owner.requirements?.coreCapabilities ?? [],
              requiredShellAbi: shellRuntime.contributionAbi,
            }
          : (() => {
              const provider = providers.find(({ appId }) => appId === module.deployment.appId);
              if (provider === undefined) {
                return module;
              }
              return {
                ...module,
                allowedContributions: provider.contributionKeys,
                contract: { ...module.contract, sha256: provider.sha256 },
                contractDocument: provider.contractDocument,
                dependencies: (provider.contract.manifest.requirements?.intrinsic ?? []).map(
                  ({ moduleId }) => moduleId,
                ),
                deployment: provider.contract.deployment,
                federation: provider.federation,
                moduleId: provider.contract.manifest.module.id,
                publicContract: {
                  id: provider.contract.manifest.module.id,
                  sha256: provider.sha256,
                  version: provider.contract.schemaVersion,
                },
                requiredCoreCapabilities: provider.contract.manifest.requirements?.coreCapabilities ?? [],
                requiredShellAbi: shellRuntime.contributionAbi,
              };
            })(),
      ),
      revision: '0'.repeat(64),
      shell: {
        ...snapshot.composition.shell,
        contributionAbi: shellRuntime.contributionAbi,
        coreCapabilities: shellRuntime.coreCapabilities,
        deployment: shellRuntime.deployment,
        federationManifest: {
          ...snapshot.composition.shell.federationManifest,
          sha256: digest(shellFederationDocument),
        },
        runtimeContract: { ...snapshot.composition.shell.runtimeContract, sha256: digest(shellRuntimeDocument) },
        sharedSingletons,
      },
    };
    return yield* validateActiveApplicationCompositionSnapshot({
      ...snapshot,
      composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
    });
  },
);

export const enrollmentApplicationCompositionSnapshot = makeEnrollmentApplicationCompositionSnapshot(
  ultramodernApiMarker.buildMarker,
  [],
);
export const enrollmentApplicationCompositionRevision = enrollmentApplicationCompositionSnapshot.pipe(
  Effect.map((snapshot) => snapshot.composition.revision),
);
export const enrollmentApplicationCompositionLayer = Layer.succeed(ActiveApplicationCompositionService, {
  load: enrollmentApplicationCompositionSnapshot,
});

const compositionSourceUrl = 'https://composition.enrollment-acceptance.test/active';

/** The existing controlled HTTP source supplies the same snapshot to production admission and JWT verification. */
export const enrollmentApplicationCompositionVerificationLayer = (
  snapshot: ActiveApplicationCompositionSnapshot,
  gatewayConfiguration: Readonly<Record<string, string>> = {},
) =>
  Layer.mergeAll(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...gatewayConfiguration,
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: compositionSourceUrl,
      }),
    ),
    Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
      const request = new Request(input, init);
      return request.url === compositionSourceUrl ? Response.json(snapshot) : await fetch(request);
    }),
  );
