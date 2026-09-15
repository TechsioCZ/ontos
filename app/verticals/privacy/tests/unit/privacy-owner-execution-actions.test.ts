import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  RecordAntiResurrectionProtectionPayloadSchema,
  RecordOwnerExecutionOutcomePayloadSchema,
} from '../../shared/actions/privacy-operations.ts';
import {
  AntiResurrectionEnforcementReceiptSchema,
  AntiResurrectionProtectionSchema,
} from '../../shared/domain/anti-resurrection.ts';
import {
  OwnerExecutionAuthorityResultSchema,
  PrivacyMeasureHandoffSchema,
} from '../../shared/domain/privacy-measure-handoff.ts';
import {
  handleRecordAntiResurrectionProtection,
  recordAntiResurrectionProtectionAction,
} from '../../src/actions/record-anti-resurrection-protection.action.ts';
import type { RecordAntiResurrectionProtectionServices } from '../../src/actions/record-anti-resurrection-protection.action.ts';
import {
  handleRecordOwnerExecutionOutcome,
  recordOwnerExecutionOutcomeAction,
} from '../../src/actions/record-owner-execution-outcome.action.ts';
import type { RecordOwnerExecutionOutcomeServices } from '../../src/actions/record-owner-execution-outcome.action.ts';
import { ownerExecutionAuthorityUnavailable } from '../../src/actions/privacy-owner-execution-authority.ts';
import type { OwnerExecutionAuthorityService } from '../../src/actions/privacy-owner-execution-authority.ts';
import { antiResurrectionEnforcementAuthorityUnavailable } from '../../src/actions/privacy-anti-resurrection-enforcement-authority.ts';
import type { AntiResurrectionEnforcementAuthorityService } from '../../src/actions/privacy-anti-resurrection-enforcement-authority.ts';
import { PrivacyActionRejected } from '../../src/actions/privacy-operation-action-support.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const actionInvocationId = '00000000-0000-4000-8000-000000000003';
const scope = {
  authMethod: 'session' as const,
  correlationId: 'privacy-owner-execution-action-test',
  legalEntityId,
  principalId: '00000000-0000-4000-8000-000000000004',
  tenantId,
};

const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  contentScopeRefs: ['email'],
  controllerObligationRef: 'obligation:1',
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['owner-proof:1'],
  idempotencyKey: 'measure:1',
  kind: 'DELETE',
  measureId: 'measure:1',
  owningCapability: 'accounts',
  preconditionRefs: ['no-hold:1'],
  requestedAt: '2026-09-14T10:00:00Z',
  requestedResult: 'deleted',
  resourceRefs: ['account:1'],
  right: 'ERASURE',
  sourceDecisionRef: 'decision:1',
  sourceDecisionRevision: 1,
  subjectRef: 'subject:1',
  taskId: 'task:1',
  tenantId,
});

const ownerRequest = Schema.decodeUnknownSync(RecordOwnerExecutionOutcomePayloadSchema)({
  request: { attempt: 1, measureId: handoff.measureId, taskId: handoff.taskId },
});
const antiResurrectionRequest = Schema.decodeUnknownSync(RecordAntiResurrectionProtectionPayloadSchema)({
  request: ownerRequest.request,
});
const authority = Schema.decodeUnknownSync(OwnerExecutionAuthorityResultSchema)({
  authorityRef: 'owner-authority:1',
  contentScopeRefs: handoff.contentScopeRefs,
  evidenceRefs: ['owner-proof:1'],
  outcome: {
    attempt: 1,
    evidenceRefs: ['owner-proof:1'],
    idempotencyKey: handoff.idempotencyKey,
    includedResourceRefs: handoff.resourceRefs,
    measureId: handoff.measureId,
    occurredAt: '2026-09-14T10:01:00Z',
    outcomeId: 'owner-outcome:1',
    owningCapability: handoff.owningCapability,
    reason: 'Deleted by the owning capability',
    recordedAt: '2026-09-14T10:02:00Z',
    remainingResourceRefs: [],
    sourceDecisionRef: handoff.sourceDecisionRef,
    sourceDecisionRevision: handoff.sourceDecisionRevision,
    status: 'SUCCEEDED',
    taskId: handoff.taskId,
  },
  receiptRef: 'owner-outcome:1',
  resourceRefs: handoff.resourceRefs,
  subjectRef: handoff.subjectRef,
  tenantId,
});
const enforcementReceipt = Schema.decodeUnknownSync(AntiResurrectionEnforcementReceiptSchema)({
  authorityRef: 'enforcement-authority:1',
  contentScopeRefs: handoff.contentScopeRefs,
  evidenceRefs: ['gate:import', 'gate:replay', 'gate:projection', 'gate:backup'],
  measure: handoff.kind,
  operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
  ownerModuleId: handoff.owningCapability,
  receiptRef: 'enforcement-receipt:1',
  resourceRefs: handoff.resourceRefs,
  subjectRef: handoff.subjectRef,
  taskId: handoff.taskId,
  tenantId,
});
const protection = Schema.decodeUnknownSync(AntiResurrectionProtectionSchema)({
  contentScopeRefs: handoff.contentScopeRefs,
  enforcementReceipt,
  evidenceRefs: ['owner-outcome:1', 'owner-proof:1'],
  measure: 'DELETE',
  outcomeStatus: 'SUCCEEDED',
  ownerExecutionOutcomeRef: authority.outcome.outcomeId,
  protectedAt: '2026-09-14T10:02:00Z',
  protectionId: 'protection:1',
  resourceRefs: handoff.resourceRefs,
  sourceDecisionRef: handoff.sourceDecisionRef,
  sourceDecisionRevision: handoff.sourceDecisionRevision,
  subjectRef: handoff.subjectRef,
  tenantId,
});

const ownerContext = (services: RecordOwnerExecutionOutcomeServices) => {
  const collector = createActionCollector(
    recordOwnerExecutionOutcomeAction.descriptor.domainEvents,
    'privacy.core',
    recordOwnerExecutionOutcomeAction.descriptor.accessEvidencePolicy,
    recordOwnerExecutionOutcomeAction.descriptor.auditEvidenceSchema,
  );
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
  };
};

const antiResurrectionContext = (services: RecordAntiResurrectionProtectionServices) => {
  const collector = createActionCollector(
    recordAntiResurrectionProtectionAction.descriptor.domainEvents,
    'privacy.core',
    recordAntiResurrectionProtectionAction.descriptor.accessEvidencePolicy,
    recordAntiResurrectionProtectionAction.descriptor.auditEvidenceSchema,
  );
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
  };
};

const trustedAuthority: OwnerExecutionAuthorityService = {
  resolve: () => Effect.succeed(authority),
};
const trustedEnforcementAuthority: AntiResurrectionEnforcementAuthorityService = {
  resolve: () => Effect.succeed(enforcementReceipt),
};

describe('Owner execution authority-bound Actions', () => {
  it('rejects caller-supplied owner success and protection facts at the public schemas', () => {
    expect(() =>
      Schema.decodeUnknownSync(RecordOwnerExecutionOutcomePayloadSchema)({ outcome: authority.outcome }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RecordAntiResurrectionProtectionPayloadSchema)({
        handoff,
        outcome: authority.outcome,
      }),
    ).toThrow();
  });

  it.effect('records an owner outcome only from the exact trusted receipt', () =>
    Effect.gen(function* recordTrustedOutcome() {
      let recordedAuthority: unknown;
      const { collector, context } = ownerContext({
        authority: trustedAuthority,
        getPrivacyMeasureHandoff: () => Effect.succeed(Option.some(handoff)),
        recordOwnerOutcome: (_tenant, _legalEntity, _invocation, request, trusted) =>
          Effect.sync(() => {
            expect(request).toBe(ownerRequest.request);
            recordedAuthority = trusted;
            return trusted.outcome;
          }),
      });

      const result = yield* handleRecordOwnerExecutionOutcome(ownerRequest, context);

      expect(recordedAuthority).toBe(authority);
      expect(result.status).toBe('SUCCEEDED');
      expect(collector.snapshot().auditEvidence.recordId).toBe(result.outcomeId);
    }),
  );

  it.effect('fails closed when owner execution authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableOwnerAuthority() {
      const { context } = ownerContext({
        authority: ownerExecutionAuthorityUnavailable,
        getPrivacyMeasureHandoff: () => Effect.succeed(Option.some(handoff)),
        recordOwnerOutcome: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordOwnerExecutionOutcome(ownerRequest, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it.effect('rejects owner evidence with a different receipt scope before persistence', () =>
    Effect.gen(function* rejectMismatchedOwnerReceipt() {
      const { context } = ownerContext({
        authority: {
          resolve: () => Effect.succeed({ ...authority, contentScopeRefs: ['different-scope'] }),
        },
        getPrivacyMeasureHandoff: () => Effect.succeed(Option.some(handoff)),
        recordOwnerOutcome: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordOwnerExecutionOutcome(ownerRequest, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('exact content scope');
    }),
  );

  it.effect('rejects an incomplete trusted SUCCEEDED outcome before persistence', () =>
    Effect.gen(function* rejectIncompleteSuccess() {
      let persisted = false;
      const incompleteAuthority = {
        ...authority,
        outcome: {
          ...authority.outcome,
          includedResourceRefs: [],
          remainingResourceRefs: handoff.resourceRefs,
        },
      };
      const { context } = ownerContext({
        authority: { resolve: () => Effect.succeed(incompleteAuthority) },
        getPrivacyMeasureHandoff: () => Effect.succeed(Option.some(handoff)),
        recordOwnerOutcome: () =>
          Effect.sync(() => {
            persisted = true;
            return incompleteAuthority.outcome;
          }),
      });

      const error = yield* Effect.flip(handleRecordOwnerExecutionOutcome(ownerRequest, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('status does not match');
      expect(persisted).toBe(false);
    }),
  );

  it.effect('records anti-resurrection protection only from the exact trusted successful receipt', () =>
    Effect.gen(function* recordTrustedProtection() {
      const { collector, context } = antiResurrectionContext({
        authority: trustedAuthority,
        enforcementAuthority: trustedEnforcementAuthority,
        getPrivacyMeasureHandoff: () => Effect.succeed(Option.some(handoff)),
        recordAntiResurrectionProtection: (_tenant, _legalEntity, _invocation, request, trusted) =>
          Effect.sync(() => {
            expect(request).toBe(antiResurrectionRequest.request);
            expect(trusted).toBe(authority);
            return protection;
          }),
      });

      const result = yield* handleRecordAntiResurrectionProtection(antiResurrectionRequest, context);

      expect(result.outcomeStatus).toBe('SUCCEEDED');
      expect(collector.snapshot().auditEvidence.recordId).toBe(result.protectionId);
    }),
  );

  it.effect('fails closed when anti-resurrection owner authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableProtectionAuthority() {
      const { context } = antiResurrectionContext({
        authority: ownerExecutionAuthorityUnavailable,
        enforcementAuthority: trustedEnforcementAuthority,
        getPrivacyMeasureHandoff: () => Effect.succeed(Option.some(handoff)),
        recordAntiResurrectionProtection: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordAntiResurrectionProtection(antiResurrectionRequest, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it.effect('fails closed when owner-local anti-resurrection enforcement is unavailable', () =>
    Effect.gen(function* rejectUnavailableEnforcementAuthority() {
      const { context } = antiResurrectionContext({
        authority: trustedAuthority,
        enforcementAuthority: antiResurrectionEnforcementAuthorityUnavailable,
        getPrivacyMeasureHandoff: () => Effect.succeed(Option.some(handoff)),
        recordAntiResurrectionProtection: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordAntiResurrectionProtection(antiResurrectionRequest, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );
});
