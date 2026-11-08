import type { OperationalScope } from '@app/core-runtime';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect } from 'effect-rstest';

import type { NoticePresentationRequest } from '../../shared/apis/notice-presentation.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { CommerceCustomerContextNoticeSubjectAuthorityServiceLive } from '../../src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts';
import {
  PrivacySubjectPartyCredentials,
  PrivacySubjectPartyOwnerLive,
} from '../../src/persistence/privacy-subject-party-owner.ts';

const customerContextModule = 'commerce.customer-context';
const bindingMutation = 'mutation:notice-unit';
const consentPermission = 'retail.consent.manage';

/**
 * Published HTTP response facts for the real CCC and Party adapters. Neither authority service is
 * substituted. This unit transport does not prove the remote owners or a native database.
 */
export const noticeSubjectOwnerFixture = (input: {
  readonly at: string;
  readonly compositionRevision: string;
  readonly scope: OperationalScope;
  readonly target: NoticePresentationRequest;
}) => {
  const { at, compositionRevision, scope, target } = input;
  const partyRef = {
    moduleId: 'party.registry',
    resourceId: '20000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party',
    tenantId: scope.tenantId,
  };
  const subject = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
    createdAt: at,
    subject: { kind: 'DATA_SUBJECT', partyRef },
    subjectRef: target.privacySubjectRef,
    updatedAt: at,
  });
  const profileRef = {
    moduleId: customerContextModule,
    resourceId: target.retailProfileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId: scope.tenantId,
  };
  const sellingLegalEntityRef = {
    moduleId: 'core.identity',
    resourceId: scope.legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId: scope.tenantId,
  };
  const bindingRef = {
    moduleId: customerContextModule,
    resourceId: 'binding:notice-unit',
    resourceType: 'commerce.customer-context.retail-portal-profile-binding',
    tenantId: scope.tenantId,
  };
  const freshness = (sourceModuleId: string, revision?: string) => {
    const value = { observedAt: at, sourceModuleId, status: 'CURRENT' };
    return revision === undefined ? value : { ...value, revision };
  };
  const responses = new Map<string, object>([
    [
      'customer-profile-read',
      {
        _tag: 'PROFILE_AVAILABLE',
        completeness: 'PARTIAL',
        profile: {
          createdAt: at,
          kind: 'RETAIL',
          profileRef,
          revision: 3,
          state: 'ACTIVE',
          stateChangedAt: at,
          subject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
          updatedAt: at,
        },
        provenance: [{ freshness: freshness(customerContextModule, '3'), projection: 'PROFILE' }],
        unavailableSections: ['PARTY_IDENTITY', 'AUTHORIZATION', 'COMMERCE_SETTINGS'],
      },
    ],
    [
      'retail-principal-resolution',
      {
        _tag: 'RETAIL_PRINCIPAL_BOUND',
        bindingRef,
        profileRef,
        provenance: [{ freshness: freshness(customerContextModule, '2'), projection: 'PROFILE' }],
      },
    ],
    [
      'retail-portal-profile-binding-read',
      {
        _tag: 'BINDING_AVAILABLE',
        authorizationFreshness: freshness(customerContextModule, bindingMutation),
        binding: {
          authorizationOperation: 'grant',
          authorizationState: 'ACTIVE',
          bindingRef,
          createdAt: at,
          enrollmentAuthorityGroup: 'RETAIL_PORTAL_SELF_SERVICE',
          enrollmentEvidenceRef: 'enrollment:notice-unit',
          lastTransitionReason: 'Original unit owner binding',
          principalRef: {
            moduleId: 'core.identity',
            resourceId: scope.principalId,
            resourceType: 'core.identity.principal',
            tenantId: scope.tenantId,
          },
          profileRef,
          revision: 2,
          sellingLegalEntityRef,
          state: 'ACTIVE',
          updatedAt: at,
        },
        completeness: 'FULL',
        grantedPermissions: ['retail.profile.read', consentPermission],
        permissionsFreshness: freshness(customerContextModule),
        provenance: [{ freshness: freshness(customerContextModule, '2'), projection: 'PROFILE' }],
      },
    ],
    [
      'retail-access-decision',
      {
        authorizationFreshness: freshness(customerContextModule, bindingMutation),
        bindingRef,
        bindingState: 'ACTIVE',
        decision: { allowed: true, outcome: 'ALLOWED' },
        evaluatedAt: at,
        profileRef,
        provenance: [
          { freshness: freshness(customerContextModule, '2'), projection: 'PROFILE' },
          { freshness: freshness(customerContextModule, bindingMutation), projection: 'RETAIL_BINDING' },
          { freshness: freshness(customerContextModule), projection: 'OWNING_CAPABILITY' },
        ],
        requiredPermission: consentPermission,
      },
    ],
    [
      'party-detail',
      {
        currentFactAssertions: [
          {
            assertionId: '40000000-0000-4000-8000-000000000001',
            factKind: 'PARTY_TYPE',
            isCurrent: true,
            partyRef,
            recordedAt: at,
            retractsAssertionId: null,
            state: 'ACTIVE',
            supersedesAssertionId: null,
            validFrom: at,
            validTo: '2026-10-20T12:00:30.000Z',
            value: 'PERSON',
          },
        ],
        party: {
          archivedAt: null,
          businessName: null,
          createdAt: at,
          displayName: null,
          firstName: null,
          lastName: null,
          partyRef,
          partyType: 'PERSON',
          revision: 4,
          updatedAt: at,
        },
        resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
      },
    ],
  ]);
  const expectedRequests = new Map<string, object>([
    ['party-detail', { partyRef }],
    [
      'customer-profile-read',
      {
        authorizationSubject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
        profileRef: { ...profileRef, kind: 'RETAIL' },
      },
    ],
    ['retail-principal-resolution', { profileRef }],
    ['retail-portal-profile-binding-read', { bindingRef, profileRef }],
    ['retail-access-decision', { profileRef, requiredPermission: consentPermission }],
  ]);
  const calls: string[] = [];
  const correlations: string[] = [];
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const wire = new Request(request, init);
    const url = new URL(wire.url);
    const path = url.pathname;
    // Observe attempted requests too: an unexpected URL/header must not look like zero remote work.
    calls.push(path);
    const correlation = wire.headers.get('x-correlation-id');
    if (correlation !== null) {
      correlations.push(correlation);
    }
    expect(url.origin).toBe('https://notice-owner.example.test');
    expect(wire.method).toBe('POST');
    expect(wire.headers.get('authorization')).toBe('Bearer notice-owner-unit-transport');
    expect(wire.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
    expect(correlation).not.toBeNull();
    const response = responses.get(path.split('/').at(-1) ?? '');
    if (response === undefined) {
      return Response.json({ reason: 'Unexpected Notice owner request' }, { status: 503 });
    }
    expect(await wire.json()).toEqual(expectedRequests.get(path.split('/').at(-1) ?? ''));
    return Response.json(response);
  };
  const credentials = {
    authorization: Redacted.make('Bearer notice-owner-unit-transport'),
    baseUrl: 'https://notice-owner.example.test',
    compositionRevision,
  };
  const originalLayer = CommerceCustomerContextNoticeSubjectAuthorityServiceLive(() =>
    Effect.succeed(credentials),
  ).pipe(
    Layer.provide(
      PrivacySubjectPartyOwnerLive.pipe(
        Layer.provide(Layer.succeed(PrivacySubjectPartyCredentials, { acquire: () => Effect.succeed(credentials) })),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { calls, correlations, layer: originalLayer, subject, transport: Layer.succeed(FetchHttpClient.Fetch, fetch) };
};
