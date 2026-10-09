#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Array as Arr,
  Config,
  ConfigProvider,
  Console,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Schema,
} from 'effect';
import type { Redacted } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { parse as parseYaml } from 'yaml';

import { serviceIdVariable } from '../publish-active-application-composition.mts';
import { OpsShellLive, runCommand } from './ops-shell.mts';
import { StageOperationError } from './stage-operation-error.mts';
import {
  DEPLOY_TARGET_VARIABLE,
  ONTOS_REPOSITORY,
  OpsMode,
  STAGE_ENVIRONMENT,
  STAGE_ZEROPS_PROJECT_ID,
  ZeropsImportEntrySchema,
  appFile,
  decodeInput,
  deleteZeropsService,
  dispatchFullDeploy,
  importZeropsServices,
  listGithubVariables,
  listZeropsProjectUserKeys,
  listZeropsServiceUserKeys,
  listZeropsServices,
  perform,
  readAppText,
  readZeropsImport,
  repositoryDirectory,
  setGithubVariable,
} from './stage-operations.mts';
import type { ServiceImport, ZeropsImportEntry, ZeropsService } from './stage-operations.mts';

/**
 * Retires and restores the stage Zerops services Cloudflare mode no longer uses (design section
 * 11a): the 10 application services the Workers replace. The migrator, SpiceDB and the Outbox Worker
 * host keep running on the Cloudflare target. The per-vertical outbox workers are not needed in `host`
 * mode and may be deleted: each deploy treats a deleted worker like a stopped one when it detects an
 * OUTBOX_WORKER_MODE switch. A switch back to `dedicated` first re-imports them from `zerops-import.yaml`
 * and points their `ZEROPS_*_WORKER_SERVICE_ID` variables at the new services. `app/zerops.yaml`, `app/zerops-import.yaml`, every GitHub variable and every deploy script
 * stay untouched, so production and a switch back keep working.
 *
 * `retire` records, per service, its ID, status, `zerops-import.yaml` entry, stage service-ID
 * variable, and the KEYS (never values) of its variables, split by where a restore gets them back.
 * The record is the versioned file `scripts/ops/stage-zerops-retirement.json`; commit it. Services
 * are deleted only with `--confirm`, and only once stage deploys with DEPLOY_TARGET=cloudflare.
 *
 * `restore` re-imports every recorded service that the current `app/zerops-import.yaml` still
 * declares, sets its service-level secrets from `--secrets-file` (a dotenv export of the vault,
 * keyed `<hostname>_<KEY>` like Zerops' own cross-service names), points the stage service-ID
 * variables at the new services, sets DEPLOY_TARGET=zerops and dispatches the full Zerops deploy.
 */
export const RETIREMENT_RECORD_PATH = ['scripts', 'ops', 'stage-zerops-retirement.json'] as const;
const RETIREMENT_RECORD_LABEL = 'scripts/ops/stage-zerops-retirement.json';

/** The stage services Cloudflare mode replaces, with the zerops.yaml setup each one deploys. */
export const RETIRED_STAGE_SERVICES = [
  { hostname: 'shellsuperapp', setup: 'shellsuperapp' },
  { hostname: 'partyregistry', setup: 'party-registry' },
  { hostname: 'commercecustomercontext', setup: 'commerce-customer-context' },
  { hostname: 'paymenttermcatalog', setup: 'payment-term-catalog' },
  { hostname: 'commercemarketcatalog', setup: 'commerce-market-catalog' },
  { hostname: 'catalog', setup: 'catalog' },
  { hostname: 'assortment', setup: 'assortment' },
  { hostname: 'pricing', setup: 'pricing' },
  { hostname: 'storefrontregistry', setup: 'storefront-registry' },
  { hostname: 'pricegroupcatalog', setup: 'price-group-catalog' },
  { hostname: 'inventory', setup: 'inventory' },
  { hostname: 'availability', setup: 'availability' },
  { hostname: 'privacy', setup: 'privacy' },
] as const;

const EnvironmentKeySchema = Schema.NonEmptyString.pipe(Schema.brand('ZeropsEnvironmentKey'));
const EnvironmentKeysSchema = Schema.Array(EnvironmentKeySchema);
const ZeropsServiceIdSchema = Schema.NonEmptyString.pipe(Schema.brand('ZeropsServiceId'));
const ZeropsProjectIdSchema = Schema.NonEmptyString.pipe(Schema.brand('ZeropsProjectId'));

const RetiredServiceSchema = Schema.Struct({
  environmentKeys: Schema.Struct({
    /** Declared by the setup's `run.envVariables`; the next deploy sets them again. */
    fromZeropsYaml: EnvironmentKeysSchema,
    /** Project variables every service inherits; retirement does not touch them. */
    inheritedFromProject: EnvironmentKeysSchema,
    /** Set on the service itself (secrets); a restore takes them from `--secrets-file`. */
    serviceSecrets: EnvironmentKeysSchema,
  }),
  hostname: Schema.String,
  importEntry: Schema.OptionFromNullOr(ZeropsImportEntrySchema),
  serviceId: ZeropsServiceIdSchema,
  serviceIdVariable: Schema.String,
  setup: Schema.String,
  status: Schema.String,
});
export type RetiredService = typeof RetiredServiceSchema.Type;

export const RetirementRecordSchema = Schema.fromJsonString(
  Schema.Struct({
    capturedAt: Schema.DateTimeUtcFromString,
    projectId: ZeropsProjectIdSchema,
    schemaVersion: Schema.Literal(1),
    services: Schema.Array(RetiredServiceSchema),
    sourceRevision: Schema.String,
  }),
  { space: 2 },
);
export type RetirementRecord = typeof RetirementRecordSchema.Type;

export interface StageServicesSettings {
  readonly projectId: string;
  readonly repository: string;
}

export const StageServicesConfiguration = Context.Service<StageServicesSettings>(
  '@app/scripts/ops/stage-zerops-services/StageServicesConfiguration',
);

// ---------------------------------------------------------------------------------------------
// Capture

const ZeropsYamlSchema = Schema.Struct({
  zerops: Schema.Array(
    Schema.Struct({
      run: Schema.optionalKey(
        Schema.Struct({ envVariables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
      ),
      setup: Schema.String,
    }),
  ),
});

/** The `run.envVariables` keys of every zerops.yaml setup. */
export const zeropsYamlEnvironmentKeys = (yamlText: string) =>
  Schema.decodeUnknownEffect(ZeropsYamlSchema)(parseYaml(yamlText)).pipe(
    Effect.map(
      ({ zerops }): ReadonlyMap<string, ReadonlySet<string>> =>
        new Map(zerops.map(({ run, setup }) => [setup, new Set(Object.keys(run?.envVariables ?? {}))])),
    ),
    Effect.mapError((cause) => new StageOperationError({ cause, message: 'app/zerops.yaml is not a setup list' })),
  );

/**
 * Splits a service's user variable keys by how a restore gets them back. Project keys are the
 * project scope's own variables, not the `<hostname>_<KEY>` references it lists for every service.
 */
const sortedEnvironmentKeys = (keys: readonly string[]) =>
  Arr.sort(
    keys.map((key) => EnvironmentKeySchema.make(key)),
    Order.String,
  );

export const classifyEnvironmentKeys = (input: {
  readonly projectKeys: readonly string[];
  readonly serviceHostnames: readonly string[];
  readonly serviceKeys: readonly string[];
  readonly zeropsYamlKeys: ReadonlySet<string>;
}): RetiredService['environmentKeys'] => {
  const projectOwnKeys = new Set(
    input.projectKeys.filter((key) => !input.serviceHostnames.some((hostname) => key.startsWith(`${hostname}_`))),
  );
  const notFromYaml = input.serviceKeys.filter((key) => !input.zeropsYamlKeys.has(key));
  return {
    fromZeropsYaml: sortedEnvironmentKeys(input.serviceKeys.filter((key) => input.zeropsYamlKeys.has(key))),
    inheritedFromProject: sortedEnvironmentKeys(notFromYaml.filter((key) => projectOwnKeys.has(key))),
    serviceSecrets: sortedEnvironmentKeys(notFromYaml.filter((key) => !projectOwnKeys.has(key))),
  };
};

/** Live records replace recorded ones; services already gone keep their earlier record. */
export const mergeRetiredServices = (
  recorded: readonly RetiredService[],
  captured: readonly RetiredService[],
): readonly RetiredService[] => {
  const capturedHostnames = new Set(captured.map(({ hostname }) => hostname));
  return RETIRED_STAGE_SERVICES.flatMap(({ hostname }) => {
    const record = capturedHostnames.has(hostname)
      ? captured.find((service) => service.hostname === hostname)
      : recorded.find((service) => service.hostname === hostname);
    return record === undefined ? [] : [record];
  });
};

const readRecord = Effect.gen(function* readRecordEffect() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* appFile(...RETIREMENT_RECORD_PATH);
  if (!(yield* fileSystem.exists(path))) {
    return Option.none<RetirementRecord>();
  }
  const text = yield* readAppText(...RETIREMENT_RECORD_PATH);
  return Option.some(yield* decodeInput(RetirementRecordSchema, RETIREMENT_RECORD_LABEL)(text));
});

const captureService = (
  service: ZeropsService,
  retired: (typeof RETIRED_STAGE_SERVICES)[number],
  context: {
    readonly entries: readonly ZeropsImportEntry[];
    readonly liveHostnames: readonly string[];
    readonly projectKeys: readonly string[];
    readonly stageVariables: ReadonlyMap<string, string>;
    readonly zeropsYamlKeys: ReadonlyMap<string, ReadonlySet<string>>;
  },
) =>
  Effect.gen(function* captureServiceEffect() {
    const { projectId } = yield* StageServicesConfiguration;
    const variable = serviceIdVariable(retired.setup);
    const recordedId = context.stageVariables.get(variable);
    if (recordedId !== undefined && recordedId !== service.id) {
      return yield* new StageOperationError({
        message: `${variable} names ${recordedId}, but Zerops runs ${retired.hostname} as ${service.id}; reconcile before retiring`,
      });
    }
    return {
      environmentKeys: classifyEnvironmentKeys({
        projectKeys: context.projectKeys,
        serviceHostnames: context.liveHostnames,
        serviceKeys: yield* listZeropsServiceUserKeys(projectId, retired.hostname),
        zeropsYamlKeys: context.zeropsYamlKeys.get(retired.setup) ?? new Set(),
      }),
      hostname: retired.hostname,
      importEntry: Option.fromNullishOr(context.entries.find(({ hostname }) => hostname === retired.hostname)),
      serviceId: ZeropsServiceIdSchema.make(service.id),
      serviceIdVariable: variable,
      setup: retired.setup,
      status: service.status,
    } satisfies RetiredService;
  });

// ---------------------------------------------------------------------------------------------
// Retire

/**
 * DEPLOY_TARGET only chooses where CI deploys; the public stage hostnames move to the Workers in DNS,
 * outside this repository. Deleting the services before that move takes stage down, so the operator
 * confirms the DNS cut-over explicitly.
 */
const retirementPreconditions = (options: { readonly dnsCutOver: boolean }) =>
  Effect.gen(function* retirementPreconditionsEffect() {
    const { repository } = yield* StageServicesConfiguration;
    const stageVariables = yield* listGithubVariables(repository, STAGE_ENVIRONMENT);
    if (stageVariables.get(DEPLOY_TARGET_VARIABLE) !== 'cloudflare') {
      return yield* new StageOperationError({
        message: `${STAGE_ENVIRONMENT} does not deploy with ${DEPLOY_TARGET_VARIABLE}=cloudflare yet; verify and activate the Cloudflare stage first`,
      });
    }
    if (!options.dnsCutOver) {
      return yield* new StageOperationError({
        message:
          'the stage hostnames may still route to these Zerops services; after the first Cloudflare-target deploy run `cloudflare-stage-cutover verify`, move their DNS to the Cloudflare Workers, check the Shell answers from Cloudflare, then add --dns-cut-over',
      });
    }
    return yield* Effect.void;
  });

export const retire = (options: { readonly confirm: boolean; readonly dnsCutOver: boolean }) =>
  Effect.gen(function* retireEffect() {
    const { projectId, repository } = yield* StageServicesConfiguration;
    const fileSystem = yield* FileSystem.FileSystem;
    const live = yield* listZeropsServices(projectId);
    if (options.confirm) {
      yield* retirementPreconditions(options);
    }
    const liveHostnames = live.map(({ hostname }) => hostname);
    const context = {
      entries: yield* readZeropsImport,
      liveHostnames,
      projectKeys: yield* listZeropsProjectUserKeys(projectId),
      stageVariables: yield* listGithubVariables(repository, STAGE_ENVIRONMENT),
      zeropsYamlKeys: yield* readAppText('zerops.yaml').pipe(Effect.flatMap(zeropsYamlEnvironmentKeys)),
    };
    const present = RETIRED_STAGE_SERVICES.flatMap((retired) => {
      const service = live.find(({ hostname }) => hostname === retired.hostname);
      return service === undefined ? [] : [{ retired, service }];
    });
    const captured = yield* Effect.forEach(
      present,
      ({ retired, service }) => captureService(service, retired, context),
      {
        concurrency: 1,
      },
    );
    const recorded = yield* readRecord;
    const record: RetirementRecord = {
      capturedAt: yield* DateTime.now,
      projectId: ZeropsProjectIdSchema.make(projectId),
      schemaVersion: 1,
      services: mergeRetiredServices(
        Option.match(recorded, { onNone: () => [], onSome: ({ services }) => services }),
        captured,
      ),
      sourceRevision: (yield* runCommand({
        args: ['rev-parse', 'HEAD'],
        command: 'git',
        cwd: yield* repositoryDirectory,
      })).trim(),
    };
    const text = yield* Schema.encodeEffect(RetirementRecordSchema)(record).pipe(
      Effect.mapError(
        (cause) => new StageOperationError({ cause, message: `${RETIREMENT_RECORD_LABEL} could not be encoded` }),
      ),
    );
    yield* perform(
      `record ${String(record.services.length)} retired services in ${RETIREMENT_RECORD_LABEL}; commit it`,
      Effect.gen(function* writeRecord() {
        yield* fileSystem.writeFileString(yield* appFile(...RETIREMENT_RECORD_PATH), `${text}\n`);
      }),
    );
    if (!options.confirm) {
      const deletable = present.map(({ service }) => `${service.hostname} (${service.id})`);
      yield* Console.log(
        deletable.length === 0
          ? 'Recorded only; nothing is left to delete.'
          : `Recorded only. Re-run with --confirm to delete ${deletable.join(', ')}.`,
      );
      return;
    }
    for (const { service } of present) {
      yield* perform(
        `delete the Zerops service ${service.hostname} (${service.id})`,
        deleteZeropsService(projectId, service.id),
      );
    }
  });

// ---------------------------------------------------------------------------------------------
// Restore

/** Every recorded secret a restore needs, by its `<hostname>_<KEY>` name. */
export const requiredSecretNames = (services: readonly RetiredService[]) =>
  services.flatMap(({ environmentKeys, hostname }) =>
    environmentKeys.serviceSecrets.map((key) => `${hostname}_${key}`),
  );

/** The import of each restorable service with its secrets, or the secret names the file lacks. */
export const restoreImports = (
  services: readonly RetiredService[],
  entries: readonly ZeropsImportEntry[],
  secrets: ReadonlyMap<string, Redacted.Redacted>,
) => {
  const missing = requiredSecretNames(services).filter((name) => !secrets.has(name));
  if (missing.length > 0) {
    return Effect.fail(
      new StageOperationError({ message: `the secrets file lacks ${missing.join(', ')}; nothing was restored` }),
    );
  }
  return Effect.succeed(
    services.flatMap(({ environmentKeys, hostname }): ServiceImport[] => {
      const entry = entries.find((candidate) => candidate.hostname === hostname);
      return entry === undefined
        ? []
        : [
            {
              entry,
              envSecrets: Object.fromEntries(
                environmentKeys.serviceSecrets.flatMap((key) => {
                  const value = secrets.get(`${hostname}_${key}`);
                  return value === undefined ? [] : [[key, value] as const];
                }),
              ),
            },
          ];
    }),
  );
};

/**
 * Reads the named secrets from the vault export with the workspace's dotenv semantics (Effect's
 * `ConfigProvider.fromDotEnvContents`): single-quoted values are literal, so JSON secrets such as the
 * private JWK belong in single quotes. Values stay redacted; absent names are simply not returned.
 */
export const readVaultSecrets = (contents: string, names: readonly string[]) =>
  Effect.gen(function* readVaultSecretsEffect() {
    const provider = ConfigProvider.fromDotEnvContents(contents);
    const found = yield* Effect.forEach(
      names,
      (name) =>
        Config.Redacted(name)
          .parse(provider)
          .pipe(
            Effect.map((value) => [[name, value] as const]),
            Effect.orElseSucceed(() => []),
          ),
      { concurrency: 1 },
    );
    return new Map(found.flat());
  });

const readSecretsFile = (secretsFile: Option.Option<string>, names: readonly string[]) =>
  Effect.gen(function* readSecretsFileEffect() {
    if (Option.isNone(secretsFile)) {
      return new Map<string, Redacted.Redacted>();
    }
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* readVaultSecrets(yield* fileSystem.readFileString(secretsFile.value), names);
  }).pipe(
    Effect.mapError((cause) => new StageOperationError({ cause, message: 'the secrets file could not be read' })),
  );

export const restore = (options: { readonly secretsFile: Option.Option<string> }) =>
  Effect.gen(function* restoreEffect() {
    const { projectId, repository } = yield* StageServicesConfiguration;
    const recorded = yield* readRecord;
    if (Option.isNone(recorded)) {
      return yield* new StageOperationError({
        message: `${RETIREMENT_RECORD_LABEL} does not exist; nothing to restore`,
      });
    }
    const entries = yield* readZeropsImport;
    const live = yield* listZeropsServices(projectId);
    const liveHostnames = new Set(live.map(({ hostname }) => hostname));
    const declared = new Set(entries.map(({ hostname }) => hostname));
    for (const service of recorded.value.services) {
      if (!declared.has(service.hostname)) {
        yield* Console.log(`${service.hostname} is no longer in app/zerops-import.yaml; not restored`);
      }
    }
    const missingServices = recorded.value.services.filter(
      ({ hostname }) => declared.has(hostname) && !liveHostnames.has(hostname),
    );
    const secrets = yield* readSecretsFile(options.secretsFile, requiredSecretNames(missingServices));
    const imports = yield* restoreImports(missingServices, entries, secrets);
    if (imports.length > 0) {
      yield* perform(
        `import the Zerops services ${imports.map(({ entry }) => entry.hostname).join(', ')} with their recorded secrets`,
        importZeropsServices(projectId, imports),
      );
    }
    const { dryRun } = yield* OpsMode;
    const current = yield* listZeropsServices(projectId);
    const restored = recorded.value.services.filter(({ hostname }) => declared.has(hostname));
    const unresolved = restored.filter(({ hostname }) => !current.some((service) => service.hostname === hostname));
    // Only a dry run plans with placeholders; a real restore never points stage at a service it cannot see.
    if (!dryRun && unresolved.length > 0) {
      return yield* new StageOperationError({
        message: `Zerops lists no ${unresolved.map(({ hostname }) => hostname).join(', ')} after the import; no stage variable was changed. Re-run restore once they appear`,
      });
    }
    const stageVariables = yield* listGithubVariables(repository, STAGE_ENVIRONMENT);
    for (const service of restored) {
      const serviceId =
        current.find(({ hostname }) => hostname === service.hostname)?.id ?? `<new ${service.hostname} service id>`;
      if (stageVariables.get(service.serviceIdVariable) !== serviceId) {
        yield* perform(
          `set the ${STAGE_ENVIRONMENT} variable ${service.serviceIdVariable}=${serviceId}`,
          setGithubVariable(repository, STAGE_ENVIRONMENT, service.serviceIdVariable, serviceId),
        );
      }
    }
    if (stageVariables.get(DEPLOY_TARGET_VARIABLE) !== 'zerops') {
      yield* perform(
        `set the ${STAGE_ENVIRONMENT} variable ${DEPLOY_TARGET_VARIABLE}=zerops`,
        setGithubVariable(repository, STAGE_ENVIRONMENT, DEPLOY_TARGET_VARIABLE, 'zerops'),
      );
    }
    yield* perform('dispatch the full Zerops stage deploy from main', dispatchFullDeploy(repository));
    return yield* Effect.void;
  });

// ---------------------------------------------------------------------------------------------
// Composition root

const stageServicesLayer = ({ dryRun }: { readonly dryRun: boolean }) =>
  Layer.merge(
    Layer.succeed(OpsMode, { dryRun }),
    Layer.succeed(StageServicesConfiguration, { projectId: STAGE_ZEROPS_PROJECT_ID, repository: ONTOS_REPOSITORY }),
  );

const dryRunFlag = Flag.Boolean('dry-run').pipe(Flag.withDefault(false));

const retireCommand = Command.make(
  'retire',
  {
    confirm: Flag.Boolean('confirm').pipe(Flag.withDefault(false)),
    dnsCutOver: Flag.Boolean('dns-cut-over').pipe(Flag.withDefault(false)),
    dryRun: dryRunFlag,
  },
  ({ confirm, dnsCutOver }) => retire({ confirm, dnsCutOver }),
).pipe(
  Command.withDescription(
    'Record the unused stage services, then delete them with --confirm once --dns-cut-over confirms DNS serves stage from Cloudflare',
  ),
  Command.provide((input) => stageServicesLayer(input)),
);

const restoreCommand = Command.make(
  'restore',
  { dryRun: dryRunFlag, secretsFile: Flag.String('secrets-file').pipe(Flag.optional) },
  ({ secretsFile }) => restore({ secretsFile }),
).pipe(
  Command.withDescription('Re-import the recorded services with their secrets, re-point stage and redeploy Zerops'),
  Command.provide((input) => stageServicesLayer(input)),
);

const cli = Command.make('stage-zerops-services').pipe(Command.withSubcommands([retireCommand, restoreCommand]));

export const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(OpsShellLive), Layer.provide(NodeServices.layer))).pipe(
      Effect.scoped,
    ),
  );
}
