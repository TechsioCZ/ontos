import {
  createOwnerPermissionAccessTarget,
  defineActionOwnerPermissions,
  defineReadOwnerPermission,
} from '@app/core-runtime';
import type { OperationalScope, OwnerPermissionAccessTarget } from '@app/core-runtime';
import { Result, Schema } from 'effect';
import { priceGroupAuthorizationContract } from '../../shared/permissions/authorization-contract.ts';

import { PriceGroupResourceIdSchema, PriceGroupTenantIdSchema } from '../../shared/resources/price-group.ts';
import { PriceGroupCatalogIdSchema } from '../../shared/resources/price-group-catalog-root.ts';

export const PriceGroupAuthorizationTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('pricing_catalog'),
    pricingCatalogId: PriceGroupCatalogIdSchema,
    tenantId: PriceGroupTenantIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('price_group'),
    priceGroupId: PriceGroupResourceIdSchema,
    pricingCatalogId: PriceGroupCatalogIdSchema,
    tenantId: PriceGroupTenantIdSchema,
  }),
]);
export type PriceGroupAuthorizationTarget = typeof PriceGroupAuthorizationTargetSchema.Type;
export interface PriceGroupPermissionRequest {
  readonly permission: string;
  readonly target: PriceGroupAuthorizationTarget;
}

const encodeGrantParts = Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)));
const PermissionIdentitySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));

export const priceGroupPermissionIdentity = ({ permission, target }: PriceGroupPermissionRequest) => {
  const decoded = Result.getOrThrow(Schema.decodeUnknownResult(PriceGroupAuthorizationTargetSchema)(target));
  const definition = priceGroupAuthorizationContract.permissions.find((entry) => entry.key === permission);
  const parts = [permission, decoded.tenantId, decoded.kind, decoded.pricingCatalogId];
  if (decoded.kind === 'price_group') {
    parts.push(decoded.priceGroupId);
  }
  const objectId = Result.getOrThrow(
    Schema.decodeUnknownResult(PermissionIdentitySchema)(
      `ctx_${Buffer.from(Result.getOrThrow(encodeGrantParts(parts)), 'utf-8').toString('base64url')}`,
    ),
  );
  return { definition, key: parts.join(':'), objectId, target: decoded };
};

export const priceGroupOwnerPermissionTarget = (
  request: PriceGroupPermissionRequest,
  operation: 'action' | 'read',
): OwnerPermissionAccessTarget => {
  const { definition, key, objectId, target } = priceGroupPermissionIdentity(request);
  if (definition === undefined || !definition.allowedScopeKinds.includes(target.kind)) {
    return Result.getOrThrow(Schema.decodeUnknownResult(Schema.Never)(request));
  }
  return createOwnerPermissionAccessTarget(priceGroupAuthorizationContract, {
    definition,
    key,
    objectId,
    scope: { kind: 'tenant', tenantId: target.tenantId },
    scopeKind: target.kind,
    target: Object.freeze(target),
    transportModuleKey: operation === 'action' ? priceGroupAuthorizationContract.owningModuleKey : request.permission,
    transportObjectId:
      target.kind === 'pricing_catalog' ? target.pricingCatalogId : `${target.pricingCatalogId}:${target.priceGroupId}`,
    transportResourceType: operation === 'action' ? `${target.kind}:${request.permission}` : target.kind,
  });
};

export const definePriceGroupActionPermissions = <Payload>(
  resolver: (payload: Payload, scope: OperationalScope) => PriceGroupPermissionRequest,
) =>
  defineActionOwnerPermissions(priceGroupAuthorizationContract, (payload: Payload, scope) => [
    priceGroupOwnerPermissionTarget(resolver(payload, scope), 'action'),
  ]);

export const definePriceGroupReadPermission = <Input>(
  resolver: (input: Input, scope: OperationalScope) => OwnerPermissionAccessTarget,
) => defineReadOwnerPermission(priceGroupAuthorizationContract, resolver);
