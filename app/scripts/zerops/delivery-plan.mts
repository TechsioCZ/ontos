import { createHash } from 'node:crypto';
import path from 'node:path';

import { Effect, Order, Schema } from 'effect';
import { sort as sortArray } from 'effect/Array';

export const SERVICES = ['app', 'storefront', 'shop', 'n1'] as const;
export type DeliveryService = (typeof SERVICES)[number];
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Service = Schema.Literals(SERVICES);
/**
 * One run's plan, the `zerops-delivery-plan` artifact every run uploads before it changes stage. A later plan reads
 * only `services` back (a run that changed stage without being verified hands its services on), so a plan of any
 * schema version decodes as a past run's plan.
 */
export const PastPlanSchema = Schema.Struct({ services: Schema.Array(Service) });
export const DeliveryPlanSchema = Schema.Struct({
  affectedUnits: Schema.Array(Schema.String),
  base: Schema.String,
  changedPaths: Schema.Array(Schema.String),
  full: Schema.Boolean,
  migrations: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(2),
  services: Schema.Array(Service),
  sourceRevision: Revision,
  /** The runs after the base that changed stage without being verified; their services are redeployed. */
  unverifiedRuns: Schema.Array(Schema.Number),
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
/**
 * What an earlier run that ended without success did to stage, read from GitHub (scripts/zerops/read-delivery-history.sh):
 * `mutated` says whether any attempt reached the step that precedes every stage mutation (MUTATION_MARKER), null when
 * its jobs could not be read; `services` is its plan, null when that could not be read.
 */
export interface RunMutation {
  readonly mutated: boolean | null;
  readonly runId: number;
  readonly services: readonly DeliveryService[] | null;
}
/** The changes between the verified base and HEAD, from GitHub's compare API; null when it could not be read. */
export interface Comparison {
  readonly ancestor: boolean;
  readonly base: string;
  readonly changedPaths: readonly string[];
  /** GitHub lists at most 300 changed files; a list that may be cut short cannot select services. */
  readonly truncated: boolean;
}
export interface DeliveryInputs {
  readonly comparison: Comparison | null;
  /**
   * Every tracked path a delivered service reads: the inputs of every unit, and every file reached from the app host,
   * the migrator, the Zerops build and deploy commands and the stage delivery workflow (deliveryReads).
   */
  readonly deliveryReads: ReadonlySet<string>;
  readonly forceFull: boolean;
  readonly head: string;
  readonly mutations: readonly RunMutation[];
  readonly packages: readonly WorkspacePackage[];
  readonly previousRuns: readonly PriorRun[];
  readonly runAttempt: number;
  readonly runNumber: number;
  readonly units: readonly DeliveryUnit[];
}
/**
 * The step that runs right before the first stage mutation of a run (secret syncs and pushes come after it). A run
 * whose jobs never started it did not change stage.
 */
export const MUTATION_MARKER = 'Mark the actual deployment attempt';
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
    // A shell comment describing the later release pack is not a unit-build dependency.
    const commands = driver.replaceAll(/^[\t ]*#.*$/gmu, '');
    for (const token of matches(SCRIPT_TOKEN, commands)) {
      const script = path.posix.normalize(token.replace(/^\$\{?root\}?\//u, ''));
      if (!BUILD_DRIVER_TOOLS.has(script)) {
        add(`app/${script}`);
      }
    }
    const prebuilt = groupValue(PREBUILT_PACKAGES.exec(commands)) ?? '';
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

/** The workflow whose runs deliver stage, and the branch it delivers. */
export const STAGE_WORKFLOW = '.github/workflows/zerops-stage.yml';
export const STAGE_BRANCH = 'demo/sales-crm';
/**
 * What runs on stage or delivers it besides the units: the app host and the migrator it runs, the Zerops build, init
 * and start commands, and the stage workflow's own steps with the delivery action that holds its pushes, warm-up and
 * proofs. Every tracked file these reach is a delivery read.
 */
export const DELIVERY_ROOTS = [
  'app/scripts/zerops/app-host.mts',
  'app/scripts/run-zerops-migrator.mjs',
  'app/zerops.yaml',
  STAGE_WORKFLOW,
  '.github/actions/deliver-stage/action.yml',
] as const;
/** In shell and YAML, any slash-separated token can be a path a command reads (`$root/` and `${root}/` stripped). */
const PATH_TOKEN = /(?:\$\{?root\}?\/)?(?<value>[\w@.-]+(?:\/[\w@.-]+)+)/gu;
/**
 * Every tracked file a delivered service reads: each unit's inputs, and every file reached from DELIVERY_ROOTS through
 * the reference graph (imports, path literals, whole workspace packages) and, in shell and YAML, through path tokens
 * resolved from the repository root, from app/ and from the file's own directory. `texts` holds the text of roots the
 * graph does not read as sources (the YAML files).
 */
export const deliveryReads = (
  graph: UnitInputGraph,
  units: readonly DeliveryUnit[],
  texts: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* collectDeliveryReads() {
    const reads = new Set<string>();
    for (const unit of units) {
      for (const entry of (yield* unitInputs(unit.directory, graph)).inputs) {
        reads.add(entry.path);
      }
    }
    const pending: string[] = [];
    const add = (filepath: string) => {
      if (graph.tracked.has(filepath) && !reads.has(filepath)) {
        reads.add(filepath);
        pending.push(filepath);
      }
    };
    const packagesAdded = new Set<string>();
    for (const root of DELIVERY_ROOTS) {
      add(root);
      // A root that is already a unit input is still followed.
      pending.push(root);
    }
    for (const filepath of pending) {
      const reached = graph.reach(filepath);
      for (const file of [...reached.files, ...reached.directories.flatMap((directory) => graph.under(directory))]) {
        add(file);
      }
      for (const root of reached.packages.filter((entry) => !packagesAdded.has(entry))) {
        packagesAdded.add(root);
        for (const file of graph.under(root)) {
          if (!isTestInput(file) && !isUnitDocumentation(file)) {
            add(file);
          }
        }
      }
      if (/\.(?:sh|ya?ml)$/u.test(filepath)) {
        const text = texts.get(filepath) ?? graph.workspace.sources.get(filepath) ?? '';
        for (const token of matches(PATH_TOKEN, text.replaceAll(/^[\t ]*#.*$/gmu, ''))) {
          for (const candidate of [token, `app/${token}`, path.posix.join(path.posix.dirname(filepath), token)]) {
            add(path.posix.normalize(candidate));
          }
        }
      }
    }
    return reads;
  });
const newestFirst = sortArray(Order.mapInput(Order.Number, (run: PriorRun) => -run.run_number));
/** This workflow's earlier runs on the stage branch, newest first. */
const earlierRuns = (runs: readonly PriorRun[], runNumber: number) =>
  newestFirst(
    runs.filter((run) => run.head_branch === STAGE_BRANCH && run.path === STAGE_WORKFLOW && run.run_number < runNumber),
  );
/**
 * The verified base: the newest earlier run that ended in success. A green run deployed and verified every service its
 * plan selected, and its plan held every service an earlier unverified run had changed, so stage was verified at its
 * commit. Null when no such run is in the history read.
 */
export const previousVerifiedBase = (runs: readonly PriorRun[], runNumber: number): PriorRun | null =>
  earlierRuns(runs, runNumber).find((run) => run.status === 'completed' && run.conclusion === 'success') ?? null;
/** The runs after the base, newest first: each ended without success, or has not ended. */
export const runsSinceBase = (runs: readonly PriorRun[], runNumber: number, base: PriorRun) =>
  earlierRuns(runs, runNumber).filter((run) => run.run_number > base.run_number);

/**
 * Paths no service reads by role, whatever the reference graph says: the stage delivery itself and the shared inputs
 * of every build and install. A change here deploys every service.
 */
const DELIVERY_MACHINERY: readonly RegExp[] = [
  /^\.github\/workflows\/zerops-stage\.yml$/u,
  /^\.github\/actions\//u,
  /^app\/zerops(?:-import)?\.yaml$/u,
  /^app\/(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.mise\.toml|\.npmrc)$/u,
  /^app\/patches\//u,
  /^app\/database\//u,
  /^app\/topology\//u,
];
/**
 * Paths that are read by no delivered service unless the reference graph reaches them (DeliveryInputs.deliveryReads):
 * other CI workflows, repository and lint tooling, and app scripts. A test outside every workspace package counts too.
 * The deploy scripts of app/scripts/zerops stay inputs whatever the graph says.
 */
const UNREAD_UNLESS_REACHED: readonly RegExp[] = [
  /^\.github\/workflows\//u,
  /^app\/scripts\/(?!zerops\/)/u,
  /^app\/tools\//u,
  /^app\/quality-audit\//u,
  /^app\/(?:oxfmt|oxlint|rstest)\.config\.ts$/u,
  /^app\/docker-compose\.yml$/u,
  /^app\/\.env\.example$/u,
  /^(?:app\/)?(?:\.agents|\.codex)\//u,
  /^lefthook\.yml$/u,
];
/** Why a changed path outside the storefronts and the units selects every service, or null when it selects none. */
const sharedPathReason = (filepath: string, input: DeliveryInputs): string | null => {
  if (DELIVERY_MACHINERY.some((pattern) => pattern.test(filepath))) {
    return `delivery machinery or shared install input: ${filepath}`;
  }
  if (filepath.startsWith('app/scripts/zerops/') && !isTestInput(filepath)) {
    return `stage delivery script: ${filepath}`;
  }
  if (input.deliveryReads.has(filepath)) {
    return `read by a delivered service: ${filepath}`;
  }
  const insidePackage = input.packages.some((entry) => inside(filepath, entry.directory));
  if (!insidePackage && (isTestInput(filepath) || UNREAD_UNLESS_REACHED.some((pattern) => pattern.test(filepath)))) {
    return null;
  }
  return `shared or unknown input: ${filepath}`;
};

const dependentUnitIds = (
  units: readonly DeliveryUnit[],
  closures: ReadonlyMap<string, readonly string[]>,
  directory: string,
): readonly string[] => units.filter((unit) => closures.get(unit.id)?.includes(directory) === true).map(({ id }) => id);

/** Why the plan cannot start from a verified base and a complete list of changes, or null when it can. */
const fullReleaseReason = (input: DeliveryInputs, base: PriorRun | null): string | null => {
  if (input.forceFull) {
    return 'a dispatched run deploys every service';
  }
  if (input.runAttempt > 1) {
    return 'a re-run attempt deploys every service';
  }
  if (base === null) {
    return 'no verified earlier run in the history read';
  }
  const { comparison } = input;
  if (comparison === null || comparison.base !== base.head_sha) {
    return `the changes since the verified base ${base.head_sha} could not be read`;
  }
  if (!comparison.ancestor) {
    return `the verified base ${base.head_sha} is not an ancestor of this commit`;
  }
  return comparison.truncated ? 'the list of changed files may be cut short' : null;
};

/** What a plan has selected so far, and why it deploys every service when it does. */
interface Selection {
  readonly affected: Set<string>;
  full: boolean;
  readonly migrations: string[];
  readonly reasons: string[];
  readonly selected: Set<DeliveryService>;
  readonly unverifiedRuns: number[];
}
const forceFull = (selection: Selection, reason: string) => {
  selection.full = true;
  selection.reasons.push(reason);
};

/**
 * A run since the base that changed stage and was not verified leaves its services on an unverified release: they
 * deploy again. A run that never reached the mutation marker changed nothing. Anything unknown deploys everything.
 */
const selectUnverifiedRuns = (input: DeliveryInputs, base: PriorRun, selection: Selection) => {
  for (const run of runsSinceBase(input.previousRuns, input.runNumber, base)) {
    const mutation = input.mutations.find((entry) => entry.runId === run.id);
    if (run.status !== 'completed') {
      forceFull(selection, `run ${run.id} has not ended`);
    } else if (mutation === undefined || mutation.mutated === null) {
      forceFull(selection, `whether run ${run.id} changed stage could not be read`);
    } else if (mutation.mutated) {
      selection.unverifiedRuns.push(run.id);
      if (mutation.services === null) {
        forceFull(selection, `run ${run.id} changed stage and its plan could not be read`);
      } else {
        for (const service of mutation.services) {
          selection.selected.add(service);
        }
        selection.reasons.push(
          `run ${run.id} changed ${mutation.services.join(', ') || 'nothing'} without being verified`,
        );
      }
    }
  }
};

interface Closures {
  readonly n1: readonly string[];
  readonly storefront: readonly string[];
  readonly units: ReadonlyMap<string, readonly string[]>;
}
const MIGRATION_PATH = /\/(?:drizzle\/|drizzle[^/]*\.config\.|src\/database\/|scripts\/verify-.*schema)/u;

/** An owner unit's change: the app, every unit that depends on the owner, and the storefronts built from it. */
const selectOwnerChange = (
  filepath: string,
  owner: DeliveryUnit,
  input: DeliveryInputs,
  closures: Closures,
  selection: Selection,
) => {
  selection.selected.add('app');
  for (const id of dependentUnitIds(input.units, closures.units, owner.directory)) {
    selection.affected.add(id);
  }
  if (closures.storefront.includes(owner.directory)) {
    selection.selected.add('storefront');
    selection.selected.add('shop');
  }
  if (closures.n1.includes(owner.directory)) {
    selection.selected.add('n1');
  }
  if (MIGRATION_PATH.test(filepath)) {
    selection.migrations.push(filepath);
  }
};

const selectChangedPath = (filepath: string, input: DeliveryInputs, closures: Closures, selection: Selection) => {
  if (inside(filepath, STOREFRONT_DIRECTORY)) {
    selection.selected.add('storefront');
    selection.selected.add('shop');
    for (const id of dependentUnitIds(input.units, closures.units, STOREFRONT_DIRECTORY)) {
      selection.selected.add('app');
      selection.affected.add(id);
    }
    return;
  }
  if (inside(filepath, N1_DIRECTORY)) {
    selection.selected.add('n1');
    return;
  }
  const owner = input.units.find((unit) => inside(filepath, unit.directory));
  if (owner !== undefined && !inside(filepath, `${owner.directory}/shared`)) {
    selectOwnerChange(filepath, owner, input, closures, selection);
    return;
  }
  const reason = owner === undefined ? sharedPathReason(filepath, input) : `shared unit input: ${filepath}`;
  if (reason !== null) {
    forceFull(selection, reason);
  }
};

export const planDelivery = (input: DeliveryInputs) =>
  Effect.gen(function* createDeliveryPlan() {
    const base = previousVerifiedBase(input.previousRuns, input.runNumber);
    const selection: Selection = {
      affected: new Set(),
      full: false,
      migrations: [],
      reasons: [],
      selected: new Set(),
      unverifiedRuns: [],
    };
    const fullReason = fullReleaseReason(input, base);
    if (fullReason !== null) {
      forceFull(selection, fullReason);
    }
    if (base !== null) {
      selectUnverifiedRuns(input, base, selection);
    }
    const units = new Map<string, readonly string[]>();
    for (const unit of input.units) {
      units.set(unit.id, yield* workspaceClosure(unit.directory, input.packages));
    }
    const closures: Closures = {
      n1: yield* workspaceClosure(N1_DIRECTORY, input.packages),
      storefront: yield* workspaceClosure(STOREFRONT_DIRECTORY, input.packages),
      units,
    };
    const changedPaths = selection.full ? [] : (input.comparison?.changedPaths ?? []);
    for (const filepath of changedPaths.filter((entry) => !isDocumentation(entry))) {
      selectChangedPath(filepath, input, closures, selection);
    }
    if (selection.full) {
      for (const service of SERVICES) {
        selection.selected.add(service);
      }
      for (const unit of input.units) {
        selection.affected.add(unit.id);
      }
    }
    return {
      affectedUnits: sortArray(Order.String)([...selection.affected]),
      base: base?.head_sha ?? '',
      changedPaths: input.comparison?.changedPaths ?? [],
      full: selection.full,
      migrations: selection.migrations,
      reasons: selection.reasons,
      schemaVersion: 2 as const,
      services: SERVICES.filter((service) => selection.selected.has(service)),
      sourceRevision: input.head,
      unverifiedRuns: selection.unverifiedRuns,
    };
  });
