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
const CLAIM_DEFINITION =
  /\bvar (?<name>[A-Za-z_$][\w$]*) = [A-Za-z_$][\w$]*\.fn\(["']HostedModuleCredentials\.claim["']\)/gu;
const EXPOSED = new RegExp(`\\nexport \\{ (?<name>[A-Za-z_$][\\w$]*) as ${BUNDLE_CLAIM_EXPORT} \\};\\n`, 'gu');

/** How many store copies a built JavaScript file carries. */
export const storeCopiesIn = (source: string): number => [...source.matchAll(CLAIM_SPAN)].length;

/**
 * The API bundle with its own copy's claim exposed, unchanged when it carries no copy or already exposes it. More than
 * one copy, or a copy whose claim cannot be located, is refused: such a bundle cannot be claimed as a whole.
 */
export const exposeBundleClaim = (source: string): Effect.Effect<string, HostedCredentialClaimError> => {
  const copies = storeCopiesIn(source);
  if (copies === 0) {
    return Effect.succeed(source);
  }
  const definitions = [...source.matchAll(CLAIM_DEFINITION)].map((match) => match.groups?.name);
  const [name] = definitions;
  if (copies !== 1 || definitions.length !== 1 || name === undefined) {
    return Effect.fail(
      new HostedCredentialClaimError({
        reason: `the bundle carries ${String(copies)} credential store copies with ${String(definitions.length)} locatable claims; exactly one of each can be claimed`,
      }),
    );
  }
  const exposed = [...source.matchAll(EXPOSED)].map((match) => match.groups?.name);
  if (exposed.length === 1 && exposed[0] === name) {
    return Effect.succeed(source);
  }
  if (exposed.length > 0) {
    return Effect.fail(new HostedCredentialClaimError({ reason: 'the bundle exposes a claim that is not its own' }));
  }
  return Effect.succeed(`${source.trimEnd()}\nexport { ${name} as ${BUNDLE_CLAIM_EXPORT} };\n`);
};

/** Whether a bundle exposes its own copy's claim. */
export const exposesBundleClaim = (source: string): boolean => {
  const definitions = [...source.matchAll(CLAIM_DEFINITION)].map((match) => match.groups?.name);
  const exposed = [...source.matchAll(EXPOSED)].map((match) => match.groups?.name);
  return definitions.length === 1 && exposed.length === 1 && exposed[0] === definitions[0];
};

/** The generated entry's line that re-exports the API bundle's claim for the host. */
export const entryClaimExport = `export { ${BUNDLE_CLAIM_EXPORT} as ${ENTRY_CLAIM_EXPORT} } from './api/index.js';`;

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
  if (!exposesBundleClaim(source)) {
    return [`${file} carries a credential store copy whose claim it does not expose`];
  }
  const fs = yield* FileSystem.FileSystem;
  const entry = yield* fs.readFileString(path.join(dist, 'zerops-entry.mjs')).pipe(Effect.option);
  return Option.isSome(entry) && !entry.value.includes(entryClaimExport)
    ? ['dist/zerops-entry.mjs does not hand the host its API bundle claim']
    : [];
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
