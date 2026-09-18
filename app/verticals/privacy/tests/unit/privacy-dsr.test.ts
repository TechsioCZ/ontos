import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  calculateDsrDeadline,
  canCloseDsrCase as canCloseDsrCaseWithoutInventory,
  canFinalizeDsrResponse,
  canPerformSensitiveDsrOperation,
  createDsrCase,
  applyDsrCaseLifecycleMutation,
  DsrResolverAssignmentSchema,
  DsrDeadlinePolicySchema,
  DsrOwnerTaskSchema,
  DsrOwnerInventoryAuthorityResultSchema,
  DsrResponseRequestSchema,
  DsrResponseSchema,
  DsrVerificationSchema,
  findDsrOwnerTaskReplay,
  isDsrDeliveryEvidenceNewerThanResponse,
  requiredDsrVerificationScope,
  resolveCurrentDsrResolver,
  resolveCurrentDsrSubstantiveDecision,
  materializeDsrResponse,
  sameDsrExactScopeRefs,
  summarizeDsrCase,
  validateDsrCaseLifecycleTransition,
  validateDsrResponseCoverage,
} from '../../shared/domain/privacy-dsr.ts';
import { DsrDeliveryEvidenceSchema } from '../../shared/domain/dsr-delivery-access.ts';
import {
  arePrivacyInstantsEqual,
  isPrivacyInstantAfter,
  PrivacyIsoTimestampSchema,
} from '../../shared/domain/privacy-subject.ts';

const receivedAt = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-09-14T10:00:00Z');
const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const resolvedAccessCase = () =>
  createDsrCase({
    caseRef: 'dsr:1',
    controllerObligations: [
      {
        caseRef: 'dsr:1',
        controllerRef: 'controller:acme',
        exactScopeRefs: ['scope:1'],
        obligationRef: 'obligation:1',
        receiptBasisRef: 'receipt:controller-confirmed',
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
  exactScopeRefs: ['scope:1'],
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
    authorityProvenance: {
      authorityRef: 'owner-authority:1',
      evidenceRefs: ['owner-evidence:1'],
      receiptRef: status === 'SUCCEEDED' ? 'outcome:1' : null,
    },
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
const ownerInventory = Schema.decodeUnknownSync(DsrOwnerInventoryAuthorityResultSchema)({
  authorityRef: 'owner-inventory-authority:1',
  caseRef: 'dsr:1',
  complete: true,
  entries: [
    {
      caseRef: 'dsr:1',
      controllerRef: 'controller:acme',
      exactScopeRefs: ['scope:1'],
      obligationRef: 'obligation:1',
      ownerModuleId: 'party-registry',
      right: 'ACCESS',
    },
  ],
  evidenceRefs: ['owner-inventory-evidence:1'],
  legalEntityId,
  observedAt: '2026-09-14T11:00:00Z',
  revision: 'owner-inventory-revision:1',
  tenantId,
});
const emptyOwnerInventory = { ...ownerInventory, entries: [] };
const canCloseDsrCase = (
  caseRecord: Parameters<typeof canCloseDsrCaseWithoutInventory>[0],
  decisions: Parameters<typeof canCloseDsrCaseWithoutInventory>[1],
  tasks: Parameters<typeof canCloseDsrCaseWithoutInventory>[2],
  inventory = ownerInventory,
) => canCloseDsrCaseWithoutInventory(caseRecord, decisions, tasks, inventory);

describe('privacy DSR case lifecycle', () => {
  it('does not accept caller-created response timestamps and compares trusted instants chronologically', () => {
    const request = Schema.decodeUnknownSync(DsrResponseRequestSchema)({
      caseRef: 'dsr:1',
      createdAt: '2999-01-01T00:00:00Z',
      decisionRefs: ['decision:1'],
      deliveryEvidenceRef: null,
      final: false,
      responseRef: 'response:request',
      scopeRefs: ['obligation:1'],
    });
    const materialized = materializeDsrResponse(request, '2026-09-14T12:00:00Z');

    expect(request).not.toHaveProperty('createdAt');
    expect(materialized.createdAt).toBe('2026-09-14T12:00:00Z');
    expect(isPrivacyInstantAfter('2026-09-14T12:00:00.001Z', '2026-09-14T12:00:00Z')).toBe(true);
    expect(isPrivacyInstantAfter('2026-09-14T12:00:00Z', '2026-09-14T12:00:00.001Z')).toBe(false);
    expect(arePrivacyInstantsEqual('2026-09-14T12:00:00Z', '2026-09-14T08:00:00-04:00')).toBe(true);
    expect(isPrivacyInstantAfter('2026-09-14T09:00:00-04:00', '2026-09-14T12:00:00.000Z')).toBe(true);
  });

  it('invalidates a final response after newer delivery evidence across ISO representations', () => {
    const response = Schema.decodeUnknownSync(DsrResponseSchema)({
      caseRef: 'dsr:1',
      createdAt: '2026-09-14T12:00:00Z',
      decisionRefs: ['decision:1'],
      deliveryEvidenceRef: 'delivery:1',
      final: true,
      responseRef: 'response:stale-evidence',
      scopeRefs: ['obligation:1'],
    });

    expect(
      isDsrDeliveryEvidenceNewerThanResponse(response, {
        caseRef: 'dsr:1',
        evidenceId: 'delivery:2',
        recordedAt: '2026-09-14T09:00:00-04:00',
      }),
    ).toBe(true);
    expect(
      isDsrDeliveryEvidenceNewerThanResponse(response, {
        caseRef: 'dsr:1',
        evidenceId: 'delivery:1',
        recordedAt: '2026-09-14T09:00:00-04:00',
      }),
    ).toBe(false);
  });

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

  it('calculates a Controller deadline as a calendar month from the authoritative receipt', () => {
    const deadline = calculateDsrDeadline({
      caseRef: 'dsr:1',
      controllerRef: 'controller:acme',
      originalReceivedAt: receivedAt,
      policy: Schema.decodeUnknownSync(DsrDeadlinePolicySchema)({
        calendar: 'UTC_CALENDAR_MONTH',
        months: 1,
        policyRef: 'policy:gdpr',
        policyVersion: '2026-01',
      }),
      receiptBasisRef: 'receipt:controller-confirmed',
    });

    expect(deadline.receivedAt).toBe(receivedAt);
    expect(deadline.deadlineAt).toBe('2026-10-14T10:00:00.000Z');
    expect(deadline.policyVersion).toBe('2026-01');
  });

  it('clips a calendar-month deadline to the last valid day of the target month', () => {
    const deadline = calculateDsrDeadline({
      caseRef: 'dsr:1',
      controllerRef: 'controller:acme',
      originalReceivedAt: '2026-01-31T10:00:00Z',
      policy: {
        calendar: 'UTC_CALENDAR_MONTH',
        months: 1,
        policyRef: 'policy:gdpr',
        policyVersion: '2026-01',
      },
      receiptBasisRef: 'receipt:controller-confirmed',
    });

    expect(deadline.deadlineAt).toBe('2026-02-28T10:00:00.000Z');
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
    expect(
      canCloseDsrCase(
        caseRecord,
        [{ ...grantedAccessDecision, ownerExecutionRequired: false }],
        [],
        emptyOwnerInventory,
      ),
    ).toBe(true);
  });

  it('fails closed without authoritative owner inventory and requires each exact owner independently', () => {
    const caseRecord = resolvedAccessCase();
    const twoOwnerInventory = Schema.decodeUnknownSync(DsrOwnerInventoryAuthorityResultSchema)({
      ...ownerInventory,
      entries: [
        ...ownerInventory.entries,
        { ...ownerInventory.entries[0], ownerModuleId: 'commerce-customer-context' },
      ],
    });

    expect(canCloseDsrCaseWithoutInventory(caseRecord, [grantedAccessDecision], [ownerTask('SUCCEEDED')])).toBe(false);
    expect(canCloseDsrCase(caseRecord, [grantedAccessDecision], [ownerTask('SUCCEEDED')], twoOwnerInventory)).toBe(
      false,
    );
    expect(
      canCloseDsrCase(
        caseRecord,
        [grantedAccessDecision],
        [
          ownerTask('SUCCEEDED'),
          ownerTask('SUCCEEDED', {
            idempotencyKey: 'idempotency:2',
            ownerModuleId: 'commerce-customer-context',
            taskRef: 'task:2',
          }),
        ],
        twoOwnerInventory,
      ),
    ).toBe(true);
    expect(
      canCloseDsrCase(
        caseRecord,
        [grantedAccessDecision],
        [ownerTask('SUCCEEDED', { ownerModuleId: 'commerce-customer-context' })],
        ownerInventory,
      ),
    ).toBe(false);
  });

  it('requires the exact owner scope and persisted authority receipt for closure', () => {
    const caseRecord = resolvedAccessCase();
    const successfulTask = ownerTask('SUCCEEDED');

    expect(sameDsrExactScopeRefs(['scope:1', 'scope:2'], ['scope:2', 'scope:1'])).toBe(true);
    expect(sameDsrExactScopeRefs(['scope:1', 'scope:1'], ['scope:1'])).toBe(false);
    expect(
      canCloseDsrCase(caseRecord, [{ ...grantedAccessDecision, exactScopeRefs: ['scope:other'] }], [successfulTask]),
    ).toBe(false);
    expect(
      canCloseDsrCase(
        caseRecord,
        [grantedAccessDecision],
        [ownerTask('SUCCEEDED', { exactScopeRefs: ['scope:other'] })],
      ),
    ).toBe(false);
    expect(
      canCloseDsrCase(
        caseRecord,
        [grantedAccessDecision],
        [ownerTask('SUCCEEDED', { exactScopeRefs: ['scope:1', 'scope:extra'] })],
      ),
    ).toBe(false);
    expect(
      (() => {
        const { authorityProvenance, ...taskWithoutProvenance } = successfulTask;
        expect(authorityProvenance).toBeDefined();
        return canCloseDsrCase(caseRecord, [grantedAccessDecision], [taskWithoutProvenance]);
      })(),
    ).toBe(false);
    expect(
      canCloseDsrCase(
        caseRecord,
        [grantedAccessDecision],
        [
          ownerTask('SUCCEEDED', {
            authorityProvenance: {
              authorityRef: 'owner-authority:1',
              evidenceRefs: ['owner-evidence:1'],
              receiptRef: 'forged-receipt:1',
            },
          }),
        ],
      ),
    ).toBe(false);
    expect(
      canCloseDsrCase(
        caseRecord,
        [grantedAccessDecision],
        [
          ownerTask('SUCCEEDED', {
            authorityProvenance: {
              authorityRef: 'owner-authority:1',
              evidenceRefs: ['owner-evidence:1'],
              receiptRef: null,
            },
          }),
        ],
      ),
    ).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(DsrOwnerTaskSchema)({
        ...successfulTask,
        exactScopeRefs: ['scope:1', 'scope:1'],
      }),
    ).toThrow();
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

  it('resolves an explicitly superseded Controller resolver without resetting receipt time', () => {
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

    expect(resolveCurrentDsrResolver(assignments, 'dsr:1', 'controller:acme', '2026-09-14T12:00:00Z').status).toBe(
      'UNAVAILABLE',
    );
    expect(resolveCurrentDsrResolver(assignments, 'dsr:1', 'controller:other', '2026-09-14T12:00:00Z').status).toBe(
      'ABSENT',
    );
  });

  it('fails closed when resolver assignments are independently current', () => {
    const assignments = ['2026-09-14T11:00:00Z', '2026-09-14T12:00:00Z'].map((assignedAt, index) =>
      Schema.decodeUnknownSync(DsrResolverAssignmentSchema)({
        assignedAt,
        assignmentRef: `unlinked-assignment:${index}`,
        caseRef: 'dsr:1',
        controllerRef: 'controller:acme',
        outage: false,
        resolverRef: `resolver:${index}`,
        supersedesAssignmentRef: null,
      }),
    );

    expect(resolveCurrentDsrResolver(assignments, 'dsr:1', 'controller:acme', '2026-09-14T12:00:00Z')).toEqual({
      status: 'CONFLICT',
    });
  });

  it('does not treat a future resolver assignment as current', () => {
    const future = Schema.decodeUnknownSync(DsrResolverAssignmentSchema)({
      assignedAt: '2026-09-15T12:00:00Z',
      assignmentRef: 'assignment:future',
      caseRef: 'dsr:1',
      controllerRef: 'controller:acme',
      outage: false,
      resolverRef: 'resolver:future',
      supersedesAssignmentRef: null,
    });

    expect(resolveCurrentDsrResolver([future], 'dsr:1', 'controller:acme', '2026-09-14T12:00:00Z')).toEqual({
      status: 'ABSENT',
    });
  });

  it('keeps each DSR right distinct and owner task retries idempotent', () => {
    expect(requiredDsrVerificationScope('ACCESS')).toBe('EXPORT');
    expect(requiredDsrVerificationScope('PORTABILITY')).toBe('EXPORT');
    for (const right of ['RECTIFICATION', 'ERASURE', 'RESTRICTION', 'OBJECTION'] as const) {
      expect(requiredDsrVerificationScope(right)).toBe('MUTATION');
    }
    const task = Schema.decodeUnknownSync(DsrOwnerTaskSchema)({
      authorityProvenance: {
        authorityRef: 'owner-authority:1',
        evidenceRefs: ['owner-evidence:1'],
        receiptRef: null,
      },
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

  it('applies only a lifecycle mutation and preserves authoritative intake facts', () => {
    const stored = resolvedAccessCase();
    const updated = applyDsrCaseLifecycleMutation(stored, { caseRef: stored.caseRef, status: 'IN_PROGRESS' });

    expect(updated).toEqual({ ...stored, status: 'IN_PROGRESS' });
    expect(updated.originalReceivedAt).toBe(stored.originalReceivedAt);
    expect(updated.requestedRights).toEqual(stored.requestedRights);
    expect(updated.requester).toEqual(stored.requester);
    expect(updated.controllerObligations).toEqual(stored.controllerObligations);
  });

  it('treats CLOSED as terminal for ordinary lifecycle updates', () => {
    for (const status of ['RECEIVED', 'IN_PROGRESS', 'PARTIALLY_RESOLVED', 'RESPONDED'] as const) {
      expect(validateDsrCaseLifecycleTransition('CLOSED', status)).toContain('terminal');
    }
    expect(validateDsrCaseLifecycleTransition('CLOSED', 'CLOSED')).toContain('terminal');
    expect(validateDsrCaseLifecycleTransition('IN_PROGRESS', 'CLOSED')).toBeUndefined();
  });

  it('does not resurrect an older substantive grant after a newer unresolved decision', () => {
    const caseRecord = resolvedAccessCase();
    const unresolved = {
      ...grantedAccessDecision,
      decidedAt: '2026-09-14T11:00:00Z',
      decisionRef: 'decision:unresolved',
      outcome: 'UNRESOLVED' as const,
    };

    expect(
      resolveCurrentDsrSubstantiveDecision(
        [grantedAccessDecision, unresolved],
        {
          caseRef: caseRecord.caseRef,
          controllerRef: caseRecord.controllerObligations[0].controllerRef,
          exactScopeRefs: caseRecord.controllerObligations[0].exactScopeRefs,
          right: 'ACCESS',
        },
        '2026-09-14T12:00:00Z',
      ),
    ).toEqual({ decisions: [unresolved], outcome: 'CONFLICT' });
  });

  it('accepts only an exact authoritative non-final obligation subset', () => {
    const caseRecord = resolvedAccessCase();
    const task = ownerTask('PENDING');
    const response = Schema.decodeUnknownSync(DsrResponseSchema)({
      caseRef: 'dsr:1',
      createdAt: '2026-09-14T12:00:00Z',
      decisionRefs: ['decision:1'],
      deliveryEvidenceRef: null,
      final: false,
      responseRef: 'response:partial',
      scopeRefs: ['obligation:1'],
    });

    expect(
      validateDsrResponseCoverage({
        caseRecord,
        decisions: [grantedAccessDecision],
        ownerInventory,
        response,
        tasks: [task],
      }),
    ).toBe(undefined);
    expect(
      validateDsrResponseCoverage({
        caseRecord,
        decisions: [grantedAccessDecision],
        ownerInventory,
        response: { ...response, scopeRefs: ['obligation:other'] },
        tasks: [task],
      }),
    ).toContain('non-empty unique subset');
    expect(
      validateDsrResponseCoverage({
        caseRecord,
        decisions: [grantedAccessDecision],
        ownerInventory,
        response: { ...response, decisionRefs: ['decision:other'] },
        tasks: [task],
      }),
    ).toContain('decision references');
    expect(
      validateDsrResponseCoverage({
        caseRecord,
        decisions: [grantedAccessDecision],
        ownerInventory,
        response,
        tasks: [],
      }),
    ).toContain('owner-execution obligation');

    const deliveredResponse = Schema.decodeUnknownSync(DsrResponseSchema)({
      ...response,
      deliveryEvidenceRef: 'delivery:1',
    });
    expect(
      validateDsrResponseCoverage({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: successfulDelivery,
        ownerInventory,
        response: deliveredResponse,
        tasks: [task],
      }),
    ).toBeUndefined();

    expect(
      validateDsrResponseCoverage({
        caseRecord,
        decisions: [grantedAccessDecision],
        ownerInventory,
        response,
        tasks: [ownerTask('PENDING', { ownerModuleId: 'commerce-customer-context' })],
      }),
    ).toContain('trusted owner task');
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

    expect(summarizeDsrCase(caseRecord, [grantedAccessDecision], [task], ownerInventory).closeable).toBe(true);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: successfulDelivery,
        ownerInventory,
        response,
        tasks: [task],
      }),
    ).toBe(true);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: successfulDelivery,
        ownerInventory,
        response: { ...response, deliveryEvidenceRef: Option.none() },
        tasks: [task],
      }),
    ).toBe(false);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: { ...successfulDelivery, outcome: 'KNOWN_FAILURE' },
        ownerInventory,
        response,
        tasks: [task],
      }),
    ).toBe(false);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: { ...successfulDelivery, evidenceId: 'delivery:other' },
        ownerInventory,
        response,
        tasks: [task],
      }),
    ).toBe(false);
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: { ...successfulDelivery, deliveryScopeRefs: ['obligation:other'] },
        ownerInventory,
        response,
        tasks: [task],
      }),
    ).toBe(false);
    for (const invalidScopeRefs of [[], ['obligation:1', 'obligation:1'], ['obligation:1', 'obligation:extra']]) {
      expect(
        canFinalizeDsrResponse({
          caseRecord,
          decisions: [grantedAccessDecision],
          deliveryEvidence: successfulDelivery,
          ownerInventory,
          response: { ...response, scopeRefs: invalidScopeRefs },
          tasks: [task],
        }),
      ).toBe(false);
    }
    expect(
      canFinalizeDsrResponse({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: {
          ...successfulDelivery,
          deliveryScopeRefs: ['obligation:1', 'obligation:extra'],
        },
        ownerInventory,
        response,
        tasks: [task],
      }),
    ).toBe(false);
    expect(() => Schema.decodeUnknownSync(DsrResponseSchema)({ ...response, scopeRefs: [] })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(DsrResponseSchema)({
        ...response,
        scopeRefs: ['obligation:1', 'obligation:1'],
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(DsrResponseSchema)({ ...response, decisionRefs: [] })).toThrow();
  });

  it('invalidates a final response after a newer trusted substantive decision', () => {
    const caseRecord = resolvedAccessCase();
    const response = Schema.decodeUnknownSync(DsrResponseSchema)({
      caseRef: 'dsr:1',
      createdAt: '2026-09-14T12:00:00Z',
      decisionRefs: ['decision:1'],
      deliveryEvidenceRef: 'delivery:1',
      final: true,
      responseRef: 'response:stale-decision',
      scopeRefs: ['obligation:1'],
    });
    const newerDecision = { ...grantedAccessDecision, decidedAt: '2026-09-14T13:00:00Z', decisionRef: 'decision:2' };
    expect(
      validateDsrResponseCoverage({
        caseRecord,
        decisions: [grantedAccessDecision, newerDecision],
        deliveryEvidence: successfulDelivery,
        ownerInventory,
        response,
        tasks: [ownerTask('SUCCEEDED')],
      }),
    ).toContain('stale after a later trusted substantive decision');
  });

  it('invalidates a final response after a newer trusted owner task', () => {
    const caseRecord = resolvedAccessCase();
    const response = Schema.decodeUnknownSync(DsrResponseSchema)({
      caseRef: 'dsr:1',
      createdAt: '2026-09-14T12:00:00Z',
      decisionRefs: ['decision:1'],
      deliveryEvidenceRef: 'delivery:1',
      final: true,
      responseRef: 'response:stale-task',
      scopeRefs: ['obligation:1'],
    });
    expect(
      validateDsrResponseCoverage({
        caseRecord,
        decisions: [grantedAccessDecision],
        deliveryEvidence: successfulDelivery,
        ownerInventory,
        response,
        tasks: [ownerTask('SUCCEEDED', { updatedAt: '2026-09-14T13:00:00Z' })],
      }),
    ).toContain('stale after a later trusted owner task');
  });
});
