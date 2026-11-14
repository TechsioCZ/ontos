import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { outboxBuildDigest, OUTBOX_BUILD_TOOLS } from '../zerops/outbox-build-digest.mjs';

const identity = { buildMarker: 'built-shell', sourceRevision: 'a'.repeat(40), unitId: 'app/shell-super-app' };
const owner = 'shell-super-app';
const entry = 'scripts/outbox-worker-host.generated.mts';
const closure = 'packages/core-runtime/src/worker.ts';
const marker = 'apps/shell-super-app/dist/ultramodern-build.json';
const fixture = Effect.gen(function* workerDigestFixture() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const write = (file: string, content: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, file), content)));
  for (const file of OUTBOX_BUILD_TOOLS) {
    yield* write(file, 'input');
  }
  for (const file of [
    'apps/shell-super-app/package.json',
    'verticals/example/package.json',
    'packages/core-runtime/package.json',
  ]) {
    yield* write(file, '{}');
  }
  yield* write(entry, "import { worker } from '@app/shell-super-app/outbox-worker-host';");
  yield* write(closure, 'worker source');
  yield* write(marker, JSON.stringify({ deliveryUnit: identity }));
  yield* write('digests', `${owner}\t${'b'.repeat(64)}\n`);
  const artifact = {
    ownerBuildIdentities: [{ appId: owner, ...identity }],
    schemaVersion: 4,
    sourceInputs: [entry, closure, 'worker-platform-node:@effect/platform-node'],
  };
  yield* write('runtime/worker-artifact.json', JSON.stringify(artifact));
  const digest = () => outboxBuildDigest(root, path.join(root, 'runtime'), path.join(root, 'digests'));
  return { artifact, digest, fs, root, write };
});

for (const changed of [
  closure,
  'scripts/materialize-outbox-worker.mjs',
  'pnpm-lock.yaml',
  'verticals/example/package.json',
  'digests',
]) {
  it.effect(`invalidates the worker when ${changed} changes`, () =>
    Effect.gen(function* changedWorkerInput() {
      const context = yield* fixture;
      const before = context.digest();
      expect(context.digest()).toBe(before);
      yield* context.write(changed, changed === 'digests' ? `${owner}\t${'c'.repeat(64)}\n` : 'changed input');
      expect(context.digest()).not.toBe(before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
for (const doubt of ['missing closure', 'changed identity', 'missing owner', 'unknown virtual input']) {
  it.effect(`fails closed on ${doubt}`, () =>
    Effect.gen(function* incompleteWorkerProof() {
      const context = yield* fixture;
      if (doubt === 'missing closure') {
        yield* context.fs.remove(path.join(context.root, closure));
      }
      if (doubt === 'changed identity') {
        yield* context.write(marker, JSON.stringify({ deliveryUnit: { ...identity, sourceRevision: 'd'.repeat(40) } }));
      }
      if (doubt === 'missing owner') {
        yield* context.write('digests', 'another-owner\tinvalid\n');
      }
      if (doubt === 'unknown virtual input') {
        yield* context.write(
          'runtime/worker-artifact.json',
          JSON.stringify({ ...context.artifact, sourceInputs: ['unknown:module'] }),
        );
      }
      expect(context.digest).toThrow();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
