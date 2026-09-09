import {
  ActionPermissionCheckError,
  ActionAuthorizationPreflightDatabaseService,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ClaimCounterpartyAccessInvitationPayloadSchema } from '../../shared/actions/claim-counterparty-access-invitation.ts';
import type { ContextAccessService } from '@app/core-runtime';
import { makeInvitationClaimActionAuthorizationPreflight } from '../../src/persistence/invitation-claim-action-preflight.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const claimantId = '50000000-0000-4000-8000-000000000001';
const otherClaimantId = '50000000-0000-4000-8000-000000000002';
const invitationId = '60000000-0000-4000-8000-000000000001';
const counterpartyId = 'counterparty-one';
const storefrontId = 'storefront-one';

const principal = {
  authBindingId: '80000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:claim-preflight-test',
  authMethod: 'session',
  correlationId: 'claim-preflight-test',
  legalEntityId,
  principalId: claimantId,
  tenantId,
  trustedStorefrontId: storefrontId,
} as const;

const payload = {
  claimant: { principalId: claimantId, tenantId },
  claimProofReference: 'safe-proof-reference',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  expectedRevision: 1,
  invitationRef: {
    moduleId: 'commerce.customer-context',
    resourceId: invitationId,
    resourceType: 'commerce.customer-context.counterparty-access-invitation',
    tenantId,
  },
  scope: { kind: 'storefront', storefrontKey: storefrontId },
} as const;

const input = {
  actionInvocationId: '70000000-0000-4000-8000-000000000001',
  actionKey: 'commerce.customer-context.claim-counterparty-access-invitation',
  correlationId: principal.correlationId,
  payload,
  principal,
  scope: principal,
} as const;

const contextAccess: Pick<ContextAccessService, 'businessPermissions'> = {
  businessPermissions: () => Effect.succeed([]),
};

const eligible = {
  resolve: (candidate: { readonly principalId: string; readonly tenantId: string }) =>
    Effect.succeed({
      decision: 'eligible' as const,
      principal: candidate,
      reason: 'active' as const,
    }),
};

const noReadDatabase: ActionAuthorizationPreflightDatabaseService = {
  transaction: <Value, Failure>(): Effect.Effect<Value, Failure> =>
    Effect.succeed(undefined as Value),
};

const failedDatabase = new ActionPermissionCheckError({
  code: 'action_permission_check_failed',
  reason: 'preflight database failure',
});

const unavailableDatabase: ActionAuthorizationPreflightDatabaseService = {
  transaction: <Value, Failure>(): Effect.Effect<Value, Failure | ActionPermissionCheckError> =>
    Effect.fail(failedDatabase),
};

const preflight = makeInvitationClaimActionAuthorizationPreflight(
  noReadDatabase,
  contextAccess,
  eligible,
);

it.effect('keeps unrelated Actions on the explicit executor path', () =>
  Effect.gen(function* unrelatedAction() {
    const decision = yield* preflight.prepare({ ...input, actionKey: 'other.action' });
    expect(decision).toEqual({ outcome: 'not_applicable' });
  }),
);

it.effect('denies a wrong invitee, Tenant, or storefront before the owner proof routine', () =>
  Effect.gen(function* mismatchedClaim() {
    const wrongInvitee = yield* preflight.prepare({
      ...input,
      payload: {
        ...payload,
        claimant: { principalId: otherClaimantId, tenantId },
      },
    });
    const wrongTenant = yield* preflight.prepare({
      ...input,
      payload: {
        ...payload,
        counterpartyRef: { ...payload.counterpartyRef, tenantId: otherTenantId },
      },
    });
    const wrongStorefront = yield* preflight.prepare({
      ...input,
      payload: {
        ...payload,
        scope: { kind: 'storefront', storefrontKey: 'storefront-two' },
      },
    });
    expect(wrongInvitee).toEqual({ outcome: 'denied' });
    expect(wrongTenant).toEqual({ outcome: 'denied' });
    expect(wrongStorefront).toEqual({ outcome: 'denied' });
  }),
);

it.effect('binds a permit to one invocation and consumes it once', () =>
  Effect.gen(function* oneShotPermit() {
    const decision = yield* preflight.prepare(input);
    expect(decision.outcome).toBe('allowed');
    if (decision.outcome !== 'allowed') {
      return;
    }
    expect(decision.permit.actionInvocationId).toBe(input.actionInvocationId);
    expect(decision.permit.actionKey).toBe(input.actionKey);
    expect(decision.permit.principalId).toBe(claimantId);
    yield* decision.permit.consume;
    const replay = yield* Effect.flip(decision.permit.consume);
    expect(Schema.is(ActionPermissionCheckError)(replay)).toBe(true);
    expect(JSON.stringify(decision)).not.toContain('raw');
  }),
);

it.effect('fails closed on a partial owner/database failure', () =>
  Effect.gen(function* partialFailure() {
    const unavailable = makeInvitationClaimActionAuthorizationPreflight(
      unavailableDatabase,
      contextAccess,
      eligible,
    );
    const failure = yield* Effect.flip(unavailable.prepare(input));
    expect(Schema.is(ActionPermissionCheckError)(failure)).toBe(true);
  }),
);

it('keeps the governed claim payload contract exact', () => {
  expect(Schema.is(ClaimCounterpartyAccessInvitationPayloadSchema)(payload)).toBe(true);
  expect(Schema.is(ClaimCounterpartyAccessInvitationPayloadSchema)(input.payload)).toBe(true);
});
