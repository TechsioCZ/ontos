import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  OwnerAuthorizationOverlay,
  OntosShellRuntimeContractSchema,
  canonicalizeApplicationComposition,
  failClosedOwnerAuthorizationOverlay,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { Effect, Redacted, Schema } from 'effect';
import { derivePrivacyDsrOwnerContract } from './dsr-obligation-native.ts';
import { privacyRegistration } from '../../vertical.registration.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

const digest = (document: string) => createHash('sha256').update(document, 'utf-8').digest('hex');
const unavailable = (cause: unknown) =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'Actual compiled Shell and Privacy native fixture metadata are unavailable',
  });

/** Source-derived Privacy contract and actual compiled Shell observations, confined to TEST authority. */
export const privacyIcoComposition = Effect.gen(function* genuinePrivacyIcoComposition() {
  const { contract, contractDocument, federation } = yield* derivePrivacyDsrOwnerContract();
  const base = yield* makeApplicationCompositionSnapshotFixture(['privacy'], ultramodernDeliveryUnit.buildMarker);
  const [shellDocument, federationDocument] = yield* Effect.all(
    [
      Effect.tryPromise({
        catch: unavailable,
        try: async () =>
          await readFile(
            new URL(
              '../../../../apps/shell-super-app/dist/public/.well-known/ontos-shell-runtime.json',
              import.meta.url,
            ),
            'utf-8',
          ),
      }),
      Effect.tryPromise({
        catch: unavailable,
        try: async () =>
          await readFile(new URL('../../../../apps/shell-super-app/dist/mf-manifest.json', import.meta.url), 'utf-8'),
      }),
    ],
    { concurrency: 2 },
  );
  const shell = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
    shellDocument,
  ).pipe(Effect.mapError(unavailable));
  const observedFederation = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        shared: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            requiredVersion: Schema.optionalKey(Schema.NonEmptyString),
            singleton: Schema.optionalKey(Schema.Boolean),
          }),
        ),
      }),
    ),
  )(federationDocument).pipe(Effect.mapError(unavailable));
  const sharedSingletons = yield* Effect.forEach(
    observedFederation.shared.filter((entry) => entry.singleton === true),
    (entry) =>
      entry.requiredVersion === undefined
        ? Effect.fail(unavailable('A real shared singleton requires an exact version'))
        : Effect.succeed({ packageName: entry.name, version: entry.requiredVersion }),
  );
  const { requirements } = contract.manifest;
  if (requirements === undefined) {
    return yield* unavailable('Actual Privacy requirements are missing');
  }
  const ownFederationDocument = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(federation);
  const composition = {
    ...base.composition,
    modules: base.composition.modules.map((module) => ({
      ...module,
      allowedContributions: Object.values(contract.manifest.publicSurface.shellContributions).flatMap((items) =>
        items.map(({ contributionKey }) => contributionKey),
      ),
      contract: { ...module.contract, sha256: digest(contractDocument) },
      contractDocument,
      dependencies: requirements.intrinsic.map(({ moduleId }) => moduleId),
      deployment: contract.deployment,
      federation: {
        execution: 'browser' as const,
        exposes: federation.exposes,
        manifest: {
          sha256: digest(ownFederationDocument),
          url: new URL('__fixture__/mf-manifest.json', module.contract.url).href,
        },
        remoteName: federation.name,
      },
      moduleId: contract.manifest.module.id,
      publicContract: {
        id: contract.manifest.module.id,
        sha256: digest(contractDocument),
        version: contract.schemaVersion,
      },
      requiredCoreCapabilities: requirements.coreCapabilities,
      requiredShellAbi: shell.contributionAbi,
    })),
    revision: '0'.repeat(64),
    shell: {
      ...base.composition.shell,
      contributionAbi: shell.contributionAbi,
      coreCapabilities: shell.coreCapabilities,
      deployment: shell.deployment,
      federationManifest: { ...base.composition.shell.federationManifest, sha256: digest(federationDocument) },
      runtimeContract: { ...base.composition.shell.runtimeContract, sha256: digest(shellDocument) },
      sharedSingletons,
    },
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
  });
});

const PrivacyReadFixturePurposeSchema = Schema.Literals([
  'implementation-1096-privacy-ico-reads',
  'implementation-1096-privacy-business-reads',
]);
const privacyNativeReadContext = Effect.fn('PrivacyTests.privacyNativeReadContext')(function* nativeContext(
  permission: string,
  purpose: typeof PrivacyReadFixturePurposeSchema.Type,
) {
  const composition = yield* privacyIcoComposition;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: composition,
    mode: 'schema-only',
    purpose,
  });
  return yield* makeNativeReadTestContext(
    {
      access: 'allowed',
      connections: {
        admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
        runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
      },
      contextPermissions: [permission],
      expectedDeployment: ultramodernDeliveryUnit,
      moduleId: 'privacy.core',
      ownerFixtureRetention: 'retain-complete-context',
    },
    privacyRegistration,
  ).pipe(
    Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(composition) }),
    Effect.provideService(OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay),
  );
});
export const privacyIcoNativeContext = (permission: string) =>
  privacyNativeReadContext(permission, 'implementation-1096-privacy-ico-reads');
export const privacyOrganizationBusinessNativeContext = (permission: string) =>
  privacyNativeReadContext(permission, 'implementation-1096-privacy-business-reads');
