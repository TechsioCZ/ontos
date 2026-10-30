import { randomUUID } from 'node:crypto';

import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  claimWithReconciliation,
  commercePortalAuthEnrollmentBindingEstablished,
  commercePortalAuthEnrollmentClaimableAttempt,
  commercePortalAuthEnrollmentClaimantBinding,
} from '../../api/portal-auth/enrollment/claim-invitation.ts';
import {
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  CORE_IDENTITY_OWNER_MODULE_KEY,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
} from '../../src/enrollment/journeys/existing-account.ts';
import {
  EnrollmentAttemptSnapshotSchema,
  EnrollmentKeySchema,
  ReconcileEnrollmentResolutionSchema,
  EnrollmentOwnerOperationSnapshotSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';
import {
  CommerceEnrollmentOwnerTransitionSchema,
  commerceEnrollmentOwnerTransitionDriverFor,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerAttemptStore } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE } from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

/**
 * The invitation claim route's three decisions, every one of them taken from durable Attempt state
 * alone: whether an Attempt can be claimed at all, whether the binding a claim is recorded under
 * exists yet, and whether the caller is the Principal that binding names.
 */

const TENANT_ID = randomUUID();
const AUTH_BINDING_ID = randomUUID();
const CREATED_AT = '2026-09-01T00:00:00.000Z';

/** A caller whose assertion carries no binding at all, which the route must also refuse. */
interface UnboundCaller {
  readonly authBindingId?: string;
}

interface AttemptOverrides {
  readonly journey?: string;
  readonly state?: string;
}

const attemptOf = (overrides: AttemptOverrides): EnrollmentAttemptSnapshot =>
  Schema.decodeUnknownSync(EnrollmentAttemptSnapshotSchema)({
    accountSubject: {
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      providerSubjectId: `provider-${randomUUID()}`,
      subjectType: 'user',
    },
    compositionRevision: 'c'.repeat(64),
    createdAt: CREATED_AT,
    createdByPrincipalId: randomUUID(),
    intentDigest: 'a'.repeat(64),
    intentKey: 'commerce.customer-context.portal-enrollment.counterparty_invitation.test',
    invitationId: randomUUID(),
    journey: 'COUNTERPARTY_INVITATION',
    portalEnrollmentAttemptId: randomUUID(),
    revision: 1,
    state: 'IN_PROGRESS',
    targetLegalEntityId: randomUUID(),
    tenantId: TENANT_ID,
    updatedAt: CREATED_AT,
    ...overrides,
  });

interface OperationOverrides {
  readonly failureCode?: string;
  readonly ownerModuleKey?: string;
  readonly resultReference?: string;
  readonly status?: string;
}

const operationOf = (transitionKey: string, overrides: OperationOverrides): EnrollmentOwnerOperationSnapshot =>
  Schema.decodeUnknownSync(EnrollmentOwnerOperationSnapshotSchema)({
    actorPrincipalId: randomUUID(),
    createdAt: CREATED_AT,
    ownerInvocationId: randomUUID(),
    ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
    portalEnrollmentAttemptId: randomUUID(),
    portalEnrollmentOwnerOperationId: randomUUID(),
    requestDigest: 'b'.repeat(64),
    required: true,
    revision: 1,
    status: 'SUCCEEDED',
    tenantId: TENANT_ID,
    transitionKey,
    updatedAt: CREATED_AT,
    ...overrides,
  });

const reserved = (resultReference: string) =>
  operationOf(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY, { resultReference });
const activated = () => operationOf(ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY, { resultReference: AUTH_BINDING_ID });

it('claims only an Attempt whose journey declared the invitation claim and is not terminal', () => {
  expect(commercePortalAuthEnrollmentClaimableAttempt(attemptOf({}))).toBe(true);
  expect(commercePortalAuthEnrollmentClaimableAttempt(attemptOf({ journey: 'RETAIL_SELF_ENROLLMENT' }))).toBe(false);
  expect(commercePortalAuthEnrollmentClaimableAttempt(attemptOf({ state: 'TERMINATED' }))).toBe(false);
});

it('requires both Core identity transitions before a claim may be recorded', () => {
  expect(commercePortalAuthEnrollmentBindingEstablished([reserved(AUTH_BINDING_ID), activated()])).toBe(true);
  expect(commercePortalAuthEnrollmentBindingEstablished([reserved(AUTH_BINDING_ID)])).toBe(false);
  expect(
    commercePortalAuthEnrollmentBindingEstablished([
      operationOf(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY, { resultReference: AUTH_BINDING_ID, status: 'FAILED' }),
      activated(),
    ]),
  ).toBe(false);
});

it('accepts only the caller whose assertion names the exact binding the Attempt reserved', () => {
  const operations = [reserved(AUTH_BINDING_ID), activated()];
  const callerWithoutBinding: UnboundCaller = {};
  expect(commercePortalAuthEnrollmentClaimantBinding(operations, AUTH_BINDING_ID)).toBe(true);
  expect(commercePortalAuthEnrollmentClaimantBinding(operations, randomUUID())).toBe(false);
  expect(commercePortalAuthEnrollmentClaimantBinding(operations, callerWithoutBinding.authBindingId)).toBe(false);
  // A reservation the journal never proved binds nobody, so no assertion may match it.
  expect(commercePortalAuthEnrollmentClaimantBinding([activated()], AUTH_BINDING_ID)).toBe(false);
});

for (const control of [
  'unchanged-pending',
  'terminal-refusal',
  'succeeded-replay',
  'newly-recorded-pending',
] as const) {
  it.effect(`settles the actual claim driver result without laundering refusal: ${control}`, () =>
    Effect.gen(function* settleClaimDriver() {
      const pendingFailureCode = Schema.decodeSync(EnrollmentKeySchema)(OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE);
      const operationOverrides: OperationOverrides = {
        ownerModuleKey: 'commerce.customer-context',
        status: {
          'newly-recorded-pending': 'RECONCILIATION_REQUIRED',
          'succeeded-replay': 'SUCCEEDED',
          'terminal-refusal': 'FAILED',
          'unchanged-pending': 'FAILED',
        }[control],
      };
      if (control !== 'succeeded-replay') {
        Object.assign(operationOverrides, {
          failureCode: control === 'terminal-refusal' ? 'owner_rejected' : pendingFailureCode,
        });
      }
      const operation = operationOf('counterparty-access-invitation.claim', operationOverrides);
      const attempt = {
        ...attemptOf({ state: 'RECONCILIATION_REQUIRED' }),
        createdByPrincipalId: operation.actorPrincipalId,
        portalEnrollmentAttemptId: operation.portalEnrollmentAttemptId,
      };
      const transition = yield* Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
        actorPrincipalId: operation.actorPrincipalId,
        compositionRevision: attempt.compositionRevision,
        correlationId: 'claim-settlement-regression',
        expectedRevision: attempt.revision,
        ownerInvocationId: operation.ownerInvocationId,
        ownerModuleKey: operation.ownerModuleKey,
        portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        requestDigest: operation.requestDigest,
        tenantId: attempt.tenantId,
        transitionKey: operation.transitionKey,
      });
      let ownerReads = 0;
      let writes = 0;
      const store: CommerceEnrollmentOwnerAttemptStore = {
        claimTransition: () => Effect.die('An accepted claim must not be claimed or dispatched again'),
        read: () => Effect.succeed(attempt),
        readOwnerOperation: () => Effect.succeed(operation),
        reconcileOutcome: () =>
          Effect.sync(() => {
            writes += 1;
            return {
              attempt,
              operation: { ...operation, failureCode: pendingFailureCode, status: 'FAILED' as const },
              outcome: 'RECORDED' as const,
            };
          }),
        recordOutcome: () => Effect.die('A retained accepted claim must not dispatch or record a new result'),
      };
      const ownerResolution = yield* Schema.decodeEffect(ReconcileEnrollmentResolutionSchema)({
        actorPrincipalId: operation.actorPrincipalId,
        failureCode: pendingFailureCode,
        nextState: 'RECONCILIATION_REQUIRED',
        reconciliationRef: randomUUID(),
        status: 'FAILED',
      });
      const driver = commerceEnrollmentOwnerTransitionDriverFor({
        attempt: store,
        owner: {
          dispatch: () => Effect.die('An accepted claim must never redeem a secret again'),
          reconcile: () =>
            Effect.sync(() => {
              ownerReads += 1;
              return ownerResolution;
            }),
        },
      });
      const settlement = yield* claimWithReconciliation(driver, store, transition, true);
      expect(settlement.kind).toBe(
        {
          'newly-recorded-pending': 'PENDING',
          'succeeded-replay': 'SETTLED',
          'terminal-refusal': 'REFUSED',
          'unchanged-pending': 'PENDING',
        }[control],
      );
      expect(writes).toBe(control === 'newly-recorded-pending' ? 1 : 0);
      expect(ownerReads).toBe(control === 'unchanged-pending' || control === 'newly-recorded-pending' ? 1 : 0);
      expect(attempt.revision).toBe(1);
      expect(operation.revision).toBe(1);
    }),
  );
}
