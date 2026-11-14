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
import {
  compositionFixtureContentDigest,
  makeApplicationCompositionSnapshotFixture,
} from '@app/core-runtime/testing/module-contract';
import type { ActiveApplicationCompositionSnapshot, OntosModuleDeploymentContract } from '@app/core-runtime';
import {
  Array as EffectArray,
  ConfigProvider,
  Effect,
  Layer,
  Order,
  Predicate,
  Record as EffectRecord,
  Schema,
} from 'effect';
import { FetchHttpClient } from 'effect/http';
import { HttpApi } from 'effect/http-api';

import { deriveOntosMcpContribution } from '../../../../scripts/ontos-mcp-contribution.mts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { commerceCustomerContextManifest } from '../../vertical.manifest.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

type CompositionModule = ActiveApplicationCompositionSnapshot['composition']['modules'][number];

/** Keeps only the members that are present, so an optional contract key is omitted rather than sent as `undefined`. */
const presentMembers = EffectRecord.filter(Predicate.isNotUndefined);

/** Compiled inputs are read relative to the app workspace root (`app/`). */
const appRoot = new URL('../../../../', import.meta.url);
const contractJson = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const shellRuntimeJson = Schema.fromJsonString(OntosShellRuntimeContractSchema);
const ShellFederationJson = Schema.fromJsonString(
  Schema.Struct({
    shared: Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        requiredVersion: Schema.optionalKey(Schema.NonEmptyString),
        singleton: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
);
const shellRuntimeFile = 'apps/shell-super-app/dist/public/.well-known/ontos-shell-runtime.json';
const shellFederationFile = 'apps/shell-super-app/dist/mf-manifest.json';

const missingCompiledInput = (file: string, cause: unknown) =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: `The enrollment fixture reads the compiled ${file}, which is missing: build that unit or unpack its Node build artifacts`,
  });
const invalidCompiledInput = (file: string, cause: unknown) =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: `The compiled ${file} is not a valid published document`,
  });
const invalidOwnerSource = (cause: unknown) =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'The Customer Context owner source does not form a valid deployment contract',
  });

/** One compiled document; a missing file fails by name, never by substituting a placeholder. */
const readCompiled = Effect.fn('EnrollmentTests.readCompiled')(function* readCompiled(file: string) {
  return yield* Effect.tryPromise({
    catch: (cause) => missingCompiledInput(file, cause),
    try: async () => await readFile(new URL(file, appRoot), 'utf-8'),
  });
});

/** A browser provider's federation entry pins its compiled Module Federation manifest. */
const compiledProviderFederation = Effect.fn('EnrollmentTests.compiledProviderFederation')(
  function* compiledProviderFederation(appId: string, contract: OntosModuleDeploymentContract) {
    const { components } = contract.manifest.publicSurface;
    const [component] = components;
    if (component === undefined) {
      return yield* Effect.succeed<CompositionModule['federation']>({ execution: 'server' });
    }
    const manifestDocument = yield* readCompiled(`verticals/${appId}/dist/bundles/mf-manifest.json`);
    return yield* Effect.succeed<CompositionModule['federation']>({
      execution: 'browser',
      exposes: components.map(({ expose }) => expose),
      manifest: {
        sha256: compositionFixtureContentDigest(manifestDocument),
        url: `https://${appId}.compiled-fixture.example/mf-manifest.json`,
      },
      remoteName: component.mfBoundaryId,
    });
  },
);

/** A dependency owner exactly as its build published it: no owner registration is imported, no generator runs. */
const compiledProvider = Effect.fn('EnrollmentTests.compiledProvider')(function* compiledProvider(appId: string) {
  const contractFile = `verticals/${appId}/dist/public/.well-known/ontos-module-manifest.json`;
  const contractDocument = yield* readCompiled(contractFile);
  const contract = yield* Schema.decodeEffect(contractJson)(contractDocument).pipe(
    Effect.mapError((cause) => invalidCompiledInput(contractFile, cause)),
  );
  if (contract.deployment.appId !== appId) {
    return yield* invalidCompiledInput(contractFile, `it publishes ${contract.deployment.appId}, not ${appId}`);
  }
  const federation = yield* compiledProviderFederation(appId, contract);
  return yield* Effect.succeed({ appId, contract, contractDocument, federation });
});

const apiOperationKeys = (api: HttpApi.Top): readonly string[] =>
  EffectArray.sort(
    Object.values(api.groups).flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) =>
        group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
      ),
    ),
    Order.String,
  );

type CompositionFailure = ActiveApplicationCompositionUnavailableError;

/** One public API as the contract publishes it: its canonical key and sorted operation keys. */
const ownerApiContract = (
  moduleId: string,
  [key, value]: readonly [string, unknown],
): Effect.Effect<{ readonly key: string; readonly operationKeys: readonly string[] }, CompositionFailure> =>
  HttpApi.isHttpApi(value)
    ? Effect.succeed({ key: canonicalOntosPublicApiKey(moduleId, key), operationKeys: apiOperationKeys(value) })
    : Effect.fail(invalidOwnerSource(`The public API ${key} is not an HttpApi`));

/**
 * The Customer Context owner's contract from its actual source, assembled the way the contract generator
 * (`scripts/generate-ontos-module-contract.mts`) publishes it, at the build marker the test asks for.
 */
const ownerContract = Effect.fn('EnrollmentTests.ownerContract')(function* ownerContract(buildMarker: string) {
  const manifest = commerceCustomerContextManifest;
  const { publicSurface } = manifest;
  const owner = yield* Effect.try({
    catch: invalidOwnerSource,
    try: () => extractVerticalRuntimeSafeDescriptors(commerceCustomerContextRegistration),
  });
  const api = yield* Effect.forEach(
    Object.entries(publicSurface.api),
    (entry) => ownerApiContract(owner.moduleId, entry),
    {
      concurrency: 1,
    },
  );
  const events = yield* Effect.forEach(
    publicSurface.events,
    (event) =>
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
        Schema.toJsonSchemaDocument(event.payloadSchema),
      ).pipe(
        Effect.map((payloadDocument) => ({
          key: event.key,
          owningModuleId: event.owningModuleId,
          payloadContract: compositionFixtureContentDigest(`${payloadDocument}\n`),
          referencesResourceTypes: event.referencesResourceTypes,
          tense: event.tense,
          visibility: event.visibility,
        })),
        Effect.mapError(invalidOwnerSource),
      ),
    { concurrency: 1 },
  );
  const mcp = yield* Effect.try({
    catch: invalidOwnerSource,
    try: () =>
      deriveOntosMcpContribution({
        actions: publicSurface.actions,
        api: publicSurface.api,
        appId: ultramodernApiMarker.appId,
        authored: publicSurface.mcp,
        moduleId: manifest.module.id,
      }),
  });
  const authoredPublicSurface = {
    actions: owner.actions,
    api,
    businessPermissions: publicSurface.businessPermissions ?? [],
    components: Object.values(publicSurface.components),
    events,
    operationContracts: owner.operationContracts,
    reports: publicSurface.reports,
    resourceTypes: publicSurface.resourceTypes,
    search: publicSurface.search,
    shellContributions: owner.shellContributions,
    // Absent optional members are omitted, not sent as `undefined`: the contract's optional keys are exact.
    ...presentMembers({
      apiCookieTransport: publicSurface.apiCookieTransport,
      externalIdentityProviders: publicSurface.externalIdentityProviders,
      mcp: mcp?.contribution,
    }),
  };
  return yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
    deployment: { appId: ultramodernApiMarker.appId, buildMarker },
    manifest: {
      activation: manifest.activation,
      module: manifest.module,
      originatorActions: manifest.originatorActions ?? [],
      publicSurface: authoredPublicSurface,
      ...presentMembers({
        registeredWorkloadCalls: manifest.registeredWorkloadCalls,
        requirements: owner.requirements,
      }),
    },
    runtime: { outboxSubscriptions: owner.outboxSubscriptions },
    schemaVersion: '2',
  }).pipe(Effect.mapError(invalidOwnerSource));
});

/** A published Shell singleton must name the version every module shares. */
const sharedSingleton = ({
  name,
  requiredVersion,
}: {
  readonly name: string;
  readonly requiredVersion?: string;
}): Effect.Effect<{ readonly packageName: string; readonly version: string }, CompositionFailure> =>
  requiredVersion === undefined
    ? Effect.fail(invalidCompiledInput(shellFederationFile, `the shared singleton ${name} has no version`))
    : Effect.succeed({ packageName: name, version: requiredVersion });

/** The compiled Shell receiving this composition: its runtime contract and its shared singletons. */
const compiledShell = Effect.fn('EnrollmentTests.compiledShell')(function* compiledShell() {
  const runtimeDocument = yield* readCompiled(shellRuntimeFile);
  const runtime = yield* Schema.decodeEffect(shellRuntimeJson)(runtimeDocument).pipe(
    Effect.mapError((cause) => invalidCompiledInput(shellRuntimeFile, cause)),
  );
  const federationDocument = yield* readCompiled(shellFederationFile);
  const federation = yield* Schema.decodeEffect(ShellFederationJson)(federationDocument).pipe(
    Effect.mapError((cause) => invalidCompiledInput(shellFederationFile, cause)),
  );
  const sharedSingletons = yield* Effect.forEach(
    federation.shared.filter(({ singleton }) => singleton === true),
    sharedSingleton,
    { concurrency: 1 },
  );
  return yield* Effect.succeed({ federationDocument, runtime, runtimeDocument, sharedSingletons });
});

/** One composition entry carrying exactly the given published contract. */
const publishedModule = (
  module: CompositionModule,
  published: {
    readonly contract: OntosModuleDeploymentContract;
    readonly contractDocument: string;
    readonly federation: CompositionModule['federation'];
    readonly requiredShellAbi: CompositionModule['requiredShellAbi'];
  },
): CompositionModule => {
  const { contract, contractDocument, federation, requiredShellAbi } = published;
  const sha256 = compositionFixtureContentDigest(contractDocument);
  const moduleId = contract.manifest.module.id;
  return {
    ...module,
    allowedContributions: Object.values(contract.manifest.publicSurface.shellContributions).flatMap((entries) =>
      entries.map(({ contributionKey }) => contributionKey),
    ),
    contract: { ...module.contract, sha256 },
    contractDocument,
    dependencies: (contract.manifest.requirements?.intrinsic ?? []).map(({ moduleId: dependency }) => dependency),
    deployment: contract.deployment,
    federation,
    moduleId,
    publicContract: { id: moduleId, sha256, version: contract.schemaVersion },
    requiredCoreCapabilities: contract.manifest.requirements?.coreCapabilities ?? [],
    requiredShellAbi,
  };
};

interface PublishedModuleInput {
  readonly appId: string;
  readonly contract: OntosModuleDeploymentContract;
  readonly contractDocument: string;
  readonly federation?: CompositionModule['federation'];
}

/** Each fixture entry carries the owner's or the requested provider's published contract; nothing else enters. */
const composedModule = (
  module: CompositionModule,
  published: readonly PublishedModuleInput[],
  requiredShellAbi: CompositionModule['requiredShellAbi'],
): Effect.Effect<CompositionModule, CompositionFailure> => {
  const match = published.find(({ appId }) => appId === module.deployment.appId);
  return match === undefined
    ? Effect.fail(invalidOwnerSource(`The composition fixture produced an unrequested ${module.deployment.appId}`))
    : Effect.succeed(
        publishedModule(module, {
          contract: match.contract,
          contractDocument: match.contractDocument,
          federation: match.federation ?? module.federation,
          requiredShellAbi,
        }),
      );
};

/**
 * INTERNAL_CONTRACT: the actual Customer Context owner source, each dependency owner's compiled published contract
 * (`verticals/<appId>/dist/public/.well-known/ontos-module-manifest.json`) and the compiled Shell runtime. No
 * promotable release is claimed, and no input is ever replaced by a placeholder.
 */
export const makeEnrollmentApplicationCompositionSnapshot = Effect.fn('EnrollmentTests.makeApplicationComposition')(
  function* makeEnrollmentApplicationComposition(buildMarker: string, additionalAppIds: readonly string[]) {
    const providers = yield* Effect.forEach(additionalAppIds, compiledProvider, { concurrency: 1 });
    const contract = yield* ownerContract(buildMarker);
    const contractDocument = yield* Schema.encodeEffect(contractJson)(contract).pipe(
      Effect.mapError(invalidOwnerSource),
    );
    const shell = yield* compiledShell();
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(
      [ultramodernApiMarker.appId, ...additionalAppIds],
      {
        [ultramodernApiMarker.appId]: buildMarker,
        ...Object.fromEntries(providers.map((provider) => [provider.appId, provider.contract.deployment.buildMarker])),
      },
    );
    const published = [{ appId: ultramodernApiMarker.appId, contract, contractDocument }, ...providers];
    const modules = yield* Effect.forEach(
      snapshot.composition.modules,
      (module) => composedModule(module, published, shell.runtime.contributionAbi),
      { concurrency: 1 },
    );
    const composition = {
      ...snapshot.composition,
      modules,
      revision: '0'.repeat(64),
      shell: {
        ...snapshot.composition.shell,
        contributionAbi: shell.runtime.contributionAbi,
        coreCapabilities: shell.runtime.coreCapabilities,
        deployment: shell.runtime.deployment,
        federationManifest: {
          ...snapshot.composition.shell.federationManifest,
          sha256: compositionFixtureContentDigest(shell.federationDocument),
        },
        runtimeContract: {
          ...snapshot.composition.shell.runtimeContract,
          sha256: compositionFixtureContentDigest(shell.runtimeDocument),
        },
        sharedSingletons: shell.sharedSingletons,
      },
    };
    return yield* validateActiveApplicationCompositionSnapshot({
      ...snapshot,
      composition: {
        ...composition,
        revision: compositionFixtureContentDigest(canonicalizeApplicationComposition(composition)),
      },
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

/**
 * The controlled HTTP source supplies the same snapshot to production admission and JWT verification, with the
 * caller's gateway configuration layered on top. `ownerFetch` carries every other request: the ordinary fetch, or a
 * suite's fetch that answers the remote owners it stands in for at their HTTP boundary.
 */
export const enrollmentApplicationCompositionVerificationLayer = (
  snapshot: ActiveApplicationCompositionSnapshot,
  gatewayConfiguration: Readonly<Record<string, string>> = {},
  ownerFetch: typeof globalThis.fetch = fetch,
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
      if (request.url === compositionSourceUrl) {
        return Response.json(snapshot);
      }
      return await ownerFetch(request);
    }),
  );
