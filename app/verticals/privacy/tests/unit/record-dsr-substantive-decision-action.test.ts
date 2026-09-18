import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { RecordDsrSubstantiveDecisionPayloadSchema } from '../../shared/actions/privacy-operations.ts';
import {
  AuthoritativeDsrSubstantiveDecisionSchema,
  DsrSubstantiveDecisionAuthorityResultSchema,
} from '../../shared/domain/privacy-dsr.ts';
import type { DsrSubstantiveDecisionAuthorityResult } from '../../shared/domain/privacy-dsr.ts';
import {
  handleRecordDsrSubstantiveDecision,
  recordDsrSubstantiveDecisionAction,
} from '../../src/actions/record-dsr-substantive-decision.action.ts';
import type { RecordDsrSubstantiveDecisionServices } from '../../src/actions/record-dsr-substantive-decision.action.ts';
import { dsrSubstantiveDecisionAuthorityUnavailable } from '../../src/actions/privacy-dsr-substantive-decision-authority.ts';
import type { DsrSubstantiveDecisionAuthorityService } from '../../src/actions/privacy-dsr-substantive-decision-authority.ts';
import { PrivacyActionRejected } from '../../src/actions/privacy-operation-action-support.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const actionInvocationId = '40000000-0000-4000-8000-000000000004';
const scope = {
  authMethod: 'session' as const,
  correlationId: 'dsr-substantive-decision-action-test',
  legalEntityId,
  principalId,
  tenantId,
};

const request = Schema.decodeUnknownSync(RecordDsrSubstantiveDecisionPayloadSchema)({
  request: {
    caseRef: 'dsr:1',
    controllerRef: 'controller:acme',
    decisionRef: 'decision:1',
    exactScopeRefs: ['scope:1'],
    right: 'ACCESS',
  },
});

const authoritativeDecision = (
  decidedAt: string,
  overrides: Partial<typeof AuthoritativeDsrSubstantiveDecisionSchema.Type> = {},
) =>
  Schema.decodeUnknownSync(AuthoritativeDsrSubstantiveDecisionSchema)({
    authorityRef: 'dsr-policy-authority:1',
    caseRef: request.request.caseRef,
    controllerRef: request.request.controllerRef,
    decidedAt,
    decisionEvidenceRefs: ['decision-evidence:1'],
    decisionRef: request.request.decisionRef,
    exactScopeRefs: request.request.exactScopeRefs,
    outcome: 'GRANTED',
    ownerExecutionRequired: false,
    policyRef: 'policy:dsr:1',
    policyVersion: '2026-01',
    provenanceRef: 'provenance:dsr-policy:1',
    reasonRef: 'reason:dsr-policy:1',
    right: request.request.right,
    ...overrides,
  });

const contextFor = (authorityService: DsrSubstantiveDecisionAuthorityService) => {
  const collector = createActionCollector(
    recordDsrSubstantiveDecisionAction.descriptor.domainEvents,
    'privacy.core',
    recordDsrSubstantiveDecisionAction.descriptor.accessEvidencePolicy,
    recordDsrSubstantiveDecisionAction.descriptor.auditEvidenceSchema,
  );
  let recorded: DsrSubstantiveDecisionAuthorityResult | undefined;
  const services: RecordDsrSubstantiveDecisionServices = {
    authority: authorityService,
    recordDsrSubstantiveDecision: (_tenant, _legalEntity, _invocation, authority) =>
      Effect.sync(() => {
        recorded = authority;
        return authority.decision;
      }),
  };
  return {
    collector,
    context: {
      actionInvocationId,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services,
    },
    recorded: () => recorded,
  };
};

const trustedAuthority: DsrSubstantiveDecisionAuthorityService = {
  resolve: (resolvedRequest, authorityContext) =>
    Effect.succeed(
      Schema.decodeUnknownSync(DsrSubstantiveDecisionAuthorityResultSchema)({
        asOf: authorityContext.asOf,
        decision: authoritativeDecision(authorityContext.asOf, {
          caseRef: resolvedRequest.caseRef,
          controllerRef: resolvedRequest.controllerRef,
          decisionRef: resolvedRequest.decisionRef,
          exactScopeRefs: resolvedRequest.exactScopeRefs,
          right: resolvedRequest.right,
        }),
        legalEntityId,
        status: 'CURRENT',
        tenantId,
      }),
    ),
};

describe('DSR substantive decision authority boundary', () => {
  it('does not expose outcome, reason, evidence, policy, or provenance in the public request', () => {
    const decoded = Schema.decodeUnknownSync(RecordDsrSubstantiveDecisionPayloadSchema)({
      request: {
        ...request.request,
        authorityRef: 'forged-authority',
        decisionEvidenceRefs: ['forged-evidence'],
        outcome: 'DENIED',
        policyRef: 'forged-policy',
        policyVersion: 'forged-version',
        provenanceRef: 'forged-provenance',
        reasonRef: 'forged-reason',
      },
    });

    expect(decoded.request).toEqual(request.request);
  });

  it.effect('records only the exact current decision returned by the trusted authority', () =>
    Effect.gen(function* recordTrustedDecision() {
      const { context, recorded } = contextFor(trustedAuthority);
      const result = yield* handleRecordDsrSubstantiveDecision(request, context);

      expect(result.outcome).toBe('GRANTED');
      const recordedAuthority = recorded();
      expect(recordedAuthority).toBeDefined();
      if (recordedAuthority === undefined) {
        return;
      }
      expect(recordedAuthority.decision).toEqual(result);
    }),
  );

  it.effect('fails closed when the DSR substantive decision authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableAuthority() {
      const { context } = contextFor(dsrSubstantiveDecisionAuthorityUnavailable);
      const error = yield* Effect.flip(handleRecordDsrSubstantiveDecision(request, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it.effect('rejects a forged authority result outside the exact case and scope', () =>
    Effect.gen(function* rejectForgedDecision() {
      const forgedAuthority: DsrSubstantiveDecisionAuthorityService = {
        resolve: (_resolvedRequest, authorityContext) =>
          Effect.succeed(
            Schema.decodeUnknownSync(DsrSubstantiveDecisionAuthorityResultSchema)({
              asOf: authorityContext.asOf,
              decision: authoritativeDecision(authorityContext.asOf, {
                caseRef: 'dsr:other',
                exactScopeRefs: ['scope:other'],
              }),
              legalEntityId,
              status: 'CURRENT',
              tenantId,
            }),
          ),
      };
      const { context } = contextFor(forgedAuthority);
      const error = yield* Effect.flip(handleRecordDsrSubstantiveDecision(request, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('exact Case');
    }),
  );
});
