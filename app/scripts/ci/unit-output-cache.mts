#!/usr/bin/env node
/**
 * The gates' per-unit outputs. A build shard starts from the dist/ and .output/ of its units that the seed run built
 * (scripts/ci/seed-units.sh), keeps a unit only when its receipt (dist/.gates-output-cache.json: the input digest, the
 * original build identity and a complete byte and mode inventory) matches this checkout, builds the rest
 * (scripts/ci/build-units.sh, which stamps a receipt on each fresh build) and verifies the complete shard before
 * anything is packed. Where an archive came from is never evidence; who may be the seed is decided at the lookup.
 *
 * The digest is the unit identity of scripts/ci/unit-inputs.mts with build-units.sh as the build driver (its post-build
 * script, --post-build, included) and the trunk's public origins (`build-origin-variables` of the gate matrices),
 * salted with the receipt format and the build profile: Node target, package build command, build mode, output policy
 * (with the served entry, --served-entry), the public build environment and the actual Node, component and pnpm
 * versions, platform and architecture. Source revision and build-marker overrides are NOT digest inputs: a kept unit
 * keeps its OLD build identity, and the receipt records the unit's committed-inputs digest. Native integration fixtures
 * that bundle checkout sources against a composition built from these outputs take a kept unit's identity from
 * scripts/ci/kept-unit-identity.mts, which proves with that digest that the sources are the ones the unit was built
 * from. Stamp requires freshly built metadata naming HEAD; never restamp a keep.
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
import {
  CacheReceiptSchema,
  IdentitySchema,
  KEEP_PROOF,
  KeepProofSchema,
  RECEIPT,
  RECEIPT_SCHEMA_VERSION,
  REVISION,
} from './unit-output-receipt.mts';
import type { CacheIdentity, CacheReceipt, OutputFile } from './unit-output-receipt.mts';
import { loadCiMatrices } from './ci-matrices.mts';
import { readSources, readWorkspace, unitIdentity, unitInputDigest, unitInputGraph } from './unit-inputs.mts';
import type { BuildDriver, UnitInputGraph } from './unit-inputs.mts';

const APP_ROOT = path.resolve(import.meta.dirname, '../..');
const BUILD_METADATA = 'ultramodern-build.json';
const SHELL = 'shell-super-app';
const DIST = 'dist';
const OUTPUT = '.output';
const WORKSPACE = 'workspace';
const BACKEND_MANIFEST = 'backend-mf-manifest.json';
const PACKAGE_JSON = 'package.json';
const OUTPUT_ROOTS = [DIST, OUTPUT];
const NONEMPTY = Schema.String.check(Schema.isMinLength(1));
const UnitSchema = Schema.Struct({
  id: NONEMPTY,
  path: Schema.String.check(Schema.isPattern(/^(?:apps|verticals)\/[a-z0-9-]+$/u)),
  surfaceProfile: Schema.optionalKey(Schema.String),
});
const TopologySchema = Schema.Struct({ shell: UnitSchema, verticals: Schema.Array(UnitSchema) });
export type CacheUnit = typeof UnitSchema.Type;
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
/**
 * The backend federation manifest names its unit with UltraModern's delivery-unit contract block, which carries the
 * build's marker and source revision but neither the app id nor the build alias of the build metadata.
 */
const BackendManifest = Schema.Struct({
  backendFederation: Schema.Struct({
    deliveryUnit: Schema.Struct({
      buildMarker: NONEMPTY,
      sourceRevision: REVISION,
      unitId: NONEMPTY.pipe(Schema.brand('BackendFederationUnitId')),
    }),
  }),
});
/** The remote names the build it belongs to: the same marker and source revision as the unit's build metadata. */
export const sameBackendBuild = (
  identity: CacheIdentity,
  remote: { readonly buildMarker: string; readonly sourceRevision: string },
) => remote.buildMarker === identity.buildMarker && remote.sourceRevision === identity.sourceRevision;
const PlanSchema = Schema.Struct({
  build: Schema.Array(Schema.String),
  keep: Schema.Array(Schema.String),
  /** Why each unit in `build` is rebuilt: the first mismatch the plan found (`<unit>: <mismatch>`), in its order. */
  reasons: Schema.Array(Schema.Struct({ reason: Schema.String, unit: Schema.String })),
});
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

/** Scripts build-units.sh names that write nothing into a unit's output, and why. */
const DRIVER_TOOLS = new Map([
  ['scripts/ci/unit-output-cache.mts', 'stamps the receipt after the build and computes these identities'],
]);
/** The gates' build driver; `postBuild` is the script it runs after a served unit's build (UNIT_POST_BUILD). */
export const gatesBuildDriver = (postBuild: string): BuildDriver => ({
  extraInputs: postBuild === '' ? [] : [path.posix.join('app', postBuild)],
  path: 'app/scripts/ci/build-units.sh',
  tools: DRIVER_TOOLS,
});
interface DigestInput {
  readonly directory: string;
  readonly driver: BuildDriver;
  readonly graph: UnitInputGraph;
  /** The values of `originVariables`, in their order. */
  readonly origins: readonly string[];
  readonly originVariables: readonly string[];
  readonly profile: CacheProfile;
}
/** Derived from the receipt format, never a second hand-kept version (see RECEIPT_SCHEMA_VERSION). */
export const gatesDigestSalt = `gates-output-receipt-v${CacheReceiptSchema.fields.schemaVersion.literal}`;
export const gatesInputDigest = (input: DigestInput) =>
  Effect.gen(function* computeGatesDigest() {
    // The profile carries the rest of the build environment; the origins are named so an unset one still counts.
    const environment = input.originVariables.map((name, index) => [name, input.origins[index] ?? ''] as const);
    const base = yield* unitInputDigest(input.directory, { driver: input.driver, environment, graph: input.graph });
    const profile = yield* encode(CacheProfileSchema, input.profile);
    return yield* Effect.succeed(hash(`${gatesDigestSalt}\n${base}\n${profile}`));
  });

const run = (executable: string, args: readonly string[], cwd: string) =>
  Effect.gen(function* captureCommand() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make(executable, args, { cwd }));
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
const git = (args: readonly string[], root: string) => run('git', args, root);
const identityOverride = /^(?:ULTRAMODERN_SOURCE_REVISION|ULTRAMODERN_BUILD_MARKER)$/u;
// ONTOS_CI_TYPECHECK_SEPARATE drops the JavaScript source maps and server declarations (shared-contracts modern-config.ts).
const buildVariable =
  /^(?:MODERN_|ULTRAMODERN_|PUBLIC_|ONTOS_.*ORIGIN|ONTOS_CI_TYPECHECK_SEPARATE$|NODE_(?:ENV|OPTIONS|PATH)$|BABEL_ENV$|RSPACK_|RSBUILD_|BROWSERSLIST|TZ$|LANG$|LC_|SOURCE_DATE_EPOCH$|CI$)/u;
/** `name=value` pairs of the environment every build child inherits, NUL-separated so values may hold newlines. */
const inheritedEnvironment = (root: string) =>
  run('env', ['-0'], root).pipe(
    Effect.map((listing) =>
      listing.split('\0').flatMap((pair): [string, string][] => {
        const separator = pair.indexOf('=');
        return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
      }),
    ),
  );
const readProfile = Effect.fn('UnitOutputCache.profile')(function* readBuildProfile(root: string, servedEntry: string) {
  const environment = (yield* inheritedEnvironment(root))
    .filter(([name]) => buildVariable.test(name) && !identityOverride.test(name))
    .toSorted(([left], [right]) => left.localeCompare(right));
  return yield* Schema.decodeUnknownEffect(CacheProfileSchema)({
    architecture: process.arch,
    command: 'pnpm run build (modern build + modern deploy --skip-build --deploy-target node)',
    environment,
    mode: yield* Config.String('NODE_ENV').pipe(Config.withDefault('production')),
    node: process.version,
    platform: process.platform,
    pnpm: yield* run('pnpm', ['--version'], root),
    policy: `full dist + packaged .output; preserve maps/types; served entry ${servedEntry || 'none'} for released units; v1`,
    target: 'node',
    versions: process.versions,
  });
});
/** How the trunk builds its units: the origins it bakes in, its post-build script and the entry that script writes. */
export interface BuildPolicy {
  readonly originVariables: readonly string[];
  readonly postBuild: string;
  readonly servedEntry: string;
}
/** Everything the plan, stamp and verify read about one committed workspace; `root` is its app directory. */
export const loadCacheContext = Effect.fn('UnitOutputCache.context')(function* readCacheContext(
  root: string,
  policy: BuildPolicy,
) {
  const dirty = yield* git(['status', '--porcelain', '--untracked-files=normal'], root);
  if (dirty.length > 0) {
    return yield* invalid(WORKSPACE, 'committed inputs required; checkout has uncommitted changes');
  }
  const head = yield* git(['rev-parse', 'HEAD'], root);
  const workspace = yield* readWorkspace(head, root);
  const topology = yield* git(['show', `${head}:app/topology/reference-topology.json`], root).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TopologySchema))),
  );
  const units = [topology.shell, ...topology.verticals];
  const origins = yield* Effect.forEach(
    policy.originVariables,
    (name) => Config.String(name).pipe(Config.withDefault('')),
    { concurrency: 1 },
  );
  return yield* Effect.succeed({
    driver: gatesBuildDriver(policy.postBuild),
    graph: unitInputGraph({ ...workspace, sources: yield* readSources(workspace.entries, root) }),
    head,
    origins,
    originVariables: policy.originVariables,
    profile: yield* readProfile(root, policy.servedEntry),
    root,
    served: workspace.units.map((unit) => unit.id),
    servedEntry: policy.servedEntry,
    units,
  });
});
type Context = Effect.Success<ReturnType<typeof loadCacheContext>>;
const selectUnits = (context: Context, names: readonly string[]) =>
  Effect.forEach(
    names,
    (name) => {
      const unit = context.units.find((entry) => entry.id === name || entry.path === name);
      return unit === undefined ? Effect.fail(invalid(name, 'not a reference-topology unit')) : Effect.succeed(unit);
    },
    { concurrency: 1 },
  );
/** The gates digest a unit's receipt must carry for this context's HEAD. */
export const expectedDigest = (context: Context, unit: CacheUnit) =>
  gatesInputDigest({ ...context, directory: `app/${unit.path}` });

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
    if (relative === RECEIPT || relative === KEEP_PROOF) {
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
  reasons: checks.flatMap((check) =>
    check.mismatch === undefined ? [] : [{ reason: check.mismatch, unit: check.unit }],
  ),
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
const validateStructure = (context: Context, unit: CacheUnit, files: readonly OutputFile[]) =>
  Effect.gen(function* validateRequiredOutputs() {
    const fs = yield* FileSystem.FileSystem;
    const root = path.join(context.root, unit.path);
    // Unpack consumes .output; hosted-owner fixtures consume the served entry and both build identities;
    // derive-built-application-composition consumes the public contracts + MF manifest.
    const remote = isBackendRemote(unit.id);
    for (const filename of requiredOutputs(unit.id)) {
      yield* requireFile(files, filename, unit.id);
    }
    if (context.servedEntry !== '' && context.served.includes(unit.id)) {
      yield* requireFile(files, context.servedEntry, unit.id);
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
      if (!sameBackendBuild(identity, backend.backendFederation.deliveryUnit)) {
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
    const root = path.join(context.root, unit.path);
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
    const identity = yield* validateStructure(context, unit, files);
    if (!sameIdentity(identity, receipt.identity)) {
      return yield* invalid(unit.id, 'original build identity mismatch');
    }
    return yield* Effect.void;
  }).pipe(
    Effect.mapError((cause) => (Schema.is(UnitOutputCacheError)(cause) ? cause : invalid(unit.id, String(cause)))),
  );
const listNames = (value: string) =>
  value
    .trim()
    .split(/\s+/u)
    .filter((name) => name.length > 0);
/** The trunk's build policy: its origins from the gate matrices, the rest from the flags every command takes. */
const policyFlags = {
  postBuild: Flag.String('post-build').pipe(Flag.withDefault('')),
  servedEntry: Flag.String('served-entry').pipe(Flag.withDefault('')),
};
const withUnits = (value: string, flags: { readonly postBuild: string; readonly servedEntry: string }) =>
  Effect.gen(function* loadSelectedUnits() {
    const matrices = yield* loadCiMatrices();
    const context = yield* loadCacheContext(APP_ROOT, {
      ...flags,
      originVariables: matrices['build-origin-variables'],
    });
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
const inspectUnit = (context: Context, unit: CacheUnit) =>
  checkUnit(context, unit).pipe(
    Effect.match({
      onFailure: (error) => ({ mismatch: error.message, unit: unit.id }),
      onSuccess: () => ({ unit: unit.id }),
    }),
  );
/** A unit's committed-inputs digest, as receipts and keep proofs record it (unitIdentity without build variables). */
export const committedInputs = (graph: UnitInputGraph, driver: BuildDriver, unitPath: string) =>
  unitIdentity(`app/${unitPath}`, { driver, environment: [], graph }).pipe(Effect.map(({ files }) => files));
/** The keep proof the plan writes for a unit it keeps (see KeepProofSchema). */
export const keepProof = (input: { readonly head: string; readonly inputs: string; readonly unit: string }) =>
  Schema.decodeUnknownEffect(KeepProofSchema)({
    inputs: input.inputs,
    revision: input.head,
    schemaVersion: 1,
    unit: input.unit,
  });
const writeKeepProof = (context: Context, unit: CacheUnit) =>
  Effect.gen(function* writeProof() {
    const fs = yield* FileSystem.FileSystem;
    const root = path.join(context.root, unit.path);
    const proof = yield* keepProof({
      head: context.head,
      inputs: yield* committedInputs(context.graph, context.driver, unit.path),
      unit: unit.id,
    });
    const temporary = path.join(root, `${KEEP_PROOF}.tmp`);
    yield* fs.writeFileString(temporary, yield* encode(KeepProofSchema, proof));
    yield* fs.rename(temporary, path.join(root, KEEP_PROOF));
  });
/**
 * Decides which units a shard keeps. A kept unit gets the keep proof that its inputs are this HEAD's (see
 * KeepProofSchema); a unit to build loses any earlier proof at once, so no proof outlives the outputs it vouched for
 * even before the workflow removes them, and a fresh build names HEAD itself.
 */
export const planUnits = Effect.fn('UnitOutputCache.plan')(function* planUnits(
  context: Context,
  units: readonly CacheUnit[],
) {
  const fs = yield* FileSystem.FileSystem;
  const checks = yield* Effect.forEach(units, (unit) => inspectUnit(context, unit), { concurrency: 1 });
  for (const [index, check] of checks.entries()) {
    const unit = units[index];
    if (unit !== undefined) {
      yield* 'mismatch' in check
        ? fs.remove(path.join(context.root, unit.path, KEEP_PROOF), { force: true })
        : writeKeepProof(context, unit);
    }
  }
  return yield* Schema.decodeUnknownEffect(PlanSchema)(planOutputCache(checks));
});
const planCommand = Command.make(
  'plan',
  { ...policyFlags, units: Flag.String('units') },
  ({ units: value, ...flags }) =>
    Effect.gen(function* printPlan() {
      const { context, units } = yield* withUnits(value, flags);
      const plan = yield* planUnits(context, units);
      // To the job log, never into the step outputs: why each unit is rebuilt, so a run explains a cold shard.
      for (const { reason } of plan.reasons) {
        yield* Console.error(`Rebuilding ${reason}`);
      }
      return yield* Console.log(`keep=${plan.keep.join(' ')}\nbuild=${plan.build.join(' ')}`);
    }),
);
const stampCommand = Command.make('stamp', { ...policyFlags, unit: Flag.String('unit') }, ({ unit: value, ...flags }) =>
  Effect.gen(function* stampFreshOutput() {
    const { context, units } = yield* withUnits(value, flags);
    const fs = yield* FileSystem.FileSystem;
    for (const unit of units) {
      const root = path.join(context.root, unit.path);
      if (yield* fs.exists(path.join(root, RECEIPT))) {
        return yield* invalid(unit.id, 'refusing to restamp; clean outputs before rebuilding');
      }
      const files = yield* inventory(root);
      const identity = yield* validateStructure(context, unit, files);
      if (identity.sourceRevision !== context.head) {
        return yield* invalid(unit.id, 'fresh build must name HEAD; refusing to relabel old bytes');
      }
      const receipt: CacheReceipt = {
        digest: yield* expectedDigest(context, unit),
        files,
        identity,
        inputs: yield* committedInputs(context.graph, context.driver, unit.path),
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        unit: unit.id,
      };
      const temporary = path.join(root, `${RECEIPT}.tmp`);
      yield* fs.writeFileString(temporary, yield* encode(CacheReceiptSchema, receipt));
      yield* fs.rename(temporary, path.join(root, RECEIPT));
    }
    return yield* Effect.void;
  }),
);
const verifyCommand = Command.make(
  'verify',
  { ...policyFlags, units: Flag.String('units') },
  ({ units: value, ...flags }) =>
    Effect.gen(function* verifyOutputs() {
      const { context, units } = yield* withUnits(value, flags);
      return yield* Effect.forEach(units, (unit) => checkUnit(context, unit), { concurrency: 1 }).pipe(Effect.asVoid);
    }),
);
export const unitOutputCacheCommand = Command.make('unit-output-cache').pipe(
  Command.withSubcommands([planCommand, stampCommand, verifyCommand]),
);
if (import.meta.main) {
  runQualityCli(Command.run(unitOutputCacheCommand, { version: '1.0.0' }));
}
