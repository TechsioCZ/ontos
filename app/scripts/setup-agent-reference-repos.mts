#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Config,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess } from 'effect/unstable/process';

const LOG_PREFIX = '[agent-reference-repos]';
const REPOSITORY_STRATEGY = 'git-subtree-squash' as const;
const WORKSPACE_ROOT = '.';

const ReferenceRepositorySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  readOnly: Schema.optionalKey(Schema.Boolean),
  ref: Schema.String,
  url: Schema.String,
});
const ReferenceRepositoryConfigSchema = Schema.Struct({
  defaultEnabled: Schema.Boolean,
  installDir: Schema.Literal('repos'),
  repositories: Schema.Array(ReferenceRepositorySchema),
  schemaVersion: Schema.Literal(1),
  strategy: Schema.Literal(REPOSITORY_STRATEGY),
});
const InstalledRepositorySchema = Schema.Struct({
  commit: Schema.optionalKey(Schema.String),
  id: Schema.String,
  installedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  name: Schema.String,
  path: Schema.String,
  readOnly: Schema.Boolean,
  ref: Schema.String,
  schemaVersion: Schema.optionalKey(Schema.Literal(1)),
  status: Schema.Literals(['installed', 'present']),
  strategy: Schema.Literal(REPOSITORY_STRATEGY),
  url: Schema.String,
});
const InstalledManifestSchema = Schema.Struct({
  generatedAt: Schema.DateTimeUtcFromString,
  installDir: Schema.Literal('repos'),
  repositories: Schema.Array(InstalledRepositorySchema),
  schemaVersion: Schema.Literal(1),
  strategy: Schema.Literal(REPOSITORY_STRATEGY),
});
const ReferenceRepositoryConfigJsonSchema = Schema.fromJsonString(
  ReferenceRepositoryConfigSchema
);
const InstalledManifestJsonSchema = Schema.fromJsonString(
  InstalledManifestSchema,
  { space: 2 }
);
type ReferenceRepository = typeof ReferenceRepositorySchema.Type;
type InstalledRepository = typeof InstalledRepositorySchema.Type;

class AgentReferenceRepoSetupError extends Schema.TaggedError<AgentReferenceRepoSetupError>()(
  'AgentReferenceRepoSetupError',
  { reason: Schema.String }
) {}
const setupError = (reason: string) =>
  new AgentReferenceRepoSetupError({ reason });
const truthy = (value: string): boolean => /^(?:1|true|yes|on)$/iu.test(value);
const falsy = (value: string): boolean => /^(?:0|false|no|off)$/iu.test(value);
const environmentValue = (name: string) =>
  Config.string(name).pipe(Config.withDefault(''));
const identityValue = (value: string, fallback: string): string =>
  value.length > 0 ? value : fallback;
const SetupEnvironment = Config.all({
  agentRepos: environmentValue('ULTRAMODERN_AGENT_REPOS'),
  authorEmail: environmentValue('GIT_AUTHOR_EMAIL'),
  authorName: environmentValue('GIT_AUTHOR_NAME'),
  committerEmail: environmentValue('GIT_COMMITTER_EMAIL'),
  committerName: environmentValue('GIT_COMMITTER_NAME'),
  refresh: environmentValue('ULTRAMODERN_AGENT_REPOS_REFRESH'),
  required: environmentValue('ULTRAMODERN_AGENT_REPOS_REQUIRED'),
  skipAgentRepos: environmentValue('ULTRAMODERN_SKIP_AGENT_REPOS'),
});
interface RuntimeSettings {
  readonly gitIdentity: Readonly<Record<string, string>>;
  readonly refresh: boolean;
  readonly required: boolean;
  readonly skipRequested: boolean;
}
const RuntimeConfiguration = Context.Service<RuntimeSettings>(
  'scripts/setup-agent-reference-repos/RuntimeConfiguration'
);
const loadRuntimeSettings = Effect.fn('loadRuntimeSettings')(
  function* loadRuntimeSettingsEffect() {
    const environment = yield* SetupEnvironment;
    return {
      gitIdentity: {
        GIT_AUTHOR_EMAIL: identityValue(
          environment.authorEmail,
          'ultramodern-agent-refs@local'
        ),
        GIT_AUTHOR_NAME: identityValue(
          environment.authorName,
          'UltraModern Agent Reference Setup'
        ),
        GIT_COMMITTER_EMAIL: identityValue(
          environment.committerEmail,
          'ultramodern-agent-refs@local'
        ),
        GIT_COMMITTER_NAME: identityValue(
          environment.committerName,
          'UltraModern Agent Reference Setup'
        ),
      },
      refresh: truthy(environment.refresh),
      required: truthy(environment.required),
      skipRequested:
        truthy(environment.skipAgentRepos) || falsy(environment.agentRepos),
    } satisfies RuntimeSettings;
  }
);

const commandFailure = (
  command: string,
  commandArguments: readonly string[],
  detail: string
): AgentReferenceRepoSetupError => {
  const invocation = [command, ...commandArguments].join(' ');
  const detailSuffix = detail.length > 0 ? `: ${detail}` : '';
  return setupError(`${invocation} failed${detailSuffix}`);
};
const executeCommand = Effect.fn('executeCommand')(
  function* executeCommandEffect(
    command: string,
    commandArguments: readonly string[],
    timeoutMilliseconds: number
  ) {
    const settings = yield* RuntimeConfiguration;
    const invocation = ChildProcess.make(command, commandArguments, {
      cwd: WORKSPACE_ROOT,
      env: settings.gitIdentity,
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    return yield* Effect.scoped(
      Effect.gen(function* collectCommandResultEffect() {
        const handle = yield* invocation;
        const [status, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode.pipe(Effect.map(Number)),
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          ],
          { concurrency: 'unbounded' }
        );
        return { status, stderr: stderr.trim(), stdout: stdout.trim() };
      })
    ).pipe(
      Effect.timeout(timeoutMilliseconds),
      Effect.mapError((error) =>
        commandFailure(command, commandArguments, String(error))
      )
    );
  }
);
const runCommand = Effect.fn('runCommand')(function* runCommandEffect(
  command: string,
  commandArguments: readonly string[],
  timeoutMilliseconds: number
) {
  const result = yield* executeCommand(
    command,
    commandArguments,
    timeoutMilliseconds
  );
  if (result.status !== 0) {
    return yield* commandFailure(command, commandArguments, result.stderr);
  }
  return result.stdout;
});
const assertSafeRepoPath = Effect.fn('assertSafeRepoPath')(
  function* assertSafeRepoPathEffect(relativePath: string) {
    const path = yield* Path.Path;
    if (
      relativePath.length === 0 ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]+/u).includes('..') ||
      !relativePath.startsWith('repos/') ||
      path.resolve(relativePath) === path.resolve('repos')
    ) {
      return yield* setupError(
        `Unsafe reference repository path: ${relativePath}`
      );
    }
    return yield* Effect.void;
  }
);
const hasGit = Effect.fn('hasGit')(function* hasGitEffect() {
  const result = yield* executeCommand('git', ['--version'], 30_000);
  return result.status === 0;
});
const hasGitSubtree = Effect.fn('hasGitSubtree')(
  function* hasGitSubtreeEffect() {
    const result = yield* executeCommand('git', ['subtree', '-h'], 30_000);
    return (
      (result.status === 0 || result.status === 129) &&
      result.stdout.includes('usage: git subtree')
    );
  }
);
const isGitWorkTree = Effect.fn('isGitWorkTree')(
  function* isGitWorkTreeEffect() {
    const result = yield* executeCommand(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      30_000
    );
    return result.status === 0 && result.stdout === 'true';
  }
);
const hasCommits = Effect.fn('hasCommits')(function* hasCommitsEffect() {
  const result = yield* executeCommand(
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    30_000
  );
  return result.status === 0;
});
const commitInstallerChanges = Effect.fn('commitInstallerChanges')(
  function* commitInstallerChangesEffect(message: string) {
    return yield* runCommand('git', ['commit', '-m', message], 120_000);
  }
);
const ensureGitRepository = Effect.fn('ensureGitRepository')(
  function* ensureGitRepositoryEffect(checkOnly: boolean) {
    if (!(yield* isGitWorkTree())) {
      if (checkOnly) {
        return yield* setupError('workspace is not a git repository');
      }
      yield* Effect.logInfo(
        `${LOG_PREFIX} initializing git repository for agent reference subtrees`
      );
      yield* runCommand('git', ['init'], 30_000);
    }
    if (!(yield* hasCommits())) {
      if (checkOnly) {
        return yield* setupError('workspace has no initial git commit');
      }
      yield* Effect.logInfo(
        `${LOG_PREFIX} creating initial workspace commit before adding reference subtrees`
      );
      yield* runCommand('git', ['add', '-A'], 30_000);
      yield* commitInstallerChanges('Initialize UltraModern workspace');
      return yield* Effect.void;
    }
    const status = yield* runCommand('git', ['status', '--porcelain'], 30_000);
    if (status.length > 0) {
      return yield* setupError(
        'workspace has uncommitted changes; commit or stash them before installing reference subtrees'
      );
    }
    return yield* Effect.void;
  }
);
const remoteCommit = Effect.fn('remoteCommit')(function* remoteCommitEffect(
  repository: ReferenceRepository
) {
  const branchOutput = yield* runCommand(
    'git',
    ['ls-remote', repository.url, `refs/heads/${repository.ref}`],
    120_000
  );
  const output =
    branchOutput.length > 0
      ? branchOutput
      : yield* runCommand(
          'git',
          ['ls-remote', repository.url, repository.ref],
          120_000
        );
  const commit = output.split(/\s+/u).at(0) ?? '';
  if (!/^[a-f\d]{40}$/iu.test(commit)) {
    return yield* setupError(
      `Could not resolve ${repository.url}#${repository.ref}`
    );
  }
  return commit;
});
const subtreeCommitExists = Effect.fn('subtreeCommitExists')(
  function* subtreeCommitExistsEffect(repository: ReferenceRepository) {
    const result = yield* executeCommand(
      'git',
      [
        'log',
        '--grep',
        `git-subtree-dir: ${repository.path}`,
        '--format=%H',
        '-n',
        '1',
      ],
      30_000
    );
    return result.status === 0 && result.stdout.length > 0;
  }
);
const installedManifestEntry = Effect.fn('installedManifestEntry')(
  function* installedManifestEntryEffect(
    manifestPath: string,
    repository: ReferenceRepository
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(manifestPath))) {
      return Option.none<InstalledRepository>();
    }
    const repositories = yield* fileSystem.readFileString(manifestPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(InstalledManifestJsonSchema)),
      Effect.map((manifest) => manifest.repositories),
      Effect.option
    );
    return repositories.pipe(
      Option.flatMap((entries) =>
        Option.fromUndefinedOr(
          entries.find((entry) => entry.id === repository.id)
        )
      )
    );
  }
);
const assertSubtreePresent = Effect.fn('assertSubtreePresent')(
  function* assertSubtreePresentEffect(
    manifestPath: string,
    repository: ReferenceRepository
  ) {
    yield* assertSafeRepoPath(repository.path);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (
      !(yield* fileSystem.exists(path.join(WORKSPACE_ROOT, repository.path)))
    ) {
      return yield* setupError(`${repository.path} is missing`);
    }
    if (!(yield* subtreeCommitExists(repository))) {
      return yield* setupError(
        `${repository.path} is present but has no git-subtree commit evidence`
      );
    }
    const installedEntry = yield* installedManifestEntry(
      manifestPath,
      repository
    );
    return Option.getOrElse(installedEntry, (): InstalledRepository => ({
      id: repository.id,
      name: repository.name,
      path: repository.path,
      readOnly: repository.readOnly !== false,
      ref: repository.ref,
      status: 'present',
      strategy: REPOSITORY_STRATEGY,
      url: repository.url,
    }));
  }
);
const addSubtree = Effect.fn('addSubtree')(function* addSubtreeEffect(
  manifestPath: string,
  repository: ReferenceRepository
) {
  yield* assertSafeRepoPath(repository.path);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* RuntimeConfiguration;
  const existing = yield* fileSystem.exists(
    path.join(WORKSPACE_ROOT, repository.path)
  );
  if (existing && !settings.refresh) {
    return yield* assertSubtreePresent(manifestPath, repository);
  }
  if (existing) {
    return yield* setupError(
      `${repository.path} already exists; refresh for subtree references is intentionally manual`
    );
  }
  const commit = yield* remoteCommit(repository);
  yield* Effect.logInfo(
    `${LOG_PREFIX} adding ${repository.name} as git subtree at ${repository.path} (${commit})`
  );
  yield* runCommand(
    'git',
    ['fetch', '--depth', '1', repository.url, repository.ref],
    300_000
  );
  yield* runCommand(
    'git',
    [
      'subtree',
      'add',
      '--prefix',
      repository.path,
      'FETCH_HEAD',
      '--squash',
      '-m',
      `Add ${repository.name} agent reference repo`,
    ],
    600_000
  );
  const installedAt = yield* DateTime.now;
  return {
    commit,
    id: repository.id,
    installedAt,
    name: repository.name,
    path: repository.path,
    readOnly: repository.readOnly !== false,
    ref: repository.ref,
    schemaVersion: 1,
    status: 'installed',
    strategy: REPOSITORY_STRATEGY,
    url: repository.url,
  } satisfies InstalledRepository;
});
const writeManifest = Effect.fn('writeManifest')(function* writeManifestEffect(
  manifestPath: string,
  entries: readonly InstalledRepository[]
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const generatedAt = yield* DateTime.now;
  const contents = yield* Schema.encodeEffect(InstalledManifestJsonSchema)({
    generatedAt,
    installDir: 'repos',
    repositories: entries,
    schemaVersion: 1,
    strategy: REPOSITORY_STRATEGY,
  }).pipe(
    Effect.mapError(() =>
      setupError('Unable to encode the agent reference manifest')
    )
  );
  yield* fileSystem.makeDirectory(path.dirname(manifestPath), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(manifestPath, `${contents}\n`);
});
const commitManifestIfChanged = Effect.fn('commitManifestIfChanged')(
  function* commitManifestIfChangedEffect(manifestPath: string) {
    const status = yield* runCommand(
      'git',
      ['status', '--porcelain', '--', manifestPath],
      30_000
    );
    if (status.length === 0) {
      return yield* Effect.void;
    }
    yield* runCommand('git', ['add', manifestPath], 30_000);
    yield* commitInstallerChanges('Record agent reference repo manifest');
    return yield* Effect.void;
  }
);
const runSetup = Effect.fn('runSetup')(function* runSetupEffect(
  checkOnly: boolean
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* RuntimeConfiguration;
  const configPath = path.join(
    WORKSPACE_ROOT,
    '.agents',
    'agent-reference-repos.json'
  );
  const manifestPath = path.join(
    WORKSPACE_ROOT,
    '.modernjs',
    'agent-reference-repos.json'
  );
  if (!(yield* fileSystem.exists(configPath))) {
    return yield* setupError('Missing .agents/agent-reference-repos.json');
  }
  const config = yield* fileSystem.readFileString(configPath).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(ReferenceRepositoryConfigJsonSchema)
    ),
    Effect.mapError(() =>
      setupError(`Invalid reference repository configuration at ${configPath}`)
    )
  );
  if (!config.defaultEnabled || settings.skipRequested) {
    yield* Effect.logInfo(
      `${LOG_PREFIX} setup skipped; set ULTRAMODERN_SKIP_AGENT_REPOS=0 to enable it again`
    );
    return yield* Effect.void;
  }
  // Validate all destinations before any Git mutation, including initial commits.
  yield* Effect.forEach(
    config.repositories,
    (repository) => assertSafeRepoPath(repository.path),
    {
      discard: true,
    }
  );
  if (!(yield* hasGit())) {
    return yield* setupError(
      'git is required to install agent reference repositories'
    );
  }
  if (!(yield* hasGitSubtree())) {
    return yield* setupError(
      'git subtree is required to install agent reference repositories'
    );
  }
  yield* ensureGitRepository(checkOnly);
  const entries = yield* Effect.forEach(
    config.repositories,
    (repository) =>
      checkOnly
        ? assertSubtreePresent(manifestPath, repository)
        : addSubtree(manifestPath, repository),
    { concurrency: 1 }
  );
  if (!checkOnly) {
    yield* writeManifest(manifestPath, entries);
    yield* commitManifestIfChanged(manifestPath);
  }
  return yield* Effect.void;
});
const reportSetupFailure =
  (checkOnly: boolean) => (error: AgentReferenceRepoSetupError) =>
    Effect.gen(function* reportSetupFailureEffect() {
      const settings = yield* RuntimeConfiguration;
      if (settings.required || checkOnly) {
        yield* Effect.logError(`${LOG_PREFIX} ${error.reason}`);
        return yield* error;
      }
      yield* Effect.logWarning(`${LOG_PREFIX} ${error.reason}`);
      return yield* Effect.void;
    });
const setupCommand = Command.make(
  'setup-agent-reference-repos',
  { checkOnly: Flag.boolean('check').pipe(Flag.withDefault(false)) },
  ({ checkOnly }) =>
    runSetup(checkOnly).pipe(
      Effect.mapError((cause) =>
        Schema.is(AgentReferenceRepoSetupError)(cause)
          ? cause
          : setupError(String(cause))
      ),
      Effect.catchTag(
        'AgentReferenceRepoSetupError',
        reportSetupFailure(checkOnly)
      )
    )
);
const applicationLayer = Layer.merge(
  NodeServices.layer,
  Layer.effect(RuntimeConfiguration, loadRuntimeSettings())
);
const executableLayer = Layer.effectDiscard(
  Command.run(setupCommand, { version: '1.0.0' })
).pipe(Layer.provide(applicationLayer));
NodeRuntime.runMain(Effect.scoped(Layer.build(executableLayer)));
