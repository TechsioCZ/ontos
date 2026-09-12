import { defineScopedRoutine } from '@app/core-runtime';
import type {
  BusinessAccessTarget,
  ContextAccessService,
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { Effect, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';

import type {
  CounterpartyPermissionScope,
  CounterpartyRef,
  PrincipalRef,
} from '../../shared/domain/access-contract.ts';
import type { CounterpartyPermissionCode } from '../../shared/domain/permission-catalog.ts';
import type { CounterpartyAccessDomainError } from '../../shared/domain/access-error.ts';
import {
  CounterpartyAccessContractViolation,
  CounterpartyAccessUnavailable,
} from '../../shared/domain/access-error.ts';
import type { CounterpartyInvitationClaimRedemptionService } from '../../shared/domain/invitation-claim-redemption.ts';
import type { CounterpartyInvitationProofDeliveryService } from '../../shared/domain/invitation-proof-delivery.ts';
import type { CounterpartyInvitationClaimAuthorityService } from '../../shared/domain/invitation-claim-authority.ts';
import type {
  CounterpartyInvitationProofLifecycleService,
  CounterpartyInvitationProofRegistrationInput,
} from '../../shared/domain/invitation-proof-lifecycle.ts';
import { InvitationClaimProofReferenceSchema } from '../../shared/domain/invitation-contract.ts';
import type { VerifiedInvitationClaimAttestation } from '../../shared/domain/invitation-contract.ts';
import { CounterpartyPermissionCodeSchema } from '../../shared/domain/permission-catalog.ts';

const ownerModuleKey = 'commerce.customer-context';
const proofVersion = 'commerce-invitation-proof.v1' as const;
const invitationExpiredReason = 'The invitation has expired';
const invitationClaimProofInvalidReason = 'The invitation claim proof is invalid';
const accessManagementPermission = 'counterparty.access.manage' as const;
// oxlint-disable-next-line effect-native/no-nullable-schema-field -- PostgreSQL routine result codecs intentionally preserve SQL NULL at the owner boundary.
const nullableText = Schema.NullOr(Schema.String);
const timestamp = Schema.Union([Schema.Date, Schema.String]);
type ClaimVerificationInput = Parameters<CounterpartyInvitationClaimAuthorityService['verifyAndConsume']>[0];
type ClaimRedemptionInput = Parameters<CounterpartyInvitationClaimRedemptionService['redeem']>[0];

export interface InvitationClaimScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const CurrentOwnerAccessDecisionSchema = Schema.Literals(['ALLOWED', 'DENIED', 'UNAVAILABLE']);
export type CurrentOwnerAccessDecision = typeof CurrentOwnerAccessDecisionSchema.Type;

export interface CurrentOwnerAccessDecisionInput {
  readonly counterpartyRef: CounterpartyRef;
  readonly legalEntityId: string;
  readonly permission: CounterpartyPermissionCode;
  readonly principal: PrincipalRef;
  readonly scope: CounterpartyPermissionScope;
}

/** Owner-local authorization is conjunctive with Core's relationship decision. */
export type CurrentOwnerAccessDecisionReader = (
  input: CurrentOwnerAccessDecisionInput,
) => Effect.Effect<CurrentOwnerAccessDecision>;

const RegistrationRowSchema = Schema.Struct({
  operation_outcome: Schema.Literals(['INVALID', 'EXPIRED', 'REGISTERED', 'REPLAYED']),
  proof_reference: nullableText,
});
type RegistrationRow = typeof RegistrationRowSchema.Type;

const registerProofRoutine = defineScopedRoutine({
  name: 'register_invitation_claim_proof',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text[]' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: RegistrationRowSchema,
  routineKey: 'counterparty-invitation-proof.register',
  schema: 'commerce_customer_context',
});

const DeliveryStageRowSchema = Schema.Struct({
  operation_outcome: Schema.Literals(['INVALID', 'STAGED', 'REPLAYED']),
  proof_reference: nullableText,
});
type DeliveryStageRow = typeof DeliveryStageRowSchema.Type;

const stageDeliveryRoutine = defineScopedRoutine({
  name: 'stage_invitation_claim_proof_delivery',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: DeliveryStageRowSchema,
  routineKey: 'counterparty-invitation-proof.stage-delivery',
  schema: 'commerce_customer_context',
});

const RedemptionRowSchema = Schema.Struct({
  counterparty_resource_id: Schema.String,
  expires_at: timestamp,
  intended_permission_codes: Schema.Array(CounterpartyPermissionCodeSchema),
  operation_outcome: Schema.Literals(['EXPIRED', 'INVALID', 'RATE_LIMITED', 'REDEEMED', 'REPLAYED']),
  proof_reference: nullableText,
  storefront_resource_id: nullableText,
});

const redeemProofRoutine = defineScopedRoutine({
  name: 'redeem_invitation_claim_secret',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: RedemptionRowSchema,
  routineKey: 'counterparty-invitation-proof.redeem',
  schema: 'commerce_customer_context',
});

const ConsumptionRowSchema = Schema.Struct({
  attestation_reference: nullableText,
  operation_outcome: Schema.Literals([
    'CONSUMED',
    'EXPIRED',
    'INVALID',
    'RATE_LIMITED',
    'REPLAYED',
    'USED_BY_ANOTHER_ACTION',
  ]),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- PostgreSQL returns SQL NULL before successful consumption.
  verified_at: Schema.NullOr(timestamp),
});
type ConsumptionRow = typeof ConsumptionRowSchema.Type;

const consumeProofRoutine = defineScopedRoutine({
  name: 'consume_invitation_claim_proof',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text[]' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: ConsumptionRowSchema,
  routineKey: 'counterparty-invitation-proof.consume',
  schema: 'commerce_customer_context',
});

const InvitationClaimPreflightRowSchema = Schema.Struct({
  counterparty_resource_id: nullableText,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- PostgreSQL returns SQL NULL when no intended permission projection exists; verification fails closed without changing the external codec; expires: 2027-03-31.
  intended_permission_codes: Schema.NullOr(Schema.Array(CounterpartyPermissionCodeSchema)),
  inviter_principal_id: nullableText,
  operation_outcome: Schema.Literals(['CONSUMED', 'EXPIRED', 'INVALID', 'REVOKED', 'VERIFIED']),
  storefront_resource_id: nullableText,
});
type InvitationClaimPreflightRow = typeof InvitationClaimPreflightRowSchema.Type;

const verifyInvitationClaimAuthorityRoutine = defineScopedRoutine({
  name: 'verify_invitation_claim_authority',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: InvitationClaimPreflightRowSchema,
  routineKey: 'counterparty-invitation-proof.verify-claim-authority',
  schema: 'commerce_customer_context',
});

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const unavailable = (cause?: unknown) => {
  const error = new CounterpartyAccessUnavailable({
    code: 'counterparty_access_unavailable',
    reason: 'Invitation claim verification is temporarily unavailable',
  });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
};

const digestRawProof = (crypto: Crypto.Crypto, rawProof: Redacted.Redacted) =>
  crypto
    .digest('SHA-256', new TextEncoder().encode(Redacted.value(rawProof)))
    .pipe(Effect.map(bytesToHex), Effect.mapError(unavailable));

const violation = (
  code: ConstructorParameters<typeof CounterpartyAccessContractViolation>[0]['code'],
  reason: string,
) => new CounterpartyAccessContractViolation({ code, reason });

const routineFailure = (failure: ScopedRoutineInvocationError) => unavailable(failure);

const storefrontId = (scope: CounterpartyPermissionScope): string | null =>
  scope.kind === 'storefront' ? scope.storefrontKey : null;

const permissionScope = (storefrontResourceId: string | null): CounterpartyPermissionScope =>
  storefrontResourceId === null
    ? { kind: 'counterparty' }
    : { kind: 'storefront', storefrontKey: storefrontResourceId };

const instant = (value: Date | string): string => (Schema.is(Schema.String)(value) ? value : value.toISOString());

const counterpartyRef = (tenantId: string, resourceId: string): CounterpartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.counterparty',
  tenantId,
});

const proofReference = (value: string) =>
  Schema.decodeEffect(InvitationClaimProofReferenceSchema)(value).pipe(Effect.mapError(unavailable));

const invitationTarget = (
  tenantId: string,
  legalEntityId: string,
  counterpartyId: string,
  scope: CounterpartyPermissionScope,
): BusinessAccessTarget =>
  scope.kind === 'counterparty'
    ? { counterpartyId, kind: 'counterparty', legalEntityId, tenantId }
    : {
        counterpartyId,
        kind: 'counterparty_storefront',
        legalEntityId,
        storefrontId: scope.storefrontKey,
        tenantId,
      };

const requireInviterAuthority = (
  ownerScope: Pick<ClaimAuthorityOwnerScope, 'contextAccess' | 'currentOwnerAccess'>,
  input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly inviter: PrincipalRef;
    readonly legalEntityId: string;
    readonly scope: CounterpartyPermissionScope;
  },
): Effect.Effect<void, CounterpartyAccessDomainError> => {
  const check = ownerScope.contextAccess.businessPermissions;
  if (check === undefined) {
    return Effect.fail(unavailable());
  }
  const target = {
    principal: input.inviter,
    targets: [
      {
        permission: accessManagementPermission,
        target: invitationTarget(
          input.counterpartyRef.tenantId,
          input.legalEntityId,
          input.counterpartyRef.resourceId,
          input.scope,
        ),
      },
    ],
  };
  const checked =
    input.scope.kind === 'storefront'
      ? check({ ...target, trustedStorefrontId: input.scope.storefrontKey })
      : check(target);
  const verifyCoreAuthority = checked.pipe(
    Effect.flatMap(([decision]) => {
      if (decision?.decision === 'allowed') {
        return Effect.void;
      }
      return Effect.fail(
        decision?.decision === 'denied'
          ? violation(
              'inviter_authority_denied',
              'The invitation grantor no longer has current administrative authority',
            )
          : unavailable(),
      );
    }),
  );
  if (ownerScope.currentOwnerAccess === undefined) {
    // Invitation authority is owner-governed. Missing current-owner state must fail closed;
    // Core's relationship projection is not a substitute for the owner grant ledger.
    return Effect.fail(unavailable());
  }
  return ownerScope
    .currentOwnerAccess({
      counterpartyRef: input.counterpartyRef,
      legalEntityId: input.legalEntityId,
      permission: accessManagementPermission,
      principal: input.inviter,
      scope: input.scope,
    })
    .pipe(
      Effect.flatMap((decision) => {
        if (decision === 'DENIED') {
          return Effect.fail(
            violation(
              'inviter_authority_denied',
              'The invitation grantor no longer has current administrative authority',
            ),
          );
        }
        if (decision === 'UNAVAILABLE') {
          return Effect.fail(unavailable());
        }
        return verifyCoreAuthority;
      }),
    );
};

interface ProofLifecycleOwnerScope {
  readonly crypto: Crypto.Crypto;
  readonly stageDelivery: CounterpartyInvitationProofDeliveryService['stage'];
  readonly transaction: InvitationClaimScopedRoutineInvoker;
}

interface ClaimAuthorityOwnerScope {
  readonly contextAccess: Pick<ContextAccessService, 'businessPermissions'>;
  readonly crypto: Crypto.Crypto;
  readonly currentOwnerAccess?: CurrentOwnerAccessDecisionReader | undefined;
  readonly transaction: InvitationClaimScopedRoutineInvoker;
}

export interface CounterpartyInvitationClaimPreflightInput {
  readonly claimant: PrincipalRef;
  readonly claimProofReference: string;
  readonly counterpartyRef: CounterpartyRef;
  readonly invitationRef: {
    readonly resourceId: string;
    readonly tenantId: string;
  };
  readonly legalEntityId: string;
  readonly scope: CounterpartyPermissionScope;
}

const validatePreflightTenant = (
  input: CounterpartyInvitationClaimPreflightInput,
): Effect.Effect<void, CounterpartyAccessContractViolation> =>
  input.claimant.tenantId !== input.invitationRef.tenantId ||
  input.counterpartyRef.tenantId !== input.invitationRef.tenantId
    ? Effect.fail(violation('invitation_claimant_mismatch', 'The invitation claim proof is outside the trusted Tenant'))
    : Effect.void;

const validateRegistrationTenant = (
  input: CounterpartyInvitationProofRegistrationInput,
): Effect.Effect<void, CounterpartyAccessContractViolation> =>
  input.counterpartyRef.tenantId !== input.invitationRef.tenantId ||
  input.inviter.tenantId !== input.invitationRef.tenantId
    ? Effect.fail(
        violation('counterparty_scope_mismatch', 'The invitation proof registration is outside the trusted Tenant'),
      )
    : Effect.void;

const validateClaimTenant = (
  input: ClaimVerificationInput,
): Effect.Effect<void, CounterpartyAccessContractViolation> =>
  input.claimant.tenantId !== input.invitationRef.tenantId ||
  input.counterpartyRef.tenantId !== input.invitationRef.tenantId ||
  input.inviter.tenantId !== input.invitationRef.tenantId
    ? Effect.fail(violation('invitation_claimant_mismatch', 'The invitation claim proof is outside the trusted Tenant'))
    : Effect.void;

// oxlint-disable-next-line typescript/consistent-return -- The decoded operation outcome is an exhaustive schema union, so every reachable switch branch returns an Effect.
const validatePreflightOutcome = (
  row: InvitationClaimPreflightRow | undefined,
): Effect.Effect<InvitationClaimPreflightRow, CounterpartyAccessContractViolation> => {
  if (row === undefined) {
    return Effect.fail(violation('invitation_claim_proof_invalid', invitationClaimProofInvalidReason));
  }
  // oxlint-disable-next-line eslint/default-case, effect-native/prefer-match-over-tag-switch -- The decoded operation-outcome schema is exhaustive here, and the grouped invalid/revoked branches are the validator's established failure mapping.
  switch (row.operation_outcome) {
    case 'INVALID':
    case 'REVOKED': {
      return Effect.fail(violation('invitation_claim_proof_invalid', invitationClaimProofInvalidReason));
    }
    case 'EXPIRED': {
      return Effect.fail(violation('invitation_expired', invitationExpiredReason));
    }
    case 'CONSUMED': {
      return Effect.fail(
        violation('invitation_claim_proof_consumed', 'The invitation claim proof has already been consumed'),
      );
    }
    case 'VERIFIED': {
      return Effect.succeed(row);
    }
  }
};

const validatePreflightBinding = (
  row: InvitationClaimPreflightRow,
  input: CounterpartyInvitationClaimPreflightInput,
): Effect.Effect<PrincipalRef, CounterpartyAccessContractViolation> => {
  if (
    row.counterparty_resource_id === null ||
    row.inviter_principal_id === null ||
    row.intended_permission_codes === null ||
    row.storefront_resource_id !== storefrontId(input.scope)
  ) {
    return Effect.fail(violation('invitation_claim_proof_invalid', invitationClaimProofInvalidReason));
  }
  if (row.counterparty_resource_id !== input.counterpartyRef.resourceId) {
    return Effect.fail(violation('invitation_claim_proof_invalid', invitationClaimProofInvalidReason));
  }
  return Effect.succeed({
    principalId: row.inviter_principal_id,
    tenantId: input.invitationRef.tenantId,
  });
};

const validateRegistration = Effect.fn('InvitationClaimAuthorityPersistence.validateRegistration')(
  function* validateInvitationProofRegistration(registration: RegistrationRow | undefined) {
    if (
      registration === undefined ||
      registration.proof_reference === null ||
      registration.operation_outcome === 'INVALID'
    ) {
      return yield* violation('invitation_invalid', 'The invitation proof cannot be registered');
    }
    if (registration.operation_outcome === 'EXPIRED') {
      return yield* violation('invitation_expired', invitationExpiredReason);
    }
    return {
      proofReference: yield* proofReference(registration.proof_reference),
      replayed: registration.operation_outcome === 'REPLAYED',
    };
  },
);

const validateDeliveryStage = (staged: DeliveryStageRow | undefined) =>
  staged?.operation_outcome === 'STAGED' || staged?.operation_outcome === 'REPLAYED'
    ? Effect.void
    : Effect.fail(unavailable());

const validateConsumption = Effect.fn('InvitationClaimAuthorityPersistence.validateConsumption')(
  function* validateInvitationProofConsumption(row: ConsumptionRow | undefined): Effect.fn.Return<
    // oxlint-disable-next-line effect-native/no-string-timestamp-schema -- The PostgreSQL routine returns the verified timestamp as an external transport string before the owning result Schema decodes it.
    { readonly attestationReference: typeof InvitationClaimProofReferenceSchema.Type; readonly verifiedAt: string },
    CounterpartyAccessDomainError
  > {
    if (row === undefined || row.operation_outcome === 'INVALID') {
      return yield* violation('invitation_claim_proof_invalid', invitationClaimProofInvalidReason);
    }
    if (row.operation_outcome === 'EXPIRED') {
      return yield* violation('invitation_expired', invitationExpiredReason);
    }
    if (row.operation_outcome === 'RATE_LIMITED') {
      return yield* violation('invitation_rate_limited', 'Invitation claim attempts are temporarily rate limited');
    }
    if (row.operation_outcome === 'USED_BY_ANOTHER_ACTION') {
      return yield* violation(
        'invitation_claim_proof_consumed',
        'The invitation claim proof has already been consumed',
      );
    }
    if (row.attestation_reference === null || row.verified_at === null) {
      return yield* unavailable();
    }
    return {
      attestationReference: yield* proofReference(row.attestation_reference),
      verifiedAt: instant(row.verified_at),
    };
  },
);

/**
 * Read-only owner proof gate used before Core's Action executor check.  It intentionally does
 * not redeem, consume, or retain the raw proof.  The claim Action repeats the authoritative
 * one-time consume inside its handler transaction, so a concurrent revoke/claim still fails at
 * the existing linearization point.
 */
export const verifyCounterpartyInvitationClaimAuthorityForOwnerScope = Effect.fn(
  'InvitationClaimAuthorityPersistence.verifyClaimAuthority',
)(function* verifyClaimAuthority(
  ownerScope: Pick<ClaimAuthorityOwnerScope, 'contextAccess' | 'currentOwnerAccess' | 'transaction'>,
  input: CounterpartyInvitationClaimPreflightInput,
): Effect.fn.Return<void, CounterpartyAccessDomainError> {
  yield* validatePreflightTenant(input);
  const [row] = yield* ownerScope.transaction
    .invoke(verifyInvitationClaimAuthorityRoutine, [
      input.invitationRef.resourceId,
      input.claimProofReference,
      input.counterpartyRef.resourceId,
      storefrontId(input.scope),
      input.claimant.principalId,
    ])
    .pipe(Effect.mapError(routineFailure));
  const verifiedRow = yield* validatePreflightOutcome(row);
  const inviter = yield* validatePreflightBinding(verifiedRow, input);
  return yield* requireInviterAuthority(ownerScope, {
    counterpartyRef: input.counterpartyRef,
    inviter,
    legalEntityId: input.legalEntityId,
    scope: input.scope,
  });
});

const registerAndStage = Effect.fn('InvitationClaimAuthorityPersistence.registerAndStage')(
  function* registerInvitationProof(
    ownerScope: ProofLifecycleOwnerScope,
    operation: 'ISSUE' | 'ROTATE',
    input: CounterpartyInvitationProofRegistrationInput,
  ) {
    yield* validateRegistrationTenant(input);
    const rawProofBytes = yield* ownerScope.crypto.randomBytes(32).pipe(Effect.mapError(unavailable));
    const rawProof = Redacted.make(bytesToHex(rawProofBytes));
    const digest = yield* digestRawProof(ownerScope.crypto, rawProof);
    const reference = yield* ownerScope.crypto.randomUUIDv4.pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(proofReference),
    );
    const [registration] = yield* ownerScope.transaction
      .invoke(registerProofRoutine, [
        input.invitationRef.resourceId,
        input.counterpartyRef.resourceId,
        storefrontId(input.scope),
        input.intendedPermissions,
        input.inviter.principalId,
        input.deliveryMethod,
        input.deliveryReference,
        input.expiresAt,
        input.actionInvocationId,
        reference,
        digest,
        operation,
      ])
      .pipe(Effect.mapError(routineFailure));
    const validatedRegistration = yield* validateRegistration(registration);
    if (validatedRegistration.replayed) {
      return {
        proofReference: validatedRegistration.proofReference,
        proofVersion,
        state: 'DELIVERY_STAGE_REPLAYED' as const,
      };
    }
    yield* ownerScope.stageDelivery({
      actionInvocationId: input.actionInvocationId,
      counterpartyRef: input.counterpartyRef,
      deliveryMethod: input.deliveryMethod,
      deliveryReference: input.deliveryReference,
      expiresAt: input.expiresAt,
      invitationRef: input.invitationRef,
      legalEntityId: input.legalEntityId,
      proofReference: validatedRegistration.proofReference,
      rawProof,
      scope: input.scope,
    });
    const [staged] = yield* ownerScope.transaction
      .invoke(stageDeliveryRoutine, [
        input.invitationRef.resourceId,
        validatedRegistration.proofReference,
        input.actionInvocationId,
      ])
      .pipe(Effect.mapError(routineFailure));
    yield* validateDeliveryStage(staged);
    return {
      proofReference: validatedRegistration.proofReference,
      proofVersion,
      state: 'DELIVERY_STAGED' as const,
    };
  },
);

const proofLifecycleForOwnerScope = (
  ownerScope: ProofLifecycleOwnerScope,
): CounterpartyInvitationProofLifecycleService =>
  Object.freeze({
    issueAndStageDelivery: (input: CounterpartyInvitationProofRegistrationInput) =>
      registerAndStage(ownerScope, 'ISSUE', input),
    rotateAndStageDelivery: (input: CounterpartyInvitationProofRegistrationInput) =>
      registerAndStage(ownerScope, 'ROTATE', input),
  });

const claimAuthorityForOwnerScope = (
  ownerScope: ClaimAuthorityOwnerScope,
): CounterpartyInvitationClaimAuthorityService =>
  Object.freeze({
    verifyAndConsume: Effect.fn('InvitationClaimAuthorityPersistence.verifyAndConsume')(
      function* verifyAndConsumeInvitationProof(input: ClaimVerificationInput) {
        yield* validateClaimTenant(input);
        yield* requireInviterAuthority(ownerScope, input);
        const attestation = yield* ownerScope.crypto.randomUUIDv4.pipe(
          Effect.mapError(unavailable),
          Effect.flatMap(proofReference),
        );
        const [row] = yield* ownerScope.transaction
          .invoke(consumeProofRoutine, [
            input.invitationRef.resourceId,
            input.claimProofReference,
            input.counterpartyRef.resourceId,
            storefrontId(input.scope),
            input.intendedPermissions,
            input.inviter.principalId,
            input.claimant.principalId,
            input.actionInvocationId,
            attestation,
          ])
          .pipe(Effect.mapError(routineFailure));
        const consumption = yield* validateConsumption(row);
        return {
          attestationReference: consumption.attestationReference,
          claimant: input.claimant,
          counterpartyRef: input.counterpartyRef,
          invitationRef: input.invitationRef,
          inviterAuthority: {
            decision: 'ALLOWED',
            inviter: input.inviter,
            permission: accessManagementPermission,
            scope: input.scope,
          },
          proofVersion,
          state: 'VERIFIED_AND_CONSUMED',
          verifiedAt: consumption.verifiedAt,
        } satisfies VerifiedInvitationClaimAttestation;
      },
    ),
  });

export const counterpartyInvitationClaimServicesForTransaction = (
  transaction: InvitationClaimScopedRoutineInvoker,
  contextAccess: Pick<ContextAccessService, 'businessPermissions'>,
  crypto: Crypto.Crypto,
  delivery: { readonly stage: ProofLifecycleOwnerScope['stageDelivery'] },
  currentOwnerAccess?: CurrentOwnerAccessDecisionReader,
) =>
  Object.freeze({
    claimAuthority: claimAuthorityForOwnerScope({
      contextAccess,
      crypto,
      currentOwnerAccess,
      transaction,
    }),
    proofLifecycle: proofLifecycleForOwnerScope({
      crypto,
      stageDelivery: delivery.stage,
      transaction,
    }),
  });

export const counterpartyInvitationClaimRedemptionForTransaction = (
  transaction: InvitationClaimScopedRoutineInvoker,
  crypto: Crypto.Crypto,
  trustedScope: OperationalScope & { readonly legalEntityId: string },
): CounterpartyInvitationClaimRedemptionService => ({
  redeem: Effect.fn('InvitationClaimAuthorityPersistence.redeem')(function* redeemInvitationSecret(
    input: ClaimRedemptionInput,
  ) {
    if (input.invitationRef.tenantId !== trustedScope.tenantId) {
      return yield* violation(
        'invitation_claimant_mismatch',
        'The invitation proof is outside the authenticated Tenant',
      );
    }
    const digest = yield* digestRawProof(crypto, input.rawProof);
    const [row] = yield* transaction
      .invoke(redeemProofRoutine, [
        input.invitationRef.resourceId,
        input.proofReference,
        digest,
        trustedScope.principalId,
      ])
      .pipe(Effect.mapError(routineFailure));
    if (row === undefined || row.operation_outcome === 'INVALID') {
      return yield* violation('invitation_claim_proof_invalid', invitationClaimProofInvalidReason);
    }
    if (row.operation_outcome === 'EXPIRED') {
      return yield* violation('invitation_expired', invitationExpiredReason);
    }
    if (row.operation_outcome === 'RATE_LIMITED') {
      return yield* violation('invitation_rate_limited', 'Invitation claim attempts are temporarily rate limited');
    }
    if (row.proof_reference === null) {
      return yield* unavailable();
    }
    return {
      counterpartyRef: counterpartyRef(trustedScope.tenantId, row.counterparty_resource_id),
      expiresAt: instant(row.expires_at),
      intendedPermissions: row.intended_permission_codes,
      invitationRef: input.invitationRef,
      proofReference: yield* proofReference(row.proof_reference),
      scope: permissionScope(row.storefront_resource_id),
    };
  }),
});

export const invitationClaimProofRoutineAllowlist = Object.freeze([
  registerProofRoutine,
  stageDeliveryRoutine,
  redeemProofRoutine,
  consumeProofRoutine,
  verifyInvitationClaimAuthorityRoutine,
]);
