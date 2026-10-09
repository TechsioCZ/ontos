import { Effect, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY,
  StageAccountsBootstrapError,
  classifyExactStageAccountsRecord,
  parseStageAccountsBootstrapConfig,
} from '../../api/auth/stage-accounts-bootstrap-contract.ts';

const ACCOUNTS_FILE_PATH = '/operator/stage-accounts.json';

const validEnvironment = {
  BETTER_AUTH_SECRET: 'stage-auth-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'https://shell.stage.example.test',
  DATABASE_ADMIN_URL: 'postgresql://db:password@db:5432/db',
  [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: ACCOUNTS_FILE_PATH,
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
} as const;

const validAccountsFile = {
  retiredAccountEmails: ['retired-fixture@example.invalid'],
  retiredTenants: [],
  schemaVersion: 2,
  tenants: [
    {
      accounts: [
        {
          authBindingId: '30000000-0000-4000-8000-0000000000a1',
          displayName: 'Tenant A account',
          email: 'account-a@example.invalid',
          grants: { explicitActions: [], tenantRelations: ['party_identity_reader'] },
          password: 'fixture-a-password',
          principalId: '20000000-0000-4000-8000-0000000000a1',
        },
      ],
      defaultLocale: 'cs',
      displayName: 'Tenant A',
      legalEntity: {
        legalEntityId: '11000000-0000-4000-8000-0000000000a0',
        legalName: 'Tenant A Legal',
        registrationCountry: 'CZ',
        registrationNumber: 'FIXTURE-A',
      },
      moduleStateId: '40000000-0000-4000-8000-0000000000a0',
      slug: 'tenant-a',
      tenantId: '10000000-0000-4000-8000-0000000000a0',
    },
  ],
} as const;

const VALID_SOURCE = JSON.stringify(validAccountsFile);

const readerFor =
  (source: string, mode = 0o600) =>
  (path: string) =>
    path === ACCOUNTS_FILE_PATH
      ? Effect.succeed({ mode, source })
      : Effect.fail(
          new StageAccountsBootstrapError({
            code: 'stage_accounts_configuration_invalid',
            reason: 'fixture read failure',
          }),
        );

it.effect('builds the stage configuration from the operator accounts file', () =>
  Effect.gen(function* buildsTheStageConfiguration() {
    const configuration = yield* parseStageAccountsBootstrapConfig(validEnvironment, readerFor(VALID_SOURCE));
    expect(configuration).toMatchObject({
      accountsFile: { retiredAccountEmails: validAccountsFile.retiredAccountEmails, schemaVersion: 2 },
      authBaseUrl: 'https://shell.stage.example.test',
      authSecret: 'stage-auth-secret-with-at-least-32-characters',
      databaseAdminUrl: 'postgresql://db:password@db:5432/db',
    });
    const [tenant] = configuration.accountsFile.tenants;
    const [account] = tenant.accounts;
    expect(account.email).toBe('account-a@example.invalid');
    expect(Redacted.value(account.password)).toBe('fixture-a-password');
    expect(Redacted.isRedacted(account.password)).toBe(true);
  }),
);

it.effect('refuses to run outside stage or without the accounts file', () =>
  Effect.gen(function* refusesWithoutAccountsFile() {
    expect(
      yield* Effect.flip(
        parseStageAccountsBootstrapConfig(
          { ...validEnvironment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' },
          readerFor(VALID_SOURCE),
        ),
      ),
    ).toMatchObject({ reason: expect.stringMatching(/stage environment/u) });
    expect(
      yield* Effect.flip(
        parseStageAccountsBootstrapConfig(
          { ...validEnvironment, [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: undefined },
          readerFor(VALID_SOURCE),
        ),
      ),
    ).toMatchObject({ reason: `${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} is required` });
    expect(
      yield* Effect.flip(
        parseStageAccountsBootstrapConfig(
          { ...validEnvironment, [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: '/operator/missing.json' },
          readerFor(VALID_SOURCE),
        ),
      ),
    ).toMatchObject({ reason: expect.stringMatching(/could not be read/u) });
  }),
);

it.effect('reports accounts file validation failures as configuration errors without values', () =>
  Effect.gen(function* reportsInvalidFiles() {
    const loose = yield* Effect.flip(
      parseStageAccountsBootstrapConfig(validEnvironment, readerFor(VALID_SOURCE, 0o644)),
    );
    expect(loose).toMatchObject({
      code: 'stage_accounts_configuration_invalid',
      reason: expect.stringMatching(/chmod 600/u),
    });
    const malformed = yield* Effect.flip(
      parseStageAccountsBootstrapConfig(
        validEnvironment,
        readerFor(JSON.stringify({ ...validAccountsFile, schemaVersion: 1 })),
      ),
    );
    expect(malformed.reason).toMatch(/documented schema/u);
    expect(malformed.reason).not.toMatch(/fixture-|example\.invalid/u);
  }),
);

it.effect('treats an exact record as idempotent and rejects conflicting state', () =>
  Effect.gen(function* treatsAnExactRecordAsIdempotent() {
    const expected = { name: 'Tenant A', slug: 'tenant-a', status: 'active' } as const;
    expect(yield* classifyExactStageAccountsRecord('tenant', undefined, expected)).toBe('create');
    expect(yield* classifyExactStageAccountsRecord('tenant', expected, expected)).toBe('existing');
    expect(
      yield* Effect.flip(classifyExactStageAccountsRecord('tenant', { ...expected, name: 'Other tenant' }, expected)),
    ).toMatchObject({ reason: expect.stringMatching(/conflicts/u) });
  }),
);
