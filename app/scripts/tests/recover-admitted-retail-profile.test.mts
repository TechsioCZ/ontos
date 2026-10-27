import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { Cause, ConfigProvider, DateTime, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { ownerUnavailable } from '../../verticals/commerce-customer-context/src/enrollment/orchestration/owner-effect-codec.ts';

import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  AdmittedRetailProfileRecoveryError,
  AdmittedRetailProfileRecoveryRuntime,
  RecoveryCoreEvidenceSchema,
  RecoveryRequestSchema,
  claimApprovedRetailProfileFence,
  recoverAdmittedRetailProfile,
  withRetailProfileRecoveryDeadline,
} from '../../verticals/commerce-customer-context/scripts/recover-admitted-retail-profile-program.mts';
import type {
  RecoveryObservation,
  RecoveryRequest,
} from '../../verticals/commerce-customer-context/scripts/recover-admitted-retail-profile-program.mts';
import {
  claimRetailProfileWithAtomicApproval,
  runRetailProfileRecoveryCommand,
} from '../../verticals/commerce-customer-context/scripts/recover-admitted-retail-profile.mts';
import {
  ClaimEnrollmentTransitionInputSchema,
  EnrollmentAttemptSnapshotSchema,
  EnrollmentOwnerOperationSnapshotSchema,
} from '../../verticals/commerce-customer-context/shared/enrollment-contracts.ts';
import { EnsureRetailCustomerProfileResultSchema } from '../../verticals/commerce-customer-context/shared/actions/ensure-retail-customer-profile.ts';
import type { EnsureRetailCustomerProfilePayload } from '../../verticals/commerce-customer-context/shared/actions/ensure-retail-customer-profile.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../verticals/commerce-customer-context/src/enrollment/attempts/errors.ts';
import {
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  retailSelfEnrollmentRequestDigest,
} from '../../verticals/commerce-customer-context/src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { CommerceEnrollmentOwnerAttemptStore } from '../../verticals/commerce-customer-context/src/enrollment/orchestration/owner-transition-driver.ts';

const COMMERCE_OWNER = 'commerce.customer-context';
const OTHER_OPERATION = 'other-operation';
const LEGAL_ENTITY_TYPE = 'core.identity.legal-entity';
const APPROVAL_MISMATCH = 'approval-mismatch';
const RECONCILIATION_REQUIRED = 'RECONCILIATION_REQUIRED';
const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const sourceRevision = 'a'.repeat(40);
const request = Schema.decodeSync(RecoveryRequestSchema)({
  actorPrincipalId: id(1),
  attemptId: id(2),
  compositionRevision: 'b'.repeat(64),
  expectedAttemptRevision: 9,
  expectedOperationRevision: 1,
  operationId: id(3),
  ownerInvocationId: id(4),
  receiptId: id(5),
  servicePrincipalId: id(6),
  tenantId: id(7),
});
const at = '2026-10-26T19:00:00.000Z';
const expired = { leaseExpiresAt: '1960-01-01T00:00:00.000Z', leaseToken: id(8), workerId: 'original-worker' };
const partyRef = {
  moduleId: 'party.registry',
  resourceId: id(9),
  resourceType: 'party.registry.party',
  tenantId: request.tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: id(10),
  resourceType: LEGAL_ENTITY_TYPE,
  tenantId: request.tenantId,
} as const;
const digest = retailSelfEnrollmentRequestDigest({
  intent: { partyRef, sellingLegalEntityRef, step: 'RETAIL_CUSTOMER_PROFILE' },
  ownerModuleKey: COMMERCE_OWNER,
  portalEnrollmentAttemptId: request.attemptId,
  transitionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
});
const profile = Schema.decodeSync(EnsureRetailCustomerProfileResultSchema)({
  outcome: 'PROFILE_CREATED',
  profileRef: {
    moduleId: COMMERCE_OWNER,
    resourceId: id(11),
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId: request.tenantId,
  },
  revision: 1,
  state: 'ACTIVE',
});

const observation = (): RecoveryObservation => ({
  attempt: Schema.decodeSync(EnrollmentAttemptSnapshotSchema)({
    compositionRevision: request.compositionRevision,
    createdAt: at,
    createdByPrincipalId: request.actorPrincipalId,
    intentDigest: 'c'.repeat(64),
    intentKey: 'original-intent',
    journey: 'RETAIL_SELF_ENROLLMENT',
    lease: expired,
    portalEnrollmentAttemptId: request.attemptId,
    revision: request.expectedAttemptRevision,
    state: 'IN_PROGRESS',
    targetLegalEntityId: sellingLegalEntityRef.resourceId,
    tenantId: request.tenantId,
    updatedAt: at,
  }),
  core: Schema.decodeSync(RecoveryCoreEvidenceSchema)({
    admissionClosed: true,
    authorityActive: true,
    authorityFresh: true,
    authorityRevision: request.compositionRevision,
    durablePresent: true,
    receiptActionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
    receiptAuthMethod: 'api_key',
    receiptCompleted: false,
    receiptId: request.receiptId,
    receiptIdempotencyKey: request.ownerInvocationId,
    receiptLegalEntityId: sellingLegalEntityRef.resourceId,
    receiptPrincipalId: request.servicePrincipalId,
    receiptRequestHash: 'd'.repeat(64),
    receiptStatus: 'received',
    receiptTenantId: request.tenantId,
  }),
  operation: Schema.decodeSync(EnrollmentOwnerOperationSnapshotSchema)({
    actorPrincipalId: request.actorPrincipalId,
    createdAt: at,
    lease: expired,
    ownerInvocationId: request.ownerInvocationId,
    ownerModuleKey: COMMERCE_OWNER,
    portalEnrollmentAttemptId: request.attemptId,
    portalEnrollmentOwnerOperationId: request.operationId,
    requestDigest: digest,
    required: true,
    revision: request.expectedOperationRevision,
    status: 'IN_PROGRESS',
    tenantId: request.tenantId,
    transitionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
    updatedAt: at,
  }),
  partyOperation: Schema.decodeSync(EnrollmentOwnerOperationSnapshotSchema)({
    actorPrincipalId: request.actorPrincipalId,
    createdAt: at,
    ownerInvocationId: id(12),
    ownerModuleKey: 'party.registry',
    portalEnrollmentAttemptId: request.attemptId,
    portalEnrollmentOwnerOperationId: id(13),
    requestDigest: 'e'.repeat(64),
    required: true,
    resultReference: partyRef.resourceId,
    revision: 2,
    status: 'SUCCEEDED',
    tenantId: request.tenantId,
    transitionKey: 'party.candidate.submit',
    updatedAt: at,
  }),
  profile: Option.none(),
});

const scenario = () => {
  let current = observation();
  let claims = 0;
  let settlements = 0;
  let dispatches = 0;
  let ownerReads = 0;
  let commandReads = 0;
  let journalFailure = false;
  let lostResponse = false;
  let nativeState: 'RETRYABLE' | 'COMMITTED' | 'RUNNING' | 'NOT_STARTED' = 'RETRYABLE';
  let nativeReceiptId = request.receiptId;
  const payloads: { readonly key: string; readonly payload: EnsureRetailCustomerProfilePayload }[] = [];
  const store: CommerceEnrollmentOwnerAttemptStore = {
    claimTransition: () =>
      Effect.sync(() => {
        claims += 1;
        const { lease: attemptLease, ...attempt } = current.attempt;
        const { lease: operationLease, ...operation } = current.operation;
        void attemptLease;
        void operationLease;
        current = {
          ...current,
          attempt: { ...attempt, revision: attempt.revision + 1, state: RECONCILIATION_REQUIRED },
          operation: { ...operation, revision: operation.revision + 1, status: 'INDETERMINATE' },
        };
        return { attempt: current.attempt, outcome: 'INDETERMINATE' as const };
      }),
    read: () => Effect.sync(() => current.attempt),
    readOwnerOperation: () => Effect.sync(() => current.operation),
    reconcileOutcome: (_input, resolution) =>
      Effect.gen(function* settleOnlyExistingProfile() {
        if (journalFailure) {
          return yield* new CommerceEnrollmentAttemptUnavailable({
            code: 'attempt_unavailable',
            reason: 'Fixture native journal failure',
            retryable: true,
          });
        }
        settlements += 1;
        current = {
          ...current,
          attempt: { ...current.attempt, revision: current.attempt.revision + 1, state: 'IN_PROGRESS' },
          core: { ...current.core, durablePresent: false },
          operation: {
            ...current.operation,
            completedAt: DateTime.makeUnsafe(at),
            resultReference: resolution.resultReference,
            revision: current.operation.revision + 1,
            status: 'SUCCEEDED',
          },
        };
        return { attempt: current.attempt, operation: current.operation, outcome: 'RECORDED' as const };
      }),
    recordOutcome: () => Effect.die('Operator must never call ordinary recordOutcome'),
  };
  const runtime: typeof AdmittedRetailProfileRecoveryRuntime.Service = {
    executeProfile: () => (payload, _correlation, options) =>
      Effect.gen(function* executeOriginalProfile() {
        dispatches += 1;
        payloads.push({ key: options.idempotencyKey, payload });
        current = {
          ...current,
          core: { ...current.core, receiptCompleted: true, receiptStatus: 'succeeded' },
          profile: Option.some(profile),
        };
        nativeState = 'COMMITTED';
        if (lostResponse) {
          return yield* new CommerceEnrollmentAttemptUnavailable({
            code: 'attempt_unavailable',
            reason: 'Fixture lost response',
            retryable: true,
          });
        }
        return profile;
      }).pipe(Effect.mapError(() => ownerUnavailable('fixture_unavailable', 'Fixture response unavailable'))),
    observe: () => Effect.sync(() => current),
    resolveCommand: () =>
      Effect.sync(() => {
        commandReads += 1;
        if (nativeState === 'NOT_STARTED') {
          return { retryCommand: true, state: 'NOT_STARTED' as const };
        }
        if (nativeState === 'RETRYABLE') {
          return { invocationId: nativeReceiptId, retryCommand: true, state: 'RETRYABLE' as const };
        }
        return { invocationId: nativeReceiptId, retryCommand: false, state: nativeState };
      }),
    run: (scope, body) =>
      Effect.suspend(() => {
        ownerReads += 1;
        return body(
          scopedRoutineInvokerFromTransaction(
            () =>
              Effect.succeed(
                Option.isSome(current.profile)
                  ? [
                      {
                        outcome: 'PROFILE_AVAILABLE',
                        payload: Schema.encodeSync(EnsureRetailCustomerProfileResultSchema)(current.profile.value),
                      },
                    ]
                  : [{ outcome: 'PROFILE_NOT_FOUND', payload: null }],
              ),
            scope,
          ),
        );
      }),
    store: () => store,
  };
  return {
    change: (next: RecoveryObservation) => {
      current = next;
    },
    counts: () => ({ claims, commandReads, dispatches, ownerReads, settlements }),
    current: () => current,
    failJournal: () => {
      journalFailure = true;
    },
    loseResponse: () => {
      lostResponse = true;
    },
    native: (state: typeof nativeState) => {
      nativeState = state;
    },
    payloads,
    receipt: (receiptId: typeof nativeReceiptId) => {
      nativeReceiptId = receiptId;
    },
    runtime,
    store,
  };
};

const checked = (test: ReturnType<typeof scenario>, target: RecoveryRequest = request) =>
  recoverAdmittedRetailProfile({ mode: 'check', request: target, sourceRevision }).pipe(
    Effect.provideService(AdmittedRetailProfileRecoveryRuntime, test.runtime),
  );
const reconciled = (
  test: ReturnType<typeof scenario>,
  approvalSha256?: string,
  target = request,
  source = sourceRevision,
) =>
  recoverAdmittedRetailProfile({ approvalSha256, mode: 'reconcile', request: target, sourceRevision: source }).pipe(
    Effect.provideService(AdmittedRetailProfileRecoveryRuntime, test.runtime),
  );

it.effect('check performs zero native writes or gateway calls and returns a stable source-bound approval', () =>
  Effect.gen(function* readOnlyCheck() {
    const test = scenario();
    const first = yield* checked(test);
    expect(yield* checked(test)).toEqual(first);
    expect(first.status).toBe('checked');
    expect(first.approvalSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(test.counts()).toEqual({ claims: 0, commandReads: 0, dispatches: 0, ownerReads: 0, settlements: 0 });
    const serialized = Schema.encodeSync(Schema.fromJsonString(RecoveryRequestSchema))(request);
    expect(serialized).not.toContain('password');
  }),
);

it.effect(
  'RETRYABLE retries the exact original key and payload, settles only this operation and reads native accounting',
  () =>
    Effect.gen(function* retryExactOriginalCommand() {
      const test = scenario();
      const check = yield* checked(test);
      const result = yield* reconciled(test, check.approvalSha256);
      expect(result.status).toBe('reconciled');
      expect(test.payloads).toEqual([
        {
          key: request.ownerInvocationId,
          payload: {
            effectiveAt: at,
            subject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
            trigger: 'AUTHORIZED_ONBOARDING',
          },
        },
      ]);
      expect(test.counts().claims).toBe(1);
      expect(test.counts().dispatches).toBe(1);
      expect(test.counts().settlements).toBe(1);
      expect(test.current().attempt.state).toBe('IN_PROGRESS');
      expect(test.current().operation.status).toBe('SUCCEEDED');
      expect(test.current().core.durablePresent).toBe(false);
    }),
);

it.effect('COMMITTED reads the actual scoped profile without redispatch', () =>
  Effect.gen(function* readCommittedOwnerResult() {
    const test = scenario();
    test.native('COMMITTED');
    test.change({
      ...test.current(),
      core: { ...test.current().core, receiptCompleted: true, receiptStatus: 'succeeded' },
      profile: Option.some(profile),
    });
    yield* reconciled(test, (yield* checked(test)).approvalSha256);
    expect(test.counts().dispatches).toBe(0);
    expect(test.counts().ownerReads).toBe(1);
    expect(test.counts().settlements).toBe(1);
  }),
);

it.effect('rejects absent, changed and source-revision-stale approval before native fencing', () =>
  Effect.gen(function* rejectUnapprovedMutation() {
    const test = scenario();
    const check = yield* checked(test);
    expect((yield* Effect.flip(reconciled(test))).reason).toBe('approval-required');
    expect((yield* Effect.flip(reconciled(test, 'f'.repeat(64)))).reason).toBe(APPROVAL_MISMATCH);
    expect((yield* Effect.flip(reconciled(test, check.approvalSha256, request, 'f'.repeat(40)))).reason).toBe(
      APPROVAL_MISMATCH,
    );
    test.change({ ...test.current(), core: { ...test.current().core, receiptRequestHash: 'f'.repeat(64) } });
    expect((yield* Effect.flip(reconciled(test, check.approvalSha256))).reason).toBe(APPROVAL_MISMATCH);
    expect(test.counts().claims).toBe(0);
  }),
);

it.effect(
  'rejects stale revisions, wrong actor/op/digest/receipt/service identity, scope, live leases and authority',
  () =>
    Effect.gen(function* rejectMismatchedEvidence() {
      const baseline = observation();
      const cases: readonly RecoveryObservation[] = [
        { ...baseline, attempt: { ...baseline.attempt, revision: 10 } },
        { ...baseline, operation: { ...baseline.operation, revision: 2 } },
        {
          ...baseline,
          operation: {
            ...baseline.operation,
            portalEnrollmentOwnerOperationId: Schema.decodeSync(RecoveryRequestSchema)({
              ...request,
              operationId: id(99),
            }).operationId,
          },
        },
        { ...baseline, operation: { ...baseline.operation, actorPrincipalId: request.servicePrincipalId } },
        { ...baseline, operation: { ...baseline.operation, requestDigest: 'f'.repeat(64) } },
        { ...baseline, core: { ...baseline.core, receiptId: request.ownerInvocationId } },
        { ...baseline, core: { ...baseline.core, receiptPrincipalId: request.actorPrincipalId } },
        {
          ...baseline,
          core: {
            ...baseline.core,
            receiptTenantId: Schema.decodeSync(RecoveryRequestSchema)({ ...request, tenantId: id(98) }).tenantId,
          },
        },
        {
          ...baseline,
          core: {
            ...baseline.core,
            receiptLegalEntityId: Schema.decodeSync(RecoveryCoreEvidenceSchema)({
              ...baseline.core,
              receiptLegalEntityId: id(99),
            }).receiptLegalEntityId,
          },
        },
        { ...baseline, core: { ...baseline.core, authorityFresh: false } },
        { ...baseline, core: { ...baseline.core, authorityActive: false } },
        { ...baseline, core: { ...baseline.core, authorityRevision: 'f'.repeat(64) } },
        { ...baseline, core: { ...baseline.core, admissionClosed: false } },
        { ...baseline, attempt: { ...baseline.attempt, state: 'COMPLETE' } },
        {
          ...baseline,
          operation: {
            ...baseline.operation,
            lease: Schema.decodeSync(EnrollmentOwnerOperationSnapshotSchema)({
              ...Schema.encodeSync(EnrollmentOwnerOperationSnapshotSchema)(baseline.operation),
              lease: { ...expired, leaseExpiresAt: '2099-01-01T00:00:00.000Z' },
            }).lease,
          },
        },
        { ...baseline, core: { ...baseline.core, receiptStatus: 'running' } },
        { ...baseline, core: { ...baseline.core, receiptStatus: 'indeterminate' } },
      ];
      for (const candidate of cases) {
        const test = scenario();
        test.change(candidate);
        expect(yield* Effect.flip(checked(test))).toBeInstanceOf(AdmittedRetailProfileRecoveryError);
        expect(test.counts().claims).toBe(0);
        expect(test.counts().dispatches).toBe(0);
        expect(test.counts().commandReads).toBe(0);
      }
    }),
);

it.effect('native NOT_STARTED, RUNNING and different receipt never authorize a retry or settlement', () =>
  Effect.gen(function* stopUnprovenNativeIdentity() {
    for (const state of ['NOT_STARTED', 'RUNNING', 'RETRYABLE'] as const) {
      const test = scenario();
      test.native(state);
      if (state === 'RETRYABLE') {
        test.receipt(request.ownerInvocationId);
      }
      expect(yield* Effect.flip(reconciled(test, (yield* checked(test)).approvalSha256))).toBeInstanceOf(
        AdmittedRetailProfileRecoveryError,
      );
      expect(test.counts().dispatches).toBe(0);
      expect(test.counts().settlements).toBe(0);
      expect(test.current().core.durablePresent).toBe(true);
    }
  }),
);

it.effect(
  'journal failure and lost response retain the blocker, then COMMITTED readback settles without a second execution',
  () =>
    Effect.gen(function* retainUnknownOutcome() {
      for (const fail of ['journal', 'response'] as const) {
        const test = scenario();
        if (fail === 'journal') {
          test.failJournal();
        } else {
          test.loseResponse();
        }
        yield* Effect.flip(reconciled(test, (yield* checked(test)).approvalSha256));
        expect(test.current().core.durablePresent).toBe(true);
        expect(test.current().operation.status).toBe('INDETERMINATE');
        expect(test.counts().dispatches).toBe(1);
        const restarted = scenario();
        restarted.change(test.current());
        restarted.native('COMMITTED');
        const refreshed = {
          ...request,
          expectedAttemptRevision: test.current().attempt.revision,
          expectedOperationRevision: test.current().operation.revision,
        };
        yield* reconciled(restarted, (yield* checked(restarted, refreshed)).approvalSha256, refreshed);
        expect(restarted.counts().dispatches).toBe(0);
        expect(restarted.counts().settlements).toBe(1);
      }
    }),
);

it.effect('timeouts are typed failures, never success', () =>
  Effect.gen(function* deadline() {
    for (const mode of ['check', 'reconcile'] as const) {
      const fiber = yield* withRetailProfileRecoveryDeadline(Effect.never, mode).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(mode === 'check' ? '30 seconds' : '60 seconds');
      expect((yield* Fiber.join(fiber)).reason).toBe('timeout');
    }
  }),
);

it.effect('command defaults to check, rejects non-stage and never reads dotenv for configuration', () =>
  Effect.gen(function* configBoundary() {
    const test = scenario();
    const environment = {
      ONTOS_STAGE_PROFILE_RECOVERY_REQUEST_JSON: Schema.encodeSync(Schema.fromJsonString(RecoveryRequestSchema))(
        request,
      ),
      ONTOS_STAGE_PROFILE_RECOVERY_SOURCE_REVISION: sourceRevision,
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    };
    expect(
      (yield* runRetailProfileRecoveryCommand.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        Effect.provideService(AdmittedRetailProfileRecoveryRuntime, test.runtime),
      )).status,
    ).toBe('checked');
    expect(
      yield* Effect.flip(
        runRetailProfileRecoveryCommand.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ...environment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' }),
          ),
          Effect.provideService(AdmittedRetailProfileRecoveryRuntime, test.runtime),
        ),
      ),
    ).toBeInstanceOf(AdmittedRetailProfileRecoveryError);
  }),
);

/** SQL rows for the real native routine decoder in the atomic transaction regression below. */
const attemptRow = (current: RecoveryObservation, outcome: string) => ({
  attempt_outcome: outcome,
  authentication_namespace_id: null,
  completed_at: null,
  composition_revision: current.attempt.compositionRevision,
  created_at: at,
  created_by_principal_id: request.actorPrincipalId,
  failure_code: null,
  failure_reason: null,
  intent_digest: current.attempt.intentDigest,
  intent_key: current.attempt.intentKey,
  invitation_id: null,
  journey: current.attempt.journey,
  last_failure_code: null,
  last_failure_reason: null,
  last_owner_invocation_id: null,
  lease_expires_at: null,
  lease_owner: null,
  lease_token: null,
  operation_actor_principal_id: null,
  operation_id: null,
  operation_lease_expires_at: null,
  operation_lease_owner: null,
  operation_lease_token: null,
  operation_revision: null,
  operation_status: null,
  outcome_code: null,
  owner_invocation_id: null,
  owner_module_key: null,
  portal_enrollment_attempt_id: request.attemptId,
  provider_subject_id: null,
  reconciliation_ref: null,
  request_digest: null,
  required: null,
  result_digest: null,
  result_reference: null,
  revision: current.attempt.revision,
  state: current.attempt.state,
  subject_type: null,
  target_legal_entity_id: sellingLegalEntityRef.resourceId,
  target_resource_id: null,
  tenant_id: request.tenantId,
  terminated_at: null,
  transition_key: null,
  updated_at: at,
});
const operationRow = (current: RecoveryObservation) => ({
  actor_principal_id: request.actorPrincipalId,
  completed_at: null,
  created_at: at,
  failure_code: null,
  failure_reason: null,
  lease_expires_at: null,
  lease_owner: null,
  lease_token: null,
  operation_outcome: 'READ',
  outcome_code: null,
  owner_invocation_id: request.ownerInvocationId,
  owner_module_key: current.operation.ownerModuleKey,
  portal_enrollment_attempt_id: request.attemptId,
  portal_enrollment_owner_operation_id: request.operationId,
  reconciliation_ref: null,
  request_digest: digest,
  required: true,
  result_digest: null,
  result_reference: null,
  revision: current.operation.revision,
  status: current.operation.status,
  tenant_id: request.tenantId,
  transition_key: current.operation.transitionKey,
  updated_at: at,
});

it.effect(
  'production atomic claim rolls back if a concurrent revision advances after the driver read and before native claim',
  () =>
    Effect.gen(function* atomicFenceRollback() {
      for (const defect of ['revision', OTHER_OPERATION, 'none'] as const) {
        const statements: string[] = [];
        const initial = observation();
        let current = initial;
        const database = yield* makeTestDatabase((statement) => {
          statements.push(statement);
          if (statement.includes('as approved')) {
            return Effect.succeed([{ approved: true }]);
          }
          if (statement.includes('read_portal_enrollment_owner_operation')) {
            return Effect.succeed([operationRow(current)]);
          }
          if (statement.includes('read_portal_enrollment_attempt')) {
            return Effect.succeed([attemptRow(current, 'READ')]);
          }
          if (statement.includes('claim_portal_enrollment_transition')) {
            current = {
              ...current,
              attempt: {
                ...current.attempt,
                revision: current.attempt.revision + (defect === 'revision' ? 2 : 1),
                state: RECONCILIATION_REQUIRED,
              },
              operation: {
                ...current.operation,
                revision: current.operation.revision + (defect === OTHER_OPERATION ? 0 : 1),
                status: defect === OTHER_OPERATION ? 'IN_PROGRESS' : 'INDETERMINATE',
              },
            };
            return Effect.succeed([attemptRow(current, 'INDETERMINATE')]);
          }
          return Effect.succeed([]);
        });
        const input = Schema.decodeSync(ClaimEnrollmentTransitionInputSchema)({
          actorPrincipalId: request.actorPrincipalId,
          expectedRevision: request.expectedAttemptRevision,
          leaseDurationMs: 30_000,
          ownerInvocationId: request.ownerInvocationId,
          ownerModuleKey: initial.operation.ownerModuleKey,
          portalEnrollmentAttemptId: request.attemptId,
          requestDigest: digest,
          required: true,
          tenantId: request.tenantId,
          transitionKey: initial.operation.transitionKey,
          workerId: 'bounded-profile-recovery',
        });
        const result = yield* Effect.exit(
          database.transaction((transaction) => claimRetailProfileWithAtomicApproval(transaction, initial, input)),
        );
        expect(statements[0]).toMatch(/begin/iu);
        expect(
          statements.some((statement) => statement.includes('claim_portal_enrollment_transition')),
          (Exit.isFailure(result) ? Cause.pretty(result.cause) : 'ok') + statements.join('\n'),
        ).toBe(true);
        expect(statements.at(-1)).toMatch(defect === 'none' ? /commit/iu : /rollback/iu);
        if (defect !== 'none') {
          expect(statements.some((statement) => /^commit/iu.test(statement))).toBe(false);
        }
        expect(Exit.isSuccess(result)).toBe(defect === 'none');
      }
    }),
);

it.effect('approved fence rejects a revision already changed before native claim without invoking the claim', () =>
  Effect.gen(function* preclaimConflict() {
    const test = scenario();
    const initial = observation();
    test.change({ ...initial, attempt: { ...initial.attempt, revision: 10 } });
    const input = Schema.decodeSync(ClaimEnrollmentTransitionInputSchema)({
      actorPrincipalId: request.actorPrincipalId,
      expectedRevision: 9,
      leaseDurationMs: 30_000,
      ownerInvocationId: request.ownerInvocationId,
      ownerModuleKey: initial.operation.ownerModuleKey,
      portalEnrollmentAttemptId: request.attemptId,
      requestDigest: digest,
      required: true,
      tenantId: request.tenantId,
      transitionKey: initial.operation.transitionKey,
      workerId: 'bounded-profile-recovery',
    });
    yield* Effect.flip(claimApprovedRetailProfileFence(initial, input, test.store));
    expect(test.counts().claims).toBe(0);
  }),
);
