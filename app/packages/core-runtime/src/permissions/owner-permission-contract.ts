import { Schema } from 'effect';

import { BusinessPermissionDescriptorSchema } from './business-permission.ts';
import type { BusinessPermissionDescriptor } from './business-permission.ts';

/** Owner declarations choose exact business meanings; Core enforces only these neutral scopes. */
export type OwnerPermissionScope =
  | Readonly<{ readonly kind: 'tenant'; readonly tenantId: string }>
  | Readonly<{ readonly kind: 'legal_entity'; readonly legalEntityId: string; readonly tenantId: string }>;

export interface OwnerPermissionContract {
  readonly owningCapability: string;
  readonly permissions: readonly BusinessPermissionDescriptor[];
  readonly schemaVersion: '1';
  readonly targetResourceType: string;
}

export interface OwnerPermissionAccessTarget {
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
  owningCapability: ownerPermissionIdentifier,
  permissions: Schema.Array(BusinessPermissionDescriptorSchema).check(Schema.isMinLength(1)),
  schemaVersion: Schema.Literal('1'),
  targetResourceType: ownerPermissionIdentifier,
});
const OwnerPermissionTargetMetadataSchema = Schema.Struct({
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
});

export const isOwnerPermissionContract = (contract: OwnerPermissionContract): boolean =>
  Schema.is(OwnerPermissionContractSchema)(contract) &&
  Object.isFrozen(contract) &&
  Object.isFrozen(contract.permissions) &&
  contract.permissions.every(
    (definition) => Object.isFrozen(definition) && definition.owningCapability === contract.owningCapability,
  );

export const createOwnerPermissionAccessTarget = (
  contract: OwnerPermissionContract,
  input: Omit<OwnerPermissionAccessTarget, 'contract'>,
): OwnerPermissionAccessTarget => Object.freeze({ ...input, contract, scope: Object.freeze({ ...input.scope }) });

export const isOwnerPermissionAccessTargetMetadataValid = (target: OwnerPermissionAccessTarget): boolean =>
  Schema.is(OwnerPermissionTargetMetadataSchema)(target) &&
  Object.isFrozen(target) &&
  Object.isFrozen(target.scope) &&
  isOwnerPermissionContract(target.contract) &&
  target.contract.schemaVersion === '1' &&
  target.definition.owningCapability === target.contract.owningCapability &&
  target.contract.permissions.includes(target.definition) &&
  target.definition.allowedScopeKinds.includes(target.scopeKind) &&
  target.key.length > 0 &&
  target.objectId.length > 0 &&
  target.transportObjectId.length > 0 &&
  target.contract.targetResourceType.length > 0;

export const isOwnerPermissionAccessTargetValid = (
  target: OwnerPermissionAccessTarget,
  scope: Readonly<{
    readonly legalEntityId?: string;
    readonly tenantId: string;
    readonly trustedStorefrontId?: string;
  }>,
  owningCapability?: string,
): boolean =>
  isOwnerPermissionAccessTargetMetadataValid(target) &&
  (owningCapability === undefined || target.contract.owningCapability === owningCapability) &&
  target.scope.tenantId === scope.tenantId &&
  scope.tenantId.length > 0 &&
  (target.scope.kind === 'tenant' ||
    (target.scope.kind === 'legal_entity' &&
      target.scope.legalEntityId.length > 0 &&
      target.scope.legalEntityId === scope.legalEntityId)) &&
  (target.requiredStorefrontId === undefined || target.requiredStorefrontId === scope.trustedStorefrontId);
