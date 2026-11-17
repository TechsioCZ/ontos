#!/usr/bin/env node
/**
 * Proves that the app runtime tree still runs without the installed packages it leaves out
 * (app-runtime-excluded-packages.txt; pack-app-release.sh omits them). Run from app/ on the installed workspace with
 * every unit's dist/ in place: in the Zerops build before the pack (a failure fails the build, so nothing deploys
 * and the running release keeps serving) and in the stage workflow's `prove_app_runtime` job.
 *
 * 1. No package that stays depends on a left-out one: every link inside node_modules/.pnpm resolves to a kept store
 *    directory.
 * 2. A workspace package links a left-out package only as a devDependency.
 * 3. No file the app host or the migrator reaches (relative imports, `scripts/…` paths it starts, the public entries of
 *    the workspace packages it imports) imports a left-out package.
 * 4. Every served unit's dist/zerops-entry.mjs imports, its API bundle included, while the left-out store directories
 *    are moved to ASIDE (and always back): the entries resolve exactly as in the shipped tree. An entry that fails
 *    for any other reason (an environment this proof does not provide) is reported, not counted.
 *
 *   node scripts/zerops/prove-app-runtime.mts
 */
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Data, Duration, Effect, FileSystem, Option, Schema, Stream } from 'effect';
import { Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { readHostedUnits, UNIT_ENTRY, workspaceRoot } from './hosted-units.mts';

export const EXCLUSION_LIST = 'scripts/zerops/app-runtime-excluded-packages.txt';
const STORE = 'node_modules/.pnpm';
/** Where the proof moves the left-out store directories while it imports the entries; they return afterwards. */
export const ASIDE = 'node_modules/.zerops-left-out';
/** The app host and every process it starts by a workspace path. */
export const RUNTIME_ENTRIES = ['scripts/zerops/app-host.mts', 'scripts/run-zerops-migrator.mjs'] as const;
const WORKSPACE_PARENTS = ['apps', 'verticals', 'packages'] as const;
const ENTRY_CONCURRENCY = 4;
/** Runtime files read at once by check 3 (one by one it took 40 s of the Zerops build over ~5100 files). */
const FILE_CONCURRENCY = 32;
const ENTRY_BUDGET = Duration.minutes(2);
const RESOLUTION_FAILURE =
  /ERR_RUNTIME_EXCLUDED|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|MODULE_NOT_FOUND|Cannot find (?:module|package)/u;

export class AppRuntimeProofError extends Data.TaggedError('AppRuntimeProofError')<{ readonly message: string }> {}

/** The npm name patterns of the list: one per line, `#` comments and blank lines ignored. */
export const parseExclusions = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/** pnpm's store directory names of one npm name pattern: `@scope/name-*` matches `@scope+name-<anything>@<version…>`. */
export const storeDirectoryPattern = (name: string): RegExp =>
  new RegExp(
    `^${name
      .replaceAll('.', String.raw`\.`)
      .replace('/', String.raw`\+`)
      .replaceAll('*', '[^@]*')}@`,
    'u',
  );

/** The package name a bare specifier names (`@scope/name/sub` → `@scope/name`), or none for a path. */
export const packageOf = (specifier: string): Option.Option<string> => {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes(':')) {
    return Option.none();
  }
  const parts = specifier.split('/');
  return Option.some(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier));
};

/** A package name a pattern of the list matches (its store directory name, as pnpm writes it). */
const isExcludedName = (patterns: readonly RegExp[], name: string) =>
  patterns.some((pattern) => pattern.test(`${name.replace('/', '+')}@`));

/** The store directories of <root> the runtime tree leaves out. */
export const excludedStoreDirectories = (root: string, names: readonly string[]) =>
  Effect.gen(function* excludedDirectories() {
    const fs = yield* FileSystem.FileSystem;
    const patterns = names.map(storeDirectoryPattern);
    const entries = yield* fs.readDirectory(path.join(root, STORE));
    return new Set(entries.filter((entry) => patterns.some((pattern) => pattern.test(entry))));
  });

const MANIFEST = 'package.json';

/** One node_modules entry and, when it is a link, the absolute path it points to. */
const linkOf = (directory: string, name: string) =>
  Effect.gen(function* linkOfProgram() {
    const fs = yield* FileSystem.FileSystem;
    const target = yield* fs.readLink(path.join(directory, name)).pipe(Effect.option);
    return { name, target: target.pipe(Option.map((link) => path.resolve(directory, path.dirname(name), link))) };
  });

/** Every `<name>` or `@scope/<name>` entry of a node_modules directory, with its link target when it is a link. */
const linkedPackages = (directory: string) =>
  Effect.gen(function* linkedPackagesProgram() {
    const fs = yield* FileSystem.FileSystem;
    // Store files (lock.yaml) and packages without dependencies have no node_modules directory.
    const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed((): readonly string[] => []));
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith('@')) {
        const scoped = yield* fs.readDirectory(path.join(directory, entry)).pipe(Effect.orElseSucceed(() => []));
        names.push(...scoped.map((child) => `${entry}/${child}`));
      } else if (!entry.startsWith('.')) {
        names.push(entry);
      }
    }
    return yield* Effect.forEach(names, (name) => linkOf(directory, name), { concurrency: 1 });
  });

/** The store directory a link target lies in, if any. */
const storeDirectoryOf = (storeRoot: string, target: string): Option.Option<string> => {
  const relative = path.relative(storeRoot, target);
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? Option.none()
    : Option.fromNullishOr(relative.split(path.sep)[0]);
};

/** The left-out store directory one link points into, if it does. */
const excludedTarget = (storeRoot: string, excluded: ReadonlySet<string>, target: Option.Option<string>) =>
  target.pipe(
    Option.flatMap((resolved) => storeDirectoryOf(storeRoot, resolved)),
    Option.filter((store) => excluded.has(store)),
  );

/** One kept store directory's links into left-out ones. */
const keptStoreViolations = (storeRoot: string, excluded: ReadonlySet<string>, directory: string) =>
  Effect.gen(function* keptStoreViolationsProgram() {
    const violations: string[] = [];
    for (const { name, target } of yield* linkedPackages(path.join(storeRoot, directory, 'node_modules'))) {
      const store = excludedTarget(storeRoot, excluded, target);
      if (Option.isSome(store)) {
        violations.push(`${directory} depends on ${name} (${store.value})`);
      }
    }
    return violations;
  });

/** Check 1: links from a kept store directory into a left-out one. */
export const storeLinkViolations = (root: string, excluded: ReadonlySet<string>) =>
  Effect.gen(function* storeLinkViolationsProgram() {
    const fs = yield* FileSystem.FileSystem;
    const storeRoot = path.join(root, STORE);
    const kept = (yield* fs.readDirectory(storeRoot)).filter(
      (entry) => !excluded.has(entry) && entry !== 'node_modules',
    );
    const found = yield* Effect.forEach(kept, (directory) => keptStoreViolations(storeRoot, excluded, directory), {
      concurrency: 32,
    });
    return found.flat();
  });

const ManifestSchema = Schema.fromJsonString(
  Schema.Struct({
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    name: Schema.optional(Schema.String),
  }),
);
/** A source file a package.json names (its `exports` and `main` targets), as `"./…"`. */
const MANIFEST_TARGET = /"(?<value>\.\/[\w./@-]+\.(?:mts|mjs|ts|tsx|js|cjs|cts))"/gu;

/** A workspace package's manifest, and the source files it names. */
const readManifest = (root: string, directory: string) =>
  Effect.gen(function* readManifestProgram() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path.join(root, directory, MANIFEST));
    const manifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(text);
    const targets = [...text.matchAll(MANIFEST_TARGET)].map((match) => match.groups?.value ?? '');
    return { directory, manifest, targets };
  });

/** The root and every workspace package of apps/, verticals/ and packages/ (the parts the runtime tree ships). */
const workspacePackages = (root: string) =>
  Effect.gen(function* workspacePackagesProgram() {
    const fs = yield* FileSystem.FileSystem;
    const directories = ['.'];
    for (const parent of WORKSPACE_PARENTS) {
      for (const child of yield* fs.readDirectory(path.join(root, parent)).pipe(Effect.orElseSucceed(() => []))) {
        if (yield* fs.exists(path.join(root, parent, child, MANIFEST))) {
          directories.push(`${parent}/${child}`);
        }
      }
    }
    return yield* Effect.forEach(directories, (directory) => readManifest(root, directory), { concurrency: 1 });
  });

/** Check 2: a workspace package links a left-out package as anything but a devDependency. */
export const importerLinkViolations = (root: string, excluded: ReadonlySet<string>) =>
  Effect.gen(function* importerLinkViolationsProgram() {
    const storeRoot = path.join(root, STORE);
    const violations: string[] = [];
    for (const { directory, manifest } of yield* workspacePackages(root)) {
      for (const { name, target } of yield* linkedPackages(path.join(root, directory, 'node_modules'))) {
        const store = excludedTarget(storeRoot, excluded, target);
        if (Option.isSome(store) && manifest.devDependencies?.[name] === undefined) {
          violations.push(`${directory} links ${name} (${store.value}) and it is not a devDependency`);
        }
      }
    }
    return violations;
  });

const SPECIFIERS = [
  /\b(?:import|export)\s+(?!type\b)(?:[^'";]*?\bfrom\s*)?["'](?<value>[^"'\n]+)["']/gu,
  /\b(?:import|require|require\.resolve)\s*\(\s*["'](?<value>[^"'\n]+)["']\s*\)/gu,
];
/** A workspace path a runtime file starts or reads: `scripts/…`, `apps/…`, `verticals/…`, `packages/…`. */
const WORKSPACE_PATH =
  /["'`](?<value>(?:scripts|apps|verticals|packages)\/[\w./@-]+\.(?:mts|mjs|ts|js|cjs|cts))["'`]/gu;
const SOURCE_FILE = /\.(?:mts|mjs|ts|tsx|js|cjs|cts)$/u;
const ALTERNATIVES = new Map([
  ['.cjs', ['.cts']],
  ['.js', ['.ts', '.tsx']],
  ['.mjs', ['.mts']],
]);
const SUFFIXES = ['.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];

/** The first existing file a relative specifier names, the way the runtime's TypeScript stripping resolves it. */
const resolveRelative = (from: string, specifier: string) =>
  Effect.gen(function* resolveRelativeProgram() {
    const fs = yield* FileSystem.FileSystem;
    const base = path.resolve(path.dirname(from), specifier);
    const extension = path.extname(base);
    const candidates = [
      base,
      ...(ALTERNATIVES.get(extension) ?? []).map((alternative) => `${base.slice(0, -extension.length)}${alternative}`),
      ...SUFFIXES.map((suffix) => `${base}${suffix}`),
    ];
    for (const candidate of candidates.filter((name) => SOURCE_FILE.test(name))) {
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === 'File') {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  });

/** The bare and relative specifiers, and the workspace paths, one source line names. */
const lineReferences = (line: string) => ({
  paths: [...line.matchAll(WORKSPACE_PATH)].map((match) => match.groups?.value ?? ''),
  specifiers: SPECIFIERS.flatMap((pattern) => [...line.matchAll(pattern)].map((match) => match.groups?.value ?? '')),
});

interface WorkspacePackage {
  readonly directory: string;
  readonly targets: readonly string[];
}

/** One reached file: the left-out packages it imports, and the workspace files it leads to. */
const fileReferences = (
  root: string,
  file: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
  patterns: readonly RegExp[],
) =>
  Effect.gen(function* fileReferencesProgram() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ''));
    const violations: string[] = [];
    const next: Option.Option<string>[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      const references = lineReferences(line);
      for (const specifier of references.specifiers) {
        const named = packageOf(specifier);
        if (Option.isNone(named)) {
          next.push(specifier.startsWith('.') ? yield* resolveRelative(file, specifier) : Option.none());
        } else {
          if (isExcludedName(patterns, named.value)) {
            violations.push(`${path.relative(root, file)}:${String(index + 1)} imports ${specifier}`);
          }
          const workspace = packages.get(named.value);
          for (const target of workspace?.targets ?? []) {
            next.push(yield* resolveRelative(path.join(root, workspace?.directory ?? '.', MANIFEST), target));
          }
        }
      }
      for (const relative of references.paths) {
        next.push(yield* resolveRelative(path.join(root, MANIFEST), `./${relative}`));
      }
    }
    return { next: next.flatMap(Option.toArray), violations };
  });

/** Check 3: the reachable workspace files of the host and the migrator that import a left-out package. */
export const workspaceImportViolations = (root: string, entries: readonly string[], names: readonly string[]) =>
  Effect.gen(function* workspaceImportViolationsProgram() {
    const patterns = names.map(storeDirectoryPattern);
    const packages = new Map(
      (yield* workspacePackages(root)).flatMap(({ directory, manifest, targets }) =>
        manifest.name === undefined ? [] : [[manifest.name, { directory, targets }] as const],
      ),
    );
    const seen = new Set<string>();
    const violations: string[] = [];
    // Breadth first, one level at a time: the files of a level are read side by side, in the order a queue would
    // take them, so the reached set and the order of the findings are those of a one-by-one walk.
    let level = entries.map((entry) => path.join(root, entry));
    while (level.length > 0) {
      const fresh: string[] = [];
      for (const file of level) {
        if (!seen.has(file) && !file.includes(`${path.sep}node_modules${path.sep}`) && !file.endsWith('.d.ts')) {
          seen.add(file);
          fresh.push(file);
        }
      }
      const found = yield* Effect.forEach(fresh, (file) => fileReferences(root, file, packages, patterns), {
        concurrency: FILE_CONCURRENCY,
      });
      violations.push(...found.flatMap((references) => references.violations));
      level = found.flatMap((references) => references.next);
    }
    return { reached: seen.size, violations };
  });

/** Check 4: one unit entry, imported in its own Node process behind the exclusion hook. */
const importEntry = (root: string, entry: string) =>
  Effect.scoped(
    Effect.gen(function* importEntryProgram() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            'await import(process.argv[1]); process.exit(0);',
            pathToFileURL(entry).href,
          ],
          {
            cwd: root,
            env: { NODE_ENV: 'production' },
            extendEnv: true,
          },
        ),
      );
      const [status, stderr] = yield* Effect.all(
        [handle.exitCode.pipe(Effect.map(Number)), handle.stderr.pipe(Stream.decodeText(), Stream.mkString)],
        { concurrency: 'unbounded' },
      );
      return { status, stderr };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: ENTRY_BUDGET,
      orElse: () => Effect.succeed({ status: -1, stderr: `did not finish within ${Duration.format(ENTRY_BUDGET)}` }),
    }),
  );

interface EntryFinding {
  readonly failure: Option.Option<string>;
  readonly note: Option.Option<string>;
}
const PROVEN: EntryFinding = { failure: Option.none(), note: Option.none() };
const counted = (message: string): EntryFinding => ({ failure: Option.some(message), note: Option.none() });
const reported = (message: string): EntryFinding => ({ failure: Option.none(), note: Option.some(message) });

const ERROR_LINE = /\bError\b(?: \[[A-Z_]+\])?: /u;
const NOT_STARTED = { status: -1, stderr: 'could not be started' };

/** The line that says why an import failed: the error's own message line, else any line naming the failure. */
const failureReason = (stderr: string) => {
  const lines = stderr.split('\n');
  const line =
    lines.find((candidate) => ERROR_LINE.test(candidate)) ??
    lines.find((candidate) => RESOLUTION_FAILURE.test(candidate)) ??
    lines.find((candidate) => candidate.trim() !== '') ??
    '';
  return line.trim();
};

/** One entry's finding: proven, counted (missing, or a resolution failure) or only reported. */
const proveEntry = (root: string, entry: string) =>
  Effect.gen(function* proveEntryProgram() {
    const fs = yield* FileSystem.FileSystem;
    const name = path.relative(root, entry);
    if (!(yield* fs.exists(entry).pipe(Effect.orElseSucceed(() => false)))) {
      return counted(`${name} is missing`);
    }
    const { status, stderr } = yield* importEntry(root, entry).pipe(Effect.orElseSucceed(() => NOT_STARTED));
    if (status === 0) {
      return PROVEN;
    }
    return RESOLUTION_FAILURE.test(stderr)
      ? counted(`${name}: ${failureReason(stderr)}`)
      : reported(`${name} (not counted): ${failureReason(stderr)}`);
  });

/** Check 4 over every entry: resolution failures count, any other failure is only reported. */
export const entryImportFindings = (root: string, entries: readonly string[]) =>
  Effect.gen(function* entryImportFindingsProgram() {
    const results = yield* Effect.forEach(entries, (entry) => proveEntry(root, entry), {
      concurrency: ENTRY_CONCURRENCY,
    });
    return {
      failures: results.flatMap(({ failure }) => Option.toArray(failure)),
      notes: results.flatMap(({ note }) => Option.toArray(note)),
    };
  });

/** Moves the left-out store directories to ASIDE for the duration of <effect>, and always back. */
export const withLeftOutAside = <A, E, R>(
  root: string,
  excluded: ReadonlySet<string>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* withLeftOutAsideProgram() {
    const fs = yield* FileSystem.FileSystem;
    const store = path.join(root, STORE);
    const aside = path.join(root, ASIDE);
    const move = (from: string, to: string) =>
      Effect.forEach([...excluded], (directory) => fs.rename(path.join(from, directory), path.join(to, directory)), {
        concurrency: 1,
        discard: true,
      });
    return yield* Effect.acquireUseRelease(
      fs.makeDirectory(aside, { recursive: true }).pipe(Effect.andThen(move(store, aside))),
      () => effect,
      () => move(aside, store).pipe(Effect.andThen(fs.remove(aside, { recursive: true })), Effect.orDie),
    );
  });

const secondsOf = (took: Duration.Duration) => `${(Duration.toMillis(took) / 1000).toFixed(1)}s`;

const report = (title: string, lines: readonly string[]) =>
  lines.length === 0 ? Effect.void : Console.error([`${title}:`, ...lines.map((line) => `  ${line}`)].join('\n'));

/** All four checks over <root>; fails when any of checks 1-4 found something. */
export const proveAppRuntime = (root: string) =>
  Effect.gen(function* proveRuntimeTree() {
    const fs = yield* FileSystem.FileSystem;
    const names = parseExclusions(yield* fs.readFileString(path.join(root, EXCLUSION_LIST)));
    const excluded = yield* excludedStoreDirectories(root, names);
    const [storesTook, stores] = yield* Effect.timed(storeLinkViolations(root, excluded));
    const [importersTook, importers] = yield* Effect.timed(importerLinkViolations(root, excluded));
    const [workspaceTook, workspace] = yield* Effect.timed(workspaceImportViolations(root, RUNTIME_ENTRIES, names));
    const entries = (yield* readHostedUnits).map(({ directory }) => path.join(root, directory, UNIT_ENTRY));
    // The entries import from the tree as it ships: the left-out store directories are moved away meanwhile.
    const [importsTook, imports] = yield* Effect.timed(
      withLeftOutAside(root, excluded, entryImportFindings(root, entries)),
    );
    // Where the build's time goes, check by check, and on what machine: the entries import ENTRY_CONCURRENCY at once.
    yield* Console.log(
      `app runtime checks took: store links ${secondsOf(storesTook)}, workspace links ${secondsOf(importersTook)}, runtime files ${secondsOf(workspaceTook)}, unit entries ${secondsOf(importsTook)} (${String(ENTRY_CONCURRENCY)} at once on ${String(availableParallelism())} cores, ${String(Math.round(totalmem() / 2 ** 30))} GiB)`,
    );
    yield* report('kept packages that depend on a left-out package', stores);
    yield* report('workspace packages that need a left-out package at runtime', importers);
    yield* report('runtime files that import a left-out package', workspace.violations);
    yield* report('unit entries that do not import without the left-out packages', imports.failures);
    yield* report('unit entries that failed for another reason', imports.notes);
    const failures = stores.length + importers.length + workspace.violations.length + imports.failures.length;
    if (failures > 0) {
      return yield* new AppRuntimeProofError({
        message: `the app runtime tree is not complete without its left-out packages (${String(failures)} findings)`,
      });
    }
    return yield* Console.log(
      `app runtime proven without ${String(excluded.size)} left-out store directories: links intact, ${String(workspace.reached)} host and migrator files, ${String(entries.length)} unit entries imported`,
    );
  });

const command = Command.make('prove-app-runtime', {}, () => proveAppRuntime(workspaceRoot));

if (import.meta.main) {
  NodeRuntime.runMain(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)), {
    disableErrorReporting: false,
  });
}
