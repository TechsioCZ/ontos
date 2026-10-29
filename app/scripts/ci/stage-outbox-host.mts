/// <reference lib="esnext" />
// The outbox host's Zerops deploy, split at the provider API boundary exactly where `zcli service deploy` splits it
// internally: create an application version, stream the package to its signed upload URL, then deploy that version
// with the zerops.yaml. zcli has no upload-only mode, so the release drives the same three calls itself and the
// package upload overlaps the database preparation and the Cloudflare uploads, while the host still starts only
// after publication:
//
//   stage-outbox-host.mts upload --directory <d> --artifact <outbox-host.tar.zst> --digest <host digest>
//   stage-outbox-host.mts check-owners --directory <d> --receipts <release receipts directory>
//   stage-outbox-host.mts deploy --directory <d> --digest <host digest> --zerops-yaml <materialized zerops.yaml>
//   stage-outbox-host.mts discard --directory <d> --deploy-directory <the deploy step's background directory>
//
// An uploaded version starts no container: the old host keeps draining the old composition until the deploy. The
// deploy sends the zerops.yaml, so native secret references resolve at that deploy, after the configuration apply.
// The version could still record the service's own user data (its secrets) when it was created, so the receipt
// keeps a keyed fingerprint of them; when the apply changed any, the deploy replaces the staged version with a fresh
// one. `<d>` is private to this run attempt: the receipt binds the service, the host digest, the package and the
// attempt. Neither the signed upload URL nor any secret value is written or printed.
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { OpsShellLive, runCommand } from '../ops/ops-shell.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from '../zerops-public-api.mts';
import type { ZeropsServiceUserData } from '../zerops-public-api.mts';

export class StageOutboxHostError extends Schema.TaggedError<StageOutboxHostError>()('StageOutboxHostError', {
  message: Schema.String,
}) {}

const failure = (message: string) => new StageOutboxHostError({ message });

export const HOST_SETUP = 'outbox-worker-host';
const RUNTIME = `app/.zerops/runtime/${HOST_SETUP}`;
const SHA256 = /^[\da-f]{64}$/u;
/** Versions in these states were never deployed, so discarding them retires nothing that ever ran. */
const UNDEPLOYED_STATUSES: ReadonlySet<string> = new Set(['UPLOADING', 'WAITING_TO_DEPLOY']);
const DISCARD_WAIT = Duration.minutes(10);
const NOTHING_STAGED = 'no outbox host version was staged';
const POLL_INTERVAL = Duration.seconds(2);

/** The staging directory's files; `stream.log` and `exit-code` belong to the workflow's background wrapper. */
export const stagingFiles = (directory: string) => ({
  creating: path.join(directory, 'creating'),
  exitCode: path.join(directory, 'exit-code'),
  package: path.join(directory, 'outbox-host.tar.gz'),
  receipt: path.join(directory, 'receipt.json'),
  stop: path.join(directory, 'stop'),
  unpacked: path.join(directory, 'unpacked'),
});

const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const ServiceIdSchema = Schema.String.pipe(Schema.brand('ZeropsServiceStackId'));
const AppVersionIdSchema = Schema.String.pipe(Schema.brand('ZeropsAppVersionId'));
const OwnerIdentitySchema = Schema.Struct({
  appId: AppIdSchema,
  buildMarker: Schema.String,
  sourceRevision: Schema.String,
});
export type OwnerIdentity = typeof OwnerIdentitySchema.Type;

/** The worker-artifact.json fields the deploy relies on. */
const WorkerArtifactJson = Schema.fromJsonString(
  Schema.Struct({
    artifactDigest: Schema.OptionFromNullOr(Schema.String),
    ownerBuildIdentities: Schema.Array(OwnerIdentitySchema),
    schemaVersion: Schema.Number,
    serviceId: ServiceIdSchema,
  }),
);

const StagedHostSchema = Schema.Struct({
  appVersionId: AppVersionIdSchema,
  artifactDigest: Schema.String,
  /** `<run id>-<run attempt>`: a receipt never crosses into another attempt. */
  attempt: Schema.String,
  deployStarted: Schema.Boolean,
  owners: Schema.Array(OwnerIdentitySchema),
  packageSha256: Schema.String,
  serviceId: ServiceIdSchema,
  uploaded: Schema.Boolean,
  /** Keyed fingerprint of the service's user data when the version was created. */
  userDataFingerprint: Schema.String,
  version: Schema.Literal(1),
});
export type StagedHost = typeof StagedHostSchema.Type;
const StagedHostJson = Schema.fromJsonString(StagedHostSchema);

const ReceiptPlanJson = Schema.fromJsonString(
  Schema.Struct({ plan: Schema.Struct({ appId: AppIdSchema, buildMarker: Schema.String }) }),
);

/** One length-prefixed field, so no value can imitate a field boundary. */
const field = (value: string) => `${String(value.length)}:${value}`;

/** HMAC over every user data entry (id, key, value), so a created, removed or rotated secret changes it. */
export const userDataFingerprint = (key: Redacted.Redacted, entries: readonly ZeropsServiceUserData[]) =>
  createHmac('sha256', Redacted.value(key))
    .update(
      entries
        .map(({ content, id, key: name }) => `${field(id)}${field(name)}${field(Redacted.value(content))}`)
        .toSorted()
        .join('\n'),
    )
    .digest('hex');

/** Every reason the prebuilt host's identity file is not the planned artifact; empty means it is. */
export const artifactShortfalls = (text: string, digest: string): readonly string[] =>
  Option.match(Schema.decodeUnknownOption(WorkerArtifactJson)(text), {
    onNone: () => ['worker-artifact.json is not an outbox worker artifact'],
    onSome: (artifact) => [
      ...(artifact.schemaVersion === 3 ? [] : [`schema version ${String(artifact.schemaVersion)}`]),
      ...(artifact.serviceId === HOST_SETUP ? [] : [`service ${artifact.serviceId}`]),
      ...(Option.contains(artifact.artifactDigest, digest)
        ? []
        : [`host digest ${Option.getOrElse(artifact.artifactDigest, () => 'none')}`]),
      ...(artifact.ownerBuildIdentities.length > 0 ? [] : ['no owner build identities']),
    ],
  });

/** Owners whose staged build marker differs from the receipt this release publishes for them. */
export const ownerMismatches = (
  owners: readonly OwnerIdentity[],
  published: ReadonlyMap<string, string>,
): readonly string[] =>
  owners.filter(({ appId, buildMarker }) => published.get(appId) !== buildMarker).map(({ appId }) => appId);

const runIdentity = Effect.all([
  Config.String('GITHUB_RUN_ID'),
  Config.String('GITHUB_RUN_ATTEMPT').pipe(Config.withDefault('1')),
]).pipe(Effect.map(([runId, attempt]) => `${runId}-${attempt}`));

const hostServiceId = Config.schema(ServiceIdSchema, 'ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID');
const fingerprintKey = Config.Redacted('RELEASE_FINGERPRINT_KEY');

const requireDigest = (digest: string) =>
  SHA256.test(digest) ? Effect.void : Effect.fail(failure('--digest must be the plan host digest'));

const writeReceipt = (file: string, receipt: StagedHost) =>
  Effect.gen(function* writeStagedReceipt() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* Schema.encodeEffect(StagedHostJson)(receipt);
    yield* fs.writeFileString(`${file}.tmp`, `${text}\n`, { mode: 0o600 });
    yield* fs.rename(`${file}.tmp`, file);
  });

const readReceipt = (file: string) =>
  Effect.gen(function* readStagedReceipt() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file);
    return yield* Schema.decodeUnknownEffect(StagedHostJson)(text);
  }).pipe(Effect.mapError(() => failure('the staged outbox host receipt is missing or invalid')));

const phase = (name: string) =>
  DateTime.now.pipe(Effect.flatMap((now) => Console.log(`outbox host phase ${name} ${DateTime.formatIso(now)}`)));

/**
 * Creates an inactive version and uploads the package to it. The service's user data must read the same before and
 * after the creation, so the fingerprint the receipt keeps is exactly the state the version could have recorded. The
 * receipt is written as soon as the version exists, so a failed upload still leaves it discardable.
 */
const stageVersion = (
  directory: string,
  base: Omit<StagedHost, 'appVersionId' | 'deployStarted' | 'uploaded' | 'userDataFingerprint'>,
  archive: Uint8Array,
) =>
  Effect.gen(function* stageApplicationVersion() {
    const api = yield* ZeropsPublicApi;
    const key = yield* fingerprintKey;
    const files = stagingFiles(directory);
    const before = userDataFingerprint(key, yield* api.serviceUserData(base.serviceId));
    const created = yield* api.createAppVersion(base.serviceId, yield* Config.String('GITHUB_SHA'));
    const receipt: StagedHost = {
      ...base,
      appVersionId: yield* Schema.decodeUnknownEffect(AppVersionIdSchema)(created.id),
      deployStarted: false,
      uploaded: false,
      userDataFingerprint: before,
    };
    yield* writeReceipt(files.receipt, receipt);
    if (userDataFingerprint(key, yield* api.serviceUserData(base.serviceId)) !== before) {
      return yield* failure('the outbox host service configuration changed while its version was created');
    }
    yield* phase('upload-start');
    yield* api.uploadAppVersionPackage(created.uploadUrl, archive);
    yield* phase('upload-done');
    const uploaded = { ...receipt, uploaded: true };
    yield* writeReceipt(files.receipt, uploaded);
    return uploaded;
  });

const readPackage = (directory: string, expected: string) =>
  Effect.gen(function* readStagedPackage() {
    const fs = yield* FileSystem.FileSystem;
    const archive = yield* fs.readFile(stagingFiles(directory).package);
    if (createHash('sha256').update(archive).digest('hex') !== expected) {
      return yield* failure('the staged outbox host package changed after it was staged');
    }
    return archive;
  });

/**
 * Verifies the prebuilt host artifact, repacks it as `zcli service deploy --path-to-file-or-dir` packs the runtime
 * directory (a gzip tar of `app/.zerops/runtime/outbox-worker-host/` with its parent directories) and uploads it to a
 * new inactive version.
 */
export const uploadStagedHost = ({
  artifact,
  digest,
  directory,
}: {
  readonly artifact: string;
  readonly digest: string;
  readonly directory: string;
}) =>
  Effect.gen(function* uploadOutboxHost() {
    yield* requireDigest(digest);
    const fs = yield* FileSystem.FileSystem;
    const files = stagingFiles(directory);
    yield* fs.makeDirectory(files.unpacked, { recursive: true });
    yield* runCommand({
      args: ['--zstd', '-x', '-f', artifact, '-C', files.unpacked],
      command: 'tar',
    }).pipe(Effect.mapError(() => failure('the outbox host artifact is not a zstd tar archive')));
    const runtime = path.join(files.unpacked, RUNTIME);
    const executable = yield* runCommand({ args: ['-x', path.join(runtime, 'node/bin/node')], command: 'test' }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!(yield* fs.exists(path.join(runtime, 'worker.mjs'))) || !executable) {
      return yield* failure(`the outbox host artifact lacks ${RUNTIME}/worker.mjs or its shipped node/bin/node`);
    }
    const identity = yield* fs
      .readFileString(path.join(runtime, 'worker-artifact.json'))
      .pipe(Effect.orElseSucceed(() => ''));
    const shortfalls = artifactShortfalls(identity, digest);
    if (shortfalls.length > 0) {
      return yield* failure(`the outbox host artifact is not the planned one: ${shortfalls.join('; ')}`);
    }
    const { ownerBuildIdentities } = yield* Schema.decodeUnknownEffect(WorkerArtifactJson)(identity);
    yield* runCommand({
      args: ['-c', '-z', '-f', files.package, '-C', files.unpacked, 'app'],
      command: 'tar',
    }).pipe(Effect.mapError(() => failure('the outbox host package could not be packed')));
    const archive = yield* fs.readFile(files.package);
    // The release is stopping: create nothing it would have to discard. `creating` first, so a discard that finds
    // no marker knows this check still lies ahead.
    yield* fs.writeFileString(files.creating, '');
    if (yield* fs.exists(files.stop)) {
      return yield* failure('the release stopped before the outbox host was staged');
    }
    yield* phase('stage-start');
    const staged = yield* stageVersion(
      directory,
      {
        artifactDigest: digest,
        attempt: yield* runIdentity,
        owners: ownerBuildIdentities,
        packageSha256: createHash('sha256').update(archive).digest('hex'),
        serviceId: yield* hostServiceId,
        version: 1,
      },
      archive,
    );
    return yield* Console.log(
      `staged outbox host ${digest.slice(0, 12)} as inactive application version ${staged.appVersionId}`,
    );
  });

/** Before publication: the staged host must run exactly the owner builds this release publishes. */
export const checkStagedOwners = ({ directory, receipts }: { readonly directory: string; readonly receipts: string }) =>
  Effect.gen(function* checkOwners() {
    const fs = yield* FileSystem.FileSystem;
    const { owners } = yield* readReceipt(stagingFiles(directory).receipt);
    const published = new Map<string, string>();
    for (const { appId } of owners) {
      const text = yield* fs.readFileString(path.join(receipts, `${appId}.json`)).pipe(Effect.option);
      const receipt = text.pipe(Option.flatMap(Schema.decodeUnknownOption(ReceiptPlanJson)));
      if (Option.isSome(receipt) && receipt.value.plan.appId === appId) {
        published.set(appId, receipt.value.plan.buildMarker);
      }
    }
    const mismatched = ownerMismatches(owners, published);
    if (mismatched.length > 0) {
      return yield* failure(
        `the staged outbox host does not carry the published build of: ${mismatched.join(', ')}; nothing was published`,
      );
    }
    return yield* Console.log(`the staged outbox host carries all ${String(owners.length)} published owner builds`);
  });

/** Deletes a staged version that was never deployed; anything else is left alone. */
const discardVersion = (receipt: StagedHost) =>
  Effect.gen(function* discardStagedVersion() {
    const api = yield* ZeropsPublicApi;
    const version = yield* api.appVersion(receipt.appVersionId);
    if (version.serviceStackId !== receipt.serviceId || !UNDEPLOYED_STATUSES.has(version.status)) {
      return false;
    }
    yield* api.deleteAppVersion(receipt.appVersionId);
    return true;
  });

/**
 * After publication and the host configuration apply: deploys the staged version of this attempt and waits for the
 * deploy process. A changed service configuration retires the staged version for a fresh one first.
 */
export const deployStagedHost = ({
  digest,
  directory,
  zeropsYaml,
}: {
  readonly digest: string;
  readonly directory: string;
  readonly zeropsYaml: string;
}) =>
  Effect.gen(function* deployOutboxHost() {
    yield* requireDigest(digest);
    const fs = yield* FileSystem.FileSystem;
    const api = yield* ZeropsPublicApi;
    const files = stagingFiles(directory);
    const receipt = yield* readReceipt(files.receipt);
    const [attempt, serviceId] = yield* Effect.all([runIdentity, hostServiceId]);
    if (
      receipt.attempt !== attempt ||
      receipt.serviceId !== serviceId ||
      receipt.artifactDigest !== digest ||
      !receipt.uploaded ||
      receipt.deployStarted
    ) {
      return yield* failure('the staged outbox host belongs to another attempt, service, digest or deploy');
    }
    const yaml = yield* fs.readFileString(zeropsYaml);
    const current = userDataFingerprint(yield* fingerprintKey, yield* api.serviceUserData(serviceId));
    // A discard already under way owns the staged version from here on: neither replace nor deploy it.
    const stopped = Effect.gen(function* requireNotStopped() {
      if (yield* fs.exists(files.stop)) {
        return yield* failure('the release stopped before the outbox host deploy');
      }
      return yield* Effect.void;
    });
    yield* stopped;
    let staged = receipt;
    if (current !== receipt.userDataFingerprint) {
      yield* Console.log('the host configuration changed since staging: replacing the staged version');
      const archive = yield* readPackage(directory, receipt.packageSha256);
      yield* discardVersion(receipt);
      const {
        appVersionId: _retired,
        deployStarted: _started,
        uploaded: _uploaded,
        userDataFingerprint: _staged,
        ...base
      } = receipt;
      staged = yield* stageVersion(directory, base, archive);
      yield* stopped;
    }
    yield* writeReceipt(files.receipt, { ...staged, deployStarted: true });
    yield* phase('deploy-start');
    yield* api.deployAppVersion(staged.appVersionId, yaml, HOST_SETUP);
    yield* phase('deploy-done');
    return yield* Console.log(
      `deployed outbox host ${digest.slice(0, 12)} (application version ${staged.appVersionId})`,
    );
  });

/** Waits up to `waitFor` for a background wrapper's `exit-code` in `directory`. */
const awaitBackground = (directory: string, waitFor: Duration.Duration) =>
  Effect.gen(function* awaitBackgroundExit() {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.exists(stagingFiles(directory).exitCode).pipe(
      Effect.orElseSucceed(() => false),
      Effect.repeat({ schedule: Schedule.spaced(POLL_INTERVAL), until: (done) => done }),
      Effect.timeoutOrElse({ duration: waitFor, orElse: () => Effect.succeed(false) }),
    );
  });

/**
 * After every release, once the deploy was joined: stops the staging and the deploy, waits for a version creation
 * and a deploy (launched when `deployDirectory` exists) still under way, then deletes the operation's own
 * undeployed version. A deploy that started is never undone.
 */
export const discardStagedHost = ({
  deployDirectory,
  directory,
  waitFor,
}: {
  readonly deployDirectory: string;
  readonly directory: string;
  readonly waitFor: Duration.Duration;
}) =>
  Effect.gen(function* discardOutboxHost() {
    const fs = yield* FileSystem.FileSystem;
    const files = stagingFiles(directory);
    if (!(yield* fs.exists(directory))) {
      return yield* Console.log(NOTHING_STAGED);
    }
    yield* fs.writeFileString(files.stop, '');
    if (!(yield* fs.exists(files.creating))) {
      return yield* Console.log(NOTHING_STAGED);
    }
    yield* awaitBackground(directory, waitFor);
    if (yield* fs.exists(deployDirectory)) {
      yield* awaitBackground(deployDirectory, waitFor);
    }
    if (!(yield* fs.exists(files.receipt))) {
      return yield* Console.log(NOTHING_STAGED);
    }
    const receipt = yield* readReceipt(files.receipt);
    if (receipt.deployStarted) {
      return yield* Console.log(`application version ${receipt.appVersionId} was deployed; nothing to discard`);
    }
    const discarded = yield* discardVersion(receipt);
    return yield* Console.log(
      discarded
        ? `discarded the undeployed application version ${receipt.appVersionId}`
        : `application version ${receipt.appVersionId} is no longer undeployed; left as it is`,
    );
  });

const directoryFlag = Flag.String('directory').pipe(Flag.withDescription("This attempt's private staging directory"));
const digestFlag = Flag.String('digest').pipe(Flag.withDescription('The plan host digest'));

const commands = Command.make('stage-outbox-host').pipe(
  Command.withSubcommands([
    Command.make(
      'upload',
      { artifact: Flag.String('artifact'), digest: digestFlag, directory: directoryFlag },
      uploadStagedHost,
    ),
    Command.make('check-owners', { directory: directoryFlag, receipts: Flag.String('receipts') }, checkStagedOwners),
    Command.make(
      'deploy',
      { digest: digestFlag, directory: directoryFlag, zeropsYaml: Flag.String('zerops-yaml') },
      deployStagedHost,
    ),
    Command.make(
      'discard',
      {
        deployDirectory: Flag.String('deploy-directory').pipe(
          Flag.withDescription("The deploy step's background directory; it exists once the deploy was launched"),
        ),
        directory: directoryFlag,
      },
      ({ deployDirectory, directory }) => discardStagedHost({ deployDirectory, directory, waitFor: DISCARD_WAIT }),
    ),
  ]),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(
        Command.run(commands, { version: '1.0.0' }).pipe(
          // Provider failures carry no URL or secret in their message; their causes are never rendered.
          Effect.catchTag('ZeropsApiError', ({ message }) => Effect.fail(failure(message))),
        ),
      ).pipe(
        Layer.provide(Layer.mergeAll(OpsShellLive, ZeropsPublicApiLive)),
        Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
