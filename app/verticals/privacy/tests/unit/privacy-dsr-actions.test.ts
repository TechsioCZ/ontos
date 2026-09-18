import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  CreateDsrCasePayloadSchema,
  RecordDsrDeadlinePayloadSchema,
  RecordDsrDeliveryEvidencePayloadSchema,
  RecordDsrVerificationPayloadSchema,
  UpdateDsrCasePayloadSchema,
  UpsertDsrOwnerTaskPayloadSchema,
} from '../../shared/actions/privacy-operations.ts';
import { DsrDeliveryEvidenceSchema } from '../../shared/domain/dsr-delivery-access.ts';
import {
  createDsrCase,
  DsrDeadlinePolicySchema,
  DsrIntakeReceiptSchema,
  DsrOwnerTaskAuthorityResultSchema,
  DsrVerificationSchema,
} from '../../shared/domain/privacy-dsr.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';
import {
  dsrDeadlineAuthorityUnavailable,
  handleRecordDsrDeadline,
  recordDsrDeadlineAction,
} from '../../src/actions/record-dsr-deadline.action.ts';
import type { RecordDsrDeadlineServices } from '../../src/actions/record-dsr-deadline.action.ts';
import {
  dsrIntakeReceiptAuthorityUnavailable,
  handleCreateDsrCase,
  createDsrCaseAction,
} from '../../src/actions/create-dsr-case.action.ts';
import type { CreateDsrCaseServices } from '../../src/actions/create-dsr-case.action.ts';
import { handleUpsertDsrOwnerTask, upsertDsrOwnerTaskAction } from '../../src/actions/upsert-dsr-owner-task.action.ts';
import { dsrOwnerTaskAuthorityUnavailable } from '../../src/actions/privacy-dsr-owner-task-authority.ts';
import { dsrOwnerInventoryAuthorityUnavailable } from '../../src/actions/privacy-dsr-owner-inventory-authority.ts';
import type { UpsertDsrOwnerTaskServices } from '../../src/actions/upsert-dsr-owner-task.action.ts';
import {
  dsrDeliveryAuthorityUnavailable,
  handleRecordDsrDeliveryEvidence,
  recordDsrDeliveryEvidenceAction,
} from '../../src/actions/record-dsr-delivery-evidence.action.ts';
import type {
  DsrDeliveryAuthorityEvidence,
  DsrDeliveryAuthorityService,
  RecordDsrDeliveryEvidenceServices,
} from '../../src/actions/record-dsr-delivery-evidence.action.ts';
import {
  dsrVerificationAuthorityUnavailable,
  handleRecordDsrVerification,
  recordDsrVerificationAction,
} from '../../src/actions/record-dsr-verification.action.ts';
import type {
  DsrVerificationAuthorityService,
  RecordDsrVerificationServices,
} from '../../src/actions/record-dsr-verification.action.ts';
import { PrivacyActionRejected } from '../../src/actions/privacy-operation-action-support.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const actionInvocationId = '00000000-0000-4000-8000-000000000003';
const scope = {
  authMethod: 'session' as const,
  correlationId: 'privacy-dsr-action-test',
  legalEntityId,
  principalId: '00000000-0000-4000-8000-000000000004',
  tenantId,
};

const deliveryRequest = Schema.decodeUnknownSync(RecordDsrDeliveryEvidencePayloadSchema)({
  accessId: 'access:1',
  deliveryClaimRef: 'provider:1',
});

const deliveryAuthorityEvidence: DsrDeliveryAuthorityEvidence = {
  accessId: deliveryRequest.accessId,
  caseRef: 'dsr:1',
  channel: 'secure-portal',
  deliveryOutputRef: 'output:1',
  deliveryOutputRevision: 1,
  deliveryScopeRefs: ['scope:1'],
  evidenceId: 'delivery:1',
  occurredAt: '2026-09-14T12:01:00Z',
  outcome: 'SUCCESSFUL_DELIVERY',
  policyRef: 'delivery-policy:1',
  providerReference: deliveryRequest.deliveryClaimRef,
  reason: 'Delivered',
  recipientRef: 'subject:1',
  representationRef: 'representation:self',
};

const verificationRequest = Schema.decodeUnknownSync(RecordDsrVerificationPayloadSchema)({
  caseRef: 'dsr:1',
  evidenceRefs: ['evidence:verification'],
  scope: 'EXPORT',
  subjectRef: 'subject:1',
  verificationRef: 'verification:1',
});

const authoritativeVerification = Schema.decodeUnknownSync(DsrVerificationSchema)({
  ...verificationRequest,
  expiresAt: null,
  method: 'method:strong-match',
  outcome: 'VERIFIED',
  verifiedAt: '2026-09-14T10:00:00Z',
});

const createCaseRequest = Schema.decodeUnknownSync(CreateDsrCasePayloadSchema)({
  request: {
    caseRef: 'dsr:intake:1',
    controllerObligations: [
      {
        controllerRef: 'controller:acme',
        exactScopeRefs: ['scope:account-1'],
        obligationRef: 'obligation:1',
        requestedRights: ['ACCESS'],
      },
    ],
    intakeClaimRef: 'intake-claim:1',
    requestedRights: ['ACCESS'],
    requester: { kind: 'RESOLVED', subjectRef: 'subject:1' },
    subjectRefs: ['subject:1'],
    unresolvedParts: [],
  },
});

const intakeReceipt = Schema.decodeUnknownSync(DsrIntakeReceiptSchema)({
  caseRef: createCaseRequest.request.caseRef,
  controllerReceipts: [
    {
      controllerRef: 'controller:acme',
      exactScopeRefs: ['scope:account-1'],
      obligationRef: 'obligation:1',
      receiptBasisRef: 'receipt-basis:trusted',
      receivedAt: '2026-09-14T08:30:00Z',
      requestedRights: ['ACCESS'],
    },
  ],
  intakeClaimRef: createCaseRequest.request.intakeClaimRef,
  originalReceivedAt: '2026-09-14T08:00:00Z',
  requestedRights: ['ACCESS'],
});

const ownerTaskRequest = Schema.decodeUnknownSync(UpsertDsrOwnerTaskPayloadSchema)({
  request: {
    caseRef: 'dsr:owner-task:1',
    controllerRef: 'controller:acme',
    exactScopeRefs: ['scope:account-1'],
    idempotencyKey: 'owner-task-idempotency:1',
    ownerModuleId: 'accounts',
    right: 'ERASURE',
    taskRef: 'owner-task:1',
  },
});

const authoritativeOwnerTask = Schema.decodeUnknownSync(DsrOwnerTaskAuthorityResultSchema)({
  authorityRef: 'owner-authority:1',
  evidenceRefs: ['owner-evidence:1'],
  legalEntityId,
  receiptRef: 'owner-receipt:1',
  task: {
    ...ownerTaskRequest.request,
    authorityProvenance: {
      authorityRef: 'owner-authority:1',
      evidenceRefs: ['owner-evidence:1'],
      receiptRef: 'owner-receipt:1',
    },
    outcomeRef: 'owner-receipt:1',
    status: 'SUCCEEDED',
  },
  tenantId,
});

const deliveryContext = (services: RecordDsrDeliveryEvidenceServices) => {
  const collector = createActionCollector(
    recordDsrDeliveryEvidenceAction.descriptor.domainEvents,
    'privacy.core',
    recordDsrDeliveryEvidenceAction.descriptor.accessEvidencePolicy,
    recordDsrDeliveryEvidenceAction.descriptor.auditEvidenceSchema,
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

const verificationContext = (services: RecordDsrVerificationServices) => {
  const collector = createActionCollector(
    recordDsrVerificationAction.descriptor.domainEvents,
    'privacy.core',
    recordDsrVerificationAction.descriptor.accessEvidencePolicy,
    recordDsrVerificationAction.descriptor.auditEvidenceSchema,
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

const deadlineContext = (services: RecordDsrDeadlineServices) => {
  const collector = createActionCollector(
    recordDsrDeadlineAction.descriptor.domainEvents,
    'privacy.core',
    recordDsrDeadlineAction.descriptor.accessEvidencePolicy,
    recordDsrDeadlineAction.descriptor.auditEvidenceSchema,
  );
  return {
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

const createCaseContext = (services: CreateDsrCaseServices) => {
  const collector = createActionCollector(
    createDsrCaseAction.descriptor.domainEvents,
    'privacy.core',
    createDsrCaseAction.descriptor.accessEvidencePolicy,
    createDsrCaseAction.descriptor.auditEvidenceSchema,
  );
  return {
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

const ownerTaskContext = (services: UpsertDsrOwnerTaskServices) => {
  const collector = createActionCollector(
    upsertDsrOwnerTaskAction.descriptor.domainEvents,
    'privacy.core',
    upsertDsrOwnerTaskAction.descriptor.accessEvidencePolicy,
    upsertDsrOwnerTaskAction.descriptor.auditEvidenceSchema,
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

const rejectedDeliveryAuthority: DsrDeliveryAuthorityService = {
  resolve: () =>
    Effect.fail(
      new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'The delivery owner rejected the claim',
      }),
    ),
};

const rejectedVerificationAuthority: DsrVerificationAuthorityService = {
  verify: () =>
    Effect.fail(
      new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'The verifier rejected the evidence',
      }),
    ),
};

describe('DSR authority-bound Actions', () => {
  it('rejects caller-supplied intake receipt facts at the public schema', () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateDsrCasePayloadSchema)({
        caseRecord: {
          ...createCaseRequest.request,
          originalReceivedAt: intakeReceipt.originalReceivedAt,
        },
      }),
    ).toThrow();
  });

  it.effect('materializes DSR receipt times and bases only from the intake authority', () =>
    Effect.gen(function* createAuthoritativeCase() {
      let retainedCase: unknown;
      const { context } = createCaseContext({
        authority: { resolve: () => Effect.succeed(intakeReceipt) },
        createDsrCase: (_tenant, _legalEntity, _invocation, caseRecord) =>
          Effect.sync(() => {
            retainedCase = caseRecord;
            return caseRecord;
          }),
      });

      const result = yield* handleCreateDsrCase(createCaseRequest, context);

      expect(retainedCase).toBeDefined();
      expect(result.originalReceivedAt).toBe(intakeReceipt.originalReceivedAt);
      expect(result.controllerObligations[0]?.receivedAt).toBe(intakeReceipt.controllerReceipts[0]?.receivedAt);
      expect(result.controllerObligations[0]?.receiptBasisRef).toBe('receipt-basis:trusted');
    }),
  );

  it.effect('fails closed when the DSR intake receipt authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableIntakeAuthority() {
      const { context } = createCaseContext({
        authority: dsrIntakeReceiptAuthorityUnavailable,
        createDsrCase: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleCreateDsrCase(createCaseRequest, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it.effect('rejects an intake receipt for a different exact case correlation', () =>
    Effect.gen(function* rejectMismatchedIntakeReceipt() {
      const { context } = createCaseContext({
        authority: { resolve: () => Effect.succeed({ ...intakeReceipt, caseRef: 'dsr:other' }) },
        createDsrCase: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleCreateDsrCase(createCaseRequest, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('exact Case');
    }),
  );

  it('rejects the legacy caller-supplied delivery evidence object at the public schema', () => {
    const legacyEvidence = Schema.decodeUnknownSync(DsrDeliveryEvidenceSchema)({
      ...deliveryAuthorityEvidence,
      recordedAt: '2026-09-14T12:02:00Z',
    });

    expect(() =>
      Schema.decodeUnknownSync(RecordDsrDeliveryEvidencePayloadSchema)({ evidence: legacyEvidence }),
    ).toThrow();
  });

  it.effect('records successful delivery only from a trusted delivery authority', () =>
    Effect.gen(function* recordAuthoritativeDelivery() {
      let recorded = false;
      const { collector, context } = deliveryContext({
        authority: { resolve: () => Effect.succeed(deliveryAuthorityEvidence) },
        recordDsrDeliveryEvidence: (_tenant, _legalEntity, _invocation, evidence) =>
          Effect.sync(() => {
            recorded = true;
            return evidence;
          }),
      });

      const result = yield* handleRecordDsrDeliveryEvidence(deliveryRequest, context);

      expect(recorded).toBe(true);
      expect(result.outcome).toBe('SUCCESSFUL_DELIVERY');
      expect(result.providerReference).toBe(deliveryRequest.deliveryClaimRef);
      expect(collector.snapshot().auditEvidence.recordId).toBe(result.evidenceId);
    }),
  );

  it.effect('fails closed when the delivery authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableDeliveryAuthority() {
      const { context } = deliveryContext({
        authority: dsrDeliveryAuthorityUnavailable,
        recordDsrDeliveryEvidence: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordDsrDeliveryEvidence(deliveryRequest, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it.effect('preserves a typed rejection from the delivery authority', () =>
    Effect.gen(function* rejectDeliveryClaim() {
      const { context } = deliveryContext({
        authority: rejectedDeliveryAuthority,
        recordDsrDeliveryEvidence: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordDsrDeliveryEvidence(deliveryRequest, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('rejected the claim');
    }),
  );

  it.effect('rejects delivery evidence that does not match the requested access', () =>
    Effect.gen(function* rejectMismatchedDeliveryEvidence() {
      const { context } = deliveryContext({
        authority: { resolve: () => Effect.succeed({ ...deliveryAuthorityEvidence, accessId: 'access:other' }) },
        recordDsrDeliveryEvidence: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordDsrDeliveryEvidence(deliveryRequest, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('different access or delivery claim');
    }),
  );

  it('rejects the legacy caller-supplied verification verdict at the public schema', () => {
    expect(() =>
      Schema.decodeUnknownSync(RecordDsrVerificationPayloadSchema)({ verification: authoritativeVerification }),
    ).toThrow();
  });

  it.effect('records VERIFIED only from the operation-scoped verification authority', () =>
    Effect.gen(function* recordAuthoritativeVerification() {
      let recorded = false;
      const { collector, context } = verificationContext({
        authority: { verify: () => Effect.succeed(authoritativeVerification) },
        recordDsrVerification: (_tenant, _legalEntity, _invocation, verification) =>
          Effect.sync(() => {
            recorded = true;
            return verification;
          }),
      });

      const result = yield* handleRecordDsrVerification(verificationRequest, context);

      expect(recorded).toBe(true);
      expect(result.outcome).toBe('VERIFIED');
      expect(result.scope).toBe(verificationRequest.scope);
      expect(collector.snapshot().auditEvidence.recordId).toBe(result.verificationRef);
    }),
  );

  it.effect('fails closed when the verification authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableVerificationAuthority() {
      const { context } = verificationContext({
        authority: dsrVerificationAuthorityUnavailable,
        recordDsrVerification: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordDsrVerification(verificationRequest, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it.effect('preserves a typed rejection from the verification authority', () =>
    Effect.gen(function* rejectVerificationEvidence() {
      const { context } = verificationContext({
        authority: rejectedVerificationAuthority,
        recordDsrVerification: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordDsrVerification(verificationRequest, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('rejected the evidence');
    }),
  );

  it.effect('rejects a verifier verdict for a different operation scope', () =>
    Effect.gen(function* rejectMismatchedVerification() {
      const { context } = verificationContext({
        authority: { verify: () => Effect.succeed({ ...authoritativeVerification, scope: 'MUTATION' }) },
        recordDsrVerification: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordDsrVerification(verificationRequest, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('different operation scope or evidence set');
    }),
  );

  it('rejects the legacy caller-supplied deadline object at the public schema', () => {
    expect(() =>
      Schema.decodeUnknownSync(RecordDsrDeadlinePayloadSchema)({
        deadline: {
          caseRef: 'dsr:1',
          controllerRef: 'controller:acme',
          deadlineAt: '2099-01-01T00:00:00Z',
        },
      }),
    ).toThrow();
  });

  it.effect('derives the deadline from the matching Controller obligation and resolved policy', () =>
    Effect.gen(function* deriveDeadline() {
      const receivedAt = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-01-31T10:00:00Z');
      const caseRecord = createDsrCase({
        caseRef: 'dsr:1',
        controllerObligations: [
          {
            caseRef: 'dsr:1',
            controllerRef: 'controller:acme',
            obligationRef: 'obligation:1',
            receiptBasisRef: 'receipt:1',
            receivedAt,
            requestedRights: ['ACCESS'],
            status: 'OPEN',
          },
        ],
        receivedAt,
        requestedRights: ['ACCESS'],
        requester: { kind: 'RESOLVED', subjectRef: 'subject:1' },
      });
      const policy = Schema.decodeUnknownSync(DsrDeadlinePolicySchema)({
        calendar: 'UTC_CALENDAR_MONTH',
        months: 1,
        policyRef: 'policy:gdpr',
        policyVersion: '2026-01',
      });
      const request = Schema.decodeUnknownSync(RecordDsrDeadlinePayloadSchema)({
        caseRef: 'dsr:1',
        controllerRef: 'controller:acme',
      });
      const { context } = deadlineContext({
        authority: {
          resolve: (receipt) => Effect.succeed({ ...receipt, policy }),
        },
        getDsrCase: () => Effect.succeed(Option.some(caseRecord)),
        recordDsrDeadline: (_tenant, _legalEntity, _invocation, deadline) => Effect.succeed(deadline),
      });

      const result = yield* handleRecordDsrDeadline(request, context);

      expect(result.deadlineAt).toBe('2026-02-28T10:00:00.000Z');
      expect(result.policyRef).toBe(policy.policyRef);
      expect(result.policyVersion).toBe(policy.policyVersion);
      expect(result.receiptBasisRef).toBe('receipt:1');
    }),
  );

  it.effect('fails closed when the versioned DSR deadline authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableDeadlineAuthority() {
      const receivedAt = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-01-31T10:00:00Z');
      const caseRecord = createDsrCase({
        caseRef: 'dsr:1',
        controllerObligations: [
          {
            caseRef: 'dsr:1',
            controllerRef: 'controller:acme',
            obligationRef: 'obligation:1',
            receiptBasisRef: 'receipt:1',
            receivedAt,
            requestedRights: ['ACCESS'],
            status: 'OPEN',
          },
        ],
        receivedAt,
        requestedRights: ['ACCESS'],
        requester: { kind: 'RESOLVED', subjectRef: 'subject:1' },
      });
      const request = Schema.decodeUnknownSync(RecordDsrDeadlinePayloadSchema)({
        caseRef: 'dsr:1',
        controllerRef: 'controller:acme',
      });
      const { context } = deadlineContext({
        authority: dsrDeadlineAuthorityUnavailable,
        getDsrCase: () => Effect.succeed(Option.some(caseRecord)),
        recordDsrDeadline: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleRecordDsrDeadline(request, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it('rejects the legacy caller-supplied DSR owner task state at the public schema', () => {
    expect(() =>
      Schema.decodeUnknownSync(UpsertDsrOwnerTaskPayloadSchema)({ task: authoritativeOwnerTask.task }),
    ).toThrow();
  });

  it('accepts only lifecycle DSR updates and rejects caller-supplied intake facts', () => {
    const expectedUpdatedAt = '2026-09-14T10:00:00Z';
    const mutation = { caseRef: 'dsr:1', status: 'IN_PROGRESS' };

    expect(Schema.decodeUnknownSync(UpdateDsrCasePayloadSchema)({ expectedUpdatedAt, mutation })).toEqual({
      expectedUpdatedAt,
      mutation,
    });
    expect(() =>
      Schema.decodeUnknownSync(UpdateDsrCasePayloadSchema)({
        caseRecord: createDsrCase({
          caseRef: 'dsr:1',
          receivedAt: '2026-09-14T10:00:00Z',
          requestedRights: ['ERASURE'],
          requester: { kind: 'UNRESOLVED' },
        }),
        expectedUpdatedAt,
      }),
    ).toThrow();
    const decodedWithCallerFacts = Schema.decodeUnknownSync(UpdateDsrCasePayloadSchema)({
      expectedUpdatedAt,
      mutation: { ...mutation, receivedAt: '2099-01-01T00:00:00Z', requestedRights: ['ERASURE'] },
    });
    expect(decodedWithCallerFacts.mutation).toEqual(mutation);
    expect('receivedAt' in decodedWithCallerFacts.mutation).toBe(false);
    expect('requestedRights' in decodedWithCallerFacts.mutation).toBe(false);
  });

  it.effect('fails closed when authoritative DSR owner inventory is unavailable', () =>
    Effect.gen(function* rejectUnavailableOwnerInventory() {
      const error = yield* Effect.flip(dsrOwnerInventoryAuthorityUnavailable.resolve());

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it.effect('records a DSR owner task only from a trusted owner receipt', () =>
    Effect.gen(function* recordAuthoritativeOwnerTask() {
      let recorded: unknown;
      const { collector, context } = ownerTaskContext({
        authority: { resolve: () => Effect.succeed(authoritativeOwnerTask) },
        upsertDsrOwnerTask: (_tenant, _legalEntity, _invocation, authority) =>
          Effect.sync(() => {
            recorded = authority;
            return authority.task;
          }),
      });

      const result = yield* handleUpsertDsrOwnerTask(ownerTaskRequest, context);

      expect(recorded).toBe(authoritativeOwnerTask);
      expect(result.status).toBe('SUCCEEDED');
      expect(Option.getOrThrow(result.outcomeRef)).toBe('owner-receipt:1');
      expect(collector.snapshot().auditEvidence.recordId).toBe(result.taskRef);
    }),
  );

  it.effect('fails closed when the DSR owner task authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableOwnerTaskAuthority() {
      const { context } = ownerTaskContext({
        authority: dsrOwnerTaskAuthorityUnavailable,
        upsertDsrOwnerTask: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleUpsertDsrOwnerTask(ownerTaskRequest, context));

      expect(Schema.is(PrivacyOperationPersistenceError)(error)).toBe(true);
      expect(error.reason).toContain('not configured');
    }),
  );

  it.effect('rejects a trusted DSR owner result with a different exact scope', () =>
    Effect.gen(function* rejectMismatchedOwnerTask() {
      const { context } = ownerTaskContext({
        authority: {
          resolve: () =>
            Effect.succeed({
              ...authoritativeOwnerTask,
              task: { ...authoritativeOwnerTask.task, exactScopeRefs: ['scope:other'] },
            }),
        },
        upsertDsrOwnerTask: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleUpsertDsrOwnerTask(ownerTaskRequest, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('exact Case, owner, task, right, or scope');
    }),
  );
});
