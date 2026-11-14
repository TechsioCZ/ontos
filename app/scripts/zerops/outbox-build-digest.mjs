// A missing/unknown input is a cache miss, never permission to reuse a worker bundle.
import { createHash } from 'node:crypto';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Console, Data, Effect, FileSystem, Order, Path, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

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
];

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

/**
 * Every file the worker bundle is built from: the build tools, every workspace package manifest (dependency
 * versions, package exports and worker discovery are materialization inputs) and the artifact's source closure.
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
        files.add(`${parent}/${child}/package.json`);
      }
    }
    for (const input of sourceInputs) {
      if (input !== VIRTUAL_PLATFORM_INPUT) {
        if (!isWorkspaceInput(input)) {
          return yield* doubt('Non-workspace worker input');
        }
        files.add(input);
      }
    }
    return EffectArray.sort([...files], Order.String);
  });

/**
 * The hosted owners' identities, each proved to be the one the kept worker was built with.
 * @param {string} root App workspace.
 * @param {ReadonlyMap<string, string>} digests Owner digests by owner id.
 * @param {readonly { readonly appId: string, readonly buildMarker: string, readonly sourceRevision: string, readonly unitId: string }[]} previous The artifact's owner identities.
 */
const ownerIdentities = (root, digests, previous) =>
  Effect.gen(function* ownerIdentitiesProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* fs.readFileString(path.join(root, 'scripts/outbox-worker-host.generated.mts'));
    const owners = [...host.matchAll(HOSTED_OWNER)].map((match) => match.groups?.owner ?? '');
    if (new Set(owners).size !== owners.length || owners.length !== previous.length) {
      return yield* doubt('Worker owner inventory changed');
    }
    const identities = [];
    for (const owner of owners) {
      const digest = digests.get(owner) ?? '';
      if (!OWNER_DIGEST.test(digest)) {
        return yield* doubt('Missing owner digest');
      }
      const directory = owner === 'shell-super-app' ? 'apps/shell-super-app' : `verticals/${owner}`;
      const marker = yield* fs.readFileString(path.join(root, directory, 'dist/ultramodern-build.json'));
      const { deliveryUnit } = yield* Schema.decodeEffect(OwnerBuildMarker)(marker);
      const kept = previous.find((candidate) => candidate.appId === owner);
      if (
        kept === undefined ||
        !PROMOTABLE_REVISION.test(deliveryUnit.sourceRevision) ||
        IDENTITY_KEYS.some((key) => deliveryUnit[key] !== kept[key])
      ) {
        return yield* doubt('Worker owner build identity changed');
      }
      identities.push({ digest, marker, owner });
    }
    return identities;
  });

/**
 * The digest of everything a kept Outbox Worker host bundle depends on; it fails on any doubt.
 * @param {string} root App workspace.
 * @param {string} runtime Candidate worker runtime.
 * @param {string} table Unit digest table.
 */
export const outboxBuildDigest = (root, runtime, table) =>
  Effect.gen(function* outboxBuildDigestProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifact = yield* fs
      .readFileString(path.join(runtime, 'worker-artifact.json'))
      .pipe(Effect.flatMap(Schema.decodeEffect(WorkerArtifact)));
    const hash = createHash('sha256').update(MATERIALIZE_FLAGS);
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
      const [owner = '', digest = ''] = row.split('\t');
      digests.set(owner, digest);
    }
    for (const { digest, marker, owner } of yield* ownerIdentities(root, digests, artifact.ownerBuildIdentities)) {
      hash.update(owner).update(digest).update(marker);
    }
    return hash.digest('hex');
  });

const outboxBuildDigestCommand = Command.make(
  'outbox-build-digest',
  { runtime: Argument.String('runtime'), table: Argument.String('table') },
  ({ runtime, table }) =>
    outboxBuildDigest(process.cwd(), runtime, table).pipe(Effect.flatMap((digest) => Console.log(digest))),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(outboxBuildDigestCommand, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)),
    { disableErrorReporting: true },
  );
}
