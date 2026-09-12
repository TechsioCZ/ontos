import { Schema } from 'effect';
import {
  ProfileInstantSchema,
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  RetailPortalBindingAuthorizationOperationSchema,
  RetailPortalBindingAuthorizationStateSchema,
  RetailPortalPermissionCodeSchema,
  SellingLegalEntityRefSchema,
} from '../domain/profile-contracts.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import {
  RetailPortalPrincipalRefSchema,
  RetailPortalProfileBindingRefSchema,
} from '../resources/retail-portal-profile-binding.ts';

const PrincipalIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const BindingStateSchema = Schema.Literals(['ACTIVE', 'REVOKED']);
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const PrincipalRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: PrincipalIdSchema,
  resourceType: Schema.Literal('core.identity.principal'),
  tenantId: TenantIdSchema,
});

const RetailPortalBindingPayloadSchema = Schema.Struct({
  effectiveAt: ProfileInstantSchema,
  enrollmentEvidenceRef: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null explicitly means no existing binding revision on create.
  expectedRevision: Schema.NullOr(RevisionSchema),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null explicitly means no existing binding state on create.
  expectedState: Schema.NullOr(BindingStateSchema),
  principalRef: PrincipalRefSchema,
  profileRef: RetailCustomerProfileRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
});
export type RetailPortalBindingPayload = typeof RetailPortalBindingPayloadSchema.Type;

interface RetailPortalBindingResultValidationInput {
  readonly authorizationOperation?: typeof RetailPortalBindingAuthorizationOperationSchema.Type;
  readonly authorizationState?: typeof RetailPortalBindingAuthorizationStateSchema.Type;
  readonly permissionMutations?: readonly {
    readonly operation: typeof RetailPortalBindingAuthorizationOperationSchema.Type;
    readonly permission: typeof RetailPortalPermissionCodeSchema.Type;
  }[];
}

const authorizationStateIssue = (result: RetailPortalBindingResultValidationInput) => {
  const { authorizationOperation, authorizationState } = result;
  if (authorizationOperation === undefined || authorizationState === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined preserves this optional validation-result contract.
    return undefined;
  }
  const validStates =
    authorizationOperation === 'grant'
      ? ['ACTIVE', 'PENDING_GRANT', 'RECONCILIATION_REQUIRED']
      : ['REVOKED', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED'];
  return validStates.includes(authorizationState)
    ? undefined
    : 'Retail binding authorization state must match its operation';
};

const permissionMutationIssue = (result: RetailPortalBindingResultValidationInput) => {
  const { authorizationOperation, permissionMutations } = result;
  if (permissionMutations === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined preserves this optional validation-result contract.
    return undefined;
  }
  const permissions = permissionMutations.map(({ permission }) => permission);
  const operations = new Set(permissionMutations.map(({ operation }) => operation));
  const expected = new Set<string>(RETAIL_PORTAL_SELF_SERVICE_BASELINE);
  const coversReviewedBaseline =
    permissions.length === expected.size &&
    new Set(permissions).size === permissions.length &&
    permissions.every((permission) => expected.has(permission));
  const matchesAuthorizationOperation =
    operations.size === 1 &&
    (authorizationOperation === undefined ||
      permissionMutations.every(({ operation }) => operation === authorizationOperation));
  return coversReviewedBaseline && matchesAuthorizationOperation
    ? undefined
    : 'Retail binding Permission mutation intents must exactly cover the reviewed baseline';
};

const retailPortalBindingResultIssue = (result: RetailPortalBindingResultValidationInput) =>
  authorizationStateIssue(result) ?? permissionMutationIssue(result);

const RetailPortalBindingAuthorizationMutationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.decodeTo(Schema.String),
);

export const RetailPortalBindingResultSchema = Schema.Struct({
  authorizationMutationId: Schema.optionalKey(RetailPortalBindingAuthorizationMutationIdSchema),
  authorizationOperation: Schema.optionalKey(RetailPortalBindingAuthorizationOperationSchema),
  authorizationState: Schema.optionalKey(RetailPortalBindingAuthorizationStateSchema),
  bindingRef: RetailPortalProfileBindingRefSchema,
  effectiveAt: ProfileInstantSchema,
  outcome: Schema.Literals(['BINDING_ACTIVATED', 'BINDING_RECOVERED', 'BINDING_REVOKED']),
  permissionMutations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        mutationId: RetailPortalBindingAuthorizationMutationIdSchema,
        operation: RetailPortalBindingAuthorizationOperationSchema,
        permission: RetailPortalPermissionCodeSchema,
        staged: Schema.Boolean,
      }),
    ),
  ),
  revision: RevisionSchema,
  state: BindingStateSchema,
}).check(Schema.makeFilter(retailPortalBindingResultIssue));
export type RetailPortalBindingResult = typeof RetailPortalBindingResultSchema.Type;

interface RetailPortalBindingTrustedScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

export const retailPortalBindingPayloadMatchesTrustedScope = (
  payload: RetailPortalBindingPayload,
  scope: RetailPortalBindingTrustedScope,
) =>
  payload.profileRef.tenantId === scope.tenantId &&
  payload.principalRef.tenantId === scope.tenantId &&
  payload.sellingLegalEntityRef.tenantId === scope.tenantId &&
  payload.sellingLegalEntityRef.resourceId === scope.legalEntityId;

export const retailPortalBindingResultMatches = (
  result: Pick<RetailPortalBindingResult, 'bindingRef' | 'effectiveAt' | 'outcome' | 'state'>,
  scope: Pick<RetailPortalBindingTrustedScope, 'tenantId'>,
  effectiveAt: RetailPortalBindingPayload['effectiveAt'],
  expectedOutcome: RetailPortalBindingResult['outcome'],
  expectedState: RetailPortalBindingResult['state'],
) =>
  result.bindingRef.tenantId === scope.tenantId &&
  result.effectiveAt === effectiveAt &&
  result.outcome === expectedOutcome &&
  result.state === expectedState;

export const retailPortalBindingStagedPermissionMutations = (
  permissionMutations: RetailPortalBindingResult['permissionMutations'],
) => (permissionMutations !== undefined && permissionMutations.length > 0 ? permissionMutations : undefined);

export const retailPortalBindingPermissionMutationPayloads = <
  Mutation extends {
    readonly mutationId: string;
    readonly operation: typeof RetailPortalBindingAuthorizationOperationSchema.Type;
    readonly permission: typeof RetailPortalPermissionCodeSchema.Type;
  },
>(
  permissionMutations: readonly Mutation[],
) => permissionMutations.map(({ mutationId, operation, permission }) => ({ mutationId, operation, permission }));

const RetailPortalBindingPermissionMutationSchema = Schema.Struct({
  mutationId: RetailPortalBindingAuthorizationMutationIdSchema,
  operation: RetailPortalBindingAuthorizationOperationSchema,
  permission: RetailPortalPermissionCodeSchema,
});
type RetailPortalBindingPermissionMutation = typeof RetailPortalBindingPermissionMutationSchema.Type;

const authorizationMutationRequestedFields = {
  bindingRef: RetailPortalProfileBindingRefSchema,
  catalogVersion: Schema.Literal('1'),
  legalEntityId: LegalEntityIdSchema,
  mutationId: RetailPortalBindingAuthorizationMutationIdSchema,
  permissionMutations: Schema.optionalKey(Schema.Array(RetailPortalBindingPermissionMutationSchema)),
  principalRef: RetailPortalPrincipalRefSchema,
  profileRef: RetailCustomerProfileRefSchema,
  schemaVersion: Schema.Literal('1'),
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
} as const;

const exactAuthorizationMutationScope = <
  Request extends {
    readonly bindingRef: { readonly tenantId: string };
    readonly legalEntityId: string;
    readonly operation: 'grant' | 'revoke';
    readonly permissionMutations?: readonly RetailPortalBindingPermissionMutation[];
    readonly principalRef: { readonly tenantId: string };
    readonly profileRef: { readonly tenantId: string };
    readonly sellingLegalEntityRef: { readonly resourceId: string; readonly tenantId: string };
  },
>(
  request: Request,
) => {
  const referencesMatch =
    request.bindingRef.tenantId === request.profileRef.tenantId &&
    request.bindingRef.tenantId === request.principalRef.tenantId &&
    request.bindingRef.tenantId === request.sellingLegalEntityRef.tenantId &&
    request.legalEntityId === request.sellingLegalEntityRef.resourceId;
  let issue: string | undefined;
  if (!referencesMatch) {
    issue = 'Retail binding authorization mutation references must share one exact Tenant and Legal Entity';
  } else if (request.permissionMutations !== undefined) {
    const intentsAreExact =
      new Set(request.permissionMutations.map(({ mutationId }) => mutationId)).size ===
        request.permissionMutations.length &&
      new Set(request.permissionMutations.map(({ permission }) => permission)).size ===
        request.permissionMutations.length &&
      request.permissionMutations.every(({ operation }) => operation === request.operation);
    if (!intentsAreExact) {
      issue = 'Retail binding authorization mutation intents must be exact and atomic';
    }
  }
  return issue;
};

export { LegalEntityIdSchema };

export const RetailPortalProfileBindingActivationAuthorizationMutationRequestedPayloadSchema = Schema.Struct({
  ...authorizationMutationRequestedFields,
  operation: Schema.Literal('grant'),
  transition: Schema.Literal('activation'),
}).check(Schema.makeFilter(exactAuthorizationMutationScope));

export const RetailPortalProfileBindingRecoveryAuthorizationMutationRequestedPayloadSchema = Schema.Struct({
  ...authorizationMutationRequestedFields,
  operation: Schema.Literal('grant'),
  transition: Schema.Literal('recovery'),
}).check(Schema.makeFilter(exactAuthorizationMutationScope));

export const RetailPortalProfileBindingRevocationAuthorizationMutationRequestedPayloadSchema = Schema.Struct({
  ...authorizationMutationRequestedFields,
  operation: Schema.Literal('revoke'),
  transition: Schema.Literal('revocation'),
}).check(Schema.makeFilter(exactAuthorizationMutationScope));

export class RetailPortalBindingActionRejected extends Schema.TaggedError<RetailPortalBindingActionRejected>()(
  'RetailPortalBindingActionRejected',
  {
    code: Schema.Literals([
      'PROFILE_NOT_FOUND',
      'PROFILE_NOT_ACTIVE',
      'BINDING_NOT_FOUND',
      'BINDING_CONFLICT',
      'BINDING_AMBIGUOUS',
      'ENROLLMENT_EVIDENCE_INSUFFICIENT',
      'CURRENT_STATE_CONFLICT',
      'DEPENDENCY_UNAVAILABLE',
      'PERSISTENCE_UNAVAILABLE',
      'OUTCOME_INDETERMINATE',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export const BindRetailPortalProfilePayloadSchema = RetailPortalBindingPayloadSchema;
export type BindRetailPortalProfilePayload = typeof BindRetailPortalProfilePayloadSchema.Type;
