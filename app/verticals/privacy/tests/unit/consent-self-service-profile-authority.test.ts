import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Layer, Redacted, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ConsentDecisionSchema } from '../../shared/domain/privacy-consent-decision.ts';
import {
  ConsentSelfServiceRequestSchema,
  resolveAndAuthorizeConsentSelfService,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type { ConsentSelfServiceRequest } from '../../shared/domain/privacy-consent-self-service.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import type { PrivacySubjectRecord } from '../../shared/domain/privacy-subject.ts';
import {
  CommerceCustomerContextConsentWithdrawalService,
  CommerceCustomerContextConsentWithdrawalServiceLive,
} from '../../src/integrations/commerce-customer-context/commerce-customer-context-consent-withdrawal.service.ts';
import {
  PrivacySubjectPartyCredentials,
  PrivacySubjectPartyOwnerLive,
} from '../../src/persistence/privacy-subject-party-owner.ts';

const now = '2026-10-20T12:00:00.000Z';
const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '10000000-0000-4000-8000-000000000002';
const legalEntityId = '10000000-0000-4000-8000-000000000003';
const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000004',
    authContextRef: 'staff:profile-consent-test',
    authenticationNamespaceId: 'staff',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'profile-consent-unit',
};
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
};
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'profile:original',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
};
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
};
const bindingRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'binding:original',
  resourceType: 'commerce.customer-context.retail-portal-profile-binding',
  tenantId,
};
const subject = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
  createdAt: now,
  subject: { kind: 'DATA_SUBJECT', partyRef },
  subjectRef: {
    moduleId: 'privacy.core',
    resourceId: 'subject:original',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  updatedAt: now,
});
const grant = Schema.decodeUnknownSync(ConsentDecisionSchema)({
  actorEvidence: null,
  decision: 'GRANTED',
  decisionId: 'grant:original',
  effectiveAt: now,
  flowEvidenceRefs: ['flow:original'],
  noticeEvidenceRefs: ['notice:original'],
  provenanceRefs: ['provenance:original'],
  recordedAt: now,
  scope: {
    controllerRef: 'controller:original',
    materialDimensions: [],
    privacySubjectRef: subject.subjectRef,
    processingPurposeRef: {
      moduleId: 'privacy.core',
      resourceId: 'purpose:original',
      resourceType: 'privacy.core.processing-purpose',
      tenantId,
    },
    purposeMeaning: 'Original retained purpose',
    purposeVersionRef: '30000000-0000-4000-8000-000000000001',
    scopeRef: 'scope:original',
  },
});
const request = Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
  decision: 'WITHDRAWN',
  noticeEvidenceRefs: ['notice:original'],
  path: {
    kind: 'CURRENT_PROFILE_BINDING',
    operation: 'CONSENT_WITHDRAW',
    operationRef: 'operation:withdraw',
    profileRef: profileRef.resourceId,
    requestRef: 'request:withdraw',
    scopeRef: grant.scope.scopeRef,
    subjectRef: subject.subjectRef,
  },
  scope: grant.scope,
});
const freshness = (sourceModuleId: string, revision?: string) => {
  const fact = { observedAt: now, sourceModuleId, status: 'CURRENT' };
  if (revision === undefined) {
    return fact;
  }
  return { ...fact, revision };
};
const profile = {
  _tag: 'PROFILE_AVAILABLE',
  completeness: 'PARTIAL',
  profile: {
    createdAt: now,
    kind: 'RETAIL',
    profileRef,
    revision: 3,
    state: 'ACTIVE',
    stateChangedAt: now,
    subject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
    updatedAt: now,
  },
  provenance: [
    { freshness: freshness('commerce.customer-context', '3'), projection: 'PROFILE' },
    { freshness: { ...freshness('party.registry'), status: 'UNAVAILABLE' }, projection: 'PARTY_REGISTRY' },
  ],
  unavailableSections: ['PARTY_IDENTITY', 'AUTHORIZATION', 'COMMERCE_SETTINGS'],
};
const binding = {
  _tag: 'BINDING_AVAILABLE',
  authorizationFreshness: freshness('commerce.customer-context', 'mutation:original'),
  binding: {
    authorizationOperation: 'grant',
    authorizationState: 'ACTIVE',
    bindingRef,
    createdAt: now,
    enrollmentAuthorityGroup: 'RETAIL_PORTAL_SELF_SERVICE',
    enrollmentEvidenceRef: 'enrollment:original',
    lastTransitionReason: 'Verified original owner binding',
    principalRef: {
      moduleId: 'core.identity',
      resourceId: principalId,
      resourceType: 'core.identity.principal',
      tenantId,
    },
    profileRef,
    revision: 2,
    sellingLegalEntityRef,
    state: 'ACTIVE',
    updatedAt: now,
  },
  completeness: 'FULL',
  grantedPermissions: ['retail.profile.read', 'retail.consent.manage'],
  permissionsFreshness: freshness('core.identity'),
  provenance: [{ freshness: freshness('commerce.customer-context', '2'), projection: 'PROFILE' }],
};
const access = {
  authorizationFreshness: freshness('commerce.customer-context', 'mutation:original'),
  bindingRef,
  bindingState: 'ACTIVE',
  decision: { allowed: true, outcome: 'ALLOWED' },
  evaluatedAt: now,
  profileRef,
  provenance: [
    { freshness: freshness('commerce.customer-context', '2'), projection: 'PROFILE' },
    { freshness: freshness('commerce.customer-context', 'mutation:original'), projection: 'RETAIL_BINDING' },
    { freshness: freshness('core.identity'), projection: 'OWNING_CAPABILITY' },
  ],
  requiredPermission: 'retail.consent.manage',
};
const resolution = {
  _tag: 'RETAIL_PRINCIPAL_BOUND',
  bindingRef,
  profileRef,
  provenance: [{ freshness: freshness('commerce.customer-context', '2'), projection: 'PROFILE' }],
};
const party = {
  currentFactAssertions: [
    {
      assertionId: '40000000-0000-4000-8000-000000000001',
      factKind: 'PARTY_TYPE',
      isCurrent: true,
      partyRef,
      recordedAt: '1960-01-01T00:00:00Z',
      retractsAssertionId: null,
      state: 'ACTIVE',
      supersedesAssertionId: null,
      validFrom: '1960-01-01T00:00:00Z',
      validTo: null,
      value: 'PERSON',
    },
  ],
  factHistory: null,
  party: {
    archivedAt: null,
    createdAt: '1960-01-01T00:00:00Z',
    displayName: null,
    partyRef,
    partyType: 'PERSON',
    revision: 4,
    updatedAt: '1960-01-01T00:00:00Z',
  },
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
};
interface Scenario {
  readonly access?: unknown;
  readonly binding?: unknown;
  readonly onRequest?: (path: string, attempt: number) => typeof profile | typeof binding | typeof access | undefined;
  readonly party?: unknown;
  readonly profile?: unknown;
  readonly request?: ConsentSelfServiceRequest;
  readonly resolution?: unknown;
  readonly scope?: OperationalScope;
  readonly subjects?: readonly PrivacySubjectRecord[];
}
const run = (scenario: Scenario = {}) =>
  Effect.gen(function* runAuthorityScenario() {
    const calls: string[] = [];
    const attempts = new Map<string, number>();
    const issued: OperationalScope[] = [];
    let cccCredentials = 0;
    let partyCredentials = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
      const wire = new Request(input, init);
      const path = new URL(wire.url).pathname;
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      calls.push(path);
      expect(wire.headers.get('x-ontos-composition-revision')).toBe('a'.repeat(64));
      const responses = new Map<string, unknown>([
        ['customer-profile-read', scenario.profile ?? profile],
        ['retail-principal-resolution', scenario.resolution ?? resolution],
        ['retail-portal-profile-binding-read', scenario.binding ?? binding],
        ['retail-access-decision', scenario.access ?? access],
      ]);
      const defaultBody = responses.get(path.split('/').at(-1) ?? '') ?? scenario.party ?? party;
      const body = scenario.onRequest?.(path, attempt) ?? defaultBody;
      expect(wire.headers.get('authorization')).toBe(
        path.endsWith('party-detail') ? `Bearer party-${partyCredentials}` : `Bearer ccc-${cccCredentials}`,
      );
      return Promise.resolve(Response.json(body));
    };
    const partyCredentialsLayer = Layer.succeed(PrivacySubjectPartyCredentials, {
      acquire: (actualScope) =>
        Effect.sync(() => {
          issued.push(actualScope);
          partyCredentials += 1;
          return {
            authorization: Redacted.make(`Bearer party-${partyCredentials}`),
            baseUrl: 'https://party.example.test',
            compositionRevision: 'a'.repeat(64),
          };
        }),
    });
    const acquire = (actualScope: OperationalScope) =>
      Effect.sync(() => {
        issued.push(actualScope);
        cccCredentials += 1;
        return {
          authorization: Redacted.make(`Bearer ccc-${cccCredentials}`),
          baseUrl: 'https://commerce.example.test',
          compositionRevision: 'a'.repeat(64),
        };
      });
    const selectedScope = scenario.scope ?? scope;
    const selectedRequest = scenario.request ?? request;
    const result = yield* Effect.gen(function* useProfileService() {
      const service = yield* CommerceCustomerContextConsentWithdrawalService;
      const ports = service.forScope({
        scope: selectedScope,
        subjects: {
          listSubjects: () => Effect.succeed(scenario.subjects ?? [subject]),
          readCurrentConsent: () => Effect.succeed({ decision: grant, outcome: 'CURRENT' }),
        },
      });
      return yield* resolveAndAuthorizeConsentSelfService({
        now,
        ports,
        principalRef: { principalId: selectedScope.principalId, tenantId: selectedScope.tenantId },
        request: selectedRequest,
      }).pipe(Effect.result);
    }).pipe(
      Effect.provide(
        CommerceCustomerContextConsentWithdrawalServiceLive(acquire).pipe(
          Layer.provide(PrivacySubjectPartyOwnerLive.pipe(Layer.provide(partyCredentialsLayer))),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    return { calls, cccCredentials, issued, partyCredentials, result };
  });

it.effect(
  'uses actual PARTIAL PROFILE section and separate Current owner proofs with fresh caller-preserving attempts',
  () =>
    Effect.gen(function* positiveAuthority() {
      const proof = yield* run();
      expect(Result.isSuccess(proof.result)).toBe(true);
      if (Result.isSuccess(proof.result)) {
        expect(proof.result.success).toMatchObject({ allowed: true, authority: 'RETAIL_PROFILE_CONSENT' });
      }
      expect(proof.cccCredentials).toBe(8);
      expect(proof.partyCredentials).toBe(2);
      expect(proof.issued).toEqual(Array.from({ length: 10 }, () => scope));
      expect(proof.calls.at(-1)).toContain('retail-access-decision');
    }),
);

it.effect(
  'fails closed for foreign scope, missing Subject, incomplete decisive sections and missing Consent permission',
  () =>
    Effect.gen(function* negativeAuthority() {
      const changedController = yield* Schema.decodeUnknownEffect(ConsentSelfServiceRequestSchema)({
        ...request,
        scope: { ...request.scope, controllerRef: 'controller:foreign' },
      });
      const changedVersion = yield* Schema.decodeUnknownEffect(ConsentSelfServiceRequestSchema)({
        ...request,
        scope: { ...request.scope, purposeVersionRef: '30000000-0000-4000-8000-000000000099' },
      });
      const cases: readonly Scenario[] = [
        { request: changedController },
        { request: changedVersion },
        { subjects: [] },
        { subjects: [subject, subject] },
        { scope: { ...scope, principalId: '10000000-0000-4000-8000-000000000099' } },
        { scope: { ...scope, legalEntityId: '10000000-0000-4000-8000-000000000099' } },
        { profile: { ...profile, unavailableSections: [...profile.unavailableSections, 'PROFILE'] } },
        { profile: { ...profile, provenance: [] } },
        {
          profile: {
            _tag: 'PROFILE_RECONCILIATION_REQUIRED',
            profileRef: { ...profileRef, kind: 'RETAIL' },
            provenance: profile.provenance,
            reconciliationCaseRef: null,
            targetSubject: profile.profile.subject,
          },
        },
        {
          profile: {
            ...profile,
            profile: {
              ...profile.profile,
              subject: { ...profile.profile.subject, partyRef: { ...partyRef, resourceId: 'foreign' } },
            },
          },
        },
        { resolution: { _tag: 'RETAIL_PRINCIPAL_NOT_BOUND', profileRef, provenance: [] } },
        {
          binding: {
            ...binding,
            completeness: 'PARTIAL',
            permissionsFreshness: { ...binding.permissionsFreshness, status: 'UNAVAILABLE' },
          },
        },
        {
          binding: {
            ...binding,
            authorizationFreshness: { ...binding.authorizationFreshness, status: 'INDETERMINATE' },
            binding: { ...binding.binding, authorizationState: 'PENDING_GRANT' },
          },
        },
        { binding: { ...binding, grantedPermissions: ['retail.profile.read'] } },
        {
          binding: {
            ...binding,
            binding: {
              ...binding.binding,
              authorizationOperation: 'revoke',
              authorizationState: 'REVOKED',
              revokedAt: now,
              state: 'REVOKED',
            },
          },
        },
        {
          binding: {
            ...binding,
            completeness: 'PARTIAL',
            permissionsFreshness: { ...binding.permissionsFreshness, status: 'STALE' },
          },
        },
        { access: { ...access, decision: { allowed: false, outcome: 'PERMISSION_DENIED' } } },
        {
          access: {
            ...access,
            provenance: access.provenance.filter((item) => item.projection !== 'OWNING_CAPABILITY'),
          },
        },
        { access: { ...access, provenance: access.provenance.filter((item) => item.projection !== 'RETAIL_BINDING') } },
        { resolution: { ...resolution, provenance: [] } },
        { party: { ...party, party: { ...party.party, partyType: 'ORGANIZATION' } } },
      ];
      for (const scenario of cases) {
        const proof = yield* run(scenario);
        expect(Result.isFailure(proof.result)).toBe(true);
      }
    }),
);

it.effect(
  'rejects changed material authority before the final fresh permission check without inventing graph revisions',
  () =>
    Effect.gen(function* changedAuthority() {
      for (const onRequest of [
        (path: string, attempt: number) =>
          path.endsWith('customer-profile-read') && attempt === 2
            ? {
                ...profile,
                profile: { ...profile.profile, revision: 4 },
                provenance: [{ freshness: freshness('commerce.customer-context', '4'), projection: 'PROFILE' }],
              }
            : undefined,
        (path: string, attempt: number) =>
          path.endsWith('retail-portal-profile-binding-read') && attempt === 2
            ? {
                ...binding,
                binding: { ...binding.binding, revision: 3 },
                provenance: [{ freshness: freshness('commerce.customer-context', '3'), projection: 'PROFILE' }],
              }
            : undefined,
        (path: string, attempt: number) =>
          path.endsWith('retail-access-decision') && attempt === 2
            ? { ...access, decision: { allowed: false, outcome: 'PERMISSION_DENIED' } }
            : undefined,
      ]) {
        const proof = yield* run({ onRequest });
        expect(Result.isFailure(proof.result)).toBe(true);
      }
    }),
);

it.effect('does not add an ACTIVE-only profile lifecycle rule to retained withdrawal authority', () =>
  Effect.gen(function* retainedProfileLifecycle() {
    const proof = yield* run({ profile: { ...profile, profile: { ...profile.profile, state: 'SUSPENDED' } } });
    expect(Result.isSuccess(proof.result)).toBe(true);
    if (Result.isSuccess(proof.result)) {
      expect(proof.result.success).toMatchObject({ allowed: true });
    }
  }),
);

it.effect('does not enable account-free credentials or unrelated operations through the profile adapter', () =>
  Effect.gen(function* unsupportedAuthority() {
    const operationScoped = yield* Schema.decodeUnknownEffect(ConsentSelfServiceRequestSchema)({
      ...request,
      path: { ...request.path, credentialRef: 'credential:unconfigured', kind: 'OPERATION_SCOPED' },
    });
    const write = yield* Schema.decodeUnknownEffect(ConsentSelfServiceRequestSchema)({
      ...request,
      decision: 'GRANTED',
      path: { ...request.path, operation: 'CONSENT_WRITE' },
    });
    for (const unsupported of [operationScoped, write]) {
      const proof = yield* run({ request: unsupported });
      expect(Result.isFailure(proof.result)).toBe(true);
      if (Result.isFailure(proof.result)) {
        expect(proof.result.failure).toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
      }
      expect(proof.calls).toEqual([]);
    }
  }),
);
