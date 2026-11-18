/**
 * A delivery unit's identity: the committed inputs its build can read, for any pipeline that builds units with a build
 * driver (BuildDriver). The stage delivery (scripts/zerops/delivery-plan.mts) and the gates' unit output cache
 * (scripts/ci/unit-output-cache.mts) compute it from the same rules, each with its own driver.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { Effect, Option, Order, Predicate, Schema, Stream } from 'effect';
import { sort as sortArray } from 'effect/Array';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

const DigestInputsSchema = Schema.Struct({
  environment: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  inputs: Schema.Array(Schema.Struct({ identity: Schema.String, path: Schema.String })),
  version: Schema.Literal(4),
});
const BuildManifestSchema = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }),
);

export interface WorkspacePackage {
  readonly directory: string;
  readonly name: string;
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
export class WorkspaceInputsInvalid extends Schema.TaggedError<WorkspaceInputsInvalid>()('WorkspaceInputsInvalid', {
  reason: Schema.String,
}) {}

export const isDocumentation = (filepath: string): boolean =>
  filepath.startsWith('docs/') ||
  filepath.startsWith('app/docs/') ||
  /(?:^|\/)(?:README|AGENTS|CLAUDE|CONTRIBUTING|SECURITY|CHANGELOG|LICENSE)\.md$/u.test(filepath);
export const inside = (filepath: string, directory: string): boolean => filepath.startsWith(`${directory}/`);

/** Resolve committed workspace manifests, not node_modules symlinks or the runner's installed graph. */
export const workspaceClosure = (directory: string, packages: readonly WorkspacePackage[]) =>
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
      for (const name of entry.workspaceDependencies) {
        const dependency = byName.get(name);
        if (dependency === undefined) {
          return yield* new WorkspaceInputsInvalid({ reason: `Unresolved workspace dependency ${name} in ${current}` });
        }
        pending.push(dependency.directory);
      }
    }
    return sortArray(Order.String)([...seen]);
  });

/*
 * A unit's identity: a cached build of the unit may be reused if and only if nothing its build can read changed.
 *
 * Included (fail closed):
 * - every file of the unit's own package, except tests, fixtures and documentation;
 * - every file reached from an included file by a static reference: imports, re-exports, `require`, `import()`,
 *   `new URL(…, import.meta.url)`, CSS `@import`/`@plugin`/`url()`, tsconfig `extends` and the tsconfig of each
 *   `references` project, the nearest package.json, the nearest tsconfig.json of code (esbuild reads it for every
 *   file it bundles), and every string literal outside comments that names a tracked file (the paths code reads);
 * - every file below a directory or matching a glob a build scans: a Tailwind `@source` or `source(…)` (tests
 *   included, Tailwind reads them), and a directory a string literal in code names (a locale, migration or asset
 *   folder; tests and documentation excluded);
 * - what the installed tools of the unit's `build` script read across the workspace (TOOL_READS);
 * - for a workspace package named by a bare specifier, its manifest and the targets of that subpath in its `exports`
 *   under every condition (packageEntries): the bundler, TypeScript, the deploy trace and Node all resolve the
 *   specifier through that map. The deploy trace also resolves the subpath the legacy way and carries what it finds
 *   with its imports, so every file that resolution can select counts, followed (legacyCandidates): `<package><subpath>`
 *   with an extension, its `index`, and a `package.json` in that directory with the files its `main` selects. A unit
 *   whose build walks every export of the packages it carries counts all of them (EXPORT_WALKING_STEPS). A package
 *   whose `exports` cannot be read that way (none, an unexported subpath, a pattern, a directory or an untracked
 *   target) counts whole. A declared dependency the unit never names is no input: no
 *   build step reads it (Module Federation shares only npm packages);
 * - the build driver, every script it names (except its tools), its extra inputs and every script the unit's own
 *   `build` script runs, with their reference graphs;
 * - every other path at the repository or app root that is not classified below (lockfile, workspace and tool
 *   pins, patches, tsconfigs, topology, Module Federation sharing, Git ignore rules and any new root file);
 * - the build variables of the environment, as values, and the build switches (see buildEnvironment).
 * Excluded, each with its reason: tests and fixtures (never bundled; a test file a build does import is reached
 * and included), documentation, the files of other workspace packages and the tool scripts the build neither runs
 * nor reaches, and NON_BUILD_PATHS. The commit is NOT part of the identity: a kept unit keeps the release identity it was built with.
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
 * The script that drives every unit build of one pipeline and exports its environment. Every script it names is an
 * input of every unit unless `tools` lists it with the reason it writes nothing into a unit's output. `extraInputs`
 * are the scripts it runs through a variable (a post-build step), which the text scan cannot see; they are inputs too,
 * with everything they reach. A `for project in <packages>; do` loop in the driver names packages it typechecks before
 * any unit build, whose declarations every unit then reads.
 */
export interface BuildDriver {
  readonly extraInputs: readonly string[];
  readonly path: string;
  readonly tools: ReadonlyMap<string, string>;
}
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
/**
 * Build steps that read every export of each workspace package the unit names, not only the subpaths it imports: the
 * Shell's packaging walks the ES module entries of every workspace package it carries, imported or not.
 */
const EXPORT_WALKING_STEPS = new Set(['app/scripts/complete-packaged-node-dependencies.mts']);
/** The build driver typechecks these packages before any unit build, which then reads their declarations. */
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
  /@(?:import|plugin|config|reference)\s+(?:url\(\s*)?["'](?<value>[^"']+)["']/gu,
  /\burl\(\s*["']?(?<value>[^"')\s]+)["']?\s*\)/gu,
];
/** Tailwind scans: `@source` (an exclusion counts too) and the base of `@import 'tailwindcss' source(…)`. */
const STYLE_SCANS = [/@source\s+(?:not\s+)?["'](?<value>[^"']+)["']/gu, /\bsource\(\s*["'](?<value>[^"']+)["']\s*\)/gu];
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
 * the toolchain are absent on purpose: a driver may also run in a deploy's own build, which must compute the same
 * identities to keep the units CI built (.mise.toml and the lockfile pin the toolchain and dependencies instead).
 */
const BUILD_VARIABLE =
  /^(?:MODERN_|MODERNJS_|ULTRAMODERN_|PUBLIC_|RSPACK_|RSBUILD_|BROWSERSLIST|ONTOS_[A-Z0-9_]*ORIGIN$|NODE_ENV$|NODE_OPTIONS$|BABEL_ENV$)/u;
/**
 * Switches a unit's build configuration reads outside the variable families above, with what each changes. Stage does
 * not support them (scripts/zerops/build-environment.sh unsets them); every identity hashes their effective value.
 */
export const BUILD_SWITCHES = new Map([
  ['ONTOS_CI_TYPECHECK_SEPARATE', 'drops JavaScript source maps and server declarations (shared-contracts tooling)'],
  ['ONTOS_INTERNAL_SYMMY_INGRESS', "mounts the Symmy REST prefix on the Shell's BFF (Shell modern.config.ts)"],
]);
/** A forced revision or marker would only relabel output; the commit is deliberately not an input. */
export const IDENTITY_OVERRIDES: ReadonlySet<string> = new Set([
  'ULTRAMODERN_BUILD_MARKER',
  'ULTRAMODERN_SOURCE_REVISION',
]);
/** Whether a unit build reads this variable, so an identity hashes its value. */
export const isBuildVariable = (name: string): boolean =>
  (BUILD_VARIABLE.test(name) || BUILD_SWITCHES.has(name)) && !IDENTITY_OVERRIDES.has(name);

/** Modern.js's file-system router scans src/routes, so nothing there counts as a test. */
export const isTestInput = (filepath: string): boolean =>
  TEST_PATH.test(filepath) && !filepath.includes('/src/routes/');
export const isUnitDocumentation = (filepath: string): boolean =>
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
    variables.filter(([name]) => isBuildVariable(name)),
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
  /** Workspace packages named by a bare specifier and counted by their exports (see EXPORT_WALKING_STEPS). */
  readonly named: readonly string[];
  /** Whole workspace packages, without their tests and documentation. */
  readonly packages: readonly string[];
}
const NOTHING: Reach = { directories: [], files: [], named: [], packages: [] };
const LegacyManifestSchema = Schema.fromJsonString(
  Schema.Struct({ main: Schema.optionalKey(Schema.String), module: Schema.optionalKey(Schema.String) }),
);
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
export const matches = (pattern: RegExp, text: string) =>
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

/** An `exports` target naming one file of its package: no subpath pattern, no directory. */
const ExportFileSchema = Schema.String.check(Schema.isPattern(/^\.\/[^*]*[^*/]$/u));
/** An `exports` value that names files only, under any subpaths and conditions (`null` exports nothing). */
type ExportsValue = string | null | readonly ExportsValue[] | { readonly [key: string]: ExportsValue };
const ExportsValueSchema: Schema.Codec<ExportsValue> = Schema.suspend(() =>
  Schema.Union([
    ExportFileSchema,
    Schema.Null,
    Schema.Array(ExportsValueSchema),
    Schema.Record(Schema.String, ExportsValueSchema),
  ]),
);
const ExportsManifestSchema = Schema.fromJsonString(Schema.Struct({ exports: ExportsValueSchema }));
/** The value a subpath (`.` or `./name`) resolves through; a map without subpath keys is the conditions of `.`. */
const subpathExport = (exports: ExportsValue, subpath: string): ExportsValue => {
  const subpaths = Predicate.isObject(exports) ? Object.entries(exports).filter(([key]) => key.startsWith('.')) : [];
  if (subpaths.length === 0) {
    return subpath === '.' ? exports : null;
  }
  return subpaths.find(([key]) => key === subpath)?.[1] ?? null;
};
const exportFiles = (value: ExportsValue): readonly string[] => {
  if (Predicate.isString(value)) {
    return [value];
  }
  return value === null ? [] : Object.values(value).flatMap(exportFiles);
};
/**
 * The files a bare specifier of a workspace package can resolve to under any condition: the package's manifest and
 * the targets of `subpath` in its `exports` map (every subpath when absent). Empty when the map does not name files of
 * the package only (no `exports`, an unexported subpath, a subpath pattern, a directory or an outside target): then
 * the package counts whole.
 */
export const packageEntries = (
  directory: string,
  manifest: string | undefined,
  subpath?: string,
): readonly string[] => {
  const files = Option.match(Schema.decodeUnknownOption(ExportsManifestSchema)(manifest ?? ''), {
    onNone: () => [],
    onSome: (decoded) => exportFiles(subpath === undefined ? decoded.exports : subpathExport(decoded.exports, subpath)),
  }).map((target) => path.posix.normalize(path.posix.join(directory, target)));
  return files.length > 0 && files.every((file) => inside(file, directory))
    ? [`${directory}/package.json`, ...files]
    : [];
};

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
   * Every tracked file a legacy resolution of `target` can select, as the deploy trace and Node resolve it: the file
   * with any extension, the directory's `index`, and the directory's own package.json with every file its `main` or
   * `module` names (resolved the same way). All count, not only the first, so a file that starts to win changes the
   * identity too.
   */
  const legacyCandidates = (target: string, depth = 0): readonly string[] => {
    const manifest = `${target}/package.json`;
    const selected = Option.match(Schema.decodeUnknownOption(LegacyManifestSchema)(workspace.sources.get(manifest)), {
      onNone: () => [],
      onSome: (decoded) => [decoded.main, decoded.module].filter(Predicate.isString),
    });
    return [
      target,
      ...RESOLVED_EXTENSIONS.map((suffix) => `${target}${suffix}`),
      ...RESOLVED_EXTENSIONS.map((suffix) => `${target}/index${suffix}`),
      manifest,
      ...(depth > 0
        ? []
        : selected.flatMap((entry) => legacyCandidates(path.posix.normalize(path.posix.join(target, entry)), 1))),
    ].filter((candidate) => tracked.has(candidate));
  };
  /** A Tailwind scan: every file under a directory, or every file a glob matches, tests included. */
  const resolveScan = (from: string, raw: string): Reach => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), raw));
    if (target.includes('*')) {
      return resolvePath(target);
    }
    if (directories.has(target)) {
      return { ...NOTHING, directories: [target] };
    }
    // A missing directory counts once it holds a file: then it is in `directories`.
    return tracked.has(target) ? { ...NOTHING, files: [target] } : NOTHING;
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
    if (named === undefined) {
      return NOTHING;
    }
    const subpath = specifier.slice(named.name.length);
    const entries = packageEntries(
      named.directory,
      workspace.sources.get(`${named.directory}/package.json`),
      `.${subpath}`,
    );
    return entries.length > 0 && entries.every((file) => tracked.has(file))
      ? {
          ...NOTHING,
          files: [...entries, ...legacyCandidates(`${named.directory}${subpath}`)],
          named: [named.directory],
        }
      : { ...NOTHING, packages: [named.directory] };
  };
  /**
   * In code, a string naming a tracked file (from the file or from app/) is taken as a path the code reads, and one
   * naming a directory (not a root locator) as a directory it reads: every file below it except tests and docs.
   */
  const resolveLiteral = (from: string, literal: string): readonly string[] =>
    [path.posix.join(path.posix.dirname(from), literal), path.posix.join('app', literal)]
      .map((candidate) => path.posix.normalize(candidate))
      .flatMap((candidate) => {
        if (tracked.has(candidate)) {
          return [candidate];
        }
        return directories.has(candidate) && !isLocator(candidate)
          ? under(candidate).filter((file) => !isTestInput(file) && !isUnitDocumentation(file))
          : [];
      });
  const referencesOf = (filepath: string, text: string): readonly string[] => {
    const name = path.posix.basename(filepath);
    if (/^tsconfig[^/]*\.json$/u.test(name)) {
      const extended = matches(TSCONFIG_EXTENDS, text).flatMap((value) => matches(QUOTED, value));
      // A root tsconfig references every package for the workspace typecheck; no unit build follows those. A package's
      // reference names a project, whose tsconfig a build can read (its options and its own references).
      const references = owningPackage(filepath) === undefined ? [] : matches(TSCONFIG_REFERENCE, text);
      return [
        ...extended,
        ...references.map((reference) => (reference.endsWith('.json') ? reference : `${reference}/tsconfig.json`)),
      ];
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
    const style = filepath.endsWith('.css');
    const resolved = [
      ...referencesOf(filepath, text).map((reference) => resolveReference(filepath, reference)),
      ...(style
        ? STYLE_SCANS.flatMap((pattern) => matches(pattern, text)).map((raw) => resolveScan(filepath, raw))
        : []),
    ];
    const code = /\.[cm]?[jt]sx?$/u.test(filepath);
    const literals = code
      ? matches(PATH_LITERAL, withoutComments(text)).flatMap((literal) => resolveLiteral(filepath, literal))
      : [];
    const stepReads = BUILD_STEP_READS.get(filepath);
    const nearest = (name: string) =>
      ancestors(filepath)
        .map((directory) => `${directory}/${name}`)
        .find((candidate) => tracked.has(candidate));
    const manifest = nearest('package.json');
    // esbuild reads the nearest tsconfig.json of every file it bundles (jsx, decorators, class fields, paths).
    const tsconfig = code ? nearest('tsconfig.json') : undefined;
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
        ...(tsconfig === undefined ? [] : [tsconfig]),
      ],
      named: resolved.flatMap((entry) => entry.named),
      packages: resolved.flatMap((entry) => entry.packages),
    };
    reaches.set(filepath, result);
    return result;
  };
  return { owningPackage, reach, tracked, under, workspace };
};
export type UnitInputGraph = ReturnType<typeof unitInputGraph>;

/** The topology apps' directories, or more: every workspace package directly below app/apps or app/verticals. */
const appDirectories = (graph: UnitInputGraph) =>
  graph.workspace.packages
    .map((entry) => entry.directory)
    .filter((directory) => /^app\/(?:apps|verticals)\/[^/]+$/u.test(directory));
/**
 * What an installed tool a unit's `build` script runs reads across the workspace, before or besides selecting the unit
 * (read in node_modules/@bleedingdev/modern-js-ultramodern-create; topology, overlays and root manifests are root
 * inputs already). `reads` are evaluated and followed through their imports; of `directories` only the existence is
 * read, so each existing one counts as a path without content.
 */
const TOOL_READS: readonly {
  readonly command: RegExp;
  readonly directories: (graph: UnitInputGraph) => readonly string[];
  readonly reads: (graph: UnitInputGraph) => readonly string[];
}[] = [
  {
    // templates/workspace-scripts/generate-public-surface-assets.mjs imports and validates every topology app's
    // route.meta.ts (tsImport, imports included) before it selects --app, and throws on a symbolic link below an app's
    // src/routes or on a missing src/routes.
    command: /\bultramodern-create\s+ultramodern\s+public-surface\b/u,
    directories: (graph) => appDirectories(graph).map((directory) => `${directory}/src/routes`),
    reads: (graph) => {
      const symlinks = new Set(
        graph.workspace.entries.filter((entry) => entry.identity.startsWith('120000 ')).map((entry) => entry.path),
      );
      return appDirectories(graph).flatMap((directory) =>
        graph.under(`${directory}/src/routes`).filter((file) => file.endsWith('/route.meta.ts') || symlinks.has(file)),
      );
    },
  },
  {
    // dist/esm-node/ultramodern-tooling/config (readUltramodernWorkspaceInputs) reads and checks every topology app's
    // package.json before routes-generate selects --app.
    command: /\bultramodern-create\s+ultramodern\s+routes-generate\b/u,
    directories: () => [],
    reads: (graph) => appDirectories(graph).map((directory) => `${directory}/package.json`),
  },
];

/** The scripts a unit's own `build` script runs, following `pnpm run` into its other scripts, and its commands. */
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
    return {
      commands: names.map((name) => scripts[name] ?? '').join('\n'),
      files: names
        .flatMap((name) => matches(SCRIPT_TOKEN, scripts[name] ?? ''))
        .map((token) => path.posix.normalize(path.posix.join(directory, token)))
        .filter((candidate) => graph.tracked.has(candidate)),
    };
  });

const exclusionReason = (filepath: string, directory: string, graph: UnitInputGraph) => {
  if (isTestInput(filepath)) {
    return 'test' as const;
  }
  if (isUnitDocumentation(filepath)) {
    return 'documentation' as const;
  }
  if (inside(filepath, directory)) {
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
export const unitInputs = (directory: string, graph: UnitInputGraph, driver: BuildDriver) =>
  Effect.gen(function* collectUnitInputs() {
    const included = new Set<string>();
    const pending: string[] = [];
    const reachedFrom = new Map<string, string>();
    let current = '';
    const add = (filepath: string) => {
      if (graph.tracked.has(filepath) && !included.has(filepath)) {
        reachedFrom.set(filepath, current);
        included.add(filepath);
        pending.push(filepath);
      }
    };
    /** Directories whose existence a build step reads: each counts as its path, without content. */
    const existing = new Set<string>();
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
    current = '(unit or root input)';
    for (const entry of graph.workspace.entries) {
      const reason = exclusionReason(entry.path, directory, graph);
      if (reason === 'input') {
        add(entry.path);
      } else {
        excluded.push({ path: entry.path, reason });
      }
    }
    current = '(build driver)';
    const text = graph.workspace.sources.get(driver.path);
    if (text === undefined) {
      return yield* new WorkspaceInputsInvalid({ reason: `Missing build driver: ${driver.path}` });
    }
    add(driver.path);
    // A shell comment is not a unit-build dependency.
    const commands = text.replaceAll(/^[\t ]*#.*$/gmu, '');
    const runs: string[] = [];
    for (const token of matches(SCRIPT_TOKEN, commands)) {
      const script = path.posix.normalize(token.replace(/^\$\{?root\}?\//u, ''));
      if (!driver.tools.has(script)) {
        runs.push(`app/${script}`);
      }
    }
    for (const script of driver.extraInputs) {
      if (!graph.tracked.has(script)) {
        return yield* new WorkspaceInputsInvalid({ reason: `Missing build driver input: ${script}` });
      }
      runs.push(script);
    }
    const prebuilt = groupValue(PREBUILT_PACKAGES.exec(commands)) ?? '';
    for (const project of prebuilt.split(/\s+/u).filter((value) => value.length > 0)) {
      addPackage(`app/${project}`);
    }
    const build = yield* buildScriptFiles(directory, graph);
    runs.push(...build.files);
    for (const script of runs) {
      add(script);
    }
    for (const tool of TOOL_READS.filter((entry) => entry.command.test(build.commands))) {
      current = `(installed tool: ${tool.command.source})`;
      for (const file of tool.reads(graph)) {
        add(file);
      }
      for (const scanned of tool.directories(graph).filter((entry) => graph.under(entry).length > 0)) {
        existing.add(scanned);
      }
    }
    const walksExports = runs.some((script) => EXPORT_WALKING_STEPS.has(script));
    for (const filepath of pending) {
      current = filepath;
      const reached = graph.reach(filepath);
      for (const file of [...reached.files, ...reached.directories.flatMap((root) => graph.under(root))]) {
        add(file);
      }
      for (const root of reached.packages) {
        addPackage(root);
      }
      for (const root of walksExports ? reached.named : []) {
        for (const file of packageEntries(root, graph.workspace.sources.get(`${root}/package.json`))) {
          add(file);
        }
      }
    }
    return {
      excluded: excluded.filter((entry) => !included.has(entry.path)),
      inputs: [
        ...graph.workspace.entries.filter((entry) => included.has(entry.path)),
        ...[...existing].toSorted().map((scanned) => ({ identity: 'directory', path: scanned })),
      ],
      /** Why each input is one: the file that reached it, or the rule that included it. */
      reachedFrom,
      /** The scripts the build runs: the driver's, its extra inputs and those of the unit's `build` script. */
      scripts: runs,
    };
  });

export interface UnitDigestInput {
  readonly driver: BuildDriver;
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
    const { inputs } = yield* unitInputs(directory, input.graph, input.driver);
    const encode = Schema.encodeEffect(Schema.fromJsonString(DigestInputsSchema));
    const [digest, files] = yield* Effect.all(
      [encode({ environment: input.environment, inputs, version: 4 }), encode({ environment: [], inputs, version: 4 })],
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

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  name: Schema.String,
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const AppId = Schema.String.pipe(Schema.brand('DeliveryAppId'));
const Intent = Schema.Struct({ modules: Schema.Array(Schema.Struct({ appId: AppId })) });
const Topology = Schema.Struct({
  shell: Schema.Struct({ path: Schema.String }),
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});

const git = (args: readonly string[]) =>
  Effect.gen(function* runGit() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make('git', args));
    const [stdout, , code] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: 'unbounded' },
    );
    if (Number(code) !== 0) {
      return yield* new WorkspaceInputsInvalid({ reason: `Git command failed: ${args[0]}` });
    }
    return stdout;
  }).pipe(Effect.scoped);
const workspacePackage = (directory: string, manifest: typeof Manifest.Type) => ({
  directory,
  name: manifest.name,
  workspaceDependencies: Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => name),
});
/** The committed text of each of <entries> (blobs), by path, read in one `git cat-file --batch`. */
const readBlobs = (entries: readonly GitEntry[], repository: string) =>
  Effect.gen(function* readCommittedBlobs() {
    const request = new TextEncoder().encode(
      entries.map((entry) => `${entry.identity.split(' ')[2] ?? ''}\n`).join(''),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make('git', ['-C', repository, 'cat-file', '--batch'], { stdin: { stream: Stream.make(request) } }),
    );
    const [chunks, , code] = yield* Effect.all(
      [Stream.runCollect(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: 'unbounded' },
    );
    if (Number(code) !== 0) {
      return yield* new WorkspaceInputsInvalid({ reason: 'Git command failed: cat-file' });
    }
    const output = Buffer.concat([...chunks]);
    const decoder = new TextDecoder();
    const texts = new Map<string, string>();
    let offset = 0;
    for (const entry of entries) {
      const end = output.indexOf(0x0a, offset);
      const size = Number(output.subarray(offset, end).toString('latin1').split(' ')[2]);
      if (end === -1 || !Number.isSafeInteger(size)) {
        return yield* new WorkspaceInputsInvalid({ reason: `Unreadable blob for ${entry.path}` });
      }
      texts.set(entry.path, decoder.decode(output.subarray(end + 1, end + 1 + size)));
      offset = end + 1 + size + 1;
    }
    return texts;
  }).pipe(Effect.scoped);

const WORKSPACE_FILE = 'app/pnpm-workspace.yaml';
const INTENT_FILE = 'app/topology/application-release-intent.json';
const TOPOLOGY_FILE = 'app/topology/reference-topology.json';
const WORKSPACE_PACKAGES = /^packages:[\t ]*\n(?<value>(?:[\t ]+-[^\n]*(?:\n|$))+)/mu;
const LITERAL_DIRECTORY = /^[\w.-]+(?:\/[\w.-]+)*$/u;
const escapeRegExp = (text: string) => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
/**
 * The manifests of the workspace packages app/pnpm-workspace.yaml declares: `<directory>/*` names every package directly
 * below the directory, any other entry one package directory. Another form cannot be resolved and fails.
 */
const workspaceManifestPattern = (text: string) =>
  Effect.gen(function* readWorkspacePackages() {
    const block = groupValue(WORKSPACE_PACKAGES.exec(text));
    if (block === undefined) {
      return yield* new WorkspaceInputsInvalid({ reason: `${WORKSPACE_FILE} declares no packages` });
    }
    const directories = [];
    for (const line of block.split('\n').filter((value) => value.trim().length > 0)) {
      const entry = line
        .replace(/^\s*-\s*/u, '')
        .trim()
        .replaceAll(/^["']|["']$/gu, '');
      const glob = entry.endsWith('/*') ? entry.slice(0, -2) : undefined;
      if (!LITERAL_DIRECTORY.test(glob ?? entry)) {
        return yield* new WorkspaceInputsInvalid({ reason: `Unsupported ${WORKSPACE_FILE} package entry: ${entry}` });
      }
      directories.push(glob === undefined ? escapeRegExp(entry) : `${escapeRegExp(glob)}/[^/]+`);
    }
    return new RegExp(`^app/(?:${directories.join('|')})/package\\.json$`, 'u');
  });

/**
 * The committed workspace of one revision; `repository` is any directory inside the repository (default: here). The
 * manifests and the topology are read in one `git cat-file --batch`, not one `git show` each (56 processes took 4-6 s
 * on a laptop and most of a 15-17 s identity step on a 2-core build).
 */
export const readWorkspace = (revision: string, repository = '.') =>
  Effect.gen(function* readWorkspaceInputs() {
    const listing = yield* git(['-C', repository, 'ls-tree', '-rz', '--full-tree', revision]);
    const entries = listing
      .split('\0')
      .filter((value) => value.length > 0)
      .map((row) => {
        const separator = row.indexOf('\t');
        return { identity: row.slice(0, separator), path: row.slice(separator + 1) };
      });
    const required: GitEntry[] = [];
    for (const filename of [WORKSPACE_FILE, INTENT_FILE, TOPOLOGY_FILE]) {
      const entry = entries.find((candidate) => candidate.path === filename);
      if (entry === undefined) {
        return yield* new WorkspaceInputsInvalid({ reason: `${filename} is not committed at ${revision}` });
      }
      required.push(entry);
    }
    const workspaceManifest = yield* workspaceManifestPattern(
      (yield* readBlobs(required.slice(0, 1), repository)).get(WORKSPACE_FILE) ?? '',
    );
    const manifests = entries.filter((entry) => workspaceManifest.test(entry.path));
    const texts = yield* readBlobs([...manifests, ...required.slice(1)], repository);
    // A function expression, not a generic arrow: tests compile this module with SWC, which refuses `<A,>(…) =>` in .mts.
    const decode = function decode<A>(filename: string, schema: Schema.Codec<A>) {
      return Schema.decodeEffect(Schema.fromJsonString(schema))(texts.get(filename) ?? '');
    };
    const packages = [];
    for (const entry of manifests) {
      const manifest = yield* decode(entry.path, Manifest);
      packages.push(workspacePackage(path.posix.dirname(entry.path), manifest));
    }
    const intent = yield* decode(INTENT_FILE, Intent);
    const topology = yield* decode(TOPOLOGY_FILE, Topology);
    const units: DeliveryUnit[] = [{ directory: `app/${topology.shell.path}`, id: 'shell-super-app' }];
    for (const module of intent.modules) {
      const owner = topology.verticals.find((entry) => entry.id === module.appId);
      if (owner === undefined) {
        return yield* new WorkspaceInputsInvalid({ reason: `Missing topology owner ${module.appId}` });
      }
      units.push({ directory: `app/${owner.path}`, id: module.appId });
    }
    return { entries, packages, units };
  });

/** The committed text of every reference source, read in one `git cat-file --batch`. */
export const readSources = (entries: readonly GitEntry[], repository = '.') =>
  readBlobs(
    entries.filter((entry) => isReferenceSource(entry.path) && entry.identity.includes(' blob ')),
    repository,
  );
