import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { Effect, Exit, Predicate, Schema } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';
import { parseSync, Visitor } from 'oxc-parser';

import { NoSubprocessServicesLive } from '../zerops/no-subprocess-services.mts';

const workspace = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(workspace, file), 'utf-8');

/**
 * The processes that hold a module credential channel on file descriptor 3, open for the host's later handovers: the
 * owners process and the Outbox Worker host. A subprocess would inherit that descriptor, so nothing they load may
 * start one.
 */
const CHANNEL_HOLDERS = ['scripts/zerops/serve-units.mts', 'scripts/outbox-worker-host.generated.mts'];
/** The one module that names the spawner, to provide one that refuses every command. */
const REFUSING_SPAWNER = 'scripts/zerops/no-subprocess-services.mts';

const SPAWNING_MODULE = /^(?:node:)?(?:child_process|cluster)$|^effect\/(?:unstable\/)?process(?:\/|$)/u;
const SPAWNING_PLATFORM = new Set(['NodeChildProcessSpawner', 'NodeServices']);

const ExportTargetSchema = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]);
const PackageSchema = Schema.Struct({
  exports: Schema.optionalKey(Schema.Record(Schema.String, ExportTargetSchema)),
  name: Schema.String,
});
const workspacePackages = new Map(
  ['apps', 'packages', 'verticals'].flatMap((group) =>
    readdirSync(path.join(workspace, group)).flatMap((name) => {
      const manifest = path.posix.join(group, name, 'package.json');
      if (!existsSync(path.join(workspace, manifest))) {
        return [];
      }
      const parsed = Schema.decodeUnknownSync(PackageSchema)(JSON.parse(read(manifest)));
      return [[parsed.name, { directory: path.posix.join(group, name), exports: parsed.exports ?? {} }] as const];
    }),
  ),
);

const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/u;
const SOURCE_CANDIDATES = ['', '.ts', '.tsx', '.mts', '.js', '/index.ts', '/index.tsx'];
const isSourceFile = (file: string) =>
  SOURCE.test(file) && existsSync(path.join(workspace, file)) && statSync(path.join(workspace, file)).isFile();

/** A runtime import's source file in the workspace; `undefined` for a third-party package or a non-source asset. */
const resolve = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    return SOURCE_CANDIDATES.map((suffix) => `${base}${suffix}`).find(isSourceFile);
  }
  const [scope, name, ...subpath] = specifier.split('/');
  const owner = workspacePackages.get(`${scope}/${name}`);
  if (owner === undefined) {
    return undefined;
  }
  const target = owner.exports[subpath.length === 0 ? '.' : `./${subpath.join('/')}`];
  const file = Predicate.isString(target) ? target : (target?.node ?? target?.default);
  const resolved = file === undefined ? undefined : path.posix.normalize(path.posix.join(owner.directory, file));
  return resolved !== undefined && isSourceFile(resolved) ? resolved : undefined;
};

const parsed = (file: string) =>
  parseSync(file, read(file), { astType: 'ts', lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }).program;

interface Imported {
  readonly names: readonly string[];
  readonly specifier: string;
}

/** The runtime imports of a source file (type-only imports load nothing). */
const importsOf = (file: string): Imported[] => {
  const imported: Imported[] = [];
  new Visitor({
    ExportAllDeclaration: ({ exportKind, source }) => {
      if (exportKind !== 'type') {
        imported.push({ names: [], specifier: source.value });
      }
    },
    ExportNamedDeclaration: ({ exportKind, source }) => {
      if (exportKind !== 'type' && source !== null) {
        imported.push({ names: [], specifier: source.value });
      }
    },
    ImportDeclaration: ({ importKind, source, specifiers }) => {
      if (importKind !== 'type') {
        imported.push({
          names: specifiers.flatMap((specifier) =>
            specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier'
              ? [specifier.imported.name]
              : [],
          ),
          specifier: source.value,
        });
      }
    },
    ImportExpression: ({ source }) => {
      if (source.type === 'Literal' && Predicate.isString(source.value)) {
        imported.push({ names: [], specifier: source.value });
      }
    },
  }).visit(parsed(file));
  return imported;
};

const sourcesUnder = (directory: string): string[] =>
  existsSync(path.join(workspace, directory))
    ? readdirSync(path.join(workspace, directory), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.posix.join(directory, entry.name);
        if (entry.isDirectory()) {
          return ['node_modules', 'tests', 'dist', '.output'].includes(entry.name) ? [] : sourcesUnder(relative);
        }
        return SOURCE.test(entry.name) && !entry.name.includes('.test.') ? [relative] : [];
      })
    : [];

/** What a channel holder can load: its own module graph, and the runtime source of every owner it imports by path. */
const loaded = () => {
  const owners = [...workspacePackages.values()]
    .filter(({ directory }) => directory.startsWith('verticals/') || directory.startsWith('apps/'))
    .flatMap(({ directory }) => ['api', 'src', 'shared'].flatMap((part) => sourcesUnder(`${directory}/${part}`)));
  const seen = new Set<string>();
  const pending = [...CHANNEL_HOLDERS, ...owners];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file) || !isSourceFile(file)) {
      continue;
    }
    seen.add(file);
    pending.push(
      ...importsOf(file).flatMap(({ specifier }) => {
        const next = resolve(file, specifier);
        return next === undefined ? [] : [next];
      }),
    );
  }
  return seen;
};

it('loads no code that can start a subprocess into a process holding a module credential channel', () => {
  const files = loaded();
  expect(CHANNEL_HOLDERS.every((holder) => files.has(holder))).toBe(true);
  expect(files.has(REFUSING_SPAWNER)).toBe(true);
  const spawning = [...files].flatMap((file) =>
    file === REFUSING_SPAWNER
      ? []
      : importsOf(file).flatMap(({ names, specifier }) =>
          SPAWNING_MODULE.test(specifier) ||
          specifier.startsWith('@effect/platform-node/NodeChildProcessSpawner') ||
          specifier.startsWith('@effect/platform-node/NodeServices') ||
          (specifier === '@effect/platform-node' && names.some((name) => SPAWNING_PLATFORM.has(name)))
            ? [`${file}: ${specifier}`]
            : [],
        ),
  );
  expect(spawning).toEqual([]);
});

it.effect('gives a channel holder a spawner that refuses every command', () =>
  Effect.gen(function* refusedSpawn() {
    const spawned = yield* Effect.exit(Effect.scoped(ChildProcess.make('true', [])));
    expect(Exit.isFailure(spawned)).toBe(true);
  }).pipe(Effect.provide(NoSubprocessServicesLive)),
);
