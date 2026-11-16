// A missing/unknown input is a cache miss, never permission to reuse a worker bundle.
//
// The digest of a prepared Outbox Worker host runtime. build-app.sh records it after a build and keeps the cached
// host only when the digest of the cached copy equals that record. It covers, in order:
// - the materializer's flags and every build tool it runs (OUTBOX_BUILD_TOOLS: the materializer scripts, the
//   generated host entry, the topology and release intent, the lockfile, workspace and toolchain pins);
// - every workspace package manifest, and every source file the worker bundle was built from (the artifact's
//   esbuild input closure);
// - the hosted owners the host is built for, hosted ∩ served, proved equal to the owners the artifact records, each
//   with its unit identity and the build identity (dist/ultramodern-build.json) it was built under;
// - every served unit's identity and build identity, so a host is rebuilt whenever any unit is (unit identities
//   carry the declared build variables, so a changed build environment rebuilds it too);
// - the platform the runtime's dependencies were installed and rebuilt on (`npm rebuild` compiles native addons):
//   OS, CPU, Node version, libc and the pnpm and npm versions;
// - every byte of the runtime itself except the record, so a half-copied or altered cache never matches.
import { createHash } from 'node:crypto';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Console, Data, Effect, FileSystem, Order, Path, Schema, Stream } from 'effect';
import { Argument, Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

export const MATERIALIZE_FLAGS = '--app outbox-worker-host --package app --package-dir . --worker';
export const OUTBOX_BUILD_TOOLS = [
  'scripts/zerops/build-app.sh',
  'scripts/zerops/outbox-build-digest.mjs',
  'scripts/materialize-ontos-zerops-runtime.mjs',
  'scripts/materialize-outbox-worker.mjs',
  'scripts/materialize-node-output.mjs',
  'scripts/materialize-node-runtime-envelope.mts',
  'scripts/generate-outbox-worker-deployment.mjs',
  'scripts/outbox-worker-delivery.mjs',
  'scripts/topology-development-ports.mjs',
  'scripts/outbox-worker-host.generated.mts',
  'topology/reference-topology.json',
  'topology/application-release-intent.json',
  'topology/local-overlays/development.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.mise.toml',
];
/** The record build-app.sh writes into the runtime; the runtime's bytes are everything else. */
export const RECORD = '.zerops-build-digest';
/** build-app.sh's served units: the Shell and every module the release intent names. */
const SHELL = 'shell-super-app';
const RELEASE_INTENT = 'topology/application-release-intent.json';

/** The one virtual module, defined by materialize-outbox-worker.mjs, which is already hashed as a build tool. */
const VIRTUAL_PLATFORM_INPUT = 'worker-platform-node:@effect/platform-node';
const OWNER_DIGEST = /^[a-f0-9]{64}$/u;
const PROMOTABLE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const HOSTED_OWNER = /from '@app\/(?<owner>[a-z-]+)\/outbox-worker-host'/gu;
/** @type {readonly ('buildMarker' | 'sourceRevision' | 'unitId')[]} */
const IDENTITY_KEYS = ['sourceRevision', 'unitId', 'buildMarker'];

const OwnerBuildIdentity = Schema.Struct({
  buildMarker: Schema.String,
  sourceRevision: Schema.String,
  unitId: Schema.String.pipe(Schema.brand('UnitId')),
});
const WorkerArtifact = Schema.fromJsonString(
  Schema.Struct({
    ownerBuildIdentities: Schema.NonEmptyArray(
      Schema.Struct({ appId: Schema.String.pipe(Schema.brand('AppId')), ...OwnerBuildIdentity.fields }),
    ),
    schemaVersion: Schema.Literal(4),
    sourceInputs: Schema.NonEmptyArray(Schema.String),
  }),
);
const OwnerBuildMarker = Schema.fromJsonString(Schema.Struct({ deliveryUnit: OwnerBuildIdentity }));
const ReleaseIntent = Schema.fromJsonString(
  Schema.Struct({ modules: Schema.Array(Schema.Struct({ appId: Schema.String.pipe(Schema.brand('ServedAppId')) })) }),
);

export class OutboxBuildDigestError extends Data.TaggedError('OutboxBuildDigestError') {
  /** @param {string} message Why the worker's input proof is incomplete. */
  constructor(message) {
    super({ message });
  }
}

/** @param {string} message Why the worker's input proof is incomplete. */
const doubt = (message) => Effect.fail(new OutboxBuildDigestError(message));

/** @param {string} input A source input the worker artifact names. */
const isWorkspaceInput = (input) => !input.startsWith('/') && !input.split('/').includes('..');
/** @param {string} unit A unit id. */
const unitDirectory = (unit) => (unit === SHELL ? 'apps/shell-super-app' : `verticals/${unit}`);

/**
 * Every file the worker bundle is built from: the build tools, every workspace package manifest (dependency
 * versions, package exports and worker discovery are materialization inputs) and the artifact's source closure.
 * A directory without a manifest is not a workspace package; the materializer skips it too.
 * @param {string} root App workspace.
 * @param {readonly string[]} sourceInputs The artifact's source inputs.
 */
const workerInputFiles = (root, sourceInputs) =>
  Effect.gen(function* workerInputFilesProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = new Set(OUTBOX_BUILD_TOOLS);
    for (const parent of ['apps', 'verticals', 'packages']) {
      for (const child of yield* fs.readDirectory(path.join(root, parent))) {
        const manifest = `${parent}/${child}/package.json`;
        if (yield* fs.exists(path.join(root, manifest))) {
          files.add(manifest);
        }
      }
    }
    for (const input of sourceInputs) {
      if (input !== VIRTUAL_PLATFORM_INPUT) {
        if (!isWorkspaceInput(input)) {
          return yield* doubt(`Non-workspace worker input: ${input}`);
        }
        files.add(input);
      }
    }
    return EffectArray.sort([...files], Order.String);
  });

/**
 * A unit's build identity as its dist names it, which must be a promotable release.
 * @param {string} root App workspace.
 * @param {string} unit A unit id.
 */
const unitBuildMarker = (root, unit) =>
  Effect.gen(function* unitBuildMarkerProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(root, unitDirectory(unit), 'dist/ultramodern-build.json');
    if (!(yield* fs.exists(file))) {
      return yield* doubt(`Missing build identity of ${unit}`);
    }
    const marker = yield* fs.readFileString(file);
    const { deliveryUnit } = yield* Schema.decodeEffect(OwnerBuildMarker)(marker);
    if (!PROMOTABLE_REVISION.test(deliveryUnit.sourceRevision)) {
      return yield* doubt(`The build identity of ${unit} names no promotable revision`);
    }
    return { deliveryUnit, marker };
  });

/**
 * The served units, as build-app.sh serves them: the Shell and every module of the release intent.
 * @param {string} root App workspace.
 */
const servedUnits = (root) =>
  Effect.gen(function* servedUnitsProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const intent = yield* fs
      .readFileString(path.join(root, RELEASE_INTENT))
      .pipe(Effect.flatMap(Schema.decodeEffect(ReleaseIntent)));
    return [SHELL, ...intent.modules.map(({ appId }) => appId)];
  });

/**
 * The hosted owners the host is built for (hosted ∩ served, as materialize-outbox-worker.mjs builds it), each proved
 * to carry the identity the kept worker was built with.
 * @param {string} root App workspace.
 * @param {readonly string[]} served The served units.
 * @param {ReadonlyMap<string, string>} digests Unit identities by unit id.
 * @param {readonly { readonly appId: string, readonly buildMarker: string, readonly sourceRevision: string, readonly unitId: string }[]} previous The artifact's owner identities.
 */
const ownerIdentities = (root, served, digests, previous) =>
  Effect.gen(function* ownerIdentitiesProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* fs.readFileString(path.join(root, 'scripts/outbox-worker-host.generated.mts'));
    const hosted = [...host.matchAll(HOSTED_OWNER)].map((match) => match.groups?.owner ?? '');
    if (new Set(hosted).size !== hosted.length) {
      return yield* doubt('The generated host names an owner twice');
    }
    // A hosted owner the deployment does not serve has no unit build here, and the host does not run its worker.
    const owners = hosted.filter((owner) => served.includes(owner));
    const recorded = previous.map(({ appId }) => appId);
    if (owners.length !== recorded.length || owners.some((owner) => !recorded.includes(owner))) {
      return yield* doubt(
        `Worker owner inventory changed: hosts ${owners.join(' ')}, the artifact records ${recorded.join(' ')}`,
      );
    }
    const identities = [];
    for (const owner of owners) {
      const digest = digests.get(owner) ?? '';
      if (!OWNER_DIGEST.test(digest)) {
        return yield* doubt(`Missing owner digest of ${owner}`);
      }
      const { deliveryUnit, marker } = yield* unitBuildMarker(root, owner);
      const kept = previous.find((candidate) => candidate.appId === owner);
      if (kept === undefined || IDENTITY_KEYS.some((key) => deliveryUnit[key] !== kept[key])) {
        return yield* doubt(`Worker owner build identity changed: ${owner}`);
      }
      identities.push({ digest, marker, owner });
    }
    return identities;
  });

/** @param {string} command A tool on PATH; its `--version` line. */
const toolVersion = (command) =>
  Effect.gen(function* toolVersionProgram() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make(command, ['--version']));
    const [version, , code] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: 'unbounded' },
    );
    return Number(code) === 0 ? version.trim() : yield* doubt(`Cannot read the ${command} version`);
  }).pipe(Effect.scoped);

/**
 * The C library Node runs on: glibc names its version in the diagnostic report; musl (Alpine) names none.
 * @typedef {{ readonly header?: { readonly glibcVersionRuntime?: string } }} NodeReport
 */
const libcIdentity = () => {
  /** @type {NodeReport} */
  const report = process.report.getReport();
  const glibc = report.header?.glibcVersionRuntime;
  return glibc === undefined ? 'no-glibc' : `glibc ${glibc}`;
};

/** The platform the runtime's dependencies are installed and natively rebuilt for. */
const platformIdentity = Effect.gen(function* platformIdentityProgram() {
  const libc = libcIdentity();
  const tools = yield* Effect.all([toolVersion('pnpm'), toolVersion('npm')], { concurrency: 1 });
  return [process.platform, process.arch, process.version, libc, `pnpm ${tools[0]}`, `npm ${tools[1]}`].join('\n');
});

/**
 * Every file and link of the runtime but the record, as path, kind and content, sorted by path.
 * @param {string} runtime The runtime directory.
 * @param {string} relative The path below it.
 * @returns {Effect.Effect<readonly { readonly bytes: Uint8Array | string, readonly kind: string, readonly path: string }[], OutboxBuildDigestError | import('effect/PlatformError').PlatformError, FileSystem.FileSystem | Path.Path>} The runtime's entries.
 */
const runtimeFiles = (runtime, relative) =>
  Effect.gen(function* runtimeFilesProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(runtime, relative);
    const info = yield* fs.lstat(filename);
    if (info.type === 'Directory') {
      const children = yield* Effect.forEach(
        EffectArray.sort(yield* fs.readDirectory(filename), Order.String),
        (name) => runtimeFiles(runtime, relative === '' ? name : `${relative}/${name}`),
        { concurrency: 16 },
      );
      return children.flat();
    }
    if (info.type === 'SymbolicLink') {
      return [{ bytes: yield* fs.readLink(filename), kind: 'link', path: relative }];
    }
    if (info.type !== 'File') {
      return yield* doubt(`Unsupported runtime entry: ${relative}`);
    }
    return relative === RECORD ? [] : [{ bytes: yield* fs.readFile(filename), kind: 'file', path: relative }];
  });

/**
 * The digest of everything a kept Outbox Worker host runtime depends on and consists of; it fails on any doubt.
 * @param {string} root App workspace.
 * @param {string} runtime Candidate worker runtime.
 * @param {string} table Unit identity table (delivery-plan-cli.mts digests).
 */
export const outboxBuildDigest = (root, runtime, table) =>
  Effect.gen(function* outboxBuildDigestProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifact = yield* fs
      .readFileString(path.join(runtime, 'worker-artifact.json'))
      .pipe(Effect.flatMap(Schema.decodeEffect(WorkerArtifact)));
    const hash = createHash('sha256').update('outbox-host-v2\0').update(MATERIALIZE_FLAGS);
    for (const file of yield* workerInputFiles(root, artifact.sourceInputs)) {
      hash
        .update(file)
        .update('\0')
        .update(yield* fs.readFile(path.join(root, file)))
        .update('\0');
    }
    /** @type {Map<string, string>} */
    const digests = new Map();
    for (const row of (yield* fs.readFileString(table)).trim().split('\n')) {
      const [unit = '', digest = ''] = row.split('\t');
      digests.set(unit, digest);
    }
    const served = yield* servedUnits(root);
    for (const { digest, marker, owner } of yield* ownerIdentities(
      root,
      served,
      digests,
      artifact.ownerBuildIdentities,
    )) {
      hash.update(owner).update(digest).update(marker);
    }
    // Any unit rebuilt, even one without a worker, rebuilds the host.
    for (const unit of EffectArray.sort(served, Order.String)) {
      const digest = digests.get(unit) ?? '';
      if (!OWNER_DIGEST.test(digest)) {
        return yield* doubt(`Missing unit digest of ${unit}`);
      }
      hash
        .update(`served\0${unit}\0${digest}\0`)
        .update((yield* unitBuildMarker(root, unit)).marker)
        .update('\0');
    }
    hash.update(`platform\0${yield* platformIdentity}\0`);
    for (const file of yield* runtimeFiles(runtime, '')) {
      hash.update(`${file.kind}\0${file.path}\0`).update(file.bytes).update('\0');
    }
    return hash.digest('hex');
  });

/**
 * Names the proof that failed, so the build log says why the host is rebuilt.
 * @param {{ readonly message: string }} failure The digest failure.
 */
const reportDoubt = (failure) => Console.error(`outbox worker host digest: ${failure.message}`);

const outboxBuildDigestCommand = Command.make(
  'outbox-build-digest',
  { runtime: Argument.String('runtime'), table: Argument.String('table') },
  ({ runtime, table }) =>
    outboxBuildDigest(process.cwd(), runtime, table).pipe(
      Effect.flatMap((digest) => Console.log(digest)),
      // build-app.sh prints "incomplete input proof"; this line says which proof.
      Effect.tapError(reportDoubt),
    ),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(outboxBuildDigestCommand, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)),
    { disableErrorReporting: true },
  );
}
