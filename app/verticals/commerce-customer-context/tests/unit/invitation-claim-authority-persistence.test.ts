// @effect-diagnostics nodeBuiltinImport:off -- Checked-in migration SQL is the security contract under test; expires: 2027-03-31.
import { ScopedRoutineInvocationError } from '@app/core-runtime';
import type { ContextAccessService, ScopedRoutineDefinition, ScopedRoutineParameter } from '@app/core-runtime';
import { readFile, readdir } from 'node:fs/promises';
import { Crypto, Effect, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CounterpartyAccessContractViolation,
  CounterpartyAccessUnavailable,
  secureQueuedCounterpartyInvitationProofDelivery,
} from '../../shared/domain/access-port.ts';
import type { CounterpartyAccessDomainError } from '../../shared/domain/access-port.ts';
import type { CounterpartyInvitationProofDeliveryService } from '../../shared/domain/invitation-proof-delivery.ts';
import {
  counterpartyInvitationClaimRedemptionForTransaction,
  counterpartyInvitationClaimServicesForTransaction,
  invitationClaimProofRoutineAllowlist,
  verifyCounterpartyInvitationClaimAuthorityForOwnerScope,
} from '../../src/persistence/invitation-claim-authority-persistence.ts';
import type { InvitationClaimScopedRoutineInvoker } from '../../src/persistence/invitation-claim-authority-persistence.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const inviterId = '40000000-0000-4000-8000-000000000001';
const claimantId = '50000000-0000-4000-8000-000000000001';
const invitationId = '60000000-0000-4000-8000-000000000001';
const actionInvocationId = '70000000-0000-4000-8000-000000000001';
const counterpartyId = 'counterparty-one';
const storefrontId = 'storefront-one';
const rawProofText = 'ab'.repeat(32);
const proofDigest = 'cd'.repeat(32);

const invitationRef = {
  moduleId: 'commerce.customer-context',
  resourceId: invitationId,
  resourceType: 'commerce.customer-context.counterparty-access-invitation',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const inviter = { principalId: inviterId, tenantId } as const;
const claimant = { principalId: claimantId, tenantId } as const;
const intendedPermissions = ['counterparty.access.read', 'counterparty.purchase.prepare'] as const;
const permissionScope = { kind: 'storefront', storefrontKey: storefrontId } as const;
const expiresAt = '2026-09-10T09:00:00.000Z';
const proofReference = 'safe-proof-reference';

const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array(32).fill(0xcd)),
  randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 0xab : 0x11),
});

const routineFailure = (routineKey: string) =>
  new ScopedRoutineInvocationError({
    code: 'scoped_routine_result_invalid',
    constraint: Option.none(),
    ownerModuleKey: 'commerce.customer-context',
    postgresCode: Option.none(),
    reason: 'The test routine row did not satisfy its declared result schema',
    routineKey,
  });

const decodeRoutineRows = <
  RowSchema extends Schema.ConstraintDecoder<object>,
  const Parameters extends readonly ScopedRoutineParameter[],
>(
  routine: ScopedRoutineDefinition<RowSchema, Parameters>,
  rows: readonly object[],
): Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError> => {
  const resultRowsSchema = Schema.Array(Schema.toType(routine.resultSchema));
  return Schema.decodeUnknownEffect(resultRowsSchema)(rows).pipe(
    Effect.mapError(() => routineFailure(routine.routineKey)),
  );
};

type RoutineHandler = (routineKey: string, values: readonly unknown[]) => readonly object[];

const first = <Value>(values: readonly Value[]): Value => {
  const [value] = values;
  if (value === undefined) {
    throw new Error('Expected one test value');
  }
  return value;
};

const invokerWith = (handler: RoutineHandler): InvitationClaimScopedRoutineInvoker => ({
  invoke: (routine, values) =>
    Effect.sync(() => handler(routine.routineKey, values)).pipe(
      Effect.flatMap((rows) => decodeRoutineRows(routine, rows)),
    ),
});

const contextAccess = (
  decision: 'allowed' | 'denied' | 'unavailable' = 'allowed',
  observe?: Parameters<NonNullable<ContextAccessService['businessPermissions']>>[0][],
): Pick<ContextAccessService, 'businessPermissions'> => ({
  businessPermissions: (input) =>
    Effect.sync(() => {
      observe?.push(input);
      return input.targets.map(({ permission }) => ({ decision, key: permission }));
    }),
});

const allowedOwnerAccess = () => Effect.succeed('ALLOWED' as const);

const successfulDelivery = (
  observe?: Parameters<CounterpartyInvitationProofDeliveryService['stage']>[0][],
): CounterpartyInvitationProofDeliveryService => ({
  stage: (input) =>
    Effect.sync(() => {
      observe?.push(input);
    }),
});

const registrationInput = {
  actionInvocationId,
  counterpartyRef,
  deliveryMethod: 'VERIFIED_CONTACT_POINT',
  deliveryReference: 'verified-contact-point-one',
  expiresAt,
  intendedPermissions,
  invitationRef,
  inviter,
  legalEntityId,
  scope: permissionScope,
} as const;

const verificationInput = {
  actionInvocationId,
  claimant,
  claimProofReference: proofReference,
  counterpartyRef,
  intendedPermissions,
  invitationRef,
  inviter,
  legalEntityId,
  scope: permissionScope,
} as const;

const redemptionInput = {
  invitationRef,
  proofReference,
  rawProof: Redacted.make(rawProofText),
} as const;
const trustedRedemptionScope = {
  authBindingId: '80000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:test',
  authMethod: 'session',
  correlationId: 'invitation-redemption-test',
  legalEntityId,
  principalId: claimantId,
  tenantId,
} as const;

const expectUnavailable = (failure: CounterpartyAccessDomainError) => {
  expect(Schema.is(CounterpartyAccessUnavailable)(failure)).toBe(true);
  if (Schema.is(CounterpartyAccessUnavailable)(failure)) {
    expect(failure.code).toBe('counterparty_access_unavailable');
  }
};

const expectViolation = (failure: CounterpartyAccessDomainError, code: CounterpartyAccessContractViolation['code']) => {
  expect(Schema.is(CounterpartyAccessContractViolation)(failure)).toBe(true);
  if (Schema.is(CounterpartyAccessContractViolation)(failure)) {
    expect(failure.code).toBe(code);
  }
};

it('declares only the governed invitation-proof owner routines with exact scope parameters', () => {
  expect(invitationClaimProofRoutineAllowlist.map(({ name, routineKey }) => [name, routineKey])).toEqual([
    ['register_invitation_claim_proof', 'counterparty-invitation-proof.register'],
    ['stage_invitation_claim_proof_delivery', 'counterparty-invitation-proof.stage-delivery'],
    ['redeem_invitation_claim_secret', 'counterparty-invitation-proof.redeem'],
    ['consume_invitation_claim_proof', 'counterparty-invitation-proof.consume'],
    ['verify_invitation_claim_authority', 'counterparty-invitation-proof.verify-claim-authority'],
  ]);
  for (const routine of invitationClaimProofRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.parameters.slice(0, 2)).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
    ]);
  }
});

it.effect('issues and stages one proof without exposing its raw value to either routine', () =>
  Effect.gen(function* issueProof() {
    const routineCalls: { readonly key: string; readonly values: readonly unknown[] }[] = [];
    const deliveries: Parameters<CounterpartyInvitationProofDeliveryService['stage']>[0][] = [];
    const events: string[] = [];
    const transaction = invokerWith((key, values) => {
      routineCalls.push({ key, values });
      events.push(key);
      if (key === 'counterparty-invitation-proof.register') {
        return [{ operation_outcome: 'REGISTERED', proof_reference: proofReference }];
      }
      return [{ operation_outcome: 'STAGED', proof_reference: proofReference }];
    });
    const delivery: CounterpartyInvitationProofDeliveryService = {
      stage: (input) =>
        Effect.sync(() => {
          deliveries.push(input);
          events.push('delivery.stage');
        }),
    };
    const { proofLifecycle } = counterpartyInvitationClaimServicesForTransaction(
      transaction,
      contextAccess(),
      crypto,
      delivery,
    );

    const result = yield* proofLifecycle.issueAndStageDelivery(registrationInput);

    expect(result).toEqual({
      proofReference,
      proofVersion: 'commerce-invitation-proof.v1',
      state: 'DELIVERY_STAGED',
    });
    expect(events).toEqual([
      'counterparty-invitation-proof.register',
      'delivery.stage',
      'counterparty-invitation-proof.stage-delivery',
    ]);
    expect(Redacted.value(deliveries[0]?.rawProof)).toBe(rawProofText);
    expect(routineCalls.map(({ values }) => JSON.stringify(values))).not.toContain(rawProofText);
    expect(routineCalls[0]?.values).toEqual([
      invitationId,
      counterpartyId,
      storefrontId,
      intendedPermissions,
      inviterId,
      'VERIFIED_CONTACT_POINT',
      'verified-contact-point-one',
      expiresAt,
      actionInvocationId,
      '11111111-1111-4111-9111-111111111111',
      proofDigest,
      'ISSUE',
    ]);
  }),
);

it.effect('returns an issue replay without restaging delivery or replacing its safe reference', () =>
  Effect.gen(function* replayIssue() {
    const calls: string[] = [];
    const deliveries: Parameters<CounterpartyInvitationProofDeliveryService['stage']>[0][] = [];
    const { proofLifecycle } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith((key) => {
        calls.push(key);
        return [{ operation_outcome: 'REPLAYED', proof_reference: 'existing-proof-reference' }];
      }),
      contextAccess(),
      crypto,
      successfulDelivery(deliveries),
    );

    const result = yield* proofLifecycle.issueAndStageDelivery(registrationInput);

    expect(result).toEqual({
      proofReference: 'existing-proof-reference',
      proofVersion: 'commerce-invitation-proof.v1',
      state: 'DELIVERY_STAGE_REPLAYED',
    });
    expect(calls).toEqual(['counterparty-invitation-proof.register']);
    expect(deliveries).toEqual([]);
  }),
);

it.effect('uses the explicit rotate operation before staging the replacement proof', () =>
  Effect.gen(function* rotateProof() {
    const operations: unknown[] = [];
    const transaction = invokerWith((key, values) => {
      if (key === 'counterparty-invitation-proof.register') {
        operations.push(values.at(-1));
        return [{ operation_outcome: 'REGISTERED', proof_reference: proofReference }];
      }
      return [{ operation_outcome: 'STAGED', proof_reference: proofReference }];
    });
    const { proofLifecycle } = counterpartyInvitationClaimServicesForTransaction(
      transaction,
      contextAccess(),
      crypto,
      successfulDelivery(),
    );

    const result = yield* proofLifecycle.rotateAndStageDelivery(registrationInput);

    expect(operations).toEqual(['ROTATE']);
    expect(result.state).toBe('DELIVERY_STAGED');
  }),
);

it.effect('fails closed when secure delivery staging fails and never marks delivery staged', () =>
  Effect.gen(function* deliveryFailure() {
    const calls: string[] = [];
    const { proofLifecycle } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith((key) => {
        calls.push(key);
        return [{ operation_outcome: 'REGISTERED', proof_reference: proofReference }];
      }),
      contextAccess(),
      crypto,
      {
        stage: () =>
          Effect.fail(
            new CounterpartyAccessUnavailable({
              code: 'counterparty_access_unavailable',
              reason: 'secure delivery unavailable',
            }),
          ),
      },
    );

    const failure = yield* Effect.flip(proofLifecycle.issueAndStageDelivery(registrationInput));

    expectUnavailable(failure);
    expect(calls).toEqual(['counterparty-invitation-proof.register']);
  }),
);

it.effect('escrows a proof with the exact committed release identity and no plaintext result', () =>
  Effect.gen(function* secureQueueHandoff() {
    const enqueued: Parameters<CounterpartyInvitationProofDeliveryService['stage']>[0][] = [];
    const delivery = secureQueuedCounterpartyInvitationProofDelivery({
      enqueueSealed: (input) =>
        Effect.sync(() => {
          enqueued.push(input);
          return 'ENQUEUED' as const;
        }),
    });
    const { proofLifecycle } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith((key) =>
        key === 'counterparty-invitation-proof.register'
          ? [{ operation_outcome: 'REGISTERED', proof_reference: proofReference }]
          : [{ operation_outcome: 'STAGED', proof_reference: proofReference }],
      ),
      contextAccess(),
      crypto,
      delivery,
    );

    yield* proofLifecycle.issueAndStageDelivery(registrationInput);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      actionInvocationId,
      invitationRef,
      legalEntityId,
      proofReference,
    });
    expect(Redacted.value(first(enqueued).rawProof)).toBe(rawProofText);
  }),
);

it.effect('maps wrong, expired, and rate-limited redemption outcomes to precise safe errors', () =>
  Effect.gen(function* redemptionFailures() {
    const scenarios = [
      ['INVALID', 'invitation_claim_proof_invalid'],
      ['EXPIRED', 'invitation_expired'],
      ['RATE_LIMITED', 'invitation_rate_limited'],
    ] as const;

    for (const [operationOutcome, expectedCode] of scenarios) {
      const redemption = counterpartyInvitationClaimRedemptionForTransaction(
        invokerWith(() => [
          {
            counterparty_resource_id: counterpartyId,
            expires_at: expiresAt,
            intended_permission_codes: intendedPermissions,
            operation_outcome: operationOutcome,
            proof_reference: null,
            storefront_resource_id: storefrontId,
          },
        ]),
        crypto,
        trustedRedemptionScope,
      );
      const failure = yield* Effect.flip(redemption.redeem(redemptionInput));
      expectViolation(failure, expectedCode);
    }
  }),
);

it.effect('binds redemption claimant and owner scope only from authenticated context', () =>
  Effect.gen(function* authenticatedRedemptionScope() {
    const routineValues: (readonly unknown[])[] = [];
    const redemption = counterpartyInvitationClaimRedemptionForTransaction(
      invokerWith((_key, values) => {
        routineValues.push(values);
        return [
          {
            counterparty_resource_id: counterpartyId,
            expires_at: expiresAt,
            intended_permission_codes: intendedPermissions,
            operation_outcome: 'REDEEMED',
            proof_reference: proofReference,
            storefront_resource_id: storefrontId,
          },
        ];
      }),
      crypto,
      trustedRedemptionScope,
    );

    const result = yield* redemption.redeem(redemptionInput);

    expect(result.invitationRef).toEqual(invitationRef);
    expect(result.counterpartyRef.tenantId).toBe(trustedRedemptionScope.tenantId);
    expect(routineValues).toEqual([[invitationId, proofReference, proofDigest, claimantId]]);

    const crossTenantFailure = yield* Effect.flip(
      redemption.redeem({
        ...redemptionInput,
        invitationRef: { ...invitationRef, tenantId: otherTenantId },
      }),
    );
    expectViolation(crossTenantFailure, 'invitation_claimant_mismatch');
    expect(routineValues).toHaveLength(1);
  }),
);

it.effect('rejects a cross-Tenant claimant before authority or persistence can run', () =>
  Effect.gen(function* crossTenantClaim() {
    const routineCalls: string[] = [];
    const authorityCalls: Parameters<NonNullable<ContextAccessService['businessPermissions']>>[0][] = [];
    const { claimAuthority } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith((key) => {
        routineCalls.push(key);
        return [];
      }),
      contextAccess('allowed', authorityCalls),
      crypto,
      successfulDelivery(),
    );

    const failure = yield* Effect.flip(
      claimAuthority.verifyAndConsume({
        ...verificationInput,
        claimant: { ...claimant, tenantId: otherTenantId },
      }),
    );

    expectViolation(failure, 'invitation_claimant_mismatch');
    expect(authorityCalls).toEqual([]);
    expect(routineCalls).toEqual([]);
  }),
);

it.effect('rechecks current inviter authority and stops before consumption when it is denied', () =>
  Effect.gen(function* deniedInviter() {
    const routineCalls: string[] = [];
    const authorityCalls: Parameters<NonNullable<ContextAccessService['businessPermissions']>>[0][] = [];
    const { claimAuthority } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith((key) => {
        routineCalls.push(key);
        return [];
      }),
      contextAccess('denied', authorityCalls),
      crypto,
      successfulDelivery(),
      allowedOwnerAccess,
    );

    const failure = yield* Effect.flip(claimAuthority.verifyAndConsume(verificationInput));

    expectViolation(failure, 'inviter_authority_denied');
    expect(authorityCalls).toEqual([
      {
        principal: inviter,
        targets: [
          {
            permission: 'counterparty.access.manage',
            target: {
              counterpartyId,
              kind: 'counterparty_storefront',
              legalEntityId,
              storefrontId,
              tenantId,
            },
          },
        ],
        trustedStorefrontId: storefrontId,
      },
    ]);
    expect(routineCalls).toEqual([]);
  }),
);

it.effect('owner pending revoke denies invitation claim before Core authority can race', () =>
  Effect.gen(function* denyOwnerRevokeBeforeCoreCheck() {
    const authorityCalls: Parameters<NonNullable<ContextAccessService['businessPermissions']>>[0][] = [];
    const { claimAuthority } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith(() => []),
      contextAccess('allowed', authorityCalls),
      crypto,
      successfulDelivery(),
      () => Effect.succeed('DENIED' as const),
    );

    const failure = yield* Effect.flip(claimAuthority.verifyAndConsume(verificationInput));

    expectViolation(failure, 'inviter_authority_denied');
    expect(authorityCalls).toEqual([]);
  }),
);

it.effect('fails closed when invitation authority has no owner reader', () =>
  Effect.gen(function* missingOwnerReader() {
    const authorityCalls: Parameters<NonNullable<ContextAccessService['businessPermissions']>>[0][] = [];
    const { claimAuthority } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith(() => []),
      contextAccess('allowed', authorityCalls),
      crypto,
      successfulDelivery(),
    );

    const failure = yield* Effect.flip(claimAuthority.verifyAndConsume(verificationInput));

    expect(Schema.is(CounterpartyAccessUnavailable)(failure)).toBe(true);
    expect(authorityCalls).toEqual([]);
  }),
);

it.effect('preflights the exact claimant, invitation, counterparty, and proof without consuming it', () =>
  Effect.gen(function* preflightExactness() {
    const routineCalls: { readonly key: string; readonly values: readonly unknown[] }[] = [];
    const authorityCalls: Parameters<NonNullable<ContextAccessService['businessPermissions']>>[0][] = [];
    const result = yield* verifyCounterpartyInvitationClaimAuthorityForOwnerScope(
      {
        contextAccess: contextAccess('allowed', authorityCalls),
        currentOwnerAccess: allowedOwnerAccess,
        transaction: invokerWith((key, values) => {
          routineCalls.push({ key, values });
          return [
            {
              counterparty_resource_id: counterpartyId,
              intended_permission_codes: intendedPermissions,
              inviter_principal_id: inviterId,
              operation_outcome: 'VERIFIED',
              storefront_resource_id: storefrontId,
            },
          ];
        }),
      },
      {
        claimant,
        claimProofReference: proofReference,
        counterpartyRef,
        invitationRef,
        legalEntityId,
        scope: permissionScope,
      },
    );

    expect(result).toBeUndefined();
    expect(routineCalls).toEqual([
      {
        key: 'counterparty-invitation-proof.verify-claim-authority',
        values: [invitationId, proofReference, counterpartyId, storefrontId, claimantId],
      },
    ]);
    expect(authorityCalls).toEqual([
      {
        principal: inviter,
        targets: [
          {
            permission: 'counterparty.access.manage',
            target: {
              counterpartyId,
              kind: 'counterparty_storefront',
              legalEntityId,
              storefrontId,
              tenantId,
            },
          },
        ],
        trustedStorefrontId: storefrontId,
      },
    ]);
  }),
);

it.effect('preflight denies wrong claimant or Tenant before touching the owner routine', () =>
  Effect.gen(function* preflightScopeMismatch() {
    const calls: string[] = [];
    const ownerScope = {
      contextAccess: contextAccess(),
      currentOwnerAccess: allowedOwnerAccess,
      transaction: invokerWith((key, values) => {
        calls.push(key);
        return values.at(-1) === claimantId
          ? [
              {
                counterparty_resource_id: counterpartyId,
                intended_permission_codes: intendedPermissions,
                inviter_principal_id: inviterId,
                operation_outcome: 'VERIFIED',
                storefront_resource_id: storefrontId,
              },
            ]
          : [
              {
                counterparty_resource_id: counterpartyId,
                intended_permission_codes: intendedPermissions,
                inviter_principal_id: inviterId,
                operation_outcome: 'INVALID',
                storefront_resource_id: storefrontId,
              },
            ];
      }),
    };
    const wrongClaimant = yield* Effect.flip(
      verifyCounterpartyInvitationClaimAuthorityForOwnerScope(ownerScope, {
        claimant: { ...claimant, principalId: inviterId },
        claimProofReference: proofReference,
        counterpartyRef,
        invitationRef,
        legalEntityId,
        scope: permissionScope,
      }),
    );
    expectViolation(wrongClaimant, 'invitation_claim_proof_invalid');
    const wrongTenant = yield* Effect.flip(
      verifyCounterpartyInvitationClaimAuthorityForOwnerScope(ownerScope, {
        claimant: { ...claimant, tenantId: otherTenantId },
        claimProofReference: proofReference,
        counterpartyRef,
        invitationRef,
        legalEntityId,
        scope: permissionScope,
      }),
    );
    expectViolation(wrongTenant, 'invitation_claimant_mismatch');
    expect(calls).toEqual(['counterparty-invitation-proof.verify-claim-authority']);
  }),
);

it.effect('preflight maps expired, revoked, consumed, and partial failures fail closed', () =>
  Effect.gen(function* preflightLifecycle() {
    const outcomes = ['EXPIRED', 'REVOKED', 'CONSUMED'] as const;
    for (const operationOutcome of outcomes) {
      const failure = yield* Effect.flip(
        verifyCounterpartyInvitationClaimAuthorityForOwnerScope(
          {
            contextAccess: contextAccess(),
            currentOwnerAccess: allowedOwnerAccess,
            transaction: invokerWith(() => [
              {
                counterparty_resource_id: counterpartyId,
                intended_permission_codes: intendedPermissions,
                inviter_principal_id: inviterId,
                operation_outcome: operationOutcome,
                storefront_resource_id: storefrontId,
              },
            ]),
          },
          {
            claimant,
            claimProofReference: proofReference,
            counterpartyRef,
            invitationRef,
            legalEntityId,
            scope: permissionScope,
          },
        ),
      );
      expectViolation(
        failure,
        // oxlint-disable-next-line eslint/no-nested-ternary -- The three exhaustive fixture outcomes map directly to their expected violation codes.
        operationOutcome === 'EXPIRED'
          ? 'invitation_expired'
          : operationOutcome === 'CONSUMED'
            ? 'invitation_claim_proof_consumed'
            : 'invitation_claim_proof_invalid',
      );
    }
    const unavailableFailure = yield* Effect.flip(
      verifyCounterpartyInvitationClaimAuthorityForOwnerScope(
        {
          contextAccess: contextAccess(),
          currentOwnerAccess: () => Effect.succeed('UNAVAILABLE' as const),
          transaction: invokerWith(() => [
            {
              counterparty_resource_id: counterpartyId,
              intended_permission_codes: intendedPermissions,
              inviter_principal_id: inviterId,
              operation_outcome: 'VERIFIED',
              storefront_resource_id: storefrontId,
            },
          ]),
        },
        {
          claimant,
          claimProofReference: proofReference,
          counterpartyRef,
          invitationRef,
          legalEntityId,
          scope: permissionScope,
        },
      ),
    );
    expectUnavailable(unavailableFailure);
  }),
);

it.effect('replays the stored same-Action attestation while preserving the exact claim tuple', () =>
  Effect.gen(function* sameActionReplay() {
    const routineValues: (readonly unknown[])[] = [];
    const { claimAuthority } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith((key, values) => {
        if (key === 'counterparty-invitation-proof.consume') {
          routineValues.push(values);
        }
        return [
          {
            attestation_reference: 'stored-attestation-reference',
            operation_outcome: 'REPLAYED',
            verified_at: '2026-09-09T09:01:00.000Z',
          },
        ];
      }),
      contextAccess(),
      crypto,
      successfulDelivery(),
      allowedOwnerAccess,
    );

    const result = yield* claimAuthority.verifyAndConsume(verificationInput);

    expect(result.attestationReference).toBe('stored-attestation-reference');
    expect(result.state).toBe('VERIFIED_AND_CONSUMED');
    expect(routineValues).toEqual([
      [
        invitationId,
        proofReference,
        counterpartyId,
        storefrontId,
        intendedPermissions,
        inviterId,
        claimantId,
        actionInvocationId,
        '11111111-1111-4111-9111-111111111111',
      ],
    ]);
  }),
);

it.effect('rejects reuse by a conflicting Action without releasing an attestation', () =>
  Effect.gen(function* conflictingAction() {
    const { claimAuthority } = counterpartyInvitationClaimServicesForTransaction(
      invokerWith(() => [
        {
          attestation_reference: null,
          operation_outcome: 'USED_BY_ANOTHER_ACTION',
          verified_at: null,
        },
      ]),
      contextAccess(),
      crypto,
      successfulDelivery(),
      allowedOwnerAccess,
    );

    const failure = yield* Effect.flip(claimAuthority.verifyAndConsume(verificationInput));

    expectViolation(failure, 'invitation_claim_proof_consumed');
  }),
);

it.effect('hardens invitation proof SQL with exact scope, locking, rate limits, and no raw secret', () =>
  Effect.gen(function* migrationSecurity() {
    const migrationRoot = new URL('../../drizzle/', import.meta.url);
    const migrationFolders = yield* Effect.promise(() => readdir(migrationRoot, { withFileTypes: true }));
    const migrationFolder = migrationFolders.find(
      (entry) =>
        entry.isDirectory() &&
        entry.name.endsWith('_add-profile-observation-owner-outcome-and-invitation-proof-evidence'),
    );
    const migrationFolderName = migrationFolder?.name;
    if (migrationFolderName === undefined) {
      throw new Error('Invitation-proof evidence migration is missing');
    }
    const sql = yield* Effect.promise(() =>
      readFile(new URL(`${migrationFolderName}/migration.sql`, migrationRoot), 'utf-8'),
    );
    const invitationSqlStart = sql.indexOf(
      'CREATE FUNCTION "commerce_customer_context"."register_invitation_claim_proof"',
    );
    const invitationSqlEnd = sql.indexOf(
      'CREATE FUNCTION "commerce_customer_context"."invalidate_invitation_claim_proofs"',
      invitationSqlStart,
    );
    expect(invitationSqlStart).toBeGreaterThanOrEqual(0);
    expect(invitationSqlEnd).toBeGreaterThan(invitationSqlStart);
    if (invitationSqlStart === -1 || invitationSqlEnd <= invitationSqlStart) {
      throw new Error('Invitation-proof routines or lifecycle hardening are missing');
    }
    const invitationSql = sql.slice(invitationSqlStart, invitationSqlEnd);
    const stageSql = invitationSql.slice(
      invitationSql.indexOf('CREATE FUNCTION "commerce_customer_context"."stage_invitation_claim_proof_delivery"'),
      invitationSql.indexOf('CREATE FUNCTION "commerce_customer_context"."redeem_invitation_claim_secret"'),
    );
    const consumeSql = invitationSql.slice(
      invitationSql.indexOf('CREATE FUNCTION "commerce_customer_context"."consume_invitation_claim_proof"'),
    );

    expect(invitationSql.match(/SECURITY DEFINER/gu) ?? []).toHaveLength(4);
    expect(invitationSql.match(/GRANT EXECUTE ON FUNCTION/gu) ?? []).toHaveLength(4);
    expect(invitationSql.match(/FOR UPDATE/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(invitationSql).toContain('SET search_path = pg_catalog, commerce_customer_context');
    expect(sql).toContain('CREATE UNIQUE INDEX "ccc_invitation_claim_proofs_current_uk"');
    expect(sql).toContain(
      'ALTER TABLE "commerce_customer_context"."counterparty_invitation_claim_proofs" FORCE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "commerce_customer_context"."counterparty_invitation_claim_attempts" FORCE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE "commerce_customer_context"."counterparty_invitation_claim_proofs" FROM PUBLIC, "ontos_runtime";',
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE "commerce_customer_context"."counterparty_invitation_claim_attempts" FROM PUBLIC, "ontos_runtime";',
    );
    expect(invitationSql).toContain('v_new_count >= 5');
    expect(invitationSql).toContain("interval '15 minutes'");
    expect(invitationSql).toContain(
      "last_outcome = CASE WHEN v_outcome = 'EXPIRED' THEN 'INVALID' ELSE 'REDEEMED' END",
    );
    expect(invitationSql).toContain("p_operation = 'ROTATE'");
    expect(invitationSql).toContain("SET lifecycle = 'REVOKED'");
    expect(sql).toContain('CREATE TRIGGER "ccc_invitation_claim_proofs_lifecycle_trg"');
    expect(sql).toContain("NEW.lifecycle IN ('REVOKED', 'EXPIRED', 'CLAIMED')");
    expect(stageSql).toContain("v_invitation.lifecycle <> 'PENDING'");
    expect(stageSql).toContain('v_invitation.expires_at <= statement_timestamp()');
    expect(stageSql).toContain("v_proof.delivery_state = 'STAGED'");
    expect(stageSql).toContain("'REPLAYED'::text");
    expect(consumeSql).toContain('v_proof.consume_action_invocation_id = p_action_invocation_id');
    expect(consumeSql).toContain('v_proof.storefront_resource_id IS DISTINCT FROM p_storefront_resource_id');
    expect(consumeSql).toContain(
      'v_proof.intended_permission_codes IS DISTINCT FROM to_jsonb(p_intended_permission_codes)',
    );
    expect(consumeSql).toContain('v_proof.inviter_principal_id IS DISTINCT FROM p_inviter_principal_id');
    expect(consumeSql).toContain("SET last_attempt_at = statement_timestamp(), last_outcome = 'INVALID'");
    expect(invitationSql).not.toMatch(/\b(?:p_raw_proof|raw_proof|raw_secret|plaintext_proof)\b/iu);
    expect(invitationSql).not.toContain(rawProofText);
    expect(invitationSql).toContain('p_secret_digest text');
    expect(invitationSql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL)\s+ON\s+TABLE/iu);
  }),
);
