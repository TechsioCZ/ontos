import {
  createOwnerPermissionAccessTarget,
  defineActionOwnerPermissions,
  defineReadOwnerPermission,
} from '@app/core-runtime';
import type { OperationalScope, OwnerPermissionAccessTarget } from '@app/core-runtime';
import { Result, Schema } from 'effect';
import { inventoryAuthorizationContract } from '../../shared/permissions/authorization-contract.ts';

export interface InventoryPermissionRequest {
  readonly permission: string;
  readonly target: {
    readonly kind: 'inventory_resource';
    readonly resource: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
    readonly tenantId: string;
  };
}

const canonicalResourceId = Schema.String.check(Schema.isUUID());
const InventoryPermissionResourceIdSchema = canonicalResourceId.pipe(
  Schema.brand('InventoryPermissionResourceId'),
  Schema.decodeTo(canonicalResourceId),
);
const encodeGrantParts = Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)));

const InventoryAuthorizationResourceSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.inventory'),
  resourceId: InventoryPermissionResourceIdSchema,
  resourceType: Schema.String.check(Schema.isPattern(/^commerce\.inventory\.[a-z][a-z0-9-]*$/u)),
});
const InventoryPermissionInvariant = Schema.TaggedError<Error>()('InventoryPermissionInvariant', {
  reason: Schema.String,
});

/** Preserves the existing grant identity independently of raw ResourceRef history. */
export const inventoryOwnerPermissionTarget = (requested: InventoryPermissionRequest): OwnerPermissionAccessTarget => {
  const { permission, target } = requested;
  const definition = inventoryAuthorizationContract.permissions.find((entry) => entry.key === permission);
  if (definition === undefined) {
    throw new InventoryPermissionInvariant({ reason: 'The Inventory permission is not declared by this owner' });
  }
  const parts = [
    permission,
    target.tenantId,
    target.kind,
    target.resource.moduleId,
    target.resource.resourceType,
    target.resource.resourceId,
  ];
  const encoded = `ctx_${Buffer.from(Result.getOrThrow(encodeGrantParts(parts)), 'utf-8').toString('base64url')}`;
  const valid =
    target.kind === 'inventory_resource' &&
    Schema.is(InventoryAuthorizationResourceSchema)(target.resource) &&
    parts.every((part) => part.length > 0) &&
    encoded.length <= 1024;
  return createOwnerPermissionAccessTarget(inventoryAuthorizationContract, {
    definition,
    key: parts.join(':'),
    objectId: valid ? encoded : '',
    scope: { kind: 'tenant', tenantId: target.tenantId },
    scopeKind: target.kind,
    target: Object.freeze({ ...target, resource: Object.freeze({ ...target.resource }) }),
    transportModuleKey: target.resource.moduleId,
    transportObjectId: target.resource.resourceId,
    transportResourceType: target.resource.resourceType,
  });
};

export const defineInventoryActionPermissions = <Payload>(
  resolver: (payload: Payload, scope: OperationalScope) => InventoryPermissionRequest,
) =>
  defineActionOwnerPermissions(inventoryAuthorizationContract, (payload: Payload, scope) =>
    Object.freeze([inventoryOwnerPermissionTarget(resolver(payload, scope))]),
  );

export const defineInventoryReadPermission = <Input>(
  resolver: (input: Input, scope: OperationalScope) => InventoryPermissionRequest,
) =>
  defineReadOwnerPermission(inventoryAuthorizationContract, (input: Input, scope) =>
    inventoryOwnerPermissionTarget(resolver(input, scope)),
  );
