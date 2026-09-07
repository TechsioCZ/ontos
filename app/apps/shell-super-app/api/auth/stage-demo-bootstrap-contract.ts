import { Config, ConfigProvider, Effect, Redacted, Schema } from 'effect';

export const STAGE_DEMO_ACCOUNTS = Object.freeze([
  Object.freeze({
    email: 'demo@test.com',
    passwordEnvironmentKey: 'STAGE_DEMO_PASSWORD',
    principalDisplayName: 'Techsio Demo',
  }),
  Object.freeze({
    email: 'siampark01@test.com',
    passwordEnvironmentKey: 'STAGE_SIAMPARK_PASSWORD',
    principalDisplayName: 'Siampark 01',
  }),
] as const);

type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;
type DecodedConfigString = Schema.Schema.Type<typeof Schema.String>;
type OptionalDecodedConfigString = DecodedConfigString | undefined;

export type StageDemoEnvironment = Readonly<Record<string, OptionalDecodedConfigString>>;

export interface StageDemoBootstrapConfig {
  readonly accounts: readonly [StageDemoAccountConfig, StageDemoAccountConfig];
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
  readonly authUser: 'created' | 'existing';
  readonly email: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface StageDemoBootstrapResult {
  readonly accounts: readonly StageDemoAccountResult[];
}

export class StageDemoBootstrapError extends Schema.TaggedError<StageDemoBootstrapError>()(
  'StageDemoBootstrapError',
  {
    code: Schema.Literals([
      'stage_demo_configuration_invalid',
      'stage_demo_conflict',
      'stage_demo_persistence_failed',
    ]),
    reason: Schema.String,
  },
) {}

const configurationFailure = (reason: string): StageDemoBootstrapError =>
  new StageDemoBootstrapError({ code: 'stage_demo_configuration_invalid', reason });

const StageEnvironmentSchema = Schema.Trim.pipe(Schema.decodeTo(Schema.Literal('stage')));
const StageDemoPasswordSchema = Schema.Redacted(
  Schema.Trim.check(Schema.isNonEmpty(), Schema.isMinLength(8)),
);
const StageAuthSecretSchema = Schema.Redacted(
  Schema.Trim.check(Schema.isNonEmpty(), Schema.isMinLength(32)),
);
const HttpOriginSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return url !== null &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value
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
  authBaseUrl: Config.schema(HttpOriginSchema, 'BETTER_AUTH_URL'),
  authSecret: Config.schema(StageAuthSecretSchema, 'BETTER_AUTH_SECRET'),
  databaseAdminUrl: Config.schema(PostgreSqlUrlSchema, 'DATABASE_ADMIN_URL'),
  demoPassword: Config.schema(StageDemoPasswordSchema, 'STAGE_DEMO_PASSWORD'),
  deploymentEnvironment: Config.schema(
    StageEnvironmentSchema,
    'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
  ),
  siamparkPassword: Config.schema(StageDemoPasswordSchema, 'STAGE_SIAMPARK_PASSWORD'),
});

const configurationFailureFromConfigError = (
  error: Config.ConfigError,
): StageDemoBootstrapError => {
  const { message } = error;
  const missing = message.includes('Expected string');
  if (message.includes('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) {
    return configurationFailure('The demo bootstrap can run only in the stage environment');
  }
  if (message.includes('STAGE_DEMO_PASSWORD')) {
    return configurationFailure(
      missing
        ? 'STAGE_DEMO_PASSWORD is required'
        : 'STAGE_DEMO_PASSWORD must contain at least 8 characters',
    );
  }
  if (message.includes('STAGE_SIAMPARK_PASSWORD')) {
    return configurationFailure(
      missing
        ? 'STAGE_SIAMPARK_PASSWORD is required'
        : 'STAGE_SIAMPARK_PASSWORD must contain at least 8 characters',
    );
  }
  if (message.includes('BETTER_AUTH_SECRET')) {
    return configurationFailure(
      missing
        ? 'BETTER_AUTH_SECRET is required'
        : 'BETTER_AUTH_SECRET must contain at least 32 characters',
    );
  }
  if (message.includes('BETTER_AUTH_URL')) {
    return configurationFailure(
      missing ? 'BETTER_AUTH_URL is required' : 'BETTER_AUTH_URL must be an HTTP origin',
    );
  }
  if (message.includes('DATABASE_ADMIN_URL')) {
    return configurationFailure(
      missing ? 'DATABASE_ADMIN_URL is required' : 'DATABASE_ADMIN_URL must use PostgreSQL',
    );
  }
  return configurationFailure('The stage demo configuration is invalid');
};

const environmentProvider = (environment: StageDemoEnvironment): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnvRecord({
    BETTER_AUTH_SECRET: environment['BETTER_AUTH_SECRET'],
    BETTER_AUTH_URL: environment['BETTER_AUTH_URL'],
    DATABASE_ADMIN_URL: environment['DATABASE_ADMIN_URL'],
    STAGE_DEMO_PASSWORD: environment['STAGE_DEMO_PASSWORD'],
    STAGE_SIAMPARK_PASSWORD: environment['STAGE_SIAMPARK_PASSWORD'],
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'],
  });

const parseStageDemoBootstrapConfigFromProvider = Effect.fn(
  'StageDemoBootstrapContract.parseStageDemoBootstrapConfigFromProvider',
)(function* parseConfiguration(provider: ConfigProvider.ConfigProvider) {
  const source = yield* stageDemoBootstrapSource
    .parse(provider)
    .pipe(
      Effect.catchTag('ConfigError', (error) =>
        Effect.fail(configurationFailureFromConfigError(error)),
      ),
    );
  return {
    accounts: [
      {
        email: STAGE_DEMO_ACCOUNTS[0].email,
        password: Redacted.value(source.demoPassword),
        principalDisplayName: STAGE_DEMO_ACCOUNTS[0].principalDisplayName,
      },
      {
        email: STAGE_DEMO_ACCOUNTS[1].email,
        password: Redacted.value(source.siamparkPassword),
        principalDisplayName: STAGE_DEMO_ACCOUNTS[1].principalDisplayName,
      },
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
