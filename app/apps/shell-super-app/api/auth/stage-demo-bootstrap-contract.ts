import { Config, ConfigProvider, Effect, Redacted, Schema } from 'effect';

/**
 * Fixed stage account slots in the Core `STAGE_CONTEXT_ORDER`. Source control knows only the Tenant
 * and role of each slot; the email and password come from the operator accounts file
 * ({@link STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY}), so no real stage identity lives in the repository.
 */
export const STAGE_DEMO_ACCOUNT_SLOTS = Object.freeze([
  Object.freeze({ principalDisplayName: 'Techsio Demo', role: 'demo', tenant: 'techsio' }),
  Object.freeze({ principalDisplayName: 'Techsio Admin', role: 'admin', tenant: 'techsio' }),
  Object.freeze({ principalDisplayName: 'Akros Demo', role: 'demo', tenant: 'akros' }),
  Object.freeze({ principalDisplayName: 'Akros Admin', role: 'admin', tenant: 'akros' }),
] as const);

/** Environment variable naming the operator-provided stage accounts file (JSON, mode 600, outside the repo). */
export const STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY = 'ONTOS_STAGE_ACCOUNTS_FILE';

type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;
type DecodedConfigString = Schema.Schema.Type<typeof Schema.String>;
type OptionalDecodedConfigString = DecodedConfigString | undefined;

export type StageDemoEnvironment = Readonly<Record<string, OptionalDecodedConfigString>>;

export interface StageDemoBootstrapConfig {
  readonly accounts: readonly [
    StageDemoAccountConfig,
    StageDemoAccountConfig,
    StageDemoAccountConfig,
    StageDemoAccountConfig,
  ];
  readonly authBaseUrl: string;
  readonly authSecret: DecodedConfigString;
  readonly databaseAdminUrl: string;
  /** Former stage accounts that the bootstrap bans, signs out, and strips of their password credential. */
  readonly retiredAccountEmails: readonly string[];
}

export interface StageDemoAccountConfig {
  readonly email: string;
  readonly password: DecodedConfigString;
  readonly principalDisplayName: string;
}

export interface StageDemoAccountResult {
  readonly authUser: 'created' | 'existing' | 'password-reset';
  readonly email: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly role: 'admin' | 'demo';
  readonly tenantId: string;
}

export interface StageDemoBootstrapResult {
  readonly accounts: readonly StageDemoAccountResult[];
  readonly retiredAccounts: readonly {
    readonly email: string;
    readonly status: 'absent' | 'banned';
  }[];
}

export class StageDemoBootstrapError extends Schema.TaggedError<StageDemoBootstrapError>()('StageDemoBootstrapError', {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.Literals(['stage_demo_configuration_invalid', 'stage_demo_conflict', 'stage_demo_persistence_failed']),
  reason: Schema.String,
}) {}

const configurationFailure = (reason: string): StageDemoBootstrapError =>
  new StageDemoBootstrapError({
    code: 'stage_demo_configuration_invalid',
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

const stageDemoBootstrapSource = Config.all({
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

const configurationFailureFromConfigError = (error: Config.ConfigError): StageDemoBootstrapError => {
  const { message } = error;
  if (message.includes('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) {
    return configurationFailure('The demo bootstrap can run only in the stage environment');
  }
  const requirement = configurationRequirements.find(([key]) => message.includes(key));
  if (requirement === undefined) {
    return configurationFailure('The stage demo configuration is invalid');
  }
  const [key, invalidReason] = requirement;
  return configurationFailure(`${key} ${message.includes('Expected string') ? 'is required' : invalidReason}`);
};

const environmentProvider = (environment: StageDemoEnvironment): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnvRecord({
    BETTER_AUTH_SECRET: environment['BETTER_AUTH_SECRET'],
    BETTER_AUTH_URL: environment['BETTER_AUTH_URL'],
    DATABASE_ADMIN_URL: environment['DATABASE_ADMIN_URL'],
    [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: environment[STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY],
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'],
  });

const AccountEmailSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => (/^[^\s@]+@[^\s@]+$/u.test(value) ? undefined : 'must be an email address')),
);
const AccountPasswordSchema = Schema.String.check(Schema.isMinLength(8));
const AccountIdentitySchema = Schema.Struct({
  email: AccountEmailSchema,
  password: AccountPasswordSchema,
});
const TenantAccountsSchema = Schema.Struct({
  admin: AccountIdentitySchema,
  demo: AccountIdentitySchema,
});

/**
 * The operator stage accounts file. Its values never enter source control; only this shape does.
 * `retiredAccountEmails` lists former stage accounts to ban and strip of their password credential.
 */
const StageAccountsFileSchema = Schema.Struct({
  retiredAccountEmails: Schema.Array(AccountEmailSchema),
  schemaVersion: Schema.Literal(1),
  tenants: Schema.Struct({
    akros: TenantAccountsSchema,
    techsio: TenantAccountsSchema,
  }),
});

/** The accounts file as read by the operator runtime: its text and POSIX permission bits. */
export interface StageAccountsFileContents {
  readonly mode: number;
  readonly source: string;
}

/** Reads the accounts file; the contract replaces any failure reason with a value-free one. */
export type StageAccountsFileReader = (
  path: string,
) => Effect.Effect<StageAccountsFileContents, StageDemoBootstrapError>;

/** The low six permission bits are the group and other read/write/execute flags. */
const GROUP_AND_OTHER_PERMISSION_RANGE = 0o100;

const configurationFailureWithCause = (reason: string) => (cause: unknown) =>
  new StageDemoBootstrapError({ cause, code: 'stage_demo_configuration_invalid', reason });

/**
 * Validates the operator accounts file without echoing any of its values: owner-only permissions,
 * the documented schema, unique emails across slots, and no retired email that is still active.
 */
const parseStageAccountsFile = Effect.fn('StageDemoBootstrapContract.parseStageAccountsFile')(
  function* parseAccountsFile(contents: StageAccountsFileContents) {
    if (contents.mode % GROUP_AND_OTHER_PERMISSION_RANGE !== 0) {
      return yield* configurationFailure(
        `The ${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} file must be readable only by its owner (chmod 600)`,
      );
    }
    const accounts = yield* Schema.decodeEffect(Schema.fromJsonString(StageAccountsFileSchema), {
      onExcessProperty: 'error',
    })(contents.source).pipe(
      Effect.mapError(
        configurationFailureWithCause(
          `The ${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} file does not match the documented schema`,
        ),
      ),
    );
    const activeEmails = new Set(
      STAGE_DEMO_ACCOUNT_SLOTS.map(({ role, tenant }) => accounts.tenants[tenant][role].email.toLowerCase()),
    );
    const retiredEmails = accounts.retiredAccountEmails.map((email) => email.toLowerCase());
    if (activeEmails.size !== STAGE_DEMO_ACCOUNT_SLOTS.length) {
      return yield* configurationFailure('Every stage account needs its own email');
    }
    if (
      new Set(retiredEmails).size !== retiredEmails.length ||
      retiredEmails.some((email) => activeEmails.has(email))
    ) {
      return yield* configurationFailure(
        'Retired stage account emails must be unique and not belong to an active account',
      );
    }
    return accounts;
  },
);

const readAccountsFile = (reader: StageAccountsFileReader, path: string) =>
  Effect.suspend(() => reader(path)).pipe(
    Effect.mapError(configurationFailureWithCause(`The ${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} file could not be read`)),
  );

const parseStageDemoBootstrapConfigFromProvider = Effect.fn(
  'StageDemoBootstrapContract.parseStageDemoBootstrapConfigFromProvider',
)(function* parseConfiguration(provider: ConfigProvider.ConfigProvider, reader: StageAccountsFileReader) {
  const source = yield* stageDemoBootstrapSource
    .parse(provider)
    .pipe(Effect.catchTag('ConfigError', (error) => Effect.fail(configurationFailureFromConfigError(error))));
  const accounts = yield* parseStageAccountsFile(yield* readAccountsFile(reader, source.accountsFilePath));
  const account = (index: 0 | 1 | 2 | 3): StageDemoAccountConfig => {
    const { principalDisplayName, role, tenant } = STAGE_DEMO_ACCOUNT_SLOTS[index];
    const { email, password } = accounts.tenants[tenant][role];
    return { email, password, principalDisplayName };
  };
  return {
    accounts: [account(0), account(1), account(2), account(3)] as const,
    authBaseUrl: source.authBaseUrl,
    authSecret: Redacted.value(source.authSecret),
    databaseAdminUrl: source.databaseAdminUrl,
    retiredAccountEmails: accounts.retiredAccountEmails,
  };
});

export const parseStageDemoBootstrapConfig = (
  environment: StageDemoEnvironment,
  reader: StageAccountsFileReader,
): Effect.Effect<StageDemoBootstrapConfig, StageDemoBootstrapError> =>
  parseStageDemoBootstrapConfigFromProvider(environmentProvider(environment), reader);

export const classifyExactStageDemoRecord = <Expected extends ExactRecord>(
  label: string,
  existing: ExactRecord | undefined,
  expected: Expected,
): Effect.Effect<'create' | 'existing', StageDemoBootstrapError> =>
  Effect.suspend(() => {
    if (existing === undefined) {
      return Effect.succeed('create' as const);
    }
    const conflictingFields = Object.entries(expected).flatMap(([key, value]) =>
      existing[key] === value ? [] : [key],
    );
    if (conflictingFields.length > 0) {
      return Effect.fail(
        new StageDemoBootstrapError({
          code: 'stage_demo_conflict',
          reason: `Existing ${label} conflicts with the stage demo definition (${conflictingFields.join(', ')})`,
        }),
      );
    }
    return Effect.succeed('existing' as const);
  });
