/**
 * The gate matrices: scripts/ci-matrices.json, plus the overlay a trunk names (`--overlay` or CI_MATRICES_OVERLAY, a
 * path relative to app/). An overlay only adds: its list entries are appended and its map entries merged. A key the
 * matrices do not know, a row name or list value the base already has (or the overlay repeats), or a map entry both
 * files name fails, so an overlay can never replace or hide what the base runs.
 */
import path from 'node:path';

import { Config, Console, Effect, FileSystem, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { runQualityCli } from '../quality-cli-lifecycle.mts';

const APP = path.resolve(import.meta.dirname, '../..');
const CI_MATRICES = 'scripts/ci-matrices.json';
const OVERLAY_VARIABLE = 'CI_MATRICES_OVERLAY';

const CommandEntrySchema = Schema.Struct({
  'artifact-units': Schema.optionalKey(Schema.String),
  commands: Schema.String,
  fetch_depth: Schema.optionalKey(Schema.Number),
  name: Schema.String,
  'node-artifacts': Schema.optionalKey(Schema.Boolean),
  /** Shell commands the row runs before its own, from app/: system tools or provisioned fixtures its tests need. */
  setup: Schema.optionalKey(Schema.String),
  'typescript-build': Schema.optionalKey(Schema.Boolean),
});
export const IntegrationEntrySchema = Schema.Struct({
  'artifact-units': Schema.optionalKey(Schema.String),
  name: Schema.String,
  'native-composition': Schema.optionalKey(Schema.Boolean),
  'native-preproposal': Schema.optionalKey(Schema.Boolean),
  'package-filters': Schema.optionalKey(Schema.String),
  'proof-packages': Schema.optionalKey(Schema.Array(Schema.String)),
  'root-rstest-shard': Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+\/\d+$/u))),
  'root-suite': Schema.optionalKey(Schema.Boolean),
  'rstest-shard': Schema.optionalKey(Schema.String),
  /** Rstest file workers; integration rows share one job database and its composition authority, so they run 1. */
  'rstest-workers': Schema.optionalKey(Schema.Literals([1, 2])),
  /** skip: leave out, only: run just the files that must migrate their own database (rstest-weighted-shard.sh). */
  'fresh-database-tests': Schema.optionalKey(Schema.Literals(['skip', 'only'])),
  /** Rstest projects a weighted package row runs one after another; `integration` when absent. */
  'rstest-projects': Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z-]+(?: [a-z-]+)*$/u))),
  /** The row may restore the cached seed database (scripts/ci/integration-seed.mts) instead of migrating its own. */
  seed: Schema.optionalKey(Schema.Boolean),
  suite: Schema.Literals(['integration', 'browser']),
}).check(
  Schema.makeFilter((entry) =>
    entry.suite === 'integration' &&
    entry['root-suite'] !== true &&
    entry['native-preproposal'] !== true &&
    (entry['package-filters'] === undefined || entry['package-filters'].length === 0)
      ? 'Integration templates must name package filters, run the root suite or run the native preproposal proof'
      : undefined,
  ),
  Schema.makeFilter((entry) =>
    entry['native-preproposal'] === true && (entry['proof-packages']?.length ?? 0) === 0
      ? 'Native preproposal templates must name their runtime proof packages'
      : undefined,
  ),
);
/**
 * A change confined to these paths is proved by the named source rows, the static contracts, the lint of the changed
 * files and the unit rows of the packages it changes; it builds no unit and starts no service. A path matches when it
 * matches a glob and no `!` glob. app/scripts/tests/demo-trunk-ci.test.mts proves that nothing outside those rows reads
 * a scoped file.
 */
const CiScopeSchema = Schema.Struct({
  name: Schema.String,
  paths: Schema.NonEmptyArray(Schema.String),
  source: Schema.NonEmptyArray(Schema.String),
});
export type CiScope = typeof CiScopeSchema.Type;
const matricesFields = {
  /** Public origins a unit build bakes in, as the gates' unit output cache names them (scripts/ci/unit-output-cache.mts). */
  'build-origin-variables': Schema.optionalKey(Schema.Array(Schema.String)),
  /** Test files that must migrate or recover their job's database; the seed model refuses exactly these. */
  'fresh-database-tests': Schema.optionalKey(Schema.Array(Schema.String)),
  integration: Schema.Array(IntegrationEntrySchema),
  /**
   * The workspace packages app/pnpm-workspace.yaml names one by one, outside `apps`, `packages` and `verticals`, each
   * named after its directory. Such a package that is not listed here leaves the workspace unaccounted: every gate runs.
   */
  'root-packages': Schema.optionalKey(Schema.Array(Schema.String)),
  scopes: Schema.optionalKey(Schema.Array(CiScopeSchema)),
  source: Schema.Array(CommandEntrySchema),
  /** Measured seconds of a test-file family by file-name prefix; scripts/ci/rstest-weighted-shard.sh deals by it. */
  'test-weights': Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  unit: Schema.Array(CommandEntrySchema),
};
export const CiTemplatesSchema = Schema.Struct(matricesFields);
export type CiTemplates = typeof CiTemplatesSchema.Type;
export type CiIntegrationEntry = typeof IntegrationEntrySchema.Type;
/** An overlay names only what it adds. */
const OverlaySchema = Schema.Struct({
  ...matricesFields,
  integration: Schema.optionalKey(matricesFields.integration),
  source: Schema.optionalKey(matricesFields.source),
  unit: Schema.optionalKey(matricesFields.unit),
});
type Overlay = typeof OverlaySchema.Type;

export class CiMatricesInvalid extends Schema.TaggedError<CiMatricesInvalid>()('CiMatricesInvalid', {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

/** The base list with the overlay's entries appended, or a failure naming every entry either list already holds. */
const appended = <Entry,>(
  key: string,
  base: readonly Entry[] | undefined,
  added: readonly Entry[] | undefined,
  nameOf: (entry: Entry) => string,
): Result.Result<readonly Entry[], CiMatricesInvalid> => {
  const existing = base ?? [];
  const extra = added ?? [];
  const names = new Set(existing.map(nameOf));
  const repeated = extra.map(nameOf).filter((name, index, all) => names.has(name) || all.indexOf(name) !== index);
  return repeated.length === 0
    ? Result.succeed([...existing, ...extra])
    : Result.fail(new CiMatricesInvalid({ reason: `The overlay repeats ${key} entries: ${repeated.join(', ')}` }));
};
const byName = (entry: { readonly name: string }) => entry.name;
const itself = (entry: string) => entry;

/** The base with the overlay's entries added (see the module comment). */
export const mergeCiMatrices = (base: CiTemplates, overlay: Overlay): Result.Result<CiTemplates, CiMatricesInvalid> => {
  const weights = overlay['test-weights'] ?? {};
  const repeatedWeights = Object.keys(weights).filter((name) => Object.hasOwn(base['test-weights'] ?? {}, name));
  if (repeatedWeights.length > 0) {
    return Result.fail(
      new CiMatricesInvalid({ reason: `The overlay repeats test-weights entries: ${repeatedWeights.join(', ')}` }),
    );
  }
  return Result.all({
    'build-origin-variables': appended(
      'build-origin-variables',
      base['build-origin-variables'],
      overlay['build-origin-variables'],
      itself,
    ),
    'fresh-database-tests': appended(
      'fresh-database-tests',
      base['fresh-database-tests'],
      overlay['fresh-database-tests'],
      itself,
    ),
    integration: appended('integration', base.integration, overlay.integration, byName),
    'root-packages': appended('root-packages', base['root-packages'], overlay['root-packages'], itself),
    scopes: appended('scopes', base.scopes, overlay.scopes, byName),
    source: appended('source', base.source, overlay.source, byName),
    'test-weights': Result.succeed({ ...base['test-weights'], ...weights }),
    unit: appended('unit', base.unit, overlay.unit, byName),
  });
};

/** One matrices document; a key the matrices do not know fails instead of being dropped. */
const decodeMatrices = <A,>(label: string, schema: Schema.Codec<A>, text: string) =>
  Schema.decodeUnknownResult(Schema.fromJsonString(schema), { onExcessProperty: 'error' })(text).pipe(
    Result.mapError((cause) => new CiMatricesInvalid({ reason: `${label}: ${String(cause)}` })),
  );

/** The merged matrices from the text of ci-matrices.json and of the overlay, if any. */
export const parseCiMatrices = (base: string, overlay?: string): Result.Result<CiTemplates, CiMatricesInvalid> =>
  Result.all([
    decodeMatrices(CI_MATRICES, CiTemplatesSchema, base),
    overlay === undefined ? Result.succeed({}) : decodeMatrices('the overlay', OverlaySchema, overlay),
  ]).pipe(Result.flatMap(([decoded, added]) => mergeCiMatrices(decoded, added)));

/** The merged matrices: the base with the given overlay (relative to app/), or CI_MATRICES_OVERLAY's when none is given. */
export const loadCiMatrices = (overlay?: string) =>
  Effect.gen(function* loadMatrices() {
    const fs = yield* FileSystem.FileSystem;
    const named = overlay ?? (yield* Config.String(OVERLAY_VARIABLE).pipe(Config.withDefault('')));
    const read = (filename: string) =>
      fs
        .readFileString(path.join(APP, filename))
        .pipe(Effect.mapError((cause) => new CiMatricesInvalid({ reason: `${filename}: ${cause.message}` })));
    const base = yield* read(CI_MATRICES);
    return yield* Effect.fromResult(parseCiMatrices(base, named === '' ? undefined : yield* read(named)));
  });

/** Prints the merged matrices as JSON. */
const cli = Command.make('ci-matrices', { overlay: Flag.String('overlay').pipe(Flag.withDefault('')) }, ({ overlay }) =>
  Effect.gen(function* printMatrices() {
    const matrices = yield* loadCiMatrices(overlay === '' ? undefined : overlay);
    yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(CiTemplatesSchema))(matrices));
  }),
);

if (import.meta.main) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
