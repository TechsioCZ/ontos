import type { OperationalScope } from '@app/core-runtime';
import { ScopedRoutineInvocationError } from '@app/core-runtime';
import {
  AuthBindingIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { AccessPortalError } from '@app/core-runtime/access/portal';
import type { AccessPortalGrantInput, AccessPortalReceipt, AccessPortalWrites } from '@app/core-runtime/access/portal';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CounterpartyAccessContractViolation, CounterpartyAccessUnavailable } from '../../shared/domain/access-port.ts';
import type { CounterpartyAccessDomainError } from '../../shared/domain/access-port.ts';
import type { VerifiedInvitationClaimAttestation } from '../../shared/domain/invitation-contract.ts';
import {
  counterpartyAccessPortForTransaction,
  currentOwnerAccessForTransaction,
  readEnrollmentInvitationClaimCurrent,
} from '../../src/persistence/access-persistence.ts';
import type {
  CounterpartyAccessScopedRoutineInvoker,
  CounterpartyAccessPersistenceContext,
} from '../../src/persistence/access-persistence.ts';

const tenantId = Schema.decodeSync(TenantIdSchema)('20000000-0000-4000-8000-000000000001');
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const actorId = Schema.decodeSync(PrincipalIdSchema)('40000000-0000-4000-8000-000000000001');
const recipientId = '50000000-0000-4000-8000-000000000001';
const invitationId = '60000000-0000-4000-8000-000000000001';
const grantId = '70000000-0000-4000-8000-000000000001';
const invocationId = '80000000-0000-4000-8000-000000000001';
const otherInvitationId = '81000000-0000-4000-8000-000000000001';
const claimMutationId = '82000000-0000-4000-8000-000000000001';
const counterpartyId = 'counterparty-one';
const ResourceIdSchema = Schema.String.pipe(Schema.brand('ResourceId'));

const counterpartyRef = Schema.decodeUnknownSync(
  Schema.Struct({
    moduleId: Schema.Literal('party.registry'),
    resourceId: ResourceIdSchema,
    resourceType: Schema.Literal('party.registry.counterparty'),
    tenantId: TenantIdSchema,
  }),
)({
  moduleId: 'party.registry',
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty',
  tenantId,
});
const actor = { principalId: actorId, tenantId } as const;
const recipient = { principalId: recipientId, tenantId } as const;
const scope = Object.freeze({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: Schema.decodeSync(AuthBindingIdSchema)('41000000-0000-4000-8000-000000000001'),
    authContextRef: 'better-auth-session:test',
    authMethod: 'session',
    principalId: actorId,
    tenantId,
  }),
  correlationId: 'correlation-one',
  legalEntityId,
}) satisfies OperationalScope & { readonly legalEntityId: string };

// oxlint-disable-next-line effect-native/no-literal-union-type-alias -- This test-only row-fixture vocabulary mirrors private persistence output and has no runtime parsing boundary.
type GrantState = 'ACTIVE' | 'REVOKED';
// oxlint-disable-next-line effect-native/no-literal-union-type-alias -- This test-only routine-result vocabulary drives fixture typing and has no runtime parsing boundary.
type GrantOperationOutcome =
  | 'ALREADY_ACTIVE'
  | 'ALREADY_REVOKED'
  | 'APPLIED'
  | 'CONFLICT'
  | 'LAST_ADMIN_PROTECTED'
  | 'REVOKED';

const grantRowFixture = Object.freeze({
  counterparty_resource_id: counterpartyId,
  grant_id: grantId,
  granted_at: '2026-09-09T09:00:00.000Z',
  granted_by: actorId,
  permission_code: 'counterparty.access.manage',
  principal_id: recipientId,
  reason: 'Access administration',
  storefront_resource_id: null,
});

const buildGrantRow = (state: GrantState) => ({
  ...grantRowFixture,
  revision: state === 'REVOKED' ? 2 : 1,
  revoked_at: state === 'REVOKED' ? '2026-09-09T09:01:00.000Z' : null,
  revoked_by: state === 'REVOKED' ? actorId : null,
  state,
});

const grantRow = (state: GrantState, operationOutcome?: GrantOperationOutcome) => {
  const row = buildGrantRow(state);
  return operationOutcome === undefined ? row : { ...row, operation_outcome: operationOutcome };
};

type RoutineHandler = (routineKey: string, values: readonly unknown[]) => readonly object[];

const invokerWith = (handler: RoutineHandler): CounterpartyAccessScopedRoutineInvoker => ({
  invoke: (routine, values) =>
    Effect.sync(() => handler(routine.routineKey, values)).pipe(
      Effect.flatMap((rows) =>
        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach is an Effect combinator; its second argument is the element effect, not Array thisArg.
        Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(routine.resultSchema)(row)),
      ),
      Effect.mapError(
        () =>
          new ScopedRoutineInvocationError({
            code: 'scoped_routine_result_invalid',
            constraint: Option.none(),
            ownerModuleKey: routine.ownerModuleKey,
            postgresCode: Option.none(),
            reason: 'The test routine row did not satisfy its declared schema',
            routineKey: routine.routineKey,
          }),
      ),
    ),
});

const attestation = Object.freeze({
  attestationReference: 'safe-attestation-one',
  claimant: recipient,
  counterpartyRef,
  invitationRef: {
    moduleId: 'commerce.customer-context',
    resourceId: invitationId,
    resourceType: 'commerce.customer-context.counterparty-access-invitation',
    tenantId,
  },
  inviterAuthority: {
    decision: 'ALLOWED',
    inviter: actor,
    permission: 'counterparty.access.manage',
    scope: { kind: 'counterparty' },
  },
  proofVersion: 'commerce-invitation-proof.v1',
  state: 'VERIFIED_AND_CONSUMED',
  verifiedAt: '2026-09-09T09:00:30.000Z',
} as const satisfies VerifiedInvitationClaimAttestation);

/** Core's portal writes as the owner transaction calls them, recorded in call order. */
const recordingPortalAccess = (refuse?: AccessPortalError) => {
  const calls: string[] = [];
  const write =
    (operation: 'grant' | 'revoke') =>
    (input: AccessPortalGrantInput): Effect.Effect<AccessPortalReceipt, AccessPortalError> =>
      Effect.sync(() => calls.push(`${operation}:${input.role.key}:${input.principalId}:${input.source}`)).pipe(
        Effect.andThen(
          refuse === undefined
            ? Effect.succeed({ assignmentIncarnationId: input.source, changed: true })
            : Effect.fail(refuse),
        ),
      );
  const portalAccess: AccessPortalWrites = { grant: write('grant'), revoke: write('revoke') };
  return { calls, portalAccess };
};

const dependenciesWith = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  overrides: Partial<CounterpartyAccessPersistenceContext> = {},
): CounterpartyAccessPersistenceContext => ({
  claimAuthority: { verifyAndConsume: () => Effect.succeed(attestation) },
  currentOwnerAccess: () => Effect.succeed('ALLOWED' as const),
  eligibility: {
    resolve: (principal) => Effect.succeed({ decision: 'eligible', principal, reason: 'active' }),
  },
  portalAccess: recordingPortalAccess().portalAccess,
  proofLifecycle: {
    issueAndStageDelivery: () =>
      Effect.succeed({
        proofReference: 'safe-proof-reference',
        proofVersion: 'commerce-invitation-proof.v1',
        state: 'DELIVERY_STAGED',
      }),
    rotateAndStageDelivery: () =>
      Effect.succeed({
        proofReference: 'safe-proof-reference',
        proofVersion: 'commerce-invitation-proof.v1',
        state: 'DELIVERY_STAGED',
      }),
  },
  scope,
  transaction,
  ...overrides,
});

const grantInput = {
  actionInvocationId: invocationId,
  actor,
  counterpartyRef,
  legalEntityId,
  permission: 'counterparty.access.manage',
  reason: 'Access administration',
  recipient,
  scope: { kind: 'counterparty' },
} as const;

const invitationRow = (state: 'CLAIMING' | 'CLAIMED') => {
  const row = {
    claimed_at: state === 'CLAIMED' ? '2026-09-09T09:01:00.000Z' : null,
    claimed_by_principal_id: recipientId,
    counterparty_resource_id: counterpartyId,
    created_at: '2026-09-09T09:00:00.000Z',
    delivery_method: 'VERIFIED_CONTACT_POINT',
    delivery_reference: 'safe-delivery-reference',
    expires_at: '2026-09-10T09:00:00.000Z',
    grant_progress: [
      state === 'CLAIMED'
        ? {
            grantRef: {
              moduleId: 'commerce.customer-context',
              resourceId: grantId,
              resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
              tenantId,
            },
            permission: 'counterparty.access.manage',
            state: 'ACTIVE',
          }
        : { permission: 'counterparty.access.manage', state: 'PENDING_GRANT' },
    ],
    invitation_id: invitationId,
    invited_by: actorId,
    mutation_id: claimMutationId,
    reason: 'Invite administrator',
    requested_permission_codes: ['counterparty.access.manage'],
    revision: state === 'CLAIMING' ? 2 : 3,
    state,
    storefront_resource_id: null,
  };
  return state === 'CLAIMING' ? { ...row, operation_outcome: 'CLAIMING' } : row;
};

const pendingInvitationRow = (operationOutcome: 'ALREADY_PENDING' | 'ALREADY_SENT' | 'CREATED' | 'RESENT') => ({
  claimed_at: null,
  claimed_by_principal_id: null,
  counterparty_resource_id: counterpartyId,
  created_at: '2026-09-09T09:00:00.000Z',
  delivery_method: 'VERIFIED_CONTACT_POINT',
  delivery_reference: 'safe-delivery-reference',
  expires_at: '2026-09-10T09:00:00.000Z',
  grant_progress: [],
  invitation_id: invitationId,
  invited_by: actorId,
  mutation_id: claimMutationId,
  operation_outcome: operationOutcome,
  reason: 'Invite administrator',
  requested_permission_codes: ['counterparty.access.manage'],
  revision: operationOutcome === 'RESENT' || operationOutcome === 'ALREADY_SENT' ? 2 : 1,
  state: 'PENDING',
  storefront_resource_id: null,
});

const claimInput = {
  actionInvocationId: invocationId,
  actor,
  claimant: recipient,
  claimProofReference: 'secure-vault-proof-one',
  counterpartyRef,
  expectedRevision: 1,
  invitationRef: attestation.invitationRef,
  legalEntityId,
  reason: 'Accept invitation',
  scope: { kind: 'counterparty' },
} as const;

const earlierRedeemerId = '51000000-0000-4000-8000-000000000001';
/** Two redemptions of the invitation: an earlier proof somebody else redeemed, then the claimant's own. */
const redemptionRows = [
  { claimant_principal_id: earlierRedeemerId, proof_reference: 'secure-vault-proof-earlier' },
  { claimant_principal_id: recipientId, proof_reference: claimInput.claimProofReference },
];
const inviteeRevocations = redemptionRows.map(
  (row) =>
    `revoke:commerce.customer-context.counterparty-invitee:${row.claimant_principal_id}:commerce.customer-context.counterparty-invitation:${invitationId}:${row.proof_reference}`,
);

const claimReconciliationRow = (state: 'CLAIMED') => ({
  attestation_reference: attestation.attestationReference,
  claim_mutation_id: claimMutationId,
  claim_subject_principal_id: null,
  claimed_at: state === 'CLAIMED' ? '2026-09-09T09:02:00.000Z' : null,
  claimed_by_principal_id: recipientId,
  counterparty_resource_id: counterpartyId,
  created_at: '2026-09-09T09:00:00.000Z',
  delivery_method: 'VERIFIED_CONTACT_POINT',
  delivery_reference: 'safe-delivery-reference',
  expires_at: '2026-09-10T09:00:00.000Z',
  grant_progress: [
    state === 'CLAIMED'
      ? {
          grantRef: {
            moduleId: 'commerce.customer-context',
            resourceId: grantId,
            resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
            tenantId,
          },
          permission: 'counterparty.access.manage',
          state: 'ACTIVE',
        }
      : { permission: 'counterparty.access.manage', state: 'PENDING_GRANT' },
  ],
  invitation_id: invitationId,
  invited_by: actorId,
  reason: 'Invite administrator',
  requested_permission_codes: ['counterparty.access.manage'],
  revision: state === 'CLAIMED' ? 4 : 3,
  source_action_invocation_id: invocationId,
  state,
  storefront_resource_id: null,
  verified_at: attestation.verifiedAt,
});

it.effect('applies a grant in one owner routine without a second permission store', () =>
  Effect.gen(function* grantAccess() {
    const calls: string[] = [];
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey) => {
          calls.push(routineKey);
          return [grantRow('ACTIVE', 'APPLIED')];
        }),
      ),
    );

    const result = yield* port.grant(grantInput);
    // The owner row is the whole authority (O67-Q1), so the grant is ACTIVE when the Action returns
    // instead of waiting for an out-of-band projection (O62).
    expect(result.outcome).toBe('APPLIED');
    expect(result.grant.state).toBe('ACTIVE');
    expect(calls).toEqual(['counterparty-access.grant']);
  }),
);

it.effect('revokes a grant in one owner routine without a second permission store', () =>
  Effect.gen(function* revokeAccess() {
    const calls: string[] = [];
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey) => {
          calls.push(routineKey);
          return [grantRow('REVOKED', 'REVOKED')];
        }),
      ),
    );

    const result = yield* port.revoke(grantInput);
    expect(result.outcome).toBe('REVOKED');
    expect(result.grant.state).toBe('REVOKED');
    expect(result.grant.revokedBy).toEqual(actor);
    expect(calls).toEqual(['counterparty-access.revoke']);
  }),
);

it.effect('denies once the owner grant is revoked', () =>
  Effect.gen(function* denyRevokedGrant() {
    const transaction = invokerWith((routineKey) =>
      routineKey === 'counterparty-access.list-grants' ? [grantRow('REVOKED')] : [],
    );
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(transaction, {
        currentOwnerAccess: currentOwnerAccessForTransaction(transaction, scope),
        scope: { ...scope, principalId: Schema.decodeSync(PrincipalIdSchema)(recipientId) },
      }),
    );

    const decision = yield* port.check({
      counterpartyRef,
      permission: 'counterparty.access.manage',
      principal: recipient,
      scope: { kind: 'counterparty' },
    });
    expect(decision).toBe('DENIED');
  }),
);

it.effect('fails closed when the owner access reader is omitted', () =>
  Effect.gen(function* missingOwnerReader() {
    const transaction = invokerWith(() => [grantRow('ACTIVE')]);
    const dependencies = dependenciesWith(transaction);
    const { currentOwnerAccess: _omittedOwnerReader, ...withoutOwnerReader } = dependencies;
    const decision = yield* counterpartyAccessPortForTransaction(withoutOwnerReader).check({
      counterpartyRef,
      permission: 'counterparty.access.manage',
      principal: recipient,
      scope: { kind: 'counterparty' },
    });
    expect(decision).toBe('UNAVAILABLE');
  }),
);

it.effect('lets a broad active owner grant cover a narrower scope despite stale rows', () =>
  Effect.gen(function* broadActiveOwnerGrant() {
    const transaction = invokerWith((routineKey) =>
      routineKey === 'counterparty-access.list-grants'
        ? [
            grantRow('ACTIVE'),
            {
              ...grantRow('REVOKED'),
              storefront_resource_id: 'storefront-one',
            },
          ]
        : [],
    );
    const reader = currentOwnerAccessForTransaction(transaction, scope);

    const decision = yield* reader({
      counterpartyRef,
      legalEntityId,
      permission: 'counterparty.access.manage',
      principal: recipient,
      scope: { kind: 'storefront', storefrontKey: 'storefront-one' },
    });

    expect(decision).toBe('ALLOWED');
  }),
);

it.effect('fails closed when the grant routine reports no applied grant', () =>
  Effect.gen(function* rejectUnappliedGrant() {
    const port = counterpartyAccessPortForTransaction(dependenciesWith(invokerWith(() => [grantRow('ACTIVE')])));

    const failure = yield* Effect.flip(port.grant(grantInput));
    expect(Schema.is(CounterpartyAccessUnavailable)(failure)).toBe(true);
  }),
);

it.effect('returns last-admin protection and idempotent active outcomes', () =>
  Effect.gen(function* protectLastAdministrator() {
    const active = counterpartyAccessPortForTransaction(
      dependenciesWith(invokerWith(() => [grantRow('ACTIVE', 'ALREADY_ACTIVE')])),
    );
    const protectedPort = counterpartyAccessPortForTransaction(
      dependenciesWith(invokerWith(() => [grantRow('ACTIVE', 'LAST_ADMIN_PROTECTED')])),
    );

    expect((yield* active.grant(grantInput)).outcome).toBe('ALREADY_ACTIVE');
    expect((yield* protectedPort.revoke(grantInput)).outcome).toBe('LAST_ADMIN_PROTECTED');
  }),
);

it.effect('gives an ACTIVE grant’s grantee the Counterparty portal role, named by the grant row', () =>
  Effect.gen(function* grantPortalAccess() {
    for (const outcome of ['APPLIED', 'ALREADY_ACTIVE'] as const) {
      const portal = recordingPortalAccess();
      const port = counterpartyAccessPortForTransaction(
        dependenciesWith(
          invokerWith(() => [grantRow('ACTIVE', outcome)]),
          { portalAccess: portal.portalAccess },
        ),
      );
      expect((yield* port.grant(grantInput)).outcome).toBe(outcome);
      expect(portal.calls).toEqual([
        `grant:commerce.customer-context.counterparty-customer:${recipientId}:commerce.customer-context.counterparty-access-grant:${grantId}`,
      ]);
    }
  }),
);

it.effect('ends exactly the portal assignment a REVOKED grant stood for', () =>
  Effect.gen(function* revokePortalAccess() {
    for (const outcome of ['REVOKED', 'ALREADY_REVOKED'] as const) {
      const portal = recordingPortalAccess();
      const port = counterpartyAccessPortForTransaction(
        dependenciesWith(
          invokerWith(() => [grantRow('REVOKED', outcome)]),
          { portalAccess: portal.portalAccess },
        ),
      );
      expect((yield* port.revoke(grantInput)).outcome).toBe(outcome);
      expect(portal.calls).toEqual([
        `revoke:commerce.customer-context.counterparty-customer:${recipientId}:commerce.customer-context.counterparty-access-grant:${grantId}`,
      ]);
    }
  }),
);

it.effect('changes no portal access for a conflicting grant or a protected last administrator', () =>
  Effect.gen(function* untouchedPortalAccess() {
    const portal = recordingPortalAccess();
    const conflicting = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith(() => [grantRow('ACTIVE', 'CONFLICT')]),
        { portalAccess: portal.portalAccess },
      ),
    );
    const protectedPort = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith(() => [grantRow('ACTIVE', 'LAST_ADMIN_PROTECTED')]),
        {
          portalAccess: portal.portalAccess,
        },
      ),
    );
    expect((yield* conflicting.grant(grantInput)).outcome).toBe('CONFLICT');
    expect((yield* protectedPort.revoke(grantInput)).outcome).toBe('LAST_ADMIN_PROTECTED');
    expect(portal.calls).toEqual([]);
  }),
);

it.effect('fails a grant closed when Core cannot write its portal access', () =>
  Effect.gen(function* refusedPortalAccess() {
    const portal = recordingPortalAccess(
      new AccessPortalError({ code: 'access_portal_unavailable', reason: 'engine down' }),
    );
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith(() => [grantRow('ACTIVE', 'APPLIED')]),
        { portalAccess: portal.portalAccess },
      ),
    );
    const failure = yield* Effect.flip(port.grant(grantInput));
    expect(Schema.is(CounterpartyAccessUnavailable)(failure)).toBe(true);
  }),
);

it.effect('never promotes an untrusted storefront request into a trusted mutation target', () =>
  Effect.gen(function* rejectRequestStorefront() {
    let routineCalls = 0;
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith(() => {
          routineCalls += 1;
          return [];
        }),
      ),
    );
    const failure: CounterpartyAccessDomainError = yield* Effect.flip(
      port.grant({
        ...grantInput,
        scope: { kind: 'storefront', storefrontKey: 'request-storefront' },
      }),
    );
    expect(Schema.is(CounterpartyAccessContractViolation)(failure)).toBe(true);
    expect(routineCalls).toBe(0);
  }),
);

it.effect('applies a storefront grant only for the independently verified storefront scope', () =>
  Effect.gen(function* useTrustedStorefront() {
    const trustedStorefrontId = 'trusted-storefront';
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith(() => [{ ...grantRow('ACTIVE', 'APPLIED'), storefront_resource_id: trustedStorefrontId }]),
        {
          trustedStorefrontId,
        },
      ),
    );

    const result = yield* port.grant({
      ...grantInput,
      scope: { kind: 'storefront', storefrontKey: trustedStorefrontId },
    });
    // The owner row is the whole authority (O67-Q1), so the storefront grant is final in the
    // owner transaction (O62) instead of waiting for an out-of-band projection.
    expect(result.outcome).toBe('APPLIED');
    expect(result.grant.scope).toEqual({
      kind: 'storefront',
      storefrontKey: trustedStorefrontId,
    });

    const mismatched = yield* Effect.flip(
      port.grant({ ...grantInput, scope: { kind: 'storefront', storefrontKey: 'untrusted-storefront' } }),
    );
    expect(Schema.is(CounterpartyAccessContractViolation)(mismatched)).toBe(true);
  }),
);

it.effect('stages proof delivery only for material invitation create and resend transitions', () =>
  Effect.gen(function* stageInvitationProofs() {
    let createCalls = 0;
    let resendCalls = 0;
    const lifecycleOperations: string[] = [];
    const portal = recordingPortalAccess();
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey) => {
          if (routineKey === 'counterparty-access.create-invitation') {
            createCalls += 1;
            return [pendingInvitationRow(createCalls === 1 ? 'CREATED' : 'ALREADY_PENDING')];
          }
          if (routineKey === 'counterparty-access.read-invitation-redemptions') {
            return redemptionRows;
          }
          resendCalls += 1;
          return [pendingInvitationRow(resendCalls === 1 ? 'RESENT' : 'ALREADY_SENT')];
        }),
        {
          portalAccess: portal.portalAccess,
          proofLifecycle: {
            issueAndStageDelivery: ({ invitationRef }) =>
              Effect.sync(() => {
                lifecycleOperations.push(`issue:${invitationRef.resourceId}`);
                return {
                  proofReference: 'safe-proof-reference',
                  proofVersion: 'commerce-invitation-proof.v1' as const,
                  state: 'DELIVERY_STAGED' as const,
                };
              }),
            rotateAndStageDelivery: ({ invitationRef }) =>
              Effect.sync(() => {
                lifecycleOperations.push(`rotate:${invitationRef.resourceId}`);
                return {
                  proofReference: 'safe-proof-reference',
                  proofVersion: 'commerce-invitation-proof.v1' as const,
                  state: 'DELIVERY_STAGED' as const,
                };
              }),
          },
        },
      ),
    );
    const createInput = {
      actionInvocationId: invocationId,
      actor,
      counterpartyRef,
      deliveryMethod: 'VERIFIED_CONTACT_POINT' as const,
      deliveryReference: 'safe-delivery-reference',
      expiresAt: '2026-09-10T09:00:00.000Z',
      intendedPermissions: ['counterparty.access.manage' as const],
      legalEntityId,
      reason: 'Invite administrator',
      scope: { kind: 'counterparty' as const },
    };
    const mutationInput = {
      actionInvocationId: invocationId,
      actor,
      counterpartyRef,
      expectedRevision: 1,
      invitationRef: attestation.invitationRef,
      legalEntityId,
      reason: 'Resend invitation',
      scope: { kind: 'counterparty' as const },
    };

    expect((yield* port.createInvitation(createInput)).outcome).toBe('CREATED');
    expect((yield* port.createInvitation(createInput)).outcome).toBe('ALREADY_PENDING');
    expect((yield* port.resendInvitation(mutationInput)).outcome).toBe('RESENT');
    expect((yield* port.resendInvitation(mutationInput)).outcome).toBe('ALREADY_SENT');
    expect(lifecycleOperations).toEqual([`issue:${invitationId}`, `rotate:${invitationId}`]);
    // The rotation revoked every earlier proof, so the invitee access each redemption admitted ends once, with the
    // material resend only.
    expect(portal.calls).toEqual(inviteeRevocations);
  }),
);

it.effect('ends the invitee access of every redemption when the invitation is revoked', () =>
  Effect.gen(function* revokeInvitation() {
    const portal = recordingPortalAccess();
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey) =>
          routineKey === 'counterparty-access.read-invitation-redemptions'
            ? redemptionRows
            : [{ ...pendingInvitationRow('RESENT'), operation_outcome: 'REVOKED', state: 'REVOKED' }],
        ),
        { portalAccess: portal.portalAccess },
      ),
    );
    const outcome = yield* port.revokeInvitation({
      actionInvocationId: invocationId,
      actor,
      counterpartyRef,
      expectedRevision: 1,
      invitationRef: attestation.invitationRef,
      legalEntityId,
      reason: 'Revoke invitation',
      scope: { kind: 'counterparty' as const },
    });
    expect(outcome.outcome).toBe('REVOKED');
    expect(portal.calls).toEqual(inviteeRevocations);
  }),
);

it.effect('binds one consumed attestation to the exact claim and persists only its safe reference', () =>
  Effect.gen(function* claimInvitation() {
    const invitationMutations: unknown[][] = [];
    let authorityChecks = 0;
    const portal = recordingPortalAccess();
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) => {
          if (routineKey === 'counterparty-access.mutate-invitation') {
            invitationMutations.push([...values]);
            return values[4] === 'BEGIN_CLAIM' ? [invitationRow('CLAIMING')] : [invitationRow('CLAIMED')];
          }
          if (routineKey === 'counterparty-access.read-invitation-redemptions') {
            return redemptionRows;
          }
          return [grantRow('ACTIVE', 'APPLIED')];
        }),
        {
          claimAuthority: {
            verifyAndConsume: () =>
              Effect.sync(() => {
                authorityChecks += 1;
                return attestation;
              }),
          },
          portalAccess: portal.portalAccess,
        },
      ),
    );

    const result = yield* port.claimInvitation(claimInput);
    expect(result.outcome).toBe('CLAIMED');
    if (result.outcome !== 'CLAIMED') {
      return;
    }
    expect(result.attestation).toEqual(attestation);
    expect(authorityChecks).toBe(1);
    // The claimed grants carry the claimant's access from here, and the invitee access of every redemption of
    // the invitation ends in the same transaction — the earlier proof somebody else redeemed too.
    expect(portal.calls.slice(-inviteeRevocations.length)).toEqual(inviteeRevocations);
    expect(
      portal.calls
        .slice(0, -inviteeRevocations.length)
        .every((call) => call.startsWith('grant:commerce.customer-context.counterparty-customer:')),
    ).toBe(true);
    expect(invitationMutations[0]).toContain(claimInput.claimProofReference);
    expect(invitationMutations[1]).toContain(attestation.attestationReference);
  }),
);

it.effect('rejects a verifier attestation for a different invitation before any grant', () =>
  Effect.gen(function* rejectMismatchedAttestation() {
    let grants = 0;
    const mismatched = {
      ...attestation,
      invitationRef: { ...attestation.invitationRef, resourceId: 'different-invitation' },
    } satisfies VerifiedInvitationClaimAttestation;
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey) => {
          if (routineKey === 'counterparty-access.grant') {
            grants += 1;
          }
          return [invitationRow('CLAIMING')];
        }),
        { claimAuthority: { verifyAndConsume: () => Effect.succeed(mismatched) } },
      ),
    );

    const failure = yield* Effect.flip(port.claimInvitation(claimInput));
    expect(Schema.is(CounterpartyAccessContractViolation)(failure)).toBe(true);
    expect(grants).toBe(0);
  }),
);

it.effect('commits proof rejection evidence while restoring the invitation to pending', () =>
  Effect.gen(function* persistProofRejection() {
    const invitationOperations: unknown[] = [];
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) => {
          if (routineKey !== 'counterparty-access.mutate-invitation') {
            return [];
          }
          invitationOperations.push(values[4]);
          return values[4] === 'BEGIN_CLAIM'
            ? [invitationRow('CLAIMING')]
            : [
                {
                  ...pendingInvitationRow('ALREADY_PENDING'),
                  mutation_id: claimMutationId,
                  operation_outcome: 'CLAIM_REJECTED',
                  revision: 3,
                },
              ];
        }),
        {
          claimAuthority: {
            verifyAndConsume: () =>
              Effect.fail(
                new CounterpartyAccessContractViolation({
                  code: 'invitation_claim_proof_invalid',
                  reason: 'The invitation claim proof is invalid',
                }),
              ),
          },
        },
      ),
    );

    const result = yield* port.claimInvitation(claimInput);
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome === 'REJECTED') {
      expect(result.rejection).toBe('INVALID_PROOF');
      expect(result.invitation.state).toBe('PENDING');
    }
    expect(invitationOperations).toEqual(['BEGIN_CLAIM', 'REJECT_CLAIM']);
  }),
);

it.effect('does not expose an already-claimed invitation to a different claimant', () =>
  Effect.gen(function* rejectDifferentClaimantReplay() {
    let authorityChecks = 0;
    const differentClaimantId = '90000000-0000-4000-8000-000000000001';
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith(() => [
          {
            ...invitationRow('CLAIMED'),
            claimed_by_principal_id: differentClaimantId,
            operation_outcome: 'ALREADY_CLAIMED',
          },
        ]),
        {
          claimAuthority: {
            verifyAndConsume: () =>
              Effect.sync(() => {
                authorityChecks += 1;
                return attestation;
              }),
          },
        },
      ),
    );

    const failure = yield* Effect.flip(port.claimInvitation(claimInput));
    expect(Schema.is(CounterpartyAccessContractViolation)(failure)).toBe(true);
    expect(failure.code).toBe('invitation_claimant_mismatch');
    expect(authorityChecks).toBe(0);
  }),
);

it.effect('fails closed and leaves the invitation recoverable when an intended grant conflicts', () =>
  Effect.gen(function* conflictingClaimGrant() {
    const invitationOperations: unknown[] = [];
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) => {
          if (routineKey === 'counterparty-access.mutate-invitation') {
            invitationOperations.push(values[4]);
            return values[4] === 'BEGIN_CLAIM' ? [invitationRow('CLAIMING')] : [invitationRow('CLAIMED')];
          }
          if (routineKey === 'counterparty-access.grant') {
            return [grantRow('ACTIVE', 'CONFLICT')];
          }
          return [];
        }),
      ),
    );

    const failure = yield* Effect.flip(port.claimInvitation(claimInput));
    expect(Schema.is(CounterpartyAccessUnavailable)(failure)).toBe(true);
    // The claim never finishes: the single owner transaction rolls back so the invitation can be
    // retried once the conflicting grant is resolved (O62, O67-Q1).
    expect(invitationOperations).toEqual(['BEGIN_CLAIM']);
  }),
);

for (const control of [
  'valid',
  'wrong-invitation',
  'wrong-claim-subject',
  'wrong-claimant',
  'wrong-attestation',
  'revoked-owner',
  'absent-owner',
  'foreign-counterparty',
  'foreign-storefront',
] as const) {
  it.effect(`checks the original accepted claim Current authority exactly: ${control}`, () =>
    Effect.gen(function* acceptedClaimCurrentAuthority() {
      const root = { ...claimReconciliationRow('CLAIMED'), claim_subject_principal_id: recipientId };
      if (control === 'wrong-invitation') {
        root.invitation_id = otherInvitationId;
      }
      if (control === 'wrong-claim-subject') {
        root.claim_subject_principal_id = actorId;
      }
      if (control === 'wrong-claimant') {
        root.claimed_by_principal_id = actorId;
      }
      if (control === 'foreign-counterparty') {
        root.counterparty_resource_id = 'another-counterparty';
      }
      const transaction = invokerWith((routineKey, values) => {
        if (routineKey === 'counterparty-access.read-enrollment-invitation-claim') {
          return [root];
        }
        if (routineKey === 'counterparty-access.list-grants') {
          // The real scoped SQL only returns rows for the requested Counterparty/Principal.
          if (values[0] !== counterpartyId || values[1] !== recipientId) {
            return [];
          }
          if (control === 'absent-owner') {
            return [];
          }
          let state: GrantState = 'ACTIVE';
          if (control === 'revoked-owner') {
            state = 'REVOKED';
          }
          const row = grantRow(state);
          return [{ ...row, storefront_resource_id: control === 'foreign-storefront' ? 'another-storefront' : null }];
        }
        return [];
      });
      const accepted = yield* readEnrollmentInvitationClaimCurrent(
        transaction,
        { legalEntityId, tenantId },
        {
          expectedAttestation:
            control === 'wrong-attestation' ? 'another-attestation' : attestation.attestationReference,
          invitationId,
          principalId: recipientId,
        },
      );
      expect(Option.isSome(accepted)).toBe(true);
      if (Option.isSome(accepted)) {
        expect(accepted.value.current).toBe(control === 'valid');
        expect(accepted.value.attestationReference).toBe(attestation.attestationReference);
        expect(accepted.value.mutationId).toBe(claimMutationId);
      }
    }),
  );
}
