import { defineScopedRoutine, PrincipalEligibility } from '@app/core-runtime';
import type {
  OperationalScope,
  PrincipalEligibilityService,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { accessPortalWritesForTransaction } from '@app/core-runtime/access/portal';
import type { AccessPortalError, AccessPortalTransaction, AccessPortalWrites } from '@app/core-runtime/access/portal';
import { Crypto, Effect, Option, Result, Schema } from 'effect';

import type {
  CounterpartyAccessGrant,
  CounterpartyPermissionScope,
  CounterpartyRef,
  PrincipalRef,
} from '../../shared/domain/access-contract.ts';
import {
  CounterpartyInvitationProofDelivery,
  CounterpartyAccessContractViolation,
  CounterpartyAccessUnavailable,
} from '../../shared/domain/access-port.ts';
import type {
  ClaimCounterpartyAccessInvitationInput,
  CounterpartyInvitationClaimAuthorityService,
  CounterpartyInvitationProofLifecycleService,
  CounterpartyAccessCheckInput,
  CounterpartyAccessDomainError,
  CounterpartyAccessPortService,
  CreateCounterpartyAccessInvitationOutcome,
  CreateCounterpartyAccessInvitationInput,
  GrantCounterpartyAccessInput,
  InvitationMutationInput,
  InvitationClaimRejection,
  ResendCounterpartyAccessInvitationOutcome,
  RevokeCounterpartyAccessInput,
} from '../../shared/domain/access-port.ts';
import { InvitationGrantProgressSchema } from '../../shared/domain/invitation-contract.ts';
import type {
  CounterpartyAccessInvitation,
  VerifiedInvitationClaimAttestation,
} from '../../shared/domain/invitation-contract.ts';
import { CounterpartyPermissionCodeSchema } from '../../shared/domain/permission-catalog.ts';
import { counterpartyInvitationClaimServicesForTransaction } from './invitation-claim-authority-persistence.ts';
import { COUNTERPARTY_CUSTOMER_PORTAL_ROLE, COUNTERPARTY_INVITEE_PORTAL_ROLE } from '../portal-access/portal-roles.ts';
import {
  counterpartyAccessGrantSource,
  counterpartyInvitationRedemptionSource,
} from '../portal-access/portal-sources.ts';
import type {
  CurrentOwnerAccessDecision,
  CurrentOwnerAccessDecisionInput,
  CurrentOwnerAccessDecisionReader,
} from './invitation-claim-authority-persistence.ts';

const timestampSchema = Schema.Union([Schema.Date, Schema.String]);
const customerContextModuleKey = 'commerce.customer-context';
const accessManagementPermission = 'counterparty.access.manage' as const;
const counterpartyModuleKey = 'party.registry' as const;
const counterpartyResourceType = 'party.registry.counterparty' as const;
const invitationProofVersion = 'commerce-invitation-proof.v1' as const;
const invitationUnavailableReason = 'The invitation is unavailable in scope';
const invitationOutsideScopeReason = 'The invitation is outside the trusted scope';
/* oxlint-disable effect-native/no-nullable-schema-field -- Owner-routine result codecs intentionally decode SQL NULL; mapping below converts absence into omitted public fields. */
const nullableTimestampSchema = Schema.NullOr(timestampSchema);

const AccessGrantRowSchema = Schema.Struct({
  counterparty_resource_id: Schema.String,
  grant_id: Schema.String,
  granted_at: timestampSchema,
  granted_by: Schema.String,
  // `access_grant_row` projects its `p_operation_outcome` argument, which a plain listing or lock
  // leaves NULL: only a mutation routine has an outcome to report through the shared row shape.
  operation_outcome: Schema.optionalKey(
    Schema.NullOr(
      Schema.Literals([
        'ALREADY_ACTIVE',
        'ALREADY_REVOKED',
        'APPLIED',
        'CONFLICT',
        'LAST_ADMIN_PROTECTED',
        'PROFILE_NOT_FOUND',
        'REVOKED',
        'SCOPE_MISMATCH',
      ]),
    ),
  ),
  permission_code: CounterpartyPermissionCodeSchema,
  principal_id: Schema.String,
  reason: Schema.NullOr(Schema.String),
  revision: Schema.Int,
  revoked_at: nullableTimestampSchema,
  revoked_by: Schema.NullOr(Schema.String),
  state: Schema.Literals(['ACTIVE', 'REVOKED']),
  storefront_resource_id: Schema.NullOr(Schema.String),
});
type AccessGrantRow = typeof AccessGrantRowSchema.Type;

/** The closed lifecycle vocabulary of `counterparty_access_invitations`, under either column name. */
const InvitationLifecycleSchema = Schema.Literals(['PENDING', 'CLAIMING', 'CLAIMED', 'REVOKED', 'EXPIRED']);

const InvitationRowFieldsSchema = Schema.Struct({
  claimed_at: nullableTimestampSchema,
  claimed_by_principal_id: Schema.NullOr(Schema.String),
  counterparty_resource_id: Schema.String,
  created_at: timestampSchema,
  delivery_method: Schema.Literals(['VERIFIED_CONTACT_POINT', 'APPROVED_RECIPIENT_DISCOVERY']),
  delivery_reference: Schema.String,
  expires_at: timestampSchema,
  grant_progress: Schema.Array(InvitationGrantProgressSchema),
  invitation_id: Schema.String,
  invited_by: Schema.String,
  // `read_access_invitation` projects `NULL::text` into this column: a plain read has no mutation
  // outcome, while `create_access_invitation` and `mutate_access_invitation` alias their own here.
  operation_outcome: Schema.optionalKey(
    Schema.NullOr(
      Schema.Literals([
        'ALREADY_CLAIMED',
        'ALREADY_PENDING',
        'ALREADY_REVOKED',
        'ALREADY_SENT',
        'CLAIM_REJECTED',
        'CLAIMING',
        'CREATED',
        'EXPIRED',
        'INVALID',
        'RESENT',
        'REVOKED',
        'REVISION_CONFLICT',
      ]),
    ),
  ),
  reason: Schema.String,
  requested_permission_codes: Schema.Array(CounterpartyPermissionCodeSchema),
  revision: Schema.Int,
  state: InvitationLifecycleSchema,
  storefront_resource_id: Schema.NullOr(Schema.String),
});
type InvitationRow = typeof InvitationRowFieldsSchema.Type;

const invitationRowProgressFacts = (row: InvitationRow) => {
  const intended = row.requested_permission_codes;
  const intendedSet = new Set(intended);
  const progress = row.grant_progress;
  return {
    exactProgress:
      progress.length === intended.length &&
      new Set(progress.map(({ permission }) => permission)).size === progress.length &&
      progress.every(({ permission }) => intendedSet.has(permission)),
    intendedSet,
    progress,
    uniqueIntended: intended.length > 0 && intendedSet.size === intended.length,
  };
};

const validateInvitationPermissionSet = (uniqueIntended: boolean) =>
  uniqueIntended ? undefined : 'invitation Permission set must be non-empty and unique';

const validateUnclaimedInvitationRow = (row: InvitationRow) =>
  row.grant_progress.length === 0 && row.claimed_by_principal_id === null
    ? undefined
    : 'unclaimed invitation rows cannot expose claimant or grant progress';

const validateRevokedInvitationRow = (row: InvitationRow, exactProgress: boolean) =>
  row.grant_progress.length === 0 || exactProgress
    ? undefined
    : 'revoked invitation rows must preserve no progress or exact progress';

const validateClaimingInvitationRow = (row: InvitationRow, exactProgress: boolean) => {
  if (row.claimed_by_principal_id === null || !exactProgress) {
    return 'claiming invitation rows require claimant and exact Permission progress';
  }
  const allActive = row.grant_progress.every(({ state }) => state === 'ACTIVE');
  return (row.state === 'CLAIMED' && allActive) || (row.state === 'CLAIMING' && !allActive)
    ? undefined
    : 'invitation row lifecycle must match exact grant progress';
};

const validateInvitationRow = (row: InvitationRow) => {
  const facts = invitationRowProgressFacts(row);
  const permissionError = validateInvitationPermissionSet(facts.uniqueIntended);
  if (permissionError !== undefined) {
    return permissionError;
  }
  if (row.state === 'PENDING' || row.state === 'EXPIRED') {
    return validateUnclaimedInvitationRow(row);
  }
  if (row.state === 'REVOKED') {
    return validateRevokedInvitationRow(row, facts.exactProgress);
  }
  return validateClaimingInvitationRow(row, facts.exactProgress);
};

const InvitationRowSchema = InvitationRowFieldsSchema.check(Schema.makeFilter(validateInvitationRow));
const InvitationMutationRowSchema = Schema.Struct({
  ...InvitationRowSchema.fields,
  mutation_id: Schema.NullOr(Schema.String),
});
type InvitationMutationRow = typeof InvitationMutationRowSchema.Type;
/* oxlint-enable effect-native/no-nullable-schema-field */

const listAccessGrantsRoutine = defineScopedRoutine({
  name: 'list_access_grants',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
  ],
  resultSchema: AccessGrantRowSchema,
  routineKey: 'counterparty-access.list-grants',
  schema: 'commerce_customer_context',
});

/** Locks the actor's owner grant rows so owner authorization and a following mutation share one
 * transaction-linearization point. The result shape intentionally matches list_access_grants. */
const lockAccessGrantAuthorityRoutine = defineScopedRoutine({
  name: 'lock_access_grant_authority',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: AccessGrantRowSchema,
  routineKey: 'counterparty-access.lock-grant-authority',
  schema: 'commerce_customer_context',
});

const grantAccessRoutine = defineScopedRoutine({
  name: 'grant_access',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: AccessGrantRowSchema,
  routineKey: 'counterparty-access.grant',
  schema: 'commerce_customer_context',
});

const revokeAccessRoutine = defineScopedRoutine({
  name: 'revoke_access',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'text' },
  ],
  resultSchema: AccessGrantRowSchema,
  routineKey: 'counterparty-access.revoke',
  schema: 'commerce_customer_context',
});

const InvitationClaimReconciliationRowSchema = Schema.Struct({
  ...InvitationRowSchema.fields,
  attestation_reference: Schema.String,
  claim_mutation_id: Schema.String,
  /** The immutable claim subject survives clearing the active claimant during revoke. */
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- PostgreSQL returns NULL for legacy claim rows without an origin projection.
  claim_subject_principal_id: Schema.NullOr(Schema.String),
  source_action_invocation_id: Schema.String,
  verified_at: timestampSchema,
});

const readEnrollmentInvitationClaimRoutine = defineScopedRoutine({
  name: 'read_enrollment_invitation_claim',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: InvitationClaimReconciliationRowSchema,
  routineKey: 'counterparty-access.read-enrollment-invitation-claim',
  schema: 'commerce_customer_context',
});

const InvitationRedemptionRowSchema = Schema.Struct({
  claimant_principal_id: Schema.String,
  proof_reference: Schema.String,
});

/** Every principal that redeemed a claim proof of one invitation, with the proof it redeemed. */
const readInvitationRedemptionsRoutine = defineScopedRoutine({
  name: 'read_invitation_claim_redemptions',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: InvitationRedemptionRowSchema,
  routineKey: 'counterparty-access.read-invitation-redemptions',
  schema: 'commerce_customer_context',
});

const createAccessInvitationRoutine = defineScopedRoutine({
  name: 'create_access_invitation',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text[]' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: InvitationRowSchema,
  routineKey: 'counterparty-access.create-invitation',
  schema: 'commerce_customer_context',
});

const readAccessInvitationRoutine = defineScopedRoutine({
  name: 'read_access_invitation',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
  ],
  resultSchema: InvitationRowSchema,
  routineKey: 'counterparty-access.read-invitation',
  schema: 'commerce_customer_context',
});

/* oxlint-disable effect-native/no-nullable-schema-field -- The routine projects SQL NULL for every invitation fact an unknown or unclaimed invitation has none of; the mapping below turns each absence into an omitted public field. */
const InvitationClaimabilityRowSchema = Schema.Struct({
  claim_proof_reference: Schema.optionalKey(Schema.NullOr(Schema.String)),
  claimable: Schema.Boolean,
  claimed_by_principal_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lifecycle: Schema.optionalKey(Schema.NullOr(InvitationLifecycleSchema)),
});
/* oxlint-enable effect-native/no-nullable-schema-field */
type InvitationClaimabilityRow = typeof InvitationClaimabilityRowSchema.Type;

const readCounterpartyInvitationClaimabilityRoutine = defineScopedRoutine({
  name: 'read_counterparty_invitation_claimability',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: InvitationClaimabilityRowSchema,
  routineKey: 'counterparty-access.read-invitation-claimability',
  schema: 'commerce_customer_context',
});

const mutateAccessInvitationRoutine = defineScopedRoutine({
  name: 'mutate_access_invitation',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'text' },
  ],
  resultSchema: InvitationMutationRowSchema,
  routineKey: 'counterparty-access.mutate-invitation',
  schema: 'commerce_customer_context',
});

const instant = (value: Date | string): string => (Schema.is(Schema.String)(value) ? value : value.toISOString());

const scopeStorefront = (scope: CounterpartyPermissionScope): string | null =>
  scope.kind === 'storefront' ? scope.storefrontKey : null;

const accessUnavailable = (failure?: ScopedRoutineInvocationError) => {
  const unavailable = new CounterpartyAccessUnavailable({
    code: 'counterparty_access_unavailable',
    reason: 'Counterparty Commerce Access is temporarily unavailable',
  });
  return failure === undefined
    ? unavailable
    : Object.defineProperty(unavailable, 'cause', {
        configurable: false,
        enumerable: false,
        value: failure,
      });
};

/** Core could not write the portal access a grant stands for, so the owner transaction rolls back with it. */
const portalAccessUnavailable = (failure: AccessPortalError) =>
  Object.defineProperty(
    new CounterpartyAccessUnavailable({
      code: 'counterparty_access_unavailable',
      reason: `Counterparty Commerce Access could not write its portal access (${failure.code})`,
    }),
    'cause',
    { configurable: false, enumerable: false, value: failure },
  );

type ViolationCode = ConstructorParameters<typeof CounterpartyAccessContractViolation>[0]['code'];
const violation = (code: ViolationCode, reason: string) => new CounterpartyAccessContractViolation({ code, reason });

/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional public contract fields are deliberately omitted when their database value is NULL. */
const grantFromRow = (tenantId: string, row: AccessGrantRow): CounterpartyAccessGrant => ({
  catalogVersion: '1',
  counterpartyRef: {
    moduleId: counterpartyModuleKey,
    resourceId: row.counterparty_resource_id,
    resourceType: counterpartyResourceType,
    tenantId,
  },
  grantedAt: instant(row.granted_at),
  grantedBy: { principalId: row.granted_by, tenantId },
  grantRef: {
    moduleId: customerContextModuleKey,
    resourceId: row.grant_id,
    resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
    tenantId,
  },
  permission: row.permission_code,
  ...(row.reason === null ? {} : { reason: row.reason }),
  recipient: { principalId: row.principal_id, tenantId },
  revision: row.revision,
  ...(row.revoked_at === null ? {} : { revokedAt: instant(row.revoked_at) }),
  ...(row.revoked_by === null ? {} : { revokedBy: { principalId: row.revoked_by, tenantId } }),
  scope:
    row.storefront_resource_id === null
      ? { kind: 'counterparty' }
      : { kind: 'storefront', storefrontKey: row.storefront_resource_id },
  state: row.state,
});

const invitationFromRow = (tenantId: string, row: InvitationRow): CounterpartyAccessInvitation => ({
  catalogVersion: '1',
  claimProofVersion: invitationProofVersion,
  ...(row.claimed_by_principal_id === null ? {} : { claimant: { principalId: row.claimed_by_principal_id, tenantId } }),
  counterpartyRef: {
    moduleId: counterpartyModuleKey,
    resourceId: row.counterparty_resource_id,
    resourceType: counterpartyResourceType,
    tenantId,
  },
  createdAt: instant(row.created_at),
  deliveryMethod: row.delivery_method,
  deliveryReference: row.delivery_reference,
  expiresAt: instant(row.expires_at),
  grantProgress: row.grant_progress,
  intendedPermissions: row.requested_permission_codes,
  invitationRef: {
    moduleId: customerContextModuleKey,
    resourceId: row.invitation_id,
    resourceType: 'commerce.customer-context.counterparty-access-invitation',
    tenantId,
  },
  invitedBy: { principalId: row.invited_by, tenantId },
  reason: row.reason,
  revision: row.revision,
  scope:
    row.storefront_resource_id === null
      ? { kind: 'counterparty' }
      : { kind: 'storefront', storefrontKey: row.storefront_resource_id },
  state: row.state,
});

const exactScope = (
  scope: OperationalScope & { readonly legalEntityId: string },
  input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly legalEntityId?: string;
    readonly principalRefs?: readonly PrincipalRef[];
  },
): boolean =>
  input.counterpartyRef.tenantId === scope.tenantId &&
  (input.legalEntityId === undefined || input.legalEntityId === scope.legalEntityId) &&
  (input.principalRefs ?? []).every(({ tenantId }) => tenantId === scope.tenantId);

const ownerGrantMatchesScope = (row: AccessGrantRow, permissionScope: CounterpartyPermissionScope): boolean =>
  permissionScope.kind === 'counterparty'
    ? row.storefront_resource_id === null
    : row.storefront_resource_id === null || row.storefront_resource_id === permissionScope.storefrontKey;

type OwnerGrantReadResult = Result.Result<readonly AccessGrantRow[], ScopedRoutineInvocationError>;

const ownerAccessDecisionFromRows = (
  rows: readonly AccessGrantRow[],
  input: CurrentOwnerAccessDecisionInput,
): CurrentOwnerAccessDecision => {
  const relevant = rows.filter(
    (row) => row.permission_code === input.permission && ownerGrantMatchesScope(row, input.scope),
  );
  // A broad ACTIVE owner grant is authoritative for a narrower requested scope, and a revoked
  // row for that narrower scope never shadows it.
  return relevant.some(({ state }) => state === 'ACTIVE') ? 'ALLOWED' : 'DENIED';
};

const ownerAccessDecisionFromResult =
  (input: CurrentOwnerAccessDecisionInput) =>
  (result: OwnerGrantReadResult): CurrentOwnerAccessDecision =>
    Result.match(result, {
      onFailure: () => 'UNAVAILABLE' as const,
      onSuccess: (rows) => ownerAccessDecisionFromRows(rows, input),
    });

const readOwnerGrantRows = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  input: CurrentOwnerAccessDecisionInput,
  lock: boolean,
): Effect.Effect<OwnerGrantReadResult> =>
  transaction
    .invoke(lock ? lockAccessGrantAuthorityRoutine : listAccessGrantsRoutine, [
      input.counterpartyRef.resourceId,
      input.principal.principalId,
    ])
    .pipe(Effect.result);

/**
 * Decide a Counterparty-scoped capability from the owner-local grant rows alone. Only an ACTIVE
 * grant allows; historical revoked rows never restore authority.
 */
export const currentOwnerAccessForTransaction =
  (
    transaction: CounterpartyAccessScopedRoutineInvoker,
    scope: Pick<OperationalScope, 'tenantId'> & { readonly legalEntityId: string },
    options: Readonly<{ readonly lock?: boolean }> = {},
  ): CurrentOwnerAccessDecisionReader =>
  (input: CurrentOwnerAccessDecisionInput): Effect.Effect<CurrentOwnerAccessDecision> => {
    if (
      input.counterpartyRef.tenantId !== scope.tenantId ||
      input.principal.tenantId !== scope.tenantId ||
      input.legalEntityId !== scope.legalEntityId
    ) {
      return Effect.succeed('UNAVAILABLE');
    }
    return readOwnerGrantRows(transaction, input, options.lock === true).pipe(
      Effect.map(ownerAccessDecisionFromResult(input)),
    );
  };

/** Read the exact grant projection used by invitation preflight, including its decision. */
export const snapshotCurrentOwnerAccess = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  scope: Pick<OperationalScope, 'tenantId'> & { readonly legalEntityId: string },
  input: CurrentOwnerAccessDecisionInput,
) => {
  if (
    input.counterpartyRef.tenantId !== scope.tenantId ||
    input.principal.tenantId !== scope.tenantId ||
    input.legalEntityId !== scope.legalEntityId
  ) {
    return Effect.succeed({ decision: 'UNAVAILABLE' as const, rows: [] });
  }
  return readOwnerGrantRows(transaction, input, false).pipe(
    Effect.flatMap((result) =>
      Result.isFailure(result)
        ? Effect.fail(accessUnavailable(result.failure))
        : Effect.succeed({
            decision: ownerAccessDecisionFromRows(result.success, input),
            rows: result.success.map((row) => ({
              ...row,
              granted_at: instant(row.granted_at),
              revoked_at: row.revoked_at === null ? null : instant(row.revoked_at),
            })),
          }),
    ),
  );
};

export const lockingCurrentOwnerAccessForTransaction = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  scope: Pick<OperationalScope, 'tenantId'> & { readonly legalEntityId: string },
): CurrentOwnerAccessDecisionReader => currentOwnerAccessForTransaction(transaction, scope, { lock: true });

/* oxlint-disable effect-native/no-dependency-parameters -- This owner adapter captures one verified transaction-scoped capability and typed collaborators, then exposes only the narrow public port to handlers. */
const requireEligible = Effect.fn('AccessPersistence.requireEligible')(function* requireEligiblePrincipal(
  eligibility: PrincipalEligibilityService,
  principal: PrincipalRef,
): Effect.fn.Return<void, CounterpartyAccessDomainError> {
  const result = yield* eligibility.resolve(principal);
  if (result.decision === 'eligible') {
    return yield* Effect.void;
  }
  if (result.decision === 'unavailable') {
    return yield* accessUnavailable();
  }
  return yield* violation(
    'principal_not_eligible',
    'The target Principal is not active and eligible in the trusted Tenant',
  );
});

export interface CounterpartyAccessPersistenceContext {
  readonly claimAuthority: CounterpartyInvitationClaimAuthorityService;
  /**
   * The owner's own Counterparty grant rows are the only authority for a Counterparty-scoped
   * capability (O67-Q1). Core's v2 gate decides the capability itself; it never sees the
   * customer's per-Counterparty grant.
   */
  readonly currentOwnerAccess?: CurrentOwnerAccessDecisionReader;
  readonly eligibility: PrincipalEligibilityService;
  /**
   * Core's portal access over the owner transaction: an ACTIVE grant is the grantee's portal role in this
   * Legal Entity, and a REVOKED one ends it, in the same commit (O62, O75).
   */
  readonly portalAccess: AccessPortalWrites;
  readonly proofLifecycle: CounterpartyInvitationProofLifecycleService;
  readonly scope: OperationalScope & { readonly legalEntityId: string };
  readonly transaction: CounterpartyAccessScopedRoutineInvoker;
  /** Trusted gateway-derived storefront identity. Request payload values never populate it. */
  readonly trustedStorefrontId?: string | undefined;
}

const isTrustedPermissionScope = (
  dependencies: CounterpartyAccessPersistenceContext,
  scope: CounterpartyPermissionScope,
): boolean => scope.kind === 'counterparty' || dependencies.trustedStorefrontId === scope.storefrontKey;

const samePermissionScope = (left: CounterpartyPermissionScope, right: CounterpartyPermissionScope): boolean =>
  left.kind === right.kind &&
  (left.kind === 'counterparty' || (right.kind === 'storefront' && left.storefrontKey === right.storefrontKey));

const attestationMatchesClaimantAndInvitation = (
  attestation: VerifiedInvitationClaimAttestation,
  input: ClaimCounterpartyAccessInvitationInput,
): boolean =>
  attestation.claimant.tenantId === input.claimant.tenantId &&
  attestation.claimant.principalId === input.claimant.principalId &&
  attestation.counterpartyRef.tenantId === input.counterpartyRef.tenantId &&
  attestation.counterpartyRef.resourceId === input.counterpartyRef.resourceId &&
  attestation.invitationRef.tenantId === input.invitationRef.tenantId &&
  attestation.invitationRef.resourceId === input.invitationRef.resourceId;

const attestationMatchesInviterAuthority = (
  attestation: VerifiedInvitationClaimAttestation,
  inviter: PrincipalRef,
): boolean =>
  attestation.inviterAuthority.decision === 'ALLOWED' &&
  attestation.inviterAuthority.permission === accessManagementPermission &&
  attestation.inviterAuthority.inviter.tenantId === inviter.tenantId &&
  attestation.inviterAuthority.inviter.principalId === inviter.principalId;

const attestationMatchesClaim = (
  attestation: VerifiedInvitationClaimAttestation,
  input: ClaimCounterpartyAccessInvitationInput,
  inviter: PrincipalRef,
): boolean =>
  attestation.state === 'VERIFIED_AND_CONSUMED' &&
  attestation.proofVersion === invitationProofVersion &&
  attestationMatchesClaimantAndInvitation(attestation, input) &&
  attestationMatchesInviterAuthority(attestation, inviter) &&
  samePermissionScope(attestation.inviterAuthority.scope, input.scope);

const requireCurrentInviterAuthority = (
  dependencies: CounterpartyAccessPersistenceContext,
  inviter: PrincipalRef,
  counterpartyRef: CounterpartyRef,
  permissionScope: CounterpartyPermissionScope,
): Effect.Effect<void, CounterpartyAccessDomainError> => {
  if (!isTrustedPermissionScope(dependencies, permissionScope) || dependencies.currentOwnerAccess === undefined) {
    // The owner's grant rows are the only authority for a Counterparty-scoped capability, so a
    // missing owner reader is an unavailable deployment seam, never an allow (O67-Q1).
    return Effect.fail(accessUnavailable());
  }
  return dependencies
    .currentOwnerAccess({
      counterpartyRef,
      legalEntityId: dependencies.scope.legalEntityId,
      permission: accessManagementPermission,
      principal: inviter,
      scope: permissionScope,
    })
    .pipe(
      Effect.flatMap((decision): Effect.Effect<void, CounterpartyAccessDomainError> => {
        if (decision === 'DENIED') {
          return Effect.fail(
            violation(
              'inviter_authority_denied',
              'The inviter no longer holds Counterparty access management authority',
            ),
          );
        }
        if (decision === 'UNAVAILABLE') {
          return Effect.fail(accessUnavailable());
        }
        return Effect.void;
      }),
    );
};

/** Minimum owner-local database capability; Actions never receive this object. */
export interface CounterpartyAccessScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const firstGrant = <Row extends AccessGrantRow>(
  rows: readonly Row[],
): Effect.Effect<Row, CounterpartyAccessUnavailable> =>
  rows[0] === undefined ? Effect.fail(accessUnavailable()) : Effect.succeed(rows[0]);

const durableClaimRejection = (failure: CounterpartyAccessDomainError): InvitationClaimRejection | undefined => {
  if (!Schema.is(CounterpartyAccessContractViolation)(failure)) {
    return undefined;
  }
  if (failure.code === 'invitation_claim_proof_consumed') {
    return 'ALREADY_CONSUMED';
  }
  if (failure.code === 'invitation_claim_proof_invalid') {
    return 'INVALID_PROOF';
  }
  if (failure.code === 'invitation_expired') {
    return 'EXPIRED';
  }
  return failure.code === 'invitation_rate_limited' ? 'RATE_LIMITED' : undefined;
};

const verifyOrPersistClaimRejection = (
  dependencies: CounterpartyAccessPersistenceContext,
  input: ClaimCounterpartyAccessInvitationInput,
  row: InvitationMutationRow,
  inviter: PrincipalRef,
) =>
  Effect.matchEffect(
    dependencies.claimAuthority.verifyAndConsume({
      actionInvocationId: input.actionInvocationId,
      claimant: input.claimant,
      claimProofReference: input.claimProofReference,
      counterpartyRef: input.counterpartyRef,
      intendedPermissions: row.requested_permission_codes,
      invitationRef: input.invitationRef,
      inviter,
      legalEntityId: input.legalEntityId,
      scope: input.scope,
    }),
    {
      onFailure: (failure) => {
        const rejection = durableClaimRejection(failure);
        if (rejection === undefined) {
          return Effect.fail(failure);
        }
        return dependencies.transaction
          .invoke(mutateAccessInvitationRoutine, [
            input.invitationRef.resourceId,
            input.counterpartyRef.resourceId,
            scopeStorefront(input.scope),
            row.revision,
            rejection === 'EXPIRED' ? 'EXPIRE_CLAIM' : 'REJECT_CLAIM',
            input.actor.principalId,
            input.actionInvocationId,
            input.reason ?? null,
            input.claimant.principalId,
            input.claimProofReference,
          ])
          .pipe(
            Effect.mapError(accessUnavailable),
            Effect.flatMap(([rejected]) =>
              rejected !== undefined &&
              (rejected.operation_outcome === 'CLAIM_REJECTED' || rejected.operation_outcome === 'EXPIRED')
                ? Effect.succeed({
                    invitation: invitationFromRow(dependencies.scope.tenantId, rejected),
                    rejection,
                    verified: false as const,
                  })
                : Effect.fail(accessUnavailable()),
            ),
          );
      },
      onSuccess: (attestation) => Effect.succeed({ attestation, verified: true as const }),
    },
  );

/** The grantee holds the Counterparty portal role while this grant row is ACTIVE (one source per row). */
const followActiveGrant = (dependencies: CounterpartyAccessPersistenceContext, row: AccessGrantRow) =>
  dependencies.portalAccess
    .grant({
      legalEntityId: dependencies.scope.legalEntityId,
      principalId: row.principal_id,
      role: COUNTERPARTY_CUSTOMER_PORTAL_ROLE,
      source: counterpartyAccessGrantSource(row.grant_id),
    })
    .pipe(Effect.mapError(portalAccessUnavailable), Effect.asVoid);

/** A REVOKED grant row ends exactly the portal assignment it stood for. */
const followRevokedGrant = (dependencies: CounterpartyAccessPersistenceContext, row: AccessGrantRow) =>
  dependencies.portalAccess
    .revoke({
      legalEntityId: dependencies.scope.legalEntityId,
      principalId: row.principal_id,
      role: COUNTERPARTY_CUSTOMER_PORTAL_ROLE,
      source: counterpartyAccessGrantSource(row.grant_id),
    })
    .pipe(Effect.mapError(portalAccessUnavailable), Effect.asVoid);

const grantAccess = (
  dependencies: CounterpartyAccessPersistenceContext,
  input: GrantCounterpartyAccessInput,
  bootstrap: boolean,
): ReturnType<CounterpartyAccessPortService['grant']> => {
  if (
    !exactScope(dependencies.scope, {
      counterpartyRef: input.counterpartyRef,
      legalEntityId: input.legalEntityId,
      principalRefs: [input.actor, input.recipient],
    }) ||
    !isTrustedPermissionScope(dependencies, input.scope)
  ) {
    return Effect.fail(
      violation('counterparty_scope_mismatch', 'The grant does not match the verified operation scope'),
    );
  }
  return Effect.gen(function* persistAccessGrant() {
    yield* requireEligible(dependencies.eligibility, input.recipient);
    const rows = yield* dependencies.transaction
      .invoke(grantAccessRoutine, [
        input.counterpartyRef.resourceId,
        input.recipient.principalId,
        input.permission,
        scopeStorefront(input.scope),
        input.actor.principalId,
        input.actionInvocationId,
        input.reason ?? null,
        bootstrap,
      ])
      .pipe(Effect.mapError(accessUnavailable));
    const row = yield* firstGrant(rows);
    const grant = grantFromRow(dependencies.scope.tenantId, row);
    if (row.operation_outcome === 'PROFILE_NOT_FOUND') {
      return yield* violation('counterparty_scope_mismatch', 'The Counterparty is unavailable in scope');
    }
    if (row.operation_outcome === 'CONFLICT') {
      return { grant, outcome: 'CONFLICT' as const };
    }
    if (row.operation_outcome === 'ALREADY_ACTIVE') {
      yield* followActiveGrant(dependencies, row);
      return { grant, outcome: 'ALREADY_ACTIVE' as const };
    }
    // The owner's grant row is the whole authority (O67-Q1), so the grant is ACTIVE when its
    // routine returns (O62).
    if (row.operation_outcome !== 'APPLIED' || row.state !== 'ACTIVE') {
      return yield* accessUnavailable();
    }
    yield* followActiveGrant(dependencies, row);
    return { grant, outcome: 'APPLIED' as const };
  });
};

const revokeAccess = (
  dependencies: CounterpartyAccessPersistenceContext,
  input: RevokeCounterpartyAccessInput,
): ReturnType<CounterpartyAccessPortService['revoke']> => {
  if (
    !exactScope(dependencies.scope, {
      counterpartyRef: input.counterpartyRef,
      legalEntityId: input.legalEntityId,
      principalRefs: [input.actor, input.recipient],
    }) ||
    !isTrustedPermissionScope(dependencies, input.scope) ||
    (input.grantRef !== undefined && input.grantRef.tenantId !== dependencies.scope.tenantId)
  ) {
    return Effect.fail(
      violation('counterparty_scope_mismatch', 'The revoke does not match the verified operation scope'),
    );
  }
  return Effect.gen(function* persistAccessRevoke() {
    const rows = yield* dependencies.transaction
      .invoke(revokeAccessRoutine, [
        input.counterpartyRef.resourceId,
        input.grantRef?.resourceId ?? null,
        input.recipient.principalId,
        input.permission,
        scopeStorefront(input.scope),
        input.actor.principalId,
        input.actionInvocationId,
        input.reason ?? null,
      ])
      .pipe(Effect.mapError(accessUnavailable));
    const row = yield* firstGrant(rows);
    const grant = grantFromRow(dependencies.scope.tenantId, row);
    if (row.operation_outcome === 'LAST_ADMIN_PROTECTED') {
      return { grant, outcome: 'LAST_ADMIN_PROTECTED' as const };
    }
    if (row.operation_outcome === 'SCOPE_MISMATCH' || row.operation_outcome === 'PROFILE_NOT_FOUND') {
      return { grant, outcome: 'SCOPE_MISMATCH' as const };
    }
    if (row.operation_outcome === 'ALREADY_REVOKED') {
      yield* followRevokedGrant(dependencies, row);
      return { grant, outcome: 'ALREADY_REVOKED' as const };
    }
    // A revoke is final in the owner transaction (O62, O67-Q1).
    if (row.operation_outcome !== 'REVOKED' || row.state !== 'REVOKED') {
      return yield* accessUnavailable();
    }
    yield* followRevokedGrant(dependencies, row);
    return { grant, outcome: 'REVOKED' as const };
  });
};

const readInvitation = (
  dependencies: CounterpartyAccessPersistenceContext,
  input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly invitationId: string;
    readonly scope: CounterpartyPermissionScope;
  },
) =>
  dependencies.transaction
    .invoke(readAccessInvitationRoutine, [
      input.invitationId,
      input.counterpartyRef.resourceId,
      scopeStorefront(input.scope),
    ])
    .pipe(
      Effect.mapError(accessUnavailable),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(violation('invitation_invalid', invitationUnavailableReason))
          : Effect.succeed(invitationFromRow(dependencies.scope.tenantId, row)),
      ),
    );

/**
 * One invitation, read over a scoped transaction alone.
 *
 * The enrollment claim route needs the invitation's current revision to present the
 * compare-and-set the claim Action demands, and it holds a scoped owner transaction rather than the
 * whole access port — which would drag the proof-delivery, eligibility and crypto seams a read
 * never touches into an HTTP group. Scope is still the routine's own: it refuses any Tenant or
 * Legal Entity the transaction did not install, and it answers an out-of-scope invitation exactly
 * as an absent one.
 */
export const readCounterpartyAccessInvitationForScope = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  tenantId: string,
  input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly invitationId: string;
    readonly scope: CounterpartyPermissionScope;
  },
): Effect.Effect<CounterpartyAccessInvitation, CounterpartyAccessDomainError> =>
  transaction
    .invoke(readAccessInvitationRoutine, [
      input.invitationId,
      input.counterpartyRef.resourceId,
      scopeStorefront(input.scope),
    ])
    .pipe(
      Effect.mapError(accessUnavailable),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(violation('invitation_invalid', invitationUnavailableReason))
          : Effect.succeed(invitationFromRow(tenantId, row)),
      ),
    );

/** What the durable invitation says about one claim, for a caller holding the invitation id alone. */
export interface CounterpartyInvitationClaimability {
  /** PENDING, unexpired, with an unexpired STAGED proof still to present. */
  readonly claimable: boolean;
  readonly claimedByPrincipalId: string | undefined;
  /** The attestation reference a finished claim stamped, absent while none has. */
  readonly claimProofReference: string | undefined;
  /** Absent exactly when this scope holds no such invitation. */
  readonly lifecycle: CounterpartyInvitationLifecycle | undefined;
}

type CounterpartyInvitationLifecycle = typeof InvitationLifecycleSchema.Type;

const claimabilityFromRow = (row: InvitationClaimabilityRow | undefined): CounterpartyInvitationClaimability => ({
  claimable: row?.claimable === true,
  claimedByPrincipalId: row?.claimed_by_principal_id ?? undefined,
  claimProofReference: row?.claim_proof_reference ?? undefined,
  lifecycle: row?.lifecycle ?? undefined,
});

/**
 * Whether the named invitation id can still be claimed: PENDING, unexpired, in this scope's Tenant
 * and Legal Entity, with a VERIFIED and STAGED proof that has not itself expired — and, alongside
 * that, the lifecycle, claimant and claim attestation reference the invitation durably carries.
 *
 * No existing read is keyed by invitation id alone: `read_access_invitation` needs the counterparty
 * resource id and storefront key an unclaimed invitation has not disclosed to its recipient yet, and
 * `verify_invitation_claim_authority` needs a presented proof reference no caller holds before it
 * starts a claim. This lets enrollment-start refuse an unknown, consumed, revoked or expired
 * invitation before it spends any budget or creates an Attempt and provider account nothing can ever
 * complete — without revealing which of those refusal reasons applied — and lets an enrollment claim
 * whose answer never arrived be settled from the invitation instead of claimed a second time.
 */
export const readCounterpartyInvitationClaimability = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  invitationId: string,
): Effect.Effect<CounterpartyInvitationClaimability, CounterpartyAccessDomainError> =>
  transaction.invoke(readCounterpartyInvitationClaimabilityRoutine, [invitationId]).pipe(
    Effect.mapError(accessUnavailable),
    Effect.map(([row]) => claimabilityFromRow(row)),
  );

/** Original accepted claim plus current owner/Core access; this read never repeats the recipient proof. */
export const readEnrollmentInvitationClaimCurrent = Effect.fn('AccessPersistence.readEnrollmentInvitationClaimCurrent')(
  function* readEnrollmentInvitationClaimCurrentEffect(
    transaction: CounterpartyAccessScopedRoutineInvoker,
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    input: { readonly expectedAttestation?: string; readonly invitationId: string; readonly principalId: string },
  ) {
    const rows = yield* transaction
      .invoke(readEnrollmentInvitationClaimRoutine, [input.invitationId, input.principalId])
      .pipe(Effect.mapError(accessUnavailable));
    if (rows.length > 1) {
      return yield* accessUnavailable();
    }
    const [row] = rows;
    if (row === undefined) {
      return Option.none();
    }
    const invitation = invitationFromRow(scope.tenantId, row);
    const accepted = {
      attestationReference: row.attestation_reference,
      invitation,
      mutationId: row.claim_mutation_id,
      sourceActionInvocationId: row.source_action_invocation_id,
    };
    if (
      row.invitation_id !== input.invitationId ||
      row.claim_subject_principal_id !== input.principalId ||
      row.claimed_by_principal_id !== input.principalId ||
      row.state !== 'CLAIMED' ||
      (input.expectedAttestation !== undefined && input.expectedAttestation !== row.attestation_reference)
    ) {
      return Option.some({ ...accepted, current: false });
    }
    const principal = { principalId: input.principalId, tenantId: scope.tenantId };
    const owner = currentOwnerAccessForTransaction(transaction, scope);
    const ownerDecisions = yield* Effect.forEach(
      invitation.intendedPermissions,
      (permission) =>
        owner({
          counterpartyRef: invitation.counterpartyRef,
          legalEntityId: scope.legalEntityId,
          permission,
          principal,
          scope: invitation.scope,
        }),
      { concurrency: 1 },
    );
    // The owner's own grant rows are the only authority left to re-read (O67-Q1): nothing is
    // projected into a second permission store, so a granted claim is current exactly while
    // every intended Permission still has its ACTIVE owner row.
    return Option.some({ ...accepted, current: ownerDecisions.every((decision) => decision === 'ALLOWED') });
  },
);

const mutateInvitation = (
  dependencies: CounterpartyAccessPersistenceContext,
  input: InvitationMutationInput,
  operation: 'RESEND' | 'REVOKE',
) => {
  if (
    !exactScope(dependencies.scope, {
      counterpartyRef: input.counterpartyRef,
      legalEntityId: input.legalEntityId,
      principalRefs: [input.actor],
    }) ||
    !isTrustedPermissionScope(dependencies, input.scope) ||
    input.invitationRef.tenantId !== dependencies.scope.tenantId
  ) {
    return Effect.fail(violation('invitation_invalid', invitationOutsideScopeReason));
  }
  return dependencies.transaction
    .invoke(mutateAccessInvitationRoutine, [
      input.invitationRef.resourceId,
      input.counterpartyRef.resourceId,
      scopeStorefront(input.scope),
      input.expectedRevision,
      operation,
      input.actor.principalId,
      input.actionInvocationId,
      input.reason ?? null,
      null,
      null,
    ])
    .pipe(
      Effect.mapError(accessUnavailable),
      Effect.flatMap(([row]) => {
        if (row === undefined || row.operation_outcome === 'INVALID') {
          return Effect.fail(violation('invitation_invalid', invitationUnavailableReason));
        }
        if (row.operation_outcome === 'REVISION_CONFLICT') {
          return Effect.fail(violation('invitation_revision_conflict', 'The invitation changed concurrently'));
        }
        if (row.operation_outcome === 'EXPIRED') {
          return Effect.fail(violation('invitation_expired', 'The invitation has expired'));
        }
        return Effect.succeed(row);
      }),
    );
};

type InvitationClaimStart =
  | Readonly<{ readonly invitation: CounterpartyAccessInvitation; readonly kind: 'ALREADY_CLAIMED' }>
  | Readonly<{
      readonly inviter: PrincipalRef;
      readonly kind: 'READY';
      readonly row: InvitationMutationRow;
    }>
  | Readonly<{ readonly code: ViolationCode; readonly kind: 'VIOLATION'; readonly reason: string }>
  | Readonly<{ readonly kind: 'UNAVAILABLE' }>;

const prepareInvitationClaimStart = (
  dependencies: CounterpartyAccessPersistenceContext,
  input: ClaimCounterpartyAccessInvitationInput,
  row: InvitationMutationRow,
): InvitationClaimStart => {
  if (row.operation_outcome === 'INVALID') {
    return { code: 'invitation_invalid', kind: 'VIOLATION', reason: invitationUnavailableReason };
  }
  if (row.operation_outcome === 'ALREADY_CLAIMED') {
    return row.claimed_by_principal_id === input.claimant.principalId
      ? { invitation: invitationFromRow(dependencies.scope.tenantId, row), kind: 'ALREADY_CLAIMED' }
      : {
          code: 'invitation_claimant_mismatch',
          kind: 'VIOLATION',
          reason: 'The invitation was claimed by a different Principal',
        };
  }
  if (row.operation_outcome === 'REVISION_CONFLICT') {
    return { code: 'invitation_revision_conflict', kind: 'VIOLATION', reason: 'The invitation changed concurrently' };
  }
  if (row.operation_outcome === 'EXPIRED') {
    return { code: 'invitation_expired', kind: 'VIOLATION', reason: 'The invitation has expired' };
  }
  if (row.mutation_id === null) {
    return { kind: 'UNAVAILABLE' };
  }
  return {
    inviter: {
      principalId: row.invited_by,
      tenantId: dependencies.scope.tenantId,
    },
    kind: 'READY',
    row,
  };
};

const beginInvitationClaim = (
  dependencies: CounterpartyAccessPersistenceContext,
  input: ClaimCounterpartyAccessInvitationInput,
) =>
  dependencies.transaction
    .invoke(mutateAccessInvitationRoutine, [
      input.invitationRef.resourceId,
      input.counterpartyRef.resourceId,
      scopeStorefront(input.scope),
      input.expectedRevision,
      'BEGIN_CLAIM',
      input.actor.principalId,
      input.actionInvocationId,
      input.reason ?? null,
      input.claimant.principalId,
      input.claimProofReference,
    ])
    .pipe(Effect.mapError(accessUnavailable));

const grantInvitationClaimPermissions = Effect.fn('AccessPersistence.grantInvitationClaimPermissions')(
  function* grantInvitationClaimPermissionsEffect(
    dependencies: CounterpartyAccessPersistenceContext,
    input: ClaimCounterpartyAccessInvitationInput,
    row: InvitationMutationRow,
    inviter: PrincipalRef,
  ) {
    yield* requireCurrentInviterAuthority(dependencies, inviter, input.counterpartyRef, input.scope);
    const grants = yield* Effect.forEach(
      row.requested_permission_codes,
      (permission) =>
        grantAccess(
          dependencies,
          {
            actionInvocationId: input.actionInvocationId,
            actor: input.actor,
            counterpartyRef: input.counterpartyRef,
            legalEntityId: input.legalEntityId,
            permission,
            reason: input.reason,
            recipient: input.claimant,
            scope: input.scope,
          },
          false,
        ),
      { concurrency: 1 },
    );
    yield* requireCurrentInviterAuthority(dependencies, inviter, input.counterpartyRef, input.scope);
    return grants;
  },
);

/**
 * Every intended grant must be ACTIVE in this transaction. A conflicting grant fails the claim
 * closed and the single owner transaction rolls back, leaving the invitation recoverable (O67-Q1).
 */
const requireActiveClaimGrants = (
  grants: readonly { readonly outcome: string }[],
): Effect.Effect<void, CounterpartyAccessUnavailable> =>
  grants.some(({ outcome }) => outcome !== 'APPLIED' && outcome !== 'ALREADY_ACTIVE')
    ? Effect.fail(accessUnavailable())
    : Effect.void;

/**
 * Every claimed grant became ACTIVE in this transaction, so the invitation claim closes here. A
 * claim that does not reach CLAIMED is an owner defect (O62, O67-Q1).
 */
const finishInvitationClaim = Effect.fn('AccessPersistence.finishInvitationClaim')(
  function* finishInvitationClaimEffect(
    dependencies: CounterpartyAccessPersistenceContext,
    input: ClaimCounterpartyAccessInvitationInput,
    row: InvitationMutationRow,
    attestation: VerifiedInvitationClaimAttestation,
  ) {
    const completedRows = yield* dependencies.transaction
      .invoke(mutateAccessInvitationRoutine, [
        input.invitationRef.resourceId,
        input.counterpartyRef.resourceId,
        scopeStorefront(input.scope),
        row.revision,
        'FINISH_CLAIM',
        input.actor.principalId,
        input.actionInvocationId,
        input.reason ?? null,
        input.claimant.principalId,
        attestation.attestationReference,
      ])
      .pipe(Effect.mapError(accessUnavailable));
    const [completed] = completedRows;
    if (completed === undefined || completed.state !== 'CLAIMED') {
      return yield* accessUnavailable();
    }
    return {
      attestation,
      invitation: invitationFromRow(dependencies.scope.tenantId, completed),
      outcome: 'CLAIMED' as const,
    };
  },
);

const counterpartyAccessCheckInScope = (
  scope: OperationalScope & { readonly legalEntityId: string },
  trustedStorefrontId: string | undefined,
  input: CounterpartyAccessCheckInput,
): boolean =>
  exactScope(scope, { counterpartyRef: input.counterpartyRef, principalRefs: [input.principal] }) &&
  input.principal.principalId === scope.principalId &&
  (input.scope.kind === 'counterparty' || trustedStorefrontId === input.scope.storefrontKey);

/**
 * Every claim proof of the invitation that somebody redeemed admitted that person as an invitee, one Core
 * assignment per proof. Once the invitation is claimed, resent or revoked, none of those proofs can be claimed
 * any more — the claim consumed one, a resend revoked the earlier one, a revocation revoked them all — so every
 * such assignment ends here, in the owner's transaction, not only the one a claim consumed.
 */
/** Grants visible within the caller's already-checked Counterparty or Storefront scope. */
const listCounterpartyAccessGrants = (
  dependencies: CounterpartyAccessPersistenceContext,
  input: Parameters<CounterpartyAccessPortService['list']>[0],
) =>
  dependencies.transaction
    .invoke(listAccessGrantsRoutine, [input.counterpartyRef.resourceId, input.recipient?.principalId ?? null])
    .pipe(
      Effect.mapError(accessUnavailable),
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const grant = grantFromRow(dependencies.scope.tenantId, row);
          const included =
            input.scope.kind === 'counterparty'
              ? grant.scope.kind === 'counterparty'
              : grant.scope.kind === 'counterparty' ||
                (grant.scope.kind === 'storefront' && grant.scope.storefrontKey === input.scope.storefrontKey);
          return included ? [grant] : [];
        }),
      ),
    );

const endInvitationRedemptions = (dependencies: CounterpartyAccessPersistenceContext, invitationId: string) =>
  dependencies.transaction.invoke(readInvitationRedemptionsRoutine, [invitationId]).pipe(
    Effect.mapError(accessUnavailable),
    Effect.flatMap((redemptions) =>
      Effect.forEach(
        redemptions,
        (redemption) =>
          dependencies.portalAccess
            .revoke({
              legalEntityId: dependencies.scope.legalEntityId,
              principalId: redemption.claimant_principal_id,
              role: COUNTERPARTY_INVITEE_PORTAL_ROLE,
              source: counterpartyInvitationRedemptionSource(invitationId, redemption.proof_reference),
            })
            .pipe(Effect.mapError(portalAccessUnavailable)),
        // Each revocation locks its person and decides on what the one before it left.
        { concurrency: 1, discard: true },
      ),
    ),
  );

export const counterpartyAccessPortForTransaction = (
  dependencies: CounterpartyAccessPersistenceContext,
): CounterpartyAccessPortService => {
  const service: CounterpartyAccessPortService = {
    bootstrapAdministrator: (input) => grantAccess(dependencies, input, true),
    check: (input) => {
      if (!counterpartyAccessCheckInScope(dependencies.scope, dependencies.trustedStorefrontId, input)) {
        return Effect.succeed('UNAVAILABLE' as const);
      }
      if (dependencies.currentOwnerAccess === undefined) {
        // The registered Read's gate admits the caller. Its exact owner grant is still mandatory.
        return Effect.succeed('UNAVAILABLE' as const);
      }
      return dependencies.currentOwnerAccess({
        counterpartyRef: input.counterpartyRef,
        legalEntityId: dependencies.scope.legalEntityId,
        permission: input.permission,
        principal: input.principal,
        scope: input.scope,
      });
    },
    claimInvitation: (input: ClaimCounterpartyAccessInvitationInput) => {
      if (
        !exactScope(dependencies.scope, {
          counterpartyRef: input.counterpartyRef,
          legalEntityId: input.legalEntityId,
          principalRefs: [input.actor, input.claimant],
        }) ||
        !isTrustedPermissionScope(dependencies, input.scope) ||
        input.invitationRef.tenantId !== dependencies.scope.tenantId
      ) {
        return Effect.fail(violation('invitation_claimant_mismatch', 'The claimant is outside the trusted scope'));
      }
      return Effect.gen(function* persistInvitationClaim() {
        yield* requireEligible(dependencies.eligibility, input.claimant);
        const [row] = yield* beginInvitationClaim(dependencies, input);
        if (row === undefined) {
          return yield* violation('invitation_invalid', invitationUnavailableReason);
        }
        const start = prepareInvitationClaimStart(dependencies, input, row);
        if (start.kind === 'VIOLATION') {
          return yield* violation(start.code, start.reason);
        }
        if (start.kind === 'UNAVAILABLE') {
          return yield* accessUnavailable();
        }
        if (start.kind === 'ALREADY_CLAIMED') {
          yield* endInvitationRedemptions(dependencies, input.invitationRef.resourceId);
          return { invitation: start.invitation, outcome: 'ALREADY_CLAIMED' as const };
        }
        const { inviter } = start;
        const verification = yield* verifyOrPersistClaimRejection(dependencies, input, row, inviter);
        if (!verification.verified) {
          return {
            invitation: verification.invitation,
            outcome: 'REJECTED' as const,
            rejection: verification.rejection,
          };
        }
        const { attestation } = verification;
        if (!attestationMatchesClaim(attestation, input, inviter)) {
          return yield* violation(
            'invitation_claim_proof_invalid',
            'The verified claim attestation does not match this invitation claim',
          );
        }
        yield* grantInvitationClaimPermissions(dependencies, input, row, inviter).pipe(
          Effect.flatMap(requireActiveClaimGrants),
        );
        const claimed = yield* finishInvitationClaim(dependencies, input, row, attestation);
        yield* endInvitationRedemptions(dependencies, input.invitationRef.resourceId);
        return claimed;
      });
    },
    createInvitation: Effect.fn('CounterpartyAccessPort.createInvitation')(function* createInvitation(
      input: CreateCounterpartyAccessInvitationInput,
    ): Effect.fn.Return<CreateCounterpartyAccessInvitationOutcome, CounterpartyAccessDomainError> {
      if (
        !exactScope(dependencies.scope, {
          counterpartyRef: input.counterpartyRef,
          legalEntityId: input.legalEntityId,
          principalRefs: [input.actor],
        }) ||
        !isTrustedPermissionScope(dependencies, input.scope)
      ) {
        return yield* violation('counterparty_scope_mismatch', 'The invitation is outside the trusted scope');
      }
      const [row] = yield* dependencies.transaction
        .invoke(createAccessInvitationRoutine, [
          input.counterpartyRef.resourceId,
          input.deliveryMethod,
          input.deliveryReference,
          input.intendedPermissions,
          scopeStorefront(input.scope),
          input.expiresAt,
          input.actor.principalId,
          input.actionInvocationId,
          input.reason,
        ])
        .pipe(Effect.mapError(accessUnavailable));
      if (row === undefined || row.operation_outcome === 'INVALID') {
        return yield* violation('invitation_invalid', 'The invitation could not be created');
      }
      const invitation = invitationFromRow(dependencies.scope.tenantId, row);
      if (row.operation_outcome === 'ALREADY_PENDING') {
        return { invitation, outcome: 'ALREADY_PENDING' };
      }
      yield* dependencies.proofLifecycle.issueAndStageDelivery({
        actionInvocationId: input.actionInvocationId,
        counterpartyRef: invitation.counterpartyRef,
        deliveryMethod: invitation.deliveryMethod,
        deliveryReference: invitation.deliveryReference,
        expiresAt: invitation.expiresAt,
        intendedPermissions: invitation.intendedPermissions,
        invitationRef: invitation.invitationRef,
        inviter: invitation.invitedBy,
        legalEntityId: input.legalEntityId,
        scope: invitation.scope,
      });
      return { invitation, outcome: 'CREATED' };
    }),
    getInvitation: (input) =>
      exactScope(dependencies.scope, {
        counterpartyRef: input.counterpartyRef,
        legalEntityId: input.legalEntityId,
        principalRefs: [input.actor],
      }) &&
      isTrustedPermissionScope(dependencies, input.scope) &&
      input.invitationRef.tenantId === dependencies.scope.tenantId
        ? readInvitation(dependencies, {
            counterpartyRef: input.counterpartyRef,
            invitationId: input.invitationRef.resourceId,
            scope: input.scope,
          })
        : Effect.fail(violation('invitation_invalid', invitationOutsideScopeReason)),
    grant: (input) => grantAccess(dependencies, input, false),
    list: (input) =>
      exactScope(dependencies.scope, {
        counterpartyRef: input.counterpartyRef,
        legalEntityId: input.legalEntityId,
        principalRefs: [input.actor, ...(input.recipient === undefined ? [] : [input.recipient])],
      }) && isTrustedPermissionScope(dependencies, input.scope)
        ? listCounterpartyAccessGrants(dependencies, input)
        : Effect.fail(accessUnavailable()),
    resendInvitation: Effect.fn('CounterpartyAccessPort.resendInvitation')(function* resendInvitation(
      input: InvitationMutationInput,
    ): Effect.fn.Return<ResendCounterpartyAccessInvitationOutcome, CounterpartyAccessDomainError> {
      const row = yield* mutateInvitation(dependencies, input, 'RESEND');
      const invitation = invitationFromRow(dependencies.scope.tenantId, row);
      if (row.operation_outcome === 'ALREADY_SENT') {
        return { invitation, outcome: 'ALREADY_SENT' };
      }
      yield* dependencies.proofLifecycle.rotateAndStageDelivery({
        actionInvocationId: input.actionInvocationId,
        counterpartyRef: invitation.counterpartyRef,
        deliveryMethod: invitation.deliveryMethod,
        deliveryReference: invitation.deliveryReference,
        expiresAt: invitation.expiresAt,
        intendedPermissions: invitation.intendedPermissions,
        invitationRef: invitation.invitationRef,
        inviter: invitation.invitedBy,
        legalEntityId: input.legalEntityId,
        scope: invitation.scope,
      });
      // The rotation revoked the earlier proof, so the invitee access its redemption admitted ends with it.
      yield* endInvitationRedemptions(dependencies, input.invitationRef.resourceId);
      return { invitation, outcome: 'RESENT' };
    }),
    revoke: (input) => revokeAccess(dependencies, input),
    revokeInvitation: (input) =>
      mutateInvitation(dependencies, input, 'REVOKE').pipe(
        // The revocation revoked every proof of the invitation, and with them the invitee access they admitted.
        Effect.tap(() => endInvitationRedemptions(dependencies, input.invitationRef.resourceId)),
        Effect.map((row) => ({
          invitation: invitationFromRow(dependencies.scope.tenantId, row),
          outcome: row.operation_outcome === 'ALREADY_REVOKED' ? ('ALREADY_REVOKED' as const) : ('REVOKED' as const),
        })),
      ),
  };
  return Object.freeze(service);
};

/**
 * Transaction-scoped production binding. It closes over Core's verified owner capability and
 * exposes only the public access port to handlers.
 */
export const counterpartyAccessPortForOwnerTransaction = Effect.fn(
  'AccessPersistence.counterpartyAccessPortForOwnerTransaction',
)(function* bindCounterpartyAccessPort(
  transaction: CounterpartyAccessScopedRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
  portalAccess: AccessPortalWrites,
) {
  const crypto = yield* Crypto.Crypto;
  const eligibility = yield* PrincipalEligibility;
  const proofDelivery = yield* CounterpartyInvitationProofDelivery;
  const currentOwnerAccess = lockingCurrentOwnerAccessForTransaction(transaction, scope);
  const { claimAuthority, proofLifecycle } = counterpartyInvitationClaimServicesForTransaction(
    transaction,
    crypto,
    proofDelivery,
    currentOwnerAccess,
  );
  return counterpartyAccessPortForTransaction({
    claimAuthority,
    currentOwnerAccess,
    eligibility,
    portalAccess,
    proofLifecycle,
    scope,
    transaction,
    ...(scope.trustedStorefrontId === undefined ? {} : { trustedStorefrontId: scope.trustedStorefrontId }),
  });
});

/** The port of a governed Action: Core's portal writes run over the Action's own scoped transaction. */
export const counterpartyAccessPortForScopedTransaction = (
  transaction: CounterpartyAccessScopedRoutineInvoker & AccessPortalTransaction,
  scope: OperationalScope & { readonly legalEntityId: string },
) =>
  counterpartyAccessPortForOwnerTransaction(transaction, scope, accessPortalWritesForTransaction(transaction, scope));

/* oxlint-enable effect-native/no-dependency-parameters */
/* oxlint-enable anti-slop/no-conditional-empty-object-spread */
