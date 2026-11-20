import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { OntosShellRuntimeContractSchema } from '../../packages/core-runtime/src/index.ts';
import {
  committedInputs,
  expectedDigest,
  gatesDigestSalt,
  inventory,
  loadCacheContext,
  planUnits,
} from '../ci/unit-output-cache.mts';
import {
  CacheReceiptSchema,
  KEEP_PROOF,
  KeepProofSchema,
  RECEIPT,
  RECEIPT_SCHEMA_VERSION,
} from '../ci/unit-output-receipt.mts';
import { createShellRuntimeContract } from '../ontos-shell-runtime-contract.ts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const SHELL = 'apps/shell-super-app';
const APP_ID = 'shell-super-app';
const OLD_REVISION = 'a'.repeat(40);
const MARKER = 'e'.repeat(64);
const EMPTY_MODULE = 'export {};';
const SOURCE = `app/${SHELL}/src/index.ts`;
/** The trunk's post-build script and the entry it writes into a served unit's dist. */
const POST_BUILD = 'scripts/serve-entry.mts';
const SERVED_ENTRY = 'dist/served-entry.mjs';
const POLICY = { originVariables: ['ONTOS_PUBLIC_ORIGIN'], postBuild: POST_BUILD, servedEntry: SERVED_ENTRY };
/** A committed workspace with one api-only Shell; its built outputs and caches are ignored, as in the real checkout. */
const COMMITTED = {
  '.gitignore': 'dist/\n.output/\nnode_modules/\n',
  [`app/${POST_BUILD}`]: 'export const entry = 1;\n',
  'app/apps/shell-super-app/package.json': JSON.stringify({ name: '@app/shell-super-app', scripts: { build: 'x' } }),
  'app/apps/shell-super-app/src/index.ts': 'export const shell = 1;\n',
  'app/pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
  'app/scripts/ci/build-units.sh': 'echo build\n',
  'app/topology/application-release-intent.json': JSON.stringify({ modules: [] }),
  'app/topology/reference-topology.json': JSON.stringify({
    shell: { id: APP_ID, path: SHELL, surfaceProfile: 'api-only' },
    verticals: [],
  }),
} satisfies Readonly<Record<string, string>>;

const fixture = Effect.gen(function* planFixture() {
  const fs = yield* FileSystem.FileSystem;
  const repository = yield* fs.makeTempDirectoryScoped();
  const root = path.join(repository, 'app');
  const unitRoot = path.join(root, SHELL);
  const write = (file: string, content: string) =>
    fs
      .makeDirectory(path.dirname(path.join(repository, file)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(repository, file), content)));
  const git = (args: readonly string[]) => collectToolingProcess(ChildProcess.make('git', ['-C', repository, ...args]));
  const commit = (message: string) =>
    git(['add', '-A']).pipe(
      Effect.andThen(git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message])),
    );
  for (const [file, content] of Object.entries(COMMITTED)) {
    yield* write(file, content);
  }
  yield* git(['init', '-q']);
  yield* commit('fixture');
  /** The Shell's outputs as an earlier commit built them, stamped as the shard stamps a fresh build. */
  const keptBuild = Effect.gen(function* writeKeptBuild() {
    const identity = { appId: APP_ID, build: MARKER, buildMarker: MARKER, sourceRevision: OLD_REVISION };
    const metadata = JSON.stringify({
      deliveryUnit: identity,
      kind: 'ultramodern-build-artifact',
      schemaVersion: 2,
      surfaces: { api: identity },
    });
    const contract = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
      createShellRuntimeContract(MARKER),
    );
    for (const [file, content] of [
      ['dist/ultramodern-build.json', metadata],
      ['.output/ultramodern-build.json', metadata],
      ['dist/api/index.js', EMPTY_MODULE],
      [SERVED_ENTRY, EMPTY_MODULE],
      ['dist/public/.well-known/ontos-shell-runtime.json', contract],
      ['.output/index.js', EMPTY_MODULE],
      ['.output/package.json', '{}'],
    ] as const) {
      yield* write(`app/${SHELL}/${file}`, content);
    }
    const context = yield* loadCacheContext(root, POLICY);
    const [unit] = context.units;
    if (unit === undefined) {
      return yield* Effect.die('the fixture topology names the Shell');
    }
    // The receipt is the stamp's, written after the outputs.
    const receipt = yield* Schema.encodeEffect(Schema.fromJsonString(CacheReceiptSchema))({
      digest: yield* expectedDigest(context, unit),
      files: yield* inventory(unitRoot),
      identity,
      inputs: yield* committedInputs(context.graph, context.driver, SHELL),
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      unit: APP_ID,
    });
    return yield* write(`app/${SHELL}/${RECEIPT}`, receipt);
  });
  const plan = () =>
    loadCacheContext(root, POLICY).pipe(Effect.flatMap((context) => planUnits(context, context.units)));
  return { commit, fs, git, keptBuild, plan, unitRoot, write };
});

it.effect(
  'keeps an unchanged unit with a keep proof for this HEAD, and drops the proof once its inputs change',
  () =>
    Effect.gen(function* planEndToEnd() {
      const context = yield* fixture;
      yield* context.keptBuild;
      expect(yield* context.plan()).toEqual({ build: [], keep: [APP_ID], reasons: [] });
      const head = (yield* context.git(['rev-parse', 'HEAD'])).stdout.trim();
      const proof = yield* context.fs
        .readFileString(path.join(context.unitRoot, KEEP_PROOF))
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(KeepProofSchema))));
      const receipt = yield* context.fs
        .readFileString(path.join(context.unitRoot, RECEIPT))
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(CacheReceiptSchema))));
      expect(proof).toEqual({ inputs: receipt.inputs, revision: head, schemaVersion: 1, unit: APP_ID });
      // A source change: the unit is no longer kept, and the proof it carried is gone before the outputs are.
      yield* context.write(SOURCE, 'export const shell = 2;\n');
      yield* context.commit('change');
      // The plan says why, so the job log of a cold shard names the mismatch of every rebuilt unit.
      expect(yield* context.plan()).toEqual({
        build: [APP_ID],
        keep: [],
        reasons: [{ reason: `${APP_ID}: input digest mismatch (target, origins, toolchain or sources)`, unit: APP_ID }],
      });
      expect(yield* context.fs.exists(path.join(context.unitRoot, KEEP_PROOF))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  'rebuilds a kept unit once the post-build script that wrote its served entry changes',
  () =>
    Effect.gen(function* postBuildChange() {
      const context = yield* fixture;
      yield* context.keptBuild;
      expect(yield* context.plan()).toEqual({ build: [], keep: [APP_ID], reasons: [] });
      yield* context.write(`app/${POST_BUILD}`, 'export const entry = 2;\n');
      yield* context.commit('post-build');
      expect(yield* context.plan()).toEqual({
        build: [APP_ID],
        keep: [],
        reasons: [{ reason: `${APP_ID}: input digest mismatch (target, origins, toolchain or sources)`, unit: APP_ID }],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);

it('salts every gates cache digest with the receipt format, so a new format names new cache keys', () => {
  expect(CacheReceiptSchema.fields.schemaVersion.literal).toBe(RECEIPT_SCHEMA_VERSION);
  expect(gatesDigestSalt).toBe(`gates-output-receipt-v${RECEIPT_SCHEMA_VERSION}`);
});
