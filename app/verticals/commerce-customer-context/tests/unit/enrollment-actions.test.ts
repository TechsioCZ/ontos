import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OperationalScope } from '@app/core-runtime';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type {
  ActionAccessEvidencePolicy,
  DomainEventContractMap,
} from '../../../../packages/core-runtime/src/actions/events.ts';
import { claimPortalEnrollmentTransitionAction } from '../../src/actions/claim-portal-enrollment-transition.action.ts';
import { recordPortalEnrollmentOutcomeAction } from '../../src/actions/record-portal-enrollment-outcome.action.ts';
import { startPortalEnrollmentAction } from '../../src/actions/start-portal-enrollment.action.ts';
import { terminatePortalEnrollmentAction } from '../../src/actions/terminate-portal-enrollment.action.ts';
import type {
  AttemptClaimResult,
  AttemptCreateResult,
  AttemptRecordResult,
  AttemptTerminateResult,
} from '../../src/enrollment/attempts/attempt-persistence.ts';
import type { CommerceEnrollmentAttemptService } from '../../src/enrollment/attempts/attempt-service.ts';
import type {
  CommerceEnrollmentPreparedOwnerBinding,
  CommerceEnrollmentPreparedOwnerCapability,
  CommerceEnrollmentPreparedOwnerEvidence,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import type {
  CommerceEnrollmentAttemptActionServices,
  CommerceEnrollmentPreparedAttemptActionServices,
} from '../../src/enrollment/orchestration/action-services.ts';
import type {
  CommercePortalAccountSubject,
  ClaimEnrollmentTransitionInput,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  ReconcileEnrollmentRequest,
  StartEnrollmentAttemptInput,
  TerminateEnrollmentAttemptInput,
} from '../../shared/enrollment-contracts.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import type { ClaimPortalEnrollmentTransitionPayload } from '../../shared/actions/claim-portal-enrollment-transition.ts';
import { ClaimPortalEnrollmentTransitionPayloadSchema } from '../../shared/actions/claim-portal-enrollment-transition.ts';
import type { RecordPortalEnrollmentOutcomePayload } from '../../shared/actions/record-portal-enrollment-outcome.ts';
import { RecordPortalEnrollmentOutcomePayloadSchema } from '../../shared/actions/record-portal-enrollment-outcome.ts';
import type { StartPortalEnrollmentPayload } from '../../shared/actions/start-portal-enrollment.ts';
import { StartPortalEnrollmentPayloadSchema } from '../../shared/actions/start-portal-enrollment.ts';
import type { TerminatePortalEnrollmentPayload } from '../../shared/actions/terminate-portal-enrollment.ts';
import { TerminatePortalEnrollmentPayloadSchema } from '../../shared/actions/terminate-portal-enrollment.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('20000000-0000-4000-8000-000000000001');
const actionInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(
  '30000000-0000-4000-8000-000000000001',
);
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('40000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('50000000-0000-4000-8000-000000000001');
const evidenceRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('60000000-0000-4000-8000-000000000001');
const operationId = Schema.decodeSync(EnrollmentOwnerOperationIdSchema)('80000000-0000-4000-8000-000000000001');
const ownerModuleKey = Schema.decodeSync(EnrollmentModuleKeySchema)('commerce.portal-auth');
const transitionKey = Schema.decodeSync(EnrollmentTransitionKeySchema)('provider.account.create');
const intentKey = Schema.decodeSync(EnrollmentKeySchema)('portal.enrollment.start');
const outcomeCode = Schema.decodeSync(EnrollmentKeySchema)('provider_account_created');
const workerId = Schema.decodeSync(EnrollmentKeySchema)(`commerce.customer-context.action:${actionInvocationId}`);
const at = DateTime.makeUnsafe('2026-09-16T10:00:00.000Z');
const subject: CommercePortalAccountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
  providerSubjectId: 'provider-user-1',
  subjectType: 'user',
});

const scope: OperationalScope = {
  authMethod: 'system',
  correlationId: 'enrollment-actions-unit',
  principalId: actorPrincipalId,
  tenantId,
};

const startPayload: StartPortalEnrollmentPayload = Schema.decodeSync(StartPortalEnrollmentPayloadSchema)({
  intentDigest: 'a'.repeat(64),
  intentKey,
  journey: 'RETAIL_SELF_ENROLLMENT',
});

const claimPayload: ClaimPortalEnrollmentTransitionPayload = Schema.decodeSync(
  ClaimPortalEnrollmentTransitionPayloadSchema,
)({
  expectedRevision: 1,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  requestDigest: 'b'.repeat(64),
  transitionKey,
});

const recordPayload: RecordPortalEnrollmentOutcomePayload = Schema.decodeSync(
  RecordPortalEnrollmentOutcomePayloadSchema,
)({
  expectedRevision: 2,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  transitionKey,
});

const terminatePayload: TerminatePortalEnrollmentPayload = Schema.decodeSync(TerminatePortalEnrollmentPayloadSchema)({
  expectedRevision: 1,
  portalEnrollmentAttemptId: attemptId,
  reason: 'The provider transition is no longer required',
});

const makeAttempt = (overrides: Partial<EnrollmentAttemptSnapshot> = {}): EnrollmentAttemptSnapshot => ({
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'a'.repeat(64),
  intentKey,
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: attemptId,
  revision: 1,
  state: 'IN_PROGRESS',
  tenantId,
  updatedAt: at,
  ...overrides,
});

const makeOperation = (
  overrides: Partial<EnrollmentOwnerOperationSnapshot> = {},
): EnrollmentOwnerOperationSnapshot => ({
  actorPrincipalId,
  createdAt: at,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  portalEnrollmentOwnerOperationId: operationId,
  requestDigest: 'b'.repeat(64),
  required: true,
  revision: 1,
  status: 'IN_PROGRESS',
  tenantId,
  transitionKey,
  updatedAt: at,
  ...overrides,
});

const unusedAttemptService = (): CommerceEnrollmentAttemptService => ({
  claimTransition: () => Effect.die('unused claimTransition'),
  read: () => Effect.die('unused read'),
  readOwnerOperation: () => Effect.die('unused readOwnerOperation'),
  reconcileOutcome: () => Effect.die('unused reconcileOutcome'),
  recordOutcome: () => Effect.die('unused recordOutcome'),
  start: () => Effect.die('unused start'),
  terminate: () => Effect.die('unused terminate'),
});

const collectorFor = <DomainEvents extends DomainEventContractMap>(action: {
  readonly descriptor: {
    readonly accessEvidencePolicy: ActionAccessEvidencePolicy;
    readonly domainEvents: DomainEvents;
    readonly owningModuleKey: string;
  };
}) =>
  createActionCollector(
    action.descriptor.domainEvents,
    'commerce.customer-context',
    action.descriptor.accessEvidencePolicy,
  );

const handlerContext = <Services>(collector: ReturnType<typeof collectorFor>, services: Services) => ({
  actionInvocationId: String(actionInvocationId),
  addDomainEvent: collector.addDomainEvent,
  addOutboxMessage: collector.addOutboxMessage,
  recordAuditEvidence: collector.recordAuditEvidence,
  recordDataAccess: collector.recordDataAccess,
  scope,
  services,
});

const preparedEvidence = (
  binding: CommerceEnrollmentPreparedOwnerBinding,
): CommerceEnrollmentPreparedOwnerEvidence => ({ ...binding, evidenceRef });

const preparedOwner = (
  onTake: (binding: CommerceEnrollmentPreparedOwnerBinding) => void,
): CommerceEnrollmentPreparedOwnerCapability['Service'] => ({
  take: (binding) =>
    Effect.sync(() => {
      onTake(binding);
      return preparedEvidence(binding);
    }),
});

it.effect('start derives Actor, Tenant and Action invocation from trusted Core context', () =>
  Effect.gen(function* startsEnrollment() {
    let request: StartEnrollmentAttemptInput | undefined;
    const attemptResult: AttemptCreateResult = { attempt: makeAttempt(), outcome: 'CREATED' };
    const services: CommerceEnrollmentAttemptActionServices = {
      attempt: {
        ...unusedAttemptService(),
        start: (input) =>
          Effect.sync(() => {
            request = input;
            return attemptResult;
          }),
      },
    };
    const collector = collectorFor(startPortalEnrollmentAction);
    const result = yield* getActionHandler(startPortalEnrollmentAction)(
      startPayload,
      handlerContext(collector, services),
    );
    if (!('attempt' in result)) {
      throw new Error('start action did not return a committed Attempt result');
    }
    expect(result.outcome).toBe('CREATED');
    expect(request?.actionInvocationId).toBe(actionInvocationId);
    expect(request?.actorPrincipalId).toBe(actorPrincipalId);
    expect(request?.tenantId).toBe(tenantId);
    expect(collector.snapshot().domainEvents).toHaveLength(0);
  }),
);

it.effect('claim authorizes the exact prepared binding before durable transition claim', () =>
  // @ts-expect-error -- This direct-handler test supplies a request-scoped owner capability double.
  Effect.gen(function* claimsTransition() {
    let binding: CommerceEnrollmentPreparedOwnerBinding | undefined;
    let request: ClaimEnrollmentTransitionInput | undefined;
    const claimResult: AttemptClaimResult = {
      attempt: makeAttempt({ revision: 2 }),
      operation: makeOperation(),
      outcome: 'CLAIMED',
    };
    const services: CommerceEnrollmentPreparedAttemptActionServices = {
      attempt: {
        ...unusedAttemptService(),
        claimTransition: (input) =>
          Effect.sync(() => {
            request = input;
            return claimResult;
          }),
      },
      preparedOwner: preparedOwner((value) => {
        binding = value;
      }),
      reconcilePrepared: () => Effect.die('unused reconcilePrepared'),
    };
    const collector = collectorFor(claimPortalEnrollmentTransitionAction);
    const result = yield* getActionHandler(claimPortalEnrollmentTransitionAction)(
      claimPayload,
      handlerContext(collector, services),
    );
    if (!('operation' in result)) {
      throw new Error('claim action did not return a committed owner operation');
    }
    expect(result.outcome).toBe('CLAIMED');
    expect(binding?.actionInvocationId).toBe(actionInvocationId);
    expect(binding?.actorPrincipalId).toBe(actorPrincipalId);
    expect(binding?.tenantId).toBe(tenantId);
    expect(binding?.actionKey).toBe(CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY);
    expect(request?.workerId).toBe(workerId);
    expect(request?.actorPrincipalId).toBe(actorPrincipalId);
    expect(request?.tenantId).toBe(tenantId);
    expect(request?.expectedRevision).toBe(claimPayload.expectedRevision);
  }),
);

it.effect('record consumes prepared owner evidence and carries only trusted reconciliation metadata', () =>
  // @ts-expect-error -- This direct-handler test supplies a request-scoped owner capability double.
  Effect.gen(function* recordsOutcome() {
    let binding: CommerceEnrollmentPreparedOwnerBinding | undefined;
    let request: ReconcileEnrollmentRequest | undefined;
    let consumedEvidence: CommerceEnrollmentPreparedOwnerEvidence | undefined;
    const recordResult: AttemptRecordResult = {
      attempt: makeAttempt({ accountSubject: subject, revision: 3, state: 'COMPLETE' }),
      operation: makeOperation({ outcomeCode, revision: 2, status: 'SUCCEEDED' }),
      outcome: 'RECORDED',
    };
    const services: CommerceEnrollmentPreparedAttemptActionServices = {
      attempt: unusedAttemptService(),
      preparedOwner: preparedOwner((value) => {
        binding = value;
      }),
      reconcilePrepared: (input, evidence) =>
        Effect.sync(() => {
          request = input;
          consumedEvidence = evidence;
          return recordResult;
        }),
    };
    const collector = collectorFor(recordPortalEnrollmentOutcomeAction);
    const result = yield* getActionHandler(recordPortalEnrollmentOutcomeAction)(
      recordPayload,
      handlerContext(collector, services),
    );
    if (!('operation' in result)) {
      throw new Error('record action did not return a committed owner outcome');
    }
    expect(result.outcome).toBe('RECORDED');
    expect(binding?.actionInvocationId).toBe(actionInvocationId);
    expect(binding?.actionKey).toBe(RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY);
    expect(request?.expectedRevision).toBe(recordPayload.expectedRevision);
    expect(request?.tenantId).toBe(tenantId);
    expect(Object.hasOwn(request ?? {}, 'status')).toBe(false);
    expect(consumedEvidence?.evidenceRef).toBe(evidenceRef);
    expect(collector.snapshot().outboxMessages).toHaveLength(0);
  }),
);

it.effect('terminate derives the trusted Actor, Tenant and invocation for the terminal Attempt fence', () =>
  Effect.gen(function* terminatesEnrollment() {
    let request: TerminateEnrollmentAttemptInput | undefined;
    const terminateResult: AttemptTerminateResult = {
      attempt: makeAttempt({ revision: 2, state: 'TERMINATED', terminatedAt: at }),
      outcome: 'TERMINATED',
    };
    const services: CommerceEnrollmentAttemptActionServices = {
      attempt: {
        ...unusedAttemptService(),
        terminate: (input) =>
          Effect.sync(() => {
            request = input;
            return terminateResult;
          }),
      },
    };
    const collector = collectorFor(terminatePortalEnrollmentAction);
    const result = yield* getActionHandler(terminatePortalEnrollmentAction)(
      terminatePayload,
      handlerContext(collector, services),
    );
    if (!('attempt' in result)) {
      throw new Error('terminate action did not return a committed terminal Attempt result');
    }
    expect(result.outcome).toBe('TERMINATED');
    expect(request?.actionInvocationId).toBe(actionInvocationId);
    expect(request?.actorPrincipalId).toBe(actorPrincipalId);
    expect(request?.tenantId).toBe(tenantId);
    expect(request?.portalEnrollmentAttemptId).toBe(attemptId);
    expect(request?.reason).toBe(terminatePayload.reason);
  }),
);
