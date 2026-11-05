import { Schema } from 'effect';
import {
  ProfileInstantSchema,
  RetailPortalBindingAuthorizationOperationSchema,
  RetailPortalBindingStateSchema,
  SellingLegalEntityRefSchema,
} from '../domain/profile-contracts.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { RetailPortalProfileBindingRefSchema } from '../resources/retail-portal-profile-binding.ts';

const PrincipalIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
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
  expectedState: Schema.NullOr(RetailPortalBindingStateSchema),
  principalRef: PrincipalRefSchema,
  profileRef: RetailCustomerProfileRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
});
export type RetailPortalBindingPayload = typeof RetailPortalBindingPayloadSchema.Type;

/** The binding and its authorization are written together, so both name the same final state. */
const retailPortalBindingResultIssue = (result: {
  readonly authorizationOperation?: typeof RetailPortalBindingAuthorizationOperationSchema.Type;
  readonly authorizationState?: typeof RetailPortalBindingStateSchema.Type;
  readonly state: typeof RetailPortalBindingStateSchema.Type;
}) =>
  (result.authorizationOperation === undefined ||
    result.authorizationOperation === (result.state === 'ACTIVE' ? 'grant' : 'revoke')) &&
  (result.authorizationState === undefined || result.authorizationState === result.state)
    ? undefined
    : 'Retail binding authorization must match the binding state';

export const RetailPortalBindingResultSchema = Schema.Struct({
  authorizationOperation: Schema.optionalKey(RetailPortalBindingAuthorizationOperationSchema),
  authorizationState: Schema.optionalKey(RetailPortalBindingStateSchema),
  bindingRef: RetailPortalProfileBindingRefSchema,
  effectiveAt: ProfileInstantSchema,
  outcome: Schema.Literals(['BINDING_ACTIVATED', 'BINDING_RECOVERED', 'BINDING_REVOKED']),
  revision: RevisionSchema,
  state: RetailPortalBindingStateSchema,
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

/** The binding facts every activated, recovered and revoked event carries. */
export const retailPortalBindingEventFields = (
  result: Pick<RetailPortalBindingResult, 'bindingRef' | 'effectiveAt' | 'revision'>,
  payload: Pick<RetailPortalBindingPayload, 'principalRef' | 'profileRef' | 'sellingLegalEntityRef'>,
) => ({
  bindingRef: result.bindingRef,
  effectiveAt: result.effectiveAt,
  principalRef: payload.principalRef,
  profileRef: payload.profileRef,
  revision: result.revision,
  sellingLegalEntityRef: payload.sellingLegalEntityRef,
});

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
