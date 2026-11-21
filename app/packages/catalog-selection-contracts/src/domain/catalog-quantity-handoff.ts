import { Schema } from 'effect';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';

import { CatalogResourceRefSchema } from './catalog-resource-reference.ts';
import { CatalogSelectionValidEvidenceSchema } from './catalog-selection-evidence.ts';
import { CatalogSelectionRevisionSchema, CatalogSelectionSchema } from './catalog-selection.ts';
import { CatalogIdentityScopeSchema } from './identity-scope.ts';

const quantityText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const CatalogQuantityTargetIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogQuantityTargetId'),
  Schema.decodeTo(Schema.String),
);
const CatalogQuantityTenantIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogQuantityTenantId'),
  Schema.decodeTo(Schema.String),
);
const CatalogQuantityUnitIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogQuantityUnitId'),
  Schema.decodeTo(Schema.String),
);
const CatalogQuantityConfigurationKeySchema = quantityText.pipe(
  Schema.brand('CatalogQuantityConfigurationKey'),
  Schema.decodeTo(quantityText),
);
const validQuantitySchema = Schema.Struct({
  changed: Schema.Boolean,
  notice: Schema.Union([Schema.Literal('ROUNDED'), Schema.Null]),
  requested: quantityText,
  resulting: quantityText,
  rounding: Schema.Literals(['UP', 'DOWN', 'HALF_UP']),
  status: Schema.Literal('VALID'),
  step: quantityText,
  targetId: CatalogQuantityTargetIdSchema,
  tenantId: CatalogQuantityTenantIdSchema,
  unitId: CatalogQuantityUnitIdSchema,
  unitRuleRevision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
});
const packageResolutionSchema = Schema.Struct({
  amount: quantityText,
  path: Schema.Array(CatalogSelectionRevisionSchema),
  status: Schema.Literal('VALID'),
  unitRef: CatalogResourceRefSchema,
});
const packageContentRevisionSchema = Schema.Struct({
  amount: quantityText,
  configurationKey: Schema.optionalKey(CatalogQuantityConfigurationKeySchema),
  form: CatalogIdentityScopeSchema,
  lower: Schema.optionalKey(Schema.Struct({ count: quantityText, revision: CatalogSelectionRevisionSchema })),
  reference: CatalogSelectionRevisionSchema,
  setComposition: Schema.optionalKey(CatalogSelectionRevisionSchema),
  unitRef: CatalogResourceRefSchema,
});

const CatalogQuantityHandoffCoreReadySchema = Schema.Struct({
  divisible: Schema.Boolean,
  evidence: CatalogSelectionValidEvidenceSchema,
  packageContent: Schema.optionalKey(packageResolutionSchema),
  packageRevision: Schema.optionalKey(packageContentRevisionSchema),
  quantity: validQuantitySchema,
  selection: CatalogSelectionSchema,
  status: Schema.Literal('READY'),
  unitRef: CatalogResourceRefSchema,
});

const CatalogQuantityHandoffFailureSchema = Schema.Struct({
  reason: Schema.String,
  status: Schema.Literals(['INVALID', 'UNVERIFIABLE', 'STALE']),
});

const ownerReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const CatalogEquivalentSelectionKeySchema = ownerReference.pipe(
  Schema.brand('CatalogEquivalentSelectionKey'),
  Schema.decodeTo(ownerReference),
);
export const CatalogQuantityBasisSchema = Schema.Struct({
  targetDivisibilityRevision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
  targetRef: CatalogResourceRefSchema,
  unitRef: CatalogResourceRefSchema,
  unitRuleRevision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
}).check(
  Schema.makeFilter(({ targetRef, unitRef }) =>
    targetRef.tenantId === unitRef.tenantId ? undefined : 'Quantity target and Unit must share one Tenant',
  ),
);
export type CatalogQuantityBasis = typeof CatalogQuantityBasisSchema.Type;

export const CatalogQuantityHandoffReadySchema = Schema.Struct({
  ...CatalogQuantityHandoffCoreReadySchema.fields,
  completeness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  equivalentSelectionKey: CatalogEquivalentSelectionKeySchema,
  hierarchyRevision: ownerReference,
  ownerRevision: ownerReference,
  quantityBasis: CatalogQuantityBasisSchema,
});
export type CatalogQuantityHandoffReady = typeof CatalogQuantityHandoffReadySchema.Type;

/** Public Commerce handoff: exact Catalog facts and evidence, without a customer policy verdict. */
export const CatalogQuantityHandoffSchema = Schema.Union([
  CatalogQuantityHandoffReadySchema,
  CatalogQuantityHandoffFailureSchema,
]);
export type CatalogQuantityHandoff = typeof CatalogQuantityHandoffSchema.Type;
