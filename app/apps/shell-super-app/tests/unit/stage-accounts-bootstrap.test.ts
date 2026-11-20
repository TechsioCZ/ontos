import { StageContextBootstrapError } from '@app/core-runtime/install/stage-context-bootstrap';
import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Redacted, Ref, Schema } from 'effect';
import { Command } from 'effect/cli';
import { expect, it } from 'effect-rstest';

import {
  STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY,
  StageAccountsBootstrapError,
  classifyExactStageAccountsRecord,
  parseStageAccountsBootstrapConfig,
  stageAccountsDatabases,
  stageAccountsDryRunLines,
  stageAccountsFailureLine,
  stageRunFailure,
} from '../../api/auth/stage-accounts-bootstrap-contract.ts';
import type { StageAccountsRehearsal } from '../../api/auth/stage-accounts-bootstrap-contract.ts';
import { loadStageAccountsConfiguration } from '../../api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';
import { makeStageAccountsCommand } from '../../scripts/bootstrap-stage-accounts.mts';

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
          grants: { owner: true, roles: [] },
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
      moduleKey: 'party.registry',
      moduleStateId: '40000000-0000-4000-8000-0000000000a0',
      slug: 'tenant-a',
      tenantId: '10000000-0000-4000-8000-0000000000a0',
    },
  ],
} as const;

const VALID_SOURCE = JSON.stringify(validAccountsFile);
const declaredWorkloadKeys: ReadonlySet<string> = new Set(['fixture.stage-provisioning']);
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
    const configuration = yield* parseStageAccountsBootstrapConfig(
      validEnvironment,
      readerFor(VALID_SOURCE),
      declaredWorkloadKeys,
    );
    expect(configuration).toMatchObject({
      accountsFile: { retiredAccountEmails: validAccountsFile.retiredAccountEmails, schemaVersion: 2 },
      authBaseUrl: 'https://shell.stage.example.test',
      authSecret: 'stage-auth-secret-with-at-least-32-characters',
      databaseAdminUrl: 'postgresql://db:password@db:5432/db',
    });
    const [tenant] = configuration.accountsFile.tenants;
    if (tenant === undefined) {
      return yield* Effect.die(new Error('the fixture declares one tenant'));
    }
    const [account] = tenant.accounts;
    expect(account.email).toBe('account-a@example.invalid');
    expect(account.grants).toEqual({ owner: true, roles: [] });
    expect(Redacted.value(account.password)).toBe('fixture-a-password');
    expect(Redacted.isRedacted(account.password)).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('refuses to run outside stage or without the accounts file', () =>
  Effect.gen(function* refusesWithoutAccountsFile() {
    expect(
      yield* Effect.flip(
        parseStageAccountsBootstrapConfig(
          { ...validEnvironment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' },
          readerFor(VALID_SOURCE),
          declaredWorkloadKeys,
        ),
      ),
    ).toMatchObject({ reason: expect.stringMatching(/stage environment/u) });
    expect(
      yield* Effect.flip(
        parseStageAccountsBootstrapConfig(
          { ...validEnvironment, [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: undefined },
          readerFor(VALID_SOURCE),
          declaredWorkloadKeys,
        ),
      ),
    ).toMatchObject({ reason: `${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} is required` });
    expect(
      yield* Effect.flip(
        parseStageAccountsBootstrapConfig(
          { ...validEnvironment, [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: '/operator/missing.json' },
          readerFor(VALID_SOURCE),
          declaredWorkloadKeys,
        ),
      ),
    ).toMatchObject({ reason: expect.stringMatching(/could not be read/u) });
  }),
);

it.effect('reports accounts file validation failures as configuration errors without values', () =>
  Effect.gen(function* reportsInvalidFiles() {
    const loose = yield* Effect.flip(
      parseStageAccountsBootstrapConfig(validEnvironment, readerFor(VALID_SOURCE, 0o644), declaredWorkloadKeys),
    );
    expect(loose).toMatchObject({
      code: 'stage_accounts_configuration_invalid',
      reason: expect.stringMatching(/chmod 600/u),
    });
    const malformed = yield* Effect.flip(
      parseStageAccountsBootstrapConfig(
        validEnvironment,
        readerFor(JSON.stringify({ ...validAccountsFile, schemaVersion: 1 })),
        declaredWorkloadKeys,
      ),
    );
    expect(malformed.reason).toMatch(/documented schema/u);
    expect(malformed.reason).not.toMatch(/fixture-|example\.invalid/u);
  }),
);

it.effect('threads only the explicitly supplied workload declarations through the infrastructure loader', () =>
  Effect.gen(function* threadsReviewedWorkloads() {
    const [tenant] = validAccountsFile.tenants;
    const [account] = tenant.accounts;
    const workloadKey = 'fixture.stage-provisioning';
    const source = yield* encodeFile({
      ...validAccountsFile,
      tenants: [{ ...tenant, workloads: [{ principalId: account.principalId, workloadKey }] }],
    });
    const reader = readerFor(source);
    const configuration = yield* loadStageAccountsConfiguration(reader, declaredWorkloadKeys, validEnvironment);
    const [loaded] = configuration.accountsFile.tenants;
    if (loaded === undefined) {
      return yield* Effect.die(new Error('the fixture declares one tenant'));
    }
    expect(loaded.workloads).toEqual([{ principalId: account.principalId, workloadKey }]);
    const failure = yield* loadStageAccountsConfiguration(reader, new Set(), validEnvironment).pipe(Effect.flip);
    expect(failure.code).toBe('stage_accounts_configuration_invalid');
    expect(failure.reason).toMatch(/declared by the composition/u);
    expect(failure.reason).not.toContain(workloadKey);
    expect(failure.reason).not.toContain(account.principalId);
    expect(failure.reason).not.toContain(account.email);
    expect(failure.reason).not.toContain(account.password);
    return yield* Effect.void;
  }),
);

it.effect('rejects malformed workloads even when a caller includes them in its supplied set', () =>
  Effect.gen(function* refusesMalformedWorkloads() {
    const [tenant] = validAccountsFile.tenants;
    const [account] = tenant.accounts;
    const workloadKey = 'invalid workload';
    const failure = yield* parseStageAccountsBootstrapConfig(
      validEnvironment,
      readerFor(
        yield* encodeFile({
          ...validAccountsFile,
          tenants: [{ ...tenant, workloads: [{ principalId: account.principalId, workloadKey }] }],
        }),
      ),
      new Set([workloadKey]),
    ).pipe(Effect.flip);
    expect(failure.code).toBe('stage_accounts_configuration_invalid');
    expect(failure.reason).toMatch(/documented schema/u);
    expect(failure.reason).not.toContain(workloadKey);
    expect(failure.reason).not.toContain(account.password);
  }),
);

it("passes every code Core refuses or fails a run under through to the operator's output line", () => {
  const reason =
    'The connected app Client 236 (https://client-236.example/metadata) of a retired stage Principal acts in company 00000000-0000-4000-8000-000000000005, which the acting tenant owner does not administer at the decision time';
  for (const code of [
    'stage_connected_app_not_administered',
    'stage_last_administrator',
    'stage_context_bootstrap_failed',
  ] as const) {
    const failure = stageRunFailure(new StageContextBootstrapError({ cause: 'a driver failure', code, reason }));
    expect(failure).toBeInstanceOf(StageAccountsBootstrapError);
    expect({ cause: failure.cause, code: failure.code, reason: failure.reason }).toEqual({
      cause: undefined,
      code,
      reason,
    });
    expect(stageAccountsFailureLine(failure)).toBe(`Stage accounts bootstrap failed (${code}): ${reason}`);
  }
  expect(
    stageAccountsFailureLine(
      new StageAccountsBootstrapError({ code: 'stage_accounts_persistence_failed', reason: 'The pool is closed' }),
    ),
  ).toBe('Stage accounts bootstrap failed (stage_accounts_persistence_failed): The pool is closed');
});

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

/** The operator command line as the script parses it; the run it selects is recorded instead of started. */
const runsSelectedBy = (argv: readonly string[]) =>
  Effect.gen(function* parseCommandLine() {
    const selected = yield* Ref.make<readonly boolean[]>([]);
    const exit = yield* Command.runWith(
      makeStageAccountsCommand((dryRun) => Ref.update(selected, (runs) => [...runs, dryRun])),
      { renderErrors: false, version: 'test' },
    )(argv).pipe(Effect.exit);
    return { refused: Exit.isFailure(exit), runs: yield* Ref.get(selected) };
  });

it.effect('runs for real without a flag, dry with --dry-run, and refuses a mistyped flag or stray argument unrun', () =>
  Effect.gen(function* parsesTheCommandLine() {
    expect(yield* runsSelectedBy([])).toEqual({ refused: false, runs: [false] });
    expect(yield* runsSelectedBy(['--dry-run'])).toEqual({ refused: false, runs: [true] });
    for (const argv of [['--dryrun'], ['dry-run'], ['--dry-run', '--dry-run'], ['--commit']]) {
      expect(yield* runsSelectedBy(argv)).toEqual({ refused: true, runs: [] });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('takes two distinct logins of one database and refuses another server, port or database', () =>
  Effect.gen(function* requiresOneDatabase() {
    const admin = 'postgresql://stage_admin:admin@db18:5432/ontos';
    const pair = yield* stageAccountsDatabases({
      DATABASE_ADMIN_URL: admin,
      DATABASE_URL: 'postgresql://ontos_runtime:runtime@db18:5432/ontos',
    });
    expect([pair.admin.user, pair.runtime.user]).toEqual(['stage_admin', 'ontos_runtime']);
    for (const runtime of [
      'postgresql://ontos_runtime:runtime@replica:5432/ontos',
      'postgresql://ontos_runtime:runtime@db18:5433/ontos',
      'postgresql://ontos_runtime:runtime@db18:5432/ontos_copy',
    ]) {
      const refused = yield* Effect.flip(stageAccountsDatabases({ DATABASE_ADMIN_URL: admin, DATABASE_URL: runtime }));
      expect({ code: refused.code, reason: refused.reason }).toEqual({
        code: 'stage_accounts_configuration_invalid',
        reason: 'DATABASE_URL and DATABASE_ADMIN_URL must name the same PostgreSQL server, port and database',
      });
    }
    const sameLogin = yield* Effect.flip(stageAccountsDatabases({ DATABASE_ADMIN_URL: admin, DATABASE_URL: admin }));
    expect(sameLogin.code).toBe('stage_accounts_configuration_invalid');
    expect(sameLogin.reason).not.toContain('admin@');
  }),
);

it('prints what the move transaction would write, every write the dry run skipped, and no secret', () => {
  const tenantId = '10000000-0000-4000-8000-0000000000e0';
  const app = {
    authBindingId: '30000000-0000-4000-8000-0000000000e2',
    clientId: 'https://client.example/metadata',
    clientName: 'E-shop client',
    endedByThisRun: false,
    grantId: '50000000-0000-4000-8000-0000000000e1',
    lastUsedAt: new Date('2026-11-19T10:00:00.000Z'),
    legalEntityId: '11000000-0000-4000-8000-0000000000e0',
    principalId: '20000000-0000-4000-8000-0000000000e1',
    revokedByPrincipalId: null,
    revokeReason: null,
    status: 'active',
    tenantId,
    userPrincipalId: '20000000-0000-4000-8000-0000000000e1',
  };
  const draft = {
    ...app,
    clientName: 'Draft client',
    grantId: '50000000-0000-4000-8000-0000000000e2',
    lastUsedAt: null,
    status: 'draft',
  };
  const rehearsal: StageAccountsRehearsal = {
    accounts: [
      { email: 'existing@example.invalid', status: 'existing', verifiesEmail: true },
      { email: 'new@example.invalid', status: 'created', verifiesEmail: false },
      { email: 'changed@example.invalid', status: 'password-reset', verifiesEmail: false },
    ],
    attachments: [
      {
        authBindingId: '30000000-0000-4000-8000-0000000000f1',
        created: true,
        email: 'leaver@example.invalid',
        principalId: '20000000-0000-4000-8000-0000000000f1',
        providerUserId: 'auth-user-1',
        tenantId: '10000000-0000-4000-8000-0000000000f0',
      },
      {
        authBindingId: '30000000-0000-4000-8000-0000000000f2',
        created: false,
        email: 'moved@example.invalid',
        principalId: '20000000-0000-4000-8000-0000000000f2',
        providerUserId: 'auth-user-2',
        tenantId: '10000000-0000-4000-8000-0000000000f0',
      },
    ],
    completedConnectedApps: [{ ...app, status: 'revoked' }],
    connectedApps: [
      { ...app, endedByThisRun: true },
      { ...draft, endedByThisRun: true },
    ],
    departures: [
      {
        archives: true,
        bindings: [
          { provider: 'better_auth', status: 'disabled', subjectType: 'oauth_grant' },
          { provider: 'better_auth', status: 'active', subjectType: 'user' },
          { provider: 'better_auth', status: 'active', subjectType: 'oauth_grant' },
          { provider: 'better_auth', status: 'disabled', subjectType: 'oauth_grant' },
        ],
        connectedApps: [app, draft],
        directory: 1,
        email: 'leaver@example.invalid',
        ended: { assignments: 2, delegations: 1, memberships: 3, teamPlaces: 0 },
        principalId: '20000000-0000-4000-8000-0000000000e1',
        revocationEvents: 1,
        tenantId,
      },
      {
        archives: false,
        bindings: [],
        connectedApps: [],
        directory: 0,
        email: 'gone@example.invalid',
        ended: { assignments: 0, delegations: 0, memberships: 0, teamPlaces: 0 },
        principalId: '20000000-0000-4000-8000-0000000000e3',
        revocationEvents: 0,
        tenantId,
      },
    ],
    leftTenantIds: [tenantId],
    retiredAccountEmails: ['old@example.invalid'],
    retiredTenantIds: ['10000000-0000-4000-8000-0000000000d0'],
    tenantIds: ['10000000-0000-4000-8000-0000000000c0'],
  };
  expect(stageAccountsDryRunLines(rehearsal)).toEqual([
    "Stage accounts dry run: the move transaction took the real run's locks and made its writes, then rolled back; nothing was written",
    `Would retire the Principal of leaver@example.invalid: tenant=${tenantId} principal=20000000-0000-4000-8000-0000000000e1 bindings=better_auth/oauth_grant:active=1,better_auth/oauth_grant:disabled=2,better_auth/user:active=1 memberships=3 assignments=2 delegations=1 teamPlaces=0 directory=1 auditEvents=1`,
    `Would end connected app "E-shop client" (https://client.example/metadata) of leaver@example.invalid: tenant=${tenantId} grant=50000000-0000-4000-8000-0000000000e1 was=active lastUsed=2026-11-19T10:00:00.000Z`,
    `Would end connected app "Draft client" (https://client.example/metadata) of leaver@example.invalid: tenant=${tenantId} grant=50000000-0000-4000-8000-0000000000e2 was=draft lastUsed=never`,
    `The Principal of gone@example.invalid is retired already: tenant=${tenantId} principal=20000000-0000-4000-8000-0000000000e3; the run ends nothing of it again`,
    'Would attach login leaver@example.invalid: tenant=10000000-0000-4000-8000-0000000000f0 principal=20000000-0000-4000-8000-0000000000f1 binding=30000000-0000-4000-8000-0000000000f1',
    'Login moved@example.invalid is attached already: tenant=10000000-0000-4000-8000-0000000000f0 principal=20000000-0000-4000-8000-0000000000f2 binding=30000000-0000-4000-8000-0000000000f2; the run creates nothing',
    'Would write 1 audit events (oauth.connection.revoked)',
    'Dry run skipped the Better Auth account existing@example.invalid: the run would leave its password and mark its email verified',
    'Dry run skipped the Better Auth account new@example.invalid: the run would create it',
    'Dry run skipped the Better Auth account changed@example.invalid: the run would replace its password and end its sessions',
    'Dry run skipped the pre-step: the run would delete the Better Auth tokens and consent of 1 connected apps whose departure an earlier run completed',
    'Dry run skipped the clean-up after the commit: the run would delete the Better Auth tokens and consent of 2 connected apps of the people it retires',
    `Dry run skipped the authorization reconcile of tenant ${tenantId}, which somebody leaves`,
    'Dry run skipped tenant 10000000-0000-4000-8000-0000000000c0 of the file: its identity rows, access bootstrap and authorization reconcile',
    'Dry run skipped retiring tenant 10000000-0000-4000-8000-0000000000d0',
    'Dry run skipped banning the retired account old@example.invalid',
  ]);
});
