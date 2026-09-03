// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import type { executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import {
  OrganizationEngagementProfileSchema,
  PersonEngagementProfileSchema,
} from '../../shared/domain/engagement-profile.ts';
import { CounterpartyRefSchema, PartyRefSchema } from '../../shared/party-registry-references.ts';
import type { CounterpartyRef, PartyRef } from '../../shared/party-registry-references.ts';
import {
  CONTACTS_TABLE_INVENTORY,
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../../src/db/schema.ts';
import {
  makePartyRegistryReferenceOperations,
  validatePartyRegistryReferences,
} from '../../src/integrations/party-registry/reference-validation.gateway.ts';
import { archiveOrganizationEngagementAction } from '../../src/actions/archive-organization-engagement.action.ts';
import { archivePersonEngagementAction } from '../../src/actions/archive-person-engagement.action.ts';
import { attachOrganizationEngagementAction } from '../../src/actions/attach-organization-engagement.action.ts';
import { attachPersonEngagementAction } from '../../src/actions/attach-person-engagement.action.ts';
import { unarchiveOrganizationEngagementAction } from '../../src/actions/unarchive-organization-engagement.action.ts';
import { unarchivePersonEngagementAction } from '../../src/actions/unarchive-person-engagement.action.ts';

const tenantId = 'c1000000-0000-4000-8000-000000000001';
const organizationPartyRef = {
  moduleId: 'party.registry',
  resourceId: 'c2000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const personPartyRef = {
  ...organizationPartyRef,
  resourceId: 'c3000000-0000-4000-8000-000000000001',
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'c4000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;

test('uses the public Party Registry ResourceRef contracts without raw legacy ids', () => {
  assert.deepEqual(
    Schema.decodeUnknownSync(PartyRefSchema)(organizationPartyRef),
    organizationPartyRef,
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(CounterpartyRefSchema)(counterpartyRef),
    counterpartyRef,
  );

  const shared = {
    archivedAt: null,
    createdAt: '2026-09-03T08:00:00.000Z',
    updatedAt: '2026-09-03T08:00:00.000Z',
  } as const;
  const engagementProfileId = 'c5000000-0000-4000-8000-000000000001';
  const organization = Schema.decodeUnknownSync(OrganizationEngagementProfileSchema, {
    onExcessProperty: 'error',
  })({
    ...shared,
    counterpartyRef,
    partyRef: organizationPartyRef,
    profileRef: {
      moduleId: 'contacts.core',
      resourceId: engagementProfileId,
      resourceType: 'contacts.core.organization-engagement-profile',
      tenantId,
    },
  });
  const person = Schema.decodeUnknownSync(PersonEngagementProfileSchema, {
    onExcessProperty: 'error',
  })({
    ...shared,
    counterpartyRef,
    partyRef: personPartyRef,
    profileRef: {
      moduleId: 'contacts.core',
      resourceId: engagementProfileId,
      resourceType: 'contacts.core.person-engagement-profile',
      tenantId,
    },
  });

  assert.equal('customerId' in organization, false);
  assert.equal('contactId' in person, false);
  assert.equal('engagementProfileId' in organization, false);
  assert.equal('name' in organization, false);
  assert.equal('email' in person, false);
  assert.equal('phone' in person, false);
  assert.equal('ico' in organization, false);
});

test('owns only engagement profile tables and has no cross-vertical foreign keys', () => {
  assert.deepEqual(CONTACTS_TABLE_INVENTORY, [
    'organization_engagement_profiles',
    'person_engagement_profiles',
  ]);
  assert.equal(organizationEngagementProfiles.partyResourceId.name, 'party_resource_id');
  assert.equal(
    organizationEngagementProfiles.counterpartyResourceId.name,
    'counterparty_resource_id',
  );
  assert.equal(personEngagementProfiles.partyResourceId.name, 'party_resource_id');
  assert.equal(personEngagementProfiles.counterpartyResourceId.name, 'counterparty_resource_id');
});

test('contains no compatibility mapping, backfill, dual-write, or legacy identity ownership', async () => {
  const [schema, migration, packageJson] = await Promise.all([
    readFile(new URL('../../src/db/schema.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../drizzle/0003_tranquil_old_lace.sql', import.meta.url), 'utf-8'),
    readFile(new URL('../../package.json', import.meta.url), 'utf-8'),
  ]);

  for (const forbidden of [
    /legacy[_-](?:customer|contact)/iu,
    /migration[_-]mapping/iu,
    /dual[_-]write/iu,
    /backfill/iu,
    /customer_id/iu,
    /contact_id/iu,
  ]) {
    assert.doesNotMatch(schema, forbidden);
    assert.doesNotMatch(migration, forbidden);
  }
  assert.match(migration, /DROP TABLE "contacts"\."contacts"/u);
  assert.match(migration, /DROP TABLE "contacts"\."customers"/u);
  assert.match(packageJson, /"@app\/party-registry": "workspace:\*"/u);
});

test('validates Party and Counterparty references through injected public operations', async () => {
  const calls: string[] = [];
  const operations = {
    readCounterparty: (ref: CounterpartyRef) => {
      calls.push(`counterparty:${ref.resourceId}`);
      return Effect.succeed({
        counterpartyRef: ref,
        partyRef: organizationPartyRef,
        roleTypes: ['CUSTOMER'] as const,
      });
    },
    readParty: (ref: PartyRef) => {
      calls.push(`party:${ref.resourceId}`);
      return Effect.succeed({
        archived: false,
        partyRef: ref,
        partyType: 'ORGANIZATION' as const,
        requestedPartyRef: ref,
      });
    },
  };

  await Effect.runPromise(
    validatePartyRegistryReferences(
      operations,
      {
        counterpartyRef,
        partyRef: organizationPartyRef,
      },
      { expectedPartyType: 'ORGANIZATION' },
    ),
  );
  assert.deepEqual(calls.toSorted(), [
    `counterparty:${counterpartyRef.resourceId}`,
    `party:${organizationPartyRef.resourceId}`,
  ]);

  const mismatch = await Effect.runPromise(
    Effect.flip(
      validatePartyRegistryReferences(
        operations,
        {
          counterpartyRef,
          partyRef: personPartyRef,
        },
        { expectedPartyType: 'PERSON' },
      ),
    ),
  );
  assert.equal(mismatch._tag, 'EngagementProfileConflict');

  const wrongType = await Effect.runPromise(
    Effect.flip(
      validatePartyRegistryReferences(
        operations,
        { counterpartyRef, partyRef: organizationPartyRef },
        { expectedPartyType: 'PERSON' },
      ),
    ),
  );
  assert.equal(wrongType.code, 'contacts_party_type_mismatch');

  const missingCustomerRole = await Effect.runPromise(
    Effect.flip(
      validatePartyRegistryReferences(
        {
          ...operations,
          readCounterparty: (ref) =>
            Effect.succeed({
              counterpartyRef: ref,
              partyRef: organizationPartyRef,
              roleTypes: ['SUPPLIER'] as const,
            }),
        },
        { counterpartyRef, partyRef: organizationPartyRef },
        { expectedPartyType: 'ORGANIZATION' },
      ),
    ),
  );
  assert.equal(missingCustomerRole.code, 'contacts_counterparty_customer_role_required');

  const crossTenantCounterparty = {
    ...counterpartyRef,
    tenantId: 'c1000000-0000-4000-8000-000000000099',
  } as const;
  const crossTenant = await Effect.runPromise(
    Effect.flip(
      validatePartyRegistryReferences(
        operations,
        { counterpartyRef: crossTenantCounterparty, partyRef: organizationPartyRef },
        { expectedPartyType: 'ORGANIZATION' },
      ),
    ),
  );
  assert.equal(crossTenant.code, 'contacts_party_counterparty_mismatch');

  const aliasPartyRef = {
    ...organizationPartyRef,
    resourceId: 'c2000000-0000-4000-8000-000000000099',
  } as const;
  const aliasFailure = await Effect.runPromise(
    Effect.flip(
      validatePartyRegistryReferences(
        {
          ...operations,
          readParty: (ref) =>
            Effect.succeed({
              archived: false,
              partyRef: organizationPartyRef,
              partyType: 'ORGANIZATION' as const,
              requestedPartyRef: ref,
            }),
        },
        { counterpartyRef, partyRef: aliasPartyRef },
        { expectedPartyType: 'ORGANIZATION' },
      ),
    ),
  );
  assert.equal(aliasFailure.code, 'contacts_party_alias_requires_canonical_reference');
});

test('allows non-commercial profiles and PERSON or UNRESOLVED person engagement', async () => {
  let counterpartyReads = 0;
  await Promise.all(
    (['ORGANIZATION', 'PERSON', 'UNRESOLVED'] as const).map((partyType) =>
      Effect.runPromise(
        validatePartyRegistryReferences(
          {
            readCounterparty: (ref) => {
              counterpartyReads += 1;
              return Effect.succeed({
                counterpartyRef: ref,
                partyRef: organizationPartyRef,
                roleTypes: [],
              });
            },
            readParty: (ref) =>
              Effect.succeed({
                archived: false,
                partyRef: ref,
                partyType,
                requestedPartyRef: ref,
              }),
          },
          { partyRef: organizationPartyRef },
          { expectedPartyType: partyType === 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSON' },
        ),
      ),
    ),
  );
  assert.equal(counterpartyReads, 0);
});

test('rejects an archived Party for new engagement without changing existing profiles', async () => {
  const failure = await Effect.runPromise(
    Effect.flip(
      validatePartyRegistryReferences(
        {
          readCounterparty: (ref) =>
            Effect.succeed({
              counterpartyRef: ref,
              partyRef: organizationPartyRef,
              roleTypes: ['CUSTOMER'] as const,
            }),
          readParty: (ref) =>
            Effect.succeed({
              archived: true,
              partyRef: ref,
              partyType: 'ORGANIZATION' as const,
              requestedPartyRef: ref,
            }),
        },
        { partyRef: organizationPartyRef },
        { expectedPartyType: 'ORGANIZATION' },
      ),
    ),
  );
  assert.equal(failure.code, 'contacts_party_archived');
});

test('mints fresh Party assertions without reusing the Contacts bearer', async () => {
  const issuedAudiences: string[] = [];
  const issuedCookies: (string | undefined)[] = [];
  const receivedAuthorizations: string[] = [];
  const receivedCorrelationIds: string[] = [];
  const issuedBaseUrls: string[] = [];
  const receivedBaseUrls: string[] = [];
  const operations = makePartyRegistryReferenceOperations(
    {
      cookie: 'shell-session=opaque',
      correlationId: 'correlation-123',
      gatewayBaseUrl: new URL('https://shell.example/shell-super-app-api'),
      partyRegistryBaseUrl: new URL('https://party.example/party-registry-api'),
    },
    {
      executeCounterpartyRead: (ref, authorization, correlationId, baseUrl) => {
        receivedBaseUrls.push(baseUrl.href);
        receivedAuthorizations.push(authorization);
        receivedCorrelationIds.push(correlationId);
        return Effect.succeed({
          counterpartyRef: ref,
          partyRef: organizationPartyRef,
          roleTypes: ['CUSTOMER'] as const,
        });
      },
      executePartyRead: (ref, authorization, correlationId, baseUrl) => {
        receivedBaseUrls.push(baseUrl.href);
        receivedAuthorizations.push(authorization);
        receivedCorrelationIds.push(correlationId);
        return Effect.succeed({
          archived: false,
          partyRef: ref,
          partyType: 'ORGANIZATION' as const,
          requestedPartyRef: ref,
        });
      },
      issuePartyContext: (payload, options) => {
        issuedAudiences.push(payload.audience);
        issuedCookies.push(options.cookie);
        issuedBaseUrls.push(options.baseUrl.href);
        return Effect.succeed({ token: `fresh-party-token-${issuedAudiences.length}` });
      },
    },
  );

  await Effect.runPromise(
    validatePartyRegistryReferences(
      operations,
      { counterpartyRef, partyRef: organizationPartyRef },
      { expectedPartyType: 'ORGANIZATION' },
    ),
  );

  assert.deepEqual(issuedAudiences, ['party-registry', 'party-registry']);
  assert.deepEqual(issuedCookies, ['shell-session=opaque', 'shell-session=opaque']);
  assert.deepEqual(receivedAuthorizations.toSorted(), [
    'Bearer fresh-party-token-1',
    'Bearer fresh-party-token-2',
  ]);
  assert.deepEqual(receivedCorrelationIds, ['correlation-123', 'correlation-123']);
  assert.equal(receivedAuthorizations.includes('Bearer contacts-token'), false);
  assert.deepEqual(issuedBaseUrls, [
    'https://shell.example/shell-super-app-api',
    'https://shell.example/shell-super-app-api',
  ]);
  assert.deepEqual(receivedBaseUrls, [
    'https://party.example/party-registry-api',
    'https://party.example/party-registry-api',
  ]);
});

test('builds the production validator from public Party Registry operations', async () => {
  const [gateway, api] = await Promise.all([
    readFile(
      new URL(
        '../../src/integrations/party-registry/reference-validation.gateway.ts',
        import.meta.url,
      ),
      'utf-8',
    ),
    readFile(new URL('../../api/index.ts', import.meta.url), 'utf-8'),
  ]);

  assert.match(gateway, /from '@app\/party-registry\/api\/client'/u);
  assert.match(gateway, /issuePartyContext\(\s*\{ audience: 'party-registry' \}/u);
  assert.match(gateway, /executePartyDetailWithAuthorization/u);
  assert.match(gateway, /executeCounterpartyReadWithAuthorization/u);
  assert.match(
    api,
    /Effect\.provideService\(\s*PartyRegistryReferenceRequest,\s*referenceValidationForRequest\(request\.headers\)/u,
  );
  assert.doesNotMatch(api, /yield\* precondition|validateAttachReferences/u);
  assert.match(gateway, /Config\.url\('ONTOS_SHELL_GATEWAY_BASE_URL'\)/u);
  assert.match(gateway, /Config\.url\('ONTOS_PARTY_REGISTRY_API_BASE_URL'\)/u);
  assert.doesNotMatch(gateway, /party-registry\/(?:src|api\/index|vertical\.registration)/u);
  assert.doesNotMatch(gateway, /requestHeaders\[['"]authorization['"]\]/u);
});

test('uses absolute independent Shell and Party hosts through the production typed clients', async (context) => {
  const requestedUrls: string[] = [];
  const timestamp = '2026-09-03T08:00:00.000Z';
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requestedUrls.push(request.url);
    const url = new URL(request.url);
    if (url.hostname === 'shell.example') {
      assert.equal(request.headers.get('cookie'), 'shell-session=opaque');
      assert.deepEqual(await request.json(), { audience: 'party-registry' });
      return Response.json({ expiresAt: 2_000_000_000, token: 'fresh-party-bearer' });
    }
    assert.equal(url.hostname, 'party.example');
    assert.equal(request.headers.get('authorization'), 'Bearer fresh-party-bearer');
    assert.equal(request.headers.get('cookie'), null);
    assert.equal(request.headers.get('x-correlation-id'), 'independent-hosts');
    if (url.pathname === '/party-registry-api/reads/party-detail') {
      return Response.json({
        currentFactAssertions: [],
        factHistory: null,
        party: {
          archivedAt: null,
          createdAt: timestamp,
          displayName: 'Example',
          partyRef: organizationPartyRef,
          partyType: 'ORGANIZATION',
          revision: 1,
          updatedAt: timestamp,
        },
        resolution: {
          aliasChain: [],
          canonicalPartyRef: organizationPartyRef,
          kind: 'DIRECT',
          requestedPartyRef: organizationPartyRef,
        },
      } satisfies Effect.Success<ReturnType<typeof executePartyDetailWithAuthorization>>);
    }
    assert.equal(url.pathname, '/party-registry-api/reads/counterparty-read');
    return Response.json({
      counterpartyRef,
      createdAt: timestamp,
      currentRoles: [
        {
          provenance: { evidenceReference: 'test-evidence', method: 'manual', source: 'test' },
          recordedAt: timestamp,
          rolePeriodRef: {
            moduleId: 'party.registry',
            resourceId: 'c6000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.counterparty-role-period',
            tenantId,
          },
          roleType: 'CUSTOMER',
          state: 'ACTIVE',
          validFrom: timestamp,
          validTo: null,
        },
      ],
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: 'c7000000-0000-4000-8000-000000000001',
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
      party: {
        archived: false,
        canonicalPartyRef: organizationPartyRef,
        displayName: 'Example',
        partyType: 'ORGANIZATION',
        storedPartyRef: organizationPartyRef,
      },
    });
  };
  context.mock.method(globalThis, 'fetch', transport);
  const operations = makePartyRegistryReferenceOperations({
    cookie: 'shell-session=opaque',
    correlationId: 'independent-hosts',
    gatewayBaseUrl: new URL('https://shell.example/shell-super-app-api'),
    partyRegistryBaseUrl: new URL('https://party.example/party-registry-api'),
  });
  await Effect.runPromise(
    validatePartyRegistryReferences(
      operations,
      { counterpartyRef, partyRef: organizationPartyRef },
      { expectedPartyType: 'ORGANIZATION' },
    ),
  );
  assert.deepEqual(requestedUrls, [
    'https://shell.example/shell-super-app-api/auth/gateway-context',
    'https://party.example/party-registry-api/reads/party-detail',
    'https://shell.example/shell-super-app-api/auth/gateway-context',
    'https://party.example/party-registry-api/reads/counterparty-read',
  ]);
});

test('registers only legal-entity-scoped engagement profile mutations', () => {
  const actions = [
    archiveOrganizationEngagementAction,
    archivePersonEngagementAction,
    attachOrganizationEngagementAction,
    attachPersonEngagementAction,
    unarchiveOrganizationEngagementAction,
    unarchivePersonEngagementAction,
  ] as const;
  assert.deepEqual(actions.map((action) => action.descriptor.actionKey).toSorted(), [
    'contacts.core.archive-organization-engagement',
    'contacts.core.archive-person-engagement',
    'contacts.core.attach-organization-engagement',
    'contacts.core.attach-person-engagement',
    'contacts.core.unarchive-organization-engagement',
    'contacts.core.unarchive-person-engagement',
  ]);
  for (const action of actions) {
    assert.equal(action.descriptor.legalEntityScope, 'required');
    assert.equal(action.descriptor.idempotency, 'required');
    assert.equal(action.descriptor.owningModuleKey, 'contacts.core');
  }

  const decoded = Schema.decodeUnknownSync(
    attachOrganizationEngagementAction.descriptor.payloadSchema,
    { onExcessProperty: 'error' },
  )({ counterpartyRef, partyRef: organizationPartyRef });
  assert.deepEqual(decoded, { counterpartyRef, partyRef: organizationPartyRef });
  assert.throws(() =>
    Schema.decodeUnknownSync(attachOrganizationEngagementAction.descriptor.payloadSchema, {
      onExcessProperty: 'error',
    })({
      counterpartyRef,
      customerId: 'c9000000-0000-4000-8000-000000000001',
      name: 'Legacy identity field',
      partyRef: organizationPartyRef,
    }),
  );
});
