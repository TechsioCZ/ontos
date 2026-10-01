import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { STAGE_CONTEXTS, STAGE_CONTEXT_ORDER } from '@app/core-runtime/install/stage-context-bootstrap';

import {
  STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY,
  STAGE_DEMO_ACCOUNT_SLOTS,
  StageDemoBootstrapError,
  classifyExactStageDemoRecord,
  parseStageDemoBootstrapConfig,
} from '../../api/auth/stage-demo-bootstrap-contract.ts';
import type { StageAccountsFileContents } from '../../api/auth/stage-demo-bootstrap-contract.ts';

const ACCOUNTS_FILE_PATH = '/operator/stage-accounts.json';

const validEnvironment = {
  BETTER_AUTH_SECRET: 'stage-auth-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'https://shell.stage.example.test',
  DATABASE_ADMIN_URL: 'postgresql://db:password@db:5432/db',
  [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: ACCOUNTS_FILE_PATH,
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
} as const;

const identity = (name: string) => ({ email: `${name}@example.invalid`, password: `fixture-${name}-password` });

const validAccountsFile: AccountsFileFixture & { readonly tenants: Required<AccountsFileFixture['tenants']> } = {
  retiredAccountEmails: ['retired-fixture@example.invalid'],
  schemaVersion: 1,
  tenants: {
    akros: { admin: identity('akros-admin'), demo: identity('akros-demo') },
    techsio: { admin: identity('techsio-admin'), demo: identity('techsio-demo') },
  },
};

interface AccountIdentityFixture {
  readonly email: string;
  readonly password: string;
}

/** Accounts file fixtures, including deliberately malformed ones (wrong version, missing Tenant, extra key). */
interface AccountsFileFixture {
  readonly extra?: boolean;
  readonly retiredAccountEmails: readonly string[];
  readonly schemaVersion: number;
  readonly tenants: Readonly<
    Partial<
      Record<'akros' | 'techsio', { readonly admin: AccountIdentityFixture; readonly demo: AccountIdentityFixture }>
    >
  >;
}

const readerFor =
  (accountsFile: AccountsFileFixture, mode = 0o600) =>
  (path: string) =>
    path === ACCOUNTS_FILE_PATH
      ? Effect.succeed<StageAccountsFileContents>({ mode, source: JSON.stringify(accountsFile) })
      : Effect.fail(
          new StageDemoBootstrapError({ code: 'stage_demo_configuration_invalid', reason: 'fixture read failure' }),
        );

const rejectionReason = (accountsFile: AccountsFileFixture, mode?: number) =>
  Effect.flip(parseStageDemoBootstrapConfig(validEnvironment, readerFor(accountsFile, mode))).pipe(
    Effect.map(({ reason }) => reason),
  );

it.effect('builds the stage configuration from the operator accounts file', () =>
  Effect.gen(function* buildsTheStageConfiguration() {
    expect(yield* parseStageDemoBootstrapConfig(validEnvironment, readerFor(validAccountsFile))).toEqual({
      accounts: [
        { ...identity('techsio-demo'), principalDisplayName: 'Techsio Demo' },
        { ...identity('techsio-admin'), principalDisplayName: 'Techsio Admin' },
        { ...identity('akros-demo'), principalDisplayName: 'Akros Demo' },
        { ...identity('akros-admin'), principalDisplayName: 'Akros Admin' },
      ],
      authBaseUrl: 'https://shell.stage.example.test',
      authSecret: 'stage-auth-secret-with-at-least-32-characters',
      databaseAdminUrl: 'postgresql://db:password@db:5432/db',
      retiredAccountEmails: ['retired-fixture@example.invalid'],
    });
  }),
);

it.effect('keeps account slots in the Core stage context order without any identity', () =>
  Effect.sync(() => {
    expect(STAGE_DEMO_ACCOUNT_SLOTS.map(({ role, tenant }) => ({ role, tenant }))).toEqual(
      STAGE_CONTEXT_ORDER.map((key) => ({ role: STAGE_CONTEXTS[key].role, tenant: STAGE_CONTEXTS[key].tenantSlug })),
    );
    expect(JSON.stringify(STAGE_DEMO_ACCOUNT_SLOTS)).not.toMatch(/@/u);
  }),
);

it.effect('refuses to run outside stage or without the accounts file', () =>
  Effect.gen(function* refusesWithoutAccountsFile() {
    expect(
      yield* Effect.flip(
        parseStageDemoBootstrapConfig(
          { ...validEnvironment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' },
          readerFor(validAccountsFile),
        ),
      ),
    ).toMatchObject({ reason: expect.stringMatching(/stage environment/u) });
    expect(
      yield* Effect.flip(
        parseStageDemoBootstrapConfig(
          { ...validEnvironment, [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: undefined },
          readerFor(validAccountsFile),
        ),
      ),
    ).toMatchObject({ reason: `${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} is required` });
    expect(
      yield* Effect.flip(
        parseStageDemoBootstrapConfig(
          { ...validEnvironment, [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: '/operator/missing.json' },
          readerFor(validAccountsFile),
        ),
      ),
    ).toMatchObject({ reason: expect.stringMatching(/could not be read/u) });
  }),
);

it.effect('rejects an accounts file readable by group or others', () =>
  Effect.gen(function* rejectsLoosePermissions() {
    expect(yield* rejectionReason(validAccountsFile, 0o640)).toMatch(/chmod 600/u);
    expect(yield* rejectionReason(validAccountsFile, 0o604)).toMatch(/chmod 600/u);
  }),
);

it.effect('rejects malformed accounts files without echoing their values', () =>
  Effect.gen(function* rejectsMalformedFiles() {
    const { techsio } = validAccountsFile.tenants;
    const invalidFiles: readonly AccountsFileFixture[] = [
      { ...validAccountsFile, schemaVersion: 2 },
      { ...validAccountsFile, extra: true },
      { ...validAccountsFile, tenants: { techsio } },
      {
        ...validAccountsFile,
        tenants: {
          ...validAccountsFile.tenants,
          techsio: { ...techsio, demo: { ...techsio.demo, password: 'short' } },
        },
      },
      {
        ...validAccountsFile,
        tenants: {
          ...validAccountsFile.tenants,
          techsio: { ...techsio, demo: { ...techsio.demo, email: 'not-an-email' } },
        },
      },
    ];
    for (const accountsFile of invalidFiles) {
      const reason = yield* rejectionReason(accountsFile);
      expect(reason).toMatch(/documented schema/u);
      expect(reason).not.toMatch(/fixture-|example\.invalid|short|not-an-email/u);
    }
  }),
);

it.effect('rejects shared or still-active retired emails', () =>
  Effect.gen(function* rejectsDuplicateEmails() {
    const { akros, techsio } = validAccountsFile.tenants;
    expect(
      yield* rejectionReason({
        ...validAccountsFile,
        tenants: {
          ...validAccountsFile.tenants,
          akros: { ...akros, demo: { ...akros.demo, email: techsio.demo.email.toUpperCase() } },
        },
      }),
    ).toMatch(/own email/u);
    expect(yield* rejectionReason({ ...validAccountsFile, retiredAccountEmails: [techsio.admin.email] })).toMatch(
      /Retired/u,
    );
    expect(
      yield* rejectionReason({
        ...validAccountsFile,
        retiredAccountEmails: ['retired-fixture@example.invalid', 'retired-fixture@example.invalid'],
      }),
    ).toMatch(/Retired/u);
  }),
);

it.effect('treats an exact record as idempotent and rejects conflicting state', () =>
  Effect.gen(function* treatsAnExactRecordAsIdempotent() {
    const expected = {
      name: 'Techsio',
      slug: 'techsio',
      status: 'active',
    } as const;
    expect(yield* classifyExactStageDemoRecord('tenant', undefined, expected)).toBe('create');
    expect(yield* classifyExactStageDemoRecord('tenant', expected, expected)).toBe('existing');
    expect(
      yield* Effect.flip(classifyExactStageDemoRecord('tenant', { ...expected, name: 'Other tenant' }, expected)),
    ).toMatchObject({ reason: expect.stringMatching(/conflicts/u) });
  }),
);
