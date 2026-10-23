import { ConfigProvider, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { STAGE_GRANTABLE_TENANT_RELATIONS, parseStageAccountsFile } from '../../src/install/stage-accounts-file.ts';
import {
  classifyStageServicePrincipal,
  reconcileStageServicePrincipals,
  buildRetiredStageContextRelationships,
  buildStageContextRelationships,
  stageContextsFromAccountsFile,
} from '../../src/install/stage-context-bootstrap.ts';

const fixturePassword = (account: string): string => `fixture-${account}-password`;

const accountsFileSource = JSON.stringify({
  actionAuthorization: { actionAssertions: [], roleGrants: [] },
  retiredAccountEmails: [],
  retiredTenants: [
    {
      legalEntityId: '11000000-0000-4000-8000-0000000000b0',
      moduleKey: 'party.registry',
      principalIds: ['20000000-0000-4000-8000-0000000000b1'],
      tenantId: '10000000-0000-4000-8000-0000000000b0',
    },
  ],
  schemaVersion: 3,
  scopedRoles: [],
  tenants: [
    {
      accounts: [
        {
          authBindingId: '30000000-0000-4000-8000-0000000000a1',
          displayName: 'Tenant A account 1',
          email: 'account-a-1@example.invalid',
          grants: { explicitActions: [], tenantRelations: ['party_identity_reader'] },
          password: fixturePassword('a-1'),
          principalId: '20000000-0000-4000-8000-0000000000a1',
        },
        {
          authBindingId: '30000000-0000-4000-8000-0000000000a2',
          displayName: 'Tenant A account 2',
          email: 'account-a-2@example.invalid',
          grants: { explicitActions: 'all', tenantRelations: ['identity_admin', 'party_identity_manager'] },
          password: fixturePassword('a-2'),
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

const loadAccountsFile = parseStageAccountsFile({ mode: 0o600, source: accountsFileSource });

it.effect('flattens the accounts file into stage contexts in file order', () =>
  Effect.gen(function* flattensAccountsFile() {
    const contexts = stageContextsFromAccountsFile(yield* loadAccountsFile);
    expect(contexts.map(({ principalDisplayName, tenantSlug }) => ({ principalDisplayName, tenantSlug }))).toEqual([
      { principalDisplayName: 'Tenant A account 1', tenantSlug: 'tenant-a' },
      { principalDisplayName: 'Tenant A account 2', tenantSlug: 'tenant-a' },
    ]);
    expect(contexts[0]).toMatchObject({
      legalName: 'Tenant A Legal',
      moduleId: 'party.registry',
      tenantName: 'Tenant A',
      tenantRelations: ['party_identity_reader'],
    });
    expect(contexts.some((context) => Object.hasOwn(context, 'password') || Object.hasOwn(context, 'email'))).toBe(
      false,
    );
  }),
);

it.effect('writes exactly the Tenant relations listed in grant data, only inside the own Tenant', () =>
  Effect.gen(function* writesListedRelations() {
    for (const context of stageContextsFromAccountsFile(yield* loadAccountsFile)) {
      const relationships = yield* buildStageContextRelationships(context);
      expect(relationships).toContainEqual({
        relation: 'self',
        resourceId: context.principalId,
        resourceType: 'principal',
        subjectId: context.principalId,
        subjectType: 'principal',
      });
      expect(relationships).toContainEqual({
        relation: 'tenant',
        resourceId: context.principalId,
        resourceType: 'principal',
        subjectId: context.tenantId,
        subjectType: 'tenant',
      });
      expect(
        relationships
          .filter(({ relation, resourceType }) => resourceType === 'tenant' && relation !== 'member')
          .map(({ relation }) => relation),
      ).toEqual([...context.tenantRelations]);
      expect(
        relationships
          .filter(({ resourceType }) => resourceType === 'tenant')
          .every(({ resourceId }) => resourceId === context.tenantId),
      ).toBe(true);
    }
  }),
);

it.effect('deletes every relationship a bootstrap can have written for a retired Tenant', () =>
  Effect.gen(function* retiresTenant() {
    const [retired] = (yield* loadAccountsFile).retiredTenants;
    expect(retired).toBeDefined();
    if (retired === undefined) {
      return;
    }
    const relationships = yield* buildRetiredStageContextRelationships(retired);
    expect(relationships).toContainEqual({
      relation: 'self',
      resourceId: retired.principalIds[0],
      resourceType: 'principal',
      subjectId: retired.principalIds[0],
      subjectType: 'principal',
    });
    expect(relationships).toHaveLength(2 + retired.principalIds.length * (STAGE_GRANTABLE_TENANT_RELATIONS.length + 5));
    expect(relationships).toContainEqual({
      relation: 'member',
      resourceId: retired.tenantId,
      resourceType: 'tenant',
      subjectId: retired.principalIds[0],
      subjectType: 'principal',
    });
    expect(
      relationships.filter(({ resourceType }) => resourceType === 'tenant').map(({ relation }) => relation),
    ).toEqual(['member', ...STAGE_GRANTABLE_TENANT_RELATIONS]);
  }),
);

const service = {
  displayName: 'Native service',
  legalEntityId: '11000000-0000-4000-8000-0000000000a0',
  principalId: '20000000-0000-4000-8000-0000000000a1',
  tenantId: '10000000-0000-4000-8000-0000000000a0',
};
const serviceRow = {
  displayName: service.displayName,
  kind: 'service',
  principalId: service.principalId,
  status: 'active',
  tenantId: service.tenantId,
} as const;
it.effect('creates missing service principals and treats exact existing records as idempotent', () =>
  Effect.gen(function* classifiesService() {
    expect(yield* classifyStageServicePrincipal(undefined, service)).toBe('create');
    expect(yield* classifyStageServicePrincipal(serviceRow, service)).toBe('existing');
  }),
);
it.effect('refuses to rename, reactivate, move or convert conflicting service identities', () =>
  Effect.gen(function* rejectsConflicts() {
    for (const conflict of [
      { displayName: 'Other service' },
      { kind: 'human' },
      { status: 'disabled' },
      { status: 'archived' },
      { tenantId: '10000000-0000-4000-8000-0000000000b0' },
    ] as const) {
      const error = yield* classifyStageServicePrincipal({ ...serviceRow, ...conflict }, service).pipe(Effect.flip);
      expect(error.reason).toContain('conflicts');
    }
  }),
);
it.effect('requires distinct service IDs and the native stage guard before opening a database', () =>
  Effect.gen(function* guardsServiceInstaller() {
    const provider = ConfigProvider.fromUnknown({
      DATABASE_ADMIN_URL: 'postgresql://operator:unused@localhost/test',
      SPICEDB_CA_CERT: 'unused',
      SPICEDB_ENDPOINT: 'spicedb:50051',
      SPICEDB_PRESHARED_KEY: 'unused',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
    });
    expect((yield* reconcileStageServicePrincipals([service, service], provider).pipe(Effect.flip)).reason).toContain(
      'distinct',
    );
    expect((yield* reconcileStageServicePrincipals([service], provider).pipe(Effect.flip)).reason).toContain(
      'only in stage',
    );
  }),
);
