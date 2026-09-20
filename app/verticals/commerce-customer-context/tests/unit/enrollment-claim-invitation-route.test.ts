import { randomUUID } from 'node:crypto';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
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
  EnrollmentOwnerOperationSnapshotSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';
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
