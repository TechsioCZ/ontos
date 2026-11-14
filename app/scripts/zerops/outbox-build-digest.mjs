// A missing/unknown input is a cache miss, never permission to reuse a worker bundle.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
/** @param {string} root App workspace. @param {string} runtime Candidate worker runtime. @param {string} table Unit digest table. */
export const outboxBuildDigest = (root, runtime, table) => {
  const artifact = JSON.parse(readFileSync(path.join(runtime, 'worker-artifact.json'), 'utf8'));
  if (
    artifact.schemaVersion !== 4 ||
    !Array.isArray(artifact.sourceInputs) ||
    artifact.sourceInputs.length === 0 ||
    !Array.isArray(artifact.ownerBuildIdentities) ||
    artifact.ownerBuildIdentities.length === 0
  ) {
    throw new Error('Unknown worker artifact');
  }
  const hash = createHash('sha256').update(MATERIALIZE_FLAGS);
  const files = new Set(OUTBOX_BUILD_TOOLS);
  // Dependency versions, package exports and worker discovery are also materialization inputs.
  for (const parent of ['apps', 'verticals', 'packages']) {
    for (const child of readdirSync(path.join(root, parent))) {
      files.add(`${parent}/${child}/package.json`);
    }
  }
  for (const input of artifact.sourceInputs) {
    // The one virtual module is defined by materialize-outbox-worker.mjs, already hashed above.
    if (typeof input !== 'string') throw new Error('Unknown worker input');
    if (input === 'worker-platform-node:@effect/platform-node') continue;
    if (path.isAbsolute(input) || input.split('/').includes('..')) throw new Error('Non-workspace worker input');
    files.add(input);
  }
  for (const file of [...files].sort()) {
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(path.join(root, file)))
      .update('\0');
  }
  const digests = new Map(
    readFileSync(table, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('\t')),
  );
  const owners = [
    ...readFileSync(path.join(root, 'scripts/outbox-worker-host.generated.mts'), 'utf8').matchAll(
      /from '@app\/([a-z-]+)\/outbox-worker-host'/gu,
    ),
  ].map((match) => match[1]);
  if (new Set(owners).size !== owners.length || owners.length !== artifact.ownerBuildIdentities.length) {
    throw new Error('Worker owner inventory changed');
  }
  for (const owner of owners) {
    const digest = digests.get(owner);
    if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Missing owner digest');
    const directory = owner === 'shell-super-app' ? 'apps/shell-super-app' : `verticals/${owner}`;
    const identity = JSON.parse(
      readFileSync(path.join(root, directory, 'dist/ultramodern-build.json'), 'utf8'),
    ).deliveryUnit;
    const previous = artifact.ownerBuildIdentities.find((candidate) => candidate.appId === owner);
    if (
      !previous ||
      !identity ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(identity.sourceRevision) ||
      ['sourceRevision', 'unitId', 'buildMarker'].some((key) => identity[key] !== previous[key])
    ) {
      throw new Error('Worker owner build identity changed');
    }
    hash.update(owner).update(digest).update(JSON.stringify(identity));
  }
  return hash.digest('hex');
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${outboxBuildDigest(process.cwd(), process.argv[2], process.argv[3])}\n`);
  } catch {
    process.exitCode = 1;
  }
}
