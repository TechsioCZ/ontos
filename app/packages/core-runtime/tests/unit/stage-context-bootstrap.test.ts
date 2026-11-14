import { Array as EffectArray, ConfigProvider, Effect, pipe, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule } from '../../src/authorization/access-declaration.ts';
import { ModuleKeySchema } from '../../src/access/ids.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { parseStageAccountsFile } from '../../src/install/stage-accounts-file.ts';
import {
  installedModuleKeysOf,
  loadStageContextBootstrapConfiguration,
  stageBootstrapRefusal,
  stageScopeOf,
  stageTenantsFromAccountsFile,
} from '../../src/install/stage-context-bootstrap.ts';

/*
 * The stage bootstrap's decisions that do not need a database: how the operator file becomes the tenants
 * it creates, which modules a stage tenant installs, the scope each write runs in, and the refusals that
 * must happen before anything is written. The bootstrap itself — owner, memberships, release, projection,
 * gate answer — is proven against PostgreSQL and SpiceDB in
 * `tests/integration/stage-context-bootstrap-access.test.ts`.
 */

/** The composition a stage run is handed: the tenant's module and Core's own. */
const entrypoint = (moduleKey: string, entrypointKey: string) =>
  defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey,
    moduleKey,
    role: 'api',
  });

const declaration = (key: string, moduleKey: string) => {
  const owner = entrypoint(moduleKey, `${key}.read`);
  return {
    accessDeclaration: decodeAccessDeclarationOrThrow(
      {
        key,
        kind: 'read' as const,
        modes: ['run' as const],
        placement: { group: 'stage', level: 'basic' },
        risk: 'routine' as const,
        selectors: [],
      },
      owner,
    ),
    entrypoint: owner,
  };
};

const modules: readonly AccessCatalogModule[] = [
  { descriptors: [declaration('core.shell.composition.read', 'core.shell')], moduleId: 'core.shell' },
  { descriptors: [declaration('core.identity.principal.read', 'core.identity')], moduleId: 'core.identity' },
  { descriptors: [declaration('party.registry.party.read', 'party.registry')], moduleId: 'party.registry' },
  { descriptors: [declaration('commerce.catalog.product.read', 'commerce.catalog')], moduleId: 'commerce.catalog' },
];

const accountsFile = JSON.stringify({
  retiredAccountEmails: [],
  retiredTenants: [
    {
      legalEntityId: '11000000-0000-4000-8000-0000000000c0',
      principalIds: ['20000000-0000-4000-8000-0000000000c1'],
      tenantId: '10000000-0000-4000-8000-0000000000c0',
    },
  ],
  schemaVersion: 2,
  tenants: [
    {
      accounts: [
        {
          authBindingId: '30000000-0000-4000-8000-0000000000a1',
          displayName: 'Owner account',
          email: 'owner@example.invalid',
          grants: { owner: true, roles: [] },
          password: ['fixture', 'owner', 'credential'].join('-'),
          principalId: '20000000-0000-4000-8000-0000000000a1',
        },
        {
          authBindingId: '30000000-0000-4000-8000-0000000000a2',
          displayName: 'Colleague account',
          email: 'colleague@example.invalid',
          grants: { owner: false, roles: ['full_access'] },
          password: ['fixture', 'colleague', 'credential'].join('-'),
          principalId: '20000000-0000-4000-8000-0000000000a2',
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
});

const providerUserIds = new Map<string, string>([
  ['20000000-0000-4000-8000-0000000000a1', 'auth-user-owner'],
  ['20000000-0000-4000-8000-0000000000a2', 'auth-user-colleague'],
]);

const loadFile = parseStageAccountsFile({ mode: 0o600, source: accountsFile }, new Set());

it.effect('turns the accounts file into the tenants a stage run creates', () =>
  Effect.gen(function* readsAccountsFile() {
    const tenants = yield* stageTenantsFromAccountsFile(yield* loadFile, providerUserIds, modules);
    expect(tenants.map(({ tenant }) => tenant.slug)).toEqual(['tenant-a']);
    const [tenant] = tenants;
    expect(tenant?.tenant).toMatchObject({
      moduleKey: 'party.registry',
      moduleStateId: '40000000-0000-4000-8000-0000000000a0',
    });
    expect(tenant?.accounts.map(({ owner, principalId, roles }) => ({ owner, principalId, roles }))).toEqual([
      { owner: true, principalId: '20000000-0000-4000-8000-0000000000a1', roles: [] },
      { owner: false, principalId: '20000000-0000-4000-8000-0000000000a2', roles: ['full_access'] },
    ]);
    expect(tenant?.accounts.map(({ providerUserId }) => providerUserId)).toEqual([
      'auth-user-owner',
      'auth-user-colleague',
    ]);
  }),
);

it.effect('refuses a stage account whose Better Auth user was not created', () =>
  Effect.gen(function* refusesMissingAuthUser() {
    const incomplete = new Map([...providerUserIds].slice(0, 1));
    const refused = yield* stageTenantsFromAccountsFile(yield* loadFile, incomplete, modules).pipe(Effect.flip);
    expect(refused.code).toBe('stage_context_bootstrap_failed');
    expect(refused.reason).toMatch(/Better Auth user/u);
  }),
);

it.effect('installs the tenant module and Core, never a vertical the tenant does not have', () =>
  Effect.sync(() => {
    // Core is never optional: the shell and the identity screens are served in every tenant.
    expect(installedModuleKeysOf(['party.registry'], modules)).toEqual([
      'core.identity',
      'core.shell',
      'party.registry',
    ]);
    // A vertical module the accounts file does not name stays out of the tenant's installations, so its
    // capabilities never enter the release: the negative control for a bootstrap that installs everything.
    expect(installedModuleKeysOf(['party.registry'], modules)).not.toContain('commerce.catalog');
  }),
);

it.effect('scopes every write to the tenant it names, in the context the request selected', () =>
  Effect.gen(function* scopesWrites() {
    const tenantContext = yield* stageScopeOf({
      principalId: '20000000-0000-4000-8000-0000000000a1',
      tenantId: '10000000-0000-4000-8000-0000000000a0',
    });
    expect(tenantContext).toMatchObject({
      correlationId: 'stage-context-bootstrap',
      principalId: '20000000-0000-4000-8000-0000000000a1',
      tenantId: '10000000-0000-4000-8000-0000000000a0',
    });
    expect(tenantContext.legalEntityId).toBeUndefined();
    const company = yield* stageScopeOf({
      legalEntityId: '11000000-0000-4000-8000-0000000000a0',
      principalId: '20000000-0000-4000-8000-0000000000a1',
      tenantId: '10000000-0000-4000-8000-0000000000a0',
    });
    expect(company.legalEntityId).toBe('11000000-0000-4000-8000-0000000000a0');
    const refused = yield* stageScopeOf({ principalId: 'not-a-uuid', tenantId: 'also-not-a-uuid' }).pipe(Effect.flip);
    expect(refused.reason).toMatch(/scope is invalid/u);
  }),
);

it.effect('refuses a stage run with no tenant, no declaration set or no owner account', () =>
  Effect.gen(function* refusesUnbootstrappableRuns() {
    const tenants = yield* stageTenantsFromAccountsFile(yield* loadFile, providerUserIds, modules);
    const [tenant] = tenants;
    if (tenant === undefined) {
      return yield* Effect.die(new Error('the fixture must declare one tenant'));
    }
    const options = { authenticationNamespaceId: 'namespace', modules };
    expect(stageBootstrapRefusal({ retiredTenants: [], tenants: [] }, options)?.reason).toMatch(/At least one/u);
    // A composition that declares nothing would publish an empty release and deny the owner everything.
    expect(stageBootstrapRefusal({ retiredTenants: [], tenants }, { ...options, modules: [] })?.reason).toMatch(
      /declarations of the running composition/u,
    );
    const withoutOwner = [{ ...tenant, accounts: tenant.accounts.map((account) => ({ ...account, owner: false })) }];
    expect(stageBootstrapRefusal({ retiredTenants: [], tenants: withoutOwner }, options)?.reason).toMatch(
      /exactly one owner/u,
    );
    const twoOwners = [{ ...tenant, accounts: tenant.accounts.map((account) => ({ ...account, owner: true })) }];
    expect(stageBootstrapRefusal({ retiredTenants: [], tenants: twoOwners }, options)?.reason).toMatch(
      /exactly one owner/u,
    );
    expect(stageBootstrapRefusal({ retiredTenants: [], tenants }, options)).toBeUndefined();
    return yield* Effect.void;
  }),
);

it.effect('uses explicit operator module intent and refuses a module absent from the composition', () =>
  Effect.gen(function* explicitBaseModule() {
    const file = yield* loadFile;
    const selected = {
      ...file,
      tenants: pipe(
        file.tenants,
        EffectArray.map((tenant) => ({ ...tenant, moduleKey: ModuleKeySchema.make('commerce.catalog') })),
      ),
    };
    const tenants = yield* stageTenantsFromAccountsFile(selected, providerUserIds, modules);
    expect(tenants.map(({ tenant }) => tenant.moduleKey)).toEqual(['commerce.catalog']);
    expect(
      installedModuleKeysOf(
        tenants.map(({ tenant }) => tenant.moduleKey),
        modules,
      ),
    ).not.toContain('party.registry');
    const absent = modules.filter(({ moduleId }) => moduleId !== 'commerce.catalog');
    const refused = yield* stageTenantsFromAccountsFile(selected, providerUserIds, absent).pipe(Effect.flip);
    expect(refused.reason).toMatch(/base module.*running composition/u);
    expect(
      stageBootstrapRefusal(
        { retiredTenants: [], tenants },
        { authenticationNamespaceId: 'namespace', modules: absent },
      )?.reason,
    ).toMatch(/base module/u);
  }),
);

const bootstrapConfiguration = {
  DATABASE_URL: 'postgresql://ontos_runtime:fixture-database-secret@database:5432/ontos_stage_fixture',
  SPICEDB_CA_CERT: '-----BEGIN CERTIFICATE-----\nfixture-only-certificate\n-----END CERTIFICATE-----',
  SPICEDB_ENDPOINT: 'spicedb:50051',
  SPICEDB_PRESHARED_KEY: 'fixture-engine-secret',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
};

it.effect('retains the bootstrap database credential as Redacted until its connection boundary', () =>
  Effect.gen(function* redactedConfiguration() {
    const configuration = yield* loadStageContextBootstrapConfiguration().pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(bootstrapConfiguration)),
    );
    expect(Redacted.isRedacted(configuration.databaseUrl)).toBe(true);
    expect(Redacted.value(configuration.databaseUrl)).toBe(bootstrapConfiguration.DATABASE_URL);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(configuration);
    expect(encoded).not.toContain('fixture-database-secret');
    expect(encoded).not.toContain('fixture-engine-secret');
    expect(Redacted.isRedacted(configuration.spiceDb)).toBe(true);
    expect(Redacted.value(configuration.spiceDb).endpoint).toBe('spicedb:50051');
  }),
);

it.effect('keeps the non-stage bootstrap refusal before any database or engine connection', () =>
  Effect.gen(function* refusedConfiguration() {
    const failure = yield* loadStageContextBootstrapConfiguration().pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ...bootstrapConfiguration,
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
        }),
      ),
      Effect.flip,
    );
    expect(failure.reason).toBe('The Core installation bootstrap can run only in stage');
  }),
);
