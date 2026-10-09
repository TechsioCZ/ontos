import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  ContactPointVerificationFactSchema,
  ContactPointVerificationRequirementSchema,
  MarketingConsentScopeError,
  createMarketingConsentScope,
  evaluateMarketingVerification,
  MarketingConsentScopeSchema,
  validateMarketingCommunicationTransition,
} from '../../shared/domain/privacy-marketing-consent.ts';

const tenantId = '00000000-0000-4000-8000-000000000000';
const baseScope = {
  controllerRef: 'controller:marketing',
  materialDimensions: [],
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: 'subject:one',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:marketing',
    resourceType: 'privacy.core.processing-purpose',
    tenantId,
  },
  purposeMeaning: 'Send product offers',
  purposeVersionRef: 'purpose-marketing-v1',
  scopeRef: 'scope:marketing',
} as const;

const requirement = Schema.decodeUnknownSync(ContactPointVerificationRequirementSchema)({
  channel: 'EMAIL',
  effectiveFrom: '2026-01-01T00:00:00Z',
  required: true,
  requirementRef: 'verification:email',
  requirementVersion: 'v1',
  sourceEvidenceRefs: ['policy:marketing'],
});

describe('Marketing Consent', () => {
  it.effect('keeps EMAIL and SMS as independent exact consent scopes', () =>
    Effect.gen(function* buildsExactMarketingScopes() {
      const email = yield* createMarketingConsentScope(baseScope, 'EMAIL');
      const sms = yield* createMarketingConsentScope(baseScope, 'SMS');
      expect(email.channel).toBe('EMAIL');
      expect(sms.channel).toBe('SMS');
      expect(email.consentScope.materialDimensions).not.toEqual(sms.consentScope.materialDimensions);
      expect(Schema.decodeUnknownSync(MarketingConsentScopeSchema)(email).channel).toBe('EMAIL');
    }),
  );

  it.effect('rejects a scope that already contains a channel instead of widening it', () =>
    Effect.gen(function* rejectsDuplicateMarketingChannel() {
      const error = yield* Effect.flip(
        createMarketingConsentScope(
          { ...baseScope, materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' }] },
          'SMS',
        ),
      );
      expect(error).toBeInstanceOf(MarketingConsentScopeError);
    }),
  );

  it('keeps verification separate from consent and identity evidence', () => {
    const unverified = Schema.decodeUnknownSync(ContactPointVerificationFactSchema)({
      channel: 'EMAIL',
      contactPointRef: 'contact:email:one',
      evidenceRefs: [],
      status: 'UNVERIFIED',
      verifiedAt: null,
    });
    expect(evaluateMarketingVerification({ channel: 'EMAIL', fact: unverified, requirement })).toMatchObject({
      outcome: 'BLOCKED',
    });
    expect(evaluateMarketingVerification({ channel: 'EMAIL', requirement })).toMatchObject({
      outcome: 'INDETERMINATE',
    });
  });

  it('allows only a current verified contact point for a required channel', () => {
    const fact = Schema.decodeUnknownSync(ContactPointVerificationFactSchema)({
      channel: 'EMAIL',
      contactPointRef: 'contact:email:one',
      evidenceRefs: ['contact-proof:one'],
      status: 'VERIFIED',
      verifiedAt: '2026-01-02T00:00:00Z',
    });
    expect(evaluateMarketingVerification({ channel: 'EMAIL', fact, requirement })).toMatchObject({
      outcome: 'ALLOWED',
    });
    expect(evaluateMarketingVerification({ channel: 'SMS', fact, requirement })).toMatchObject({
      outcome: 'INDETERMINATE',
    });
  });

  it('does not let subscription or preference replace an explicit consent transition', () => {
    expect(
      validateMarketingCommunicationTransition({
        consentDecisionId: null,
        preferenceChange: null,
        subscriptionChange: { action: 'SUBSCRIBE', programRef: 'program:one', subscriptionId: 'subscription:one' },
        transitionId: 'transition:one',
      }),
    ).toBeUndefined();
    expect(
      validateMarketingCommunicationTransition({
        consentDecisionId: null,
        preferenceChange: null,
        subscriptionChange: null,
        transitionId: 'transition:empty',
      }),
    ).toContain('explicit');
  });
});
