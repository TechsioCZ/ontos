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
 *    are moved to ASIDE (and always back): the entries resolve exactly as in the shipped tree. They load in the
 *    processes the app host runs them in (app-host.mts startUnitProcess): the Shell alone, every owner together in
 *    one, so a module the owners share loads once, as it does on stage. An entry that fails for any other reason (an
 *    environment this proof does not provide) is reported, not counted.
 *
 * Check 3 reads only workspace sources, never a store directory, so it runs beside check 4.
 *
 *   node scripts/zerops/prove-app-runtime.mts
 */
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Clock, Console, Data, Duration, Effect, FileSystem, Match, Option, Schema, Stream } from 'effect';
import { Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { readHostedUnits, SHELL_ID, UNIT_ENTRY, workspaceRoot } from './hosted-units.mts';
import type { HostedUnit } from './hosted-units.mts';

export const EXCLUSION_LIST = 'scripts/zerops/app-runtime-excluded-packages.txt';
const STORE = 'node_modules/.pnpm';
/** Where the proof moves the left-out store directories while it imports the entries; they return afterwards. */
export const ASIDE = 'node_modules/.zerops-left-out';
/** The app host and every process it starts by a workspace path. */
export const RUNTIME_ENTRIES = ['scripts/zerops/app-host.mts', 'scripts/run-zerops-migrator.mjs'] as const;
const WORKSPACE_PARENTS = ['apps', 'verticals', 'packages'] as const;
/** Runtime files read at once by check 3 (one by one it took 40 s of the Zerops build over ~5100 files). */
const FILE_CONCURRENCY = 32;
/**
 * Each entry's own import, from the end of the one before it to its own record. The parent enforces it: an entry that
 * blocks its process (a synchronous loop, a blocking child process) never lets a timer inside that process fire.
 */
export const ENTRY_BUDGET = Duration.minutes(2);
/**
 * After an entry ran over its budget, the entries after it import one process each, this many at a time: a hang in a
 * module they share then costs one budget per round of four, not one per entry.
 */
const ALONE_CONCURRENCY = 4;
/** How often the parent reads the results file for the next entry's record. */
const RECORD_POLL = Duration.millis(200);
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

/**
 * What each absolute specifier base resolved to in one walk. The answer depends on the base alone, and the walk asks
 * for the same ones over and over (every file that imports a workspace package resolves all of its public entries).
 */
type Resolutions = Map<string, Option.Option<string>>;

/** The first existing file a relative specifier names, the way the runtime's TypeScript stripping resolves it. */
const resolveRelative = (resolutions: Resolutions, from: string, specifier: string) =>
  Effect.gen(function* resolveRelativeProgram() {
    const fs = yield* FileSystem.FileSystem;
    const base = path.resolve(path.dirname(from), specifier);
    const known = resolutions.get(base);
    if (known !== undefined) {
      return known;
    }
    const extension = path.extname(base);
    const candidates = [
      base,
      ...(ALTERNATIVES.get(extension) ?? []).map((alternative) => `${base.slice(0, -extension.length)}${alternative}`),
      ...SUFFIXES.map((suffix) => `${base}${suffix}`),
    ];
    let resolved = Option.none<string>();
    for (const candidate of candidates.filter((name) => SOURCE_FILE.test(name))) {
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === 'File') {
        resolved = Option.some(candidate);
        break;
      }
    }
    resolutions.set(base, resolved);
    return resolved;
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
  resolutions: Resolutions,
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
          next.push(specifier.startsWith('.') ? yield* resolveRelative(resolutions, file, specifier) : Option.none());
        } else {
          if (isExcludedName(patterns, named.value)) {
            violations.push(`${path.relative(root, file)}:${String(index + 1)} imports ${specifier}`);
          }
          const workspace = packages.get(named.value);
          for (const target of workspace?.targets ?? []) {
            next.push(
              yield* resolveRelative(resolutions, path.join(root, workspace?.directory ?? '.', MANIFEST), target),
            );
          }
        }
      }
      for (const relative of references.paths) {
        next.push(yield* resolveRelative(resolutions, path.join(root, MANIFEST), `./${relative}`));
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
    const resolutions: Resolutions = new Map();
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
      const found = yield* Effect.forEach(
        fresh,
        (file) => fileReferences(root, file, packages, patterns, resolutions),
        { concurrency: FILE_CONCURRENCY },
      );
      violations.push(...found.flatMap((references) => references.violations));
      level = found.flatMap((references) => references.next);
    }
    return { reached: seen.size, violations };
  });

/**
 * Check 4's importer: imports its entries one after another, in this order, in one process, and appends one line per
 * entry to the results file as it ends: proven, or failed (with the error as Node prints it). An error thrown or
 * rejected outside an import (a timer, a promise nobody awaits) is recorded against the entry being imported at the
 * time. A process that ends early (an entry that exits it) or that the parent ends (an entry over its budget) leaves
 * the rest without a line.
 *
 *   node --input-type=module --eval IMPORTER <results file> <entry URL>...
 */
const IMPORTER = [
  "import { appendFileSync } from 'node:fs';",
  "import { inspect } from 'node:util';",
  'const [results, ...entries] = process.argv.slice(1);',
  "let current = '';",
  'const record = (entry, outcome, reason) =>',
  String.raw`  appendFileSync(results, JSON.stringify({ entry, outcome, reason }) + '\n');`,
  "const late = (cause) => record(current, 'late', inspect(cause));",
  "process.on('uncaughtException', late);",
  "process.on('unhandledRejection', late);",
  'for (const entry of entries) {',
  '  current = entry;',
  "  const [outcome, reason] = await import(entry).then(() => ['proven', ''], (cause) => ['failed', inspect(cause)]);",
  '  record(entry, outcome, reason);',
  '}',
  'process.exit(0);',
].join('\n');

const ImportRecordSchema = Schema.fromJsonString(
  Schema.Struct({
    entry: Schema.String,
    outcome: Schema.Literals(['proven', 'failed', 'late']),
    reason: Schema.String,
  }),
);
type ImportRecord = typeof ImportRecordSchema.Type;
const decodeRecord = Schema.decodeUnknownOption(ImportRecordSchema);

const NOT_STARTED = { stalled: false, status: -1, stderr: 'could not be started' };

/** The complete lines of the results file: a line the importer was still writing when it ended is not one. */
const completeLines = (text: string) => text.split('\n').slice(0, -1);

/** How many entries the results so far have ended (proven or failed). */
const endedEntries = (text: string) =>
  completeLines(text).filter((line) => Option.exists(decodeRecord(line), ({ outcome }) => outcome !== 'late')).length;

/** Succeeds once <results> has recorded no further entry for <budget>: the entry importing then is over its budget. */
const stalled = (results: string, budget: Duration.Duration) =>
  Effect.gen(function* stalledProgram() {
    const fs = yield* FileSystem.FileSystem;
    let ended = 0;
    let since = yield* Clock.currentTimeMillis;
    for (;;) {
      yield* Effect.sleep(RECORD_POLL);
      const now = yield* Clock.currentTimeMillis;
      const count = endedEntries(yield* fs.readFileString(results).pipe(Effect.orElseSucceed(() => '')));
      if (count !== ended) {
        ended = count;
        since = now;
      } else if (now - since >= Duration.toMillis(budget)) {
        return { stalled: true, status: -1, stderr: '' };
      }
    }
  });

/**
 * One importer process over <entries> (file URLs): its exit status, its stderr and the lines it recorded, or `stalled`
 * when the parent ended it because an entry ran over <budget>.
 */
const importProcess = (root: string, entries: readonly string[], budget: Duration.Duration) =>
  Effect.scoped(
    Effect.gen(function* importProcessProgram() {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const results = yield* fs.makeTempFileScoped({ prefix: 'prove-app-runtime-' });
      // The race's loser is interrupted, and closing the importer's scope ends the process: with SIGKILL, because an
      // entry that blocks the event loop never runs a SIGTERM handler it installed.
      const ended = yield* Effect.raceFirst(
        Effect.scoped(
          Effect.gen(function* runImporter() {
            const handle = yield* spawner.spawn(
              ChildProcess.make(process.execPath, ['--input-type=module', '--eval', IMPORTER, results, ...entries], {
                cwd: root,
                env: { NODE_ENV: 'production' },
                extendEnv: true,
                killSignal: 'SIGKILL',
                stdout: 'ignore',
              }),
            );
            const [status, stderr] = yield* Effect.all(
              [handle.exitCode.pipe(Effect.map(Number)), handle.stderr.pipe(Stream.decodeText(), Stream.mkString)],
              { concurrency: 'unbounded' },
            );
            return { stalled: false, status, stderr };
          }),
        ).pipe(Effect.orElseSucceed(() => NOT_STARTED)),
        stalled(results, budget),
      );
      const records: ImportRecord[] = [];
      for (const line of completeLines(yield* fs.readFileString(results).pipe(Effect.orElseSucceed(() => '')))) {
        records.push(yield* Schema.decodeUnknownEffect(ImportRecordSchema)(line));
      }
      return { ...ended, records };
    }),
  );

interface EntryFinding {
  readonly failure: Option.Option<string>;
  readonly note: Option.Option<string>;
}
const counted = (message: string): EntryFinding => ({ failure: Option.some(message), note: Option.none() });
const reported = (message: string): EntryFinding => ({ failure: Option.none(), note: Option.some(message) });

const ERROR_LINE = /\bError\b(?: \[[A-Z_]+\])?: /u;

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

/** A failure counts when it is a resolution failure; any other failure is only reported. */
const classified = (name: string, reason: string): EntryFinding =>
  RESOLUTION_FAILURE.test(reason)
    ? counted(`${name}: ${failureReason(reason)}`)
    : reported(`${name} (not counted): ${failureReason(reason)}`);

const recordFinding = (name: string, record: ImportRecord): Option.Option<EntryFinding> =>
  Match.value(record.outcome).pipe(
    Match.when('proven', () => Option.none<EntryFinding>()),
    Match.when('failed', () => Option.some(classified(name, record.reason))),
    Match.when('late', () => Option.some(classified(`${name} (while it imported)`, record.reason))),
    Match.exhaustive,
  );

interface ImporterRun {
  readonly records: readonly ImportRecord[];
  readonly stalled: boolean;
  readonly status: number;
  readonly stderr: string;
}

/**
 * What one importer process over <pending> found: a finding for every entry it ended, and for the entry it stopped at,
 * if any (over its budget, or the process ended); `rest` is every entry after that one.
 */
const runFindings = (
  nameOf: ReadonlyMap<string, string>,
  pending: readonly string[],
  { records, stalled: over, status, stderr }: ImporterRun,
  budget: Duration.Duration,
) => {
  const findings: EntryFinding[] = [];
  const ended = new Set<string>();
  for (const record of records) {
    const finding = recordFinding(nameOf.get(record.entry) ?? record.entry, record);
    if (Option.isSome(finding)) {
      findings.push(finding.value);
    }
    if (record.outcome !== 'late') {
      ended.add(record.entry);
    }
  }
  const stopped = pending.findIndex((entry) => !ended.has(entry));
  if (stopped === -1) {
    return { findings, over: false, rest: [] };
  }
  const name = nameOf.get(pending[stopped] ?? '') ?? '';
  findings.push(
    over
      ? reported(`${name} (not counted): did not finish within ${Duration.format(budget)}`)
      : classified(name, stderr.trim() === '' ? `ended the process (exit status ${String(status)})` : stderr),
  );
  return { findings, over, rest: pending.slice(stopped + 1) };
};

/**
 * One unit process's entries, imported in order in one process as the app host loads them: the findings of each. When
 * an entry ends the process, the entries after it import in a new one. When an entry runs over <budget>, the parent
 * ends the process and imports each entry after it in a process of its own, ALONE_CONCURRENCY at a time: a hang they
 * share then costs one budget per round, never one per entry.
 */
const proveProcess = (root: string, entries: readonly string[], budget: Duration.Duration) =>
  Effect.gen(function* proveProcessProgram() {
    const fs = yield* FileSystem.FileSystem;
    const findings: EntryFinding[] = [];
    const present: string[] = [];
    for (const entry of entries) {
      if (yield* fs.exists(entry).pipe(Effect.orElseSucceed(() => false))) {
        present.push(entry);
      } else {
        findings.push(counted(`${path.relative(root, entry)} is missing`));
      }
    }
    const nameOf = new Map(present.map((entry) => [pathToFileURL(entry).href, path.relative(root, entry)]));
    let pending = [...nameOf.keys()];
    while (pending.length > 0) {
      const run = runFindings(nameOf, pending, yield* importProcess(root, pending, budget), budget);
      findings.push(...run.findings);
      if (run.over) {
        const alone = yield* Effect.forEach(
          run.rest,
          (entry) =>
            importProcess(root, [entry], budget).pipe(
              Effect.map((result) => runFindings(nameOf, [entry], result, budget).findings),
            ),
          { concurrency: ALONE_CONCURRENCY },
        );
        findings.push(...alone.flat());
        break;
      }
      pending = run.rest;
    }
    return findings;
  });

/** The app host's unit processes (app-host.mts startUnitProcess): the Shell alone, then every owner together. */
export const unitProcesses = (units: readonly HostedUnit[]): readonly (readonly HostedUnit[])[] =>
  [units.filter(({ id }) => id === SHELL_ID), units.filter(({ id }) => id !== SHELL_ID)].filter(
    (group) => group.length > 0,
  );

/**
 * Check 4 over every unit process (each its entries, in load order), the processes side by side: resolution failures
 * count, any other failure is only reported. Each entry has <budget> (ENTRY_BUDGET) of its own.
 */
export const entryImportFindings = (
  root: string,
  processes: readonly (readonly string[])[],
  budget: Duration.Duration = ENTRY_BUDGET,
) =>
  Effect.gen(function* entryImportFindingsProgram() {
    const results = (yield* Effect.forEach(processes, (entries) => proveProcess(root, entries, budget), {
      concurrency: 'unbounded',
    })).flat();
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
    // Checks 1 and 2 read the store's links, so they end before check 4 moves the left-out directories aside.
    const [storesTook, stores] = yield* Effect.timed(storeLinkViolations(root, excluded));
    const [importersTook, importers] = yield* Effect.timed(importerLinkViolations(root, excluded));
    const processes = unitProcesses(yield* readHostedUnits).map((units) =>
      units.map(({ directory }) => path.join(root, directory, UNIT_ENTRY)),
    );
    const entries = processes.flat().length;
    // The entries import from the tree as it ships: the left-out store directories are moved away meanwhile. Check 3
    // reads workspace sources only (it never follows a path into node_modules), so it runs beside them.
    const [[workspaceTook, workspace], [importsTook, imports]] = yield* Effect.all(
      [
        Effect.timed(workspaceImportViolations(root, RUNTIME_ENTRIES, names)),
        Effect.timed(withLeftOutAside(root, excluded, entryImportFindings(root, processes))),
      ],
      { concurrency: 'unbounded' },
    );
    // Where the build's time goes, check by check, and on what machine.
    yield* Console.log(
      `app runtime checks took: store links ${secondsOf(storesTook)}, workspace links ${secondsOf(importersTook)}, runtime files ${secondsOf(workspaceTook)} beside unit entries ${secondsOf(importsTook)} (${String(entries)} in ${String(processes.length)} processes as the app host runs them, on ${String(availableParallelism())} cores, ${String(Math.round(totalmem() / 2 ** 30))} GiB)`,
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
      `app runtime proven without ${String(excluded.size)} left-out store directories: links intact, ${String(workspace.reached)} host and migrator files, ${String(entries)} unit entries imported`,
    );
  });

const command = Command.make('prove-app-runtime', {}, () => proveAppRuntime(workspaceRoot));

if (import.meta.main) {
  NodeRuntime.runMain(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)), {
    disableErrorReporting: false,
  });
}
