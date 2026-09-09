import { Schema } from 'effect';
import { RetailPortalBindingResultSchema } from './bind-retail-portal-profile.ts';
import { ProfileInstantSchema, SellingLegalEntityRefSchema } from '../domain/profile-contracts.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';

const PrincipalIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId'));
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const BindingStateSchema = Schema.Literals(['ACTIVE', 'REVOKED']);
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const PrincipalRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: PrincipalIdSchema,
  resourceType: Schema.Literal('core.identity.principal'),
  tenantId: TenantIdSchema,
});

export const RecoverRetailPortalProfileBindingPayloadSchema = Schema.Struct({
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
export type RecoverRetailPortalProfileBindingPayload =
  typeof RecoverRetailPortalProfileBindingPayloadSchema.Type;

export const RecoverRetailPortalProfileBindingResultSchema = RetailPortalBindingResultSchema;
export type RecoverRetailPortalProfileBindingResult =
  typeof RecoverRetailPortalProfileBindingResultSchema.Type;
