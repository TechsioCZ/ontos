import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import { IssueDsrDeliveryAccessPayloadSchema } from '../../shared/actions/issue-dsr-delivery-access.ts';
import {
  EvaluateProcessingEligibilityPayloadSchema,
  RecordProcessingInterventionPayloadSchema,
} from '../../shared/actions/privacy-operations.ts';
import {
  evaluatePrivacyEligibility,
  PrivacyProcessingInterventionSchema,
} from '../../shared/domain/privacy-processing-eligibility.ts';
import { processingInterventionAuthorityUnavailable } from '../../src/actions/processing-intervention-authority.ts';
import { dsrDeliveryAccessAuthorityUnavailable } from '../../src/actions/dsr-delivery-access-authority.ts';
import { privacyApplicabilityBusinessFactAuthorityUnavailable } from '../../src/actions/privacy-applicability-business-fact-authority-service.ts';

const scope = {
  controllerRef: 'controller:one',
  dataCategoryRefs: ['category:email'],
  operation: 'send-email',
  processingScopeRef: { scopeId: 'scope:one', scopeType: 'privacy.processing-scope' },
  purposeRef: 'purpose:one',
  purposeVersionId: 'purpose-version:one',
  recipientRefs: ['recipient:one'],
  subjectRef: {
    moduleId: 'privacy.core',
    resourceId: 'subject:one',
    resourceType: 'privacy.core.privacy-subject',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
} as const;
const currentness = {
  authoritative: true,
  observedAt: '2026-01-01T00:00:00Z',
  revision: 'revision:one',
  sourceRef: 'source:one',
};

describe('privacy trusted authority boundaries', () => {
  it('exposes only request identity at the three public write boundaries', () => {
    const intervention = Schema.decodeUnknownSync(RecordProcessingInterventionPayloadSchema)({
      request: { interventionRef: 'intervention:one', kind: 'OBJECTION', scope },
      status: 'ACTIVE',
    });
    const eligibility = Schema.decodeUnknownSync(EvaluateProcessingEligibilityPayloadSchema)({
      applicabilityScope: { facts: [], operation: 'forged', processingScopeRef: scope.processingScopeRef },
      evidenceId: 'evidence:one',
      intendedScope: scope,
    });
    const delivery = Schema.decodeUnknownSync(IssueDsrDeliveryAccessPayloadSchema)({
      access: { policyRef: 'forged' },
      requestRef: 'delivery-request:one',
    });

    expect(intervention).not.toHaveProperty('status');
    expect(eligibility).not.toHaveProperty('applicabilityScope');
    expect(delivery).not.toHaveProperty('access');
  });

  it.effect('defaults both new authorities to unavailable', () =>
    Effect.gen(function* failClosed() {
      const interventionFailure = yield* Effect.flip(
        processingInterventionAuthorityUnavailable.resolve(
          { interventionRef: 'intervention:one', kind: 'OBJECTION', scope },
          {
            actionInvocationId: 'action:one',
            asOf: '2026-01-01T00:00:00Z',
            legalEntityId: 'legal-entity:one',
            principalId: 'principal:one',
            tenantId: 'tenant:one',
          },
        ),
      );
      const deliveryFailure = yield* Effect.flip(
        dsrDeliveryAccessAuthorityUnavailable.resolve('delivery-request:one', {
          actionInvocationId: 'action:one',
          legalEntityId: 'legal-entity:one',
          principalId: 'principal:one',
          tenantId: 'tenant:one',
        }),
      );
      const applicabilityFailure = yield* Effect.flip(
        privacyApplicabilityBusinessFactAuthorityUnavailable.resolveEligibility({
          asOf: '2026-01-01T00:00:00Z',
          intendedScope: scope,
          legalEntityId: '00000000-0000-4000-8000-000000000002',
          tenantId: scope.subjectRef.tenantId,
        }),
      );
      expect(interventionFailure.reason).toContain('not configured');
      expect(deliveryFailure.reason).toContain('not configured');
      expect(applicabilityFailure.reason).toContain('not configured');
    }),
  );

  it('does not treat an unresolved current intervention as ALLOWED', () => {
    const outcome = evaluatePrivacyEligibility({
      applicability: null,
      applicabilityCurrentness: null,
      applicabilityScope: {
        facts: [],
        operation: scope.operation,
        processingScopeRef: scope.processingScopeRef,
      },
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: {
        basisRef: 'legal-basis:contract',
        basisVersion: 'v1',
        currentness,
        scope,
      },
      legalEntityId: 'legal-entity:one',
      objection: {
        currentness: { ...currentness, authoritative: false },
        objectionRef: 'objection:unresolved',
        scope,
        status: 'ABSENT',
      },
      restriction: null,
      tenantId: 'tenant:one',
    });

    expect(outcome.outcome).toBe('INDETERMINATE');
    expect(outcome.outcome).not.toBe('ALLOWED');
    expect(Schema.is(PrivacyProcessingInterventionSchema)({})).toBe(false);
  });

  it('rejects forged ABSENT or RESOLVED intervention state from another subject', () => {
    for (const status of ['ABSENT', 'RESOLVED'] as const) {
      const outcome = evaluatePrivacyEligibility({
        applicability: null,
        applicabilityCurrentness: null,
        applicabilityScope: { facts: [], operation: scope.operation, processingScopeRef: scope.processingScopeRef },
        asOf: '2026-01-02T00:00:00Z',
        consent: null,
        consentCurrentness: null,
        intendedScope: scope,
        legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
        legalEntityId: 'legal-entity:one',
        objection: {
          currentness,
          objectionRef: `objection:forged:${status}`,
          scope: {
            ...scope,
            subjectRef: { ...scope.subjectRef, resourceId: 'subject:other' },
          },
          status,
        },
        restriction: null,
        tenantId: 'tenant:one',
      });
      expect(outcome.outcome).toBe('INDETERMINATE');
      expect(outcome.reasonCodes).toContain('objection_objection_scope_mismatch');
    }
  });
});
