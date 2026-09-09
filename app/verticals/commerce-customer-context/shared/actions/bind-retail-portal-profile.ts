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
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('LegalEntityId'),
);
const BindingStateSchema = Schema.Literals(['ACTIVE', 'REVOKED']);
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const PrincipalRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: PrincipalIdSchema,
  resourceType: Schema.Literal('core.identity.principal'),
  tenantId: TenantIdSchema,
});

export const RetailPortalBindingPayloadSchema = Schema.Struct({
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

export const RetailPortalBindingAuthorizationMutationIdSchema = Schema.String.check(
  Schema.isUUID(),
).pipe(Schema.decodeTo(Schema.String));
export type RetailPortalBindingAuthorizationMutationId =
  typeof RetailPortalBindingAuthorizationMutationIdSchema.Type;

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
}).check(
  Schema.makeFilter((result) => {
    let issue: string | undefined;
    if (result.authorizationOperation !== undefined && result.authorizationState !== undefined) {
      const validState =
        result.authorizationOperation === 'grant'
          ? ['ACTIVE', 'PENDING_GRANT', 'RECONCILIATION_REQUIRED'].includes(
              result.authorizationState,
            )
          : ['REVOKED', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED'].includes(
              result.authorizationState,
            );
      if (!validState) {
        issue = 'Retail binding authorization state must match its operation';
      }
    }
    if (issue === undefined && result.permissionMutations !== undefined) {
      const permissions = result.permissionMutations.map(({ permission }) => permission);
      const operations = new Set(result.permissionMutations.map(({ operation }) => operation));
      const expected = new Set<string>(RETAIL_PORTAL_SELF_SERVICE_BASELINE);
      if (
        permissions.length !== expected.size ||
        new Set(permissions).size !== permissions.length ||
        !permissions.every((permission) => expected.has(permission)) ||
        operations.size !== 1 ||
        (result.authorizationOperation !== undefined &&
          result.permissionMutations.some(
            ({ operation }) => operation !== result.authorizationOperation,
          ))
      ) {
        issue =
          'Retail binding Permission mutation intents must exactly cover the reviewed baseline';
      }
    }
    return issue;
  }),
);
export type RetailPortalBindingResult = typeof RetailPortalBindingResultSchema.Type;

export const RetailPortalBindingPermissionMutationSchema = Schema.Struct({
  mutationId: RetailPortalBindingAuthorizationMutationIdSchema,
  operation: RetailPortalBindingAuthorizationOperationSchema,
  permission: RetailPortalPermissionCodeSchema,
});
export type RetailPortalBindingPermissionMutation =
  typeof RetailPortalBindingPermissionMutationSchema.Type;

const authorizationMutationRequestedFields = {
  bindingRef: RetailPortalProfileBindingRefSchema,
  catalogVersion: Schema.Literal('1'),
  legalEntityId: LegalEntityIdSchema,
  mutationId: RetailPortalBindingAuthorizationMutationIdSchema,
  permissionMutations: Schema.optionalKey(
    Schema.Array(RetailPortalBindingPermissionMutationSchema),
  ),
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
    issue =
      'Retail binding authorization mutation references must share one exact Tenant and Legal Entity';
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

export const RetailPortalProfileBindingActivationAuthorizationMutationRequestedPayloadSchema =
  Schema.Struct({
    ...authorizationMutationRequestedFields,
    operation: Schema.Literal('grant'),
    transition: Schema.Literal('activation'),
  }).check(Schema.makeFilter(exactAuthorizationMutationScope));
export type RetailPortalProfileBindingActivationAuthorizationMutationRequestedPayload =
  typeof RetailPortalProfileBindingActivationAuthorizationMutationRequestedPayloadSchema.Type;

export const RetailPortalProfileBindingRecoveryAuthorizationMutationRequestedPayloadSchema =
  Schema.Struct({
    ...authorizationMutationRequestedFields,
    operation: Schema.Literal('grant'),
    transition: Schema.Literal('recovery'),
  }).check(Schema.makeFilter(exactAuthorizationMutationScope));
export type RetailPortalProfileBindingRecoveryAuthorizationMutationRequestedPayload =
  typeof RetailPortalProfileBindingRecoveryAuthorizationMutationRequestedPayloadSchema.Type;

export const RetailPortalProfileBindingRevocationAuthorizationMutationRequestedPayloadSchema =
  Schema.Struct({
    ...authorizationMutationRequestedFields,
    operation: Schema.Literal('revoke'),
    transition: Schema.Literal('revocation'),
  }).check(Schema.makeFilter(exactAuthorizationMutationScope));
export type RetailPortalProfileBindingRevocationAuthorizationMutationRequestedPayload =
  typeof RetailPortalProfileBindingRevocationAuthorizationMutationRequestedPayloadSchema.Type;

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
export const BindRetailPortalProfileResultSchema = RetailPortalBindingResultSchema;
export type BindRetailPortalProfilePayload = typeof BindRetailPortalProfilePayloadSchema.Type;
export type BindRetailPortalProfileResult = typeof BindRetailPortalProfileResultSchema.Type;
