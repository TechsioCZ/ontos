#!/usr/bin/env node
/**
 * Gates-only cache v1. Archive the unit directories' dist/ and .output/ verbatim, including
 * dist/.gates-output-cache.json (digest + original identity + complete byte/mode inventory).
 * Never share zerops-units archives: stage origins, missing packaged outputs, different flags.
 *
 * Actions key: gates-units-v1-${runner.os}-${runner.arch}-${shard}-${github.sha}-${github.run_id}-${github.run_attempt}
 * restore-keys: gates-units-v1-${runner.os}-${runner.arch}-${shard}-
 * Use exactly the same ordered path list for restore/save; bump v1 when changing that list.
 * Main push runs must populate this cache even when queue-proof skips other gates. A candidate/*
 * PR can restore its base/default main cache; a candidate push can restore default main, NOT an
 * unrelated feature branch. Save only after verify, never on failure. The key is a locator, NOT
 * evidence: every unit is validated independently after fallback restoration.
 *
 * USAGE (bash; app/ cwd; SHARD_UNITS = matrix.units, the existing space-separated paths):
 * job env: MODERN_PUBLIC_SITE_URL=http://localhost:8080, ULTRAMODERN_SOURCE_REVISION=${github.sha}
 * 1. actions/cache/restore@v6, id: unit-cache, with:
 *      path: |  # expand matrix.units to explicit paths, EACH with BOTH suffixes
 *        app/apps/shell-super-app/dist
 *        app/apps/shell-super-app/.output
 *        app/verticals/<each-shard-unit>/dist
 *        app/verticals/<each-shard-unit>/.output
 *      key: gates-units-v1-${{ runner.os }}-${{ runner.arch }}-${{ matrix.shard }}-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}
 *      restore-keys: gates-units-v1-${{ runner.os }}-${{ runner.arch }}-${{ matrix.shard }}-
 * 2. id: cached-plan; run:
 *      mise exec -- node scripts/ci/unit-output-cache.mts plan --units "$SHARD_UNITS" >> "$GITHUB_OUTPUT"
 *    # prints keep=<space-separated appIds> and build=<space-separated appIds>.
 *    # A bad restore goes to build, not to verify; verify the final complete shard below.
 * 3. env BUILD_UNITS: ${{ steps.cached-plan.outputs.build }}; run:
 *      if [[ -n "$BUILD_UNITS" ]]; then
 *        mise exec -- pnpm exec ultramodern-create ultramodern typecheck --build packages/shared-contracts/tsconfig.json
 *        mise exec -- pnpm exec ultramodern-create ultramodern typecheck --build packages/shared-design-tokens/tsconfig.json
 *        for id in $BUILD_UNITS; do
 *          dir="verticals/$id"; [[ "$id" != shell-super-app ]] || dir=apps/shell-super-app
 *          rm -rf -- "$dir/dist" "$dir/.output" # clean ONLY selected rebuild outputs
 *          mise exec -- pnpm --filter "./$dir" run build
 *          # Keep the existing served-unit selection: generate owner-entry ONLY for released units.
 *          if [[ "$id" == shell-super-app ]] || jq -e --arg id "$id" '.modules | any(.appId == $id)' topology/application-release-intent.json >/dev/null; then
 *            mise exec -- node scripts/zerops/owner-entry.mts "$dir"
 *          fi
 *          mise exec -- node scripts/ci/unit-output-cache.mts stamp --unit "$id"
 *        done
 *      fi
 * 4. mise exec -- node scripts/ci/unit-output-cache.mts verify --units "$SHARD_UNITS"
 * 5. actions/cache/save@v6: same path list; key: ${{ steps.unit-cache.outputs.cache-primary-key }}
 * 6. Keep existing tar/upload/unpack/proof steps. No identity rewriting, including on keep.
 *
 * Digest inputs, exactly: deploy v2's committed Git paths/modes/blob IDs for the transitive
 * workspace closure, common/unknown tooling, shared packages/paths and three public origins;
 * plus all reference-topology units (not just release intent); Node target, package build command,
 * production/default build mode, map/type-bundle policy and owner-entry policy; effective public
 * build environment (MODERN_*, ULTRAMODERN_*, PUBLIC_*, ONTOS_*ORIGIN*, NODE_ENV, NODE_OPTIONS,
 * NODE_PATH, BABEL_ENV, RSPACK_*, RSBUILD_*, BROWSERSLIST*, TZ, LANG, LC_*, SOURCE_DATE_EPOCH
 * and CI); actual Node/component versions, pnpm, platform and architecture.
 * Lockfile, mise pins, scripts and workflow are already common committed deploy inputs. Actual
 * versions additionally prevent a runner/toolchain mismatch despite unchanged pins. Source SHA
 * and build-marker overrides are deliberately NOT digest inputs: unchanged units keep their OLD
 * source/build identity. Stamp requires freshly built metadata naming HEAD; never restamp a keep.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { Config, Console, Effect, FileSystem, Schema, Stream } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
} from '../../packages/core-runtime/src/index.ts';
import { runQualityCli } from '../quality-cli-lifecycle.mts';
import { readWorkspace } from '../zerops/delivery-plan-cli.mts';
import { unitInputDigest } from '../zerops/delivery-plan.mts';
import type { DeliveryUnit, GitEntry, WorkspacePackage } from '../zerops/delivery-plan.mts';

const APP_ROOT = path.resolve(import.meta.dirname, '../..');
const RECEIPT = 'dist/.gates-output-cache.json';
const BUILD_METADATA = 'ultramodern-build.json';
const SHELL = 'shell-super-app';
const DIST = 'dist';
const OUTPUT = '.output';
const WORKSPACE = 'workspace';
const BACKEND_MANIFEST = 'backend-mf-manifest.json';
const PACKAGE_JSON = 'package.json';
const OUTPUT_ROOTS = [DIST, OUTPUT];
const DIGEST = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const NONEMPTY = Schema.String.check(Schema.isMinLength(1));
const REVISION = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const UnitSchema = Schema.Struct({
  id: NONEMPTY,
  path: Schema.String.check(Schema.isPattern(/^(?:apps|verticals)\/[a-z0-9-]+$/u)),
  surfaceProfile: Schema.optionalKey(Schema.String),
});
const TopologySchema = Schema.Struct({ shell: UnitSchema, verticals: Schema.Array(UnitSchema) });
export type CacheUnit = typeof UnitSchema.Type;
const IdentitySchema = Schema.Struct({
  appId: NONEMPTY.pipe(Schema.brand('UnitOutputAppId'), Schema.decodeTo(Schema.String)),
  build: NONEMPTY,
  buildMarker: NONEMPTY,
  sourceRevision: REVISION,
});
export type CacheIdentity = typeof IdentitySchema.Type;
const MetadataSchema = Schema.Struct({
  deliveryUnit: IdentitySchema,
  kind: Schema.Literal('ultramodern-build-artifact'),
  schemaVersion: Schema.Literal(2),
  surfaces: Schema.Struct({ api: IdentitySchema, ui: Schema.optionalKey(IdentitySchema) }),
});
export const CacheProfileSchema = Schema.Struct({
  architecture: NONEMPTY,
  command: NONEMPTY,
  environment: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  mode: NONEMPTY,
  node: NONEMPTY,
  platform: NONEMPTY,
  pnpm: NONEMPTY,
  policy: NONEMPTY,
  target: NONEMPTY,
  versions: Schema.Record(Schema.String, Schema.String),
});
export type CacheProfile = typeof CacheProfileSchema.Type;
export const OutputFileSchema = Schema.Struct({
  /** A relative symlink's target, kept as a link: its sha256 and size describe the target text. */
  link: Schema.optionalKey(NONEMPTY),
  mode: Schema.Number,
  path: NONEMPTY,
  sha256: DIGEST,
  size: Schema.Number,
});
export type OutputFile = typeof OutputFileSchema.Type;
export const CacheReceiptSchema = Schema.Struct({
  digest: DIGEST,
  files: Schema.Array(OutputFileSchema),
  identity: IdentitySchema,
  schemaVersion: Schema.Literal(1),
  unit: NONEMPTY,
});
export type CacheReceipt = typeof CacheReceiptSchema.Type;
/** A Modern.js route document: this check owns only that it is a parsed JSON object, not its route model. */
const RouteDocument = Schema.Record(Schema.String, Schema.Unknown);
const PlainSourceMapSchema = Schema.Struct({
  mappings: Schema.String,
  names: Schema.Array(Schema.String),
  sources: Schema.Array(Schema.String),
  version: Schema.Literal(3),
});
const SourceMapSchema = Schema.Union([
  PlainSourceMapSchema,
  Schema.Struct({
    sections: Schema.Array(
      Schema.Struct({
        map: PlainSourceMapSchema,
        offset: Schema.Struct({ column: Schema.Number, line: Schema.Number }),
      }),
    ),
    version: Schema.Literal(3),
  }),
]);
const PackageManifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  type: Schema.optionalKey(Schema.Literals(['module', 'commonjs'])),
});
const FederationManifest = Schema.Struct({
  exposes: Schema.Array(Schema.Unknown),
  metaData: Schema.Struct({ name: NONEMPTY }),
  name: NONEMPTY,
});
const BackendManifest = Schema.Struct({ backendFederation: Schema.Struct({ deliveryUnit: IdentitySchema }) });
const PlanSchema = Schema.Struct({ build: Schema.Array(Schema.String), keep: Schema.Array(Schema.String) });
export class UnitOutputCacheError extends Schema.TaggedError<UnitOutputCacheError>()('UnitOutputCacheError', {
  message: Schema.String,
  unit: Schema.String,
}) {}
const invalid = (unit: string, message: string) => new UnitOutputCacheError({ message: `${unit}: ${message}`, unit });
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = <A,>(schema: Schema.Codec<A>, value: A) => Schema.encodeEffect(Schema.fromJsonString(schema))(value);
const readJson = <A,>(filename: string, schema: Schema.Codec<A>) =>
  Effect.gen(function* decodeFile() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(filename).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))));
  });

interface DigestInput {
  readonly directory: string;
  readonly entries: readonly GitEntry[];
  readonly origins: readonly string[];
  readonly packages: readonly WorkspacePackage[];
  readonly profile: CacheProfile;
  readonly units: readonly DeliveryUnit[];
}
export const gatesInputDigest = (input: DigestInput) =>
  Effect.gen(function* computeGatesDigest() {
    const base = yield* unitInputDigest(input.directory, input.packages, input.units, input.entries, input.origins);
    const profile = yield* encode(CacheProfileSchema, input.profile);
    return yield* Effect.succeed(hash(`gates-output-v1\n${base}\n${profile}`));
  });

const run = (executable: string, args: readonly string[]) =>
  Effect.gen(function* captureCommand() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make(executable, args, { cwd: APP_ROOT }));
    const [text, stderr, code] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 'unbounded' },
    );
    if (Number(code) !== 0) {
      return yield* invalid(WORKSPACE, `${executable} ${args.join(' ')} failed: ${stderr}`);
    }
    return yield* Effect.succeed(text.trim());
  }).pipe(Effect.scoped);
const git = (args: readonly string[]) => run('git', args);
const identityOverride = /^(?:ULTRAMODERN_SOURCE_REVISION|ULTRAMODERN_BUILD_MARKER)$/u;
const buildVariable =
  /^(?:MODERN_|ULTRAMODERN_|PUBLIC_|ONTOS_.*ORIGIN|NODE_(?:ENV|OPTIONS|PATH)$|BABEL_ENV$|RSPACK_|RSBUILD_|BROWSERSLIST|TZ$|LANG$|LC_|SOURCE_DATE_EPOCH$|CI$)/u;
/** `name=value` pairs of the environment every build child inherits, NUL-separated so values may hold newlines. */
const inheritedEnvironment = run('env', ['-0']).pipe(
  Effect.map((listing) =>
    listing.split('\0').flatMap((pair): [string, string][] => {
      const separator = pair.indexOf('=');
      return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
    }),
  ),
);
const readProfile = Effect.gen(function* readBuildProfile() {
  const environment = (yield* inheritedEnvironment)
    .filter(([name]) => buildVariable.test(name) && !identityOverride.test(name))
    .toSorted(([left], [right]) => left.localeCompare(right));
  return yield* Schema.decodeUnknownEffect(CacheProfileSchema)({
    architecture: process.arch,
    command: 'pnpm run build (modern build + modern deploy --skip-build --deploy-target node)',
    environment,
    mode: yield* Config.String('NODE_ENV').pipe(Config.withDefault('production')),
    node: process.version,
    platform: process.platform,
    pnpm: yield* run('pnpm', ['--version']),
    policy: 'full dist + packaged .output; preserve maps/types; owner-entry for released units; v1',
    target: 'node',
    versions: process.versions,
  });
});
const loadContext = Effect.gen(function* readCacheContext() {
  const dirty = yield* git(['status', '--porcelain', '--untracked-files=normal']);
  if (dirty.length > 0) {
    return yield* invalid(WORKSPACE, 'committed inputs required; checkout has uncommitted changes');
  }
  const head = yield* git(['rev-parse', 'HEAD']);
  const workspace = yield* readWorkspace(head);
  const topology = yield* git(['show', `${head}:app/topology/reference-topology.json`]).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TopologySchema))),
  );
  const units = [topology.shell, ...topology.verticals];
  const origins = yield* Effect.forEach(
    ['ONTOS_PUBLIC_ORIGIN', 'ONTOS_STOREFRONT_ORIGIN', 'ONTOS_SHOP_STOREFRONT_ORIGIN'],
    (name) => Config.String(name).pipe(Config.withDefault('')),
    { concurrency: 1 },
  );
  return yield* Effect.succeed({
    ...workspace,
    head,
    origins,
    profile: yield* readProfile,
    served: workspace.units.map((unit) => unit.id),
    units,
  });
});
type Context = Effect.Success<typeof loadContext>;
const selectUnits = (context: Context, names: readonly string[]) =>
  Effect.forEach(
    names,
    (name) => {
      const unit = context.units.find((entry) => entry.id === name || entry.path === name);
      return unit === undefined ? Effect.fail(invalid(name, 'not a reference-topology unit')) : Effect.succeed(unit);
    },
    { concurrency: 1 },
  );
const expectedDigest = (context: Context, unit: CacheUnit) =>
  gatesInputDigest({
    ...context,
    directory: `app/${unit.path}`,
    units: context.units.map((entry) => ({ directory: `app/${entry.path}`, id: entry.id })),
  });

/**
 * A symlink is kept as a link when its target is relative and stays inside the output root it sits in: Modern.js
 * deploy links each npm alias in .output/node_modules to the package it names, and the packaged server needs those
 * links. A link that is absolute, leaves its output root or dangles fails, so no outside byte is ever trusted.
 */
const outputLink = (root: string, relative: string) =>
  Effect.gen(function* inventoryLink() {
    const fs = yield* FileSystem.FileSystem;
    const filename = path.join(root, relative);
    const target = yield* fs.readLink(filename);
    const outputRoot = path.join(root, relative.split('/')[0] ?? relative);
    const inside = path.relative(outputRoot, path.resolve(path.dirname(filename), target));
    if (path.isAbsolute(target) || inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
      return yield* invalid(root, `symlink at ${relative} leaves its output: ${target}`);
    }
    if (!(yield* fs.exists(filename))) {
      return yield* invalid(root, `dangling symlink at ${relative}: ${target}`);
    }
    const bytes = new TextEncoder().encode(target);
    return [{ link: target, mode: 0o777, path: relative, sha256: hash(bytes), size: bytes.byteLength }];
  });

/** Walk every byte, not just entrypoints. Keep in-output symlinks as links; reject escaping links and special files. */
const walkOutput = (
  root: string,
  relative: string,
): Effect.Effect<OutputFile[], PlatformError | UnitOutputCacheError, FileSystem.FileSystem> =>
  Effect.gen(function* inventoryOutput() {
    const fs = yield* FileSystem.FileSystem;
    const filename = path.join(root, relative);
    const info = yield* fs.lstat(filename);
    if (info.type === 'Directory') {
      const children = yield* Effect.forEach(
        (yield* fs.readDirectory(filename)).toSorted(),
        (name) => walkOutput(root, `${relative}/${name}`),
        { concurrency: 8 },
      );
      return yield* Effect.succeed(children.flat());
    }
    if (info.type === 'SymbolicLink') {
      return yield* outputLink(root, relative);
    }
    if (info.type !== 'File') {
      return yield* invalid(root, `unsupported output type at ${relative}: ${info.type}`);
    }
    if (relative === RECEIPT) {
      return yield* Effect.succeed([]);
    }
    const bytes = yield* fs.readFile(filename);
    return yield* Effect.succeed([
      { mode: info.mode % 0o1000, path: relative, sha256: hash(bytes), size: bytes.byteLength },
    ]);
  });
export const inventory = (root: string) =>
  Effect.forEach(OUTPUT_ROOTS, (directory) => walkOutput(root, directory), { concurrency: 1 }).pipe(
    Effect.map((files) => files.flat().toSorted((left, right) => left.path.localeCompare(right.path))),
  );
const sameIdentity = (left: CacheIdentity, right: CacheIdentity) =>
  left.appId === right.appId &&
  left.sourceRevision === right.sourceRevision &&
  left.build === right.build &&
  left.buildMarker === right.buildMarker;

/** Pure comparison used by both plan and verify. Return the first concrete mismatch. */
export const firstOutputMismatch = (input: {
  readonly digest: string;
  readonly files: readonly OutputFile[];
  readonly identity: CacheIdentity;
  readonly receipt: CacheReceipt;
  readonly unit: string;
}): string | undefined => {
  if (input.receipt.unit !== input.unit) {
    return 'receipt belongs to another unit';
  }
  if (input.receipt.digest !== input.digest) {
    return 'input digest mismatch (target, origins, toolchain or sources)';
  }
  if (!sameIdentity(input.receipt.identity, input.identity)) {
    return 'original build identity mismatch';
  }
  for (const [index, file] of input.files.entries()) {
    const previous = input.receipt.files[index];
    if (previous === undefined || previous.path !== file.path) {
      return `output path mismatch: ${file.path}`;
    }
    if (
      previous.size !== file.size ||
      previous.sha256 !== file.sha256 ||
      previous.mode !== file.mode ||
      previous.link !== file.link
    ) {
      return `output bytes or mode mismatch: ${file.path}`;
    }
  }
  if (input.receipt.files.length !== input.files.length) {
    return `output file count mismatch; missing ${input.receipt.files[input.files.length]?.path ?? 'file'}`;
  }
  return undefined;
};
export const planOutputCache = (
  checks: readonly { readonly mismatch?: string | undefined; readonly unit: string }[],
) => ({
  build: checks.filter((check) => check.mismatch !== undefined).map((check) => check.unit),
  keep: checks.filter((check) => check.mismatch === undefined).map((check) => check.unit),
});

export const requiredOutputMismatch = (files: readonly OutputFile[], filename: string): string | undefined =>
  files.some((file) => file.path === filename && file.size > 0) ? undefined : `missing or empty ${filename}`;
/** Type bundles are ordinary ZIPs; reject truncation before trusting a newly built bundle. */
export const typeBundleMismatch = (bytes: Uint8Array): string | undefined => {
  const zip = Buffer.from(bytes);
  if (zip.length < 22 || zip.readUInt32LE(0) !== 0x04_03_4b_50) {
    return 'invalid type-bundle ZIP header';
  }
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset -= 1) {
    if (zip.readUInt32LE(offset) !== 0x06_05_4b_50) {
      continue;
    }
    const end = offset + 22 + zip.readUInt16LE(offset + 20);
    const centralStart = zip.readUInt32LE(offset + 16);
    const centralSize = zip.readUInt32LE(offset + 12);
    if (
      end === zip.length &&
      centralSize >= 46 &&
      centralStart + centralSize === offset &&
      zip.readUInt32LE(centralStart) === 0x02_01_4b_50
    ) {
      return undefined;
    }
  }
  return 'missing or truncated type-bundle ZIP directory';
};
const requireFile = (files: readonly OutputFile[], filename: string, unit: string) => {
  const mismatch = requiredOutputMismatch(files, filename);
  return mismatch === undefined ? Effect.void : Effect.fail(invalid(unit, mismatch));
};
const readMetadata = (root: string, directory: string) =>
  readJson(path.join(root, directory, BUILD_METADATA), MetadataSchema);
/** Every surface an artifact declares carries the build's own identity. */
const surfacesMatch = (
  identity: CacheIdentity,
  surfaces: { readonly api: CacheIdentity; readonly ui?: CacheIdentity },
) => sameIdentity(identity, surfaces.api) && (surfaces.ui === undefined || sameIdentity(identity, surfaces.ui));
/** Every module is a backend federation remote; the Shell hosts those remotes and emits no remote of its own. */
const isBackendRemote = (unit: string) => unit !== SHELL;
/** The files a unit's cached build must still hold before anything is kept. */
export const requiredOutputs = (unit: string): readonly string[] => [
  `${OUTPUT}/index.js`,
  `${OUTPUT}/${PACKAGE_JSON}`,
  `${DIST}/api/index.js`,
  ...(isBackendRemote(unit) ? [`${DIST}/${BACKEND_MANIFEST}`, `${DIST}/backendRemoteEntry.cjs`] : []),
];
const validateStructure = (unit: CacheUnit, files: readonly OutputFile[], served: readonly string[]) =>
  Effect.gen(function* validateRequiredOutputs() {
    const fs = yield* FileSystem.FileSystem;
    const root = path.join(APP_ROOT, unit.path);
    // Unpack consumes .output; hosted-owner fixtures consume dist/zerops-entry.mjs and both
    // build identities; derive-built-application-composition consumes the public contracts + MF manifest.
    const remote = isBackendRemote(unit.id);
    for (const filename of requiredOutputs(unit.id)) {
      yield* requireFile(files, filename, unit.id);
    }
    if (served.includes(unit.id)) {
      yield* requireFile(files, `${DIST}/zerops-entry.mjs`, unit.id);
    }
    yield* readJson(path.join(root, OUTPUT, PACKAGE_JSON), PackageManifest);
    const [built, packaged] = yield* Effect.all([readMetadata(root, DIST), readMetadata(root, OUTPUT)], {
      concurrency: 1,
    });
    const identity = built.deliveryUnit;
    if (
      identity.appId !== unit.id ||
      identity.build !== identity.buildMarker ||
      !sameIdentity(identity, packaged.deliveryUnit)
    ) {
      return yield* invalid(unit.id, 'dist/.output build identity mismatch');
    }
    if (![built, packaged].every((artifact) => surfacesMatch(identity, artifact.surfaces))) {
      return yield* invalid(unit.id, 'surface identity mismatch');
    }
    if (remote) {
      const backend = yield* readJson(path.join(root, DIST, BACKEND_MANIFEST), BackendManifest);
      if (!sameIdentity(identity, backend.backendFederation.deliveryUnit)) {
        return yield* invalid(unit.id, 'backend federation identity mismatch');
      }
    }
    const contract = unit.id === SHELL ? 'ontos-shell-runtime.json' : 'ontos-module-manifest.json';
    yield* requireFile(files, `${DIST}/public/.well-known/${contract}`, unit.id);
    const contractFile = path.join(root, DIST, 'public/.well-known', contract);
    const deployment =
      unit.id === SHELL
        ? (yield* readJson(contractFile, OntosShellRuntimeContractSchema)).deployment
        : (yield* readJson(contractFile, OntosModuleDeploymentContractSchema)).deployment;
    if (deployment.appId !== unit.id || deployment.buildMarker !== identity.buildMarker) {
      return yield* invalid(unit.id, 'public contract build identity mismatch');
    }
    if (unit.surfaceProfile !== 'api-only') {
      for (const filename of ['route.json', 'routes-manifest.json']) {
        yield* requireFile(files, `${DIST}/${filename}`, unit.id);
        yield* readJson(path.join(root, DIST, filename), RouteDocument);
      }
      const manifest = yield* readJson(path.join(root, DIST, 'mf-manifest.json'), FederationManifest);
      if (manifest.exposes.length > 0) {
        const bundle = `${DIST}/@mf-types.zip`;
        yield* requireFile(files, bundle, unit.id);
        const issue = typeBundleMismatch(yield* fs.readFile(path.join(root, bundle)));
        if (issue !== undefined) {
          return yield* invalid(unit.id, `${bundle}: ${issue}`);
        }
      }
    }
    // JSON and sourcemaps must parse, not merely have the right file name or a nonzero length.
    const documents = files.filter(
      (entry) => !entry.path.includes('/node_modules/') && /\.(?:json|map)$/u.test(entry.path),
    );
    for (const file of documents) {
      const filename = path.join(root, file.path);
      yield* file.path.endsWith('.map') ? readJson(filename, SourceMapSchema) : readJson(filename, Schema.Json);
    }
    return yield* Effect.succeed(identity);
  });
const checkUnit = (context: Context, unit: CacheUnit) =>
  Effect.gen(function* validateRestoredUnit() {
    const root = path.join(APP_ROOT, unit.path);
    const receipt = yield* readJson(path.join(root, RECEIPT), CacheReceiptSchema);
    const files = yield* inventory(root);
    const mismatch = firstOutputMismatch({
      digest: yield* expectedDigest(context, unit),
      files,
      identity: receipt.identity,
      receipt,
      unit: unit.id,
    });
    if (mismatch !== undefined) {
      return yield* invalid(unit.id, mismatch);
    }
    const identity = yield* validateStructure(unit, files, context.served);
    if (!sameIdentity(identity, receipt.identity)) {
      return yield* invalid(unit.id, 'original build identity mismatch');
    }
    return yield* Effect.void;
  }).pipe(Effect.mapError((cause) => invalid(unit.id, String(cause))));
const listNames = (value: string) =>
  value
    .trim()
    .split(/\s+/u)
    .filter((name) => name.length > 0);
const withUnits = (value: string) =>
  Effect.gen(function* loadSelectedUnits() {
    const context = yield* loadContext;
    const names = listNames(value);
    if (names.length === 0 || new Set(names).size !== names.length) {
      return yield* invalid('selection', 'nonempty, unique units required');
    }
    const units = yield* selectUnits(context, names);
    if (new Set(units.map((unit) => unit.id)).size !== units.length) {
      return yield* invalid('selection', 'duplicate unit aliases');
    }
    return yield* Effect.succeed({ context, units });
  });
const printUnitDigest = (context: Context, unit: CacheUnit) =>
  expectedDigest(context, unit).pipe(Effect.flatMap((digest) => Console.log(`${unit.id}=${digest}`)));
const inspectUnit = (context: Context, unit: CacheUnit) =>
  checkUnit(context, unit).pipe(
    Effect.match({
      onFailure: (error) => ({ mismatch: error.message, unit: unit.id }),
      onSuccess: () => ({ unit: unit.id }),
    }),
  );
const digestCommand = Command.make('digest', { unit: Flag.String('unit').pipe(Flag.atLeast(1)) }, ({ unit }) =>
  Effect.gen(function* printDigests() {
    const { context, units } = yield* withUnits(unit.join(' '));
    return yield* Effect.forEach(units, (entry) => printUnitDigest(context, entry), { concurrency: 1 }).pipe(
      Effect.asVoid,
    );
  }),
);
const planCommand = Command.make('plan', { units: Flag.String('units') }, ({ units: value }) =>
  Effect.gen(function* printPlan() {
    const { context, units } = yield* withUnits(value);
    const checks = yield* Effect.forEach(units, (unit) => inspectUnit(context, unit), { concurrency: 1 });
    const plan = yield* Schema.decodeUnknownEffect(PlanSchema)(planOutputCache(checks));
    return yield* Console.log(`keep=${plan.keep.join(' ')}\nbuild=${plan.build.join(' ')}`);
  }),
);
const stampCommand = Command.make('stamp', { unit: Flag.String('unit') }, ({ unit: value }) =>
  Effect.gen(function* stampFreshOutput() {
    const { context, units } = yield* withUnits(value);
    const fs = yield* FileSystem.FileSystem;
    for (const unit of units) {
      const root = path.join(APP_ROOT, unit.path);
      if (yield* fs.exists(path.join(root, RECEIPT))) {
        return yield* invalid(unit.id, 'refusing to restamp; clean outputs before rebuilding');
      }
      const files = yield* inventory(root);
      const identity = yield* validateStructure(unit, files, context.served);
      if (identity.sourceRevision !== context.head) {
        return yield* invalid(unit.id, 'fresh build must name HEAD; refusing to relabel old bytes');
      }
      const receipt: CacheReceipt = {
        digest: yield* expectedDigest(context, unit),
        files,
        identity,
        schemaVersion: 1,
        unit: unit.id,
      };
      const temporary = path.join(root, `${RECEIPT}.tmp`);
      yield* fs.writeFileString(temporary, yield* encode(CacheReceiptSchema, receipt));
      yield* fs.rename(temporary, path.join(root, RECEIPT));
    }
    return yield* Effect.void;
  }),
);
const verifyCommand = Command.make('verify', { units: Flag.String('units') }, ({ units: value }) =>
  Effect.gen(function* verifyOutputs() {
    const { context, units } = yield* withUnits(value);
    return yield* Effect.forEach(units, (unit) => checkUnit(context, unit), { concurrency: 1 }).pipe(Effect.asVoid);
  }),
);
export const unitOutputCacheCommand = Command.make('unit-output-cache').pipe(
  Command.withSubcommands([digestCommand, planCommand, stampCommand, verifyCommand]),
);
if (import.meta.main) {
  runQualityCli(Command.run(unitOutputCacheCommand, { version: '1.0.0' }));
}
