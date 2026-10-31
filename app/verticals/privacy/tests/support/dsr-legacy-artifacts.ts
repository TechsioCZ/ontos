// TEST infrastructure only. Preparation never opens a database or starts an owner.
// The old owner is the pre-#1271 Privacy producer: the pinned merge-base product files substituted into the
// current workspace and dependencies. It proves a historical producer's records against the current consumer,
// not compatibility with a complete historical runtime, deployment contract or migration level.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Array as EffectArray, Clock, Effect, FileSystem, Order, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';

const appRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const privacyRoot = path.join(appRoot, 'verticals/privacy');
const fixtureRoot = path.join(privacyRoot, 'tests/fixtures/pre-1271');
const historicalCommit = 'ed7ecb1fcf395ccfbffab7c2bff3edf0c0c15a2f';
const historicalPaths = [
  'shared/actions/privacy-operations.ts',
  'shared/domain/privacy-dsr.ts',
  'shared/privacy-queries.ts',
  // Keep the historical repository's caller from importing the current prepared-subject constructor.
  'src/actions/create-privacy-subject.action.ts',
  'src/actions/record-dsr-deadline.action.ts',
  'src/actions/dispatch-privacy-measure.action.ts',
  'src/persistence/privacy-operation-postgres-repository.ts',
  'src/persistence/privacy-operation-repository.ts',
].map((relative) => `app/verticals/privacy/${relative}`);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
class DsrLegacyArtifactFailure extends Schema.TaggedError<DsrLegacyArtifactFailure>()('DsrLegacyArtifactFailure', {
  reason: Schema.String,
}) {}
const failure = (reason: string) => new DsrLegacyArtifactFailure({ reason });
const pinSchema = Schema.Struct({ path: Schema.String, sha256: Schema.String });
const manifestSchema = Schema.Struct({
  commit: Schema.Literal(historicalCommit),
  files: Schema.Array(pinSchema),
});
const receiptSchema = Schema.Struct({
  buildMarker: Schema.String,
  bundleSha256: Schema.String,
  generation: Schema.Literals(['old', 'current']),
  inputs: Schema.Array(pinSchema),
  manifestSha256: Schema.String,
  metafileSha256: Schema.String,
  nodeSha256: Schema.String,
  nodeVersion: Schema.String,
});
const metafileSchema = Schema.Struct({ inputs: Schema.Record(Schema.String, Schema.Unknown) });

export const verifyDsrLegacyPreimage = Effect.fn('DsrLegacyArtifact.verifyPreimage')(function* verifyPreimage(
  bytes: Uint8Array,
  expectedSha256: string,
  history?: Uint8Array,
) {
  if (hash(bytes) !== expectedSha256) {
    return yield* failure('Historical fixture SHA-256 mismatch');
  }
  if (history !== undefined && !Buffer.from(bytes).equals(Buffer.from(history))) {
    return yield* failure('Historical fixture differs from the pinned Git blob');
  }
  return yield* Effect.void;
});
const git = Effect.fn('DsrLegacyArtifact.git')(function* git(args: readonly string[]) {
  const child = yield* ChildProcess.make('git', args, { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' });
  const [code, stdout] = yield* Effect.all(
    [child.exitCode, Stream.runCollect(child.stdout), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  return { bytes: Buffer.concat([...stdout]), code };
}, Effect.scoped);
const readPrivate = Effect.fn('DsrLegacyArtifact.readPrivate')(function* readPrivate(file: string) {
  const filesystem = yield* FileSystem.FileSystem;
  if ((yield* filesystem.realPath(file)) !== path.resolve(file) || (yield* filesystem.stat(file)).type !== 'File') {
    return yield* failure('Artifact input is not a regular canonical file');
  }
  return yield* filesystem.readFile(file);
});
const readSources = Effect.fn('DsrLegacyArtifact.readSources')(function* readSources() {
  const manifestBytes = yield* readPrivate(path.join(fixtureRoot, 'manifest.json'));
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(manifestSchema))(
    new TextDecoder().decode(manifestBytes),
  );
  if (
    manifest.files.length !== historicalPaths.length ||
    new Set(manifest.files.map((entry) => entry.path)).size !== historicalPaths.length ||
    manifest.files.some((entry) => !historicalPaths.includes(entry.path))
  ) {
    return yield* failure('Historical fixture manifest must name exactly the pinned owner substitutions');
  }
  const historyAvailable = (yield* git(['cat-file', '-e', `${historicalCommit}^{commit}`])).code === 0;
  const sources = new Map<string, Uint8Array>();
  for (const pin of manifest.files) {
    const relative = path.relative('app/verticals/privacy', pin.path);
    const bytes = yield* readPrivate(path.join(fixtureRoot, `${relative}.fixture`));
    let history: Uint8Array | undefined;
    if (historyAvailable) {
      const blob = yield* git(['show', `${historicalCommit}:${pin.path}`]);
      if (blob.code !== 0) {
        return yield* failure(`Cannot read pinned Git blob: ${pin.path}`);
      }
      history = blob.bytes;
    }
    yield* verifyDsrLegacyPreimage(bytes, pin.sha256, history);
    sources.set(path.resolve(appRoot, '..', pin.path), bytes);
  }
  return { manifestSha256: hash(manifestBytes), sources };
});

export interface DsrLegacyOwnerArtifact {
  readonly buildMarker: string;
  readonly bundlePath: string;
  readonly generation: 'old' | 'current';
  readonly nodeExecutable: string;
  readonly receiptSha256: string;
  readonly root: string;
  readonly staged: string;
}
const sourcePins = Effect.fn('DsrLegacyArtifact.sourcePins')(function* sourcePins(
  metafilePath: string,
  generation: 'old' | 'current',
  sources: ReadonlyMap<string, Uint8Array>,
) {
  const metafile = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(metafileSchema))(
    new TextDecoder().decode(yield* readPrivate(metafilePath)),
  );
  const pins: (typeof pinSchema.Type)[] = [];
  const inputs = new Set<string>();
  for (const relative of EffectArray.sort(Object.keys(metafile.inputs), Order.String)) {
    const absolute = path.resolve(appRoot, relative);
    if (
      !absolute.startsWith(`${appRoot}${path.sep}`) ||
      absolute.startsWith(`${fixtureRoot}${path.sep}`) ||
      relative.includes('/tests/unit/')
    ) {
      return yield* failure('Unexpected owner bundle input');
    }
    inputs.add(absolute);
    const historical = generation === 'old' ? sources.get(absolute) : undefined;
    pins.push({ path: relative, sha256: hash(historical ?? (yield* readPrivate(absolute))) });
  }
  if ([...sources.keys()].some((absolute) => !inputs.has(absolute))) {
    return yield* failure('An exact historical owner substitution is missing from the bundle metafile');
  }
  pins.push({ path: 'pnpm-lock.yaml', sha256: hash(yield* readPrivate(path.join(appRoot, 'pnpm-lock.yaml'))) });
  return pins;
});
export const verifyDsrOwnerLaunchIdentity = Effect.fn('DsrLegacyArtifact.verifyOwnerLaunch')(
  function* verifyOwnerLaunch(artifact: DsrLegacyOwnerArtifact) {
    const receiptBytes = yield* readPrivate(path.join(artifact.root, 'artifact.json'));
    const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(receiptSchema))(
      new TextDecoder().decode(receiptBytes),
    );
    const { manifestSha256, sources } = yield* readSources();
    const metafilePath = path.join(artifact.root, 'owner.meta.json');
    const pins = yield* sourcePins(metafilePath, artifact.generation, sources);
    if (
      hash(receiptBytes) !== artifact.receiptSha256 ||
      receipt.generation !== artifact.generation ||
      receipt.buildMarker !== artifact.buildMarker ||
      receipt.manifestSha256 !== manifestSha256 ||
      receipt.bundleSha256 !== hash(yield* readPrivate(artifact.bundlePath)) ||
      receipt.metafileSha256 !== hash(yield* readPrivate(metafilePath)) ||
      receipt.nodeSha256 !== hash(yield* readPrivate(process.execPath)) ||
      receipt.nodeVersion !== process.version ||
      artifact.nodeExecutable !== process.execPath ||
      !Schema.toEquivalence(Schema.Array(pinSchema))(receipt.inputs, pins)
    ) {
      return yield* failure('Per-run owner bundle, source, metafile or Node identity mismatch');
    }
    return yield* Effect.void;
  },
);

export const prepareDsrLegacyArtifacts = Effect.fn('DsrLegacyArtifact.prepare')(function* prepare() {
  const startedAt = yield* Clock.currentTimeMillis;
  const filesystem = yield* FileSystem.FileSystem;
  const { manifestSha256, sources } = yield* readSources();
  // Scoped outputs are always cold and removed on setup failure, test failure and success.
  const root = yield* filesystem.makeTempDirectoryScoped({
    directory: path.join(privacyRoot, 'node_modules'),
    prefix: '.1271-owner-',
  });
  yield* filesystem.chmod(root, 0o700);
  const artifacts: DsrLegacyOwnerArtifact[] = [];
  for (const generation of ['old', 'current'] as const) {
    const output = path.join(root, generation);
    yield* filesystem.makeDirectory(output, { mode: 0o700 });
    const buildMarker = hash(`${root}:${generation}:${manifestSha256}`).slice(0, 16);
    const bundlePath = path.join(output, 'owner.mjs');
    const substituted = new Set<string>();
    const result = yield* Effect.tryPromise({
      catch: (cause) => failure(`Owner bundle build failed: ${String(cause)}`),
      try: async () =>
        await build({
          absWorkingDir: appRoot,
          bundle: true,
          define: {
            ULTRAMODERN_BUILD_MARKER: JSON.stringify(buildMarker),
            ULTRAMODERN_SOURCE_REVISION: '"workspace"',
          },
          entryPoints: ['verticals/privacy/tests/support/dsr-legacy-owner.fixture.ts'],
          format: 'esm',
          logLevel: 'silent',
          metafile: true,
          outfile: bundlePath,
          packages: 'external',
          platform: 'node',
          plugins:
            generation === 'old'
              ? [
                  {
                    name: 'pinned-pre-1271-owner',
                    setup(builder) {
                      // esbuild uses Go regexps, which do not accept JavaScript's Unicode flag.
                      const tsFilter = /\.ts$/u;
                      builder.onLoad(
                        { filter: new RegExp(tsFilter.source, tsFilter.flags.replace('u', '')) },
                        (args) => {
                          const historical = sources.get(args.path);
                          if (historical !== undefined) {
                            substituted.add(args.path);
                          }
                          return historical === undefined
                            ? undefined
                            : { contents: historical, loader: 'ts', resolveDir: path.dirname(args.path) };
                        },
                      );
                    },
                  },
                ]
              : [],
        }),
    });
    if (
      result.metafile === undefined ||
      (generation === 'old' &&
        (substituted.size !== sources.size || [...sources.keys()].some((file) => !substituted.has(file))))
    ) {
      return yield* failure('The old owner must substitute exactly all pinned files');
    }
    const metafilePath = path.join(output, 'owner.meta.json');
    yield* filesystem.writeFileString(metafilePath, JSON.stringify(result.metafile), { flag: 'wx', mode: 0o600 });
    const receipt = {
      buildMarker,
      bundleSha256: hash(yield* readPrivate(bundlePath)),
      generation,
      inputs: yield* sourcePins(metafilePath, generation, sources),
      manifestSha256,
      metafileSha256: hash(yield* readPrivate(metafilePath)),
      nodeSha256: hash(yield* readPrivate(process.execPath)),
      nodeVersion: process.version,
    };
    const receiptText = JSON.stringify(receipt);
    yield* filesystem.writeFileString(path.join(output, 'artifact.json'), receiptText, {
      flag: 'wx',
      mode: 0o600,
    });
    const artifact = {
      buildMarker,
      bundlePath,
      generation,
      nodeExecutable: process.execPath,
      receiptSha256: hash(receiptText),
      root: output,
      staged: appRoot,
    };
    yield* verifyDsrOwnerLaunchIdentity(artifact);
    artifacts.push(artifact);
  }
  const [old, current] = artifacts;
  if (old === undefined || current === undefined || old.buildMarker === current.buildMarker) {
    return yield* failure('Distinct old and current native owner identities are required');
  }
  yield* Effect.addFinalizer(() =>
    Effect.all(artifacts.map((artifact) => verifyDsrOwnerLaunchIdentity(artifact))).pipe(
      Effect.scoped,
      Effect.orDie,
      Effect.asVoid,
    ),
  );
  yield* Effect.logInfo(`1271 cold owner preparation: ${(yield* Clock.currentTimeMillis) - startedAt}ms`);
  return { current, old };
});
