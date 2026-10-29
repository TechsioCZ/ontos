#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  MICROVERTICAL_RELEASE_ENVELOPE_KIND,
  verifyMicroVerticalReleaseEnvelope,
} from '@modern-js/app-tools-extensions/release-envelope';
import type { ReleaseEnvelopeKind } from '@modern-js/app-tools-extensions/release-envelope';
import { MICROVERTICAL_RELEASE_ENVELOPE_PATH } from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { resolveUltramodernSourceRevision } from '@modern-js/app-tools-extensions/release-identity';
import {
  Array as EffectArray,
  Clock,
  Config,
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Order,
  Predicate,
  Redacted,
  Runtime,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
import type { PlatformError } from 'effect/PlatformError';

import {
  moduleReleaseAssetWorkerName,
  moduleReleaseWorkerName,
} from '../packages/core-runtime/src/http/module-release-identity.ts';
import { OntosDeploymentAppIdSchema } from '../packages/core-runtime/src/modules/manifest.ts';
import { ApplicationCompositionCloudflareWorkerBackendSchema } from '../packages/core-runtime/src/modules/application-composition.ts';
import { validateActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import { decodeActiveApplicationCompositionSnapshot } from './active-application-composition.mts';
import {
  ApplicationCompositionPublicationCandidateSchema,
  assertRetainedReleaseArtifactPaths,
  readPublishedSnapshot,
} from './publish-active-application-composition.mts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';
import {
  ApplicationReleaseIntentSchema,
  applicationReleaseSelectCommand,
  readReviewedApplicationReleaseIntent,
} from './application-release-intent.mts';
import type { ApplicationReleaseIntent } from './application-release-intent.mts';
import { DIGEST_ENV_KEYS, computeSecretFingerprints } from './ci/deploy-plan.mts';
import { verifyImmutableBackendModuleContent } from './immutable-backend-package.mts';
import { OpsCommandError } from './ops/ops-command-error.mts';
import { OpsShellLive, runCommand } from './ops/ops-shell.mts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withImmutableApplicationReleaseIdentityLock,
} from './application-composition-authority-publication.mts';

export class ImmutableApplicationReleaseError extends Schema.TaggedError<ImmutableApplicationReleaseError>()(
  'ImmutableApplicationReleaseError',
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    /**
     * The attempt uploaded Workers it cannot complete (their workers.dev route never came up, or they are not what it
     * uploaded): its half release is removed, and no further attempt runs.
     */
    removeHalfRelease: Schema.optional(Schema.Boolean),
    /** The provider failed an upload in a way its own retry guidance covers. */
    transient: Schema.optional(Schema.Boolean),
  },
) {}

const ImmutableAssetNotReady = Data.TaggedError('ImmutableAssetNotReady')<{
  readonly cause: unknown;
  readonly message: string;
}>;
type ImmutableAssetNotReadyError = InstanceType<typeof ImmutableAssetNotReady>;

/**
 * One asset GET lost to the network rather than answered: a connection reset (before or during the body), a
 * response that never started within its bound, or a provider 5xx. Answered content — a non-5xx status, headers or
 * bytes — never is, and a body that stalls after its headers stays bounded by the overall readback deadline.
 */
const ImmutableAssetTransientRead = Data.TaggedError('ImmutableAssetTransientRead')<{
  readonly path: string;
  readonly transport: string;
}>;
/** Bound on one asset GET reaching its response headers. */
const ASSET_RESPONSE_TIMEOUT = Duration.seconds(10);
/** GETs of one asset per readback attempt, when the transport rather than the content fails. */
const ASSET_READ_ATTEMPTS = 3;

const RECEIPT_FILE_FLAG = 'receipt-file';
const SHELL_APP_ID = 'shell-super-app';
const NATIVE_ENVELOPE_MISMATCH = 'the native Cloudflare release envelope does not bind the final artifact bytes';
const PUBLIC_ASSET_INVENTORY_MISMATCH =
  'the deployed immutable public release does not serve the exact compiled asset inventory';

const sourceRevision = Schema.String.check(Schema.isPattern(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u));
const buildMarker = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u));
const appId = OntosDeploymentAppIdSchema;
const workerVersionIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand('WorkerVersionId'),
  Schema.decodeTo(Schema.String),
);
const deliveryUnitIdSchema = Schema.NonEmptyString.pipe(Schema.brand('DeliveryUnitId'), Schema.decodeTo(Schema.String));
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u));
const artifact = Schema.Struct({ sha256, url: Schema.String });
/** The deploy plan's word for a secret fingerprint it cannot compute: no fingerprint key or no release secrets. */
const SECRET_FINGERPRINT_UNAVAILABLE = 'unavailable';
const secretFingerprintSchema = Schema.String.check(Schema.isPattern(/^(?:[a-f\d]{64}|unavailable)$/u));

export const ImmutableApplicationReleasePlanSchema = Schema.Struct({
  appId,
  assetsOrigin: Schema.String,
  assetsScriptName: Schema.String,
  backendScriptName: Schema.String,
  buildMarker,
  sourceRevision,
});
export type ImmutableApplicationReleasePlan = typeof ImmutableApplicationReleasePlanSchema.Type;

export const ImmutableApplicationReleaseReceiptSchema = Schema.Struct({
  artifacts: Schema.Struct({
    assetsSha256: sha256,
    contract: artifact,
    federationManifest: Schema.optionalKey(artifact),
    workerSha256: sha256,
  }),
  assetsVersionId: workerVersionIdSchema,
  backend: ApplicationCompositionCloudflareWorkerBackendSchema,
  plan: ImmutableApplicationReleasePlanSchema,
  /**
   * The deploy plan's HMAC of the unit's release secrets (its `secretFingerprint`) that the backend Worker version
   * holds. The release identity names a source revision, not its secrets, so a rotation at the same revision finds
   * the same Workers; this fingerprint, also annotated on the Worker version, is how reuse tells them apart.
   */
  secretFingerprint: secretFingerprintSchema,
});
export type ImmutableApplicationReleaseReceipt = typeof ImmutableApplicationReleaseReceiptSchema.Type;

export const ImmutableShellArtifactReceiptSchema = Schema.Struct({
  artifacts: Schema.Struct({
    assetsSha256: sha256,
    federationManifest: artifact,
    runtimeContract: artifact,
  }),
  assetsVersionId: workerVersionIdSchema,
  plan: ImmutableApplicationReleasePlanSchema,
});
export type ImmutableShellArtifactReceipt = typeof ImmutableShellArtifactReceiptSchema.Type;

const fail = (message: string, cause?: unknown) => new ImmutableApplicationReleaseError({ cause, message });

const isTransientUploadFailure = <E,>(failure: E): boolean =>
  Schema.is(ImmutableApplicationReleaseError)(failure) && failure.transient === true;

/** Whether a failed attempt leaves a half release of its own to remove: a transient failure, or an incomplete one. */
const leavesOwnHalfRelease = <E,>(failure: E): boolean =>
  isTransientUploadFailure(failure) ||
  (Schema.is(ImmutableApplicationReleaseError)(failure) && failure.removeHalfRelease === true);

/** Marks a Wrangler upload failure the provider reported as transient, so its release attempt may run again. */
const classifyTransientUpload = <A, E, R>(upload: Effect.Effect<A, E, R>) =>
  upload.pipe(
    Effect.mapError((failure) =>
      Schema.is(OpsCommandError)(failure) && failure.transient === true
        ? new ImmutableApplicationReleaseError({
            cause: failure,
            message: 'the provider failed the upload transiently',
            transient: true,
          })
        : failure,
    ),
  );

export const IMMUTABLE_UPLOAD_ATTEMPTS = 3;

/** The pause before each repeated upload attempt: 10 s, then 20 s. */
export const ImmutableUploadRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  '@app/scripts/immutable-application-release/ImmutableUploadRetrySchedule',
  { defaultValue: () => Schedule.exponential('10 seconds') },
);

/** How often one idempotent provider write (a Worker deletion, a workers.dev route) is attempted. */
export const IMMUTABLE_PROVIDER_WRITE_ATTEMPTS = 6;

/** The pause before each repeated idempotent provider write: 5 s, doubling, about 2.5 minutes in all. */
export const ImmutableProviderWriteRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  '@app/scripts/immutable-application-release/ImmutableProviderWriteRetrySchedule',
  { defaultValue: () => Schedule.exponential('5 seconds') },
);

const providerScriptUrl = (accountId: string, scriptName: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`;

/** A provider answer that says nothing about the request itself: rate limiting or a gateway or server error. */
const isTransientProviderStatus = (status: number) => status === 429 || status >= 500;

/**
 * Classifies one provider Worker script lookup. The provider answers 200 for a Worker with its own code and
 * 204 for an assets-only Worker; only 404 establishes absence. Every other answer establishes neither.
 */
export const immutableProviderScriptPresence = (status: number): 'absent' | 'present' | 'unknown' => {
  if (status === 200 || status === 204) {
    return 'present';
  }
  return status === 404 ? 'absent' : 'unknown';
};

/** Why one deletion attempt did not prove the Worker gone. */
const ImmutableWorkerStillPresent = Data.TaggedError('ImmutableWorkerStillPresent')<{
  readonly status: number | 'timeout';
}>;

/**
 * Deletes one Worker and proves it gone. The provider's 404 proves absence; its 200 is checked by reading the
 * Worker back. A rate limit, gateway or server error, or timeout proves neither (a 504 deletion may well have
 * happened), so the Worker is read back and the deletion repeated until a read proves it absent, at most
 * {@link IMMUTABLE_PROVIDER_WRITE_ATTEMPTS} times. Any other answer is a refusal and ends at once. Deletion is
 * never forced: the provider keeps a Worker another Worker's service binding still references.
 */
export const deleteImmutableWorker = Effect.fn('ImmutableApplicationRelease.deleteWorker')(
  function* deleteImmutableWorkerEffect(accountId: string, token: Redacted.Redacted, scriptName: string) {
    const client = yield* HttpClient.HttpClient;
    const schedule = yield* Effect.service(ImmutableProviderWriteRetrySchedule);
    const status = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(HttpClientRequest.bearerToken(request, Redacted.value(token))).pipe(
        Effect.tap((response) => Effect.ignore(response.arrayBuffer)),
        Effect.map((response) => response.status),
        Effect.timeout(Duration.seconds(30)),
        Effect.orElseSucceed(() => 'timeout' as const),
      );
    const url = providerScriptUrl(accountId, scriptName);
    const attempt = Effect.gen(function* deleteOnce() {
      const deleted = yield* status(HttpClientRequest.delete(url));
      if (deleted === 404) {
        return yield* Effect.void;
      }
      if (deleted !== 200 && deleted !== 'timeout' && !isTransientProviderStatus(deleted)) {
        return yield* fail(
          `the provider refused to delete the immutable Worker ${scriptName} (HTTP ${String(deleted)})`,
        );
      }
      const observed = yield* status(HttpClientRequest.get(url));
      if (observed !== 404) {
        return yield* new ImmutableWorkerStillPresent({ status: deleted });
      }
      return yield* Effect.void;
    });
    return yield* attempt.pipe(
      Effect.retry({
        schedule,
        times: IMMUTABLE_PROVIDER_WRITE_ATTEMPTS - 1,
        while: Predicate.isTagged('ImmutableWorkerStillPresent'),
      }),
      Effect.catchTag('ImmutableWorkerStillPresent', ({ status: last }) =>
        Effect.fail(
          fail(
            `the immutable Worker ${scriptName} was still present after ${String(IMMUTABLE_PROVIDER_WRITE_ATTEMPTS)} deletions (last answer ${String(last)})`,
          ),
        ),
      ),
    );
  },
);

/**
 * Removes what a failed attempt may have created under its release identities. The attempt held the identity lock
 * and found every identity absent before it uploaded, so anything present now is its own unpublished half release.
 */
const removeHalfCreatedImmutableRelease = Effect.fn('ImmutableApplicationRelease.removeHalfCreated')(
  function* removeHalfCreatedImmutableReleaseEffect(scriptNames: readonly string[]) {
    const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
    const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    // The backend goes first: it may reference its assets Worker, never the other way round.
    // Removal stops at the first identity the provider keeps, so nothing behind it is removed either.
    return yield* Effect.forEach(
      scriptNames,
      (scriptName) =>
        deleteImmutableWorker(accountId, token, scriptName).pipe(
          Effect.mapError((cause) =>
            fail(`the half-created immutable release ${scriptName} could not be removed`, cause),
          ),
          Effect.as(scriptName),
        ),
      { concurrency: 1 },
    );
  },
);

export const PUBLISHED_HALF_RELEASE =
  'a half present immutable release identity is named by the active Application Composition; publication must never overwrite it';

/**
 * An identity with exactly one of its two Workers (a prune or a removal stopped between them) cannot serve, and the
 * same source revision always derives the same identity, so it can only be released again once the survivor is gone.
 * The caller holds the identity lock, so no other upload creates or reads either Worker meanwhile. The survivor is
 * removed only while the active Application Composition provably names neither Worker (a published identity is never
 * replaced) and the provider deletes it (it refuses while another Worker's service binding references it).
 */
const removeUnreferencedHalfRelease = Effect.fn('ImmutableApplicationRelease.removeUnreferencedHalf')(
  function* removeUnreferencedHalfReleaseEffect(
    accountId: string,
    token: Redacted.Redacted,
    plan: ImmutableApplicationReleasePlan,
    survivor: string,
  ) {
    const active = yield* readPublishedSnapshot.pipe(
      Effect.mapError((cause) =>
        fail(
          `${survivor} is the only Worker of its immutable release identity, and without the active Application Composition it cannot be proven unreferenced`,
          cause,
        ),
      ),
    );
    if (
      Option.isSome(active) &&
      [plan.backendScriptName, plan.assetsScriptName].some((name) => active.value.includes(name))
    ) {
      return yield* fail(PUBLISHED_HALF_RELEASE);
    }
    yield* Effect.logWarning(
      `${survivor} is the only Worker of its immutable release identity and nothing active names it; removing it so the pair is uploaded whole`,
    );
    return yield* deleteImmutableWorker(accountId, token, survivor).pipe(
      Effect.mapError((cause) => fail(`the unreferenced half release ${survivor} could not be removed`, cause)),
    );
  },
);

const removeAfterFailedAttempt =
  (scriptNames: readonly string[], attempt: number) =>
  <E,>(failure: E) =>
    leavesOwnHalfRelease(failure)
      ? Effect.logWarning(
          `${isTransientUploadFailure(failure) ? 'transient provider failure' : 'incomplete upload'} releasing ${scriptNames.join(', ')} (attempt ${String(attempt)} of ${String(IMMUTABLE_UPLOAD_ATTEMPTS)}); removing its half release`,
        ).pipe(Effect.andThen(removeHalfCreatedImmutableRelease(scriptNames)))
      : Effect.void;

const finalTransientFailure = <E,>(failure: E) =>
  isTransientUploadFailure(failure)
    ? fail(
        `the provider failed transiently on all ${String(IMMUTABLE_UPLOAD_ATTEMPTS)} upload attempts; the half release was removed`,
        failure,
      )
    : failure;

/**
 * Runs one immutable release attempt up to {@link IMMUTABLE_UPLOAD_ATTEMPTS} times while the provider fails
 * transiently, removing each failed attempt's half release first so the next one starts from verified absence
 * under the same content-addressed identity. A failed final attempt leaves no half release either, so the
 * same commit can be released again. An incomplete upload (`removeHalfRelease`) also removes its half release but
 * is not attempted again. Every other failure ends the release at once.
 */
export const retryTransientImmutableUpload =
  (scriptNames: readonly string[]) =>
  <A, E, R>(attempt: Effect.Effect<A, E, R>) =>
    Effect.gen(function* retryTransientImmutableUploadEffect() {
      const schedule = yield* Effect.service(ImmutableUploadRetrySchedule);
      let attempts = 0;
      const attemptOnce = Effect.suspend(() => {
        attempts += 1;
        return attempt.pipe(Effect.tapError(removeAfterFailedAttempt(scriptNames, attempts)));
      });
      return yield* attemptOnce.pipe(
        Effect.retry({ schedule, times: IMMUTABLE_UPLOAD_ATTEMPTS - 1, while: isTransientUploadFailure }),
        Effect.mapError(finalTransientFailure),
      );
    });

/** Logs how long each upload phase took since the previous mark, so a slow release names its slow step. */
const releasePhaseTimer = (release: string) =>
  Effect.gen(function* startReleasePhaseTimer() {
    let last = yield* Clock.currentTimeMillis;
    return (phase: string) =>
      Effect.gen(function* markReleasePhase() {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo(`release ${release} phase ${phase}: ${String(now - last)} ms`);
        last = now;
      });
  });

export const resolveCleanImmutableApplicationSourceRevision = Effect.fn('ImmutableApplicationRelease.cleanSource')(
  function* cleanSourceRevision(directory: string) {
    const git = (args: readonly string[]) =>
      runCommand({ args, command: 'git', cwd: directory, env: {}, extendEnv: false }).pipe(
        Effect.mapError((cause) => fail('immutable release publication requires a clean Git checkout', cause)),
      );
    yield* git(['rev-parse', '--show-toplevel']);
    const revision = (yield* git(['rev-parse', '--verify', 'HEAD'])).trim();
    if ((yield* git(['status', '--porcelain=v1', '--untracked-files=all'])).trim() !== '') {
      return yield* fail('immutable release publication requires a clean Git checkout');
    }
    return yield* Schema.decodeUnknownEffect(sourceRevision)(revision).pipe(
      Effect.mapError((cause) => fail('immutable release publication requires a real Git source revision', cause)),
    );
  },
);

export const deriveImmutableApplicationReleasePlan = Effect.fn('ImmutableApplicationRelease.plan')(
  function* makeImmutableReleasePlan(input: {
    readonly appId: string;
    readonly buildMarker: string;
    readonly sourceRevision: string;
    readonly workersDevSubdomain: string;
  }) {
    yield* Schema.decodeUnknownEffect(Schema.Struct({ appId, buildMarker, sourceRevision }), {
      onExcessProperty: 'error',
    })({
      appId: input.appId,
      buildMarker: input.buildMarker,
      sourceRevision: input.sourceRevision,
    }).pipe(Effect.mapError((cause) => fail('release evidence failed validation', cause)));
    if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(input.workersDevSubdomain)) {
      return yield* fail('an exact Cloudflare workers.dev subdomain is required');
    }
    const [backendScriptName, assetsScriptName] = yield* Effect.all([
      moduleReleaseWorkerName(input.appId, input.buildMarker),
      moduleReleaseAssetWorkerName(input.appId, input.buildMarker),
    ]).pipe(Effect.mapError((cause) => fail('release identity could not be calculated', cause)));
    return {
      appId: input.appId,
      assetsOrigin: `https://${assetsScriptName}.${input.workersDevSubdomain}.workers.dev/`,
      assetsScriptName,
      backendScriptName,
      buildMarker: input.buildMarker,
      sourceRevision: input.sourceRevision,
    } satisfies ImmutableApplicationReleasePlan;
  },
);

export const immutableAssetsWranglerConfig = (
  plan: ImmutableApplicationReleasePlan,
  assetsDirectory: string,
  compatibilityDate: string,
) => ({
  assets: { directory: assetsDirectory, html_handling: 'none', not_found_handling: 'none' },
  compatibility_date: compatibilityDate,
  name: plan.assetsScriptName,
  preview_urls: false,
  workers_dev: true,
});

export const validateReleasePlan = (plan: ImmutableApplicationReleasePlan) =>
  Effect.gen(function* validateReleasePlanEffect() {
    yield* Schema.decodeUnknownEffect(ImmutableApplicationReleasePlanSchema, { onExcessProperty: 'error' })(plan).pipe(
      Effect.mapError((cause) => fail('release plan failed validation', cause)),
    );
    const [backendName, assetsName] = yield* Effect.all([
      moduleReleaseWorkerName(plan.appId, plan.buildMarker),
      moduleReleaseAssetWorkerName(plan.appId, plan.buildMarker),
    ]).pipe(Effect.mapError((cause) => fail('release identity could not be calculated', cause)));
    const origin = URL.parse(plan.assetsOrigin);
    if (
      backendName !== plan.backendScriptName ||
      assetsName !== plan.assetsScriptName ||
      origin === null ||
      origin.href !== plan.assetsOrigin ||
      origin.protocol !== 'https:' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      origin.username !== '' ||
      origin.password !== '' ||
      !new RegExp(`^${assetsName}\\.[a-z\\d](?:[a-z\\d-]*[a-z\\d])?\\.workers\\.dev$`, 'u').test(origin.hostname)
    ) {
      return yield* fail('provider names and assets origin must identify the exact immutable release');
    }
    return yield* Effect.void;
  });

export interface ReleaseFile {
  readonly bytes: Uint8Array;
  readonly path: string;
}
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const InventorySchema = Schema.Array(Schema.Struct({ path: Schema.String, sha256, size: Schema.Number }));
const inventoryHash = Effect.fn('ImmutableApplicationRelease.inventoryHash')(function* inventoryHashEffect(
  files: readonly ReleaseFile[],
) {
  const inventory = EffectArray.sort(
    files,
    Order.mapInput(Order.String, (file: ReleaseFile) => file.path),
  ).map((file) => ({ path: file.path, sha256: hash(file.bytes), size: file.bytes.byteLength }));
  return hash(yield* Schema.encodeEffect(Schema.fromJsonString(InventorySchema))(inventory));
});
export const decodeUtf8 = (bytes: Uint8Array) =>
  Effect.try({
    catch: (cause) => fail('release artifact is not exact UTF-8', cause),
    try: () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  });
const ReleaseContractSchema = Schema.Struct({ deployment: Schema.Struct({ appId, buildMarker }) });
const ManifestSchema = Schema.Struct({
  exposes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        assets: Schema.Struct({
          css: Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) }),
          js: Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) }),
        }),
      }),
    ),
  ),
  metaData: Schema.Struct({
    publicPath: Schema.String,
    remoteEntry: Schema.optionalKey(
      Schema.Struct({
        name: Schema.String,
        path: Schema.optionalKey(Schema.String),
        type: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
  remoteEntry: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
  remotes: Schema.optionalKey(Schema.Array(Schema.Json)),
  shared: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        assets: Schema.Struct({
          css: Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) }),
          js: Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) }),
        }),
      }),
    ),
  ),
});

const federationEntrypoints = (manifest: typeof ManifestSchema.Type): readonly string[] => {
  const { remoteEntry } = manifest.metaData;
  if (remoteEntry === undefined) {
    return manifest.remoteEntry === undefined ? [] : [manifest.remoteEntry.name];
  }
  return [`${remoteEntry.path ?? ''}${remoteEntry.name}`];
};

const ShellRouteAssetsSchema = Schema.Struct({
  routeAssets: Schema.Record(
    Schema.NonEmptyString,
    Schema.Struct({
      assets: Schema.Array(Schema.NonEmptyString),
      referenceCssAssets: Schema.Array(Schema.NonEmptyString),
    }),
  ),
});

const isShellConsumerManifest = (manifest: typeof ManifestSchema.Type) => {
  const { remoteEntry } = manifest.metaData;
  return (
    remoteEntry?.name === '' &&
    remoteEntry.path === '' &&
    remoteEntry.type === 'global' &&
    manifest.remoteEntry === undefined &&
    manifest.exposes?.length === 0 &&
    manifest.remotes?.length === 0
  );
};

const shellConsumerEntrypoints = Effect.fn('ImmutableApplicationRelease.shellConsumerEntrypoints')(
  function* nativeShellConsumerEntrypoints(
    assetsOrigin: string,
    manifest: typeof ManifestSchema.Type,
    assets: ReadonlyMap<string, ReleaseFile['bytes']>,
  ) {
    if (!isShellConsumerManifest(manifest)) {
      return yield* fail('a Shell consumer manifest must not declare a remote producer or static remotes');
    }
    const routesBytes = assets.get('routes-manifest.json');
    if (routesBytes === undefined) {
      return yield* fail('a Shell consumer release requires its native route asset manifest');
    }
    const routes = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellRouteAssetsSchema))(
      yield* decodeUtf8(routesBytes),
    ).pipe(Effect.mapError((cause) => fail('the native Shell route asset manifest is invalid', cause)));
    const routeAssets = Object.values(routes.routeAssets);
    if (routeAssets.length === 0 || routeAssets.some((route) => !route.assets.some((entry) => entry.endsWith('.js')))) {
      return yield* fail('every native Shell route must retain a compiled client entrypoint');
    }
    const nativeEntries = routeAssets.flatMap((route) => [...route.assets, ...route.referenceCssAssets]);
    const { origin } = new URL(assetsOrigin);
    const paths: string[] = [];
    for (const entry of nativeEntries) {
      const destination = URL.parse(entry, assetsOrigin);
      if (
        destination === null ||
        destination.origin !== origin ||
        destination.search !== '' ||
        destination.hash !== '' ||
        destination.username !== '' ||
        destination.password !== '' ||
        ![destination.href, destination.pathname, destination.pathname.slice(1)].includes(entry)
      ) {
        return yield* fail('native Shell route assets must identify exact files within the immutable origin');
      }
      paths.push(destination.pathname.slice(1));
    }
    return paths;
  },
);

const validateReleaseFilePaths = Effect.fn('ImmutableApplicationRelease.filePaths')(
  function* validateReleaseFilePathsEffect(files: readonly ReleaseFile[]) {
    const paths = new Set<string>();
    for (const file of files) {
      if (
        !/^[\w.@$()[\]-]+(?:\/[\w.@$()[\]-]+)*$/u.test(file.path) ||
        file.path.split('/').some((part) => part === '..' || part === '.') ||
        paths.has(file.path)
      ) {
        return yield* fail('artifact inventory contains an unsafe or duplicate path', { path: file.path });
      }
      paths.add(file.path);
    }
    return yield* Effect.void;
  },
);

const validateImmutablePublicAssetInventory = Effect.fn('ImmutableApplicationRelease.publicInventory')(
  function* validateImmutablePublicAssetInventoryEffect(assets: readonly ReleaseFile[]) {
    yield* validateReleaseFilePaths(assets);
    if (
      assets.some((file) =>
        /(?:\.map(?:\.(?:gz|br))?$|(?:^|\/)(?:\.env|worker|server|node_modules|credentials|private-key)(?:[./]|$)|\.(?:pem|key)$)/u.test(
          file.path,
        ),
      )
    ) {
      return yield* fail('public release assets contain private runtime files or sourcemaps');
    }
    return yield* Effect.void;
  },
);

const validateReleaseInventory = Effect.fn('ImmutableApplicationRelease.validateInventory')(
  function* validateReleaseInventoryEffect(
    assets: readonly ReleaseFile[],
    backendFiles: readonly ReleaseFile[],
    backendEntrypoint: string,
  ) {
    yield* validateImmutablePublicAssetInventory(assets);
    yield* validateReleaseFilePaths(backendFiles);
    if (!backendFiles.some((file) => file.path === backendEntrypoint)) {
      return yield* fail('the complete compiled Worker entrypoint is missing');
    }
    return yield* Effect.void;
  },
);

interface ImmutablePublicReleaseArtifacts {
  readonly assetsSha256: string;
  readonly federationManifest?: { readonly sha256: string; readonly url: string };
}

export const validateImmutablePublicAssets = Effect.fn('ImmutableApplicationRelease.publicAssets')(
  function* validateImmutablePublicAssetsEffect(plan: ImmutableApplicationReleasePlan, files: readonly ReleaseFile[]) {
    yield* validateReleasePlan(plan);
    yield* validateImmutablePublicAssetInventory(files);
    const assets = new Map(files.map((file) => [file.path, file.bytes]));
    const manifestBytes = assets.get('mf-manifest.json');
    if (manifestBytes !== undefined) {
      const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestSchema))(
        yield* decodeUtf8(manifestBytes),
      ).pipe(Effect.mapError((cause) => fail('Federation release manifest is invalid', cause)));
      if (manifest.metaData.publicPath !== plan.assetsOrigin) {
        return yield* fail('Federation publicPath must already point at the immutable release origin');
      }
      const entries =
        plan.appId === SHELL_APP_ID
          ? yield* shellConsumerEntrypoints(plan.assetsOrigin, manifest, assets)
          : federationEntrypoints(manifest);
      const required = [
        ...entries,
        ...[...(manifest.exposes ?? []), ...(manifest.shared ?? [])].flatMap(({ assets: asset }) => [
          ...asset.js.sync,
          ...asset.js.async,
          ...asset.css.sync,
          ...asset.css.async,
        ]),
      ];
      if (entries.length === 0 || required.some((entry) => !assets.has(entry.replace(/^\/+/u, '')))) {
        return yield* fail('Federation manifest references an absent release entrypoint or chunk');
      }
    }
    const artifacts: ImmutablePublicReleaseArtifacts = { assetsSha256: yield* inventoryHash(files) };
    return manifestBytes === undefined
      ? artifacts
      : {
          ...artifacts,
          federationManifest: { sha256: hash(manifestBytes), url: `${plan.assetsOrigin}mf-manifest.json` },
        };
  },
);

export const validateImmutableApplicationReleaseArtifacts = Effect.fn('ImmutableApplicationRelease.artifacts')(
  function* validateImmutableReleaseArtifactsEffect(
    plan: ImmutableApplicationReleasePlan,
    input: {
      readonly assets: readonly ReleaseFile[];
      readonly backendEntrypoint: string;
      readonly backendFiles: readonly ReleaseFile[];
      readonly contract: { readonly deployment: { readonly appId: string; readonly buildMarker: string } };
      readonly deliveryUnit: { readonly buildMarker: string; readonly sourceRevision: string; readonly unitId: string };
    },
  ) {
    yield* validateReleasePlan(plan);
    if (
      input.deliveryUnit.sourceRevision !== plan.sourceRevision ||
      input.deliveryUnit.buildMarker !== plan.buildMarker ||
      input.deliveryUnit.unitId !== `app/${plan.appId}` ||
      input.contract.deployment.appId !== plan.appId ||
      input.contract.deployment.buildMarker !== plan.buildMarker
    ) {
      return yield* fail(
        'compiled Worker, deployment contract and release plan must identify the same clean source release',
      );
    }
    yield* validateReleaseInventory(input.assets, input.backendFiles, input.backendEntrypoint);
    const assets = new Map(input.assets.map((file) => [file.path, file.bytes]));
    const contractBytes = assets.get('.well-known/ontos-module-manifest.json');
    if (contractBytes === undefined) {
      return yield* fail('the exact deployment contract must be part of the immutable public assets');
    }
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseContractSchema))(
      yield* decodeUtf8(contractBytes),
    ).pipe(Effect.mapError((cause) => fail('release contract bytes are invalid', cause)));
    if (contract.deployment.appId !== plan.appId || contract.deployment.buildMarker !== plan.buildMarker) {
      return yield* fail('published contract bytes identify a different release');
    }
    const artifacts: ImmutableApplicationReleaseReceipt['artifacts'] = {
      ...(yield* validateImmutablePublicAssets(plan, input.assets)),
      contract: { sha256: hash(contractBytes), url: `${plan.assetsOrigin}.well-known/ontos-module-manifest.json` },
      workerSha256: yield* inventoryHash(input.backendFiles),
    };
    return artifacts;
  },
);

interface ImmutableApplicationReleaseCandidateModule {
  readonly appId: string;
  readonly backend: typeof ApplicationCompositionCloudflareWorkerBackendSchema.Type;
  readonly contractUrl: string;
}

const shellReceiptArtifacts = Effect.fn('ImmutableApplicationRelease.shellReceipt')(
  function* shellReceiptArtifactsEffect(raw: ImmutableShellArtifactReceipt) {
    const receipt = yield* Schema.decodeUnknownEffect(ImmutableShellArtifactReceiptSchema, {
      onExcessProperty: 'error',
    })(raw).pipe(Effect.mapError((cause) => fail('the retained Shell artifact receipt failed validation', cause)));
    yield* validateReleasePlan(receipt.plan);
    if (
      receipt.plan.appId !== SHELL_APP_ID ||
      receipt.artifacts.runtimeContract.url !== `${receipt.plan.assetsOrigin}.well-known/ontos-shell-runtime.json` ||
      receipt.artifacts.federationManifest.url !== `${receipt.plan.assetsOrigin}mf-manifest.json`
    ) {
      return yield* fail('the Shell artifact receipt must identify the exact retained Shell release');
    }
    return {
      deployment: { appId: SHELL_APP_ID, buildMarker: receipt.plan.buildMarker },
      federationManifest: receipt.artifacts.federationManifest,
      runtimeContract: receipt.artifacts.runtimeContract,
    } satisfies (typeof ApplicationCompositionPublicationCandidateSchema.Type)['shell'];
  },
);

export const makeImmutableApplicationReleasePublicationCandidate = Effect.fn('ImmutableApplicationRelease.candidate')(
  function* publicationCandidateEffect(
    receipts: readonly ImmutableApplicationReleaseReceipt[],
    intent: ApplicationReleaseIntent,
    shellReceipt?: ImmutableShellArtifactReceipt,
    retainedSnapshot?: ActiveApplicationCompositionSnapshot,
  ) {
    yield* Schema.decodeUnknownEffect(ApplicationReleaseIntentSchema, { onExcessProperty: 'error' })(intent).pipe(
      Effect.mapError((cause) => fail('the reviewed complete release intent failed validation', cause)),
    );
    const selection = new Set(intent.modules.map((module) => module.appId));
    if (selection.size !== intent.modules.length || selection.has(SHELL_APP_ID) || receipts.length !== selection.size) {
      return yield* fail('every selected module requires exactly one retained deployment receipt');
    }
    const identities = new Set<string>();
    const modules = [];
    for (const raw of receipts) {
      const receipt = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseReceiptSchema, {
        onExcessProperty: 'error',
      })(raw).pipe(Effect.mapError((cause) => fail('release receipt failed validation', cause)));
      yield* validateReleasePlan(receipt.plan);
      if (
        identities.has(receipt.plan.appId) ||
        !selection.has(receipt.plan.appId) ||
        receipt.backend.workerName !== receipt.plan.backendScriptName ||
        receipt.backend.baseUrl !==
          receipt.plan.assetsOrigin.replace(
            `${receipt.plan.assetsScriptName}.`,
            `${receipt.plan.backendScriptName}.`,
          ) ||
        receipt.artifacts.contract.url !== `${receipt.plan.assetsOrigin}.well-known/ontos-module-manifest.json` ||
        (receipt.artifacts.federationManifest !== undefined &&
          receipt.artifacts.federationManifest.url !== `${receipt.plan.assetsOrigin}mf-manifest.json`)
      ) {
        return yield* fail('candidate requires unique, retained, exact release deployment receipts');
      }
      identities.add(receipt.plan.appId);
      const module: ImmutableApplicationReleaseCandidateModule = {
        appId: receipt.plan.appId,
        backend: receipt.backend,
        contractUrl: receipt.artifacts.contract.url,
      };
      modules.push(
        receipt.artifacts.federationManifest === undefined
          ? module
          : { ...module, federationManifestUrl: receipt.artifacts.federationManifest.url },
      );
    }
    if (shellReceipt !== undefined) {
      if (retainedSnapshot !== undefined) {
        return yield* fail('publication requires exactly one genuine Shell artifact source');
      }
      return { modules, shell: yield* shellReceiptArtifacts(shellReceipt) };
    }
    if (retainedSnapshot === undefined) {
      return yield* fail('publication requires a genuine Shell receipt or captured approved snapshot');
    }
    const approved = yield* validateActiveApplicationCompositionSnapshot(retainedSnapshot).pipe(
      Effect.mapError((cause) => fail('the retained approved snapshot is invalid or expired', cause)),
    );
    yield* assertRetainedReleaseArtifactPaths(approved).pipe(
      Effect.mapError((cause) => fail('the approved snapshot does not identify retained native release assets', cause)),
    );
    const { deployment, federationManifest, runtimeContract } = approved.composition.shell;
    return {
      modules,
      retainedShellRevision: approved.composition.revision,
      shell: { deployment, federationManifest, runtimeContract },
    };
  },
);

export const readReleaseFiles = (
  root: string,
  base = '',
): Effect.Effect<readonly ReleaseFile[], PlatformError | ImmutableApplicationReleaseError, FileSystem.FileSystem> =>
  Effect.gen(function* readReleaseFilesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const canonicalRoot = yield* fileSystem.realPath(root);
    const files: ReleaseFile[] = [];
    for (const name of yield* fileSystem.readDirectory(path.join(canonicalRoot, base))) {
      const relative = base === '' ? name : `${base}/${name}`;
      const location = path.join(canonicalRoot, relative);
      if ((yield* fileSystem.realPath(location)) !== location) {
        return yield* fail('release inventory may not include symbolic links');
      }
      const info = yield* fileSystem.stat(location);
      if (info.type === 'Directory') {
        files.push(...(yield* readReleaseFiles(canonicalRoot, relative)));
      } else if (info.type === 'File') {
        files.push({ bytes: yield* fileSystem.readFile(location), path: relative });
      } else {
        return yield* fail('release inventory must contain only regular files and directories');
      }
    }
    return files;
  });

export const readImmutablePublicReleaseFiles = Effect.fn('ImmutableApplicationRelease.publicFiles')(
  function* readImmutablePublicReleaseFilesEffect(root: string) {
    const files = yield* readReleaseFiles(root);
    yield* validateReleaseFilePaths(files);
    return files.filter((file) => !/\.map(?:\.(?:gz|br))?$/u.test(file.path));
  },
);

export const materializeImmutablePublicAssets = Effect.fn('ImmutableApplicationRelease.materializePublicAssets')(
  function* materializeImmutablePublicAssetsEffect(files: readonly ReleaseFile[], directory?: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* validateImmutablePublicAssetInventory(files);
    const destination = yield* fileSystem.makeTempDirectoryScoped({
      directory,
      prefix: 'ontos-immutable-assets-',
    });
    for (const file of files) {
      const location = path.join(destination, file.path);
      yield* fileSystem.makeDirectory(path.dirname(location), { recursive: true });
      yield* fileSystem.writeFile(location, file.bytes);
    }
    return destination;
  },
);

const WranglerSchema = Schema.StructWithRest(
  Schema.Struct({
    alias: Schema.optionalKey(Schema.Json),
    assets: Schema.StructWithRest(Schema.Struct({ directory: Schema.NonEmptyString }), [
      Schema.Record(Schema.String, Schema.Json),
    ]),
    build: Schema.optionalKey(Schema.Json),
    compatibility_date: Schema.NonEmptyString,
    define: Schema.optionalKey(Schema.Json),
    main: Schema.NonEmptyString,
    minify: Schema.optionalKey(Schema.Json),
    no_bundle: Schema.optionalKey(Schema.Boolean),
    rules: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          fallthrough: Schema.optionalKey(Schema.Boolean),
          globs: Schema.Array(Schema.String),
          type: Schema.Literals([
            'ESModule',
            'CommonJS',
            'CompiledWasm',
            'Data',
            'Text',
            'PythonModule',
            'PythonRequirement',
          ]),
        }),
      ),
    ),
    tsconfig: Schema.optionalKey(Schema.Json),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const DeliveryUnitSchema = Schema.Struct({
  deliveryUnit: Schema.Struct({ buildMarker, sourceRevision, unitId: deliveryUnitIdSchema }),
});
const PinnedNativeTools = Schema.Struct({
  devDependencies: Schema.Struct({
    wrangler: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][a-z\d.-]+)?$/u)),
  }),
});

export const verifyPinnedWrangler = Effect.fn('ImmutableApplicationRelease.nativeToolchain')(
  function* verifyPinnedWranglerEffect(directory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const tools = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PinnedNativeTools))(
      yield* fileSystem.readFileString(path.join(directory, 'package.json')),
    ).pipe(Effect.mapError((cause) => fail('the delivery unit must pin its exact native Wrangler version', cause)));
    const version = yield* runCommand({
      args: ['exec', 'wrangler', '--version'],
      command: 'pnpm',
      cwd: directory,
    }).pipe(Effect.mapError((cause) => fail('the pinned native Wrangler toolchain is unavailable', cause)));
    if (version.trim() !== tools.devDependencies.wrangler) {
      return yield* fail('the resolved native Wrangler version differs from the delivery unit toolchain pin');
    }
    return yield* Effect.void;
  },
);

const verifyNativeReleaseOutput = Effect.fn('ImmutableApplicationRelease.nativeEnvelope')(
  function* verifyNativeReleaseOutputEffect(
    output: string,
    plan: ImmutableApplicationReleasePlan,
    expectedKind: ReleaseEnvelopeKind,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const serializedEnvelope = yield* fileSystem
      .readFileString(path.join(output, MICROVERTICAL_RELEASE_ENVELOPE_PATH))
      .pipe(Effect.mapError((cause) => fail(NATIVE_ENVELOPE_MISMATCH, cause)));
    const envelopeValue = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
      serializedEnvelope,
    ).pipe(Effect.mapError((cause) => fail(NATIVE_ENVELOPE_MISMATCH, cause)));
    const envelope = yield* Effect.tryPromise({
      catch: (cause) => fail(NATIVE_ENVELOPE_MISMATCH, cause),
      try: async () =>
        await verifyMicroVerticalReleaseEnvelope(envelopeValue, {
          artifactRoot: output,
          expectedKind,
          expectedTarget: 'cloudflare',
        }),
    });
    if (
      envelope.identity.unitId !== `app/${plan.appId}` ||
      envelope.identity.buildMarker !== plan.buildMarker ||
      envelope.identity.sourceRevision !== plan.sourceRevision
    ) {
      return yield* fail('the native Cloudflare release envelope identifies a different planned source release');
    }
    return envelope;
  },
);

export const readVerifiedReleaseFiles = Effect.fn('ImmutableApplicationRelease.verifiedFiles')(
  function* readVerifiedReleaseFilesEffect(
    output: string,
    plan: ImmutableApplicationReleasePlan,
    ownedPaths: readonly string[] = [],
    expectedKind: ReleaseEnvelopeKind = MICROVERTICAL_RELEASE_ENVELOPE_KIND,
  ) {
    const envelope = yield* verifyNativeReleaseOutput(output, plan, expectedKind);
    const boundPaths = new Set(envelope.artifacts.map(({ logicalPath }) => logicalPath));
    const temporaryPaths = ownedPaths.map((owned) => path.relative(output, owned).split(path.sep).join('/'));
    const files = (yield* readReleaseFiles(output)).filter(
      (file) => !temporaryPaths.some((owned) => file.path === owned || file.path.startsWith(`${owned}/`)),
    );
    if (files.some((file) => file.path !== MICROVERTICAL_RELEASE_ENVELOPE_PATH && !boundPaths.has(file.path))) {
      return yield* fail('the compiled release contains a file absent from its native artifact envelope');
    }
    return files;
  },
);

/**
 * The deploy plan's fingerprint of a unit's stored release secrets (`computeSecretFingerprints`, the plan's matrix
 * `secretFingerprint`): the same key and the same raw owner-keyed secrets the plan read, so equal fingerprints at one
 * source revision mean equal bound secrets. Without the key or the secrets it is `unavailable`, exactly as in the plan.
 */
export const currentReleaseSecretFingerprint = Effect.fn('ImmutableApplicationRelease.secretFingerprint')(
  function* currentReleaseSecretFingerprintEffect(unitId: string) {
    const key = yield* Config.option(Config.Redacted('RELEASE_FINGERPRINT_KEY'));
    const secretsFile = yield* Config.option(Config.Redacted('ALL_RELEASE_SECRETS_FILE'));
    const rawSecrets = Option.isSome(secretsFile)
      ? Option.some(
          yield* (yield* FileSystem.FileSystem)
            .readFileString(Redacted.value(secretsFile.value))
            .pipe(Effect.mapError((cause) => fail('the raw release secrets file cannot be read', cause))),
        )
      : (yield* Config.option(Config.Redacted('ALL_RELEASE_SECRETS'))).pipe(Option.map(Redacted.value));
    if (Option.isNone(key) || Option.isNone(rawSecrets) || rawSecrets.value === '') {
      return SECRET_FINGERPRINT_UNAVAILABLE;
    }
    const fingerprints = Option.liftThrowable(computeSecretFingerprints)({
      key: Redacted.value(key.value),
      rawSecrets: rawSecrets.value,
      unitIds: [unitId],
    });
    return Option.match(fingerprints, {
      onNone: () => SECRET_FINGERPRINT_UNAVAILABLE,
      onSome: (computed) => computed[unitId] ?? SECRET_FINGERPRINT_UNAVAILABLE,
    });
  },
  Effect.mapError((cause) =>
    Schema.is(ImmutableApplicationReleaseError)(cause)
      ? cause
      : fail('the release secret fingerprint configuration is invalid', cause),
  ),
);

/** A backend Worker version records the secret fingerprint it was uploaded with as its version message. */
export const releaseSecretFingerprintAnnotation = (secretFingerprint: string) =>
  `ontos-release-secrets:${secretFingerprint}`;

export const STALE_RELEASE_SECRETS =
  'the existing immutable release holds other release secrets than this release binds; a secret rotation needs a new source revision';

const WorkerVersionAnnotationsSchema = Schema.Struct({
  result: Schema.Struct({
    annotations: Schema.OptionFromOptionalNullOr(
      Schema.Struct({ 'workers/message': Schema.OptionFromOptionalNullOr(Schema.String) }),
    ),
  }),
  success: Schema.Boolean,
});

/** The exact backend Worker version must have been uploaded with `secretFingerprint`'s secrets. */
export const requireWorkerVersionSecretFingerprint = Effect.fn('ImmutableApplicationRelease.versionSecrets')(
  function* requireWorkerVersionSecretFingerprintEffect(
    accountId: string,
    token: Redacted.Redacted,
    scriptName: string,
    versionId: string,
    secretFingerprint: string,
  ) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.bearerToken(
        HttpClientRequest.get(`${providerScriptUrl(accountId, scriptName)}/versions/${encodeURIComponent(versionId)}`),
        Redacted.value(token),
      ),
    );
    const version = yield* Schema.decodeUnknownEffect(WorkerVersionAnnotationsSchema)(yield* response.json);
    if (response.status !== 200 || !version.success) {
      return yield* fail('the immutable backend Worker version could not be observed');
    }
    const message = version.result.annotations.pipe(Option.flatMap((annotations) => annotations['workers/message']));
    if (!Option.contains(message, releaseSecretFingerprintAnnotation(secretFingerprint))) {
      return yield* fail(STALE_RELEASE_SECRETS);
    }
    return yield* Effect.void;
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) =>
    Schema.is(ImmutableApplicationReleaseError)(cause)
      ? cause
      : fail('the immutable backend Worker version could not be observed within its timeout'),
  ),
);

/**
 * The environment of the digest recomputation: the build environment every unit digest covers, the runner platform
 * and PATH, nothing else. Inherited Git selectors (GIT_DIR, GIT_WORK_TREE, hook-exported GIT_INDEX_FILE) would make
 * the planner hash another checkout than the clean HEAD the source checks inspect. An empty value reads as unset, so
 * the recomputed digest then differs and the check fails closed. The secrets stay out: the release passes the
 * fingerprint it binds instead.
 */
const unitDigestEnvironment = Effect.gen(function* unitDigestEnvironmentEffect() {
  const entries = yield* Effect.forEach([...DIGEST_ENV_KEYS, 'RUNNER_OS', 'RUNNER_ARCH', 'PATH'], (name) =>
    Config.option(Config.String(name)).pipe(
      Effect.map(Option.map((value): readonly [string, Redacted.Redacted] => [name, Redacted.make(value)])),
    ),
  );
  return Object.fromEntries(EffectArray.getSomes(entries));
});

export interface PlannedUnitInputs {
  readonly artifactName?: string | undefined;
  readonly inputsFile?: string | undefined;
}

const PlannedUnitInputsDocumentSchema = Schema.Struct({
  digest: sha256,
  lines: Schema.Array(Schema.String),
  sourceRevision,
  unitId: appId,
  version: Schema.Literal('ontos-deploy-plan-v1'),
});

/** Old artifacts keep their identity only when the shared planner proves their inputs unchanged. */
export const requirePlannedUnitInputs = Effect.fn('ImmutableApplicationRelease.requirePlannedUnitInputs')(
  function* requirePlannedUnitInputsEffect(
    directory: string,
    plan: ImmutableApplicationReleasePlan,
    message: string,
    evidence: PlannedUnitInputs = {},
  ) {
    const revision = yield* resolveCleanImmutableApplicationSourceRevision(directory);
    if (revision === plan.sourceRevision) {
      return yield* Effect.void;
    }
    // The release names the build artifact it unpacked and the inputs.json the build packed beside its output.
    const { artifactName, inputsFile } = evidence;
    if (artifactName === undefined || inputsFile === undefined) {
      return yield* fail(message);
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const inputs = yield* fileSystem.readFileString(inputsFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PlannedUnitInputsDocumentSchema))),
      Effect.mapError(() => fail(message)),
    );
    if (
      inputs.unitId !== plan.appId ||
      inputs.sourceRevision !== plan.sourceRevision ||
      artifactName !== `edge-unit-${plan.appId}-${inputs.digest}`
    ) {
      return yield* fail(message);
    }
    // The CLI calls computeUnitDigest with the plan job's build environment and the fingerprint of the secrets
    // this release binds. Never derive current inputs from the downloaded artifact's own lines or digest.
    const secretFingerprint = yield* currentReleaseSecretFingerprint(plan.appId);
    const current = yield* runCommand({
      args: [
        path.resolve(import.meta.dirname, 'ci/deploy-plan.mts'),
        'unit-digest',
        '--unit',
        plan.appId,
        '--secret-fingerprint',
        secretFingerprint,
      ],
      command: 'node',
      cwd: directory,
      env: yield* unitDigestEnvironment,
      extendEnv: false,
    }).pipe(
      Effect.flatMap((digest) => Schema.decodeUnknownEffect(sha256)(digest.trim())),
      Effect.mapError(() => fail(message)),
    );
    if (current !== inputs.digest || (yield* resolveCleanImmutableApplicationSourceRevision(directory)) !== revision) {
      return yield* fail(message);
    }
    return yield* Effect.void;
  },
);

export const validateImmutableAssetRedirects = Effect.fn('ImmutableApplicationRelease.assetRedirects')(
  function* validateImmutableAssetRedirectsEffect(directory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const redirectsFile = path.join(directory, '_redirects');
    if (yield* fileSystem.exists(redirectsFile)) {
      const redirects = yield* fileSystem.readFileString(redirectsFile);
      if (redirects.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#'))) {
        return yield* fail('immutable release asset delivery must not redirect any artifact URL');
      }
    }
    return yield* Effect.void;
  },
);

export const verifyRetainedPublicAsset = Effect.fn('ImmutableApplicationRelease.assetReadback')(
  function* verifyRetainedPublicAssetEffect(
    plan: ImmutableApplicationReleasePlan,
    file: ReleaseFile,
    mode: 'new-upload' | 'retained-release' = 'new-upload',
  ) {
    const client = yield* HttpClient.HttpClient;
    const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
    const url = `${plan.assetsOrigin}${encodedPath}`;
    const bytes = new Uint8Array(file.bytes.byteLength);
    let lastNotReady: ImmutableAssetNotReadyError | null = null;
    const attempt = Effect.scoped(
      Effect.gen(function* readRetainedPublicAssetAttempt() {
        const response = yield* client.get(url).pipe(
          Effect.timeoutOrElse({
            duration: ASSET_RESPONSE_TIMEOUT,
            orElse: () => Effect.fail(new ImmutableAssetTransientRead({ path: file.path, transport: 'timeout' })),
          }),
        );
        if (response.status >= 500) {
          yield* response.stream.pipe(Stream.runDrain, Effect.ignore);
          return yield* new ImmutableAssetTransientRead({
            path: file.path,
            transport: `HTTP ${String(response.status)}`,
          });
        }
        if (response.status === 404) {
          yield* response.stream.pipe(Stream.runDrain);
          return false;
        }
        if (response.status !== 200) {
          return yield* fail('the deployed immutable public asset did not return HTTP 200', {
            path: file.path,
            status: response.status,
          });
        }
        const headerState = {
          hasCacheHeader: response.headers['cache-control'] !== undefined,
          hasCorsHeader: response.headers['access-control-allow-origin'] !== undefined,
          hasImmutableCache: response.headers['cache-control']?.includes('immutable') ?? false,
          hasNoSniff: response.headers['x-content-type-options'] === 'nosniff',
          hasNoSniffHeader: response.headers['x-content-type-options'] !== undefined,
          hasPublicCors: response.headers['access-control-allow-origin'] === '*',
          path: file.path,
          status: response.status,
        };
        if (
          file.path === 'robots.txt' &&
          (!headerState.hasPublicCors || !headerState.hasImmutableCache || !headerState.hasNoSniff)
        ) {
          lastNotReady = new ImmutableAssetNotReady({
            cause: headerState,
            message: PUBLIC_ASSET_INVENTORY_MISMATCH,
          });
          yield* response.stream.pipe(Stream.runDrain);
          return false;
        }
        if (!headerState.hasPublicCors || !headerState.hasImmutableCache || !headerState.hasNoSniff) {
          return yield* fail(PUBLIC_ASSET_INVENTORY_MISMATCH, headerState);
        }
        const metadata = {
          contentEncoding: response.headers['content-encoding'] ?? null,
          contentType: response.headers['content-type'] ?? null,
          expectedBytes: bytes.byteLength,
          path: file.path,
          status: response.status,
        };
        const receivedSize = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => 0,
            (received, chunk) => {
              if (received + chunk.byteLength > bytes.byteLength) {
                return Effect.fail(
                  new ImmutableAssetNotReady({
                    cause: { ...metadata, observedBytes: received + chunk.byteLength },
                    message: 'the deployed asset body exceeds its compiled artifact byte length',
                  }),
                );
              }
              return Effect.sync(() => {
                bytes.set(chunk, received);
                return received + chunk.byteLength;
              });
            },
          ),
        );
        if (receivedSize !== file.bytes.byteLength || hash(bytes) !== hash(file.bytes)) {
          return yield* new ImmutableAssetNotReady({
            cause: { ...metadata, observedBytes: receivedSize },
            message: PUBLIC_ASSET_INVENTORY_MISMATCH,
          });
        }
        return true;
      }),
    ).pipe(
      Effect.catchTag('HttpClientError', (failure) =>
        Match.value(failure.reason).pipe(
          Match.tag('TransportError', 'DecodeError', ({ _tag }) =>
            Effect.fail(new ImmutableAssetTransientRead({ path: file.path, transport: _tag })),
          ),
          Match.orElse(() => Effect.fail(failure)),
        ),
      ),
      Effect.retry({
        schedule: Schedule.exponential('1 second'),
        times: ASSET_READ_ATTEMPTS - 1,
        while: Predicate.isTagged('ImmutableAssetTransientRead'),
      }),
      Effect.catchTag('ImmutableAssetTransientRead', ({ path: assetPath, transport }) =>
        Effect.fail(
          fail('the immutable public asset could not be read on any bounded transport attempt', {
            path: assetPath,
            transport,
          }),
        ),
      ),
      Effect.catchTag('ImmutableAssetNotReady', (cause) => {
        lastNotReady = cause;
        return Effect.succeed(false);
      }),
    );
    return yield* Effect.gen(function* awaitRetainedPublicAssetBytes() {
      while (!(yield* attempt)) {
        if (mode === 'retained-release') {
          return yield* fail('the retained immutable public asset does not match this build');
        }
        yield* Effect.sleep(Duration.seconds(1));
      }
      return yield* Effect.void;
    }).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.catchTag('TimeoutError', (cause) =>
        Effect.fail(lastNotReady === null ? cause : fail(lastNotReady.message, lastNotReady.cause)),
      ),
    );
  },
  Effect.mapError((cause) => fail('immutable release asset readback failed or exceeded its timeout', cause)),
);

const NativeAccountSubdomain = Schema.Struct({
  result: Schema.Struct({ subdomain: Schema.String.check(Schema.isPattern(/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u)) }),
  success: Schema.Boolean,
});

export const verifyImmutableAssetsAccountOrigin = Effect.fn('ImmutableApplicationRelease.accountOrigin')(
  function* verifyImmutableAssetsAccountOriginEffect(
    accountId: string,
    token: Redacted.Redacted,
    plan: ImmutableApplicationReleasePlan,
  ) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.bearerToken(
        HttpClientRequest.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`),
        Redacted.value(token),
      ),
    );
    const account = yield* Schema.decodeUnknownEffect(NativeAccountSubdomain)(yield* response.json);
    if (
      response.status !== 200 ||
      !account.success ||
      plan.assetsOrigin !== `https://${plan.assetsScriptName}.${account.result.subdomain}.workers.dev/`
    ) {
      return yield* fail('the immutable assets origin does not belong to the locked Cloudflare account');
    }
    return account.result.subdomain;
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) =>
    Schema.is(ImmutableApplicationReleaseError)(cause)
      ? cause
      : fail('the immutable assets account origin could not be observed within its timeout'),
  ),
);

export const readRetainedImmutableWorkerVersion = Effect.fn('ImmutableApplicationRelease.providerVersion')(
  function* readRetainedImmutableWorkerVersionEffect(accountId: string, token: Redacted.Redacted, scriptName: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.bearerToken(
        HttpClientRequest.get(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
        ),
        Redacted.value(token),
      ),
    );
    const history = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        result: Schema.Struct({
          deployments: Schema.Array(
            Schema.Struct({
              versions: Schema.Array(Schema.Struct({ percentage: Schema.Number, version_id: workerVersionIdSchema })),
            }),
          ),
        }),
        success: Schema.Boolean,
      }),
    )(yield* response.json);
    const versions = history.result.deployments[0]?.versions;
    const version = versions?.[0];
    if (response.status !== 200 || !history.success || versions?.length !== 1 || version?.percentage !== 100) {
      return yield* fail('the immutable Worker release has no actual single-version active deployment receipt');
    }
    return version.version_id;
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) =>
    Schema.is(ImmutableApplicationReleaseError)(cause)
      ? cause
      : fail('the retained immutable Worker deployment history could not be observed within its timeout'),
  ),
);

const WorkersDevRouteSchema = Schema.Struct({
  result: Schema.Struct({ enabled: Schema.Boolean, previews_enabled: Schema.Boolean }),
  success: Schema.Boolean,
});

/** A workers.dev route request the provider answered nothing about: rate limited, a gateway or server error, or no answer. */
const WorkersDevRouteUnanswered = Data.TaggedError('WorkersDevRouteUnanswered')<{
  readonly status: number | 'timeout';
}>;

/**
 * Enables one uploaded immutable Worker's exact workers.dev route with previews disabled and reads it back enabled.
 * The POST is idempotent, so an unanswered request (see {@link WorkersDevRouteUnanswered}) repeats it, at most
 * {@link IMMUTABLE_PROVIDER_WRITE_ATTEMPTS} times; any other answer that is not exactly that route ends at once.
 */
export const enableImmutableWorkersDevRoute = Effect.fn('ImmutableApplicationRelease.enableWorkersDevRoute')(
  function* enableImmutableWorkersDevRouteEffect(accountId: string, token: Redacted.Redacted, scriptName: string) {
    const client = yield* HttpClient.HttpClient;
    const schedule = yield* Effect.service(ImmutableProviderWriteRetrySchedule);
    const url = `${providerScriptUrl(accountId, scriptName)}/subdomain`;
    const answered = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(HttpClientRequest.bearerToken(request, Redacted.value(token))).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => new WorkersDevRouteUnanswered({ status: 'timeout' })),
        Effect.flatMap((response) =>
          isTransientProviderStatus(response.status)
            ? Effect.ignore(response.arrayBuffer).pipe(
                Effect.andThen(Effect.fail(new WorkersDevRouteUnanswered({ status: response.status }))),
              )
            : Effect.succeed(response),
        ),
      );
    const exactRoute = (request: HttpClientRequest.HttpClientRequest, refusal: string) =>
      Effect.gen(function* readExactWorkersDevRoute() {
        const response = yield* answered(request);
        const route = yield* Schema.decodeUnknownEffect(WorkersDevRouteSchema)(yield* response.json).pipe(
          Effect.mapError(() => fail(refusal)),
        );
        if (response.status !== 200 || !route.success || !route.result.enabled || route.result.previews_enabled) {
          return yield* fail(refusal);
        }
        return yield* Effect.void;
      });
    const attempt = Effect.gen(function* enableWorkersDevRouteOnce() {
      const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(url), {
        enabled: true,
        previews_enabled: false,
      }).pipe(Effect.mapError((cause) => fail('the workers.dev route request could not be encoded', cause)));
      yield* exactRoute(
        HttpClientRequest.setHeader(request, 'Cloudflare-Workers-Script-Api-Date', '2025-08-01'),
        `the workers.dev route of ${scriptName} was not enabled with previews disabled`,
      );
      yield* exactRoute(
        HttpClientRequest.get(url),
        `the workers.dev route of ${scriptName} does not read back enabled with previews disabled`,
      );
    });
    return yield* attempt.pipe(
      Effect.retry({
        schedule,
        times: IMMUTABLE_PROVIDER_WRITE_ATTEMPTS - 1,
        while: Predicate.isTagged('WorkersDevRouteUnanswered'),
      }),
      Effect.catchTag('WorkersDevRouteUnanswered', ({ status }) =>
        Effect.fail(
          fail(
            `the workers.dev route of ${scriptName} stayed unanswered after ${String(IMMUTABLE_PROVIDER_WRITE_ATTEMPTS)} attempts (last answer ${String(status)})`,
          ),
        ),
      ),
    );
  },
);

const WorkersDevRouteFailure = Schema.Struct({ providerPath: Schema.String });

/**
 * Wrangler uploads a Worker before it requests its workers.dev route. A command that failed transiently on exactly
 * that route request of exactly this Worker therefore failed after the upload, at the route alone.
 */
const failedOnlyAtWorkersDevRoute = (failure: OpsCommandError, accountId: string, scriptName: string) =>
  failure.transient === true &&
  Schema.is(WorkersDevRouteFailure)(failure.cause) &&
  failure.cause.providerPath === `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`;

const NoTriggerBeyondWorkersDev = Schema.Struct({
  queues: Schema.optionalKey(Schema.Struct({ consumers: Schema.optionalKey(Schema.Tuple([])) })),
  route: Schema.optionalKey(Schema.Never),
  routes: Schema.optionalKey(Schema.Tuple([])),
  triggers: Schema.optionalKey(Schema.Struct({ crons: Schema.optionalKey(Schema.Tuple([])) })),
  workflows: Schema.optionalKey(Schema.Tuple([])),
});

/**
 * Wrangler deploys a Worker's other triggers (routes, crons, queue consumers, workflows) only after its workers.dev
 * route, so a release with any of them is not complete once that route alone is enabled.
 */
export const workersDevIsTheOnlyTrigger = Schema.is(NoTriggerBeyondWorkersDev);

/** An uploaded Worker that cannot complete its route is not a release: its half release goes. */
const incompleteUpload = (scriptName: string) => (cause: unknown) =>
  new ImmutableApplicationReleaseError({
    cause,
    message: `the uploaded immutable Worker ${scriptName} could not complete its workers.dev route; its half release is removed`,
    removeHalfRelease: true,
  });

const WorkerVisibilityResponse = Schema.Struct({
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ code: Schema.Number }))),
  result: Schema.OptionFromOptionalNullOr(Schema.Struct({ name: Schema.String })),
  success: Schema.Boolean,
});
const NativeWorkerLookupFailure = Schema.Struct({ providerCode: Schema.Number, providerPath: Schema.String });

const completeImmutableAssetsRouting = Effect.fn('ImmutableApplicationRelease.completeAssetsRouting')(
  function* completeImmutableAssetsRoutingEffect(
    accountId: string,
    token: Redacted.Redacted,
    plan: ImmutableApplicationReleasePlan,
  ) {
    const client = yield* HttpClient.HttpClient;
    const providerPath = `/accounts/${accountId}/workers/workers/${plan.assetsScriptName}`;
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(HttpClientRequest.bearerToken(request, Redacted.value(token)));
    const workerReady = Effect.gen(function* observeUploadedAssetsWorker() {
      const response = yield* execute(HttpClientRequest.get(`https://api.cloudflare.com/client/v4${providerPath}`));
      const observed = yield* Schema.decodeUnknownEffect(WorkerVisibilityResponse)(yield* response.json);
      if (
        response.status === 200 &&
        observed.success &&
        Option.exists(observed.result, (worker) => worker.name === plan.assetsScriptName)
      ) {
        return true;
      }
      if (
        response.status === 404 &&
        !observed.success &&
        observed.errors?.length === 1 &&
        observed.errors[0]?.code === 10_007
      ) {
        return false;
      }
      return yield* fail('the uploaded immutable assets Worker could not be observed', {
        providerPath,
        status: response.status,
      });
    });
    while (!(yield* workerReady)) {
      yield* Effect.sleep(Duration.seconds(1));
    }
    yield* readRetainedImmutableWorkerVersion(accountId, token, plan.assetsScriptName);
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${plan.assetsScriptName}/subdomain`,
      ),
      { enabled: true, previews_enabled: false },
    );
    const response = yield* execute(
      HttpClientRequest.setHeader(request, 'Cloudflare-Workers-Script-Api-Date', '2025-08-01'),
    );
    const acknowledgement = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        result: Schema.Struct({ enabled: Schema.Boolean, previews_enabled: Schema.Boolean }),
        success: Schema.Boolean,
      }),
    )(yield* response.json);
    if (
      response.status !== 200 ||
      !acknowledgement.success ||
      !acknowledgement.result.enabled ||
      acknowledgement.result.previews_enabled
    ) {
      return yield* fail('the immutable assets Worker routing was not enabled with previews disabled');
    }
    return yield* Effect.void;
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) => fail('immutable assets routing completion failed or exceeded its timeout', cause)),
);

export const deployImmutableAssets = Effect.fn('ImmutableApplicationRelease.deployAssets')(
  function* deployImmutableAssetsEffect(input: {
    readonly accountId: string;
    readonly appDirectory: string;
    readonly configFile: string;
    readonly plan: ImmutableApplicationReleasePlan;
    readonly token: Redacted.Redacted;
  }) {
    const command = {
      args: ['exec', 'wrangler', 'deploy', '--config', input.configFile],
      captureProviderFailure: true,
      classifyTransientProviderFailure: true,
      command: 'pnpm',
      cwd: input.appDirectory,
      env: { CLOUDFLARE_ACCOUNT_ID: Redacted.make(input.accountId), CLOUDFLARE_API_TOKEN: input.token },
    };
    yield* runCommand(command).pipe(
      Effect.catchTag('OpsCommandError', (failure) =>
        Effect.gen(function* recoverUploadedAssetsRouting() {
          if (failure.command !== [command.command, ...command.args].join(' ')) {
            return yield* failure;
          }
          if (failedOnlyAtWorkersDevRoute(failure, input.accountId, input.plan.assetsScriptName)) {
            // Uploaded: one complete active version. Only its idempotent route request is repeated, never the upload.
            return yield* readRetainedImmutableWorkerVersion(
              input.accountId,
              input.token,
              input.plan.assetsScriptName,
            ).pipe(
              Effect.andThen(enableImmutableWorkersDevRoute(input.accountId, input.token, input.plan.assetsScriptName)),
              Effect.mapError(incompleteUpload(input.plan.assetsScriptName)),
            );
          }
          if (
            !Schema.is(NativeWorkerLookupFailure)(failure.cause) ||
            failure.cause.providerCode !== 10_007 ||
            failure.cause.providerPath !== `/accounts/${input.accountId}/workers/workers/${input.plan.assetsScriptName}`
          ) {
            return yield* failure;
          }
          return yield* completeImmutableAssetsRouting(input.accountId, input.token, input.plan);
        }),
      ),
      classifyTransientUpload,
    );
  },
);

/**
 * Uploads one content-addressed release and reads it back. Registers nothing and deletes only its own half
 * release after a transient provider failure (see {@link retryTransientImmutableUpload}).
 */
const uploadImmutableApplicationRelease = Effect.fn('ImmutableApplicationRelease.upload')(
  function* uploadImmutableReleaseEffect(
    input: {
      readonly appDirectory: string;
      readonly plan: ImmutableApplicationReleasePlan;
    } & PlannedUnitInputs,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const client = yield* HttpClient.HttpClient;
    const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
    const apiToken = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    const secretsText = yield* Config.Redacted('ONTOS_IMMUTABLE_RELEASE_SECRETS');
    const secrets = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(Redacted.value(secretsText)).pipe(Effect.mapError(() => fail('backend secret configuration is invalid')));
    if (!/^[a-f\d]{32}$/u.test(accountId)) {
      return yield* fail('release publication requires an exact Cloudflare account');
    }
    const plan = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleasePlanSchema, {
      onExcessProperty: 'error',
    })(input.plan).pipe(Effect.mapError((cause) => fail('release plan failed validation', cause)));
    const markPhase = yield* releasePhaseTimer(plan.backendScriptName);
    yield* validateReleasePlan(plan);
    yield* requirePlannedUnitInputs(
      input.appDirectory,
      plan,
      'the release plan does not identify the current clean Git source revision',
      input,
    );
    const output = path.resolve(input.appDirectory, '.output');
    const outputFiles = yield* readVerifiedReleaseFiles(output, plan);
    yield* verifyPinnedWrangler(input.appDirectory);
    const wrangler = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WranglerSchema))(
      yield* fileSystem.readFileString(path.join(output, 'wrangler.json')),
    );
    const delivery = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DeliveryUnitSchema))(
      yield* fileSystem.readFileString(path.join(output, 'server/modern-worker-manifest.json')),
    );
    const assetsDirectory = path.resolve(output, wrangler.assets.directory);
    if (!assetsDirectory.startsWith(`${output}${path.sep}`)) {
      return yield* fail('native public assets must remain inside the compiled release output');
    }
    yield* validateImmutableAssetRedirects(assetsDirectory);
    const compiledAssets = yield* readImmutablePublicReleaseFiles(assetsDirectory);
    const backendFiles = outputFiles.filter(
      (file) => !file.path.startsWith(`${path.relative(output, assetsDirectory).split(path.sep).join('/')}/`),
    );
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseContractSchema))(
      yield* fileSystem.readFileString(path.join(assetsDirectory, '.well-known/ontos-module-manifest.json')),
    );
    yield* validateImmutableApplicationReleaseArtifacts(plan, {
      assets: compiledAssets,
      backendEntrypoint: wrangler.main.replace(/^\.\//u, ''),
      backendFiles,
      contract,
      deliveryUnit: delivery.deliveryUnit,
    });
    yield* markPhase('verify compiled output');
    const accountSubdomain = yield* verifyImmutableAssetsAccountOrigin(accountId, apiToken, plan);
    const apiUrl = (suffix: string) => `https://api.cloudflare.com/client/v4/accounts/${accountId}${suffix}`;
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(HttpClientRequest.bearerToken(request, Redacted.value(apiToken))).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => fail('Cloudflare release request failed')),
      );
    const backendScript = `/workers/scripts/${plan.backendScriptName}`;
    // A status-only response still has its body read, so its connection returns to the pool instead of
    // holding the process open until the provider closes it (about a minute).
    const statusOnly = (request: HttpClientRequest.HttpClientRequest) =>
      execute(request).pipe(Effect.tap((response) => Effect.ignore(response.arrayBuffer)));
    const presence = (yield* Effect.forEach(
      [backendScript, `/workers/scripts/${plan.assetsScriptName}`],
      (suffix) => statusOnly(HttpClientRequest.get(apiUrl(suffix))),
      { concurrency: 'unbounded' },
    )).map((current) => immutableProviderScriptPresence(current.status));
    if (presence.includes('unknown')) {
      return yield* fail('provider release absence could not be established');
    }
    // A failed-job rerun may find the complete release uploaded by its earlier attempt. Never
    // overwrite either identity: reuse only after the same full package and asset readback below.
    // A half release (exactly one identity present) is never reused: its unreferenced survivor is removed first.
    const reuseExisting = presence.every((current) => current === 'present');
    const survivor = presence.includes('absent')
      ? [plan.backendScriptName, plan.assetsScriptName].find((_, index) => presence[index] === 'present')
      : undefined;
    if (survivor !== undefined) {
      yield* removeUnreferencedHalfRelease(accountId, apiToken, plan, survivor);
    }
    // The identity names the source revision, not the secrets, so a rotation at the same revision finds these
    // Workers too. Reuse only a backend version uploaded with exactly the secrets this release binds; the receipt
    // would otherwise claim the new secrets for a Worker that still holds the old ones.
    const secretFingerprint = yield* currentReleaseSecretFingerprint(plan.appId);
    if (reuseExisting) {
      if (secretFingerprint === SECRET_FINGERPRINT_UNAVAILABLE) {
        return yield* fail(
          'an existing immutable release can be reused only with RELEASE_FINGERPRINT_KEY and the raw release secrets, which prove it holds the secrets this release binds',
        );
      }
      yield* requireWorkerVersionSecretFingerprint(
        accountId,
        apiToken,
        plan.backendScriptName,
        yield* readRetainedImmutableWorkerVersion(accountId, apiToken, plan.backendScriptName),
        secretFingerprint,
      );
    }
    yield* markPhase('provider account and absence');
    const deployedAssetsDirectory = yield* materializeImmutablePublicAssets(compiledAssets);
    // Native assets-only Workers apply these bytes directly; the compiled assets stay unchanged.
    yield* fileSystem.writeFileString(
      path.join(deployedAssetsDirectory, '_headers'),
      '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex, nofollow\n',
    );
    const assets = yield* readReleaseFiles(deployedAssetsDirectory);
    const artifacts = yield* validateImmutableApplicationReleaseArtifacts(plan, {
      assets,
      backendEntrypoint: wrangler.main.replace(/^\.\//u, ''),
      backendFiles,
      contract,
      deliveryUnit: delivery.deliveryUnit,
    });
    const backendConfig = yield* fileSystem.makeTempFileScoped({
      directory: output,
      prefix: '.wrangler-immutable-backend-',
      suffix: '.json',
    });
    const assetsConfig = yield* fileSystem.makeTempFileScoped({
      directory: output,
      prefix: '.wrangler-immutable-assets-',
      suffix: '.json',
    });
    yield* fileSystem.writeFileString(
      backendConfig,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))({
        ...wrangler,
        assets: { ...wrangler.assets, directory: deployedAssetsDirectory },
        main: path.resolve(output, wrangler.main),
        name: plan.backendScriptName,
        preview_urls: false,
        routes: [],
        workers_dev: true,
      }),
    );
    yield* fileSystem.writeFileString(
      assetsConfig,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
        immutableAssetsWranglerConfig(plan, deployedAssetsDirectory, wrangler.compatibility_date),
      ),
    );
    /** `afterRouteFailure` completes an upload whose command failed only at the backend's workers.dev route. */
    const deploy = <R = never,>(
      configFile: string,
      extra: readonly string[],
      afterRouteFailure?: Effect.Effect<void, ImmutableApplicationReleaseError, R>,
    ) => {
      const command = runCommand({
        args: ['exec', 'wrangler', 'deploy', '--config', configFile, ...extra],
        captureProviderFailure: !reuseExisting,
        classifyTransientProviderFailure: !reuseExisting,
        command: 'pnpm',
        cwd: input.appDirectory,
        env: { CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId), CLOUDFLARE_API_TOKEN: apiToken },
      }).pipe(
        Effect.catchIf(
          (failure) =>
            afterRouteFailure !== undefined && failedOnlyAtWorkersDevRoute(failure, accountId, plan.backendScriptName),
          () => afterRouteFailure ?? Effect.void,
        ),
      );
      // Existing identities are not owned by this attempt. Even a transient packaging failure
      // must never enter the upload retry's half-release deletion path.
      return reuseExisting ? command : classifyTransientUpload(command);
    };
    const packageDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: 'ontos-immutable-package-',
    });
    yield* markPhase('materialize assets and configs');
    yield* deploy(backendConfig, ['--dry-run', '--outdir', packageDirectory]);
    yield* markPhase('native package dry run');
    const packagedModules = (yield* readReleaseFiles(packageDirectory)).filter(
      (file) => file.path !== 'README.md' && !file.path.endsWith('.map'),
    );
    const packagedMain =
      wrangler.no_bundle === true ? path.basename(wrangler.main) : `${path.parse(wrangler.main).name}.js`;
    if (!packagedModules.some((file) => file.path === packagedMain)) {
      return yield* fail('the native Worker packager did not capture the complete deployment entrypoint');
    }
    /** The provider's retained module content must be exactly the captured native upload package. */
    const verifyInstalledContent = (installedContent: HttpClientResponse.HttpClientResponse) =>
      Effect.gen(function* verifyInstalledWorkerContent() {
        if (installedContent.status !== 200) {
          return yield* fail('the provider did not retain the complete immutable Worker module content');
        }
        if (installedContent.headers['cf-entrypoint'] !== packagedMain) {
          return yield* fail('the provider retained a missing or different immutable Worker entrypoint');
        }
        return yield* verifyImmutableBackendModuleContent(
          packagedModules,
          yield* installedContent.formData.pipe(
            Effect.timeout(Duration.seconds(30)),
            Effect.mapError(() => fail('the retained Worker module content could not be read within its timeout')),
          ),
        ).pipe(
          Effect.mapError((cause) =>
            fail('the deployed Worker differs from the captured native upload package', cause),
          ),
        );
      });
    const capturedConfig = {
      ...wrangler,
      assets: { ...wrangler.assets, directory: deployedAssetsDirectory },
      base_dir: packageDirectory,
      find_additional_modules: true,
      main: path.join(packageDirectory, packagedMain),
      name: plan.backendScriptName,
      no_bundle: true,
      preview_urls: false,
      routes: [],
      rules: [{ fallthrough: true, globs: ['**/*.js', '**/*.mjs'], type: 'ESModule' }, ...(wrangler.rules ?? [])],
      upload_source_maps: false,
      workers_dev: true,
    };
    delete capturedConfig.alias;
    delete capturedConfig.build;
    delete capturedConfig.define;
    delete capturedConfig.minify;
    delete capturedConfig.tsconfig;
    yield* fileSystem.writeFileString(
      backendConfig,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(capturedConfig),
    );
    yield* requirePlannedUnitInputs(
      input.appDirectory,
      plan,
      'the source revision changed while preparing the immutable upload package',
      input,
    );
    yield* readVerifiedReleaseFiles(output, plan, [
      assetsConfig,
      backendConfig,
      deployedAssetsDirectory,
      packageDirectory,
    ]);
    // The secrets travel with the one backend upload, so the release has a single version that already
    // holds them. The file lives outside the checkout and is removed when the upload scope closes.
    const secretsArguments: string[] = [];
    if (!reuseExisting && Object.keys(secrets).length > 0) {
      const secretsFile = yield* fileSystem.makeTempFileScoped({ prefix: 'ontos-release-secrets-', suffix: '.json' });
      yield* fileSystem.chmod(secretsFile, 0o600);
      yield* fileSystem.writeFileString(
        secretsFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(secrets),
      );
      secretsArguments.push('--secrets-file', secretsFile);
    }
    yield* markPhase('verify upload package');
    // Wrangler uploaded the backend and then failed transiently on its workers.dev route request. When that route is
    // the backend's only trigger, the upload is proven to be exactly this release and only the idempotent route
    // request repeats; re-uploading would only add another release under provider strain.
    const completeBackendRoute = Effect.gen(function* completeUploadedBackendRoute() {
      const uploadedVersion = yield* readRetainedImmutableWorkerVersion(accountId, apiToken, plan.backendScriptName);
      yield* requireWorkerVersionSecretFingerprint(
        accountId,
        apiToken,
        plan.backendScriptName,
        uploadedVersion,
        secretFingerprint,
      );
      yield* execute(HttpClientRequest.get(apiUrl(`${backendScript}/content/v2`))).pipe(
        Effect.flatMap(verifyInstalledContent),
      );
      yield* enableImmutableWorkersDevRoute(accountId, apiToken, plan.backendScriptName);
    }).pipe(Effect.mapError(incompleteUpload(plan.backendScriptName)));
    if (!reuseExisting) {
      yield* deploy(
        backendConfig,
        ['--no-bundle', '--message', releaseSecretFingerprintAnnotation(secretFingerprint), ...secretsArguments],
        workersDevIsTheOnlyTrigger(capturedConfig) ? completeBackendRoute : undefined,
      );
      yield* markPhase('backend upload with secrets');
      yield* deployImmutableAssets({
        accountId,
        appDirectory: input.appDirectory,
        configFile: assetsConfig,
        plan,
        token: apiToken,
      });
      yield* markPhase('assets upload');
    }
    // The read-backs are independent, so they run side by side; any failure still fails the release.
    const [installed, subdomain, installedContent] = yield* Effect.all(
      [
        statusOnly(HttpClientRequest.get(apiUrl(backendScript))),
        execute(HttpClientRequest.get(apiUrl(`${backendScript}/subdomain`))),
        execute(HttpClientRequest.get(apiUrl(`${backendScript}/content/v2`))),
      ],
      { concurrency: 'unbounded' },
    );
    if (installed.status !== 200) {
      return yield* fail('complete immutable Worker release was not retained');
    }
    const subdomainState = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ result: Schema.Struct({ enabled: Schema.Boolean }), success: Schema.Boolean }),
    )(yield* subdomain.json).pipe(Effect.mapError(() => fail('native Worker subdomain readback is invalid')));
    if (subdomain.status !== 200 || !subdomainState.success || !subdomainState.result.enabled) {
      return yield* fail('the immutable backend has no enabled native workers.dev route');
    }
    const workerSha256 = yield* verifyInstalledContent(installedContent);
    const [, versionId, assetsVersionId] = yield* Effect.all(
      [
        Effect.forEach(
          assets.filter((file) => !['_headers', '_redirects', '.assetsignore'].includes(file.path)),
          (file) => verifyRetainedPublicAsset(plan, file, reuseExisting ? 'retained-release' : 'new-upload'),
          { concurrency: 16 },
        ),
        readRetainedImmutableWorkerVersion(accountId, apiToken, plan.backendScriptName),
        readRetainedImmutableWorkerVersion(accountId, apiToken, plan.assetsScriptName),
      ],
      { concurrency: 'unbounded' },
    );
    yield* requireWorkerVersionSecretFingerprint(
      accountId,
      apiToken,
      plan.backendScriptName,
      versionId,
      secretFingerprint,
    );
    yield* markPhase('provider read-back');
    const backend = yield* Schema.decodeUnknownEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
      baseUrl: `https://${plan.backendScriptName}.${accountSubdomain}.workers.dev/`,
      transport: 'cloudflare-worker',
      versionId,
      workerName: plan.backendScriptName,
    }).pipe(Effect.mapError((cause) => fail('the observed immutable Worker placement is invalid', cause)));
    return {
      artifacts: { ...artifacts, workerSha256 },
      assetsVersionId,
      backend,
      plan,
      secretFingerprint,
    } satisfies ImmutableApplicationReleaseReceipt;
  },
  Effect.scoped,
);

/**
 * Distinct releases upload in parallel: an upload only produces a receipt, and the composition publication
 * (the one database registration) keeps the environment-wide publication lock. The same release identity
 * stays serialized so its absence check, upload and readback cannot interleave with a second upload.
 */
export const deployImmutableApplicationRelease = (
  input: {
    readonly appDirectory: string;
    readonly plan: ImmutableApplicationReleasePlan;
  } & PlannedUnitInputs,
) =>
  withImmutableApplicationReleaseIdentityLock(input.plan.backendScriptName)(
    uploadImmutableApplicationRelease(input).pipe(
      retryTransientImmutableUpload([input.plan.backendScriptName, input.plan.assetsScriptName]),
    ),
  );

const PlanDocumentSchema = Schema.Struct({
  ...ImmutableApplicationReleasePlanSchema.fields,
  buildEnvironment: Schema.Record(Schema.String, Schema.String),
});

/**
 * A ledger receipt is reusable only while both exact deployments remain active in this account and the backend
 * version is the one uploaded with the secrets the receipt fingerprints.
 */
export const verifyRetainedImmutableApplicationRelease = Effect.fn('ImmutableApplicationRelease.verifyRetained')(
  function* verifyRetainedApplicationRelease(raw: ImmutableApplicationReleaseReceipt) {
    const receipt = yield* Schema.decodeUnknownEffect(ImmutableApplicationReleaseReceiptSchema, {
      onExcessProperty: 'error',
    })(raw).pipe(Effect.mapError((cause) => fail('retained release receipt failed validation', cause)));
    const { backend, plan } = receipt;
    yield* validateReleasePlan(plan);
    if (
      plan.appId === SHELL_APP_ID ||
      backend.workerName !== plan.backendScriptName ||
      backend.baseUrl !== plan.assetsOrigin.replace(`${plan.assetsScriptName}.`, `${plan.backendScriptName}.`) ||
      receipt.artifacts.contract.url !== `${plan.assetsOrigin}.well-known/ontos-module-manifest.json` ||
      (receipt.artifacts.federationManifest !== undefined &&
        receipt.artifacts.federationManifest.url !== `${plan.assetsOrigin}mf-manifest.json`)
    ) {
      return yield* fail('the retained receipt must identify the exact immutable application release');
    }
    const accountId = yield* Config.String('CLOUDFLARE_ACCOUNT_ID');
    const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    if (!/^[a-f\d]{32}$/u.test(accountId)) {
      return yield* fail('retained release verification requires an exact Cloudflare account');
    }
    yield* verifyImmutableAssetsAccountOrigin(accountId, token, plan);
    const [backendVersion, assetsVersion] = yield* Effect.all(
      [
        readRetainedImmutableWorkerVersion(accountId, token, plan.backendScriptName),
        readRetainedImmutableWorkerVersion(accountId, token, plan.assetsScriptName),
      ],
      { concurrency: 2 },
    );
    if (backendVersion !== backend.versionId || assetsVersion !== receipt.assetsVersionId) {
      return yield* fail('the retained provider deployments no longer match their receipt');
    }
    if (receipt.secretFingerprint === SECRET_FINGERPRINT_UNAVAILABLE) {
      return yield* fail('a retained receipt must record the fingerprint of the release secrets its Worker holds');
    }
    yield* requireWorkerVersionSecretFingerprint(
      accountId,
      token,
      plan.backendScriptName,
      backendVersion,
      receipt.secretFingerprint,
    );
    return yield* Effect.void;
  },
);

const verifyRetainedCommand = Command.make(
  'verify-retained',
  { receiptFile: Flag.String(RECEIPT_FILE_FLAG) },
  ({ receiptFile }) =>
    Effect.gen(function* verifyRetainedCommandEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ImmutableApplicationReleaseReceiptSchema),
      )(yield* fileSystem.readFileString(receiptFile));
      yield* verifyRetainedImmutableApplicationRelease(receipt);
    }),
);

const deployCommand = Command.make(
  'deploy',
  {
    appDirectory: Flag.String('app-directory'),
    artifactName: Flag.String('artifact-name').pipe(Flag.optional),
    inputsFile: Flag.String('inputs-file').pipe(Flag.optional),
    planFile: Flag.String('plan-file'),
    receiptFile: Flag.String(RECEIPT_FILE_FLAG),
  },
  ({ appDirectory, artifactName, inputsFile, planFile, receiptFile }) =>
    Effect.gen(function* deployCommandEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const plan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ImmutableApplicationReleasePlanSchema))(
        yield* fileSystem.readFileString(planFile),
      );
      // The receipt is written only after the upload was read back; a failed upload leaves no receipt.
      const receipt = yield* deployImmutableApplicationRelease({
        appDirectory,
        artifactName: Option.getOrUndefined(artifactName),
        inputsFile: Option.getOrUndefined(inputsFile),
        plan,
      });
      yield* fileSystem.writeFileString(
        receiptFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ImmutableApplicationReleaseReceiptSchema))(receipt),
      );
      yield* Effect.logInfo(`release ${plan.backendScriptName} receipt written`);
    }),
).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

const candidateCommand = Command.make(
  'candidate',
  {
    candidateFile: Flag.String('candidate-file'),
    intentFile: Flag.String('intent-file'),
    receiptFiles: Flag.String(RECEIPT_FILE_FLAG).pipe(Flag.atLeast(0)),
    retainedShellSnapshotFile: Flag.String('retained-shell-snapshot-file').pipe(Flag.optional),
    shellReceiptFile: Flag.String('shell-receipt-file').pipe(Flag.optional),
  },
  ({ candidateFile, intentFile, receiptFiles, retainedShellSnapshotFile, shellReceiptFile }) =>
    Effect.gen(function* candidateCommandEffect() {
      if (Option.isSome(shellReceiptFile) === Option.isSome(retainedShellSnapshotFile)) {
        yield* fail('select exactly one genuine Shell receipt or captured approved snapshot file');
      }
      const fileSystem = yield* FileSystem.FileSystem;
      const receipts = yield* Effect.forEach(
        receiptFiles,
        (file) =>
          fileSystem
            .readFileString(file)
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(ImmutableApplicationReleaseReceiptSchema)),
              ),
            ),
        { concurrency: 4 },
      );
      const intent = yield* readReviewedApplicationReleaseIntent(intentFile);
      const shellReceipt = yield* Option.match(shellReceiptFile, {
        onNone: () => Effect.succeed(Option.none<ImmutableShellArtifactReceipt>()),
        onSome: (file) =>
          fileSystem
            .readFileString(file)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ImmutableShellArtifactReceiptSchema))),
              Effect.map(Option.some),
            ),
      });
      const retainedSnapshot = yield* Option.match(retainedShellSnapshotFile, {
        onNone: () => Effect.succeed(Option.none<ActiveApplicationCompositionSnapshot>()),
        onSome: (file) =>
          fileSystem
            .readFileString(file)
            .pipe(Effect.flatMap(decodeActiveApplicationCompositionSnapshot), Effect.map(Option.some)),
      });
      const candidate = yield* makeImmutableApplicationReleasePublicationCandidate(
        receipts,
        intent,
        Option.getOrUndefined(shellReceipt),
        Option.getOrUndefined(retainedSnapshot),
      );
      yield* fileSystem.writeFileString(
        candidateFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(ApplicationCompositionPublicationCandidateSchema))(candidate),
      );
    }),
);

const planCommand = Command.make(
  'plan',
  {
    planFile: Flag.String('plan-file'),
    vertical: Flag.String('vertical'),
    workersDevSubdomain: Flag.String('workers-dev-subdomain'),
  },
  ({ planFile, vertical, workersDevSubdomain }) =>
    Effect.gen(function* planCommandEffect() {
      const workspaceRoot = path.resolve(import.meta.dirname, '..');
      const cleanRevision = yield* resolveCleanImmutableApplicationSourceRevision(workspaceRoot);
      const contract = yield* deriveOntosModuleDeploymentContract({ vertical, workspaceRoot });
      const revision = yield* Effect.try({
        catch: (cause) => fail('source revision cannot be resolved', cause),
        try: () => resolveUltramodernSourceRevision(workspaceRoot),
      });
      if (revision !== cleanRevision) {
        yield* fail('the configured source revision does not identify the current clean Git checkout');
      }
      const plan = yield* deriveImmutableApplicationReleasePlan({
        ...contract.deployment,
        sourceRevision: revision,
        workersDevSubdomain,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        planFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(PlanDocumentSchema))({
          ...plan,
          buildEnvironment: {
            [`ULTRAMODERN_PUBLIC_URL_${plan.appId.replaceAll('-', '_').toUpperCase()}`]: plan.assetsOrigin,
            MODERN_ASSET_PREFIX: plan.assetsOrigin,
            ULTRAMODERN_SOURCE_REVISION: cleanRevision,
          },
        }),
      );
    }),
);

const command = Command.make('immutable-application-release').pipe(
  Command.withSubcommands([
    applicationReleaseSelectCommand,
    planCommand,
    deployCommand,
    verifyRetainedCommand,
    candidateCommand,
  ]),
);
const executableLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(
    Layer.mergeAll(
      OpsShellLive,
      FetchHttpClient.layer,
      Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'error' }),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);
/**
 * The CLI exits as soon as its command and every scope (lock session, database pool) have closed. A
 * successful run would otherwise wait for the event loop to drain: on CI that took 58 s after the last
 * read-back of every upload, longer than the upload itself.
 */
const exitWhenCommandCompletes: Runtime.Teardown = (exit, onExit) => {
  Runtime.defaultTeardown(exit, (code) => {
    onExit(code);
    // Scope finalizers have completed before this executable teardown is called.
    process.exit(code);
  });
};

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(executableLayer).pipe(Effect.scoped), { teardown: exitWhenCommandCompletes });
}
