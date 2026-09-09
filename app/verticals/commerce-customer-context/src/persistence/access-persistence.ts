import {
  AuthorizationMutationReconciliationUnavailable,
  AuthorizationMutationSagaError,
  ContextAccess,
  defineScopedRoutine,
  PrincipalEligibility,
  reconcileCommittedAuthorizationMutation,
} from '@app/core-runtime';
import type {
  AuthorizationMutationJournalEntry,
  AuthorizationMutationReconcilerService,
  BusinessAccessTarget,
  BusinessPermissionRelationshipMutationService,
  ContextAccessService,
  OperationalScope,
  OutboxWorkerLegalEntityScope,
  PrincipalEligibilityService,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { Crypto, DateTime, Effect, Result, Schema } from 'effect';

import type {
  CounterpartyAccessDecision,
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
import type {
  CurrentOwnerAccessDecision,
  CurrentOwnerAccessDecisionInput,
  CurrentOwnerAccessDecisionReader,
} from './invitation-claim-authority-persistence.ts';
import { AccessAuthorizationMutationWorkerRejected } from '../workers/access-authorization-mutation-reconciliation.ts';
import type {
  AccessAuthorizationMutationReconciliationService,
  AccessAuthorizationMutationRequest,
  AccessAuthorizationMutationWorkerError,
} from '../workers/access-authorization-mutation-reconciliation.ts';

const timestampSchema = Schema.Union([Schema.Date, Schema.String]);
const customerContextModuleKey = 'commerce.customer-context';
const accessManagementPermission = 'counterparty.access.manage' as const;
const counterpartyModuleKey = 'party.registry' as const;
const counterpartyResourceType = 'party.registry.counterparty' as const;
const invitationProofVersion = 'commerce-invitation-proof.v1' as const;
const invitationUnavailableReason = 'The invitation is unavailable in scope';
const invitationOutsideScopeReason = 'The invitation is outside the trusted scope';
const AccessMutationOperationSchema = Schema.Literals(['grant', 'revoke']);
type AccessMutationOperation = typeof AccessMutationOperationSchema.Type;
/* oxlint-disable effect-native/no-nullable-schema-field -- Owner-routine result codecs intentionally decode SQL NULL; mapping below converts absence into omitted public fields. */
const nullableTimestampSchema = Schema.NullOr(timestampSchema);

const AccessGrantRowSchema = Schema.Struct({
  counterparty_resource_id: Schema.String,
  grant_id: Schema.String,
  granted_at: timestampSchema,
  granted_by: Schema.String,
  operation_outcome: Schema.optionalKey(
    Schema.Literals([
      'ALREADY_ACTIVE',
      'ALREADY_REVOKED',
      'CONFLICT',
      'LAST_ADMIN_PROTECTED',
      'PENDING_GRANT',
      'PENDING_REVOKE',
      'PROFILE_NOT_FOUND',
      'SCOPE_MISMATCH',
    ]),
  ),
  permission_code: CounterpartyPermissionCodeSchema,
  principal_id: Schema.String,
  reason: Schema.NullOr(Schema.String),
  revision: Schema.Int,
  revoked_at: nullableTimestampSchema,
  revoked_by: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    'PENDING_GRANT',
    'ACTIVE',
    'PENDING_REVOKE',
    'REVOKED',
    'RECONCILIATION_REQUIRED',
  ]),
  storefront_resource_id: Schema.NullOr(Schema.String),
});
type AccessGrantRow = typeof AccessGrantRowSchema.Type;

const AccessMutationIntentRowSchema = Schema.Struct({
  ...AccessGrantRowSchema.fields,
  action_invocation_id: Schema.NullOr(Schema.String),
  mutation_id: Schema.NullOr(Schema.String),
  mutation_operation: Schema.NullOr(AccessMutationOperationSchema),
  mutation_staged: Schema.NullOr(Schema.Boolean),
});
type AccessMutationIntentRow = typeof AccessMutationIntentRowSchema.Type;

const InvitationRowSchema = Schema.Struct({
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
  operation_outcome: Schema.optionalKey(
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
      'RECONCILIATION_REQUIRED',
      'RESENT',
      'REVOKED',
      'REVISION_CONFLICT',
    ]),
  ),
  reason: Schema.String,
  requested_permission_codes: Schema.Array(CounterpartyPermissionCodeSchema),
  revision: Schema.Int,
  state: Schema.Literals([
    'PENDING',
    'CLAIMING',
    'CLAIMED',
    'REVOKED',
    'EXPIRED',
    'RECONCILIATION_REQUIRED',
  ]),
  storefront_resource_id: Schema.NullOr(Schema.String),
}).check(
  // oxlint-disable-next-line eslint/complexity -- The row codec states the complete cross-field lifecycle invariant in one auditable predicate.
  Schema.makeFilter((row) => {
    const intended = row.requested_permission_codes;
    const intendedSet = new Set(intended);
    const progress = row.grant_progress;
    const uniqueIntended = intended.length > 0 && intendedSet.size === intended.length;
    const exactProgress =
      progress.length === intended.length &&
      new Set(progress.map(({ permission }) => permission)).size === progress.length &&
      progress.every(({ permission }) => intendedSet.has(permission));
    if (!uniqueIntended) {
      return 'invitation Permission set must be non-empty and unique';
    }
    if (row.state === 'PENDING' || row.state === 'EXPIRED') {
      return progress.length === 0 && row.claimed_by_principal_id === null
        ? undefined
        : 'unclaimed invitation rows cannot expose claimant or grant progress';
    }
    if (row.state === 'REVOKED') {
      return progress.length === 0 || exactProgress
        ? undefined
        : 'revoked invitation rows must preserve no progress or exact progress';
    }
    if (row.claimed_by_principal_id === null || !exactProgress) {
      return 'claiming invitation rows require claimant and exact Permission progress';
    }
    const anyReconciliation = progress.some(({ state }) => state === 'RECONCILIATION_REQUIRED');
    const allActive = progress.every(({ state }) => state === 'ACTIVE');
    return (row.state === 'CLAIMED' && allActive) ||
      (row.state === 'RECONCILIATION_REQUIRED' && anyReconciliation) ||
      (row.state === 'CLAIMING' && !anyReconciliation && !allActive)
      ? undefined
      : 'invitation row lifecycle must match exact grant progress';
  }),
);
type InvitationRow = typeof InvitationRowSchema.Type;
const InvitationMutationRowSchema = Schema.Struct({
  ...InvitationRowSchema.fields,
  mutation_id: Schema.NullOr(Schema.String),
  mutation_staged: Schema.NullOr(Schema.Boolean),
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

const beginAccessGrantRoutine = defineScopedRoutine({
  name: 'begin_access_grant',
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
  resultSchema: AccessMutationIntentRowSchema,
  routineKey: 'counterparty-access.begin-grant',
  schema: 'commerce_customer_context',
});

const beginAccessRevokeRoutine = defineScopedRoutine({
  name: 'begin_access_revoke',
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
  resultSchema: AccessMutationIntentRowSchema,
  routineKey: 'counterparty-access.begin-revoke',
  schema: 'commerce_customer_context',
});

const transitionAccessGrantRoutine = defineScopedRoutine({
  name: 'transition_access_grant',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: AccessMutationIntentRowSchema,
  routineKey: 'counterparty-access.transition-grant',
  schema: 'commerce_customer_context',
});

const ReconciliationRowSchema = Schema.Struct({
  ...AccessGrantRowSchema.fields,
  action_invocation_id: Schema.String,
  mutation_id: Schema.String,
  recovery_operation: AccessMutationOperationSchema,
});

const listAccessReconciliationRoutine = defineScopedRoutine({
  name: 'list_access_reconciliation',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'integer' },
  ],
  resultSchema: ReconciliationRowSchema,
  routineKey: 'counterparty-access.list-reconciliation',
  schema: 'commerce_customer_context',
});

const readAccessReconciliationRoutine = defineScopedRoutine({
  name: 'read_access_reconciliation',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: ReconciliationRowSchema,
  routineKey: 'counterparty-access.read-reconciliation',
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

const readInvitationClaimReconciliationRoutine = defineScopedRoutine({
  name: 'read_access_invitation_claim_reconciliation',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: InvitationClaimReconciliationRowSchema,
  routineKey: 'counterparty-access.read-invitation-claim-reconciliation',
  schema: 'commerce_customer_context',
});

const InvitationClaimPermissionMutationRowSchema = Schema.Struct({
  ...ReconciliationRowSchema.fields,
  mutation_staged: Schema.Boolean,
});

const stageInvitationClaimGrantsRoutine = defineScopedRoutine({
  name: 'stage_access_invitation_claim_grants',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: InvitationClaimPermissionMutationRowSchema,
  routineKey: 'counterparty-access.stage-invitation-claim-grants',
  schema: 'commerce_customer_context',
});

const FinalizedInvitationClaimRowSchema = Schema.Struct({
  ...InvitationClaimReconciliationRowSchema.fields,
  operation_outcome: Schema.Literals(['ALREADY_CLAIMED', 'CLAIMED', 'PENDING_AUTHORIZATION']),
});

const finalizeInvitationClaimRoutine = defineScopedRoutine({
  name: 'finalize_reconciled_access_invitation',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: FinalizedInvitationClaimRowSchema,
  routineKey: 'counterparty-access.finalize-reconciled-invitation',
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

const instant = (value: Date | string): string =>
  Schema.is(Schema.String)(value) ? value : value.toISOString();

const scopeStorefront = (scope: CounterpartyPermissionScope): string | null =>
  scope.kind === 'storefront' ? scope.storefrontKey : null;

const accessDecision = (
  result: { readonly decision: 'allowed' | 'denied' | 'unavailable' } | undefined,
): CounterpartyAccessDecision => {
  if (result?.decision === 'allowed') {
    return 'ALLOWED';
  }
  return result?.decision === 'denied' ? 'DENIED' : 'UNAVAILABLE';
};

const businessTarget = (
  scope: Readonly<{ readonly legalEntityId: string; readonly tenantId: string }>,
  counterpartyId: string,
  permissionScope: CounterpartyPermissionScope,
): BusinessAccessTarget =>
  permissionScope.kind === 'counterparty'
    ? {
        counterpartyId,
        kind: 'counterparty',
        legalEntityId: scope.legalEntityId,
        tenantId: scope.tenantId,
      }
    : {
        counterpartyId,
        kind: 'counterparty_storefront',
        legalEntityId: scope.legalEntityId,
        storefrontId: permissionScope.storefrontKey,
        tenantId: scope.tenantId,
      };

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

type ViolationCode = ConstructorParameters<typeof CounterpartyAccessContractViolation>[0]['code'];
const violation = (code: ViolationCode, reason: string) =>
  new CounterpartyAccessContractViolation({ code, reason });

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
  ...(row.claimed_by_principal_id === null
    ? {}
    : { claimant: { principalId: row.claimed_by_principal_id, tenantId } }),
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

const ownerGrantMatchesScope = (
  row: AccessGrantRow,
  permissionScope: CounterpartyPermissionScope,
): boolean =>
  permissionScope.kind === 'counterparty'
    ? row.storefront_resource_id === null
    : row.storefront_resource_id === null ||
      row.storefront_resource_id === permissionScope.storefrontKey;

type OwnerGrantReadResult = Result.Result<readonly AccessGrantRow[], ScopedRoutineInvocationError>;

const ownerAccessDecisionFromRows = (
  rows: readonly AccessGrantRow[],
  input: CurrentOwnerAccessDecisionInput,
): CurrentOwnerAccessDecision => {
  const relevant = rows.filter(
    (row) => row.permission_code === input.permission && ownerGrantMatchesScope(row, input.scope),
  );
  // A broad ACTIVE owner grant is authoritative for a narrower requested scope. A
  // stale/revoked row for that narrower scope must not shadow the active grant; only
  // when no active grant covers the request do pending/reconciliation states decide it.
  if (relevant.some(({ state }) => state === 'ACTIVE')) {
    return 'ALLOWED';
  }
  if (relevant.some(({ state }) => state === 'RECONCILIATION_REQUIRED')) {
    return 'UNAVAILABLE';
  }
  if (
    relevant.some(
      ({ state }) => state === 'PENDING_REVOKE' || state === 'PENDING_GRANT' || state === 'REVOKED',
    )
  ) {
    return 'DENIED';
  }
  return 'DENIED';
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
 * Read the owner-local current grant before consulting Core's relationship projection. A
 * pending revoke is an immediate deny, while reconciliation is indeterminate and therefore
 * unavailable. Historical revoked rows never restore authority.
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

export const lockingCurrentOwnerAccessForTransaction = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  scope: Pick<OperationalScope, 'tenantId'> & { readonly legalEntityId: string },
): CurrentOwnerAccessDecisionReader =>
  currentOwnerAccessForTransaction(transaction, scope, { lock: true });

/* oxlint-disable effect-native/no-dependency-parameters -- This owner adapter captures one verified transaction-scoped capability and typed collaborators, then exposes only the narrow public port to handlers. */
const requireEligible = Effect.fn('AccessPersistence.requireEligible')(
  function* requireEligiblePrincipal(
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
  },
);

export interface CounterpartyAccessPersistenceContext {
  readonly claimAuthority: CounterpartyInvitationClaimAuthorityService;
  readonly contextAccess: Pick<ContextAccessService, 'businessPermissions'>;
  /** Current owner state is conjunctive with Core authorization for protected checks. */
  readonly currentOwnerAccess?: CurrentOwnerAccessDecisionReader;
  readonly eligibility: PrincipalEligibilityService;
  readonly proofLifecycle: CounterpartyInvitationProofLifecycleService;
  readonly scope: OperationalScope & { readonly legalEntityId: string };
  readonly transaction: CounterpartyAccessScopedRoutineInvoker;
  /** Trusted gateway-derived storefront identity. Request payload values never populate it. */
  readonly trustedStorefrontId?: string | undefined;
}

interface AccessAuthorizationReconciliationContext {
  readonly scope: Readonly<{ readonly legalEntityId: string; readonly tenantId: string }>;
  readonly transaction: CounterpartyAccessScopedRoutineInvoker;
}

const isTrustedPermissionScope = (
  dependencies: CounterpartyAccessPersistenceContext,
  scope: CounterpartyPermissionScope,
): boolean =>
  scope.kind === 'counterparty' || dependencies.trustedStorefrontId === scope.storefrontKey;

const samePermissionScope = (
  left: CounterpartyPermissionScope,
  right: CounterpartyPermissionScope,
): boolean =>
  left.kind === right.kind &&
  (left.kind === 'counterparty' ||
    (right.kind === 'storefront' && left.storefrontKey === right.storefrontKey));

const attestationMatchesClaim = (
  attestation: VerifiedInvitationClaimAttestation,
  input: ClaimCounterpartyAccessInvitationInput,
  inviter: PrincipalRef,
): boolean =>
  attestation.state === 'VERIFIED_AND_CONSUMED' &&
  attestation.proofVersion === invitationProofVersion &&
  attestation.claimant.tenantId === input.claimant.tenantId &&
  attestation.claimant.principalId === input.claimant.principalId &&
  attestation.counterpartyRef.tenantId === input.counterpartyRef.tenantId &&
  attestation.counterpartyRef.resourceId === input.counterpartyRef.resourceId &&
  attestation.invitationRef.tenantId === input.invitationRef.tenantId &&
  attestation.invitationRef.resourceId === input.invitationRef.resourceId &&
  attestation.inviterAuthority.decision === 'ALLOWED' &&
  attestation.inviterAuthority.permission === accessManagementPermission &&
  attestation.inviterAuthority.inviter.tenantId === inviter.tenantId &&
  attestation.inviterAuthority.inviter.principalId === inviter.principalId &&
  samePermissionScope(attestation.inviterAuthority.scope, input.scope);

const requireCurrentInviterAuthority = (
  dependencies: CounterpartyAccessPersistenceContext,
  inviter: PrincipalRef,
  counterpartyRef: CounterpartyRef,
  permissionScope: CounterpartyPermissionScope,
): Effect.Effect<void, CounterpartyAccessDomainError> => {
  const check = dependencies.contextAccess.businessPermissions;
  if (check === undefined || !isTrustedPermissionScope(dependencies, permissionScope)) {
    return Effect.fail(accessUnavailable());
  }
  const verifyCoreAuthority = Effect.gen(function* recheckInviterAuthority() {
    const [result] = yield* check({
      principal: inviter,
      targets: [
        {
          permission: accessManagementPermission,
          target: businessTarget(dependencies.scope, counterpartyRef.resourceId, permissionScope),
        },
      ],
      ...(permissionScope.kind === 'storefront' && dependencies.trustedStorefrontId !== undefined
        ? { trustedStorefrontId: dependencies.trustedStorefrontId }
        : {}),
    });
    if (result?.decision === 'allowed') {
      return yield* Effect.void;
    }
    if (result?.decision === 'denied') {
      return yield* violation(
        'inviter_authority_denied',
        'The inviter no longer holds Counterparty access management authority',
      );
    }
    return yield* accessUnavailable();
  });
  if (dependencies.currentOwnerAccess === undefined) {
    // Counterparty targets are owner-governed. A missing owner reader is an unavailable
    // deployment seam, never permission to continue with Core's projection alone.
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
      Effect.flatMap((decision) => {
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
        return verifyCoreAuthority;
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

const transitionGrant = (
  dependencies: AccessAuthorizationReconciliationContext,
  grantId: string,
  mutationId: string,
  operation: 'grant' | 'revoke',
  state: 'ACTIVE' | 'RECONCILIATION_REQUIRED' | 'REVOKED',
) =>
  dependencies.transaction
    .invoke(transitionAccessGrantRoutine, [grantId, mutationId, operation, state])
    .pipe(Effect.mapError(accessUnavailable), Effect.flatMap(firstGrant));

const requireMutationIntent = <Operation extends 'grant' | 'revoke'>(
  row: AccessMutationIntentRow,
  operation: Operation,
): Effect.Effect<
  Readonly<{ mutationId: string; operation: Operation; staged: boolean }>,
  CounterpartyAccessUnavailable
> =>
  row.mutation_id === null || row.mutation_operation !== operation || row.mutation_staged === null
    ? Effect.fail(accessUnavailable())
    : Effect.succeed({
        mutationId: row.mutation_id,
        operation,
        staged: row.mutation_staged,
      });

const durableClaimRejection = (
  failure: CounterpartyAccessDomainError,
): InvitationClaimRejection | undefined => {
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
              (rejected.operation_outcome === 'CLAIM_REJECTED' ||
                rejected.operation_outcome === 'EXPIRED')
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
      violation(
        'counterparty_scope_mismatch',
        'The grant does not match the verified operation scope',
      ),
    );
  }
  return Effect.gen(function* persistAccessGrant() {
    yield* requireEligible(dependencies.eligibility, input.recipient);
    const rows = yield* dependencies.transaction
      .invoke(beginAccessGrantRoutine, [
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
      return yield* violation(
        'counterparty_scope_mismatch',
        'The Counterparty is unavailable in scope',
      );
    }
    if (row.operation_outcome === 'CONFLICT') {
      return { grant, outcome: 'CONFLICT' as const };
    }
    if (row.operation_outcome === 'ALREADY_ACTIVE') {
      return { grant, outcome: 'ALREADY_ACTIVE' as const };
    }
    const reconciliation = yield* requireMutationIntent(row, 'grant');
    const completed = yield* transitionGrant(
      dependencies,
      row.grant_id,
      reconciliation.mutationId,
      'grant',
      'RECONCILIATION_REQUIRED',
    );
    return {
      grant: grantFromRow(dependencies.scope.tenantId, completed),
      outcome: 'RECONCILIATION_REQUIRED' as const,
      reconciliation,
    };
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
      violation(
        'counterparty_scope_mismatch',
        'The revoke does not match the verified operation scope',
      ),
    );
  }
  return Effect.gen(function* persistAccessRevoke() {
    const rows = yield* dependencies.transaction
      .invoke(beginAccessRevokeRoutine, [
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
    if (
      row.operation_outcome === 'SCOPE_MISMATCH' ||
      row.operation_outcome === 'PROFILE_NOT_FOUND'
    ) {
      return { grant, outcome: 'SCOPE_MISMATCH' as const };
    }
    if (row.operation_outcome === 'ALREADY_REVOKED') {
      return { grant, outcome: 'ALREADY_REVOKED' as const };
    }
    const reconciliation = yield* requireMutationIntent(row, 'revoke');
    const completed = yield* transitionGrant(
      dependencies,
      row.grant_id,
      reconciliation.mutationId,
      'revoke',
      'RECONCILIATION_REQUIRED',
    );
    return {
      grant: grantFromRow(dependencies.scope.tenantId, completed),
      outcome: 'RECONCILIATION_REQUIRED' as const,
      reconciliation,
    };
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
          return Effect.fail(
            violation('invitation_revision_conflict', 'The invitation changed concurrently'),
          );
        }
        if (row.operation_outcome === 'EXPIRED') {
          return Effect.fail(violation('invitation_expired', 'The invitation has expired'));
        }
        return Effect.succeed(row);
      }),
    );
};

export const counterpartyAccessPortForTransaction = (
  dependencies: CounterpartyAccessPersistenceContext,
): CounterpartyAccessPortService => {
  const service: CounterpartyAccessPortService = {
    bootstrapAdministrator: (input) => grantAccess(dependencies, input, true),
    check: (input) => {
      if (
        !exactScope(dependencies.scope, {
          counterpartyRef: input.counterpartyRef,
          principalRefs: [input.principal],
        }) ||
        !isTrustedPermissionScope(dependencies, input.scope) ||
        dependencies.contextAccess.businessPermissions === undefined
      ) {
        return Effect.succeed('UNAVAILABLE' as const);
      }
      const target = businessTarget(
        dependencies.scope,
        input.counterpartyRef.resourceId,
        input.scope,
      );
      const checkCore = dependencies.contextAccess
        .businessPermissions({
          principal: input.principal,
          targets: [{ permission: input.permission, target }],
          ...(input.scope.kind === 'storefront' && dependencies.trustedStorefrontId !== undefined
            ? { trustedStorefrontId: dependencies.trustedStorefrontId }
            : {}),
        })
        .pipe(Effect.map(([result]) => accessDecision(result)));
      if (dependencies.currentOwnerAccess === undefined) {
        // The owner-local grant is conjunctive with Core's relationship projection. Do not
        // silently downgrade to Core-only authorization when the owner adapter is absent.
        return Effect.succeed('UNAVAILABLE' as const);
      }
      return dependencies
        .currentOwnerAccess({
          counterpartyRef: input.counterpartyRef,
          legalEntityId: dependencies.scope.legalEntityId,
          permission: input.permission,
          principal: input.principal,
          scope: input.scope,
        })
        .pipe(
          Effect.flatMap((decision) =>
            decision === 'ALLOWED' ? checkCore : Effect.succeed(decision),
          ),
        );
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
        return Effect.fail(
          violation('invitation_claimant_mismatch', 'The claimant is outside the trusted scope'),
        );
      }
      return Effect.gen(function* persistInvitationClaim() {
        yield* requireEligible(dependencies.eligibility, input.claimant);
        const rows = yield* dependencies.transaction
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
        const [row] = rows;
        if (row === undefined || row.operation_outcome === 'INVALID') {
          return yield* violation('invitation_invalid', 'The invitation is unavailable in scope');
        }
        if (row.operation_outcome === 'ALREADY_CLAIMED') {
          if (row.claimed_by_principal_id !== input.claimant.principalId) {
            return yield* violation(
              'invitation_claimant_mismatch',
              'The invitation was claimed by a different Principal',
            );
          }
          return {
            invitation: invitationFromRow(dependencies.scope.tenantId, row),
            outcome: 'ALREADY_CLAIMED' as const,
          };
        }
        if (row.operation_outcome === 'REVISION_CONFLICT') {
          return yield* violation(
            'invitation_revision_conflict',
            'The invitation changed concurrently',
          );
        }
        if (row.operation_outcome === 'EXPIRED') {
          return yield* violation('invitation_expired', 'The invitation has expired');
        }
        if (row.mutation_id === null || row.mutation_staged === null) {
          return yield* accessUnavailable();
        }
        const claimReconciliation = {
          mutationId: row.mutation_id,
          operation: 'claim' as const,
          staged: row.mutation_staged,
        };
        const inviter = {
          principalId: row.invited_by,
          tenantId: dependencies.scope.tenantId,
        };
        const verification = yield* verifyOrPersistClaimRejection(
          dependencies,
          input,
          row,
          inviter,
        );
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
        yield* requireCurrentInviterAuthority(
          dependencies,
          inviter,
          input.counterpartyRef,
          input.scope,
        );
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
        yield* requireCurrentInviterAuthority(
          dependencies,
          inviter,
          input.counterpartyRef,
          input.scope,
        );
        const completedRows = yield* dependencies.transaction
          .invoke(mutateAccessInvitationRoutine, [
            input.invitationRef.resourceId,
            input.counterpartyRef.resourceId,
            scopeStorefront(input.scope),
            row.revision,
            grants.some(({ outcome }) => outcome !== 'APPLIED' && outcome !== 'ALREADY_ACTIVE')
              ? 'FINISH_RECONCILIATION'
              : 'FINISH_CLAIM',
            input.actor.principalId,
            input.actionInvocationId,
            input.reason ?? null,
            input.claimant.principalId,
            attestation.attestationReference,
          ])
          .pipe(Effect.mapError(accessUnavailable));
        const [completed] = completedRows;
        if (completed === undefined) {
          return yield* accessUnavailable();
        }
        const invitation = invitationFromRow(dependencies.scope.tenantId, completed);
        if (completed.state === 'CLAIMED') {
          return { attestation, invitation, outcome: 'CLAIMED' as const };
        }
        return {
          attestation,
          invitation,
          outcome: 'RECONCILIATION_REQUIRED' as const,
          reconciliation: {
            ...claimReconciliation,
            permissionMutations: grants.flatMap((result) =>
              result.outcome === 'RECONCILIATION_REQUIRED'
                ? [
                    {
                      grantRef: result.grant.grantRef,
                      mutationId: result.reconciliation.mutationId,
                      operation: 'grant' as const,
                      permission: result.grant.permission,
                      staged: result.reconciliation.staged,
                    },
                  ]
                : [],
            ),
          },
        };
      });
    },
    createInvitation: Effect.fn('CounterpartyAccessPort.createInvitation')(
      function* createInvitation(
        input: CreateCounterpartyAccessInvitationInput,
      ): Effect.fn.Return<
        CreateCounterpartyAccessInvitationOutcome,
        CounterpartyAccessDomainError
      > {
        if (
          !exactScope(dependencies.scope, {
            counterpartyRef: input.counterpartyRef,
            legalEntityId: input.legalEntityId,
            principalRefs: [input.actor],
          }) ||
          !isTrustedPermissionScope(dependencies, input.scope)
        ) {
          return yield* violation(
            'counterparty_scope_mismatch',
            'The invitation is outside the trusted scope',
          );
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
      },
    ),
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
        ? dependencies.transaction
            .invoke(listAccessGrantsRoutine, [
              input.counterpartyRef.resourceId,
              input.recipient?.principalId ?? null,
            ])
            .pipe(
              Effect.mapError(accessUnavailable),
              Effect.map((rows) =>
                rows.flatMap((row) => {
                  const grant = grantFromRow(dependencies.scope.tenantId, row);
                  const included =
                    input.scope.kind === 'counterparty'
                      ? grant.scope.kind === 'counterparty'
                      : grant.scope.kind === 'counterparty' ||
                        (grant.scope.kind === 'storefront' &&
                          grant.scope.storefrontKey === input.scope.storefrontKey);
                  return included ? [grant] : [];
                }),
              ),
            )
        : Effect.fail(accessUnavailable()),
    resendInvitation: Effect.fn('CounterpartyAccessPort.resendInvitation')(
      function* resendInvitation(
        input: InvitationMutationInput,
      ): Effect.fn.Return<
        ResendCounterpartyAccessInvitationOutcome,
        CounterpartyAccessDomainError
      > {
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
        return { invitation, outcome: 'RESENT' };
      },
    ),
    revoke: (input) => revokeAccess(dependencies, input),
    revokeInvitation: (input) =>
      mutateInvitation(dependencies, input, 'REVOKE').pipe(
        Effect.map((row) => ({
          invitation: invitationFromRow(dependencies.scope.tenantId, row),
          outcome:
            row.operation_outcome === 'ALREADY_REVOKED'
              ? ('ALREADY_REVOKED' as const)
              : ('REVOKED' as const),
        })),
      ),
  };
  return Object.freeze(service);
};

/**
 * Transaction-scoped production binding. It closes over Core's verified owner capability and
 * exposes only the public access port to handlers.
 */
export const counterpartyAccessPortForScopedTransaction = Effect.fn(
  'AccessPersistence.counterpartyAccessPortForScopedTransaction',
)(function* bindCounterpartyAccessPort(
  transaction: CounterpartyAccessScopedRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
) {
  const contextAccess = yield* ContextAccess;
  const crypto = yield* Crypto.Crypto;
  const eligibility = yield* PrincipalEligibility;
  const proofDelivery = yield* CounterpartyInvitationProofDelivery;
  const currentOwnerAccess = lockingCurrentOwnerAccessForTransaction(transaction, scope);
  const { claimAuthority, proofLifecycle } = counterpartyInvitationClaimServicesForTransaction(
    transaction,
    contextAccess,
    crypto,
    proofDelivery,
    currentOwnerAccess,
  );
  return counterpartyAccessPortForTransaction({
    claimAuthority,
    contextAccess,
    currentOwnerAccess,
    eligibility,
    proofLifecycle,
    scope,
    transaction,
    ...(scope.trustedStorefrontId === undefined
      ? {}
      : { trustedStorefrontId: scope.trustedStorefrontId }),
  });
});

const reconciliationEntry = (
  dependencies: AccessAuthorizationReconciliationContext,
  row: typeof ReconciliationRowSchema.Type,
): AuthorizationMutationJournalEntry => {
  const permissionScope: CounterpartyPermissionScope =
    row.storefront_resource_id === null
      ? { kind: 'counterparty' }
      : { kind: 'storefront', storefrontKey: row.storefront_resource_id };
  return {
    attemptCount: 0,
    businessTarget: businessTarget(
      dependencies.scope,
      row.counterparty_resource_id,
      permissionScope,
    ),
    correlationId: row.action_invocation_id,
    mutationId: row.mutation_id,
    operation: row.recovery_operation,
    permission: row.permission_code,
    principal: { principalId: row.principal_id, tenantId: dependencies.scope.tenantId },
    state: row.state,
  };
};

const reconciliationFailure = (reason: string, cause?: unknown) => {
  const failure = new AuthorizationMutationReconciliationUnavailable({ reason });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { enumerable: false, value: cause });
};

const reconcileAccessEntry = (
  dependencies: AccessAuthorizationReconciliationContext,
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
  row: typeof ReconciliationRowSchema.Type,
) => {
  const entry = reconciliationEntry(dependencies, row);
  return reconcileCommittedAuthorizationMutation(entry, mutation, {
    finalize: ({ mutationId, to }) =>
      transitionGrant(dependencies, row.grant_id, mutationId, row.recovery_operation, to).pipe(
        Effect.map((completed) => ({ ...entry, state: completed.state })),
        Effect.mapError((cause) =>
          Object.defineProperty(
            new AuthorizationMutationSagaError({
              code: 'authorization_mutation_finalization_indeterminate',
              externalMutationMayHaveSucceeded: true,
              reason: 'The access grant finalization remains indeterminate',
              retryable: true,
            }),
            'cause',
            { enumerable: false, value: cause },
          ),
        ),
      ),
  });
};

const reconcileAccessRow = (
  dependencies: AccessAuthorizationReconciliationContext,
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
  row: typeof ReconciliationRowSchema.Type,
) =>
  reconcileAccessEntry(dependencies, mutation, row).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

export type AccessAuthorizationMutationReconciliationResult =
  | Readonly<{
      readonly grant: CounterpartyAccessGrant;
      readonly mutationId: string;
      readonly occurredAt: Date;
      readonly operation: AccessMutationOperation;
      readonly outcome: 'ALREADY_FINAL' | 'FINALIZED' | 'INDETERMINATE';
      readonly sourceActionInvocationId: string;
    }>
  | Readonly<{ readonly outcome: 'COMPENSATED' }>;

const finalizedAccessMutationResult = (
  dependencies: AccessAuthorizationReconciliationContext,
  mutationId: string,
  operation: AccessMutationOperation,
  outcome: 'ALREADY_FINAL' | 'FINALIZED',
) =>
  dependencies.transaction.invoke(readAccessReconciliationRoutine, [mutationId]).pipe(
    Effect.flatMap(([finalized]) => {
      if (finalized === undefined) {
        return Effect.fail(reconciliationFailure('Finalized access evidence is unavailable'));
      }
      const terminalInstant = operation === 'grant' ? finalized.granted_at : finalized.revoked_at;
      return terminalInstant === null
        ? Effect.fail(reconciliationFailure('Terminal access mutation time is unavailable'))
        : Effect.succeed({
            grant: grantFromRow(dependencies.scope.tenantId, finalized),
            mutationId,
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe(terminalInstant)),
            operation,
            outcome,
            sourceActionInvocationId: finalized.action_invocation_id,
          });
    }),
  );

export const accessAuthorizationMutationReconciliationForTransaction = (
  dependencies: AccessAuthorizationReconciliationContext,
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
) =>
  Object.freeze({
    reconcileOne: ({
      counterpartyResourceId,
      grantId,
      mutationId,
      operation,
    }: {
      readonly counterpartyResourceId: string;
      readonly grantId: string;
      readonly mutationId: string;
      readonly operation: AccessMutationOperation;
    }) =>
      dependencies.transaction.invoke(readAccessReconciliationRoutine, [mutationId]).pipe(
        Effect.mapError((cause) =>
          reconciliationFailure('Access reconciliation storage is unavailable', cause),
        ),
        Effect.flatMap(([row]) => {
          if (
            row === undefined ||
            row.recovery_operation !== operation ||
            row.counterparty_resource_id !== counterpartyResourceId ||
            row.grant_id !== grantId
          ) {
            return Effect.fail(
              reconciliationFailure('The access mutation is unavailable or no longer current'),
            );
          }
          const grant = grantFromRow(dependencies.scope.tenantId, row);
          return reconcileAccessEntry(dependencies, mutation, row).pipe(
            Effect.flatMap((result) =>
              finalizedAccessMutationResult(dependencies, mutationId, operation, result.outcome),
            ),
            Effect.orElseSucceed(() => ({
              grant,
              mutationId,
              occurredAt: DateTime.toDateUtc(
                DateTime.makeUnsafe(
                  operation === 'grant' ? row.granted_at : (row.revoked_at ?? row.granted_at),
                ),
              ),
              operation,
              outcome: 'INDETERMINATE' as const,
              sourceActionInvocationId: row.action_invocation_id,
            })),
          );
        }),
      ),
  });

/**
 * Worker-facing binding over the verified legal-entity fan-out scope. It exposes only the
 * routine invoker already scoped by Core and never asks the worker to construct Action services.
 */
export const accessAuthorizationMutationReconciliationForScopedWorker = (
  scope: OutboxWorkerLegalEntityScope,
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
) =>
  accessAuthorizationMutationReconciliationForTransaction(
    {
      scope: { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId },
      transaction: scope.routineInvoker,
    },
    mutation,
  );

const workerRejected = (
  code: 'RECONCILIATION_INDETERMINATE' | 'RECONCILIATION_UNAVAILABLE',
  reason: string,
  cause?: unknown,
) => {
  const failure = new AccessAuthorizationMutationWorkerRejected({ code, reason });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { enumerable: false, value: cause });
};

const claimRootMatchesRequest = (
  root: typeof InvitationClaimReconciliationRowSchema.Type,
  request: Extract<AccessAuthorizationMutationRequest, { readonly operation: 'claim' }>,
): boolean => {
  const claimSubjectPrincipalId = root.claim_subject_principal_id ?? root.claimed_by_principal_id;
  // The request contains only permission mutations that were durably staged by the claim.
  // Permissions that were already ACTIVE are intentionally absent.  Comparing against the
  // invitation's intended set therefore accepts a forged subset (or rejects a valid claim with
  // pre-existing grants); compare every non-terminal progress identity and any partially-applied
  // terminal identity instead.
  const pendingProgress = root.grant_progress.filter(
    ({ state }) => state === 'PENDING_GRANT' || state === 'RECONCILIATION_REQUIRED',
  );
  const expectedPermissions = new Set(pendingProgress.map(({ permission }) => permission));
  const expectedGrantByPermission = new Map(
    root.grant_progress.flatMap((progress) =>
      'grantRef' in progress && progress.grantRef !== undefined
        ? [[progress.permission, progress.grantRef.resourceId] as const]
        : [],
    ),
  );
  const requestedPermissions = request.permissionMutations.map(({ permission }) => permission);
  const requestedMutationIds = request.permissionMutations.map(({ mutationId }) => mutationId);
  const rootPermissionSet = new Set(root.requested_permission_codes);
  const requestedPermissionSet = new Set(requestedPermissions);
  const requestedGrantByPermission = new Map(
    request.permissionMutations.map(({ grantRef, permission }) => [
      permission,
      grantRef.resourceId,
    ]),
  );
  // Older request-only envelopes intentionally carry no permission mutation details. The
  // durable claim root and the subsequent owner-routine row check still provide the complete
  // authorization boundary in that case. When details are present, require the exact staged
  // progress identities so a forged subset cannot narrow the claim's grant set.
  const requestMatchesProgress =
    root.state === 'REVOKED'
      ? new Set(requestedPermissions).size === requestedPermissions.length &&
        requestedPermissions.every((permission) => rootPermissionSet.has(permission)) &&
        request.permissionMutations.every(({ operation }) => operation === 'grant')
      : request.permissionMutations.length === 0 ||
        (requestedPermissions.length >= expectedPermissions.size &&
          new Set(requestedPermissions).size === requestedPermissions.length &&
          new Set(requestedMutationIds).size === requestedMutationIds.length &&
          pendingProgress.every(({ permission }) => requestedPermissionSet.has(permission)) &&
          requestedPermissions.every((permission) => {
            const expectedGrantId = expectedGrantByPermission.get(permission);
            return (
              rootPermissionSet.has(permission) &&
              (expectedGrantId === undefined ||
                requestedGrantByPermission.get(permission) === expectedGrantId)
            );
          }) &&
          request.permissionMutations.every(({ operation }) => operation === 'grant'));
  return (
    root.claim_mutation_id === request.mutationId &&
    root.counterparty_resource_id === request.counterpartyRef.resourceId &&
    root.invitation_id === request.invitationRef.resourceId &&
    claimSubjectPrincipalId !== null &&
    claimSubjectPrincipalId !== undefined &&
    requestMatchesProgress &&
    (request.scope.kind === 'counterparty'
      ? root.storefront_resource_id === null
      : root.storefront_resource_id === request.scope.storefrontKey)
  );
};

const claimInviterAuthorityDecision = (
  contextAccess: Pick<ContextAccessService, 'businessPermissions'>,
  scope: OutboxWorkerLegalEntityScope,
  root: typeof InvitationClaimReconciliationRowSchema.Type,
  ownerAccessReader?: typeof currentOwnerAccessForTransaction,
) => {
  const permissionScope: CounterpartyPermissionScope =
    root.storefront_resource_id === null
      ? { kind: 'counterparty' }
      : { kind: 'storefront', storefrontKey: root.storefront_resource_id };
  const verifyCoreAuthority = () => {
    if (contextAccess.businessPermissions === undefined) {
      return Effect.succeed('unavailable' as const);
    }
    return contextAccess
      .businessPermissions({
        principal: { principalId: root.invited_by, tenantId: scope.tenantId },
        targets: [
          {
            permission: accessManagementPermission,
            target: businessTarget(scope, root.counterparty_resource_id, permissionScope),
          },
        ],
        ...(root.storefront_resource_id === null
          ? {}
          : { trustedStorefrontId: root.storefront_resource_id }),
      })
      .pipe(Effect.map(([decision]) => decision?.decision ?? ('unavailable' as const)));
  };
  if (ownerAccessReader === undefined) {
    // Reconciliation must not repair or preserve owner-governed access from Core-only state.
    return Effect.succeed('unavailable' as const);
  }
  return ownerAccessReader(scope.routineInvoker, {
    legalEntityId: scope.legalEntityId,
    tenantId: scope.tenantId,
  })({
    counterpartyRef: {
      moduleId: counterpartyModuleKey,
      resourceId: root.counterparty_resource_id,
      resourceType: counterpartyResourceType,
      tenantId: scope.tenantId,
    },
    legalEntityId: scope.legalEntityId,
    permission: accessManagementPermission,
    principal: { principalId: root.invited_by, tenantId: scope.tenantId },
    scope: permissionScope,
  }).pipe(
    Effect.flatMap((decision) => {
      if (decision === 'DENIED') {
        return Effect.succeed('denied' as const);
      }
      if (decision === 'UNAVAILABLE') {
        return Effect.succeed('unavailable' as const);
      }
      return verifyCoreAuthority();
    }),
  );
};

const invitationClaimAttestation = (
  scope: OutboxWorkerLegalEntityScope,
  row: Omit<typeof InvitationClaimReconciliationRowSchema.Type, 'operation_outcome'>,
  claimantPrincipalId: string,
): VerifiedInvitationClaimAttestation => {
  const permissionScope: CounterpartyPermissionScope =
    row.storefront_resource_id === null
      ? { kind: 'counterparty' }
      : { kind: 'storefront', storefrontKey: row.storefront_resource_id };
  return {
    attestationReference: row.attestation_reference,
    claimant: { principalId: claimantPrincipalId, tenantId: scope.tenantId },
    counterpartyRef: {
      moduleId: counterpartyModuleKey,
      resourceId: row.counterparty_resource_id,
      resourceType: counterpartyResourceType,
      tenantId: scope.tenantId,
    },
    invitationRef: {
      moduleId: customerContextModuleKey,
      resourceId: row.invitation_id,
      resourceType: 'commerce.customer-context.counterparty-access-invitation',
      tenantId: scope.tenantId,
    },
    inviterAuthority: {
      decision: 'ALLOWED',
      inviter: { principalId: row.invited_by, tenantId: scope.tenantId },
      permission: accessManagementPermission,
      scope: permissionScope,
    },
    proofVersion: invitationProofVersion,
    state: 'VERIFIED_AND_CONSUMED',
    verifiedAt: instant(row.verified_at),
  };
};

const claimPermissionRowsMatchRoot = (
  root: typeof InvitationClaimReconciliationRowSchema.Type,
  rows: readonly (typeof InvitationClaimPermissionMutationRowSchema.Type)[],
  operation?: AccessMutationOperation,
): boolean => {
  const claimSubjectPrincipalId = root.claim_subject_principal_id ?? root.claimed_by_principal_id;
  // Normal claim staging is restricted to the currently pending progress identities. A
  // compensation pass is different: it must discover every tuple whose GRANT journal points
  // at this claim, including tuples that became ACTIVE before the revoke won the race.
  const intended = new Set(
    operation === 'revoke'
      ? root.requested_permission_codes
      : root.grant_progress.flatMap(({ permission, state }) =>
          state === 'PENDING_GRANT' || state === 'RECONCILIATION_REQUIRED' ? [permission] : [],
        ),
  );
  const grantIds = new Set(
    root.grant_progress.flatMap((progress) =>
      'grantRef' in progress && progress.grantRef !== undefined
        ? [progress.grantRef.resourceId]
        : [],
    ),
  );
  const rowPermissions = rows.map(({ permission_code }) => permission_code);
  const rowGrantIds = rows.map(({ grant_id }) => grant_id);
  const rowMutationIds = rows.map(({ mutation_id }) => mutation_id);
  return (
    // Compensation may legitimately return fewer rows after a previous retry already revoked
    // one of the claim-created grants. Every returned row still has to be an exact durable
    // claim grant; it must never be selected merely because its permission is intended.
    rowPermissions.length <= intended.size &&
    new Set(rowPermissions).size === rowPermissions.length &&
    new Set(rowGrantIds).size === rowGrantIds.length &&
    new Set(rowMutationIds).size === rowMutationIds.length &&
    rows.every(
      (row) =>
        row.counterparty_resource_id === root.counterparty_resource_id &&
        row.principal_id === claimSubjectPrincipalId &&
        row.storefront_resource_id === root.storefront_resource_id &&
        intended.has(row.permission_code) &&
        (operation === 'revoke' || grantIds.size === 0 || grantIds.has(row.grant_id)) &&
        row.mutation_id !== null &&
        (operation === undefined || row.recovery_operation === operation),
    )
  );
};

const compensateInvitationClaim = (
  scope: OutboxWorkerLegalEntityScope,
  root: typeof InvitationClaimReconciliationRowSchema.Type,
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
): Effect.Effect<
  Readonly<{ readonly outcome: 'COMPENSATED' | 'INDETERMINATE' }>,
  AccessAuthorizationMutationWorkerError
> =>
  scope.routineInvoker
    .invoke(stageInvitationClaimGrantsRoutine, [root.claim_mutation_id, true])
    .pipe(
      Effect.mapError((cause) =>
        workerRejected(
          'RECONCILIATION_UNAVAILABLE',
          'Invitation claim compensation is unavailable',
          cause,
        ),
      ),
      Effect.flatMap((rows) =>
        claimPermissionRowsMatchRoot(root, rows, 'revoke')
          ? Effect.succeed(rows)
          : Effect.fail(
              workerRejected(
                'RECONCILIATION_UNAVAILABLE',
                'An invitation compensation mutation is not linked to the durable claim',
              ),
            ),
      ),
      Effect.flatMap(
        (
          rows,
        ): Effect.Effect<
          Readonly<{ readonly outcome: 'COMPENSATED' | 'INDETERMINATE' }>,
          AccessAuthorizationMutationWorkerError
        > => {
          if (rows.length === 0) {
            // A claim can lose issuer authority before the owner creates its first grant row.
            // Persist the same claimant/proof-bound rejection marker used by the synchronous
            // path so the retry is idempotent and the invitation returns to PENDING instead of
            // remaining forever in CLAIMING with no tuples left to compensate.
            return scope.routineInvoker
              .invoke(mutateAccessInvitationRoutine, [
                root.invitation_id,
                root.counterparty_resource_id,
                root.storefront_resource_id,
                root.revision,
                'REJECT_CLAIM',
                root.invited_by,
                root.source_action_invocation_id,
                'Compensate invitation claim after inviter authority was lost',
                root.claim_subject_principal_id ?? root.claimed_by_principal_id,
                root.attestation_reference,
              ])
              .pipe(
                Effect.mapError((cause) =>
                  workerRejected(
                    'RECONCILIATION_UNAVAILABLE',
                    'Invitation claim reset is unavailable',
                    cause,
                  ),
                ),
                Effect.flatMap(([reset]) =>
                  reset?.operation_outcome === 'CLAIM_REJECTED'
                    ? Effect.succeed({ outcome: 'COMPENSATED' as const })
                    : Effect.fail(
                        workerRejected(
                          'RECONCILIATION_INDETERMINATE',
                          'The invitation issuer no longer has access management authority',
                        ),
                      ),
                ),
              );
          }
          // A compensation staging call can return a mix of rows: a newly staged revoke
          // is deliberately deferred until the next delivery, while an already staged
          // row is safe to reconcile now. Do not let one newly staged row suppress the
          // TOUCH compensation for every other row in the same claim.
          const readyRows = rows.filter(({ mutation_staged: staged }) => !staged);
          return Effect.forEach(
            readyRows,
            (row) =>
              reconcileAccessRow({ scope, transaction: scope.routineInvoker }, mutation, row),
            { concurrency: 1 },
          ).pipe(Effect.as({ outcome: 'INDETERMINATE' as const }));
        },
      ),
    );

const reconcileInvitationClaimForWorker = (
  scope: OutboxWorkerLegalEntityScope,
  request: Extract<AccessAuthorizationMutationRequest, { readonly operation: 'claim' }>,
  contextAccess: Pick<ContextAccessService, 'businessPermissions'>,
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
  ownerAccessReader?: typeof currentOwnerAccessForTransaction,
) =>
  scope.routineInvoker.invoke(readInvitationClaimReconciliationRoutine, [request.mutationId]).pipe(
    Effect.mapError((cause) =>
      workerRejected(
        'RECONCILIATION_UNAVAILABLE',
        'Invitation claim evidence is unavailable',
        cause,
      ),
    ),
    Effect.flatMap(([root]) =>
      root === undefined || !claimRootMatchesRequest(root, request)
        ? Effect.fail(
            workerRejected(
              'RECONCILIATION_UNAVAILABLE',
              'The invitation claim mutation is unavailable or outside the verified scope',
            ),
          )
        : Effect.gen(function* reconcileDurableClaim() {
            // Revocation clears the active claimant/proof fields, but the owner routine
            // preserves the immutable claim root so claim-created tuples remain compensatable.
            if (root.state === 'REVOKED') {
              return yield* compensateInvitationClaim(scope, root, mutation);
            }
            const initialAuthority = yield* claimInviterAuthorityDecision(
              contextAccess,
              scope,
              root,
              ownerAccessReader,
            );
            if (initialAuthority !== 'allowed') {
              return yield* compensateInvitationClaim(scope, root, mutation);
            }
            const pending = yield* scope.routineInvoker
              .invoke(stageInvitationClaimGrantsRoutine, [request.mutationId, false])
              .pipe(
                Effect.mapError((cause) =>
                  workerRejected(
                    'RECONCILIATION_UNAVAILABLE',
                    'Invitation permission staging is unavailable',
                    cause,
                  ),
                ),
              );
            if (!claimPermissionRowsMatchRoot(root, pending)) {
              return yield* workerRejected(
                'RECONCILIATION_UNAVAILABLE',
                'A staged invitation permission mutation is not linked to the durable claim',
              );
            }
            if (pending.some(({ mutation_staged: staged }) => staged)) {
              return { outcome: 'INDETERMINATE' as const };
            }
            const results = yield* Effect.forEach(
              pending,
              (row) =>
                reconcileAccessRow({ scope, transaction: scope.routineInvoker }, mutation, row),
              { concurrency: 1 },
            );
            if (results.some((repaired) => !repaired)) {
              return { outcome: 'INDETERMINATE' as const };
            }
            const terminalAuthority = yield* claimInviterAuthorityDecision(
              contextAccess,
              scope,
              root,
              ownerAccessReader,
            );
            if (terminalAuthority !== 'allowed') {
              return yield* compensateInvitationClaim(scope, root, mutation);
            }
            const [finalized] = yield* scope.routineInvoker
              .invoke(finalizeInvitationClaimRoutine, [request.mutationId])
              .pipe(
                Effect.mapError((cause) =>
                  workerRejected(
                    'RECONCILIATION_UNAVAILABLE',
                    'Invitation claim finalization is unavailable',
                    cause,
                  ),
                ),
              );
            if (
              finalized === undefined ||
              finalized.operation_outcome === 'PENDING_AUTHORIZATION' ||
              finalized.claimed_at === null ||
              finalized.claimed_by_principal_id === null
            ) {
              return { outcome: 'INDETERMINATE' as const };
            }
            const { operation_outcome: _, ...invitationEvidence } = finalized;
            return {
              outcome:
                finalized.operation_outcome === 'CLAIMED'
                  ? ('FINALIZED' as const)
                  : ('ALREADY_FINAL' as const),
              terminal: {
                attestation: invitationClaimAttestation(
                  scope,
                  invitationEvidence,
                  finalized.claimed_by_principal_id,
                ),
                completionId: finalized.claim_mutation_id,
                invitation: invitationFromRow(scope.tenantId, invitationEvidence),
                kind: 'INVITATION_CLAIM' as const,
                occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe(finalized.claimed_at)),
                sourceActionInvocationId: finalized.source_action_invocation_id,
              },
            };
          }),
    ),
  );

/** Production worker adapter. Every target fact is loaded from owner routines before mutation. */
export const accessAuthorizationMutationReconciliationForWorker = (
  contextAccess: Pick<ContextAccessService, 'businessPermissions'>,
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
  ownerAccessReader?: typeof currentOwnerAccessForTransaction,
): AccessAuthorizationMutationReconciliationService => {
  const service: AccessAuthorizationMutationReconciliationService = {
    reconcile: (scope, request) => {
      if (request.operation === 'claim') {
        return reconcileInvitationClaimForWorker(
          scope,
          request,
          contextAccess,
          mutation,
          ownerAccessReader,
        );
      }
      return accessAuthorizationMutationReconciliationForScopedWorker(scope, mutation)
        .reconcileOne({
          counterpartyResourceId: request.counterpartyRef.resourceId,
          grantId: request.grantRef.resourceId,
          mutationId: request.mutationId,
          operation: request.operation,
        })
        .pipe(
          Effect.mapError((cause) =>
            workerRejected(
              'RECONCILIATION_UNAVAILABLE',
              'Access authorization reconciliation is unavailable',
              cause,
            ),
          ),
          Effect.map((result) => {
            if (result.outcome === 'INDETERMINATE') {
              return { outcome: 'INDETERMINATE' as const };
            }
            return {
              outcome: result.outcome,
              terminal: {
                completionId: result.mutationId,
                grant: result.grant,
                kind: 'GRANT' as const,
                occurredAt: result.occurredAt,
                sourceActionInvocationId: result.sourceActionInvocationId,
              },
            };
          }),
        );
    },
  };
  return Object.freeze(service);
};

export const accessAuthorizationReconcilerForTransaction = (
  dependencies: AccessAuthorizationReconciliationContext,
  mutation: Pick<BusinessPermissionRelationshipMutationService, 'mutate'>,
): AuthorizationMutationReconcilerService => {
  const service: AuthorizationMutationReconcilerService = {
    reconcile: ({
      limit,
      tenantId,
    }: {
      readonly limit: number;
      readonly tenantId?: string | undefined;
    }) => {
      if (
        limit < 1 ||
        limit > 100 ||
        (tenantId !== undefined && tenantId !== dependencies.scope.tenantId)
      ) {
        return Effect.fail(reconciliationFailure('The reconciliation request is outside scope'));
      }
      return dependencies.transaction.invoke(listAccessReconciliationRoutine, [limit]).pipe(
        Effect.mapError((cause) =>
          reconciliationFailure('Access reconciliation storage is unavailable', cause),
        ),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => reconcileAccessRow(dependencies, mutation, row), {
            concurrency: 1,
          }),
        ),
        Effect.map((repaired) => ({
          examined: repaired.length,
          repaired: repaired.filter(Boolean).length,
          stillIndeterminate: repaired.filter((value) => !value).length,
        })),
      );
    },
  };
  return Object.freeze(service);
};

export const accessPersistenceRoutineAllowlist = Object.freeze([
  listAccessGrantsRoutine,
  lockAccessGrantAuthorityRoutine,
  beginAccessGrantRoutine,
  beginAccessRevokeRoutine,
  transitionAccessGrantRoutine,
  listAccessReconciliationRoutine,
  readAccessReconciliationRoutine,
  readInvitationClaimReconciliationRoutine,
  stageInvitationClaimGrantsRoutine,
  finalizeInvitationClaimRoutine,
  createAccessInvitationRoutine,
  readAccessInvitationRoutine,
  mutateAccessInvitationRoutine,
]);
/* oxlint-enable effect-native/no-dependency-parameters */
/* oxlint-enable anti-slop/no-conditional-empty-object-spread */
