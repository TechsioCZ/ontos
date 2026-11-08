import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { authenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '@app/commerce-customer-context/portal-auth/contracts';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { noticePresentationRead } from '../../src/api/notice-presentation.read.ts';
import { CommerceCustomerContextNoticeSubjectAuthorityService } from '../../src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts';
import {
  makePrivacyNoticeInformationStep,
  PrivacyNoticeInformationStep,
} from '../../src/services/privacy-notice-acknowledgement-authority.service.ts';
import {
  makePrivacyNoticePresentationService,
  PrivacyNoticePresentationService,
} from '../../src/services/privacy-notice-presentation.service.ts';
import { PrivacySubjectOwnerEvidenceSchema, PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { PrivacyNoticeVersionSchema } from '../../shared/domain/privacy-notice-version.ts';
import { privacyRegistration } from '../../vertical.registration.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000004';
const compositionRevision = 'a'.repeat(64);
const now = DateTime.makeUnsafe('2026-10-20T12:00:00.000Z');
const identity = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000003',
  authContextRef: 'native-notice-session',
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  authMethod: 'session',
  legalEntityId,
  principalId: '10000000-0000-4000-8000-000000000002',
  tenantId,
});
const principal = trustVerifiedGatewayPrincipalContext(identity, compositionRevision);
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000007',
  resourceType: 'party.registry.party',
  tenantId,
};
const target = {
  businessInteractionRef: 'native-information-step',
  noticeVersionId: '10000000-0000-4000-8000-000000000005',
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: '10000000-0000-4000-8000-000000000006',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  retailProfileId: 'profile:exact-owner',
};
const subject = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
  createdAt: DateTime.formatIso(now),
  subject: { kind: 'DATA_SUBJECT', partyRef },
  subjectRef: target.privacySubjectRef,
  updatedAt: DateTime.formatIso(now),
});
const notice = Schema.decodeUnknownSync(PrivacyNoticeVersionSchema)({
  applicableScope: {
    facts: [
      { dimension: 'PRIVACY_SUBJECT', value: target.privacySubjectRef.resourceId },
      { dimension: 'CONTROLLER_SCOPE', value: 'controller:native' },
      { dimension: 'PROCESSING_PURPOSE', value: 'purpose:native' },
      { dimension: 'PROCESSING_PURPOSE_VERSION', value: '10000000-0000-4000-8000-000000000008' },
    ],
    operation: 'CONSENT_DECISION',
    processingScopeRef: { scopeId: 'scope:native', scopeType: 'privacy.processing-scope' },
  },
  contentIdentity: 'notice:native:v1',
  effectiveFrom: '2026-10-20T11:00:00.000Z',
  effectiveTo: null,
  evidenceArtifactRef: null,
  language: 'en',
  noticeRef: {
    moduleId: 'privacy.core',
    resourceId: 'notice:native',
    resourceType: 'privacy.core.privacy-notice-version',
    tenantId,
  },
  recordedAt: '2026-10-20T11:00:00.000Z',
  versionId: target.noticeVersionId,
  versionNumber: 1,
  wording: 'The exact current owner Notice.',
});
const namespaceLive = authenticationNamespaceRegistryLayer(
  Schema.decodeEffect(AuthenticationNamespaceRegistrationSchema)({
    allowedAudiences: ['privacy'],
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    provider: 'commerce-portal-better-auth',
    requiresOperationAdmission: false,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user'],
    trustedAttesterPrincipalIds: [],
  }).pipe(Effect.map((registration) => [registration])),
);

const nativeNotice = Effect.fn('PrivacyNotice.nativeWiringTest')(function* nativeNotice() {
  yield* TestClock.setTime(DateTime.toEpochMillis(now));
  const integrity = yield* makePrivacyNoticePresentationService({
    keyId: 'native-notice',
    signingKey: Redacted.make('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  });
  const harness = yield* makeReadTestHarness({
    access: 'allowed',
    compositionRevision,
    executeOwnerQuery: ({ params, scope, sql }) => {
      expect(params).toContain(scope.tenantId);
      expect(params).toContain(scope.legalEntityId);
      if (scope.tenantId !== tenantId || scope.legalEntityId !== legalEntityId) {
        return Effect.succeed([]);
      }
      if (sql.includes('privacy_subjects')) {
        return Effect.succeed([{ record: subject }]);
      }
      if (sql.includes('notice_versions')) {
        return Effect.succeed([{ record: notice }]);
      }
      return Effect.die(`Unexpected Notice owner SQL: ${sql}`);
    },
    operationTime: DateTime.toDateUtc(now),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: privacyRegistration,
    scope: { ...principal, correlationId: 'native-notice' },
  });
  let authorityCalls = 0;
  const partyEvidence = yield* Schema.decodeUnknownEffect(PrivacySubjectOwnerEvidenceSchema)({
    observedAt: DateTime.formatIso(now),
    ownerRevision: 1,
    partyRef,
    typeAssertions: [{ assertionId: 'native:person', validFrom: DateTime.formatIso(now), validTo: null }],
  });
  const subjectAuthority = CommerceCustomerContextNoticeSubjectAuthorityService.of({
    forScope: (input) => ({
      resolve: (requested) =>
        Effect.gen(function* currentOwnerAuthority() {
          expect(harness.snapshot().statements.at(-1)).toBe('COMMIT');
          expect(input.compositionRevision).toBe(compositionRevision);
          expect(input.scope).toMatchObject({ legalEntityId, principalId: identity.principalId, tenantId });
          expect(requested).toEqual({
            privacySubjectRef: subject.subjectRef,
            retailProfileId: target.retailProfileId,
          });
          expect(yield* input.subjects.listSubjects(tenantId, legalEntityId).pipe(Effect.orDie)).toEqual([subject]);
          authorityCalls += 1;
          return { evidenceRefs: ['native:current-owner-binding'], partyEvidence };
        }),
    }),
  });
  const informationStep = yield* makePrivacyNoticeInformationStep.pipe(
    Effect.provideService(PrivacyNoticePresentationService, {
      ...integrity,
      seal: (claims) =>
        Effect.suspend(() => {
          expect(harness.snapshot().statements.at(-1)).toBe('COMMIT');
          return integrity.seal(claims);
        }),
    }),
    Effect.provideService(CommerceCustomerContextNoticeSubjectAuthorityService, subjectAuthority),
  );
  const run = (requestPrincipal: typeof identity, input = target) =>
    harness.runtime
      .runRead({
        input,
        principal: requestPrincipal,
        registration: noticePresentationRead,
        transport: { correlationId: 'native-notice' },
      })
      .pipe(
        Effect.provideService(PrivacyNoticeInformationStep, informationStep),
        Effect.provideService(CommerceCustomerContextNoticeSubjectAuthorityService, subjectAuthority),
      );
  const result = yield* run(principal);
  expect(result.notice).toEqual(notice);
  const claims = yield* integrity.open(result.presentationReceipt);
  expect(claims).toMatchObject({
    actorPrincipalId: identity.principalId,
    businessInteractionRef: target.businessInteractionRef,
    legalEntityId,
    noticeVersionId: target.noticeVersionId,
    privacySubjectRef: subject.subjectRef,
    retailProfileId: target.retailProfileId,
    tenantId,
  });
  expect(authorityCalls).toBe(1);
  expect(harness.snapshot().ownerQueries).toHaveLength(2);
  const foreignTarget = yield* run(principal, {
    ...target,
    privacySubjectRef: { ...target.privacySubjectRef, tenantId: '10000000-0000-4000-8000-000000000099' },
  }).pipe(Effect.flip);
  expect(foreignTarget._tag).toBe('ReadPolicyDenied');
  const foreignCompany = yield* run(
    trustVerifiedGatewayPrincipalContext(
      {
        ...identity,
        legalEntityId: '10000000-0000-4000-8000-000000000098',
      },
      compositionRevision,
    ),
  ).pipe(Effect.flip);
  expect(foreignCompany._tag).toBe('ReadHandlerUnavailable');
  expect(authorityCalls).toBe(1);
});

it.layer(Layer.mergeAll(NodeCrypto.layer, namespaceLive))('native Notice production service wiring', (suite) => {
  suite.effect(
    'loads exact owner state before current subject authority and signs outside SQL without foreign-scope reuse',
    () => nativeNotice(),
  );
});
