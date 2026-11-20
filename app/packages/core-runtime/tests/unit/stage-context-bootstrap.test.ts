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
  stageCredentialEndingOf,
  stageScopeOf,
  stageTenantsFromAccountsFile,
} from '../../src/install/stage-context-bootstrap.ts';
import type { StageConnectedApp, StageLeaverBinding } from '../../src/install/stage-context-bootstrap.ts';

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
    const run = { attachedLogins: [], retiredPrincipals: [], retiredTenants: [], tenants };
    expect(stageBootstrapRefusal({ ...run, tenants: [] }, options)?.reason).toMatch(/At least one/u);
    // A file that only attaches or retires logins reconciles no tenant and is still a run.
    const attachedLogin = {
      authBindingId: '30000000-0000-4000-8000-0000000000b1',
      displayName: 'Attached login',
      principalId: '20000000-0000-4000-8000-0000000000b1',
      providerUserId: 'auth-user-attached',
      tenantId: '10000000-0000-4000-8000-0000000000b0',
    };
    expect(stageBootstrapRefusal({ ...run, attachedLogins: [attachedLogin], tenants: [] }, options)).toBeUndefined();
    const retiredPrincipal = {
      principalId: '20000000-0000-4000-8000-0000000000c2',
      providerUserId: 'auth-user-retired',
      tenantId: '10000000-0000-4000-8000-0000000000b0',
    };
    expect(
      stageBootstrapRefusal({ ...run, retiredPrincipals: [retiredPrincipal], tenants: [] }, options),
    ).toBeUndefined();
    // A composition that declares nothing would publish an empty release and deny the owner everything.
    expect(stageBootstrapRefusal(run, { ...options, modules: [] })?.reason).toMatch(
      /declarations of the running composition/u,
    );
    const withoutOwner = [{ ...tenant, accounts: tenant.accounts.map((account) => ({ ...account, owner: false })) }];
    expect(stageBootstrapRefusal({ ...run, tenants: withoutOwner }, options)?.reason).toMatch(/exactly one owner/u);
    const twoOwners = [{ ...tenant, accounts: tenant.accounts.map((account) => ({ ...account, owner: true })) }];
    expect(stageBootstrapRefusal({ ...run, tenants: twoOwners }, options)?.reason).toMatch(/exactly one owner/u);
    expect(stageBootstrapRefusal(run, options)).toBeUndefined();
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
        { attachedLogins: [], retiredPrincipals: [], retiredTenants: [], tenants },
        { authenticationNamespaceId: 'namespace', modules: absent },
      )?.reason,
    ).toMatch(/base module/u);
  }),
);

/*
 * What a departure ends of a leaver's sign-ins, decided from the rows the run holds locked: the shapes of the AKROS
 * leavers (a login, connected apps the person revoked in the product, one still live), a draft consent, and the replay
 * of a departure that already ended them.
 */
const leaverLogin = 'auth-user-leaver';
const leaverId = '20000000-0000-4000-8000-0000000000d1';
/** The company the acting owner administers, and one they do not (suspended there, say). */
const administeredCompany = '11000000-0000-4000-8000-0000000000d0';
const unadministeredCompany = '11000000-0000-4000-8000-0000000000d9';
const administersOnly = (legalEntityId: string) => legalEntityId === administeredCompany;
const loginBinding: StageLeaverBinding = {
  authenticationNamespaceId: 'namespace',
  bindingRevision: 1,
  principalAuthBindingId: '30000000-0000-4000-8000-0000000000d0',
  provider: 'better_auth',
  providerSubjectId: leaverLogin,
  status: 'active',
  subjectType: 'user',
};

/** Connected app `n`: its grant and the `oauth_grant` binding naming it, as the product leaves them. */
const appOf = (n: number, grant: string, binding: StageLeaverBinding['status'] | null) => {
  const grantId = `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const bindingId = `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const app: StageConnectedApp = {
    authBindingId: binding === null ? null : bindingId,
    clientId: `https://client-${n}.example/metadata`,
    clientName: `Client ${n}`,
    grantId,
    lastUsedAt: null,
    legalEntityId: administeredCompany,
    principalId: leaverId,
    revokedByPrincipalId: grant === 'revoked' ? leaverId : null,
    revokeReason: grant === 'revoked' ? 'user' : null,
    status: grant,
    tenantId: '10000000-0000-4000-8000-0000000000d0',
    userPrincipalId: leaverId,
  };
  const bindings: readonly StageLeaverBinding[] =
    binding === null
      ? []
      : [
          {
            authenticationNamespaceId: 'namespace',
            bindingRevision: 2,
            principalAuthBindingId: bindingId,
            provider: 'better_auth',
            providerSubjectId: grantId,
            status: binding,
            subjectType: 'oauth_grant',
          },
        ];
  return { app, bindings };
};

const endingOf = (
  apps: readonly ReturnType<typeof appOf>[],
  input: { readonly login?: StageLeaverBinding; readonly principalStatus?: string } = {},
) =>
  stageCredentialEndingOf({
    actingOwnerAdministers: administersOnly,
    authenticationNamespaceId: 'namespace',
    bindings: [input.login ?? loginBinding, ...apps.flatMap(({ bindings }) => bindings)],
    connectedApps: apps.map(({ app }) => app),
    principalStatus: input.principalStatus ?? 'active',
    providerUserId: leaverLogin,
  });

const revokedInTheProduct = (n: number) => appOf(n, 'revoked', 'disabled');

it.effect('revokes the disabled bindings of connected apps the person revoked, and ends nothing else', () =>
  Effect.gen(function* disabledGrantsOnly() {
    // The expedice shape: the login and three connections the person revoked in the product, which left their
    // bindings disabled. They no longer refuse the departure; each is revoked at the revision and status it was read.
    const apps = [1, 2, 3].map(revokedInTheProduct);
    const ending = yield* endingOf(apps);
    expect(ending.replay).toBe(false);
    expect(ending.connectedApps).toEqual([]);
    expect(ending.bindings).toEqual([
      {
        id: loginBinding.principalAuthBindingId,
        provider: 'better_auth',
        revision: 1,
        status: 'active',
        subjectType: 'user',
      },
      ...apps.map(({ app }) => ({
        id: app.authBindingId,
        provider: 'better_auth',
        revision: 2,
        status: 'disabled',
        subjectType: 'oauth_grant',
      })),
    ]);
  }),
);

it.effect('ends the one connected app still live and revokes every grant binding with the login', () =>
  Effect.gen(function* oneActiveGrant() {
    // The eshop shape: five connections revoked in the product and one live, last used yesterday.
    const live = appOf(6, 'active', 'active');
    const apps = [...[1, 2, 3, 4, 5].map(revokedInTheProduct), live];
    const ending = yield* endingOf(apps);
    expect(ending.connectedApps).toEqual([live.app]);
    expect(ending.bindings.map(({ status }) => status)).toEqual([
      'active',
      'disabled',
      'disabled',
      'disabled',
      'disabled',
      'disabled',
      'active',
    ]);
  }),
);

it.effect('ends a draft consent, which has no binding yet', () =>
  Effect.gen(function* pendingGrant() {
    const pending = appOf(7, 'draft', null);
    const ending = yield* endingOf([pending]);
    expect(ending.connectedApps).toEqual([pending.app]);
    expect(ending.bindings).toEqual([
      {
        id: loginBinding.principalAuthBindingId,
        provider: 'better_auth',
        revision: 1,
        status: 'active',
        subjectType: 'user',
      },
    ]);
  }),
);

it.effect('replays a departure that ended its connected apps without ending anything again', () =>
  Effect.gen(function* replayAfterEndedGrants() {
    const ended = [
      ...[1, 2, 3, 4, 5].map((n) => appOf(n, 'revoked', 'revoked')),
      appOf(6, 'revoked', 'revoked'),
      appOf(7, 'denied', null),
    ];
    const ending = yield* endingOf(ended, {
      login: { ...loginBinding, bindingRevision: 2, status: 'revoked' },
      principalStatus: 'archived',
    });
    expect(ending).toEqual({ bindings: [], connectedApps: [], replay: true });
    // A grant binding left unrevoked on an archived Principal is no replay of this departure.
    const refused = yield* endingOf([...ended, revokedInTheProduct(8)], {
      login: { ...loginBinding, bindingRevision: 2, status: 'revoked' },
      principalStatus: 'archived',
    }).pipe(Effect.flip);
    expect(refused.reason).toMatch(/exact replay/u);
  }),
);

it.effect('still refuses a credential that is no connected app of the leaver', () =>
  Effect.gen(function* refusesOtherCredentials() {
    const app = revokedInTheProduct(1);
    const [binding] = app.bindings;
    if (binding === undefined) {
      return yield* Effect.die(new Error('the fixture app has a binding'));
    }
    const credential = (bindings: readonly StageLeaverBinding[], connectedApps: readonly StageConnectedApp[]) =>
      stageCredentialEndingOf({
        actingOwnerAdministers: administersOnly,
        authenticationNamespaceId: 'namespace',
        bindings: [loginBinding, ...bindings],
        connectedApps,
        principalStatus: 'active',
        providerUserId: leaverLogin,
      }).pipe(Effect.flip);
    // A disabled API key, a grant binding no grant of the leaver names, one whose grant names another binding, and
    // one of another namespace: each refuses the departure.
    const refusals = [
      yield* credential([{ ...binding, providerSubjectId: 'key', status: 'disabled', subjectType: 'api_key' }], []),
      yield* credential([binding], []),
      yield* credential([binding], [{ ...app.app, authBindingId: loginBinding.principalAuthBindingId }]),
      yield* credential([{ ...binding, authenticationNamespaceId: 'other' }], [app.app]),
    ];
    for (const refused of refusals) {
      expect(refused.reason).toMatch(/another login or credential/u);
    }
    // Without the login's live binding nothing is ended, whatever connected apps the person has.
    const unsigned = yield* endingOf([appOf(6, 'active', 'active')], {
      login: { ...loginBinding, status: 'disabled' },
    }).pipe(Effect.flip);
    expect(unsigned.reason).toMatch(/live binding of the login/u);
    return yield* Effect.void;
  }),
);

it.effect(
  'ends a live connected app only in a company the acting owner administers, and names the one it may not end',
  () =>
    Effect.gen(function* refusesUnadministeredCompany() {
      const inCompany = (app: ReturnType<typeof appOf>, legalEntityId: string) => ({
        ...app,
        app: { ...app.app, legalEntityId },
      });
      // An active grant and a draft consent in a company the owner does not administer: neither is ended, and the file is
      // refused naming the app and the company, before anything is written.
      for (const live of [appOf(6, 'active', 'active'), appOf(7, 'draft', null)]) {
        const refused = yield* endingOf([revokedInTheProduct(1), inCompany(live, unadministeredCompany)]).pipe(
          Effect.flip,
        );
        expect(refused.code).toBe('stage_connected_app_not_administered');
        expect(refused.reason).toContain(live.app.clientName);
        expect(refused.reason).toContain(live.app.clientId);
        expect(refused.reason).toContain(unadministeredCompany);
      }
      // A connection that already ended there ends nothing, so no administration is asked; its binding is still revoked.
      const ended = inCompany(revokedInTheProduct(2), unadministeredCompany);
      const ending = yield* endingOf([ended]);
      expect(ending.connectedApps).toEqual([]);
      expect(ending.bindings.map(({ id }) => id)).toEqual([
        loginBinding.principalAuthBindingId,
        ended.app.authBindingId,
      ]);
      // The same live app in the company the owner administers is ended.
      const administered = appOf(6, 'active', 'active');
      expect((yield* endingOf([administered])).connectedApps).toEqual([administered.app]);
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
