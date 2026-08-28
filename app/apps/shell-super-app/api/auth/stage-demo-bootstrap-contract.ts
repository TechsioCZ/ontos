import { Effect, Schema } from 'effect';

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
  readonly authSecret: string;
  readonly databaseAdminUrl: string;
}

export interface StageDemoAccountConfig {
  readonly email: string;
  readonly password: string;
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

const required = (environment: StageDemoEnvironment, key: string): string => {
  const value = environment[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw configurationFailure(`${key} is required`);
  }
  return value;
};

const parsePostgresUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw configurationFailure('DATABASE_ADMIN_URL must use PostgreSQL');
  }
  return value;
};

const parseHttpOrigin = (value: string): string => {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw configurationFailure('BETTER_AUTH_URL must be an HTTP origin');
  }
  return value;
};

export const parseStageDemoBootstrapConfig = (
  environment: StageDemoEnvironment,
): Effect.Effect<StageDemoBootstrapConfig, StageDemoBootstrapError> =>
  Effect.try({
    catch: (cause) =>
      Schema.is(StageDemoBootstrapError)(cause)
        ? cause
        : configurationFailure('The stage demo configuration is invalid'),
    try: () => {
      if (environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT']?.trim() !== 'stage') {
        throw configurationFailure('The demo bootstrap can run only in the stage environment');
      }
      const authSecret = required(environment, 'BETTER_AUTH_SECRET');
      if (authSecret.length < 32) {
        throw configurationFailure('BETTER_AUTH_SECRET must contain at least 32 characters');
      }
      const accountConfiguration = (account: (typeof STAGE_DEMO_ACCOUNTS)[number]) => {
        const password = required(environment, account.passwordEnvironmentKey);
        if (password.length < 8) {
          throw configurationFailure(
            `${account.passwordEnvironmentKey} must contain at least 8 characters`,
          );
        }
        return {
          email: account.email,
          password,
          principalDisplayName: account.principalDisplayName,
        };
      };
      const accounts = [
        accountConfiguration(STAGE_DEMO_ACCOUNTS[0]),
        accountConfiguration(STAGE_DEMO_ACCOUNTS[1]),
      ] as const;
      return {
        accounts,
        authBaseUrl: parseHttpOrigin(required(environment, 'BETTER_AUTH_URL')),
        authSecret,
        databaseAdminUrl: parsePostgresUrl(required(environment, 'DATABASE_ADMIN_URL')),
      };
    },
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
