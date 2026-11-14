import { Effect, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseStageAccountsFile } from '../../src/install/stage-accounts-file.ts';

/*
 * The operator accounts file names a stage tenant's v2 authority as data: which account owns the tenant
 * and which further accounts hold the tenant's "Plný přístup" role. A file that names no owner, two
 * owners, or a role that does not exist yet cannot be bootstrapped, so it is refused before anything is
 * written — a tenant without an owner would be created with no authority at all.
 */

const account = (tenant: string, index: number, grants: { owner: boolean; roles: readonly string[] }) => ({
  authBindingId: `30000000-0000-4000-8000-0000000000${tenant}${index}`,
  displayName: `Tenant ${tenant.toUpperCase()} account ${index}`,
  email: `account-${tenant}-${index}@example.invalid`,
  grants,
  password: `fixture-${tenant}-${index}-password`,
  principalId: `20000000-0000-4000-8000-0000000000${tenant}${index}`,
});

const tenant = (suffix: string) => ({
  accounts: [
    account(suffix, 1, { owner: true, roles: [] }),
    account(suffix, 2, { owner: false, roles: ['full_access'] }),
  ],
  defaultLocale: 'cs',
  displayName: `Tenant ${suffix.toUpperCase()}`,
  legalEntity: {
    legalEntityId: `11000000-0000-4000-8000-0000000000${suffix}0`,
    legalName: `Tenant ${suffix.toUpperCase()} Legal`,
    registrationCountry: 'CZ',
    registrationNumber: `FIXTURE-${suffix.toUpperCase()}`,
  },
  moduleKey: 'party.registry',
  moduleStateId: `40000000-0000-4000-8000-0000000000${suffix}0`,
  slug: `tenant-${suffix}`,
  tenantId: `10000000-0000-4000-8000-0000000000${suffix}0`,
});

const validFile = {
  retiredAccountEmails: ['retired-fixture@example.invalid'],
  retiredTenants: [
    {
      legalEntityId: '11000000-0000-4000-8000-0000000000c0',
      principalIds: ['20000000-0000-4000-8000-0000000000c1'],
      tenantId: '10000000-0000-4000-8000-0000000000c0',
    },
  ],
  schemaVersion: 2,
  tenants: [tenant('a'), tenant('b')],
};

const reviewedWorkloads: ReadonlySet<string> = new Set(['fixture.machine-task', 'fixture.other-task']);
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const parse = <File>(file: File, mode = 0o600) =>
  parseStageAccountsFile({ mode, source: JSON.stringify(file) }, reviewedWorkloads);
const rejectionReason = <File>(file: File, mode?: number) =>
  Effect.flip(parse(file, mode)).pipe(Effect.map(({ reason }) => reason));

it.effect('accepts any number of Tenants and accounts with v2 authority as data', () =>
  Effect.gen(function* acceptsValidFile() {
    const parsed = yield* parse(validFile);
    expect(parsed).toMatchObject({
      retiredAccountEmails: validFile.retiredAccountEmails,
      retiredTenants: validFile.retiredTenants,
      schemaVersion: 2,
      tenants: validFile.tenants.map(({ accounts, ...tenantData }) => ({
        ...tenantData,
        accounts: accounts.map(({ authBindingId, displayName, email, grants, principalId }) => ({
          authBindingId,
          displayName,
          email,
          grants,
          principalId,
        })),
      })),
    });
    const [firstTenant] = parsed.tenants;
    const [owner, holder] = firstTenant.accounts;
    expect(owner?.grants).toEqual({ owner: true, roles: [] });
    expect(holder?.grants).toEqual({ owner: false, roles: ['full_access'] });
    expect(Redacted.value(owner?.password ?? Redacted.make(''))).toBe('fixture-a-1-password');
    expect(yield* parse({ ...validFile, tenants: [tenant('a')] })).toMatchObject({ tenants: [{ slug: 'tenant-a' }] });
  }),
);

it.effect('rejects a file readable by group or others', () =>
  Effect.gen(function* rejectsLoosePermissions() {
    expect(yield* rejectionReason(validFile, 0o640)).toMatch(/chmod 600/u);
    expect(yield* rejectionReason(validFile, 0o604)).toMatch(/chmod 600/u);
  }),
);

it.effect('rejects malformed files without echoing their values', () =>
  Effect.gen(function* rejectsMalformedFiles() {
    const [first, second] = validFile.tenants;
    const [firstAccount] = first?.accounts ?? [];
    const withAccount = <Patch>(patch: Patch) => ({
      ...validFile,
      tenants: [{ ...first, accounts: [{ ...firstAccount, ...patch }] }, second],
    });
    for (const file of [
      { ...validFile, schemaVersion: 1 },
      { ...validFile, extra: true },
      { ...validFile, tenants: [] },
      withAccount({ password: 'short' }),
      withAccount({ email: 'not-an-email' }),
      withAccount({ role: 'anything' }),
      // The legacy grant shape is gone with the relations it named (O62): it is not accepted quietly.
      withAccount({ grants: { explicitActions: 'all', tenantRelations: ['party_identity_reader'] } }),
      withAccount({ grants: { owner: true, roles: ['role_editor_template'] } }),
    ]) {
      const reason = yield* rejectionReason(file);
      expect(reason).toMatch(/documented schema/u);
      expect(reason).not.toMatch(/fixture-|example\.invalid|short|not-an-email/u);
    }
  }),
);

it.effect('rejects duplicate identities, unknown role keys, and overlapping retirements', () =>
  Effect.gen(function* rejectsInconsistentData() {
    const [first, second] = validFile.tenants;
    const [firstAccount, secondAccount] = first?.accounts ?? [];
    const withAccounts = <Account>(accounts: readonly Account[]) => ({
      ...validFile,
      tenants: [{ ...first, accounts }, second],
    });
    expect(yield* rejectionReason({ ...validFile, tenants: [first, first] })).toMatch(/own ID/u);
    expect(
      yield* rejectionReason(
        withAccounts([firstAccount, { ...secondAccount, email: firstAccount?.email.toUpperCase() }]),
      ),
    ).toMatch(/own email/u);
    expect(
      yield* rejectionReason(
        withAccounts([
          firstAccount,
          { ...secondAccount, grants: { owner: false, roles: ['full_access', 'full_access'] } },
        ]),
      ),
    ).toMatch(/roles must be unique/u);
    expect(yield* rejectionReason({ ...validFile, retiredAccountEmails: [firstAccount?.email] })).toMatch(/Retired/u);
    expect(
      yield* rejectionReason({
        ...validFile,
        retiredTenants: [
          { legalEntityId: first?.legalEntity.legalEntityId, principalIds: [], tenantId: first?.tenantId },
        ],
      }),
    ).toMatch(/documented schema/u);
  }),
);

it.effect('refuses a Tenant with no owner or with two owners', () =>
  Effect.gen(function* refusesUnbootstrappableTenants() {
    const [first, second] = validFile.tenants;
    const [owner, holder] = first?.accounts ?? [];
    const withoutOwner = { ...validFile, tenants: [{ ...first, accounts: [holder] }, second] };
    expect(yield* rejectionReason(withoutOwner)).toMatch(/exactly one owner/u);
    const withTwoOwners = {
      ...validFile,
      tenants: [
        {
          ...first,
          accounts: [owner, { ...holder, grants: { owner: true, roles: [] } }],
        },
        second,
      ],
    };
    expect(yield* rejectionReason(withTwoOwners)).toMatch(/exactly one owner/u);
  }),
);

it.effect('accepts only the workload declarations explicitly supplied by the caller', () =>
  Effect.gen(function* acceptsDeclaredWorkloadsOnly() {
    const [first, second] = validFile.tenants;
    const principalId = first?.accounts[1]?.principalId;
    const withWorkload = (workloadKey: string) => ({
      ...validFile,
      tenants: [{ ...first, workloads: [{ principalId, workloadKey }] }, second],
    });
    for (const workloadKey of reviewedWorkloads) {
      expect((yield* parse(withWorkload(workloadKey))).tenants[0]?.workloads).toStrictEqual([
        { principalId, workloadKey },
      ]);
    }
    const reason = yield* rejectionReason(withWorkload('fixture.undeclared-task'));
    expect(reason).toMatch(/declared by the composition/u);
    expect(reason).not.toContain('fixture.undeclared-task');
  }),
);

it.effect('allows the same declared workload in two tenants when each names its own principals', () =>
  Effect.gen(function* acceptsTenantLocalWorkloads() {
    const workloadKey = 'fixture.machine-task';
    const tenants = validFile.tenants.map((entry) => ({
      ...entry,
      workloads: entry.accounts.map(({ principalId }) => ({ principalId, workloadKey })),
    }));
    const parsed = yield* parse({ ...validFile, tenants });
    expect(parsed.tenants).toHaveLength(2);
    expect(parsed.tenants.map(({ workloads }) => workloads)).toEqual(tenants.map(({ workloads }) => workloads));
    expect(parsed.retiredTenants).toEqual(validFile.retiredTenants);
  }),
);

it.effect('refuses another active file tenant principal with the value-free own-tenant error', () =>
  Effect.gen(function* refusesCrossTenantWorkloadPrincipal() {
    const first = tenant('a');
    const second = tenant('b');
    const [foreignAccount] = second.accounts;
    if (foreignAccount === undefined) {
      expect.unreachable('The second tenant fixture needs its own active account');
    }
    expect(validFile.tenants.flatMap(({ accounts }) => accounts).map(({ principalId }) => principalId)).toContain(
      foreignAccount.principalId,
    );
    const failure = yield* parse({
      ...validFile,
      tenants: [
        {
          ...first,
          workloads: [{ principalId: foreignAccount.principalId, workloadKey: 'fixture.machine-task' }],
        },
        second,
      ],
    }).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'StageAccountsFileError')).toBe(true);
    expect(failure.reason).toBe('Every registered workload needs a principal of its own tenant');
    expect(failure.cause).toBeUndefined();
    for (const value of [
      first.tenantId,
      second.tenantId,
      foreignAccount.principalId,
      foreignAccount.email,
      foreignAccount.password,
    ]) {
      expect(failure.reason).not.toContain(value);
    }
  }),
);

it.effect('uses exactly one supplied workload set, with no retained declarations between calls', () =>
  Effect.gen(function* isolatesReviewedDeclarations() {
    const first = tenant('a');
    const workloadKey = 'another.integration-task';
    const withWorkload = {
      ...validFile,
      tenants: [{ ...first, workloads: [{ principalId: first.accounts[0]?.principalId, workloadKey }] }],
    };
    const contents = { mode: 0o600, source: yield* encodeFile(withWorkload) };
    const parsed = yield* parseStageAccountsFile(contents, new Set([workloadKey]));
    expect(parsed.tenants[0].workloads).toEqual([{ principalId: first.accounts[0]?.principalId, workloadKey }]);
    for (const declared of [new Set<string>(), reviewedWorkloads]) {
      const failure = yield* parseStageAccountsFile(contents, declared).pipe(Effect.flip);
      expect(failure.reason).toMatch(/declared by the composition/u);
      expect(failure.reason).not.toContain(workloadKey);
      expect(failure.reason).not.toContain(first.accounts[0]?.principalId);
    }
    expect(
      (yield* parseStageAccountsFile({ mode: 0o600, source: yield* encodeFile(validFile) }, new Set())).tenants,
    ).toHaveLength(2);
  }),
);

it.effect('does not let supplied declarations bypass workload syntax or account identity checks', () =>
  Effect.gen(function* validatesDeclaredWorkloadData() {
    const first = tenant('a');
    for (const workloadKey of ['', '*', 'invalid workload', 'upper.Task']) {
      const file = {
        ...validFile,
        tenants: [{ ...first, workloads: [{ principalId: first.accounts[0]?.principalId, workloadKey }] }],
      };
      const failure = yield* parseStageAccountsFile(
        { mode: 0o600, source: yield* encodeFile(file) },
        new Set([workloadKey]),
      ).pipe(Effect.flip);
      expect(failure.reason).toMatch(/documented schema/u);
      expect(failure.reason).not.toContain('fixture-');
    }
    const workloadKey = 'fixture.machine-task';
    const workload = { principalId: '20000000-0000-4000-8000-000000000099', workloadKey };
    expect(yield* rejectionReason({ ...validFile, tenants: [{ ...first, workloads: [workload] }] })).toMatch(
      /principal of its own tenant/u,
    );
    const ownWorkload = { principalId: first.accounts[0]?.principalId, workloadKey };
    expect(
      yield* rejectionReason({ ...validFile, tenants: [{ ...first, workloads: [ownWorkload, ownWorkload] }] }),
    ).toMatch(/only once/u);
  }),
);

it.effect('requires explicit valid base-module intent without a legacy default', () =>
  Effect.gen(function* explicitModuleIntent() {
    const first = tenant('a');
    for (const moduleKey of [undefined, '', '*', 'module access']) {
      expect(yield* rejectionReason({ ...validFile, tenants: [{ ...first, moduleKey }] })).toMatch(
        /documented schema/u,
      );
    }
    const alternate = yield* parse({ ...validFile, tenants: [{ ...first, moduleKey: 'another.owner' }] });
    expect(alternate.tenants[0].moduleKey).toBe('another.owner');
  }),
);
