import type { OwnerPermissionAccessTarget, ResourceContainmentRelationshipMutationInput } from '@app/core-runtime';
import { Result, Schema } from 'effect';
import { priceGroupOwnerPermissionTarget } from './authorization.ts';

const identifier = Schema.String.check(Schema.isUUID());
const PermissionPartsSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Tuple([Schema.String, identifier, Schema.Literal('pricing_catalog'), identifier]),
    Schema.Tuple([Schema.String, identifier, Schema.Literal('price_group'), identifier, identifier]),
  ]),
);
const childPermissions = new Set([
  'pricing.price_group.read',
  'pricing.price_group.revision.create',
  'pricing.price_group.retire',
]);

const decodeTarget = (objectId: string): OwnerPermissionAccessTarget | undefined => {
  if (!objectId.startsWith('ctx_') || objectId.length > 1024) {
    return undefined;
  }
  const decoded = Schema.decodeUnknownResult(PermissionPartsSchema)(
    Buffer.from(objectId.slice(4), 'base64url').toString('utf-8'),
  );
  if (Result.isFailure(decoded)) {
    return undefined;
  }
  const [permission, tenantId, kind, pricingCatalogId, priceGroupId] = decoded.success;
  if (!childPermissions.has(permission) || tenantId !== pricingCatalogId) {
    return undefined;
  }
  const target =
    kind === 'pricing_catalog'
      ? { kind, pricingCatalogId, tenantId }
      : { kind, priceGroupId: priceGroupId ?? '', pricingCatalogId, tenantId };
  const qualified = priceGroupOwnerPermissionTarget({ permission, target }, 'action');
  return qualified.objectId === objectId ? qualified : undefined;
};

/** Owner topology is exactly one Tenant catalog containing a group under the same atomic Permission. */
export const preparePriceGroupContainment = (
  input: ResourceContainmentRelationshipMutationInput,
): readonly OwnerPermissionAccessTarget[] | undefined => {
  const targets: OwnerPermissionAccessTarget[] = [];
  for (const relationship of input.relationships) {
    const child = decodeTarget(relationship.resource.objectId);
    if (
      child === undefined ||
      child.scopeKind !== 'price_group' ||
      relationship.resource.objectType !== 'business_permission'
    ) {
      return undefined;
    }
    targets.push(child);
    if (relationship.relation === 'tenant') {
      if (relationship.container.objectType !== 'tenant' || relationship.container.objectId !== child.scope.tenantId) {
        return undefined;
      }
    } else {
      const parent = decodeTarget(relationship.container.objectId);
      if (
        relationship.container.objectType !== 'business_permission' ||
        parent === undefined ||
        parent.scopeKind !== 'pricing_catalog' ||
        parent.definition !== child.definition ||
        parent.scope.tenantId !== child.scope.tenantId
      ) {
        return undefined;
      }
      targets.push(parent);
    }
  }
  return targets;
};
