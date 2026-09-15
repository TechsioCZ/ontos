/* jscpd:ignore-start -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority. */
import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '@app/core-runtime';

import { processingEligibilityPolicy } from '../../src/policies/processing-eligibility.policy.ts';
import {
  evaluatePrivacyEligibilityForConsumer,
  privacyEligibilityAllowsConsumerOperation,
} from '../../shared/domain/privacy-eligibility-consumer-contract.ts';
import type { PrivacyEligibilityConsumerRequest } from '../../shared/domain/privacy-eligibility-consumer-contract.ts';
import type { IntendedProcessingScope } from '../../shared/domain/privacy-processing-eligibility.ts';

const scope: IntendedProcessingScope = {
  controllerRef: 'controller:one',
  dataCategoryRefs: ['category:email'],
  operation: 'send-email',
  processingScopeRef: { scopeId: 'scope:one', scopeType: 'privacy.processing-scope' },
  purposeRef: 'purpose:transactional',
  purposeVersionId: 'purpose-version:one',
  recipientRefs: ['recipient:mail'],
};
const currentness = {
  authoritative: true,
  observedAt: '2026-01-01T00:00:00Z',
  revision: 'rev:one',
  sourceRef: 'source:one',
};
const applicabilityScope = {
  facts: [
    { dimension: 'CONTROLLER_SCOPE' as const, value: scope.controllerRef },
    ...scope.dataCategoryRefs.map((value) => ({ dimension: 'CATEGORY' as const, value })),
    { dimension: 'PROCESSING_PURPOSE' as const, value: scope.purposeRef },
    { dimension: 'PROCESSING_PURPOSE_VERSION' as const, value: scope.purposeVersionId },
  ],
  operation: scope.operation,
  processingScopeRef: scope.processingScopeRef,
};
const request: PrivacyEligibilityConsumerRequest = {
  boundary: 'before-send',
  consumerRef: 'consumer:mailer',
  operationRef: 'send-email',
  requestedScope: scope,
  subjectRef: 'subject:one',
  trustedAsOf: '2026-01-02T00:00:00Z',
};
const trusted = {
  requestedScope: scope,
  subjectRef: 'subject:one',
  trustedInputs: {
    applicability: {
      evaluatedAt: '2026-01-01T00:00:00Z',
      evaluatedScope: applicabilityScope,
      evidenceRefs: ['evidence:applicability'],
      outcome: 'APPLICABLE' as const,
      policyIdentities: [],
      proposedActivity: true,
      reasonCodes: ['explicit_policy_match'],
      responsibilityAssignmentRefs: [],
    },
    applicabilityCurrentness: currentness,
    applicabilityScope,
    asOf: request.trustedAsOf,
    consent: null,
    consentCurrentness: null,
    intendedScope: scope,
    legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
    objection: { currentness, objectionRef: 'objection:none', scope, status: 'ABSENT' as const },
    restriction: { currentness, restrictionRef: 'restriction:none', scope, status: 'ABSENT' as const },
  },
};
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authContextRef: 'job:privacy-eligibility-test:run:one',
  authMethod: 'system',
  principalId: '00000000-0000-4000-8000-000000000010',
  tenantId: '00000000-0000-4000-8000-000000000011',
});

describe('privacy eligibility consumer contract', () => {
  it.effect('returns only the exact decision and safe evidence, without executing a consumer operation', () =>
    Effect.gen(function* exactEligibilityDecision() {
      const response = yield* evaluatePrivacyEligibilityForConsumer(request, trusted);
      expect(response.decision.outcome).toBe('ALLOWED');
      expect(response.decision.evaluatedScope).toEqual(scope);
      expect(response.evidence.evaluatedScope).toEqual(scope);
      expect(privacyEligibilityAllowsConsumerOperation(response)).toBe(true);
      expect('personalData' in response.evidence).toBe(false);
    }),
  );

  it.effect('rejects a request whose scope or subject is not the trusted server-side resolution', () =>
    Effect.gen(function* rejectsUntrustedResolution() {
      const scopeFailure = yield* Effect.exit(
        evaluatePrivacyEligibilityForConsumer(
          { ...request, requestedScope: { ...scope, purposeRef: 'purpose:other' } },
          trusted,
        ),
      );
      const subjectFailure = yield* Effect.exit(
        evaluatePrivacyEligibilityForConsumer({ ...request, subjectRef: 'subject:other' }, trusted),
      );
      const operationFailure = yield* Effect.exit(
        evaluatePrivacyEligibilityForConsumer({ ...request, operationRef: 'delete' }, trusted),
      );
      expect(Exit.isFailure(scopeFailure)).toBe(true);
      expect(Exit.isFailure(subjectFailure)).toBe(true);
      expect(Exit.isFailure(operationFailure)).toBe(true);
    }),
  );

  it.effect('does not allow a response to cross a different operation boundary', () =>
    Effect.gen(function* rejectsDifferentConsumerOperation() {
      const response = yield* evaluatePrivacyEligibilityForConsumer(request, trusted);

      expect(privacyEligibilityAllowsConsumerOperation({ ...response, operationRef: 'delete' })).toBe(false);
    }),
  );

  it.effect('fails closed for indeterminate and denied decisions', () =>
    Effect.gen(function* failsClosed() {
      const response = yield* evaluatePrivacyEligibilityForConsumer(request, {
        ...trusted,
        trustedInputs: { ...trusted.trustedInputs, legalBasis: null },
      });
      expect(response.decision.outcome).toBe('INDETERMINATE');
      expect(privacyEligibilityAllowsConsumerOperation(response)).toBe(false);
      const policyExit = yield* Effect.exit(
        processingEligibilityPolicy.evaluate({
          action: { actionKey: 'privacy.consumer', owningModuleKey: 'privacy.core', schemaVersion: '1' },
          payload: response,
          principal,
          target: {},
          transport: { correlationId: 'test', traceId: 'test' },
        }),
      );
      expect(Exit.isFailure(policyExit)).toBe(true);
    }),
  );
});
/* jscpd:ignore-end */
