import { Effect, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { STAGE_GRANTABLE_TENANT_RELATIONS, parseStageAccountsFile } from '../../src/install/stage-accounts-file.ts';

const account = (tenant: string, index: number, explicitActions: 'all' | readonly string[]) => ({
  authBindingId: `30000000-0000-4000-8000-0000000000${tenant}${index}`,
  displayName: `Tenant ${tenant.toUpperCase()} account ${index}`,
  email: `account-${tenant}-${index}@example.invalid`,
  grants: { explicitActions, tenantRelations: index === 1 ? ['party_identity_reader'] : ['identity_admin'] },
  password: `fixture-${tenant}-${index}-password`,
  principalId: `20000000-0000-4000-8000-0000000000${tenant}${index}`,
});

const tenant = (suffix: string) => ({
  accounts: [account(suffix, 1, []), account(suffix, 2, 'all')],
  defaultLocale: 'cs',
  displayName: `Tenant ${suffix.toUpperCase()}`,
  legalEntity: {
    legalEntityId: `11000000-0000-4000-8000-0000000000${suffix}0`,
    legalName: `Tenant ${suffix.toUpperCase()} Legal`,
    registrationCountry: 'CZ',
    registrationNumber: `FIXTURE-${suffix.toUpperCase()}`,
  },
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

const parse = <File>(file: File, mode = 0o600) => parseStageAccountsFile({ mode, source: JSON.stringify(file) });
const rejectionReason = <File>(file: File, mode?: number) =>
  Effect.flip(parse(file, mode)).pipe(Effect.map(({ reason }) => reason));

it.effect('accepts any number of Tenants and accounts with grants as data', () =>
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
    const [firstAccount] = firstTenant.accounts;
    expect(Redacted.value(firstAccount.password)).toBe('fixture-a-1-password');
    expect(yield* parse({ ...validFile, tenants: [tenant('a')] })).toMatchObject({ tenants: [{ slug: 'tenant-a' }] });
  }),
);

it.effect('derives grantable Tenant relations from the SpiceDB schema, never membership', () =>
  Effect.sync(() => {
    expect(STAGE_GRANTABLE_TENANT_RELATIONS).toContain('identity_admin');
    expect(STAGE_GRANTABLE_TENANT_RELATIONS).toContain('party_identity_reader');
    expect(STAGE_GRANTABLE_TENANT_RELATIONS).not.toContain('member');
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
      withAccount({ grants: { explicitActions: 'some', tenantRelations: [] } }),
    ]) {
      const reason = yield* rejectionReason(file);
      expect(reason).toMatch(/documented schema/u);
      expect(reason).not.toMatch(/fixture-|example\.invalid|short|not-an-email/u);
    }
  }),
);

it.effect('rejects duplicate identities, unknown relations, and overlapping retirements', () =>
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
    for (const tenantRelations of [['member'], ['not_a_relation'], ['identity_admin', 'identity_admin']]) {
      expect(
        yield* rejectionReason(
          withAccounts([{ ...firstAccount, grants: { explicitActions: [], tenantRelations } }, secondAccount]),
        ),
      ).toMatch(/SpiceDB schema/u);
    }
    expect(yield* rejectionReason({ ...validFile, retiredAccountEmails: [firstAccount?.email] })).toMatch(/Retired/u);
    expect(
      yield* rejectionReason({
        ...validFile,
        retiredTenants: [
          { legalEntityId: first?.legalEntity.legalEntityId, principalIds: [], tenantId: first?.tenantId },
        ],
      }),
    ).toMatch(/Retired/u);
  }),
);
