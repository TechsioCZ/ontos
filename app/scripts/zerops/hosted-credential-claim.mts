/**
 * Every built owner bundle that makes delegated calls inlines its own copy of the hosted module credential store
 * (`packages/core-runtime/src/auth/hosted-module-credential-store.ts`): the API bundler inlines workspace sources.
 * The host can fill only a copy it claimed, so a unit's build exposes exactly its API bundle's own claim, and nothing
 * else of the store, as one named export the unit's generated entry re-exports (`owner-entry.mts`) and only the host
 * program calls (`serve-units.mts`, `scripts/demo/serve-module.mts`). A copy anywhere else in what a host serves fails
 * the build: nobody could claim it, so its owner would never hold a key.
 *
 * Its command line is `scripts/zerops/hosted-credential-claim-cli.mts`; this module stays free of anything that can
 * start a subprocess, because the processes holding a credential channel load it.
 */
import path from 'node:path';

import { Effect, FileSystem, Option, Schema } from 'effect';

export class HostedCredentialClaimError extends Schema.TaggedError<HostedCredentialClaimError>()(
  'HostedCredentialClaimError',
  { reason: Schema.String },
) {}

/** The API bundle's export of its own store copy's claim; only the generated entry names it. */
export const BUNDLE_CLAIM_EXPORT = 'ontosClaimHostedModuleCredentials';
/** The generated entry's export the host claims a unit's copy through. */
export const ENTRY_CLAIM_EXPORT = 'claimModuleCredentials';
/** A unit's API bundle, relative to its directory: the file the unit's production server loads its API from. */
export const API_BUNDLE = path.join('dist', 'api', 'index.js');
/**
 * Built files of a unit that carry a copy but that no host loads: the backend federation remote, which only build
 * tooling inspects (`scripts/tests/hosted-credential-claim.test.mts` holds that no host program names it).
 */
export const UNSERVED_ARTEFACTS: ReadonlySet<string> = new Set([path.join('dist', 'backendRemoteEntry.cjs')]);

/** Each copy names its claim's span; the span survives bundling whatever the bundler renames. */
const CLAIM_SPAN = /["']HostedModuleCredentials\.claim["']/gu;
/** `var claim = Effect.fn(...)` (an ES module bundle) or `claim = import_effect.Effect.fn(...)` (a lazy module). */
const CLAIM_DEFINITION =
  /\b(?<name>[A-Za-z_$][\w$]*) = [A-Za-z_$][\w$.]*\.fn\(["']HostedModuleCredentials\.claim["']\)/gu;
/** esbuild wraps a module it may load lazily in an initialiser that must run before its bindings exist. */
const LAZY_STORE = /\bvar (?<init>[A-Za-z_$][\w$]*) = __esm\(\{\s*"[^"]*hosted-module-credential-store\.ts"/gu;
const EXPOSURE_MARKER =
  "// The host's claim of this bundle's own credential store copy (scripts/zerops/hosted-credential-claim.mts).";

const BundleFormatSchema = Schema.Literals(['commonjs', 'module']);
type BundleFormat = typeof BundleFormatSchema.Type;

const formatOf = (source: string): BundleFormat | undefined => {
  if (/^export \{/mu.test(source)) {
    return 'module';
  }
  return /^(?:exports\.|module\.exports)/mu.test(source) ? 'commonjs' : undefined;
};

/** How the bundle exposes its copy's claim: the claim itself, after running the copy's initialiser when it is lazy. */
const exposureOf = (name: string, init: string | undefined, format: BundleFormat) => {
  const claim = init === undefined ? name : `(owners) => (${init}(), ${name}(owners))`;
  if (format === 'commonjs') {
    return `${EXPOSURE_MARKER}\nexports.${BUNDLE_CLAIM_EXPORT} = ${claim};`;
  }
  return init === undefined
    ? `${EXPOSURE_MARKER}\nexport { ${name} as ${BUNDLE_CLAIM_EXPORT} };`
    : `${EXPOSURE_MARKER}\nexport const ${BUNDLE_CLAIM_EXPORT} = ${claim};`;
};

/** A bundle's form in words, for a build failure: its module system and whether its store copy is lazy. */
export const bundleFormOf = (source: string): string => {
  const format = formatOf(source);
  const lazy = [...source.matchAll(LAZY_STORE)].length > 0 ? ', store initialised lazily' : '';
  if (format === undefined) {
    return `unknown module system${lazy}`;
  }
  return `${format === 'module' ? 'ES module' : 'CommonJS'}${lazy}`;
};

/** How many store copies a built JavaScript file carries. */
export const storeCopiesIn = (source: string): number => [...source.matchAll(CLAIM_SPAN)].length;

const unclaimable = (reason: string) => new HostedCredentialClaimError({ reason });

/** The exposure a bundle with exactly one copy needs; refused for any other shape. */
const requiredExposure = (source: string): Effect.Effect<string, HostedCredentialClaimError> => {
  const copies = storeCopiesIn(source);
  const definitions = [...source.matchAll(CLAIM_DEFINITION)].map((match) => match.groups?.name);
  const inits = [...source.matchAll(LAZY_STORE)].map((match) => match.groups?.init);
  const [name] = definitions;
  const format = formatOf(source);
  if (copies !== 1 || definitions.length !== 1 || name === undefined || inits.length > 1) {
    return Effect.fail(
      unclaimable(
        `the bundle carries ${String(copies)} credential store copies with ${String(definitions.length)} locatable claims; exactly one of each can be claimed`,
      ),
    );
  }
  if (format === undefined) {
    return Effect.fail(unclaimable('the bundle is neither an ES module nor a CommonJS module'));
  }
  return Effect.succeed(exposureOf(name, inits[0], format));
};

/**
 * The API bundle with its own copy's claim exposed, unchanged when it carries no copy or already exposes it. More than
 * one copy, or a copy whose claim cannot be located, is refused: such a bundle cannot be claimed as a whole.
 */
export const exposeBundleClaim = (source: string): Effect.Effect<string, HostedCredentialClaimError> =>
  storeCopiesIn(source) === 0
    ? Effect.succeed(source)
    : requiredExposure(source).pipe(
        Effect.flatMap((exposure) => {
          if (source.includes(`\n${exposure}\n`)) {
            return Effect.succeed(source);
          }
          return source.includes(BUNDLE_CLAIM_EXPORT)
            ? Effect.fail(unclaimable('the bundle exposes a claim that is not its own'))
            : Effect.succeed(`${source.trimEnd()}\n${exposure}\n`);
        }),
      );

/** Whether a bundle exposes its own copy's claim, exactly once. */
export const exposesBundleClaim = (source: string): Effect.Effect<boolean> =>
  requiredExposure(source).pipe(
    Effect.map((exposure) => source.split(`\n${exposure}\n`).length === 2),
    Effect.orElseSucceed(() => false),
  );

/** The generated ES module entry's line that re-exports the API bundle's claim for the host. */
export const entryClaimExport = `export { ${BUNDLE_CLAIM_EXPORT} as ${ENTRY_CLAIM_EXPORT} } from './api/index.js';`;
/** The generated CommonJS entry's exports: its start and the API bundle's claim for the host. */
export const commonJsEntryExports = `module.exports = { start, ${ENTRY_CLAIM_EXPORT}: require('./api/index.js').${BUNDLE_CLAIM_EXPORT} };`;
/** The ES module shim over a CommonJS entry that carries the claim. */
export const commonJsClaimShim = [
  "import { createRequire } from 'node:module';",
  '',
  `export const { start, ${ENTRY_CLAIM_EXPORT} } = createRequire(import.meta.url)('./zerops-entry.cjs');`,
  '',
].join('\n');

const builtScripts = (fs: FileSystem.FileSystem, directory: string): Effect.Effect<readonly string[]> =>
  fs.readDirectory(directory, { recursive: true }).pipe(
    Effect.map((entries) =>
      entries.filter((entry) => /\.(?:c|m)?js$/u.test(entry) && !entry.split(path.sep).includes('node_modules')),
    ),
    Effect.orElseSucceed((): readonly string[] => []),
  );

/** What is wrong with one built file of a unit: a copy no host can claim, or a claim the entry does not hand over. */
const problemsOf = Effect.fn('HostedCredentialClaim.problemsOf')(function* problemsOf(
  file: string,
  source: string,
  dist: string,
) {
  const copies = storeCopiesIn(source);
  if (copies === 0 || UNSERVED_ARTEFACTS.has(file)) {
    return [];
  }
  if (file !== API_BUNDLE) {
    return [`${file} carries ${String(copies)} credential store copies no host can claim`];
  }
  if (!(yield* exposesBundleClaim(source))) {
    return [`${file} carries a credential store copy whose claim it does not expose`];
  }
  const fs = yield* FileSystem.FileSystem;
  const entry = yield* fs.readFileString(path.join(dist, 'zerops-entry.mjs')).pipe(Effect.option);
  const commonJsEntry = yield* fs.readFileString(path.join(dist, 'zerops-entry.cjs')).pipe(Effect.option);
  const handsOver = Option.isSome(commonJsEntry)
    ? commonJsEntry.value.includes(commonJsEntryExports) &&
      Option.isSome(entry) &&
      entry.value.includes(`export const { start, ${ENTRY_CLAIM_EXPORT} }`)
    : Option.isNone(entry) || entry.value.includes(entryClaimExport);
  return handsOver ? [] : ['dist/zerops-entry does not hand the host its API bundle claim'];
});

/** One served unit's findings: every file under `dist/` that carries a copy no host can claim. */
export const inspectServedUnit = Effect.fn('HostedCredentialClaim.inspect')(function* inspect(unitDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const dist = path.join(unitDirectory, 'dist');
  const problems: string[] = [];
  for (const relative of yield* builtScripts(fs, dist)) {
    const file = path.join('dist', relative);
    const source = yield* fs.readFileString(path.join(unitDirectory, file)).pipe(Effect.orElseSucceed(() => ''));
    problems.push(...(yield* problemsOf(file, source, dist)));
  }
  return problems;
});

const exposeUnit = Effect.fn('HostedCredentialClaim.exposeUnit')(function* exposeUnit(unitDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const bundle = path.join(unitDirectory, API_BUNDLE);
  if (!(yield* fs.exists(bundle))) {
    return yield* new HostedCredentialClaimError({ reason: `${bundle} is missing; build the unit first` });
  }
  const source = yield* fs.readFileString(bundle);
  const exposed = yield* exposeBundleClaim(source).pipe(
    Effect.mapError((problem) => new HostedCredentialClaimError({ reason: `${bundle}: ${problem.reason}` })),
  );
  if (exposed !== source) {
    yield* fs.writeFileString(bundle, exposed);
  }
  return storeCopiesIn(source) > 0;
});

/** Exposes the API bundle's claim of each unit (idempotent); answers whether the unit's bundle carries a copy. */
export const exposeUnitClaims = (unitDirectories: readonly string[]) =>
  Effect.forEach(unitDirectories, exposeUnit, { concurrency: 1 });

/** Fails when any of the units serves a copy no host can claim. */
export const checkUnitClaims = Effect.fn('HostedCredentialClaim.check')(function* check(
  unitDirectories: readonly string[],
) {
  const found = yield* Effect.forEach(
    unitDirectories,
    (unit) => inspectServedUnit(unit).pipe(Effect.map((problems) => problems.map((problem) => `${unit}: ${problem}`))),
    { concurrency: 1 },
  );
  const problems = found.flat();
  if (problems.length > 0) {
    return yield* new HostedCredentialClaimError({ reason: problems.join('\n') });
  }
  return yield* Effect.void;
});
