import { Schema } from 'effect';

import { BusinessPermissionDescriptorSchema } from './business-permission.ts';
import type { BusinessPermissionDescriptor } from './business-permission.ts';

/** Owner declarations choose exact business meanings; Core enforces only these neutral scopes. */
export type OwnerPermissionScope =
  | Readonly<{ readonly kind: 'tenant'; readonly tenantId: string }>
  | Readonly<{ readonly kind: 'legal_entity'; readonly legalEntityId: string; readonly tenantId: string }>;

export interface OwnerPermissionContract {
  readonly ownerStateRequired?: boolean;
  readonly owningModuleKey: string;
  readonly permissions: readonly BusinessPermissionDescriptor[];
  readonly schemaVersion: '1';
  readonly targetResourceType: string;
}

export interface OwnerPermissionAccessTarget {
  readonly alternativeObjectIds?: readonly string[];
  readonly contract: OwnerPermissionContract;
  readonly definition: BusinessPermissionDescriptor;
  readonly key: string;
  readonly objectId: string;
  readonly requiredStorefrontId?: string;
  readonly scope: OwnerPermissionScope;
  readonly scopeKind: string;
  /** Owner-local decoded meaning, forwarded only to the same owner's transaction overlay. */
  readonly target: object;
  readonly transportModuleKey: string;
  readonly transportObjectId: string;
  readonly transportResourceType?: string;
}

const ownerPermissionIdentifier = Schema.String.check(Schema.isMinLength(1));
const OwnerPermissionObjectIdSchema = ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionObjectId'));
const OwnerPermissionStorefrontIdSchema = ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionStorefrontId'));
const OwnerPermissionTenantIdSchema = ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionTenantId'));
const OwnerPermissionLegalEntityIdSchema = ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionLegalEntityId'));
const OwnerPermissionTransportModuleKeySchema = ownerPermissionIdentifier.pipe(
  Schema.brand('OwnerPermissionTransportModuleKey'),
);
const OwnerPermissionContractSchema = Schema.Struct({
  ownerStateRequired: Schema.optionalKey(Schema.Boolean),
  owningModuleKey: ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionModuleKey')),
  permissions: Schema.Array(BusinessPermissionDescriptorSchema).check(Schema.isMinLength(1)),
  schemaVersion: Schema.Literal('1'),
  targetResourceType: ownerPermissionIdentifier,
});
const OwnerPermissionTargetMetadataSchema = Schema.Struct({
  alternativeObjectIds: Schema.optionalKey(Schema.Array(OwnerPermissionObjectIdSchema)),
  contract: OwnerPermissionContractSchema,
  definition: BusinessPermissionDescriptorSchema,
  key: ownerPermissionIdentifier,
  objectId: OwnerPermissionObjectIdSchema,
  requiredStorefrontId: Schema.optionalKey(OwnerPermissionStorefrontIdSchema),
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('tenant'), tenantId: OwnerPermissionTenantIdSchema }),
    Schema.Struct({
      kind: Schema.Literal('legal_entity'),
      legalEntityId: OwnerPermissionLegalEntityIdSchema,
      tenantId: OwnerPermissionTenantIdSchema,
    }),
  ]),
  scopeKind: ownerPermissionIdentifier,
  transportModuleKey: OwnerPermissionTransportModuleKeySchema,
  transportObjectId: OwnerPermissionObjectIdSchema,
  transportResourceType: Schema.optionalKey(ownerPermissionIdentifier),
});

export const isOwnerPermissionContract = (contract: OwnerPermissionContract): boolean =>
  Schema.is(OwnerPermissionContractSchema)(contract) &&
  Object.isFrozen(contract) &&
  Object.isFrozen(contract.permissions) &&
  contract.permissions.every((definition) => Object.isFrozen(definition));

export const createOwnerPermissionAccessTarget = (
  contract: OwnerPermissionContract,
  input: Omit<OwnerPermissionAccessTarget, 'contract'>,
): OwnerPermissionAccessTarget => {
  const { alternativeObjectIds, ...target } = input;
  const scopedTarget = { ...target, contract, scope: Object.freeze({ ...input.scope }) };
  return alternativeObjectIds === undefined
    ? Object.freeze(scopedTarget)
    : Object.freeze({ ...scopedTarget, alternativeObjectIds: Object.freeze([...alternativeObjectIds]) });
};

export const isOwnerPermissionAccessTargetMetadataValid = (target: OwnerPermissionAccessTarget): boolean =>
  Schema.is(OwnerPermissionTargetMetadataSchema)(target) &&
  Object.isFrozen(target) &&
  Object.isFrozen(target.scope) &&
  isOwnerPermissionContract(target.contract) &&
  target.contract.schemaVersion === '1' &&
  target.contract.permissions.includes(target.definition) &&
  target.definition.allowedScopeKinds.includes(target.scopeKind) &&
  target.key.length > 0 &&
  target.objectId.length > 0 &&
  target.objectId.length <= 1024 &&
  (target.alternativeObjectIds === undefined ||
    (Object.isFrozen(target.alternativeObjectIds) &&
      target.alternativeObjectIds.every(
        (objectId) => objectId.length > 0 && objectId.length <= 1024 && objectId !== target.objectId,
      ) &&
      new Set(target.alternativeObjectIds).size === target.alternativeObjectIds.length)) &&
  target.transportObjectId.length > 0 &&
  target.contract.targetResourceType.length > 0;

export const isOwnerPermissionAccessTargetValid = (
  target: OwnerPermissionAccessTarget,
  scope: Readonly<{
    readonly legalEntityId?: string;
    readonly tenantId: string;
    readonly trustedStorefrontId?: string;
  }>,
  owningModuleKey?: string,
): boolean =>
  isOwnerPermissionAccessTargetMetadataValid(target) &&
  (owningModuleKey === undefined || target.contract.owningModuleKey === owningModuleKey) &&
  target.scope.tenantId === scope.tenantId &&
  scope.tenantId.length > 0 &&
  (target.scope.kind === 'tenant' ||
    (target.scope.kind === 'legal_entity' &&
      target.scope.legalEntityId.length > 0 &&
      target.scope.legalEntityId === scope.legalEntityId)) &&
  (target.requiredStorefrontId === undefined || target.requiredStorefrontId === scope.trustedStorefrontId);
