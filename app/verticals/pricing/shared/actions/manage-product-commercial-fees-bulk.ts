import {
  PriceProductTargetOutcomeIdentitySchema,
  PriceProductTargetSnapshotIdSchema,
  priceCatalogTargetsEqual,
} from '@app/pricing-contracts/domain/catalog-price-target';
import {
  PricingCommercialFeeCatalogTargetEvidenceSchema,
  PricingCommercialFeeProductTargetSnapshotSchema,
  PricingCommercialFeeRefSchema,
  PricingCommercialFeeRevisionIdSchema,
  PricingCommercialFeeScheduleAcknowledgementSchema,
} from '@app/pricing-contracts/domain/commercial-fee';
import { Schema } from 'effect';

import { DefineCommercialFeePayloadSchema } from './define-commercial-fee.ts';
import { ReviseCommercialFeePayloadSchema } from './revise-commercial-fee.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

export const ProductCommercialFeeBulkIntentIdSchema = stableReference.pipe(
  Schema.brand('ProductCommercialFeeBulkIntentId'),
  Schema.decodeTo(Schema.String),
);
export const ProductCommercialFeeBulkTargetCorrelationRefSchema = stableReference.pipe(
  Schema.brand('ProductCommercialFeeBulkTargetCorrelationRef'),
  Schema.decodeTo(Schema.String),
);

export const ManageProductCommercialFeeOperationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('DEFINE_COMMERCIAL_FEE'), payload: DefineCommercialFeePayloadSchema }),
  Schema.Struct({ kind: Schema.Literal('REVISE_COMMERCIAL_FEE'), payload: ReviseCommercialFeePayloadSchema }),
]);
export type ManageProductCommercialFeeOperation = typeof ManageProductCommercialFeeOperationSchema.Type;

const sameResourceRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const catalogEvidenceFromOperation = (operation: ManageProductCommercialFeeOperation) => {
  if (operation.kind === 'DEFINE_COMMERCIAL_FEE') {
    return operation.payload.catalogTargetEvidence;
  }
  return operation.payload.intent === 'RETIRE_CURRENT' ? null : operation.payload.catalogTargetEvidence;
};

export const ManageProductCommercialFeesBulkTargetIntentSchema = Schema.Struct({
  catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidenceSchema,
  identity: PriceProductTargetOutcomeIdentitySchema,
  intentId: ProductCommercialFeeBulkIntentIdSchema,
  operation: ManageProductCommercialFeeOperationSchema,
  targetCorrelationRef: ProductCommercialFeeBulkTargetCorrelationRefSchema,
}).check(
  Schema.makeFilter(({ catalogTargetEvidence, identity, operation }) => {
    if (
      catalogTargetEvidence.snapshotId !== identity.snapshotId ||
      catalogTargetEvidence.targetId !== identity.targetId ||
      !sameResourceRef(catalogTargetEvidence.productRef, identity.target.productRef) ||
      !sameResourceRef(catalogTargetEvidence.variantRef, identity.target.variantRef)
    ) {
      return 'Commercial Fee Catalog evidence must bind the exact Product snapshot target identity';
    }
    if (!sameResourceRef(operation.payload.identityKey.target.variantRef, identity.target.variantRef)) {
      return 'Commercial Fee operation identity must bind the exact Product snapshot Variant';
    }
    const operationEvidence = catalogEvidenceFromOperation(operation);
    return operationEvidence === null ||
      (operationEvidence.snapshotId === catalogTargetEvidence.snapshotId &&
        operationEvidence.targetId === catalogTargetEvidence.targetId &&
        operationEvidence.catalogOwnerRevision === catalogTargetEvidence.catalogOwnerRevision &&
        operationEvidence.capturedAt === catalogTargetEvidence.capturedAt &&
        sameResourceRef(operationEvidence.productRef, catalogTargetEvidence.productRef) &&
        sameResourceRef(operationEvidence.variantRef, catalogTargetEvidence.variantRef))
      ? undefined
      : 'Commercial Fee operation must preserve the exact separately supplied Catalog target evidence';
  }),
);
export type ManageProductCommercialFeesBulkTargetIntent = typeof ManageProductCommercialFeesBulkTargetIntentSchema.Type;

const targetIntentsSchema = Schema.Array(ManageProductCommercialFeesBulkTargetIntentSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((intents) =>
    new Set(intents.map(({ identity }) => identity.targetId)).size === intents.length
      ? undefined
      : 'Commercial Fee Product bulk target IDs must be unique',
  ),
  Schema.makeFilter((intents) =>
    new Set(intents.map(({ intentId }) => intentId)).size === intents.length
      ? undefined
      : 'Commercial Fee Product bulk intent IDs must be unique',
  ),
  Schema.makeFilter((intents) =>
    new Set(intents.map(({ targetCorrelationRef }) => targetCorrelationRef)).size === intents.length
      ? undefined
      : 'Commercial Fee Product bulk correlations must be unique per target',
  ),
);

export const ManageProductCommercialFeesBulkPayloadSchema = Schema.Struct({
  snapshot: PricingCommercialFeeProductTargetSnapshotSchema,
  targetIntents: targetIntentsSchema,
}).check(
  Schema.makeFilter(({ snapshot, targetIntents }) => {
    if (snapshot.targets.length !== targetIntents.length) {
      return 'Commercial Fee Product bulk intents must cover the fixed snapshot exactly';
    }
    const intentsByTarget = new Map(targetIntents.map((intent) => [intent.identity.targetId, intent]));
    const mismatched = snapshot.targets.some(({ target, targetId }) => {
      const intent = intentsByTarget.get(targetId);
      return (
        intent === undefined ||
        intent.identity.snapshotId !== snapshot.snapshotId ||
        !priceCatalogTargetsEqual(intent.identity.target, target) ||
        intent.catalogTargetEvidence.capturedAt !== snapshot.capturedAt ||
        intent.catalogTargetEvidence.catalogOwnerRevision !== snapshot.catalogOwnerRevision
      );
    });
    return mismatched
      ? 'Every Commercial Fee Product bulk intent must bind its exact fixed snapshot entry and owner revision'
      : undefined;
  }),
);
export type ManageProductCommercialFeesBulkPayload = typeof ManageProductCommercialFeesBulkPayloadSchema.Type;

const outcomeIdentitySchema = Schema.Struct({
  identity: PriceProductTargetOutcomeIdentitySchema,
  intentId: ProductCommercialFeeBulkIntentIdSchema,
  resolvedBy: Schema.Literals(['OWNER_COMMAND', 'OWNER_RECONCILIATION']),
  targetCorrelationRef: ProductCommercialFeeBulkTargetCorrelationRefSchema,
});

const canonicalRefsSchema = Schema.Struct({
  feeRef: PricingCommercialFeeRefSchema,
  revisionId: Schema.optionalKey(PricingCommercialFeeRevisionIdSchema),
});

export const ManageProductCommercialFeesBulkTargetOutcomeSchema = Schema.Union([
  Schema.Struct({
    ...outcomeIdentitySchema.fields,
    canonical: canonicalRefsSchema,
    outcome: Schema.Literals(['CREATED', 'CHANGED', 'SCHEDULED', 'CORRECTED', 'RETIRED', 'UNCHANGED']),
  }),
  Schema.Struct({
    ...outcomeIdentitySchema.fields,
    acknowledgementChallenge: Schema.optionalKey(PricingCommercialFeeScheduleAcknowledgementSchema),
    outcome: Schema.Literals(['CONFLICT', 'INDETERMINATE', 'REJECTED']),
    reasonCode: stableReference,
  }),
]);
export const ManageProductCommercialFeesBulkResultSchema = Schema.Struct({
  outcomes: Schema.Array(ManageProductCommercialFeesBulkTargetOutcomeSchema),
  snapshotId: PriceProductTargetSnapshotIdSchema,
}).check(
  Schema.makeFilter(({ outcomes, snapshotId }) =>
    outcomes.every(({ identity }) => identity.snapshotId === snapshotId)
      ? undefined
      : 'Every Commercial Fee Product bulk outcome must bind the result snapshot',
  ),
);
export type ManageProductCommercialFeesBulkResult = typeof ManageProductCommercialFeesBulkResultSchema.Type;
