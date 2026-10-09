import {
  PriceProductTargetOutcomeIdentitySchema,
  PriceProductTargetSnapshotIdSchema,
  PriceProductTargetSnapshotSchema,
  priceCatalogTargetsEqual,
} from '@app/pricing-contracts/domain/catalog-price-target';
import { PriceRevisionIdSchema } from '@app/pricing-contracts/domain/price-definition';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { Schema } from 'effect';

import { DefinePricePayloadSchema } from './define-price.ts';
import { RevisePricePayloadSchema } from './revise-price.ts';

const stableIntentReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

export const ProductPriceBulkIntentIdSchema = stableIntentReference.pipe(
  Schema.brand('ProductPriceBulkIntentId'),
  Schema.decodeTo(Schema.String),
);
export const ProductPriceBulkTargetCorrelationRefSchema = stableIntentReference.pipe(
  Schema.brand('ProductPriceBulkTargetCorrelationRef'),
  Schema.decodeTo(Schema.String),
);

export const ManageProductPriceOperationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('DEFINE_PRICE'), payload: DefinePricePayloadSchema }),
  Schema.Struct({ kind: Schema.Literal('REVISE_PRICE'), payload: RevisePricePayloadSchema }),
]);
export type ManageProductPriceOperation = typeof ManageProductPriceOperationSchema.Type;

export const ManageProductPricesBulkTargetIntentSchema = Schema.Struct({
  identity: PriceProductTargetOutcomeIdentitySchema,
  intentId: ProductPriceBulkIntentIdSchema,
  operation: ManageProductPriceOperationSchema,
  targetCorrelationRef: ProductPriceBulkTargetCorrelationRefSchema,
}).check(
  Schema.makeFilter(({ identity, operation }) =>
    operation.kind !== 'DEFINE_PRICE' ||
    priceCatalogTargetsEqual(identity.target, operation.payload.identityKey.catalogSelection)
      ? undefined
      : 'Define Price bulk intent must bind the exact fixed snapshot target',
  ),
);
export type ManageProductPricesBulkTargetIntent = typeof ManageProductPricesBulkTargetIntentSchema.Type;

const targetIntentsSchema = Schema.Array(ManageProductPricesBulkTargetIntentSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((intents) =>
    new Set(intents.map(({ identity }) => identity.targetId)).size === intents.length
      ? undefined
      : 'Product Price bulk target IDs must be unique',
  ),
  Schema.makeFilter((intents) =>
    new Set(intents.map(({ intentId }) => intentId)).size === intents.length
      ? undefined
      : 'Product Price bulk intent IDs must be unique',
  ),
  Schema.makeFilter((intents) =>
    new Set(intents.map(({ targetCorrelationRef }) => targetCorrelationRef)).size === intents.length
      ? undefined
      : 'Product Price bulk correlations must be unique per target',
  ),
);

export const ManageProductPricesBulkPayloadSchema = Schema.Struct({
  snapshot: PriceProductTargetSnapshotSchema,
  targetIntents: targetIntentsSchema,
}).check(
  Schema.makeFilter(({ snapshot, targetIntents }) => {
    if (snapshot.targets.length !== targetIntents.length) {
      return 'Product Price bulk intents must cover the fixed snapshot exactly';
    }
    const intentsByTarget = new Map(targetIntents.map((intent) => [intent.identity.targetId, intent]));
    const mismatched = snapshot.targets.some(({ target, targetId }) => {
      const intent = intentsByTarget.get(targetId);
      return (
        intent === undefined ||
        intent.identity.snapshotId !== snapshot.snapshotId ||
        !priceCatalogTargetsEqual(intent.identity.target, target)
      );
    });
    return mismatched ? 'Every Product Price bulk intent must bind its exact fixed snapshot entry' : undefined;
  }),
);
export type ManageProductPricesBulkPayload = typeof ManageProductPricesBulkPayloadSchema.Type;

const outcomeIdentitySchema = Schema.Struct({
  identity: PriceProductTargetOutcomeIdentitySchema,
  intentId: ProductPriceBulkIntentIdSchema,
  resolvedBy: Schema.Literals(['OWNER_COMMAND', 'OWNER_RECONCILIATION']),
  targetCorrelationRef: ProductPriceBulkTargetCorrelationRefSchema,
});

const canonicalRefsSchema = Schema.Struct({
  priceRef: PriceRefSchema,
  revisionId: Schema.optionalKey(PriceRevisionIdSchema),
});

export const ManageProductPricesBulkTargetOutcomeSchema = Schema.Union([
  Schema.Struct({
    ...outcomeIdentitySchema.fields,
    canonical: canonicalRefsSchema,
    outcome: Schema.Literals(['APPLIED', 'UNCHANGED']),
  }),
  Schema.Struct({
    ...outcomeIdentitySchema.fields,
    outcome: Schema.Literals(['REJECTED', 'CONFLICT', 'INDETERMINATE']),
    reasonCode: stableIntentReference,
  }),
]);
export const ManageProductPricesBulkResultSchema = Schema.Struct({
  outcomes: Schema.Array(ManageProductPricesBulkTargetOutcomeSchema),
  snapshotId: PriceProductTargetSnapshotIdSchema,
}).check(
  Schema.makeFilter(({ outcomes, snapshotId }) =>
    outcomes.every(({ identity }) => identity.snapshotId === snapshotId)
      ? undefined
      : 'Every Product Price bulk outcome must bind the result snapshot',
  ),
);
export type ManageProductPricesBulkResult = typeof ManageProductPricesBulkResultSchema.Type;
