import {
  parseStageAccountsFile,
  STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY,
} from '@app/core-runtime/install/stage-accounts-file';
import type {
  StageAccountsFile,
  StageAccountsFileContents,
  StageAccountsFileError,
} from '@app/core-runtime/install/stage-accounts-file';
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
  readonly principalId: string;
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
    code: Schema.Literals([
      'stage_accounts_configuration_invalid',
      'stage_accounts_conflict',
      'stage_accounts_persistence_failed',
    ]),
    reason: Schema.String,
  },
) {}

const configurationFailure = (reason: string): StageAccountsBootstrapError =>
  new StageAccountsBootstrapError({
    code: 'stage_accounts_configuration_invalid',
    reason,
  });

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
)(function* parseConfiguration(provider: ConfigProvider.ConfigProvider, reader: StageAccountsFileReader) {
  const source = yield* stageAccountsBootstrapSource
    .parse(provider)
    .pipe(Effect.catchTag('ConfigError', (error) => Effect.fail(configurationFailureFromConfigError(error))));
  const accountsFile = yield* readAccountsFile(reader, source.accountsFilePath).pipe(
    Effect.flatMap(parseStageAccountsFile),
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
): Effect.Effect<StageAccountsBootstrapConfig, StageAccountsBootstrapError> =>
  parseStageAccountsBootstrapConfigFromProvider(environmentProvider(environment), reader);

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
