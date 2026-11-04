import {
  createOwnerPermissionAccessTarget,
  defineActionOwnerPermissions,
  defineReadOwnerPermission,
} from '@app/core-runtime';
import type { OperationalScope, OwnerPermissionAccessTarget } from '@app/core-runtime';
import { Result, Schema } from 'effect';
import { commerceCustomerContextAuthorizationContract } from '../../shared/permissions/authorization-contract.ts';

const identifier = Schema.String.check(Schema.isMinLength(1));
const CustomerPermissionTenantIdSchema = Schema.String.pipe(
  Schema.brand('CustomerPermissionTenantId'),
  Schema.decodeTo(Schema.String),
);
const CustomerPermissionLegalEntityIdSchema = Schema.String.pipe(
  Schema.brand('CustomerPermissionLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const CustomerPermissionProfileIdSchema = identifier.pipe(
  Schema.brand('CustomerPermissionProfileId'),
  Schema.decodeTo(identifier),
);
const CustomerPermissionCounterpartyIdSchema = identifier.pipe(
  Schema.brand('CustomerPermissionCounterpartyId'),
  Schema.decodeTo(identifier),
);
const CustomerPermissionStorefrontIdSchema = identifier.pipe(
  Schema.brand('CustomerPermissionStorefrontId'),
  Schema.decodeTo(identifier),
);
const encodeGrantParts = Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)));
// Invalid or missing trusted scope remains observable to Core's typed fail-closed boundary.
const common = { legalEntityId: CustomerPermissionLegalEntityIdSchema, tenantId: CustomerPermissionTenantIdSchema };
export const CustomerPermissionTargetSchema = Schema.Union([
  Schema.Struct({ ...common, kind: Schema.Literal('retail_profile'), profileId: CustomerPermissionProfileIdSchema }),
  Schema.Struct({
    ...common,
    counterpartyId: CustomerPermissionCounterpartyIdSchema,
    kind: Schema.Literal('counterparty'),
  }),
  Schema.Struct({
    ...common,
    counterpartyId: CustomerPermissionCounterpartyIdSchema,
    kind: Schema.Literal('counterparty_storefront'),
    storefrontId: CustomerPermissionStorefrontIdSchema,
  }),
]);
export type CustomerPermissionTarget = typeof CustomerPermissionTargetSchema.Type;
export interface CustomerPermissionRequest {
  readonly permission: string;
  readonly target: CustomerPermissionTarget;
  readonly trustedStorefrontId?: string;
}
class CustomerPermissionInvariant extends Schema.TaggedError<CustomerPermissionInvariant>()(
  'CustomerPermissionInvariant',
  { reason: Schema.String },
) {}
const invalid = (): never => {
  throw new CustomerPermissionInvariant({ reason: 'The exact customer permission target is invalid' });
};
const parts = ({ permission, target }: CustomerPermissionRequest): readonly string[] => [
  permission,
  target.tenantId,
  target.legalEntityId,
  target.kind,
  target.kind === 'retail_profile' ? target.profileId : target.counterpartyId,
  ...(target.kind === 'counterparty_storefront' ? [target.storefrontId] : []),
];
export const customerPermissionKey = (request: CustomerPermissionRequest): string => parts(request).join(':');
export const customerPermissionObjectId = (request: CustomerPermissionRequest): string => {
  const values = parts(request);
  if (values.some((part) => part.length === 0)) {
    return '';
  }
  const objectId = `ctx_${Buffer.from(Result.getOrThrow(encodeGrantParts(values)), 'utf-8').toString('base64url')}`;
  return objectId.length <= 1024 ? objectId : '';
};

export const customerOwnerPermissionTarget = (
  requested: CustomerPermissionRequest,
  transport: 'action' | 'read' = 'read',
): OwnerPermissionAccessTarget => {
  const target = Result.getOrThrow(Schema.decodeUnknownResult(CustomerPermissionTargetSchema)(requested.target));
  const definition = commerceCustomerContextAuthorizationContract.permissions.find(
    (entry) => entry.key === requested.permission,
  );
  if (definition === undefined || !definition.allowedScopeKinds.includes(target.kind)) {
    return invalid();
  }
  // Core compares requiredStorefrontId with the genuine operation scope before owner effects.
  const exact = { permission: requested.permission, target };
  const alternativeObjectIds =
    target.kind === 'counterparty_storefront'
      ? Object.freeze([
          customerPermissionObjectId({
            permission: requested.permission,
            target: {
              counterpartyId: target.counterpartyId,
              kind: 'counterparty',
              legalEntityId: target.legalEntityId,
              tenantId: target.tenantId,
            },
          }),
        ])
      : Object.freeze([]);
  let transportObjectId: string;
  if (target.kind === 'retail_profile') {
    transportObjectId = target.profileId;
  } else if (target.kind === 'counterparty') {
    transportObjectId = target.counterpartyId;
  } else {
    transportObjectId = `${target.counterpartyId}:${target.storefrontId}`;
  }
  const input = {
    alternativeObjectIds,
    definition,
    key: customerPermissionKey(exact),
    objectId: customerPermissionObjectId(exact),
    scope: { kind: 'legal_entity' as const, legalEntityId: target.legalEntityId, tenantId: target.tenantId },
    scopeKind: target.kind,
    target: Object.freeze(target),
    transportModuleKey: transport === 'action' ? 'commerce.customer-context' : requested.permission,
    transportObjectId,
    transportResourceType: transport === 'action' ? `${target.kind}:${requested.permission}` : target.kind,
  };
  if (target.kind === 'counterparty_storefront') {
    return createOwnerPermissionAccessTarget(commerceCustomerContextAuthorizationContract, {
      ...input,
      requiredStorefrontId: target.storefrontId,
    });
  }
  return createOwnerPermissionAccessTarget(commerceCustomerContextAuthorizationContract, input);
};
export const defineCustomerActionPermissions = <Payload>(
  resolver: (payload: Payload, scope: OperationalScope) => CustomerPermissionRequest,
) =>
  defineActionOwnerPermissions(commerceCustomerContextAuthorizationContract, (payload: Payload, scope) => [
    customerOwnerPermissionTarget(resolver(payload, scope), 'action'),
  ]);
export const customerReadPermissionTarget = (request: CustomerPermissionRequest) => ({
  kind: 'owner_permission' as const,
  ownerPermission: customerOwnerPermissionTarget(request),
});

export const defineCustomerResolvedReadPermission = <Input>(
  resolver: (
    input: Input,
    scope: OperationalScope,
  ) => { readonly kind: 'owner_permission'; readonly ownerPermission: OwnerPermissionAccessTarget },
) =>
  defineReadOwnerPermission(
    commerceCustomerContextAuthorizationContract,
    (input: Input, scope) => resolver(input, scope).ownerPermission,
  );

export type CustomerResolvedReadPermissionTarget = ReturnType<typeof customerReadPermissionTarget>;
