import { Console, Context, Effect, FileSystem, Path, Redacted, Schema } from 'effect';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runCommand } from './ops-shell.mts';
import type { SecretValues } from './ops-shell.mts';
import { StageOperationError } from './stage-operation-error.mts';

/**
 * Shared vocabulary of the stage operations scripts: the stage Zerops project, the GitHub
 * environments, the Zerops import entries, and the dry-run gate every mutation passes through.
 * Zerops is driven through the locally authenticated `zcli` and GitHub through `gh`, both behind
 * the `OpsShell` seam.
 */
export const STAGE_ZEROPS_PROJECT_ID = 't1ljmn3DRDafgi8AuPvhdQ';
export const ONTOS_REPOSITORY = 'TechsioCZ/ontos';
export const STAGE_ENVIRONMENT = 'stage';
export const STAGE_EDGE_ENVIRONMENT = 'stage-edge';
export const DEPLOY_WORKFLOW = 'ultramodern-workspace-gates.yml';
export const DEPLOY_TARGET_VARIABLE = 'DEPLOY_TARGET';
/** `dedicated` or `host`: how an environment runs its Outbox Workers, whatever its deploy target. */
export const OUTBOX_WORKER_MODE_VARIABLE = 'OUTBOX_WORKER_MODE';

const ZCLI = 'zcli';
const GH = 'gh';
const PROJECT_ID_FLAG = '--project-id';
const REPOSITORY_FLAG = '--repo';
const ENVIRONMENT_FLAG = '--env';

export interface OpsModeSettings {
  /** Reads always run, so a dry run reports the real plan; mutations are only reported. */
  readonly dryRun: boolean;
}

export const OpsMode = Context.Service<OpsModeSettings>('@app/scripts/ops/stage-operations/OpsMode');

/**
 * Runs `effect` unless this is a dry run, in which case it reports the mutation and returns
 * `planned`, the value later steps plan with.
 */
export const mutate = <A, E, R>(description: string, effect: Effect.Effect<A, E, R>, planned: A) =>
  Effect.gen(function* mutateEffect() {
    const { dryRun } = yield* OpsMode;
    if (dryRun) {
      yield* Console.log(`[dry-run] would ${description}`);
      return planned;
    }
    yield* Console.log(description);
    return yield* effect;
  });

/** {@link mutate} for a mutation whose result nothing plans with. */
export const perform = <A, E, R>(description: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* performEffect() {
    const { dryRun } = yield* OpsMode;
    yield* Console.log(dryRun ? `[dry-run] would ${description}` : description);
    if (!dryRun) {
      yield* effect;
    }
  });

/** Decodes a document the operations read, failing with a message that names it. */
export const decodeInput =
  <A,>(schema: Schema.Codec<A, string>, label: string) =>
  (input: string) =>
    Schema.decodeEffect(schema)(input).pipe(
      Effect.mapError((cause) => new StageOperationError({ cause, message: `${label} is not in the expected form` })),
    );

// ---------------------------------------------------------------------------------------------
// Repository files

export const appDirectory = Effect.gen(function* appDirectoryEffect() {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, '..', '..');
});

export const repositoryDirectory = Effect.gen(function* repositoryDirectoryEffect() {
  const path = yield* Path.Path;
  return path.resolve(yield* appDirectory, '..');
});

export const appFile = (...segments: readonly string[]) =>
  Effect.gen(function* appFileEffect() {
    const path = yield* Path.Path;
    return path.join(yield* appDirectory, ...segments);
  });

export const readAppText = (...segments: readonly string[]) =>
  Effect.gen(function* readAppTextEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(yield* appFile(...segments));
  }).pipe(
    Effect.mapError(
      (cause) => new StageOperationError({ cause, message: `app/${segments.join('/')} could not be read` }),
    ),
  );

/** One `zerops-import.yaml` service entry, kept verbatim so a re-import recreates the same service. */
export const ZeropsImportEntrySchema = Schema.StructWithRest(
  Schema.Struct({ hostname: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,25}$/u)) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type ZeropsImportEntry = typeof ZeropsImportEntrySchema.Type;

const ImportDocumentSchema = Schema.Struct({ services: Schema.Array(ZeropsImportEntrySchema) });

export const decodeZeropsImport = (yamlText: string) =>
  Schema.decodeUnknownEffect(ImportDocumentSchema)(parseYaml(yamlText)).pipe(
    Effect.map(({ services }) => services),
    Effect.mapError(
      (cause) => new StageOperationError({ cause, message: 'app/zerops-import.yaml is not a Zerops service list' }),
    ),
  );

export const readZeropsImport = readAppText('zerops-import.yaml').pipe(Effect.flatMap(decodeZeropsImport));

export const importEntry = (entries: readonly ZeropsImportEntry[], hostname: string) => {
  const entry = entries.find((candidate) => candidate.hostname === hostname);
  return entry === undefined
    ? Effect.fail(
        new StageOperationError({
          message: `app/zerops-import.yaml has no "${hostname}" service; merge its Zerops setup first`,
        }),
      )
    : Effect.succeed(entry);
};

/** An import entry plus the secrets Zerops stores with it; they stay redacted until piped to `zcli`. */
export interface ServiceImport {
  readonly entry: ZeropsImportEntry;
  readonly envSecrets: SecretValues;
}

export const renderImportDocument = (imports: readonly ServiceImport[]): Redacted.Redacted =>
  Redacted.make(
    stringifyYaml({
      services: imports.map(({ entry, envSecrets }) => {
        const secrets = Object.entries(envSecrets);
        return secrets.length === 0
          ? entry
          : { ...entry, envSecrets: Object.fromEntries(secrets.map(([key, value]) => [key, Redacted.value(value)])) };
      }),
    }),
  );

// ---------------------------------------------------------------------------------------------
// Zerops through zcli

export interface ZeropsService {
  readonly hostname: string;
  readonly id: string;
  readonly status: string;
}

/** Parses the table `zcli service list` prints: `│ ID │ NAME │ STATUS │` rows under a header row. */
export const parseZeropsServiceList = (output: string): readonly ZeropsService[] =>
  output.split('\n').flatMap((line) => {
    const cells = line
      .split('│')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    const [id, hostname, status] = cells;
    return cells.length === 3 && id !== undefined && hostname !== undefined && status !== undefined && id !== 'ID'
      ? [{ hostname, id, status }]
      : [];
  });

export const listZeropsServices = (projectId: string) =>
  runCommand({ args: ['service', 'list', PROJECT_ID_FLAG, projectId], command: ZCLI }).pipe(
    Effect.map(parseZeropsServiceList),
  );

const ENV_KEY_PATTERN = /^[A-Za-z0-9_]+$/u;

const projectEnvArgs = (projectId: string, template: string, scope: readonly string[]) => [
  'project',
  'env',
  PROJECT_ID_FLAG,
  projectId,
  ...scope,
  '--template',
  template,
];

/**
 * Reads one Zerops variable into memory without printing it. The Go template emits only the named
 * key's value, so no other variable crosses the process boundary. Cross-service values use the
 * project scope's `<hostname>_<KEY>` names (for example `db18_password`).
 */
export const readZeropsValue = (projectId: string, key: string) =>
  Effect.gen(function* readZeropsValueEffect() {
    if (!ENV_KEY_PATTERN.test(key)) {
      return yield* new StageOperationError({ message: `"${key}" is not a Zerops variable name` });
    }
    const output = yield* runCommand({
      args: projectEnvArgs(projectId, `{{if eq .Key "${key}"}}{{.Value}}{{end}}`, []),
      command: ZCLI,
    });
    const value = output.replaceAll(/^\n+|\n+$/gu, '');
    if (value.length === 0) {
      return yield* new StageOperationError({ message: `Zerops project ${projectId} has no value for ${key}` });
    }
    return Redacted.make(value);
  });

const keyLines = (output: string) =>
  output
    .split('\n')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

/** The user-defined variable KEYS of the project scope, never their values. */
export const listZeropsProjectUserKeys = (projectId: string) =>
  runCommand({ args: [...projectEnvArgs(projectId, '{{.Key}}', []), '--user-only'], command: ZCLI }).pipe(
    Effect.map(keyLines),
  );

/** The user-defined variable KEYS a service sees, never their values. */
export const listZeropsServiceUserKeys = (projectId: string, hostname: string) =>
  runCommand({
    args: [...projectEnvArgs(projectId, '{{.Key}}', ['--service', hostname]), '--user-only'],
    command: ZCLI,
  }).pipe(Effect.map(keyLines));

export const importZeropsServices = (projectId: string, imports: readonly ServiceImport[]) =>
  runCommand({
    args: ['project', 'service-import', '-', PROJECT_ID_FLAG, projectId],
    command: ZCLI,
    stdin: renderImportDocument(imports),
  });

export const deleteZeropsService = (projectId: string, serviceId: string) =>
  runCommand({
    args: ['service', 'delete', PROJECT_ID_FLAG, projectId, '--service-id', serviceId, '--confirm'],
    command: ZCLI,
  });

// ---------------------------------------------------------------------------------------------
// GitHub through gh

export const setGithubVariable = (repository: string, environment: string, name: string, value: string) =>
  runCommand({
    args: ['variable', 'set', name, REPOSITORY_FLAG, repository, ENVIRONMENT_FLAG, environment, '--body', value],
    command: GH,
  });

export const setGithubSecret = (repository: string, environment: string, name: string, value: Redacted.Redacted) =>
  runCommand({
    args: ['secret', 'set', name, REPOSITORY_FLAG, repository, ENVIRONMENT_FLAG, environment],
    command: GH,
    stdin: value,
  });

const GithubSecretNamesSchema = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })));

/** Secret names of a GitHub environment; GitHub never returns the values. */
export const listGithubSecretNames = (repository: string, environment: string) =>
  runCommand({
    args: ['secret', 'list', REPOSITORY_FLAG, repository, ENVIRONMENT_FLAG, environment, '--json', 'name'],
    command: GH,
  }).pipe(
    Effect.flatMap(decodeInput(GithubSecretNamesSchema, `the ${environment} secret list`)),
    Effect.map((secrets): ReadonlySet<string> => new Set(secrets.map(({ name }) => name))),
  );

const GithubVariablesSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
);

export const listGithubVariables = (repository: string, environment: string) =>
  runCommand({
    args: ['variable', 'list', REPOSITORY_FLAG, repository, ENVIRONMENT_FLAG, environment, '--json', 'name,value'],
    command: GH,
  }).pipe(
    Effect.flatMap(decodeInput(GithubVariablesSchema, `the ${environment} variable list`)),
    Effect.map((variables): ReadonlyMap<string, string> => new Map(variables.map(({ name, value }) => [name, value]))),
  );

export const githubApi = (args: readonly string[]) => runCommand({ args: ['api', ...args], command: GH });

export const dispatchFullDeploy = (repository: string) =>
  runCommand({
    args: ['workflow', 'run', DEPLOY_WORKFLOW, REPOSITORY_FLAG, repository, '--ref', 'main', '-f', 'full=true'],
    command: GH,
  });
