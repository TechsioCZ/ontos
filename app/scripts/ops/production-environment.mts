#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Config,
  ConfigProvider,
  Console,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Stdio,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { serviceIdVariable } from '../publish-active-application-composition.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import { CloudflareApiLive, CloudflareCredentials } from './cloudflare-api.mts';
import { OpsShellLive, runCommand } from './ops-shell.mts';
import type { SecretValues } from './ops-shell.mts';
import { ensureSpicedbTls } from './spicedb-tls.mts';
import { StageOperationError } from './stage-operation-error.mts';
import { readVaultSecrets } from './stage-zerops-services.mts';
import {
  DEPLOY_TARGET_VARIABLE,
  ONTOS_REPOSITORY,
  OUTBOX_WORKER_MODE_VARIABLE,
  OpsMode,
  STAGE_ZEROPS_PROJECT_ID,
  ZeropsImportEntrySchema,
  githubApi,
  listGithubSecretNames,
  listGithubVariables,
  listZeropsServices,
  mutate,
  perform,
  readAppText,
  readZeropsImport,
  setGithubSecret,
  setGithubVariable,
} from './stage-operations.mts';
import type { ZeropsImportEntry, ZeropsService } from './stage-operations.mts';

/**
 * Creates the production Zerops project and wires the `production` GitHub environment to it, so the
 * deploy workflow can deploy production (`-f environment=production`). Stage stays cheap: its
 * services run single-container from `app/zerops-import.yaml`. Production's import is derived from
 * that same file, in high availability: each `:single` managed service becomes `:ha`, every runtime
 * service except the run-once migrator runs at least two containers, and the stage-only Cloudflare
 * Tunnel connector and Outbox Worker host are left out (production runs each owner's dedicated worker).
 *
 * `provision` reads before it writes, so a re-run after a partial failure converges. It creates or
 * reuses the Serious-core project `ontos-production`, imports the services it lacks with their
 * secrets, and sets the production variables `ZEROPS_PROJECT_ID`, every `ZEROPS_*_SERVICE_ID`,
 * `SPICEDB_ENDPOINT`, `DEPLOY_TARGET=zerops` and `OUTBOX_WORKER_MODE=dedicated`, plus the
 * `ZEROPS_TOKEN` secret read from standard input. It never deletes a service, variable or secret, and never touches stage.
 *
 * `spicedb-tls` then creates the TLS material SpiceDB refuses to start without on production's
 * `spicedb` service, exactly as the stage cut-over does for stage.
 */
export const PRODUCTION_ENVIRONMENT = 'production';
export const PRODUCTION_PROJECT_NAME = 'ontos-production';
export const PRODUCTION_BRANCH = 'main';
export const PRODUCTION_MIN_CONTAINERS = 2;
export const ZEROPS_PROJECT_ID_VARIABLE = 'ZEROPS_PROJECT_ID';
export const SPICEDB_ENDPOINT_VARIABLE = 'SPICEDB_ENDPOINT';
export const ZEROPS_TOKEN_SECRET = 'ZEROPS_TOKEN';

/** Stage-only services: the Workers VPC tunnel and the combined Outbox Worker host of the Cloudflare target. */
export const STAGE_ONLY_HOSTNAMES: ReadonlySet<string> = new Set(['cloudflared', 'outboxworkerhost']);
/** Runs owner migrations once per deploy and is stopped after; a second container would migrate concurrently. */
const SINGLE_CONTAINER_HOSTNAMES: ReadonlySet<string> = new Set(['migrator']);
/** Zerops caps hostnames at 25 characters, so these setups run under an abbreviated hostname. */
const ABBREVIATED_HOSTNAMES = new Map([['commerce-customer-context-worker', 'commercecstmrcntxtworker']]);
const SHELL_HOSTNAME = 'shellsuperapp';
const SPICEDB_HOSTNAME = 'spicedb';

const SINGLE_VARIANT = ':single@';
const HA_VARIANT = ':ha@';
const GENERATED_SECRET = '<@generateRandomString(<48>)>';
const PREPROCESSOR_HEADER = '#yamlPreprocessor=on\n';
const PRODUCTION_VARIABLES_LABEL = `the ${PRODUCTION_ENVIRONMENT} variable`;
const ZCLI = 'zcli';

export interface ProductionEnvironmentSettings {
  readonly repository: string;
  /** The stage project, whose organization the production project joins by default. */
  readonly stageProjectId: string;
}

export const ProductionEnvironmentConfiguration = Context.Service<ProductionEnvironmentSettings>(
  '@app/scripts/ops/production-environment/ProductionEnvironmentConfiguration',
);

// ---------------------------------------------------------------------------------------------
// The production import

/** The Zerops hostname each zerops.yaml setup deploys to. */
export const zeropsHostname = (setup: string) => ABBREVIATED_HOSTNAMES.get(setup) ?? setup.replaceAll('-', '');

/** The import fields production derives from; every other field is copied as stage declares it. */
const ProductionImportEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    enableSubdomainAccess: Schema.optionalKey(Schema.Boolean),
    hostname: ZeropsImportEntrySchema.schema.fields.hostname,
    minContainers: Schema.optionalKey(Schema.Number),
    type: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type ProductionImportEntry = typeof ProductionImportEntrySchema.Type;

/** A managed service names its deployment variant (`postgresql:single@18`); runtime types have none. */
const isManaged = (entry: ProductionImportEntry) => entry.type.includes(':');

const productionEntry = (entry: ProductionImportEntry): Effect.Effect<ProductionImportEntry, StageOperationError> => {
  if (isManaged(entry)) {
    const { type } = entry;
    if (!type.includes(SINGLE_VARIANT) && !type.includes(HA_VARIANT)) {
      return Effect.fail(
        new StageOperationError({
          message: `${entry.hostname} must name its deployment variant (${SINGLE_VARIANT} or ${HA_VARIANT}), not ${type}`,
        }),
      );
    }
    return Effect.succeed({ ...entry, type: type.replace(SINGLE_VARIANT, HA_VARIANT) });
  }
  if (SINGLE_CONTAINER_HOSTNAMES.has(entry.hostname)) {
    return Effect.succeed(entry);
  }
  return Effect.succeed({ ...entry, minContainers: Math.max(entry.minContainers ?? 1, PRODUCTION_MIN_CONTAINERS) });
};

/** Production's services: stage's import in high availability, without the stage-only services. */
export const productionImportEntries = (stageEntries: readonly ZeropsImportEntry[]) =>
  Schema.decodeUnknownEffect(Schema.Array(ProductionImportEntrySchema))(
    stageEntries.filter(({ hostname }) => !STAGE_ONLY_HOSTNAMES.has(hostname)),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new StageOperationError({ cause, message: 'app/zerops-import.yaml entries must each name a service type' }),
    ),
    Effect.flatMap((entries) => Effect.all(entries.map(productionEntry))),
  );

const ZeropsSetupsSchema = Schema.Struct({ zerops: Schema.Array(Schema.Struct({ setup: Schema.String })) });

const readZeropsSetups = readAppText('zerops.yaml').pipe(
  Effect.flatMap((text) =>
    Schema.decodeUnknownEffect(ZeropsSetupsSchema)(parseYaml(text)).pipe(
      Effect.mapError((cause) => new StageOperationError({ cause, message: 'app/zerops.yaml is not a setup list' })),
    ),
  ),
  Effect.map(({ zerops }) => zerops.map(({ setup }) => setup)),
);

export interface ProductionService {
  readonly entry: ProductionImportEntry;
  /** The zerops.yaml setup CI deploys to it, and its service-ID variable; none for managed services. */
  readonly setup: Option.Option<{ readonly name: string; readonly variable: string }>;
}

/** Every production service with the setup and service-ID variable CI deploys it through. */
export const productionServices = Effect.gen(function* productionServicesEffect() {
  const entries = yield* productionImportEntries(yield* readZeropsImport);
  const setups = yield* readZeropsSetups;
  return yield* Effect.all(
    entries.map((entry) => {
      const setup = setups.find((name) => zeropsHostname(name) === entry.hostname);
      if (setup === undefined && !isManaged(entry)) {
        return Effect.fail(
          new StageOperationError({ message: `app/zerops.yaml has no setup that deploys ${entry.hostname}` }),
        );
      }
      return Effect.succeed({
        entry,
        setup: Option.fromNullishOr(setup).pipe(Option.map((name) => ({ name, variable: serviceIdVariable(name) }))),
      } satisfies ProductionService);
    }),
  );
});

// ---------------------------------------------------------------------------------------------
// Service secrets

/** Secrets Zerops generates at import: SpiceDB's datastore password and pre-shared key, and the auth secret. */
const GENERATED_SECRETS = new Map([
  [SHELL_HOSTNAME, ['BETTER_AUTH_SECRET']],
  [SPICEDB_HOSTNAME, ['SPICEDB_DATABASE_PASSWORD', 'SPICEDB_GRPC_PRESHARED_KEY']],
]);
/** Secrets the operator supplies: the production auth origin and the gateway signing key pair. */
const SHELL_SUPPLIED_SECRETS = ['BETTER_AUTH_TRUSTED_ORIGINS', 'BETTER_AUTH_URL', 'ONTOS_GATEWAY_PRIVATE_JWK'];
const VERTICAL_SUPPLIED_SECRETS = ['ONTOS_GATEWAY_PUBLIC_JWKS'];

const suppliedKeys = (entry: ProductionImportEntry): readonly string[] => {
  if (entry.hostname === SHELL_HOSTNAME) {
    return SHELL_SUPPLIED_SECRETS;
  }
  return entry.enableSubdomainAccess === true ? VERTICAL_SUPPLIED_SECRETS : [];
};

/** The supplied secrets each service needs, by the `<hostname>_<KEY>` name of the vault export. */
export const suppliedSecretNames = (entries: readonly ProductionImportEntry[]) =>
  entries.flatMap((entry) => suppliedKeys(entry).map((key) => `${entry.hostname}_${key}`));

const readSuppliedSecrets = (secretsFile: Option.Option<string>, names: readonly string[]) =>
  Effect.gen(function* readSuppliedSecretsEffect() {
    if (names.length === 0) {
      return new Map<string, Redacted.Redacted>();
    }
    if (Option.isNone(secretsFile)) {
      const { dryRun } = yield* OpsMode;
      if (dryRun) {
        yield* Console.log(`[dry-run] the real run needs --secrets-file with ${names.join(', ')}`);
        return new Map<string, Redacted.Redacted>();
      }
      return yield* new StageOperationError({
        message: `the new services need ${names.join(', ')}; pass them with --secrets-file`,
      });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem
      .readFileString(secretsFile.value)
      .pipe(
        Effect.mapError((cause) => new StageOperationError({ cause, message: 'the secrets file could not be read' })),
      );
    const secrets = yield* readVaultSecrets(contents, names);
    const missing = names.filter((name) => !secrets.has(name));
    if (missing.length > 0) {
      return yield* new StageOperationError({
        message: `the secrets file lacks ${missing.join(', ')}; nothing was imported`,
      });
    }
    return secrets;
  });

const serviceSecrets = (entry: ProductionImportEntry, supplied: ReadonlyMap<string, Redacted.Redacted>): SecretValues =>
  Object.fromEntries([
    ...(GENERATED_SECRETS.get(entry.hostname) ?? []).map((key) => [key, Redacted.make(GENERATED_SECRET)] as const),
    ...suppliedKeys(entry).flatMap((key) => {
      const value = supplied.get(`${entry.hostname}_${key}`);
      return value === undefined ? [] : [[key, value] as const];
    }),
  ]);

/** The import document; the preprocessor header lets Zerops generate the generated secrets. */
export const renderProductionImport = (
  entries: readonly ProductionImportEntry[],
  supplied: ReadonlyMap<string, Redacted.Redacted>,
) =>
  Redacted.make(
    `${PREPROCESSOR_HEADER}${stringifyYaml({
      services: entries.map((entry) => {
        const secrets = Object.entries(serviceSecrets(entry, supplied));
        return secrets.length === 0
          ? entry
          : { ...entry, envSecrets: Object.fromEntries(secrets.map(([key, value]) => [key, Redacted.value(value)])) };
      }),
    })}`,
  );

// ---------------------------------------------------------------------------------------------
// Zerops projects through zcli

export interface ZeropsProject {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
}

/** Parses the table `zcli project list` prints: `│ ID │ NAME │ ORG NAME │ ORG ID │ STATUS │ MODE │`. */
export const parseZeropsProjectList = (output: string): readonly ZeropsProject[] =>
  output.split('\n').flatMap((line) => {
    const cells = line
      .split('│')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    const [id, name, , orgId] = cells;
    return cells.length === 6 && id !== undefined && name !== undefined && orgId !== undefined && id !== 'ID'
      ? [{ id, name, orgId }]
      : [];
  });

const listZeropsProjects = runCommand({ args: ['project', 'list'], command: ZCLI }).pipe(
  Effect.map(parseZeropsProjectList),
);

const createZeropsProject = (orgId: string) =>
  runCommand({
    args: [
      'project',
      'create',
      '--name',
      PRODUCTION_PROJECT_NAME,
      '--mode',
      'serious',
      '--org-id',
      orgId,
      '--out',
      '{{.Id}}',
    ],
    command: ZCLI,
  }).pipe(Effect.map((output) => output.trim()));

const importProductionServices = (projectId: string, document: Redacted.Redacted) =>
  runCommand({ args: ['project', 'service-import', '-', '--project-id', projectId], command: ZCLI, stdin: document });

const PLANNED_PROJECT_ID = `<new ${PRODUCTION_PROJECT_NAME} project id>`;

const recordedProject = (recorded: string, projects: readonly ZeropsProject[]) =>
  Effect.gen(function* recordedProjectEffect() {
    const { stageProjectId } = yield* ProductionEnvironmentConfiguration;
    if (recorded === stageProjectId) {
      return yield* new StageOperationError({
        message: `${PRODUCTION_VARIABLES_LABEL} ${ZEROPS_PROJECT_ID_VARIABLE} names the stage project; production needs its own`,
      });
    }
    if (!projects.some(({ id }) => id === recorded)) {
      return yield* new StageOperationError({
        message: `${PRODUCTION_VARIABLES_LABEL} ${ZEROPS_PROJECT_ID_VARIABLE} names ${recorded}, which zcli does not list; reconcile before provisioning`,
      });
    }
    return { created: false, id: recorded };
  });

/** The production project: the one `ZEROPS_PROJECT_ID` names, else the one named `ontos-production`, else a new one. */
const ensureProject = (variables: ReadonlyMap<string, string>, orgId: Option.Option<string>) =>
  Effect.gen(function* ensureProjectEffect() {
    const { stageProjectId } = yield* ProductionEnvironmentConfiguration;
    const projects = yield* listZeropsProjects;
    const recorded = variables.get(ZEROPS_PROJECT_ID_VARIABLE);
    if (recorded !== undefined && recorded !== '') {
      return yield* recordedProject(recorded, projects);
    }
    const named = projects.filter(({ name }) => name === PRODUCTION_PROJECT_NAME);
    const [existing] = named;
    if (named.length > 1) {
      return yield* new StageOperationError({
        message: `zcli lists ${String(named.length)} projects named ${PRODUCTION_PROJECT_NAME}; set ${ZEROPS_PROJECT_ID_VARIABLE} on ${PRODUCTION_ENVIRONMENT} to the right one`,
      });
    }
    if (existing !== undefined) {
      return { created: false, id: existing.id };
    }
    const organization = Option.orElse(orgId, () =>
      Option.fromNullishOr(projects.find(({ id }) => id === stageProjectId)?.orgId),
    );
    if (Option.isNone(organization)) {
      return yield* new StageOperationError({
        message: 'zcli does not list the stage project, so its organization is unknown; pass --org-id',
      });
    }
    const id = yield* mutate(
      `create the Serious-core Zerops project ${PRODUCTION_PROJECT_NAME} in organization ${organization.value}`,
      createZeropsProject(organization.value),
      PLANNED_PROJECT_ID,
    );
    if (id.length === 0) {
      return yield* new StageOperationError({
        message: `zcli created ${PRODUCTION_PROJECT_NAME} without printing its ID`,
      });
    }
    return { created: true, id };
  });

// ---------------------------------------------------------------------------------------------
// The production GitHub environment

/**
 * Creates `production` when missing, deployable only from `main` and without required reviewers.
 * Succeeds with whether the environment exists afterwards: a dry run only plans its creation.
 */
const ensureGithubEnvironment = Effect.gen(function* ensureGithubEnvironmentEffect() {
  const { repository } = yield* ProductionEnvironmentConfiguration;
  const { dryRun } = yield* OpsMode;
  const environments = yield* githubApi([`repos/${repository}/environments`, '--jq', '.environments[].name']);
  if (environments.split('\n').includes(PRODUCTION_ENVIRONMENT)) {
    return true;
  }
  yield* perform(
    `create the GitHub environment ${PRODUCTION_ENVIRONMENT}, deployable only from ${PRODUCTION_BRANCH}`,
    Effect.gen(function* createEnvironment() {
      yield* githubApi([
        '-X',
        'PUT',
        `repos/${repository}/environments/${PRODUCTION_ENVIRONMENT}`,
        '-F',
        'deployment_branch_policy[protected_branches]=false',
        '-F',
        'deployment_branch_policy[custom_branch_policies]=true',
      ]);
      yield* githubApi([
        '-X',
        'POST',
        `repos/${repository}/environments/${PRODUCTION_ENVIRONMENT}/deployment-branch-policies`,
        '-f',
        `name=${PRODUCTION_BRANCH}`,
        '-f',
        'type=branch',
      ]);
    }),
  );
  return !dryRun;
});

const readTokenFromStdin = Effect.gen(function* readTokenFromStdinEffect() {
  const stdio = yield* Stdio.Stdio;
  const token = (yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)).trim();
  if (token.length === 0) {
    return yield* new StageOperationError({ message: `standard input holds no ${ZEROPS_TOKEN_SECRET}` });
  }
  return Redacted.make(token);
}).pipe(
  Effect.catchTag('PlatformError', (cause) =>
    Effect.fail(new StageOperationError({ cause, message: 'standard input could not be read' })),
  ),
);

const SPICEDB_ENDPOINT_PATTERN = /^[A-Za-z0-9.-]+:[0-9]{1,5}$/u;

// ---------------------------------------------------------------------------------------------
// Provision

export interface ProvisionOptions {
  readonly orgId: Option.Option<string>;
  readonly secretsFile: Option.Option<string>;
  readonly spicedbEndpoint: string;
  /** Read the `ZEROPS_TOKEN` secret from standard input; required until production holds one. */
  readonly zeropsTokenStdin: boolean;
}

interface ServiceIdVariable {
  readonly hostname: string;
  readonly id: string | undefined;
  readonly variable: string;
}

const serviceIdVariables = (
  services: readonly ProductionService[],
  live: readonly ZeropsService[],
): readonly ServiceIdVariable[] =>
  services.flatMap(({ entry, setup }) =>
    Option.match(setup, {
      onNone: () => [],
      onSome: ({ variable }) => [
        { hostname: entry.hostname, id: live.find(({ hostname }) => hostname === entry.hostname)?.id, variable },
      ],
    }),
  );

/** A service-ID variable that names another service than Zerops runs is drift an operator resolves. */
const rejectServiceIdDrift = (planned: readonly ServiceIdVariable[], variables: ReadonlyMap<string, string>) =>
  Effect.forEach(
    planned,
    ({ hostname, id, variable }) => {
      const recorded = variables.get(variable);
      return id !== undefined && recorded !== undefined && recorded !== '' && recorded !== id
        ? Effect.fail(
            new StageOperationError({
              message: `${PRODUCTION_VARIABLES_LABEL} ${variable} names ${recorded}, but Zerops runs ${hostname} as ${id}; reconcile before provisioning`,
            }),
          )
        : Effect.void;
    },
    { discard: true },
  );

const importMissingServices = (
  projectId: string,
  services: readonly ProductionService[],
  live: readonly ZeropsService[],
  secretsFile: Option.Option<string>,
) =>
  Effect.gen(function* importMissingServicesEffect() {
    const missing = services
      .map(({ entry }) => entry)
      .filter(({ hostname }) => !live.some((service) => service.hostname === hostname));
    if (missing.length === 0) {
      return;
    }
    const supplied = yield* readSuppliedSecrets(secretsFile, suppliedSecretNames(missing));
    yield* perform(
      `import the production services ${missing.map(({ hostname }) => hostname).join(', ')} into ${projectId}`,
      importProductionServices(projectId, renderProductionImport(missing, supplied)),
    );
  });

export const provision = (options: ProvisionOptions) =>
  Effect.gen(function* provisionEffect() {
    const { repository } = yield* ProductionEnvironmentConfiguration;
    const { dryRun } = yield* OpsMode;
    if (!SPICEDB_ENDPOINT_PATTERN.test(options.spicedbEndpoint)) {
      return yield* new StageOperationError({
        message: `--spicedb-endpoint must be production's TLS SpiceDB endpoint as host:port, got "${options.spicedbEndpoint}"`,
      });
    }
    const services = yield* productionServices;
    // A dry run that only plans the environment cannot read it; a new environment holds nothing.
    const environmentExists = yield* ensureGithubEnvironment;
    const variables = environmentExists
      ? yield* listGithubVariables(repository, PRODUCTION_ENVIRONMENT)
      : new Map<string, string>();
    const secretNames = environmentExists
      ? yield* listGithubSecretNames(repository, PRODUCTION_ENVIRONMENT)
      : new Set<string>();
    if (!options.zeropsTokenStdin && !secretNames.has(ZEROPS_TOKEN_SECRET)) {
      if (!dryRun) {
        return yield* new StageOperationError({
          message: `${PRODUCTION_ENVIRONMENT} has no ${ZEROPS_TOKEN_SECRET} secret; pipe a production Zerops token and add --zerops-token-stdin`,
        });
      }
      yield* Console.log(
        `[dry-run] ${PRODUCTION_ENVIRONMENT} has no ${ZEROPS_TOKEN_SECRET} secret; the real run needs a production Zerops token piped with --zerops-token-stdin`,
      );
    }
    const token = options.zeropsTokenStdin ? Option.some(yield* readTokenFromStdin) : Option.none();

    const project = yield* ensureProject(variables, options.orgId);
    const live = project.created ? [] : yield* listZeropsServices(project.id);
    yield* rejectServiceIdDrift(serviceIdVariables(services, live), variables);
    yield* importMissingServices(project.id, services, live, options.secretsFile);

    const current = dryRun && project.created ? [] : yield* listZeropsServices(project.id);
    const planned = serviceIdVariables(services, current);
    const unresolved = planned.filter(({ id }) => id === undefined);
    // Only a dry run plans with placeholders; a real run never points production at a service it cannot see.
    if (!dryRun && unresolved.length > 0) {
      return yield* new StageOperationError({
        message: `Zerops lists no ${unresolved.map(({ hostname }) => hostname).join(', ')} after the import; no ${PRODUCTION_ENVIRONMENT} variable was changed. Re-run provision once they appear`,
      });
    }
    const desired: readonly (readonly [string, string])[] = [
      [ZEROPS_PROJECT_ID_VARIABLE, project.id],
      ...planned.map(({ hostname, id, variable }) => [variable, id ?? `<new ${hostname} service id>`] as const),
      [SPICEDB_ENDPOINT_VARIABLE, options.spicedbEndpoint],
      [DEPLOY_TARGET_VARIABLE, 'zerops'],
      [OUTBOX_WORKER_MODE_VARIABLE, 'dedicated'],
    ];
    for (const [name, value] of desired) {
      if (variables.get(name) !== value) {
        yield* perform(
          `set ${PRODUCTION_VARIABLES_LABEL} ${name}=${value}`,
          setGithubVariable(repository, PRODUCTION_ENVIRONMENT, name, value),
        );
      }
    }
    if (Option.isSome(token)) {
      yield* perform(
        `set the ${PRODUCTION_ENVIRONMENT} secret ${ZEROPS_TOKEN_SECRET} from standard input`,
        setGithubSecret(repository, PRODUCTION_ENVIRONMENT, ZEROPS_TOKEN_SECRET, token.value),
      );
    }
    yield* Console.log(
      `Production is wired to ${project.id}. Create its SpiceDB TLS secrets (spicedb-tls --gateway-hostname <name>), set its project variables, then deploy: gh workflow run ultramodern-workspace-gates.yml --ref main -f environment=production -f full=true`,
    );
    return yield* Effect.void;
  });

/** Prints the production import without secrets, for review. */
export const renderImport = productionServices.pipe(
  Effect.flatMap((services) =>
    Console.log(
      Redacted.value(
        renderProductionImport(
          services.map(({ entry }) => entry),
          new Map(),
        ),
      ),
    ),
  ),
);

// ---------------------------------------------------------------------------------------------
// SpiceDB TLS

const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;

/**
 * Creates the SpiceDB gRPC and HTTP gateway TLS secrets on production's `spicedb` service when they are
 * missing, as `cloudflare-stage-cutover.mts spicedb-tls` does for stage. SpiceDB starts only with both
 * pairs. The gateway certificate comes from the Cloudflare Origin CA for `gatewayHostname`, a name in a
 * zone of the Cloudflare account; it is only a TLS server name and needs no DNS record. The project is
 * the one the `production` variable `ZEROPS_PROJECT_ID` names, so run `provision` first.
 */
export const ensureProductionSpicedbTls = (gatewayHostname: string) =>
  Effect.gen(function* ensureProductionSpicedbTlsEffect() {
    const { repository, stageProjectId } = yield* ProductionEnvironmentConfiguration;
    if (!HOSTNAME_PATTERN.test(gatewayHostname)) {
      return yield* new StageOperationError({
        message: `--gateway-hostname must be a DNS hostname, got "${gatewayHostname}"`,
      });
    }
    const variables = yield* listGithubVariables(repository, PRODUCTION_ENVIRONMENT);
    const projectId = variables.get(ZEROPS_PROJECT_ID_VARIABLE) ?? '';
    if (projectId === '') {
      return yield* new StageOperationError({
        message: `${PRODUCTION_VARIABLES_LABEL} ${ZEROPS_PROJECT_ID_VARIABLE} is not set; run provision first`,
      });
    }
    if (projectId === stageProjectId) {
      return yield* new StageOperationError({
        message: `${PRODUCTION_VARIABLES_LABEL} ${ZEROPS_PROJECT_ID_VARIABLE} names the stage project; production needs its own`,
      });
    }
    return yield* ensureSpicedbTls({ gatewayHostname, projectId });
  });

// ---------------------------------------------------------------------------------------------
// Composition root

const productionLayer = ({ dryRun }: { readonly dryRun: boolean }) =>
  Layer.merge(
    Layer.succeed(OpsMode, { dryRun }),
    Layer.succeed(ProductionEnvironmentConfiguration, {
      repository: ONTOS_REPOSITORY,
      stageProjectId: STAGE_ZEROPS_PROJECT_ID,
    }),
  );

const provisionCommand = Command.make(
  'provision',
  {
    dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)),
    orgId: Flag.String('org-id').pipe(Flag.optional),
    secretsFile: Flag.String('secrets-file').pipe(Flag.optional),
    spicedbEndpoint: Flag.String('spicedb-endpoint'),
    zeropsTokenStdin: Flag.Boolean('zerops-token-stdin').pipe(Flag.withDefault(false)),
  },
  ({ orgId, secretsFile, spicedbEndpoint, zeropsTokenStdin }) =>
    provision({ orgId, secretsFile, spicedbEndpoint, zeropsTokenStdin }),
).pipe(
  Command.withDescription(
    'Create or reuse the HA production Zerops project, import its missing services and wire the production GitHub environment',
  ),
  Command.provide((input) => productionLayer(input)),
);

/** Cloudflare and Zerops API access from the environment, or else from the optional dotenv file. */
const spicedbTlsLayer = ({
  dryRun,
  envFile,
}: {
  readonly dryRun: boolean;
  readonly envFile: Option.Option<string>;
}) => {
  const settingsFile = Effect.gen(function* settingsFileEffect() {
    if (Option.isNone(envFile)) {
      return ConfigProvider.fromUnknown({});
    }
    return yield* ConfigProvider.fromDotEnv({ path: envFile.value });
  });
  const credentials = Layer.effect(
    CloudflareCredentials,
    Effect.gen(function* cloudflareCredentials() {
      return {
        accountId: yield* Config.String('CLOUDFLARE_ACCOUNT_ID'),
        apiToken: yield* Config.Redacted('CLOUDFLARE_API_TOKEN'),
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StageOperationError({
            cause,
            message: `CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in the environment or --env-file (${cause.message}); nothing was changed`,
          }),
      ),
    ),
  );
  // The settings stay in the step's context: the Zerops API reads ZEROPS_TOKEN per request.
  return Layer.mergeAll(CloudflareApiLive.pipe(Layer.provide(credentials)), ZeropsPublicApiLive).pipe(
    Layer.provideMerge(productionLayer({ dryRun })),
    Layer.provideMerge(ConfigProvider.layerAdd(settingsFile)),
  );
};

const spicedbTlsCommand = Command.make(
  'spicedb-tls',
  {
    dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)),
    envFile: Flag.String('env-file').pipe(Flag.optional),
    gatewayHostname: Flag.String('gateway-hostname'),
  },
  ({ gatewayHostname }) => ensureProductionSpicedbTls(gatewayHostname),
).pipe(
  Command.withDescription(
    "Create the SpiceDB gRPC and HTTP gateway TLS certificates as secrets on production's Zerops spicedb service when missing",
  ),
  Command.provide((input) => spicedbTlsLayer(input)),
);

const renderImportCommand = Command.make('render-import', {}, () => renderImport).pipe(
  Command.withDescription('Print the production import derived from app/zerops-import.yaml, without secrets'),
);

const cli = Command.make('production-environment').pipe(
  Command.withSubcommands([provisionCommand, spicedbTlsCommand, renderImportCommand]),
);

export const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(main).pipe(
        Layer.provide(OpsShellLive),
        Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
