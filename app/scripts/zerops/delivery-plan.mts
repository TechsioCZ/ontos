import { createHash } from 'node:crypto';
import path from 'node:path';

import { Effect, Order, Schema } from 'effect';
import { sort as sortArray } from 'effect/Array';

export const SERVICES = ['app', 'storefront', 'shop', 'n1'] as const;
export type DeliveryService = (typeof SERVICES)[number];
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
// `n1` is optional: receipts written before the N1 service existed carry no pin for it, and must still decode.
const SourcePins = Schema.Struct({
  app: Revision,
  n1: Schema.optionalKey(Revision),
  shop: Revision,
  storefront: Revision,
});
export const DeliveryAttemptSchema = Schema.Struct({
  runAttempt: Schema.Number,
  runId: Schema.Number,
  sourceRevision: Revision,
});
export type DeliveryAttempt = typeof DeliveryAttemptSchema.Type;
export const DeliveryReceiptSchema = Schema.Struct({
  lastAttempt: DeliveryAttemptSchema,
  runAttempt: Schema.Number,
  runId: Schema.Number,
  schemaVersion: Schema.Literal(1),
  services: SourcePins,
  validatedHead: Revision,
});
export type DeliveryReceipt = typeof DeliveryReceiptSchema.Type;
export const DeliveryPlanSchema = Schema.Struct({
  affectedUnits: Schema.Array(Schema.String),
  base: Schema.String,
  changedPaths: Schema.Array(Schema.String),
  full: Schema.Boolean,
  migrations: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
  receipt: DeliveryReceiptSchema,
  schemaVersion: Schema.Literal(1),
  services: Schema.Array(Schema.Literals(SERVICES)),
  sourceRevision: Revision,
});
const DigestInputsSchema = Schema.Struct({
  closure: Schema.Array(Schema.String),
  environment: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  inputs: Schema.Array(Schema.Struct({ identity: Schema.String, path: Schema.String })),
  version: Schema.Literal(3),
});
const BuildManifestSchema = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }),
);
const STOREFRONT_DIRECTORY = 'app/akros-storefront';
const N1_DIRECTORY = 'app/n1-storefront';

export interface WorkspacePackage {
  readonly directory: string;
  readonly name: string;
  /**
   * The workspace packages a built unit can contain without importing them: `dependencies`, `peerDependencies` and
   * `optionalDependencies` (Module Federation shares declared dependencies). Absent means all of them.
   */
  readonly runtimeDependencies?: readonly string[];
  readonly workspaceDependencies: readonly string[];
}
export interface DeliveryUnit {
  readonly directory: string;
  readonly id: string;
}
export interface GitEntry {
  readonly identity: string;
  readonly path: string;
}
export interface PriorRun {
  readonly conclusion: string | null;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly id: number;
  readonly path: string;
  readonly run_attempt: number;
  readonly run_number: number;
  readonly status: string;
}
export interface DeliveryInputs {
  readonly ancestor: boolean;
  readonly changedPaths: readonly string[];
  readonly forceFull: boolean;
  readonly head: string;
  readonly packages: readonly WorkspacePackage[];
  readonly previousAttempt: DeliveryAttempt | null;
  readonly previousReceipt: DeliveryReceipt | null;
  readonly previousRuns: readonly PriorRun[];
  readonly runAttempt: number;
  readonly runId: number;
  readonly runNumber: number;
  readonly units: readonly DeliveryUnit[];
}
export class WorkspaceInputsInvalid extends Schema.TaggedError<WorkspaceInputsInvalid>()('WorkspaceInputsInvalid', {
  reason: Schema.String,
}) {}

export const isDocumentation = (filepath: string): boolean =>
  filepath.startsWith('docs/') ||
  filepath.startsWith('app/docs/') ||
  /(?:^|\/)(?:README|AGENTS|CLAUDE|CONTRIBUTING|SECURITY|CHANGELOG|LICENSE)\.md$/u.test(filepath);
const inside = (filepath: string, directory: string): boolean => filepath.startsWith(`${directory}/`);

const closureOf = (
  directory: string,
  packages: readonly WorkspacePackage[],
  dependenciesOf: (entry: WorkspacePackage) => readonly string[],
) =>
  Effect.gen(function* resolveWorkspaceClosure() {
    const byName = new Map(packages.map((entry) => [entry.name, entry]));
    const byDirectory = new Map(packages.map((entry) => [entry.directory, entry]));
    const seen = new Set<string>();
    const pending = [directory];
    for (const current of pending) {
      if (seen.has(current)) {
        continue;
      }
      const entry = byDirectory.get(current);
      if (entry === undefined) {
        return yield* new WorkspaceInputsInvalid({ reason: `Missing workspace manifest: ${current}` });
      }
      seen.add(current);
      for (const name of dependenciesOf(entry)) {
        const dependency = byName.get(name);
        if (dependency === undefined) {
          return yield* new WorkspaceInputsInvalid({ reason: `Unresolved workspace dependency ${name} in ${current}` });
        }
        pending.push(dependency.directory);
      }
    }
    return sortArray(Order.String)([...seen]);
  });
/** Resolve committed workspace manifests, not node_modules symlinks or the runner's installed graph. */
export const workspaceClosure = (directory: string, packages: readonly WorkspacePackage[]) =>
  closureOf(directory, packages, (entry) => entry.workspaceDependencies);
/**
 * The packages a unit's build output can hold without the unit importing them. A devDependency (a test helper, a
 * fixture owner) enters a unit's identity only when included code references it, which the reference graph follows.
 */
export const runtimeClosure = (directory: string, packages: readonly WorkspacePackage[]) =>
  closureOf(directory, packages, (entry) => entry.runtimeDependencies ?? entry.workspaceDependencies);

/*
 * A unit's identity: a cached build of the unit may be reused if and only if nothing its build can read changed.
 *
 * Included (fail closed):
 * - every file of the unit's workspace closure (the unit and, transitively, the workspace packages it depends on),
 *   except tests, fixtures and documentation;
 * - every file reached from an included file by a static reference: imports, re-exports, `require`, `import()`,
 *   `new URL(…, import.meta.url)`, CSS `@import`/`@source`/`@plugin`/`url()`, tsconfig `extends`/`references`, a
 *   workspace package named by a bare specifier (all of it), the nearest package.json, and every string literal
 *   outside comments that names a tracked file (the paths code reads);
 * - build-app.sh, every script it names (except BUILD_DRIVER_TOOLS) and every script the unit's own `build` script
 *   runs, with their reference graphs;
 * - every other path at the repository or app root that is not classified below (lockfile, workspace and tool
 *   pins, patches, tsconfigs, topology, Module Federation sharing, Git ignore rules and any new root file);
 * - the build variables of the environment, as values (see buildEnvironment).
 * Excluded, each with its reason: tests and fixtures (never bundled; a test file a build does import is reached
 * and included), documentation, other workspace packages and tool scripts the build neither runs nor reaches, and
 * NON_BUILD_PATHS. The commit is NOT part of the identity: a kept unit keeps the release identity it was built with.
 */

/** Why a tracked path is not part of a unit's identity. */
const UnitInputExclusionSchema = Schema.Literals([
  'documentation',
  'non-build',
  'other-package',
  'test',
  'unused-script',
]);
type UnitInputExclusion = typeof UnitInputExclusionSchema.Type;
export interface ExcludedInput {
  readonly path: string;
  readonly reason: UnitInputExclusion;
}
interface NonBuildPath {
  readonly pattern: RegExp;
  readonly reason: string;
}
/** Root paths no unit build reads. A path not listed here (and not docs, tests, scripts or a package) is an input. */
const NON_BUILD_PATHS: readonly NonBuildPath[] = [
  {
    pattern: /^\.github\//u,
    reason: 'GitHub workflows and actions: a build sees them only through its environment, hashed as values',
  },
  { pattern: /^(?:app\/)?(?:\.agents|\.codex)\//u, reason: 'coding-agent skills, plans and configuration' },
  { pattern: /^lefthook\.yml$/u, reason: 'Git hooks' },
  { pattern: /^\.deployignore$/u, reason: 'Zerops packaging rules, applied to the built tree' },
  {
    pattern: /^app\/zerops(?:-import)?\.yaml$/u,
    reason: 'Zerops project and service definitions, applied after the build',
  },
  { pattern: /^app\/quality-audit\//u, reason: 'quality gate configuration and lint suppressions' },
  { pattern: /^app\/tools\/oxlint\//u, reason: 'lint rules' },
  { pattern: /^app\/(?:oxfmt|oxlint|rstest)\.config\.ts$/u, reason: 'format, lint and test runner configuration' },
  { pattern: /^app\/docker-compose\.yml$/u, reason: 'local development containers' },
  { pattern: /^app\/\.env\.example$/u, reason: 'an example; no environment loader reads .env.example' },
  { pattern: /^node_modules\//u, reason: 'pnpm state of the repository root; the app installs into app/node_modules' },
];
/**
 * build-app.sh drives every unit build and exports its environment. Every script it names is an input of every
 * unit (owner-entry.mts writes the served entry into dist, its imports included) unless it is listed here.
 */
export const BUILD_DRIVER = 'app/scripts/zerops/build-app.sh';
/** Scripts build-app.sh names that write nothing into a unit's output, and why. */
export const BUILD_DRIVER_TOOLS = new Map([
  ['scripts/materialize-outbox-worker.mjs', 'bundles the Outbox Worker host, outside every unit'],
  ['scripts/outbox-worker-host.generated.mts', "lists the Outbox Worker host's owners, read only for that host"],
  ['scripts/zerops/delivery-plan-cli.mts', 'computes these identities; build-app.sh only compares them'],
  ['scripts/zerops/outbox-build-digest.mjs', 'the Outbox Worker host cache, outside every unit'],
]);
/**
 * Reads a build step makes outside its reference graph. The Shell's build checks the Tailwind candidate projection
 * against every vertical's UI sources (VERTICAL_UI_SOURCES of the script); a stale projection must fail that build,
 * so the Shell is rebuilt whenever those sources change.
 */
const BUILD_STEP_READS = new Map([
  [
    'app/scripts/generate-shell-ui-candidates.mts',
    /^app\/verticals\/[^/]+\/(?:src\/|vertical\.manifest\.ts$|vertical\.runtime-declaration\.ts$)/u,
  ],
]);
/** build-app.sh typechecks these packages before any unit build, which then reads their declarations. */
const PREBUILT_PACKAGES = /^\s*for project in (?<value>[^;]+);\s*do\b/mu;
const TEST_PATH = /(?:^|\/)(?:tests|__tests__|fixtures|__fixtures__)\/|\.(?:test|spec)\.[^/]+$/u;
const SCRIPT_TOKEN = /[^\s"'&|;()]+\.(?:[cm]?[jt]s|sh)(?=$|[\s"'&|;()])/gu;
const SCRIPT_CALL = /\bpnpm\s+(?:run\s+)?(?<value>[\w:.-]+)/gu;
const IMPORT_REFERENCES = [
  /\bfrom\s*["'](?<value>[^"'\n]+)["']/gu,
  /\bimport\s*["'](?<value>[^"'\n]+)["']/gu,
  /\b(?:import|require|require\.resolve|import\.meta\.resolve)\s*\(\s*["'](?<value>[^"'\n]+)["']/gu,
  /\bnew\s+URL\(\s*["'](?<value>[^"'\n]+)["']\s*,\s*import\.meta\.url/gu,
  /\/\/\/\s*<reference\s+path=["'](?<value>[^"']+)["']/gu,
];
const STYLE_REFERENCES = [
  /@(?:import|source|plugin|config|reference)\s+(?:not\s+)?(?:url\(\s*)?["'](?<value>[^"']+)["']/gu,
  /\burl\(\s*["']?(?<value>[^"')\s]+)["']?\s*\)/gu,
];
/**
 * Tailwind's automatic source detection scans the whole project (the unit being built), tests included. It is on
 * unless `@import 'tailwindcss'` says `source(none)`; a stylesheet from node_modules may import Tailwind without it.
 */
const TAILWIND_IMPORT = /@import\s+["']tailwindcss["'](?<value>[^;]*);/gu;
const STYLE_IMPORT = /@import\s+(?:url\(\s*)?["'](?<value>[^"']+)["']/gu;
const TSCONFIG_EXTENDS = /"extends"\s*:\s*(?<value>\[[^\]]*\]|"[^"]*")/gu;
const TSCONFIG_REFERENCE = /"path"\s*:\s*"(?<value>[^"]+)"/gu;
const QUOTED = /"(?<value>[^"]+)"/gu;
const PATH_LITERAL = /["'`](?<value>(?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.*-]+)+)["'`]/gu;
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.d.ts'];
const SOURCE_EXTENSIONS = new Map([
  ['.cjs', ['.cts']],
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
]);
/**
 * Build variables, as values: everything a bundler or Modern.js reads at build time. Locale, time zone, CI flags and
 * the toolchain are absent on purpose: build-app.sh also runs in the Zerops build, which must compute the same
 * identities to keep the units CI built (.mise.toml and the lockfile pin the toolchain and dependencies instead).
 */
const BUILD_VARIABLE =
  /^(?:MODERN_|ULTRAMODERN_|PUBLIC_|RSPACK_|RSBUILD_|BROWSERSLIST|ONTOS_[A-Z0-9_]*ORIGIN$|NODE_ENV$|NODE_OPTIONS$|BABEL_ENV$)/u;
/** A forced revision or marker would only relabel output; the commit is deliberately not an input. */
const IDENTITY_OVERRIDE = /^ULTRAMODERN_(?:SOURCE_REVISION|BUILD_MARKER)$/u;

/** Modern.js's file-system router scans src/routes, so nothing there counts as a test. */
export const isTestInput = (filepath: string): boolean =>
  TEST_PATH.test(filepath) && !filepath.includes('/src/routes/');
const isUnitDocumentation = (filepath: string): boolean =>
  isDocumentation(filepath) ||
  /(?:^|\/)docs\/.+\.mdx?$/u.test(filepath) ||
  /^(?:app\/)?[^/]+\.md$/u.test(filepath) ||
  /^app\/specs\/.+\.md$/u.test(filepath) ||
  filepath === 'LICENSE';
/** The tracked files whose text can name another build input. */
export const isReferenceSource = (filepath: string): boolean =>
  /\.(?:[cm]?[jt]sx?|css|sh)$/u.test(filepath) || /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/u.test(filepath);
/** The build variables among `name=value` pairs of an environment, sorted by name. */
export const buildEnvironment = (variables: readonly (readonly [string, string])[]) =>
  sortArray(Order.mapInput(Order.String, ([name]: readonly [string, string]) => name))(
    variables.filter(([name]) => BUILD_VARIABLE.test(name) && !IDENTITY_OVERRIDE.test(name)),
  );

/** A unit identity's view of one commit: tracked paths, the package graph and the text of reference sources. */
interface UnitWorkspace {
  readonly entries: readonly GitEntry[];
  readonly packages: readonly WorkspacePackage[];
  readonly sources: ReadonlyMap<string, string>;
}
interface Reach {
  /** Every tracked file below these directories: a Tailwind `@source` scan, tests included. */
  readonly directories: readonly string[];
  readonly files: readonly string[];
  /** Whole workspace packages, without their tests and documentation. */
  readonly packages: readonly string[];
}
const NOTHING: Reach = { directories: [], files: [], packages: [] };
/**
 * Code without its comments, for the path-literal scan only: a comment that names a file is prose, not a read.
 * A regex literal can confuse this scanner, so import references are always read from the full text.
 */
const withoutComments = (text: string) => {
  let output = '';
  let quote = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (quote !== '') {
      const escaped = char === '\\';
      output += escaped ? `${char}${next}` : char;
      if (!escaped && (char === quote || (char === '\n' && quote !== '`'))) {
        quote = '';
      }
      index += escaped ? 2 : 1;
    } else if (char === '/' && (next === '/' || next === '*')) {
      const end = text.indexOf(next === '/' ? '\n' : '*/', index + 2);
      index = end === -1 ? text.length : end + (next === '/' ? 0 : 2);
    } else {
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
      }
      output += char;
      index += 1;
    }
  }
  return output;
};
/** A match's `value` group, if the pattern names one. */
const groupValue = (match: RegExpMatchArray | null): string | undefined => {
  const { value } = match?.groups ?? {};
  return value;
};
const matches = (pattern: RegExp, text: string) =>
  [...text.matchAll(pattern)].map((match) => groupValue(match) ?? match[0]);
const globPattern = (glob: string) =>
  new RegExp(
    `^${glob
      .split(/(?<wildcard>\*\*\/|\*\*|\*)/u)
      .map((part) => {
        if (part === '**/') {
          return '(?:.*/)?';
        }
        if (part === '**') {
          return '.*';
        }
        return part === '*' ? '[^/]*' : part.replaceAll(/[$()+.?[\\\]^{|}]/gu, String.raw`\$&`);
      })
      .join('')}$`,
    'u',
  );

/** Every directory above a path, nearest first. */
const ancestors = (filepath: string) =>
  filepath
    .split('/')
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, parts.length - index).join('/'));

/** The reference graph of one commit. Each file's references are resolved once and shared by every unit. */
export const unitInputGraph = (workspace: UnitWorkspace) => {
  const tracked = new Set(workspace.entries.map((entry) => entry.path));
  const directories = new Set(
    workspace.entries.flatMap((entry) =>
      entry.path
        .split('/')
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join('/')),
    ),
  );
  const packageDirectories = new Set(workspace.packages.map((entry) => entry.directory));
  const byName = sortArray(Order.mapInput(Order.Number, (entry: WorkspacePackage) => -entry.name.length))([
    ...workspace.packages,
  ]);
  const below = new Map<string, readonly string[]>();
  const reaches = new Map<string, Reach>();
  const owningPackage = (filepath: string) =>
    ancestors(filepath).find((directory) => packageDirectories.has(directory));
  const under = (directory: string) => {
    const cached = below.get(directory);
    if (cached !== undefined) {
      return cached;
    }
    const files = workspace.entries.filter((entry) => inside(entry.path, directory)).map((entry) => entry.path);
    below.set(directory, files);
    return files;
  };
  const resolvePath = (target: string): Reach => {
    if (target.includes('*')) {
      const pattern = globPattern(target);
      return { ...NOTHING, files: workspace.entries.map((entry) => entry.path).filter((value) => pattern.test(value)) };
    }
    const extension = path.posix.extname(target);
    const stem = target.slice(0, target.length - extension.length);
    const candidates = [
      target,
      ...(SOURCE_EXTENSIONS.get(extension) ?? []).map((substitute) => `${stem}${substitute}`),
      ...RESOLVED_EXTENSIONS.map((suffix) => `${target}${suffix}`),
      ...RESOLVED_EXTENSIONS.map((suffix) => `${target}/index${suffix}`),
    ];
    const file = candidates.find((candidate) => tracked.has(candidate));
    if (file !== undefined) {
      return { ...NOTHING, files: [file] };
    }
    return directories.has(target) ? { ...NOTHING, directories: [target] } : NOTHING;
  };
  /**
   * A directory that holds a workspace package (or is the app or repository root) is a root locator such as
   * `new URL('../../..', import.meta.url)`: the code then names the files it reads, which the literal scan follows.
   */
  const isLocator = (directory: string) =>
    directory === '' ||
    directory === '.' ||
    directory === 'app' ||
    [...packageDirectories].some((root) => root === directory || inside(root, directory));
  const resolveReference = (from: string, raw: string): Reach => {
    const specifier = raw.startsWith('#') ? raw : (raw.split(/[?#]/u)[0] ?? '');
    if (specifier === '' || specifier.startsWith('/') || /^[a-z][\w+.-]*:/u.test(specifier)) {
      return NOTHING;
    }
    if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
      return resolvePath(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
    }
    if (specifier.startsWith('#')) {
      const owner = owningPackage(from);
      return owner === undefined ? NOTHING : { ...NOTHING, packages: [owner] };
    }
    const named = byName.find((entry) => specifier === entry.name || specifier.startsWith(`${entry.name}/`));
    return named === undefined ? NOTHING : { ...NOTHING, packages: [named.directory] };
  };
  /** In code, a string naming a tracked file (from the file or from app/) is taken as a path the code reads. */
  const resolveLiteral = (from: string, literal: string): readonly string[] =>
    [path.posix.join(path.posix.dirname(from), literal), path.posix.join('app', literal)]
      .map((candidate) => path.posix.normalize(candidate))
      .filter((candidate) => tracked.has(candidate));
  const referencesOf = (filepath: string, text: string): readonly string[] => {
    const name = path.posix.basename(filepath);
    if (/^tsconfig[^/]*\.json$/u.test(name)) {
      const extended = matches(TSCONFIG_EXTENDS, text).flatMap((value) => matches(QUOTED, value));
      // A root tsconfig references every package for the workspace typecheck; no unit build follows those.
      const references = owningPackage(filepath) === undefined ? [] : matches(TSCONFIG_REFERENCE, text);
      return [...extended, ...references];
    }
    if (name.endsWith('.json') || name.endsWith('.sh')) {
      return [];
    }
    return (name.endsWith('.css') ? STYLE_REFERENCES : IMPORT_REFERENCES).flatMap((pattern) => matches(pattern, text));
  };
  const reach = (filepath: string): Reach => {
    const cached = reaches.get(filepath);
    if (cached !== undefined) {
      return cached;
    }
    const text = workspace.sources.get(filepath) ?? '';
    const resolved = referencesOf(filepath, text).map((reference) => resolveReference(filepath, reference));
    const code = /\.[cm]?[jt]sx?$/u.test(filepath);
    const literals = code
      ? matches(PATH_LITERAL, withoutComments(text)).flatMap((literal) => resolveLiteral(filepath, literal))
      : [];
    const stepReads = BUILD_STEP_READS.get(filepath);
    const manifest = ancestors(filepath)
      .map((directory) => `${directory}/package.json`)
      .find((candidate) => tracked.has(candidate));
    const style = filepath.endsWith('.css');
    const named = resolved.flatMap((entry) => entry.directories);
    const owner = owningPackage(filepath);
    const scansProject =
      style &&
      owner !== undefined &&
      (matches(TAILWIND_IMPORT, text).some((options) => !/\bsource\(\s*none\s*\)/u.test(options)) ||
        matches(STYLE_IMPORT, text).some(
          (specifier) =>
            specifier !== 'tailwindcss' &&
            !specifier.startsWith('.') &&
            !byName.some((entry) => specifier === entry.name || specifier.startsWith(`${entry.name}/`)),
        ));
    const result: Reach = {
      // A stylesheet's directories are Tailwind scans, which read every file below them, tests included.
      directories: style ? [...named, ...(scansProject ? [owner] : [])] : [],
      files: [
        ...(style
          ? []
          : named
              .filter((directory) => !isLocator(directory))
              .flatMap((directory) =>
                under(directory).filter((file) => !isTestInput(file) && !isUnitDocumentation(file)),
              )),
        ...resolved.flatMap((entry) => entry.files),
        ...literals,
        ...(stepReads === undefined ? [] : [...tracked].filter((candidate) => stepReads.test(candidate))),
        ...(manifest === undefined ? [] : [manifest]),
      ],
      packages: resolved.flatMap((entry) => entry.packages),
    };
    reaches.set(filepath, result);
    return result;
  };
  return { owningPackage, reach, tracked, under, workspace };
};
export type UnitInputGraph = ReturnType<typeof unitInputGraph>;

/** The scripts a unit's own `build` script runs, following `pnpm run` into its other scripts. */
const buildScriptFiles = (directory: string, graph: UnitInputGraph) =>
  Effect.gen(function* readBuildScripts() {
    const text = graph.workspace.sources.get(`${directory}/package.json`);
    if (text === undefined) {
      return yield* new WorkspaceInputsInvalid({ reason: `Missing unit manifest source: ${directory}/package.json` });
    }
    const scripts =
      (yield* Schema.decodeEffect(BuildManifestSchema)(text).pipe(
        Effect.mapError(
          () => new WorkspaceInputsInvalid({ reason: `Invalid unit manifest: ${directory}/package.json` }),
        ),
      )).scripts ?? {};
    const names = ['build'];
    for (const name of names) {
      for (const called of matches(SCRIPT_CALL, scripts[name] ?? '')) {
        if (Object.hasOwn(scripts, called) && !names.includes(called)) {
          names.push(called);
        }
      }
    }
    return names
      .flatMap((name) => matches(SCRIPT_TOKEN, scripts[name] ?? ''))
      .map((token) => path.posix.normalize(path.posix.join(directory, token)))
      .filter((candidate) => graph.tracked.has(candidate));
  });

const exclusionReason = (filepath: string, closure: readonly string[], graph: UnitInputGraph) => {
  const inClosure = closure.some((root) => inside(filepath, root));
  if (isTestInput(filepath)) {
    return 'test' as const;
  }
  if (isUnitDocumentation(filepath)) {
    return 'documentation' as const;
  }
  if (inClosure) {
    return 'input' as const;
  }
  if (graph.owningPackage(filepath) !== undefined) {
    return 'other-package' as const;
  }
  if (filepath.startsWith('app/scripts/')) {
    return 'unused-script' as const;
  }
  return NON_BUILD_PATHS.some((entry) => entry.pattern.test(filepath)) ? ('non-build' as const) : ('input' as const);
};

/** The committed inputs of one unit, and every tracked path left out with its reason. */
export const unitInputs = (directory: string, graph: UnitInputGraph) =>
  Effect.gen(function* collectUnitInputs() {
    const closure = yield* runtimeClosure(directory, graph.workspace.packages);
    const included = new Set<string>();
    const pending: string[] = [];
    const reachedFrom = new Map<string, string>();
    let current = '';
    const add = (filepath: string) => {
      if (!included.has(filepath) && graph.tracked.has(filepath)) {
        reachedFrom.set(filepath, current);
        included.add(filepath);
        pending.push(filepath);
      }
    };
    const packagesAdded = new Set<string>();
    const addPackage = (root: string) => {
      if (packagesAdded.has(root)) {
        return;
      }
      packagesAdded.add(root);
      for (const filepath of graph.under(root)) {
        if (!isTestInput(filepath) && !isUnitDocumentation(filepath)) {
          add(filepath);
        }
      }
    };
    const excluded: ExcludedInput[] = [];
    current = '(closure or root input)';
    for (const entry of graph.workspace.entries) {
      const reason = exclusionReason(entry.path, closure, graph);
      if (reason === 'input') {
        add(entry.path);
      } else {
        excluded.push({ path: entry.path, reason });
      }
    }
    current = '(build driver)';
    const driver = graph.workspace.sources.get(BUILD_DRIVER);
    if (driver === undefined) {
      return yield* new WorkspaceInputsInvalid({ reason: `Missing build driver: ${BUILD_DRIVER}` });
    }
    add(BUILD_DRIVER);
    for (const token of matches(SCRIPT_TOKEN, driver)) {
      const script = path.posix.normalize(token.replace(/^\$\{?root\}?\//u, ''));
      if (!BUILD_DRIVER_TOOLS.has(script)) {
        add(`app/${script}`);
      }
    }
    const prebuilt = groupValue(PREBUILT_PACKAGES.exec(driver)) ?? '';
    for (const project of prebuilt.split(/\s+/u).filter((value) => value.length > 0)) {
      addPackage(`app/${project}`);
    }
    for (const script of yield* buildScriptFiles(directory, graph)) {
      add(script);
    }
    for (const filepath of pending) {
      current = filepath;
      const reached = graph.reach(filepath);
      for (const file of [...reached.files, ...reached.directories.flatMap((root) => graph.under(root))]) {
        add(file);
      }
      for (const root of reached.packages) {
        addPackage(root);
      }
    }
    return {
      closure,
      excluded: excluded.filter((entry) => !included.has(entry.path)),
      inputs: graph.workspace.entries.filter((entry) => included.has(entry.path)),
      /** Why each input is one: the file that reached it, or the rule that included it. */
      reachedFrom,
    };
  });

interface UnitDigestInput {
  /** The build variables, see buildEnvironment. */
  readonly environment: readonly (readonly [string, string])[];
  readonly graph: UnitInputGraph;
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * A unit's identity and its two parts, so a rebuild can say why: `files` covers the committed inputs alone, and
 * `variables` names each build variable with a short hash of its value (never the value itself).
 */
export const unitIdentity = (directory: string, input: UnitDigestInput) =>
  Effect.gen(function* identifyUnit() {
    const { closure, inputs } = yield* unitInputs(directory, input.graph);
    const encode = Schema.encodeEffect(Schema.fromJsonString(DigestInputsSchema));
    const [digest, files] = yield* Effect.all(
      [
        encode({ closure, environment: input.environment, inputs, version: 3 }),
        encode({ closure, environment: [], inputs, version: 3 }),
      ],
      { concurrency: 1 },
    );
    return {
      digest: sha256(digest),
      files: sha256(files),
      variables: input.environment.map(([name, value]) => `${name}=${sha256(value).slice(0, 12)}`),
    };
  });
export const unitInputDigest = (directory: string, input: UnitDigestInput) =>
  unitIdentity(directory, input).pipe(Effect.map((identity) => identity.digest));

export const previousVerifiedBase = (
  receipt: DeliveryReceipt | null,
  runs: readonly PriorRun[],
  runNumber: number,
): string | null => {
  const [previous] = sortArray(Order.mapInput(Order.Number, (run: PriorRun) => -run.run_number))(
    runs.filter(
      (run) =>
        run.head_branch === 'demo/sales-crm' &&
        run.path === '.github/workflows/zerops-stage.yml' &&
        run.run_number < runNumber,
    ),
  );
  if (
    receipt === null ||
    previous === undefined ||
    previous.status !== 'completed' ||
    previous.conclusion !== 'success' ||
    previous.id !== receipt.runId ||
    previous.run_attempt !== receipt.runAttempt ||
    previous.head_sha !== receipt.validatedHead
  ) {
    return null;
  }
  return receipt.validatedHead;
};
const needsFullRelease = (input: DeliveryInputs, base: string | null) =>
  input.forceFull ||
  input.runAttempt > 1 ||
  base === null ||
  !input.ancestor ||
  input.previousAttempt?.runId !== input.previousReceipt?.lastAttempt.runId ||
  input.previousAttempt?.runAttempt !== input.previousReceipt?.lastAttempt.runAttempt ||
  input.previousAttempt?.sourceRevision !== input.previousReceipt?.lastAttempt.sourceRevision;
const nextAttempt = (input: DeliveryInputs, services: readonly DeliveryService[]) =>
  services.length > 0
    ? { runAttempt: input.runAttempt, runId: input.runId, sourceRevision: input.head }
    : input.previousReceipt?.lastAttempt;

const dependentUnitIds = (
  units: readonly DeliveryUnit[],
  closures: ReadonlyMap<string, readonly string[]>,
  directory: string,
): readonly string[] => units.filter((unit) => closures.get(unit.id)?.includes(directory) === true).map(({ id }) => id);

const nextServicePins = (input: DeliveryInputs, selected: ReadonlySet<DeliveryService>) =>
  Object.fromEntries(
    SERVICES.flatMap((service) => {
      const revision = selected.has(service) ? input.head : input.previousReceipt?.services[service];
      return revision === undefined ? [] : [[service, revision]];
    }),
  );

export const planDelivery = (input: DeliveryInputs) =>
  Effect.gen(function* createDeliveryPlan() {
    const base = previousVerifiedBase(input.previousReceipt, input.previousRuns, input.runNumber);
    const reasons: string[] = [];
    let full = needsFullRelease(input, base);
    if (full) {
      reasons.push('forced, retried, missing/failed previous verified release, or non-ancestor base');
    }
    const selected = new Set<DeliveryService>();
    const affected = new Set<string>();
    const migrations: string[] = [];
    const closures = new Map<string, readonly string[]>();
    for (const unit of input.units) {
      closures.set(unit.id, yield* workspaceClosure(unit.directory, input.packages));
    }
    const storefrontClosure = yield* workspaceClosure(STOREFRONT_DIRECTORY, input.packages);
    const n1Closure = yield* workspaceClosure(N1_DIRECTORY, input.packages);
    for (const filepath of input.changedPaths.filter((entry) => !isDocumentation(entry))) {
      if (inside(filepath, STOREFRONT_DIRECTORY)) {
        selected.add('storefront');
        selected.add('shop');
        for (const id of dependentUnitIds(input.units, closures, STOREFRONT_DIRECTORY)) {
          selected.add('app');
          affected.add(id);
        }
      } else if (inside(filepath, N1_DIRECTORY)) {
        selected.add('n1');
      } else {
        const owner = input.units.find((unit) => inside(filepath, unit.directory));
        if (owner === undefined || inside(filepath, `${owner.directory}/shared`)) {
          full = true;
          reasons.push(`shared or unknown input: ${filepath}`);
        } else {
          selected.add('app');
          for (const id of dependentUnitIds(input.units, closures, owner.directory)) {
            affected.add(id);
          }
          if (storefrontClosure.includes(owner.directory)) {
            selected.add('storefront');
            selected.add('shop');
          }
          if (n1Closure.includes(owner.directory)) {
            selected.add('n1');
          }
          if (/\/(?:drizzle\/|drizzle[^/]*\.config\.|src\/database\/|scripts\/verify-.*schema)/u.test(filepath)) {
            migrations.push(filepath);
          }
        }
      }
    }
    if (full) {
      for (const service of SERVICES) {
        selected.add(service);
      }
      for (const unit of input.units) {
        affected.add(unit.id);
      }
    }
    const services = SERVICES.filter((service) => selected.has(service));
    // A service with no revision yet (N1 before its first deploy) carries no pin, rather than an undefined one.
    const receipt = yield* Schema.decodeUnknownEffect(DeliveryReceiptSchema)({
      lastAttempt: nextAttempt(input, services),
      runAttempt: input.runAttempt,
      runId: input.runId,
      schemaVersion: 1,
      services: nextServicePins(input, selected),
      validatedHead: input.head,
    });
    return {
      affectedUnits: sortArray(Order.String)([...affected]),
      base: base ?? '',
      changedPaths: input.changedPaths,
      full,
      migrations,
      reasons,
      receipt,
      schemaVersion: 1 as const,
      services,
      sourceRevision: input.head,
    };
  });
