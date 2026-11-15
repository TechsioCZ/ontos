import { createHash } from 'node:crypto';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { createUltramodernReleaseBuildMarker } from '@modern-js/app-tools-extensions/release-identity';
import { Effect, Exit, FileSystem, Layer, PlatformError, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { KeptUnitIdentityError, readBuiltDocument, resolveOwnerReleaseIdentity } from '../ci/kept-unit-identity.mts';
import { CacheReceiptSchema, KEEP_PROOF, KeepProofSchema, RECEIPT } from '../ci/unit-output-receipt.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const SHELL = 'apps/shell-super-app';
const APP_ID = 'shell-super-app';
const GENERATION = 'generation-marker';
const UNIT_ID = 'app/shell-super-app';
const OLD_REVISION = 'a'.repeat(40);
const OTHER_REVISION = 'b'.repeat(40);
const INPUTS = 'c'.repeat(64);
const METADATA = 'dist/ultramodern-build.json';
const CONTRACT = 'dist/public/.well-known/ontos-shell-runtime.json';
/** No ULTRAMODERN_SOURCE_REVISION: the fixture checkout's own clean HEAD is the source revision. */
const ENVIRONMENT = {};
const markerAt = (revision: string) =>
  createUltramodernReleaseBuildMarker({ generationBuildMarker: GENERATION, sourceRevision: revision, unitId: UNIT_ID });
const NOT_THIS_BUILD = 'does not describe this build';
const RECEIPT_UNREADABLE = 'gates receipt cannot be read';
const OTHER_SOURCES = 'other sources';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface InventoryEntry {
  readonly mode: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
interface BuildOptions {
  readonly marker?: string;
  /** Field overrides of the keep proof, or false for none. */
  readonly proof?: { readonly inputs?: string; readonly revision?: string; readonly unit?: string } | false;
  /** Field overrides of the receipt (applied after it describes the build). */
  readonly receipt?: { readonly files?: readonly InventoryEntry[]; readonly unit?: string };
  /** Field overrides of the receipt's identity. */
  readonly receiptIdentity?: {
    readonly appId?: string;
    readonly buildMarker?: string;
    readonly sourceRevision?: string;
  };
  readonly withReceipt?: boolean;
}

/** A clean committed checkout of one unit; built outputs are ignored, as in the real checkout. */
const fixture = Effect.gen(function* keptUnitFixture() {
  const fs = yield* FileSystem.FileSystem;
  const repository = yield* fs.makeTempDirectoryScoped();
  const workspaceRoot = path.join(repository, 'app');
  const write = (file: string, content: string) =>
    fs
      .makeDirectory(path.dirname(path.join(repository, file)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(repository, file), content)));
  const git = (args: readonly string[]) =>
    collectToolingProcess(ChildProcess.make('git', ['-C', repository, ...args])).pipe(
      Effect.map(({ stdout }) => stdout.trim()),
    );
  yield* write('.gitignore', 'dist/\n');
  yield* write(`app/${SHELL}/src/index.ts`, 'export const shell = 1;\n');
  yield* git(['init', '-q']);
  yield* git(['add', '-A']);
  yield* git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture']);
  const head = yield* git(['rev-parse', 'HEAD']);
  const contract = JSON.stringify({ deployment: { appId: APP_ID } });
  /** Writes a built Shell naming `revision`, with its gates receipt and keep proof unless told otherwise. */
  const build = (revision: string, options: BuildOptions = {}) =>
    Effect.gen(function* writeBuild() {
      const marker = options.marker ?? markerAt(revision);
      const identity = { appId: APP_ID, build: marker, buildMarker: marker, sourceRevision: revision };
      const metadata = JSON.stringify({ deliveryUnit: identity });
      yield* write(`app/${SHELL}/${METADATA}`, metadata);
      yield* write(`app/${SHELL}/${CONTRACT}`, contract);
      if (options.withReceipt !== false) {
        const receipt = {
          digest: 'd'.repeat(64),
          files: [
            { mode: 0o644, path: CONTRACT, sha256: sha256(contract), size: contract.length },
            { mode: 0o644, path: METADATA, sha256: sha256(metadata), size: metadata.length },
          ],
          identity: { ...identity, ...options.receiptIdentity },
          inputs: INPUTS,
          schemaVersion: 2,
          unit: APP_ID,
          ...options.receipt,
        };
        yield* write(`app/${SHELL}/${RECEIPT}`, JSON.stringify(receipt));
      }
      if (options.proof !== false) {
        yield* write(
          `app/${SHELL}/${KEEP_PROOF}`,
          JSON.stringify({ inputs: INPUTS, revision: head, schemaVersion: 1, unit: APP_ID, ...options.proof }),
        );
      }
    });
  const resolve = (environment: Readonly<Record<string, string>> = ENVIRONMENT, root = workspaceRoot) =>
    resolveOwnerReleaseIdentity({
      environment,
      generationBuildMarker: GENERATION,
      unitDirectory: SHELL,
      unitId: UNIT_ID,
      workspaceRoot: root,
    });
  /** The refusal's reason, or `accepted`. */
  const refusal = (environment?: Readonly<Record<string, string>>, root?: string) =>
    resolve(environment, root).pipe(
      Effect.match({
        onFailure: (error) => (Schema.is(KeptUnitIdentityError)(error) ? error.reason : String(error)),
        onSuccess: () => 'accepted',
      }),
    );
  return { build, fs, git, head, refusal, repository, resolve, workspaceRoot, write };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));
const live = (name: string, body: () => Effect.Effect<unknown, unknown>) => it.effect(name, body, 30_000);

live('without built output, and for a build of the checkout itself, runs as the checkout', () =>
  run(
    Effect.gen(function* checkoutIdentity() {
      const context = yield* fixture;
      const checkout = { buildMarker: markerAt(context.head), sourceRevision: context.head };
      expect(yield* context.resolve()).toEqual(checkout);
      yield* context.build(context.head, { proof: false, withReceipt: false });
      expect(yield* context.resolve()).toEqual(checkout);
    }),
  ),
);

live('in a dirty checkout runs as the workspace whatever the outputs, as before', () =>
  run(
    Effect.gen(function* dirtyCheckout() {
      const context = yield* fixture;
      yield* context.build(OLD_REVISION, { proof: false, withReceipt: false });
      yield* context.write(`app/${SHELL}/src/index.ts`, 'export const shell = 2;\n');
      expect((yield* context.resolve()).sourceRevision).toBe('workspace');
    }),
  ),
);

live('runs a kept unit as the release it was built at once its receipt and keep proof prove the same sources', () =>
  run(
    Effect.gen(function* keptIdentity() {
      const context = yield* fixture;
      yield* context.build(OLD_REVISION);
      expect(yield* context.resolve()).toEqual({ buildMarker: markerAt(OLD_REVISION), sourceRevision: OLD_REVISION });
    }),
  ),
);

live('tells a developer with a stale local build exactly what to rebuild or delete', () =>
  run(
    Effect.gen(function* staleLocalBuild() {
      const context = yield* fixture;
      yield* context.build(OLD_REVISION, { proof: false, withReceipt: false });
      const reason = yield* context.refusal();
      expect(reason).toContain(`built at ${OLD_REVISION}, not at this checkout (${context.head})`);
      expect(reason).toContain(`rebuild the unit, or delete ${path.join(context.workspaceRoot, SHELL, 'dist')}`);
    }),
  ),
);

live('never takes the revision from the environment alone', () =>
  run(
    Effect.gen(function* environmentRevision() {
      const context = yield* fixture;
      yield* context.build(OLD_REVISION);
      // UltraModern refuses a configured revision that is not the clean HEAD.
      expect(yield* context.refusal({ ULTRAMODERN_SOURCE_REVISION: OLD_REVISION })).not.toBe('accepted');
      // Without Git the configured revision is all UltraModern has; the kept identity still needs a Git HEAD.
      const exported = yield* context.fs.makeTempDirectoryScoped();
      yield* context.fs.copy(path.join(context.workspaceRoot, SHELL), path.join(exported, SHELL));
      expect(yield* context.refusal({ ULTRAMODERN_SOURCE_REVISION: OLD_REVISION }, exported)).toContain('no Git HEAD');
      // A configured value UltraModern cannot accept at all: the framework call itself fails.
      expect(yield* context.refusal({ ULTRAMODERN_SOURCE_REVISION: 'not-a-revision' }, exported)).toContain(
        'no release identity from the checkout',
      );
    }),
  ),
);

const refusals: readonly {
  readonly change: string;
  readonly expected: string;
  readonly setup: (context: Effect.Success<typeof fixture>) => Effect.Effect<unknown, unknown, FileSystem.FileSystem>;
}[] = [
  {
    change: 'undecodable build metadata',
    expected: 'is not a build identity',
    setup: (context) => context.write(`app/${SHELL}/${METADATA}`, '{"deliveryUnit":'),
  },
  {
    change: 'unreadable build metadata',
    expected: 'cannot be read',
    setup: (context) =>
      context.fs
        .remove(path.join(context.workspaceRoot, SHELL, METADATA))
        .pipe(Effect.andThen(context.fs.makeDirectory(path.join(context.workspaceRoot, SHELL, METADATA)))),
  },
  {
    change: 'a revision that is no full commit hash',
    expected: 'no full commit hash',
    setup: (context) => context.build('abc1234'),
  },
  {
    change: 'an unreadable receipt',
    expected: RECEIPT_UNREADABLE,
    setup: (context) => context.write(`app/${SHELL}/${RECEIPT}`, 'not json'),
  },
  {
    change: 'a version 1 receipt',
    expected: RECEIPT_UNREADABLE,
    setup: (context) =>
      context.write(
        `app/${SHELL}/${RECEIPT}`,
        JSON.stringify({ digest: 'd'.repeat(64), files: [], identity: {}, schemaVersion: 1, unit: APP_ID }),
      ),
  },
  {
    change: "the receipt's unit",
    expected: NOT_THIS_BUILD,
    setup: (context) => context.build(OLD_REVISION, { receipt: { unit: 'crm' } }),
  },
  {
    change: "the receipt identity's app",
    expected: NOT_THIS_BUILD,
    setup: (context) => context.build(OLD_REVISION, { receiptIdentity: { appId: 'crm' } }),
  },
  {
    change: "the receipt identity's marker",
    expected: NOT_THIS_BUILD,
    setup: (context) => context.build(OLD_REVISION, { receiptIdentity: { buildMarker: 'e'.repeat(64) } }),
  },
  {
    change: "the receipt identity's revision",
    expected: NOT_THIS_BUILD,
    setup: (context) => context.build(OLD_REVISION, { receiptIdentity: { sourceRevision: OTHER_REVISION } }),
  },
  {
    change: 'the metadata bytes the receipt inventoried',
    expected: NOT_THIS_BUILD,
    setup: (context) =>
      context.build(OLD_REVISION, { receipt: { files: [{ mode: 0o644, path: METADATA, sha256: INPUTS, size: 1 }] } }),
  },
  {
    change: "a marker that is not this unit's",
    expected: "not this unit's marker",
    setup: (context) => context.build(OLD_REVISION, { marker: 'e'.repeat(64) }),
  },
  {
    change: 'no keep proof',
    expected: 'no gates plan kept it',
    setup: (context) => context.fs.remove(path.join(context.workspaceRoot, SHELL, KEEP_PROOF)),
  },
  {
    change: 'a corrupt keep proof',
    expected: 'keep proof cannot be read',
    setup: (context) =>
      context.build(OLD_REVISION).pipe(Effect.andThen(context.write(`app/${SHELL}/${KEEP_PROOF}`, '{'))),
  },
  {
    change: 'a keep proof for another HEAD',
    expected: OTHER_SOURCES,
    setup: (context) => context.build(OLD_REVISION, { proof: { revision: OTHER_REVISION } }),
  },
  {
    change: 'a keep proof for other inputs',
    expected: OTHER_SOURCES,
    setup: (context) => context.build(OLD_REVISION, { proof: { inputs: 'f'.repeat(64) } }),
  },
  {
    change: 'a keep proof for another unit',
    expected: OTHER_SOURCES,
    setup: (context) => context.build(OLD_REVISION, { proof: { unit: 'crm' } }),
  },
];
for (const { change, expected, setup } of refusals) {
  live(`refuses a kept unit with ${change}`, () =>
    run(
      Effect.gen(function* refused() {
        const context = yield* fixture;
        yield* context.build(OLD_REVISION);
        yield* setup(context);
        expect(yield* context.refusal()).toContain(expected);
      }),
    ),
  );
}

live('reads a built document only as the bytes its receipt inventoried', () =>
  run(
    Effect.gen(function* builtDocument() {
      const context = yield* fixture;
      const read = () =>
        readBuiltDocument({ document: CONTRACT, unitDirectory: SHELL, workspaceRoot: context.workspaceRoot });
      yield* context.build(OLD_REVISION, { proof: false, withReceipt: false });
      // A local build has no receipt: the document is read as it is.
      expect(yield* read()).toContain(APP_ID);
      yield* context.build(OLD_REVISION);
      expect(yield* read()).toContain(APP_ID);
      // A document rewritten after the shard verified the unit is refused.
      yield* context.write(`app/${SHELL}/${CONTRACT}`, '{"deployment":{"appId":"rewritten"}}');
      expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
    }),
  ),
);

live('the keep proof schema accepts only what the gates plan writes', () =>
  run(
    Effect.gen(function* proofSchema() {
      const decode = Schema.decodeUnknownExit(KeepProofSchema);
      expect(Exit.isSuccess(decode({ inputs: INPUTS, revision: OLD_REVISION, schemaVersion: 1, unit: APP_ID }))).toBe(
        true,
      );
      expect(Exit.isFailure(decode({ inputs: 'short', revision: OLD_REVISION, schemaVersion: 1, unit: APP_ID }))).toBe(
        true,
      );
      expect(Exit.isFailure(Schema.decodeUnknownExit(CacheReceiptSchema)({ schemaVersion: 1 }))).toBe(true);
      return yield* Effect.void;
    }),
  ),
);

/** A spawner that cannot start anything: Git is not installed. */
const noGit = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.fail(PlatformError.systemError({ _tag: 'NotFound', method: 'spawn', module: 'ChildProcess' })),
  ),
);

live('refuses a built unit when Git cannot be run', () =>
  run(
    Effect.gen(function* gitUnavailable() {
      const context = yield* fixture;
      yield* context.build(OLD_REVISION);
      const reason = yield* context.refusal().pipe(Effect.provide(noGit));
      expect(reason).toContain('Git cannot be run');
    }),
  ),
);

live('refuses a built document that cannot be read, has no readable receipt, or is not in its inventory', () =>
  run(
    Effect.gen(function* builtDocumentRefusals() {
      const context = yield* fixture;
      const read = (document = CONTRACT) =>
        readBuiltDocument({ document, unitDirectory: SHELL, workspaceRoot: context.workspaceRoot }).pipe(
          Effect.match({ onFailure: (error) => error.reason, onSuccess: () => 'accepted' }),
        );
      yield* context.build(OLD_REVISION);
      expect(yield* read('dist/public/missing.json')).toContain('cannot be read');
      // A document on disk that the receipt never inventoried, as opposed to one with other bytes.
      yield* context.write(`app/${SHELL}/dist/public/extra.json`, '{}');
      expect(yield* read('dist/public/extra.json')).toContain('is not the document its build verified');
      yield* context.write(`app/${SHELL}/${RECEIPT}`, 'not json');
      expect(yield* read()).toContain(RECEIPT_UNREADABLE);
      yield* context.write(
        `app/${SHELL}/${RECEIPT}`,
        JSON.stringify({ digest: 'd'.repeat(64), files: [], identity: {}, schemaVersion: 1, unit: APP_ID }),
      );
      expect(yield* read()).toContain(RECEIPT_UNREADABLE);
    }),
  ),
);
