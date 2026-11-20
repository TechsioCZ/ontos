import {
  parseStageAccountsFile,
  STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY,
} from '@app/core-runtime/install/stage-accounts-file';
import type {
  StageAccountRole,
  StageAccountsFile,
  StageAccountsFileContents,
  StageAccountsFileError,
} from '@app/core-runtime/install/stage-accounts-file';
import { StageContextBootstrapCodeSchema } from '@app/core-runtime/install/stage-context-bootstrap';
import type {
  StageAttachment,
  StageContextBootstrapError,
  StageDeparture,
  StageRetiredConnectedApp,
} from '@app/core-runtime/install/stage-context-bootstrap';
import { parseDatabaseConnectionPair, targetsSameDatabase } from '@app/core-runtime';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { Config, ConfigProvider, Effect, Redacted, Schema } from 'effect';

export { STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY } from '@app/core-runtime/install/stage-accounts-file';

type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;
type DecodedConfigString = Schema.Schema.Type<typeof Schema.String>;
type OptionalDecodedConfigString = DecodedConfigString | undefined;

export type StageAccountsEnvironment = Readonly<Record<string, OptionalDecodedConfigString>>;

export interface StageAccountsBootstrapConfig {
  /** The validated operator accounts file: every Tenant, account, grant, and retirement is data. */
  readonly accountsFile: StageAccountsFile;
  readonly authBaseUrl: string;
  readonly authSecret: DecodedConfigString;
  readonly databaseAdminUrl: string;
}

export interface StageAccountConfig {
  readonly displayName: string;
  readonly email: string;
  readonly password: Redacted.Redacted;
}

export interface StageAccountResult {
  readonly authUser: 'created' | 'existing' | 'password-reset';
  readonly email: string;
  readonly legalEntityId: string;
  /** The one account of its tenant that owns it: `bootstrapTenantAccess` creates the tenant for it. */
  readonly owner: boolean;
  readonly principalId: string;
  /** The roles the account holds beside its membership; today only the tenant's `full_access` role. */
  readonly roles: readonly StageAccountRole[];
  readonly tenantId: string;
}

export interface StageAccountsBootstrapResult {
  readonly accounts: readonly StageAccountResult[];
  readonly retiredAccounts: readonly {
    readonly email: string;
    readonly status: 'absent' | 'banned';
  }[];
}

export class StageAccountsBootstrapError extends Schema.TaggedError<StageAccountsBootstrapError>()(
  'StageAccountsBootstrapError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    /** The Shell's own codes, or the code Core's run refused or failed under, passed through unchanged. */
    code: Schema.Union([
      Schema.Literals([
        'stage_accounts_configuration_invalid',
        'stage_accounts_conflict',
        'stage_accounts_persistence_failed',
      ]),
      StageContextBootstrapCodeSchema,
    ]),
    reason: Schema.String,
  },
) {}

const configurationFailure = (reason: string): StageAccountsBootstrapError =>
  new StageAccountsBootstrapError({
    code: 'stage_accounts_configuration_invalid',
    reason,
  });

/**
 * Core's refusal or failure as the operator command reports it: the code Core decided it under, such as
 * `stage_connected_app_not_administered` or `stage_last_administrator`, and its reason, never a cause.
 */
export const stageRunFailure = (error: StageContextBootstrapError): StageAccountsBootstrapError =>
  new StageAccountsBootstrapError({ code: error.code, reason: error.reason });

/**
 * The two logins of one stage run: `DATABASE_URL` (Core, the runtime login) and `DATABASE_ADMIN_URL` (Better Auth, the
 * administrative login) must be distinct logins (the runtime one never `postgres`) of the same server, port and
 * database, or the run is refused before either pool opens. Both are read exactly as the driver connects with them: a
 * URL with a query parameter that overrides its user, server or database is refused, and the server and database are
 * compared as the driver decodes them, so `%64b18` is `db18` and `//ontos` is not `/ontos`.
 */
export const stageAccountsDatabases = (environment: {
  readonly DATABASE_ADMIN_URL: string;
  readonly DATABASE_URL: string;
}): Effect.Effect<DatabaseConnectionPair, StageAccountsBootstrapError> =>
  parseDatabaseConnectionPair(environment, { rejectIdentityOverrides: true }).pipe(
    Effect.mapError(({ reason }) => configurationFailure(reason)),
    Effect.filterOrFail(
      ({ admin, runtime }) => targetsSameDatabase(admin, runtime),
      () =>
        configurationFailure(
          'DATABASE_URL and DATABASE_ADMIN_URL must name the same PostgreSQL server, port and database',
        ),
    ),
  );

/** Which run the operator command makes: the dry run, which writes nothing, unless its command line asks to commit. */
const StageAccountsExecutionSchema = Schema.Literals(['commit', 'dry-run']);
export type StageAccountsExecution = typeof StageAccountsExecutionSchema.Type;

/** The only two command lines of the operator command, as a refused command line names them. */
export const STAGE_ACCOUNTS_USAGE =
  'Run `node scripts/bootstrap-stage-accounts.mts` for the dry run, which writes nothing, or `node scripts/bootstrap-stage-accounts.mts --commit` for the real run';

/**
 * The run a command line selects, decided before the command reads its file or opens a connection. No argument, or
 * exactly `--dry-run`, is the dry run; the real run needs the one argument `--commit`, spelled exactly so. Every other
 * command line (a value or negation such as `--commit=true` or `--no-commit`, both flags, a repeated flag, a stray
 * argument, `--help`) is refused naming the two valid ones, so no spelling of a flag ever starts the real run by itself.
 */
export const stageAccountsExecutionOf = (
  args: readonly string[],
): Effect.Effect<StageAccountsExecution, StageAccountsBootstrapError> => {
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) {
    return Effect.succeed('dry-run');
  }
  if (args.length === 1 && args[0] === '--commit') {
    return Effect.succeed('commit');
  }
  return Effect.fail(configurationFailure(`The command line is not one the command accepts. ${STAGE_ACCOUNTS_USAGE}`));
};

/** What the dry run of one operator file found the real run would do. The dry run wrote none of it. */
export interface StageAccountsRehearsal {
  /** Each account of the file's tenants and what the run would do with its Better Auth user. */
  readonly accounts: readonly {
    readonly email: string;
    readonly status: StageAccountResult['authUser'];
    /** The run would mark the user's email as verified. */
    readonly verifiesEmail: boolean;
  }[];
  readonly attachments: readonly (StageAttachment & { readonly email: string })[];
  /** The connected apps of departures an earlier run completed, whose tokens and consent the pre-step would delete. */
  readonly completedConnectedApps: readonly StageRetiredConnectedApp[];
  /** Every connected app of the people the file retires, whose tokens and consent the run deletes after its commit. */
  readonly connectedApps: readonly StageRetiredConnectedApp[];
  readonly departures: readonly (StageDeparture & { readonly email: string })[];
  /** The tenants somebody leaves, which the run reconciles after its commit. */
  readonly leftTenantIds: readonly string[];
  readonly retiredAccountEmails: readonly string[];
  readonly retiredTenantIds: readonly string[];
  readonly tenantIds: readonly string[];
}

/** The bindings of a departure counted by provider, subject and the status the run read them with. */
const bindingCountsOf = (bindings: StageDeparture['bindings']): string => {
  const counts = new Map<string, number>();
  for (const { provider, status, subjectType } of bindings) {
    const key = `${provider}/${subjectType}:${status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts.size === 0
    ? 'none'
    : [...counts]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, count]) => `${key}=${count}`)
        .join(',');
};

/** Every write the move transaction makes for one departure, counted; its connected apps are listed one by one. */
const departureWritesOf = (departure: StageDeparture): string =>
  `bindings=${bindingCountsOf(departure.bindings)} memberships=${departure.ended.memberships} assignments=${departure.ended.assignments} delegations=${departure.ended.delegations} teamPlaces=${departure.ended.teamPlaces} directory=${departure.directory} auditEvents=${departure.revocationEvents}`;

/** Whether a departure writes anything at all: a replay still ends a connected app that went live after the archive. */
const departureWritesSomething = (departure: StageDeparture): boolean =>
  departure.archives ||
  departure.bindings.length > 0 ||
  departure.connectedApps.length > 0 ||
  departure.directory > 0 ||
  departure.revocationEvents > 0 ||
  Object.values(departure.ended).some((count) => count > 0);

/**
 * One departure as the dry run (`dry-run`) or the real run (`commit`) reports it, with every write its move
 * transaction makes. A replay archives nothing, yet it still ends what went live since the archive (a late draft
 * consent is denied), so it says "nothing" only when it writes nothing.
 */
export const stageDepartureLine = (
  departure: StageDeparture & { readonly email: string },
  execution: StageAccountsExecution,
): string => {
  const where = `tenant=${departure.tenantId} principal=${departure.principalId}`;
  const writes = departureWritesOf(departure);
  const dry = execution === 'dry-run';
  if (departure.archives) {
    return dry
      ? `Would retire the Principal of ${departure.email}: ${where} ${writes}`
      : `Retired stage Principal of ${departure.email}: ${where} ${writes}`;
  }
  if (!departureWritesSomething(departure)) {
    return dry
      ? `The Principal of ${departure.email} is retired already: ${where}; the run writes nothing of it again`
      : `The Principal of ${departure.email} was retired already: ${where}; the run wrote nothing of it again`;
  }
  return dry
    ? `The Principal of ${departure.email} is retired already: ${where}; the run archives nothing again but still writes ${writes}`
    : `The Principal of ${departure.email} was retired already: ${where}; the run archived nothing again but wrote ${writes}`;
};

/** One attached login as the dry run or the real run reports it: created by this run, or found as an earlier run made it. */
export const stageAttachmentLine = (
  attachment: StageAttachment & { readonly email: string },
  execution: StageAccountsExecution,
): string => {
  const where = `tenant=${attachment.tenantId} principal=${attachment.principalId} binding=${attachment.authBindingId}`;
  if (execution === 'dry-run') {
    return attachment.created
      ? `Would attach login ${attachment.email}: ${where}`
      : `Login ${attachment.email} is attached already: ${where}; the run creates nothing`;
  }
  return attachment.created
    ? `Attached stage login ${attachment.email}: ${where}`
    : `Login ${attachment.email} was attached already: ${where}; the run created nothing`;
};

const accountActionOf = ({ status, verifiesEmail }: StageAccountsRehearsal['accounts'][number]): string => {
  const action = {
    created: 'create it',
    existing: 'leave its password',
    'password-reset': 'replace its password and end its sessions',
  }[status];
  return verifiesEmail ? `${action} and mark its email verified` : action;
};

/**
 * What the dry run prints: what the move transaction would write, per person who leaves and per attached login, then
 * every write of the real run the dry run did not make. A refusal is printed as the real run prints it.
 */
export const stageAccountsDryRunLines = (rehearsal: StageAccountsRehearsal): readonly string[] => [
  "Stage accounts dry run: the move transaction took the real run's locks and made its writes, then rolled back; nothing was written",
  ...rehearsal.departures.flatMap((departure) => [
    stageDepartureLine(departure, 'dry-run'),
    ...departure.connectedApps.map(
      (app) =>
        `Would end connected app "${app.clientName}" (${app.clientId}) of ${departure.email}: tenant=${app.tenantId} grant=${app.grantId} was=${app.status} lastUsed=${app.lastUsedAt?.toISOString() ?? 'never'}`,
    ),
  ]),
  ...rehearsal.attachments.map((attachment) => stageAttachmentLine(attachment, 'dry-run')),
  `Would write ${rehearsal.departures.reduce((total, { revocationEvents }) => total + revocationEvents, 0)} audit events (oauth.connection.revoked)`,
  ...rehearsal.accounts.map(
    (account) => `Dry run skipped the Better Auth account ${account.email}: the run would ${accountActionOf(account)}`,
  ),
  ...(rehearsal.completedConnectedApps.length === 0
    ? []
    : [
        `Dry run skipped the pre-step: the run would delete the Better Auth tokens and consent of ${rehearsal.completedConnectedApps.length} connected apps whose departure an earlier run completed`,
      ]),
  ...(rehearsal.connectedApps.length === 0
    ? []
    : [
        `Dry run skipped the clean-up after the commit: the run would delete the Better Auth tokens and consent of ${rehearsal.connectedApps.length} connected apps of the people it retires`,
      ]),
  ...rehearsal.leftTenantIds.map(
    (tenantId) => `Dry run skipped the authorization reconcile of tenant ${tenantId}, which somebody leaves`,
  ),
  ...rehearsal.tenantIds.map(
    (tenantId) =>
      `Dry run skipped tenant ${tenantId} of the file: its identity rows, access bootstrap and authorization reconcile`,
  ),
  ...rehearsal.retiredTenantIds.map((tenantId) => `Dry run skipped retiring tenant ${tenantId}`),
  ...rehearsal.retiredAccountEmails.map((email) => `Dry run skipped banning the retired account ${email}`),
  'Nothing was written. Check every line above; the real run of the same, unchanged file is `node scripts/bootstrap-stage-accounts.mts --commit`',
];

/** The one line the operator command prints for a failed run: its code, then its reason. */
export const stageAccountsFailureLine = (failure: StageAccountsBootstrapError): string =>
  `Stage accounts bootstrap failed (${failure.code}): ${failure.reason}`;

const StageEnvironmentSchema = Schema.Trim.pipe(Schema.decodeTo(Schema.Literal('stage')));
const StageAuthSecretSchema = Schema.Redacted(Schema.Trim.check(Schema.isNonEmpty(), Schema.isMinLength(32)));
const HttpOriginSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
      ? undefined
      : 'URL must be an HTTP origin';
  }),
);
const PostgreSqlUrlSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return url !== null && (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
      ? undefined
      : 'URL must use PostgreSQL';
  }),
);
const AccountsFilePathSchema = Schema.Trim.check(Schema.isNonEmpty());

const stageAccountsBootstrapSource = Config.all({
  accountsFilePath: Config.schema(AccountsFilePathSchema, STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY),
  authBaseUrl: Config.schema(HttpOriginSchema, 'BETTER_AUTH_URL'),
  authSecret: Config.schema(StageAuthSecretSchema, 'BETTER_AUTH_SECRET'),
  databaseAdminUrl: Config.schema(PostgreSqlUrlSchema, 'DATABASE_ADMIN_URL'),
  deploymentEnvironment: Config.schema(StageEnvironmentSchema, 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
});

const configurationRequirements = [
  [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY, 'must name the operator stage accounts file'],
  ['BETTER_AUTH_SECRET', 'must contain at least 32 characters'],
  ['BETTER_AUTH_URL', 'must be an HTTP origin'],
  ['DATABASE_ADMIN_URL', 'must use PostgreSQL'],
] as const;

const configurationFailureFromConfigError = (error: Config.ConfigError): StageAccountsBootstrapError => {
  const { message } = error;
  if (message.includes('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) {
    return configurationFailure('The stage accounts bootstrap can run only in the stage environment');
  }
  const requirement = configurationRequirements.find(([key]) => message.includes(key));
  if (requirement === undefined) {
    return configurationFailure('The stage account configuration is invalid');
  }
  const [key, invalidReason] = requirement;
  return configurationFailure(`${key} ${message.includes('Expected string') ? 'is required' : invalidReason}`);
};

const environmentProvider = (environment: StageAccountsEnvironment): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnvRecord({
    BETTER_AUTH_SECRET: environment['BETTER_AUTH_SECRET'],
    BETTER_AUTH_URL: environment['BETTER_AUTH_URL'],
    DATABASE_ADMIN_URL: environment['DATABASE_ADMIN_URL'],
    [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: environment[STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY],
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'],
  });

/** Reads the accounts file; the contract replaces any failure reason with a value-free one. */
export type StageAccountsFileReader = (
  path: string,
) => Effect.Effect<StageAccountsFileContents, StageAccountsBootstrapError | StageAccountsFileError>;

const readAccountsFile = (reader: StageAccountsFileReader, path: string) =>
  Effect.suspend(() => reader(path)).pipe(
    Effect.mapError(
      (cause) =>
        new StageAccountsBootstrapError({
          cause,
          code: 'stage_accounts_configuration_invalid',
          reason: `The ${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} file could not be read`,
        }),
    ),
  );

const parseStageAccountsBootstrapConfigFromProvider = Effect.fn(
  'StageAccountsBootstrapContract.parseStageAccountsBootstrapConfigFromProvider',
)(function* parseConfiguration(
  provider: ConfigProvider.ConfigProvider,
  reader: StageAccountsFileReader,
  declaredWorkloadKeys: ReadonlySet<string>,
) {
  const source = yield* stageAccountsBootstrapSource
    .parse(provider)
    .pipe(Effect.catchTag('ConfigError', (error) => Effect.fail(configurationFailureFromConfigError(error))));
  const accountsFile = yield* readAccountsFile(reader, source.accountsFilePath).pipe(
    Effect.flatMap((contents) => parseStageAccountsFile(contents, declaredWorkloadKeys)),
    Effect.catchTag('StageAccountsFileError', (error) => Effect.fail(configurationFailure(error.reason))),
  );
  return {
    accountsFile,
    authBaseUrl: source.authBaseUrl,
    authSecret: Redacted.value(source.authSecret),
    databaseAdminUrl: source.databaseAdminUrl,
  };
});

export const parseStageAccountsBootstrapConfig = (
  environment: StageAccountsEnvironment,
  reader: StageAccountsFileReader,
  declaredWorkloadKeys: ReadonlySet<string>,
): Effect.Effect<StageAccountsBootstrapConfig, StageAccountsBootstrapError> =>
  parseStageAccountsBootstrapConfigFromProvider(environmentProvider(environment), reader, declaredWorkloadKeys);

export const classifyExactStageAccountsRecord = <Expected extends ExactRecord>(
  label: string,
  existing: ExactRecord | undefined,
  expected: Expected,
): Effect.Effect<'create' | 'existing', StageAccountsBootstrapError> =>
  Effect.suspend(() => {
    if (existing === undefined) {
      return Effect.succeed('create' as const);
    }
    const conflictingFields = Object.entries(expected).flatMap(([key, value]) =>
      existing[key] === value ? [] : [key],
    );
    if (conflictingFields.length > 0) {
      return Effect.fail(
        new StageAccountsBootstrapError({
          code: 'stage_accounts_conflict',
          reason: `Existing ${label} conflicts with the stage accounts definition (${conflictingFields.join(', ')})`,
        }),
      );
    }
    return Effect.succeed('existing' as const);
  });
