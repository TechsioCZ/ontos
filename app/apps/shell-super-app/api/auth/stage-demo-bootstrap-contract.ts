import { Effect, Schema } from 'effect';

export const STAGE_DEMO = Object.freeze({
  authBindingId: '73000000-0000-4000-8000-000000000001',
  defaultLocale: 'cs',
  email: 'demo@test.com',
  legalEntityId: '71000000-0000-4000-8000-000000000001',
  legalName: 'TechsioCZ',
  moduleId: 'crm.core',
  moduleStateId: '74000000-0000-4000-8000-000000000001',
  principalDisplayName: 'Techsio Demo',
  principalId: '72000000-0000-4000-8000-000000000001',
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-TECHSIOCZ',
  tenantId: '70000000-0000-4000-8000-000000000001',
  tenantName: 'Techsio',
  tenantSlug: 'techsio',
} as const);

export type StageDemoEnvironment = Readonly<Record<string, string | undefined>>;
type Comparable = boolean | null | number | string;
type ExactRecord = Readonly<Record<string, Comparable>>;

export interface StageDemoBootstrapConfig {
  readonly authBaseUrl: string;
  readonly authSecret: string;
  readonly databaseAdminUrl: string;
  readonly password: string;
}

export interface StageDemoBootstrapResult {
  readonly authUser: 'created' | 'existing';
  readonly email: typeof STAGE_DEMO.email;
  readonly legalEntityId: typeof STAGE_DEMO.legalEntityId;
  readonly principalId: typeof STAGE_DEMO.principalId;
  readonly tenantId: typeof STAGE_DEMO.tenantId;
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
      cause instanceof StageDemoBootstrapError
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
      const password = required(environment, 'STAGE_DEMO_PASSWORD');
      if (password.length < 8) {
        throw configurationFailure('STAGE_DEMO_PASSWORD must contain at least 8 characters');
      }
      return {
        authBaseUrl: parseHttpOrigin(required(environment, 'BETTER_AUTH_URL')),
        authSecret,
        databaseAdminUrl: parsePostgresUrl(required(environment, 'DATABASE_ADMIN_URL')),
        password,
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
  const conflictingFields = Object.entries(expected)
    .filter(([key, value]) => existing[key] !== value)
    .map(([key]) => key);
  if (conflictingFields.length > 0) {
    throw new StageDemoBootstrapError({
      code: 'stage_demo_conflict',
      reason: `Existing ${label} conflicts with the stage demo definition (${conflictingFields.join(', ')})`,
    });
  }
  return 'existing';
};
