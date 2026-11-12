import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem, Redacted } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { expect, it } from 'effect-rstest';

import { parseStageAccountsFile, STAGE_DECLARED_WORKLOAD_KEYS } from '../../src/install/stage-accounts-file.ts';

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

it.effect('accepts only the workloads a carrier declares, and refuses module-to-module workload keys', () =>
  Effect.gen(function* acceptsDeclaredWorkloadsOnly() {
    const [first, second] = validFile.tenants;
    const principalId = first?.accounts[1]?.principalId;
    const withWorkload = (workloadKey: string) => ({
      ...validFile,
      tenants: [{ ...first, workloads: [{ principalId, workloadKey }] }, second],
    });
    for (const workloadKey of [
      'commerce.storefront-client',
      'core.identity-provider',
      'payment.provider-notification-ingress',
      'payment.provider-reconciliation',
    ]) {
      expect((yield* parse(withWorkload(workloadKey))).tenants[0]?.workloads).toStrictEqual([
        { principalId, workloadKey },
      ]);
    }
    const reason = yield* rejectionReason(withWorkload('commerce.order-approval-consumer'));
    expect(reason).not.toContain('commerce.order-approval-consumer');
  }),
);

/** The repository's `app/` root, where every carrier package lives. */
const APP_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** Where carriers declare `accessWorkload`: the Core runtime, the verticals and the Shell API. */
const CARRIER_ROOTS = ['packages/core-runtime/src', 'verticals', 'apps/shell-super-app/api'];
const ACCESS_WORKLOAD_LIST = /accessWorkload:\s*\{[^}]*?workloads:\s*\[(?<keys>[^\]]*)\]/gu;

/** Every production source file under a directory, skipping installed packages and test folders. */
const productionSourceFiles = (directory: string): Effect.Effect<string[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* listProductionSourceFiles() {
    const fileSystem = yield* FileSystem.FileSystem;
    const files: string[] = [];
    for (const name of yield* fileSystem.readDirectory(directory)) {
      const entry = `${directory}/${name}`;
      if (name === 'node_modules' || name === 'tests') {
        continue;
      }
      if ((yield* fileSystem.stat(entry)).type === 'Directory') {
        files.push(...(yield* productionSourceFiles(entry)));
      } else if (/\.m?ts$/u.test(name) && !/\.test\./u.test(name)) {
        files.push(entry);
      }
    }
    return files;
  });

it.layer(NodeFileSystem.layer)('the carrier workload keys', (suite) => {
  suite.effect(
    'accepts exactly the workload keys that carriers declare with accessWorkload',
    () =>
      Effect.gen(function* declaresTheCarrierWorkloadKeys() {
        const fileSystem = yield* FileSystem.FileSystem;
        const declared = new Set<string>();
        for (const root of CARRIER_ROOTS) {
          for (const file of yield* productionSourceFiles(`${APP_ROOT}${root}`)) {
            for (const match of (yield* fileSystem.readFileString(file)).matchAll(ACCESS_WORKLOAD_LIST)) {
              for (const key of (match.groups?.['keys'] ?? '').matchAll(/'(?<key>[^']+)'/gu)) {
                declared.add(key.groups?.['key'] ?? '');
              }
            }
          }
        }
        expect([...declared].toSorted()).toStrictEqual([...STAGE_DECLARED_WORKLOAD_KEYS].toSorted());
      }),
    // It reads every production source file of the carrier roots, which outlasts the default on CI.
    30_000,
  );
});
