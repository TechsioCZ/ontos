import { Config, ConfigProvider, Effect, Redacted, Schema } from 'effect';

/**
 * Fixed stage accounts in the Core `STAGE_CONTEXT_ORDER`. The Techsio demo keeps `demo@test.com`
 * because its existing Core principal binding is pinned to that Better Auth user.
 */
export const STAGE_DEMO_ACCOUNTS = Object.freeze([
  Object.freeze({
    email: 'demo@test.com',
    passwordEnvironmentKey: 'STAGE_TECHSIO_DEMO_PASSWORD',
    principalDisplayName: 'Techsio Demo',
  }),
  Object.freeze({
    email: 'admin@techsio.test',
    passwordEnvironmentKey: 'STAGE_TECHSIO_ADMIN_PASSWORD',
    principalDisplayName: 'Techsio Admin',
  }),
  Object.freeze({
    email: 'demo@akros.test',
    passwordEnvironmentKey: 'STAGE_AKROS_DEMO_PASSWORD',
    principalDisplayName: 'Akros Demo',
  }),
  Object.freeze({
    email: 'admin@akros.test',
    passwordEnvironmentKey: 'STAGE_AKROS_ADMIN_PASSWORD',
    principalDisplayName: 'Akros Admin',
  }),
] as const);

/** Former stage accounts that the bootstrap bans, signs out, and strips of their password credential. */
export const STAGE_DEMO_RETIRED_ACCOUNT_EMAILS = Object.freeze(['siampark01@test.com'] as const);

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
const StageDemoPasswordSchema = Schema.Redacted(Schema.Trim.check(Schema.isNonEmpty(), Schema.isMinLength(8)));
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

const stageDemoBootstrapSource = Config.all({
  akrosAdminPassword: Config.schema(StageDemoPasswordSchema, 'STAGE_AKROS_ADMIN_PASSWORD'),
  akrosDemoPassword: Config.schema(StageDemoPasswordSchema, 'STAGE_AKROS_DEMO_PASSWORD'),
  authBaseUrl: Config.schema(HttpOriginSchema, 'BETTER_AUTH_URL'),
  authSecret: Config.schema(StageAuthSecretSchema, 'BETTER_AUTH_SECRET'),
  databaseAdminUrl: Config.schema(PostgreSqlUrlSchema, 'DATABASE_ADMIN_URL'),
  deploymentEnvironment: Config.schema(StageEnvironmentSchema, 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
  techsioAdminPassword: Config.schema(StageDemoPasswordSchema, 'STAGE_TECHSIO_ADMIN_PASSWORD'),
  techsioDemoPassword: Config.schema(StageDemoPasswordSchema, 'STAGE_TECHSIO_DEMO_PASSWORD'),
});

const PASSWORD_REQUIREMENT = 'must contain at least 8 characters';

const configurationRequirements = [
  ['STAGE_TECHSIO_DEMO_PASSWORD', PASSWORD_REQUIREMENT],
  ['STAGE_TECHSIO_ADMIN_PASSWORD', PASSWORD_REQUIREMENT],
  ['STAGE_AKROS_DEMO_PASSWORD', PASSWORD_REQUIREMENT],
  ['STAGE_AKROS_ADMIN_PASSWORD', PASSWORD_REQUIREMENT],
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
    STAGE_AKROS_ADMIN_PASSWORD: environment['STAGE_AKROS_ADMIN_PASSWORD'],
    STAGE_AKROS_DEMO_PASSWORD: environment['STAGE_AKROS_DEMO_PASSWORD'],
    STAGE_TECHSIO_ADMIN_PASSWORD: environment['STAGE_TECHSIO_ADMIN_PASSWORD'],
    STAGE_TECHSIO_DEMO_PASSWORD: environment['STAGE_TECHSIO_DEMO_PASSWORD'],
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'],
  });

const parseStageDemoBootstrapConfigFromProvider = Effect.fn(
  'StageDemoBootstrapContract.parseStageDemoBootstrapConfigFromProvider',
)(function* parseConfiguration(provider: ConfigProvider.ConfigProvider) {
  const source = yield* stageDemoBootstrapSource
    .parse(provider)
    .pipe(Effect.catchTag('ConfigError', (error) => Effect.fail(configurationFailureFromConfigError(error))));
  const account = (index: 0 | 1 | 2 | 3, password: Redacted.Redacted): StageDemoAccountConfig => ({
    email: STAGE_DEMO_ACCOUNTS[index].email,
    password: Redacted.value(password),
    principalDisplayName: STAGE_DEMO_ACCOUNTS[index].principalDisplayName,
  });
  return {
    accounts: [
      account(0, source.techsioDemoPassword),
      account(1, source.techsioAdminPassword),
      account(2, source.akrosDemoPassword),
      account(3, source.akrosAdminPassword),
    ] as const,
    authBaseUrl: source.authBaseUrl,
    authSecret: Redacted.value(source.authSecret),
    databaseAdminUrl: source.databaseAdminUrl,
  };
});

export const parseStageDemoBootstrapConfig = (
  environment: StageDemoEnvironment,
): Effect.Effect<StageDemoBootstrapConfig, StageDemoBootstrapError> =>
  parseStageDemoBootstrapConfigFromProvider(environmentProvider(environment));

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
