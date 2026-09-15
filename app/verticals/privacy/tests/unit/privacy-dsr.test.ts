import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  calculateDsrDeadline,
  canCloseDsrCase,
  canFinalizeDsrResponse,
  canPerformSensitiveDsrOperation,
  createDsrCase,
  DsrResolverAssignmentSchema,
  DsrOwnerTaskSchema,
  DsrResponseSchema,
  DsrVerificationSchema,
  findDsrOwnerTaskReplay,
  requiredDsrVerificationScope,
  resolveCurrentDsrResolver,
  summarizeDsrCase,
} from '../../shared/domain/privacy-dsr.ts';
import { DsrDeliveryEvidenceSchema } from '../../shared/domain/dsr-delivery-access.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const receivedAt = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-09-14T10:00:00Z');
const resolvedAccessCase = () =>
  createDsrCase({
    caseRef: 'dsr:1',
    controllerObligations: [
      {
        caseRef: 'dsr:1',
        controllerRef: 'controller:acme',
        obligationRef: 'obligation:1',
        receivedAt,
        requestedRights: ['ACCESS'],
        status: 'OPEN',
      },
    ],
    receivedAt,
    requestedRights: ['ACCESS'],
    requester: { kind: 'RESOLVED', subjectRef: 'subject:1' },
  });
const grantedAccessDecision = {
  caseRef: 'dsr:1',
  controllerRef: 'controller:acme',
  decidedAt: receivedAt,
  decisionEvidenceRefs: ['evidence:1'],
  decisionRef: 'decision:1',
  outcome: 'GRANTED' as const,
  ownerExecutionRequired: true,
  reasonRef: 'reason:1',
  right: 'ACCESS' as const,
};
const ownerTask = (
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'PARTIAL' | 'INDETERMINATE' | 'FAILED',
  overrides: Partial<typeof DsrOwnerTaskSchema.Encoded> = {},
) =>
  Schema.decodeUnknownSync(DsrOwnerTaskSchema)({
    caseRef: 'dsr:1',
    controllerRef: 'controller:acme',
    exactScopeRefs: ['scope:1'],
    idempotencyKey: 'idempotency:1',
    outcomeRef: status === 'SUCCEEDED' ? 'outcome:1' : null,
    ownerModuleId: 'party-registry',
    right: 'ACCESS',
    status,
    taskRef: 'task:1',
    ...overrides,
  });
const successfulDelivery = Schema.decodeUnknownSync(DsrDeliveryEvidenceSchema)({
  accessId: 'access:1',
  channel: 'secure-portal',
  deliveryOutputRef: 'output:1',
  deliveryOutputRevision: 1,
  deliveryScopeRefs: ['obligation:1'],
  evidenceId: 'delivery:1',
  occurredAt: '2026-09-14T12:01:00Z',
  outcome: 'SUCCESSFUL_DELIVERY',
  policyRef: 'delivery-policy:1',
  providerReference: null,
  reason: 'Secure access became available to the verified recipient',
  recipientRef: 'subject:1',
  recordedAt: '2026-09-14T12:02:00Z',
  representationRef: 'representation:self',
});

describe('privacy DSR case lifecycle', () => {
  it('accepts unresolved account-free intake without creating broader identity', () => {
    const caseRecord = createDsrCase({
      caseRef: 'dsr:1',
      receivedAt,
      requestedRights: ['ACCESS', 'ERASURE'],
      requester: { kind: 'UNRESOLVED' },
      unresolvedParts: ['controller:unknown', 'subject:unresolved'],
    });

    expect(caseRecord.status).toBe('RECEIVED');
    expect(caseRecord.originalReceivedAt).toBe(receivedAt);
    expect(caseRecord.subjectRefs).toEqual([]);
  });

  it('keeps Controller-specific deadlines anchored to original receipt', () => {
    const deadline = calculateDsrDeadline({
      caseRef: 'dsr:1',
      controllerRef: 'controller:acme',
      deadlineAt: Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-10-14T10:00:00Z'),
      originalReceivedAt: receivedAt,
      receiptBasisRef: 'receipt:controller-confirmed',
    });

    expect(deadline.receivedAt).toBe(receivedAt);
  });

  it('matches substantive decisions to the exact case, Controller, and right', () => {
    const caseRecord = resolvedAccessCase();
    const task = ownerTask('SUCCEEDED');

    expect(canCloseDsrCase(caseRecord, [{ ...grantedAccessDecision, caseRef: 'dsr:other' }], [task])).toBe(false);
    expect(canCloseDsrCase(caseRecord, [{ ...grantedAccessDecision, controllerRef: 'controller:other' }], [task])).toBe(
      false,
    );
    expect(canCloseDsrCase(caseRecord, [{ ...grantedAccessDecision, right: 'ERASURE' }], [task])).toBe(false);
    expect(canCloseDsrCase(caseRecord, [grantedAccessDecision], [task])).toBe(true);
  });

  it('requires non-empty successful owner task evidence for decisions that require execution', () => {
    const caseRecord = resolvedAccessCase();

    expect(canCloseDsrCase(caseRecord, [grantedAccessDecision], [])).toBe(false);
    for (const status of ['PENDING', 'IN_PROGRESS', 'PARTIAL', 'FAILED', 'INDETERMINATE'] as const) {
      expect(canCloseDsrCase(caseRecord, [grantedAccessDecision], [ownerTask(status)])).toBe(false);
    }
    expect(canCloseDsrCase(caseRecord, [grantedAccessDecision], [ownerTask('SUCCEEDED')])).toBe(true);
    expect(canCloseDsrCase(caseRecord, [grantedAccessDecision], [ownerTask('SUCCEEDED', { outcomeRef: null })])).toBe(
      false,
    );
    expect(
      canCloseDsrCase(caseRecord, [grantedAccessDecision], [ownerTask('SUCCEEDED', { caseRef: 'dsr:other' })]),
    ).toBe(false);
    expect(
      canCloseDsrCase(
        caseRecord,
        [grantedAccessDecision],
        [ownerTask('SUCCEEDED', { controllerRef: 'controller:other' })],
      ),
    ).toBe(false);
    expect(canCloseDsrCase(caseRecord, [grantedAccessDecision], [ownerTask('SUCCEEDED', { right: 'ERASURE' })])).toBe(
      false,
    );
    expect(canCloseDsrCase(caseRecord, [{ ...grantedAccessDecision, ownerExecutionRequired: false }], [])).toBe(true);
  });

  it('limits verification to one case, subject, operation scope, and expiry', () => {
    const verification = Schema.decodeUnknownSync(DsrVerificationSchema)({
      caseRef: 'dsr:1',
      evidenceRefs: ['evidence:verification'],
      expiresAt: '2026-09-15T10:00:00Z',
      method: 'method:strong-match',
      outcome: 'VERIFIED',
      scope: 'EXPORT',
      subjectRef: 'subject:1',
      verificationRef: 'verification:1',
      verifiedAt: '2026-09-14T10:00:00Z',
    });

    expect(
      canPerformSensitiveDsrOperation({
        at: receivedAt,
        caseRef: 'dsr:1',
        requiredScope: 'EXPORT',
        subjectRef: 'subject:1',
        verification,
      }),
    ).toBe(true);
    expect(
      canPerformSensitiveDsrOperation({
        at: receivedAt,
        caseRef: 'dsr:1',
        requiredScope: 'MUTATION',
        subjectRef: 'subject:1',
        verification,
      }),
    ).toBe(false);
    expect(
      canPerformSensitiveDsrOperation({
        at: Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-09-16T10:00:00Z'),
        caseRef: 'dsr:1',
        requiredScope: 'EXPORT',
        subjectRef: 'subject:1',
        verification,
      }),
    ).toBe(false);
  });

  it('resolves the latest Controller-specific resolver without resetting receipt time', () => {
    const assignments = ['2026-09-14T11:00:00Z', '2026-09-14T12:00:00Z'].map((assignedAt, index) =>
      Schema.decodeUnknownSync(DsrResolverAssignmentSchema)({
        assignedAt,
        assignmentRef: `assignment:${index}`,
        caseRef: 'dsr:1',
        controllerRef: 'controller:acme',
        outage: index === 1,
        resolverRef: `resolver:${index}`,
        supersedesAssignmentRef: index === 0 ? null : 'assignment:0',
      }),
    );

    expect(resolveCurrentDsrResolver(assignments, 'dsr:1', 'controller:acme').status).toBe('UNAVAILABLE');
    expect(resolveCurrentDsrResolver(assignments, 'dsr:1', 'controller:other').status).toBe('ABSENT');
  });

  it('keeps each DSR right distinct and owner task retries idempotent', () => {
    expect(requiredDsrVerificationScope('ACCESS')).toBe('EXPORT');
    expect(requiredDsrVerificationScope('PORTABILITY')).toBe('EXPORT');
    for (const right of ['RECTIFICATION', 'ERASURE', 'RESTRICTION', 'OBJECTION'] as const) {
      expect(requiredDsrVerificationScope(right)).toBe('MUTATION');
    }
    const task = Schema.decodeUnknownSync(DsrOwnerTaskSchema)({
      caseRef: 'dsr:1',
      controllerRef: 'controller:acme',
      exactScopeRefs: ['scope:1'],
      idempotencyKey: 'retry:1',
      outcomeRef: null,
      ownerModuleId: 'party-registry',
      right: 'ERASURE',
      status: 'PENDING',
      taskRef: 'task:1',
    });
    expect(findDsrOwnerTaskReplay([task], 'retry:1')).toBe(task);
  });

  it('requires complete decisions, terminal owner tasks, and delivery evidence for final response', () => {
    const caseRecord = resolvedAccessCase();
    const task = ownerTask('SUCCEEDED', { idempotencyKey: 'retry:1' });
    const response = Schema.decodeUnknownSync(DsrResponseSchema)({
      caseRef: 'dsr:1',
      createdAt: '2026-09-14T12:00:00Z',
      decisionRefs: ['decision:1'],
      deliveryEvidenceRef: 'delivery:1',
      final: true,
      responseRef: 'response:1',
      scopeRefs: ['obligation:1'],
    });

    expect(summarizeDsrCase(caseRecord, [grantedAccessDecision], [task]).closeable).toBe(true);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: successfulDelivery,
        response,
        tasks: [task],
      }),
    ).toBe(true);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: successfulDelivery,
        response: { ...response, deliveryEvidenceRef: Option.none() },
        tasks: [task],
      }),
    ).toBe(false);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: { ...successfulDelivery, outcome: 'KNOWN_FAILURE' },
        response,
        tasks: [task],
      }),
    ).toBe(false);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: { ...successfulDelivery, evidenceId: 'delivery:other' },
        response,
        tasks: [task],
      }),
    ).toBe(false);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: { ...successfulDelivery, deliveryScopeRefs: ['obligation:other'] },
        response,
        tasks: [task],
      }),
    ).toBe(false);
  });
});
