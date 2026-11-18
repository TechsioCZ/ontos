#!/usr/bin/env node
import nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, DateTime, Effect, FileSystem, Layer, Option, Schema, Stream } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

/**
 * `node app/scripts/merge/plan.mts --main origin/main --demo origin/demo/sales-crm [--out <path>]`
 *
 * Pins one main commit M and one demo commit D and writes the plan for merging M into D: the merge
 * bases, every conflict with its blob triple and standing verdict, the incoming main pull requests
 * grouped by intent, changed owner contracts with their consumers, interleaved or edited migrations,
 * and the import edges main adds that demo's tree does not have yet. Read-only apart from the tree
 * objects `git merge-tree` writes. The procedure that consumes the plan is
 * app/docs/architecture/MERGING.md, which also declares the verdict table this script reads.
 */

const REPOSITORY_ROOT = nodePath.resolve(import.meta.dirname, '..', '..', '..');
const GITHUB_OWNER = 'TechsioCZ';
const GITHUB_REPOSITORY = 'ontos';
const GRAPHQL_BATCH = 50;
const GIT_CONCURRENCY = 8;
const VERDICTS_START = '<!-- verdicts:start -->';
const VERDICTS_END = '<!-- verdicts:end -->';
const VERDICTS_DOCUMENT = 'app/docs/architecture/MERGING.md';
const TYPESCRIPT_PATHSPECS = ['app/*.ts', 'app/*.tsx', 'app/*.mts'] as const;
const MODIFY_DELETE = 'modify-delete';

const OWNER_CONTRACT_GLOBS = [
  'app/verticals/*/shared/api.ts',
  'app/verticals/*/shared/command-api.ts',
  'app/verticals/*/shared/apis/*.ts',
  'app/verticals/*/shared/actions/*.ts',
  'app/verticals/*/src/api/*.read.ts',
  'app/verticals/*/src/actions/*.action.ts',
  'app/verticals/*/vertical.manifest.ts',
  'app/verticals/*/vertical.registration.ts',
  'app/verticals/*/vertical.runtime-declaration.ts',
  'app/verticals/*/package.json',
  'app/verticals/*/drizzle/**',
  'app/topology/*.json',
  'app/packages/core-runtime/src/**',
] as const;

const WORKSPACE_PACKAGE_JSON = /^app\/(?:(?:apps|packages|verticals)\/)?[^/]+\/package\.json$/u;
const WORKSPACE_PACKAGE_DIRECTORY = /^app\/(?:(?:apps|packages|verticals)\/)?[^/]+/u;
const MIGRATION_FOLDER = /^app\/verticals\/(?<owner>[^/]+)\/drizzle\/(?<folder>(?<timestamp>\d+)_[^/]+)\//u;
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*)['"](?<specifier>@app\/[^'"]+)['"]/gu;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?tsx?$/u;
const CONFLICT_LABEL = /^CONFLICT \((?<label>[^)]+)\)/u;
const CONFLICT_RECORD = /^(?<mode>\d+) (?<oid>[0-9a-f]+) (?<stage>[123])\t(?<path>.+)$/u;

class MergePlanError extends Schema.TaggedError<MergePlanError>()('MergePlanError', {
  message: Schema.String,
}) {}

const planFailure = (message: string): MergePlanError => new MergePlanError({ message });

const ConflictKindSchema = Schema.Literals(['content', MODIFY_DELETE, 'add-add', 'rename', 'other']);
type ConflictKind = typeof ConflictKindSchema.Type;

const StageSchema = Schema.Struct({ mode: Schema.String, oid: Schema.String });
type Stage = typeof StageSchema.Type;

const ConflictSchema = Schema.Struct({
  deletedBy: Schema.OptionFromNullOr(Schema.Literals(['demo', 'main'])),
  deletingCommit: Schema.OptionFromNullOr(Schema.String),
  importers: Schema.Array(Schema.String),
  kind: ConflictKindSchema,
  message: Schema.String,
  path: Schema.String,
  stages: Schema.Struct({
    base: Schema.OptionFromNullOr(StageSchema),
    demo: Schema.OptionFromNullOr(StageSchema),
    main: Schema.OptionFromNullOr(StageSchema),
  }),
  verdict: Schema.OptionFromNullOr(Schema.Struct({ id: Schema.String, rule: Schema.String })),
});
type Conflict = typeof ConflictSchema.Type;

const IntentStatusSchema = Schema.Literals(['clean', 'conflicted', 'adapt']);
type IntentStatus = typeof IntentStatusSchema.Type;

const IntentSchema = Schema.Struct({
  commits: Schema.Array(Schema.String),
  conflictedPaths: Schema.Array(Schema.String),
  paths: Schema.Array(Schema.String),
  pr: Schema.OptionFromNullOr(Schema.Number),
  status: IntentStatusSchema,
  title: Schema.String,
});
type Intent = typeof IntentSchema.Type;

const OwnerContractSchema = Schema.Struct({ owner: Schema.String, paths: Schema.Array(Schema.String) });
type OwnerContract = typeof OwnerContractSchema.Type;

const OwnerConsumersSchema = Schema.Struct({
  consumers: Schema.Array(Schema.Struct({ demoOnly: Schema.Boolean, directory: Schema.String, name: Schema.String })),
  owner: Schema.String,
  packageName: Schema.String,
});

const InterleavedMigrationSchema = Schema.Struct({
  folder: Schema.String,
  newestDemoOnlyFolder: Schema.String,
  owner: Schema.String,
});

const ImportEdgeSchema = Schema.Struct({
  files: Schema.Array(Schema.String),
  importer: Schema.String,
  specifier: Schema.String,
});

const MergePlanSchema = Schema.Struct({
  conflicts: Schema.Array(ConflictSchema),
  consumers: Schema.Array(OwnerConsumersSchema),
  createdAt: Schema.DateTimeUtcFromString,
  demo: Schema.String,
  intents: Schema.Array(IntentSchema),
  interleavedMigrations: Schema.Array(InterleavedMigrationSchema),
  main: Schema.String,
  mergeBases: Schema.Array(Schema.String),
  migrationEdits: Schema.Array(Schema.String),
  newImportEdges: Schema.Array(ImportEdgeSchema),
  ownerContracts: Schema.Array(OwnerContractSchema),
  resultTree: Schema.OptionFromNullOr(Schema.String),
  schema: Schema.Literal('ontos-merge-plan/1'),
});
type MergePlan = typeof MergePlanSchema.Type;

const DependenciesSchema = Schema.optionalKey(Schema.Record(Schema.String, Schema.String));
const PackageJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    dependencies: DependenciesSchema,
    devDependencies: DependenciesSchema,
    name: Schema.optionalKey(Schema.String),
    peerDependencies: DependenciesSchema,
  }),
);
type PackageJson = typeof PackageJsonSchema.Type;

const PullRequestResponseSchema = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Record(
        Schema.String,
        Schema.OptionFromNullOr(
          Schema.Struct({
            associatedPullRequests: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ number: Schema.Number, title: Schema.String })),
            }),
          }),
        ),
      ),
    }),
  }),
);

/** Runs one subprocess in the repository root; an exit code outside `accepted` fails with its stderr. */
const run = Effect.fn(function* run(command: string, args: readonly string[], accepted: readonly number[] = [0]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [code, stdout, stderr] = yield* Effect.scoped(
    Effect.gen(function* collectOutput() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: REPOSITORY_ROOT,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        }),
      );
      return yield* Effect.all(
        [
          handle.exitCode,
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
        ],
        { concurrency: 'unbounded' },
      );
    }),
  ).pipe(Effect.mapError((cause) => planFailure(`${command} ${args.join(' ')}: ${cause.message}`)));
  return accepted.includes(Number(code))
    ? stdout
    : yield* Effect.fail(planFailure(`${command} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
});

const git = (args: readonly string[], accepted?: readonly number[]) => run('git', args, accepted);

const lines = (output: string): readonly string[] => output.split('\n').filter((line) => line.length > 0);

const listTree = (ref: string) => git(['ls-tree', '-r', '--name-only', ref, '--', 'app']).pipe(Effect.map(lines));

const resolveCommit = (ref: string) =>
  git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], [0, 1]).pipe(
    Effect.map((output) => output.trim()),
    Effect.filterOrFail(
      (sha) => /^[0-9a-f]{40}$/u.test(sha),
      () => planFailure(`${ref} does not resolve to a commit`),
    ),
  );

const isOwnerContract = (path: string) => OWNER_CONTRACT_GLOBS.some((glob) => nodePath.matchesGlob(path, glob));

/** The owner whose contract surface a path belongs to: a vertical directory, `topology` or `core-runtime`. */
const ownerOf = (path: string): Option.Option<string> => {
  if (!isOwnerContract(path)) {
    return Option.none();
  }
  const [, group = '', name = ''] = path.split('/');
  if (group === 'verticals') {
    return Option.some(name);
  }
  return Option.some(group === 'topology' ? 'topology' : 'core-runtime');
};

const OWNER_DIRECTORIES = new Map([
  ['core-runtime', Option.some('app/packages/core-runtime')],
  ['topology', Option.none<string>()],
]);
const ownerDirectory = (owner: string): Option.Option<string> =>
  OWNER_DIRECTORIES.get(owner) ?? Option.some(`app/verticals/${owner}`);

interface VerdictRule {
  readonly globs: readonly string[];
  readonly id: string;
  readonly kinds: readonly string[];
  readonly rule: string;
}

const listCell = (cell: string): readonly string[] =>
  cell
    .split(',')
    .map((item) => item.replaceAll('`', '').trim())
    .filter((item) => item.length > 0 && item !== '—');

/** The standing verdicts: rows `| V<n> | globs | kinds | rule |` between the markers of MERGING.md. */
const parseVerdicts = (document: string): readonly VerdictRule[] => {
  const start = document.indexOf(VERDICTS_START);
  const end = document.indexOf(VERDICTS_END);
  if (start === -1 || end < start) {
    return [];
  }
  return lines(document.slice(start + VERDICTS_START.length, end)).flatMap((line) => {
    const [id = '', globs = '', kinds = '', rule = ''] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    return /^V\d+$/u.test(id) ? [{ globs: listCell(globs), id, kinds: listCell(kinds), rule }] : [];
  });
};

type UndecidedConflict = Omit<Conflict, 'verdict'>;

const admits = (conflict: UndecidedConflict, kind: string) =>
  kind === 'any' ||
  kind === conflict.kind ||
  (kind === 'demo-deleted' && Option.contains(conflict.deletedBy, 'demo') && conflict.importers.length === 0);

/**
 * The first verdict whose globs match the path and whose kinds admit the conflict. Kind `demo-deleted`
 * admits a modify/delete where demo deleted the file and nothing outside the conflicts names it.
 */
const verdictFor = (rules: readonly VerdictRule[], conflict: UndecidedConflict): Conflict['verdict'] =>
  Option.map(
    Option.fromNullishOr(
      rules.find(
        (rule) =>
          rule.globs.some((glob) => nodePath.matchesGlob(conflict.path, glob)) &&
          rule.kinds.some((kind) => admits(conflict, kind)),
      ),
    ),
    ({ id, rule }) => ({ id, rule }),
  );

const CONFLICT_KINDS = new Map<string, ConflictKind>([
  ['add/add', 'add-add'],
  ['binary', 'content'],
  ['content', 'content'],
  ['contents', 'content'],
  ['modify/delete', MODIFY_DELETE],
]);

const kindOf = (message: string, stages: StagesByPath): ConflictKind => {
  if (message === '') {
    return stages.base === undefined ? 'add-add' : 'content';
  }
  const label = CONFLICT_LABEL.exec(message)?.groups?.label ?? '';
  return CONFLICT_KINDS.get(label) ?? (label.startsWith('rename') ? 'rename' : 'other');
};

interface StagesByPath {
  readonly base?: Stage;
  readonly demo?: Stage;
  readonly main?: Stage;
}

interface MergeTree {
  readonly messages: ReadonlyMap<string, string>;
  readonly stages: ReadonlyMap<string, StagesByPath>;
  readonly tree: string;
}

const STAGE_SIDES = new Map<string, keyof StagesByPath>([
  ['1', 'base'],
  ['2', 'demo'],
  ['3', 'main'],
]);

/** Parses `git merge-tree --write-tree -z --messages`: tree, conflicted file info, then messages. */
const parseMergeTree = (output: string): MergeTree => {
  const tokens = output.split('\0');
  const stages = new Map<string, StagesByPath>();
  let index = 1;
  for (; index < tokens.length && tokens[index] !== ''; index += 1) {
    const groups = CONFLICT_RECORD.exec(tokens[index] ?? '')?.groups;
    const side = STAGE_SIDES.get(groups?.stage ?? '');
    if (groups !== undefined && side !== undefined) {
      const path = groups.path ?? '';
      stages.set(path, { ...stages.get(path), [side]: { mode: groups.mode ?? '', oid: groups.oid ?? '' } });
    }
  }
  const messages = new Map<string, string>();
  index += 1;
  while (index < tokens.length && tokens[index] !== '') {
    const count = Number(tokens[index]);
    const message = tokens[index + 2 + count] ?? '';
    for (const path of tokens.slice(index + 1, index + 1 + count)) {
      if (message.startsWith('CONFLICT') && !messages.has(path)) {
        messages.set(path, message);
      }
    }
    index += count + 3;
  }
  return { messages, stages, tree: tokens[0] ?? '' };
};

interface Change {
  readonly path: string;
  readonly status: string;
}

interface Commit {
  readonly changes: readonly Change[];
  readonly sha: string;
}

/** Every incoming main commit, oldest first, with its name-status changes. */
const parseLog = (output: string): readonly Commit[] =>
  output
    .split('\u0001')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const [sha = '', ...rest] = lines(chunk);
      return {
        changes: rest.flatMap((line) => {
          const [status = '', path] = line.split('\t');
          return path === undefined ? [] : [{ path, status }];
        }),
        sha: sha.trim(),
      };
    });

const isTestFile = (path: string) => TEST_FILE.test(path);
const packageDirectory = (path: string) => WORKSPACE_PACKAGE_DIRECTORY.exec(path)?.[0] ?? path;
const edgeKey = (importer: string, specifier: string) => `${importer}\u0000${specifier}`;
const specifiersIn = (line: string) =>
  [...line.matchAll(IMPORT_SPECIFIER)].map((match) => match.groups?.specifier ?? '');

interface ImportEdge {
  readonly files: Set<string>;
  readonly importer: string;
  readonly specifier: string;
}

/** Import edges (importing workspace package, imported specifier) in the added lines of a unified diff. */
const addedImportEdges = (diff: string): ReadonlyMap<string, ImportEdge> => {
  const edges = new Map<string, ImportEdge>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : '';
    } else if (line.startsWith('+') && file !== '' && !isTestFile(file)) {
      const importer = packageDirectory(file);
      for (const specifier of specifiersIn(line)) {
        const key = edgeKey(importer, specifier);
        const edge = edges.get(key) ?? { files: new Set<string>(), importer, specifier };
        edge.files.add(file);
        edges.set(key, edge);
      }
    }
  }
  return edges;
};

/** The (importing package, specifier) pairs that already exist in non-test files of one tree. */
const existingImportEdges = (output: string, ref: string): ReadonlySet<string> =>
  new Set(
    lines(output).flatMap((line) => {
      const rest = line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line;
      const separator = rest.indexOf(':');
      const file = rest.slice(0, separator);
      return isTestFile(file)
        ? []
        : specifiersIn(rest.slice(separator + 1)).map((specifier) => edgeKey(packageDirectory(file), specifier));
    }),
  );

interface MigrationFolder {
  readonly folder: string;
  readonly owner: string;
  readonly timestamp: string;
}

const migrationFolders = (paths: readonly string[]): ReadonlyMap<string, MigrationFolder> =>
  new Map(
    paths.flatMap((path) => {
      const groups = MIGRATION_FOLDER.exec(path)?.groups;
      if (groups === undefined) {
        return [];
      }
      const folder = { folder: groups.folder ?? '', owner: groups.owner ?? '', timestamp: groups.timestamp ?? '' };
      return [[`${folder.owner}/${folder.folder}`, folder] as const];
    }),
  );

/** Main-added migration folders older than the newest demo-only folder of the same owner. */
const interleavedMigrationsOf = (
  baseFiles: readonly string[],
  demoFiles: readonly string[],
  mainFiles: readonly string[],
) => {
  const [baseFolders, demoFolders, mainFolders] = [baseFiles, demoFiles, mainFiles].map(migrationFolders);
  const newestDemoOnly = new Map<string, MigrationFolder>();
  for (const [key, folder] of demoFolders ?? []) {
    const newest = newestDemoOnly.get(folder.owner);
    const demoOnly = !(baseFolders?.has(key) ?? false) && !(mainFolders?.has(key) ?? false);
    if (demoOnly && (newest === undefined || folder.timestamp > newest.timestamp)) {
      newestDemoOnly.set(folder.owner, folder);
    }
  }
  return [...(mainFolders ?? [])].flatMap(([key, folder]) => {
    const newest = newestDemoOnly.get(folder.owner);
    const mainOnly = !(baseFolders?.has(key) ?? false) && !(demoFolders?.has(key) ?? false);
    return mainOnly && newest !== undefined && folder.timestamp < newest.timestamp
      ? [{ folder: folder.folder, newestDemoOnlyFolder: newest.folder, owner: folder.owner }]
      : [];
  });
};

/** A plain commit on that side that deleted the file, else the merge whose resolution dropped it. */
const deletingCommitOf = (ref: string, path: string) =>
  Effect.forEach(
    [[], ['-m']],
    (merges) => git(['log', '-1', ...merges, '--full-history', '--diff-filter=D', '--format=%H', ref, '--', path]),
    { concurrency: 2 },
  ).pipe(Effect.map((shas) => Option.fromNullishOr(shas.map((sha) => sha.trim()).find((sha) => sha !== ''))));

/** Files on the result tree outside the conflicted paths that name a file by its stem. */
const importersOf = (tree: string, path: string, conflicted: ReadonlyMap<string, unknown>) =>
  git(
    ['grep', '-l', '-F', nodePath.basename(path).replace(/\.[^.]+$/u, ''), tree, '--', 'app', '.github'],
    [0, 1],
  ).pipe(
    Effect.map((output) =>
      lines(output)
        .map((line) => line.slice(tree.length + 1))
        .filter((file) => !conflicted.has(file)),
    ),
  );

interface Pins {
  readonly demo: string;
  readonly main: string;
}

const conflictEntry = Effect.fn(function* conflictEntry(
  pins: Pins,
  mergeTree: MergeTree,
  rules: readonly VerdictRule[],
  path: string,
) {
  const stages = mergeTree.stages.get(path) ?? {};
  const message = mergeTree.messages.get(path) ?? '';
  const kind = kindOf(message, stages);
  const deletedBy: Conflict['deletedBy'] =
    kind === MODIFY_DELETE ? Option.some(stages.demo === undefined ? 'demo' : 'main') : Option.none();
  const deletingSide = deletedBy.pipe(Option.map((side) => (side === 'demo' ? pins.demo : pins.main)));
  const [deletingCommit, importers] = yield* Effect.all(
    [
      Option.match(deletingSide, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (ref) => deletingCommitOf(ref, path),
      }),
      Option.contains(deletedBy, 'demo')
        ? importersOf(mergeTree.tree, path, mergeTree.stages)
        : Effect.succeed<readonly string[]>([]),
    ],
    { concurrency: 2 },
  );
  const entry: UndecidedConflict = {
    deletedBy,
    deletingCommit,
    importers,
    kind,
    message,
    path,
    stages: {
      base: Option.fromNullishOr(stages.base),
      demo: Option.fromNullishOr(stages.demo),
      main: Option.fromNullishOr(stages.main),
    },
  };
  return { ...entry, verdict: verdictFor(rules, entry) };
});

interface PullRequest {
  readonly number: number;
  readonly title: string;
}

/** One GitHub GraphQL query for up to 50 commits: the pull request each one was merged by. */
const pullRequestBatch = Effect.fn(function* pullRequestBatch(batch: readonly Commit[]) {
  const fields = batch
    .map(
      (commit, index) =>
        `c${index}: object(oid: "${commit.sha}") { ... on Commit { associatedPullRequests(first: 1) { nodes { number title } } } }`,
    )
    .join(' ');
  const query = `query { repository(owner: "${GITHUB_OWNER}", name: "${GITHUB_REPOSITORY}") { ${fields} } }`;
  const response = yield* run('gh', ['api', 'graphql', '-f', `query=${query}`]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PullRequestResponseSchema)),
    Effect.mapError((cause) => planFailure(`GitHub pull request lookup failed: ${cause.message}`)),
  );
  return batch.flatMap((commit, index) =>
    Option.toArray(
      Option.fromNullishOr(response.data.repository[`c${index}`]).pipe(
        Option.flatten,
        Option.flatMap((object) => Option.fromNullishOr(object.associatedPullRequests.nodes[0])),
        Option.map((pull): readonly [string, PullRequest] => [commit.sha, pull]),
      ),
    ),
  );
});

const pullRequestsOf = (commits: readonly Commit[]) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(commits.length / GRAPHQL_BATCH) }, (_, batch) =>
      commits.slice(batch * GRAPHQL_BATCH, (batch + 1) * GRAPHQL_BATCH),
    ),
    pullRequestBatch,
    { concurrency: 4 },
  ).pipe(Effect.map((batches) => new Map(batches.flat())));

const intentStatus = (paths: readonly string[], conflicted: readonly string[]): IntentStatus => {
  if (conflicted.length > 0) {
    return 'conflicted';
  }
  return paths.some(isOwnerContract) ? 'adapt' : 'clean';
};

interface IntentGroup {
  readonly commits: string[];
  readonly paths: Set<string>;
  readonly pr: Option.Option<number>;
  readonly title: string;
}

/** Commits grouped by pull request; a commit without one is its own intent, titled by its subject. */
const intentsOf = Effect.fn(function* intentsOf(commits: readonly Commit[], conflicted: ReadonlyMap<string, unknown>) {
  const pullRequests = yield* pullRequestsOf(commits);
  const grouped = new Map<string, IntentGroup>();
  for (const commit of commits) {
    const pull = Option.fromNullishOr(pullRequests.get(commit.sha));
    const key = Option.match(pull, { onNone: () => commit.sha, onSome: (found) => `#${found.number}` });
    const group = grouped.get(key) ?? {
      commits: [],
      paths: new Set<string>(),
      pr: pull.pipe(Option.map((found) => found.number)),
      title: Option.match(pull, { onNone: () => '', onSome: (found) => found.title }),
    };
    group.commits.push(commit.sha);
    for (const change of commit.changes) {
      group.paths.add(change.path);
    }
    grouped.set(key, group);
  }
  return yield* Effect.forEach(
    [...grouped.values()],
    (group) =>
      Effect.gen(function* intentEntry() {
        const paths = [...group.paths].toSorted();
        const conflictedPaths = paths.filter((path) => conflicted.has(path));
        const [first = ''] = group.commits;
        const title = Option.isSome(group.pr) ? group.title : (yield* git(['log', '-1', '--format=%s', first])).trim();
        const intent: Intent = {
          commits: group.commits,
          conflictedPaths,
          paths,
          pr: group.pr,
          status: intentStatus(paths, conflictedPaths),
          title,
        };
        return intent;
      }),
    { concurrency: GIT_CONCURRENCY },
  );
});

const ownerContractsOf = (commits: readonly Commit[]): readonly OwnerContract[] => {
  const contractPaths = new Map<string, string[]>();
  const changed = new Set(commits.flatMap((commit) => commit.changes.map((change) => change.path)));
  for (const path of [...changed].toSorted()) {
    for (const owner of Option.toArray(ownerOf(path))) {
      contractPaths.set(owner, [...(contractPaths.get(owner) ?? []), path]);
    }
  }
  return [...contractPaths.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([owner, paths]) => ({ owner, paths }));
};

/** A package.json on the result tree; a conflicted one falls back to demo's version. */
const readPackage = (tree: string, demo: string, path: string) =>
  Effect.firstSuccessOf(
    [tree, demo].map((ref) =>
      git(['show', `${ref}:${path}`]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageJsonSchema))),
    ),
  ).pipe(
    Effect.option,
    Effect.map((manifest) => manifest.pipe(Option.map((value) => ({ manifest: value, path })))),
  );

const dependsOn = (manifest: PackageJson, packageName: string) =>
  [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(
    (dependencies) => dependencies !== undefined && packageName in dependencies,
  );

/** Workspace packages on the result tree that depend on each changed owner, marking demo-only ones. */
const consumersOf = Effect.fn(function* consumersOf(
  tree: string,
  demo: string,
  resultFiles: readonly string[],
  mainFiles: ReadonlySet<string>,
  ownerContracts: readonly OwnerContract[],
) {
  const packages = (yield* Effect.forEach(
    resultFiles.filter((path) => WORKSPACE_PACKAGE_JSON.test(path)),
    (path) => readPackage(tree, demo, path),
    { concurrency: GIT_CONCURRENCY },
  )).flatMap((entry) => Option.toArray(entry));
  const packageNameAt = new Map(
    packages.flatMap(({ manifest, path }) =>
      manifest.name === undefined ? [] : [[nodePath.posix.dirname(path), manifest.name] as const],
    ),
  );
  return ownerContracts.flatMap(({ owner }) =>
    Option.toArray(
      Option.flatMap(ownerDirectory(owner), (directory) => Option.fromNullishOr(packageNameAt.get(directory))),
    ).map((packageName) => ({
      consumers: packages
        .filter(({ manifest }) => dependsOn(manifest, packageName))
        .map(({ manifest, path }) => ({
          demoOnly: !mainFiles.has(path),
          directory: nodePath.posix.dirname(path),
          name: manifest.name ?? nodePath.posix.dirname(path),
        })),
      owner,
      packageName,
    })),
  );
});

/** Main changes, other than additions, to files of migration folders that already exist at the base. */
const migrationEditsOf = (commits: readonly Commit[], baseFiles: ReadonlySet<string>) =>
  [
    ...new Set(
      commits
        .flatMap((commit) => commit.changes)
        .filter((change) => change.status !== 'A' && MIGRATION_FOLDER.test(change.path) && baseFiles.has(change.path))
        .map((change) => change.path),
    ),
  ].toSorted();

const summaryOf = (plan: MergePlan, out: string) => {
  const conflictCount = (kind: ConflictKind) => plan.conflicts.filter((conflict) => conflict.kind === kind).length;
  const statusCount = (status: IntentStatus) => plan.intents.filter((intent) => intent.status === status).length;
  const undecided = plan.conflicts.filter((conflict) => Option.isNone(conflict.verdict)).length;
  const consumers = plan.consumers.flatMap((owner) => owner.consumers);
  const commits = plan.intents.reduce((total, intent) => total + intent.commits.length, 0);
  const stop = plan.migrationEdits.length > 0 ? ' (STOP)' : '';
  return [
    `main ${plan.main.slice(0, 12)}  demo ${plan.demo.slice(0, 12)}  merge bases ${plan.mergeBases.length}`,
    `result tree ${Option.getOrElse(plan.resultTree, () => 'none')}`,
    `conflicts ${plan.conflicts.length}: content ${conflictCount('content')}, modify/delete ${conflictCount(MODIFY_DELETE)}, add/add ${conflictCount('add-add')}, rename ${conflictCount('rename')}, other ${conflictCount('other')}`,
    `verdicts: ${plan.conflicts.length - undecided} standing, ${undecided} null (decide these)`,
    `incoming ${commits} commits in ${plan.intents.length} intents: clean ${statusCount('clean')}, conflicted ${statusCount('conflicted')}, adapt ${statusCount('adapt')}`,
    `owner contracts: ${plan.ownerContracts.map((contract) => contract.owner).join(', ') || 'none'}`,
    `consumers ${consumers.length} (${consumers.filter((consumer) => consumer.demoOnly).length} demo-only)`,
    `migrations: ${plan.interleavedMigrations.length} interleaved, ${plan.migrationEdits.length} edits of applied migrations${stop}`,
    `new import edges ${plan.newImportEdges.length}`,
    `plan ${out}`,
  ].join('\n');
};

const requireRerere = git(['config', '--get', 'rerere.enabled'], [0, 1]).pipe(
  Effect.filterOrFail(
    (value) => value.trim() === 'true',
    () =>
      planFailure(
        'rerere is disabled in this clone. Run `git config rerere.enabled true && git config rerere.autoUpdate false`, then run the plan again.',
      ),
  ),
);

/** Fetches, pins main and demo, analyses the merge and writes the plan; returns the summary. */
export const writeMergePlan = Effect.fn(function* writeMergePlan(options: {
  readonly demo: string;
  readonly main: string;
  readonly out: Option.Option<string>;
}) {
  yield* requireRerere;
  yield* git(['fetch', '--quiet', 'origin', 'main', 'demo/sales-crm']);
  const [main, demo] = yield* Effect.all([resolveCommit(options.main), resolveCommit(options.demo)], {
    concurrency: 2,
  });
  const fileSystem = yield* FileSystem.FileSystem;
  const [mergeBaseOutput, mergeTreeOutput, logOutput, verdictDocument] = yield* Effect.all(
    [
      git(['merge-base', '--all', demo, main]),
      git(['merge-tree', '--write-tree', '-z', '--messages', demo, main], [0, 1]),
      git(['log', '--reverse', '--no-merges', '--no-renames', '--format=%x01%H', '--name-status', `${demo}..${main}`]),
      fileSystem.readFileString(nodePath.join(REPOSITORY_ROOT, VERDICTS_DOCUMENT)).pipe(Effect.orElseSucceed(() => '')),
    ],
    { concurrency: 'unbounded' },
  );
  const mergeBases = lines(mergeBaseOutput);
  const [base] = mergeBases;
  if (base === undefined) {
    return yield* Effect.fail(planFailure(`${demo} and ${main} have no merge base`));
  }
  const mergeTree = parseMergeTree(mergeTreeOutput);
  const commits = parseLog(logOutput);
  const [baseFiles, demoFiles, mainFiles, resultFiles, importDiff, demoImports] = yield* Effect.all(
    [
      listTree(base),
      listTree(demo),
      listTree(main),
      listTree(mergeTree.tree),
      git(['diff', '-U0', '--no-color', '--no-renames', '--diff-filter=AM', base, main, '--', ...TYPESCRIPT_PATHSPECS]),
      git(
        [
          'grep',
          '-I',
          '-E',
          String.raw`(from[[:space:]]+|import[[:space:]]*\([[:space:]]*)['"]@app/`,
          demo,
          '--',
          ...TYPESCRIPT_PATHSPECS,
        ],
        [0, 1],
      ),
    ],
    { concurrency: GIT_CONCURRENCY },
  );
  const rules = parseVerdicts(verdictDocument);
  const ownerContracts = ownerContractsOf(commits);
  const [conflicts, intents, consumers] = yield* Effect.all(
    [
      Effect.forEach(
        [...mergeTree.stages.keys()].toSorted(),
        (path) => conflictEntry({ demo, main }, mergeTree, rules, path),
        { concurrency: GIT_CONCURRENCY },
      ),
      intentsOf(commits, mergeTree.stages),
      consumersOf(mergeTree.tree, demo, resultFiles, new Set(mainFiles), ownerContracts),
    ],
    { concurrency: 3 },
  );
  const demoEdges = existingImportEdges(demoImports, demo);
  const plan: MergePlan = {
    conflicts,
    consumers,
    createdAt: yield* DateTime.now,
    demo,
    intents,
    interleavedMigrations: interleavedMigrationsOf(baseFiles, demoFiles, mainFiles),
    main,
    mergeBases,
    migrationEdits: migrationEditsOf(commits, new Set(baseFiles)),
    newImportEdges: [...addedImportEdges(importDiff).entries()]
      .filter(([key]) => !demoEdges.has(key))
      .map(([, edge]) => ({ files: [...edge.files].toSorted(), importer: edge.importer, specifier: edge.specifier }))
      .toSorted((left, right) =>
        edgeKey(left.importer, left.specifier).localeCompare(edgeKey(right.importer, right.specifier)),
      ),
    ownerContracts,
    resultTree: Option.some(mergeTree.tree),
    schema: 'ontos-merge-plan/1',
  };
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(MergePlanSchema, { space: 2 }))(plan).pipe(
    Effect.mapError((issue) => planFailure(`unable to encode the plan: ${issue.message}`)),
  );
  const out = Option.getOrElse(options.out, () => nodePath.join(tmpdir(), 'ontos-merge', `${main.slice(0, 12)}.json`));
  yield* fileSystem.makeDirectory(nodePath.dirname(out), { recursive: true });
  yield* fileSystem.writeFileString(out, `${encoded}\n`);
  return summaryOf(plan, out);
});

const command = Command.make(
  'merge-plan',
  {
    demo: Flag.String('demo').pipe(Flag.withDefault('origin/demo/sales-crm')),
    main: Flag.String('main').pipe(Flag.withDefault('origin/main')),
    out: Flag.String('out').pipe(Flag.optional),
  },
  ({ demo, main, out }) => writeMergePlan({ demo, main, out }).pipe(Effect.flatMap(Console.log)),
);

const [, invokedPath] = process.argv;
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const mainLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid));
}
