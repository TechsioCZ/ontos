import { Effect, Redacted, Schema } from 'effect';

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

export type StageDemoEnvironment = Readonly<Record<string, string | undefined>>;
type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;

export interface StageDemoBootstrapConfig {
  readonly accounts: readonly [StageDemoAccountConfig, StageDemoAccountConfig];
  readonly authBaseUrl: string;
  readonly authSecret: Redacted.Redacted<string>;
  readonly databaseAdminUrl: Redacted.Redacted<string>;
}

export interface StageDemoAccountConfig {
  readonly email: string;
  readonly password: Redacted.Redacted<string>;
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

const required = (environment: StageDemoEnvironment, key: string) =>
  Effect.gen(function* () {
    const value = environment[key]?.trim();
    if (value === undefined || value.length === 0) {
      return yield* configurationFailure(`${key} is required`);
    }
    return value;
  });

const parsePostgresUrl = (value: string) =>
  Effect.gen(function* () {
    const url = URL.parse(value);
    if (url === null) {
      return yield* configurationFailure('The stage demo configuration is invalid');
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      return yield* configurationFailure('DATABASE_ADMIN_URL must use PostgreSQL');
    }
    return value;
  });

const parseHttpOrigin = (value: string) =>
  Effect.gen(function* () {
    const url = URL.parse(value);
    if (url === null) {
      return yield* configurationFailure('The stage demo configuration is invalid');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
      return yield* configurationFailure('BETTER_AUTH_URL must be an HTTP origin');
    }
    return value;
  });

export const parseStageDemoBootstrapConfig = (
  environment: StageDemoEnvironment,
): Effect.Effect<StageDemoBootstrapConfig, StageDemoBootstrapError> =>
  Effect.gen(function* () {
    if (environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT']?.trim() !== 'stage') {
      return yield* configurationFailure(
        'The demo bootstrap can run only in the stage environment',
      );
    }
    const authSecret = yield* required(environment, 'BETTER_AUTH_SECRET');
    if (authSecret.length < 32) {
      return yield* configurationFailure('BETTER_AUTH_SECRET must contain at least 32 characters');
    }
    const accountConfiguration = (account: (typeof STAGE_DEMO_ACCOUNTS)[number]) =>
      Effect.gen(function* () {
        const password = yield* required(environment, account.passwordEnvironmentKey);
        if (password.length < 8) {
          return yield* configurationFailure(
            `${account.passwordEnvironmentKey} must contain at least 8 characters`,
          );
        }
        return {
          email: account.email,
          password: Redacted.make(password),
          principalDisplayName: account.principalDisplayName,
        };
      });
    const accounts = [
      yield* accountConfiguration(STAGE_DEMO_ACCOUNTS[0]),
      yield* accountConfiguration(STAGE_DEMO_ACCOUNTS[1]),
    ] as const;
    return {
      accounts,
      authBaseUrl: yield* parseHttpOrigin(yield* required(environment, 'BETTER_AUTH_URL')),
      authSecret: Redacted.make(authSecret),
      databaseAdminUrl: Redacted.make(
        yield* parsePostgresUrl(yield* required(environment, 'DATABASE_ADMIN_URL')),
      ),
    };
  });

export const classifyExactStageDemoRecord = <Expected extends ExactRecord>(
  label: string,
  existing: ExactRecord | undefined,
  expected: Expected,
): 'create' | 'existing' => {
  if (existing === undefined) {
    return 'create';
  }
  const conflictingFields = Object.entries(expected).flatMap(([key, value]) =>
    existing[key] === value ? [] : [key],
  );
  if (conflictingFields.length > 0) {
    throw new StageDemoBootstrapError({
      code: 'stage_demo_conflict',
      reason: `Existing ${label} conflicts with the stage demo definition (${conflictingFields.join(', ')})`,
    });
  }
  return 'existing';
};
