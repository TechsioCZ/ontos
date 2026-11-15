import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { outboxBuildDigest, OUTBOX_BUILD_TOOLS, RECORD } from '../zerops/outbox-build-digest.mjs';

const SHELL = 'shell-super-app';
const HOSTED = 'crm';
/** A unit the deployment serves that has no Outbox Worker. */
const WORKERLESS = 'tax';
/** An owner the generated host names but the deployment does not serve (as payment and commerce-order on stage). */
const UNSERVED = 'payment';
const REVISION = 'a'.repeat(40);
const ENTRY = 'scripts/outbox-worker-host.generated.mts';
const INTENT = 'topology/application-release-intent.json';
const CLOSURE = 'packages/core-runtime/src/worker.ts';
const LOCKFILE = 'pnpm-lock.yaml';
const TABLE = 'digests';
const RUNTIME = 'runtime';
const WORKER = `${RUNTIME}/worker.mjs`;
const unitDirectory = (unit: string) => (unit === SHELL ? 'apps/shell-super-app' : `verticals/${unit}`);
const markerPath = (unit: string) => `${unitDirectory(unit)}/dist/ultramodern-build.json`;
const identityOf = (unit: string, buildMarker = `built-${unit}`) => ({
  buildMarker,
  sourceRevision: REVISION,
  unitId: `app/${unit}`,
});
const markerOf = (unit: string, buildMarker?: string) =>
  JSON.stringify({ deliveryUnit: identityOf(unit, buildMarker) });
const tableOf = (digests: Readonly<Record<string, string>>) =>
  `${Object.entries(digests)
    .map(([unit, digest]) => `${unit}\t${digest}\tfiles\tONTOS_PUBLIC_ORIGIN=0123456789ab`)
    .join('\n')}\n`;
const DIGESTS = { [HOSTED]: 'c'.repeat(64), [SHELL]: 'b'.repeat(64), [WORKERLESS]: 'd'.repeat(64) };
const hostEntry = (owners: readonly string[]) =>
  owners.map((owner) => `import { worker } from '@app/${owner}/outbox-worker-host';`).join('\n');
const artifactOf = (owners: readonly string[]) =>
  JSON.stringify({
    ownerBuildIdentities: owners.map((owner) => ({ appId: owner, ...identityOf(owner) })),
    schemaVersion: 4,
    sourceInputs: [ENTRY, CLOSURE, 'worker-platform-node:@effect/platform-node'],
  });

/** A workspace with a built host: the Shell and crm host workers, tax has none, payment is hosted but not served. */
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
  for (const unit of [SHELL, HOSTED, WORKERLESS, UNSERVED]) {
    yield* write(`${unitDirectory(unit)}/package.json`, '{}');
  }
  yield* write('packages/core-runtime/package.json', '{}');
  // A leftover directory without a manifest (a restored build cache of a removed unit) is not a package.
  yield* fs.makeDirectory(path.join(root, 'verticals/removed/node_modules/.cache'), { recursive: true });
  yield* write(INTENT, JSON.stringify({ modules: [{ appId: HOSTED }, { appId: WORKERLESS }] }));
  yield* write(ENTRY, hostEntry([SHELL, HOSTED, UNSERVED]));
  yield* write(CLOSURE, 'worker source');
  for (const unit of [SHELL, HOSTED, WORKERLESS]) {
    yield* write(markerPath(unit), markerOf(unit));
  }
  yield* write(TABLE, tableOf(DIGESTS));
  yield* write(`${RUNTIME}/worker-artifact.json`, artifactOf([SHELL, HOSTED]));
  yield* write(WORKER, 'bundled worker');
  yield* write(`${RUNTIME}/node_modules/native/addon.node`, 'native addon');
  const digest = (runtime = RUNTIME) => outboxBuildDigest(root, path.join(root, runtime), path.join(root, TABLE));
  return { digest, fs, root, write };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect('keeps a host whose inputs, owners and bytes are unchanged, despite an unserved hosted owner', () =>
  run(
    Effect.gen(function* unchangedHost() {
      const context = yield* fixture;
      const before = yield* context.digest();
      expect(yield* context.digest()).toBe(before);
      // The record build-app.sh writes into the runtime is not part of it.
      yield* context.write(`${RUNTIME}/${RECORD}`, before);
      expect(yield* context.digest()).toBe(before);
      // The cache copy of a runtime has the same digest.
      yield* context.fs.copy(path.join(context.root, RUNTIME), path.join(context.root, 'cache'));
      expect(yield* context.digest('cache')).toBe(before);
    }),
  ),
);

const changes: readonly { readonly change: string; readonly content: string; readonly file: string }[] = [
  { change: "a hosted owner's build marker", content: markerOf(HOSTED, 'rebuilt-crm'), file: markerPath(HOSTED) },
  {
    change: "a workerless unit's build marker",
    content: markerOf(WORKERLESS, 'rebuilt'),
    file: markerPath(WORKERLESS),
  },
  { change: 'a host source', content: 'changed source', file: CLOSURE },
  { change: 'the lockfile', content: 'changed lockfile', file: LOCKFILE },
  { change: 'a materializer script', content: 'changed tool', file: 'scripts/materialize-outbox-worker.mjs' },
  { change: 'a workspace manifest', content: '{"version":"2"}', file: `${unitDirectory(UNSERVED)}/package.json` },
  {
    change: "a unit's identity, which carries the declared build environment",
    content: tableOf({ ...DIGESTS, [WORKERLESS]: 'e'.repeat(64) }),
    file: TABLE,
  },
  { change: 'the built worker bytes', content: 'altered worker', file: WORKER },
  { change: 'a native addon', content: 'other addon', file: `${RUNTIME}/node_modules/native/addon.node` },
];
for (const { change, content, file } of changes) {
  it.effect(`rebuilds the host when ${change} changes`, () =>
    run(
      Effect.gen(function* changedHostInput() {
        const context = yield* fixture;
        const before = yield* context.digest();
        yield* context.write(file, content);
        // A different digest, or no digest at all: either way build-app.sh rebuilds instead of keeping the host.
        const after = yield* Effect.exit(context.digest());
        expect(Exit.isSuccess(after) && after.value === before).toBe(false);
      }),
    ),
  );
}

it.effect('rebuilds the host when a served hosted owner is added or the generated owner list changes', () =>
  run(
    Effect.gen(function* changedOwners() {
      const context = yield* fixture;
      // Serving payment makes it a hosted owner the artifact does not record.
      yield* context.write(
        INTENT,
        JSON.stringify({ modules: [{ appId: HOSTED }, { appId: WORKERLESS }, { appId: UNSERVED }] }),
      );
      yield* context.write(markerPath(UNSERVED), markerOf(UNSERVED));
      yield* context.write(TABLE, tableOf({ ...DIGESTS, [UNSERVED]: 'f'.repeat(64) }));
      expect(Exit.isFailure(yield* Effect.exit(context.digest()))).toBe(true);
      const second = yield* fixture;
      // A served unit that gains a worker in the generated host, which the artifact does not record.
      yield* second.write(ENTRY, hostEntry([SHELL, HOSTED, WORKERLESS, UNSERVED]));
      expect(Exit.isFailure(yield* Effect.exit(second.digest()))).toBe(true);
      const third = yield* fixture;
      const before = yield* third.digest();
      // Only an unserved owner leaves the generated host: no hosted owner changes, but the entry file did.
      yield* third.write(ENTRY, hostEntry([SHELL, HOSTED]));
      expect(yield* third.digest()).not.toBe(before);
    }),
  ),
);

it.effect('rebuilds the host when a served hosted owner is removed', () =>
  run(
    Effect.gen(function* removedOwner() {
      const context = yield* fixture;
      yield* context.write(INTENT, JSON.stringify({ modules: [{ appId: WORKERLESS }] }));
      expect(Exit.isFailure(yield* Effect.exit(context.digest()))).toBe(true);
    }),
  ),
);

for (const doubt of [
  'missing closure',
  'changed identity',
  'missing owner digest',
  'missing served unit marker',
  'unknown virtual input',
  'half-written cache',
]) {
  it.effect(`fails closed on ${doubt}`, () =>
    run(
      Effect.gen(function* incompleteWorkerProof() {
        const context = yield* fixture;
        const remove = (file: string) => context.fs.remove(path.join(context.root, file), { recursive: true });
        if (doubt === 'missing closure') {
          yield* remove(CLOSURE);
        }
        if (doubt === 'changed identity') {
          yield* context.write(
            markerPath(HOSTED),
            JSON.stringify({ deliveryUnit: { ...identityOf(HOSTED), sourceRevision: 'd'.repeat(40) } }),
          );
        }
        if (doubt === 'missing owner digest') {
          yield* context.write(TABLE, tableOf({ [SHELL]: DIGESTS[SHELL], [WORKERLESS]: DIGESTS[WORKERLESS] }));
        }
        if (doubt === 'missing served unit marker') {
          yield* remove(markerPath(WORKERLESS));
        }
        if (doubt === 'unknown virtual input') {
          yield* context.write(
            `${RUNTIME}/worker-artifact.json`,
            artifactOf([SHELL, HOSTED]).replace(ENTRY, '../outside.mts'),
          );
        }
        if (doubt === 'half-written cache') {
          yield* remove(`${RUNTIME}/worker-artifact.json`);
        }
        expect(Exit.isFailure(yield* Effect.exit(context.digest()))).toBe(true);
      }),
    ),
  );
}

it.effect('never matches a cache copy that misses part of the runtime', () =>
  run(
    Effect.gen(function* partialCache() {
      const context = yield* fixture;
      const built = yield* context.digest();
      yield* context.fs.copy(path.join(context.root, RUNTIME), path.join(context.root, 'cache'));
      yield* context.fs.remove(path.join(context.root, 'cache/node_modules'), { recursive: true });
      expect(yield* context.digest('cache')).not.toBe(built);
    }),
  ),
);
