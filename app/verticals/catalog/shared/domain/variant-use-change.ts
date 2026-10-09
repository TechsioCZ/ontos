import { Effect, Match, Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';
import type { AttributeDefinition, AttributeValue, UnitConversion } from './attribute-values.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema, ProductRevisionSchema } from './product.ts';
import type { ProductTypeAttributeRule } from './product-type-rules.ts';
import type {
  VariantAxis,
  VariantAxisCandidate,
  VariantAxisDefinitionSnapshot,
  VariantAxisValue,
} from './variant-axes.ts';
import { evaluateVariantAxes, stableParts } from './variant-axes.ts';

/**
 * Explicit, revisioned operation for changing axes, values, or Product membership of an
 * already-used Variant. The operation classifies the real ordered thing; a caller cannot
 * make a material realization identity-preserving by choosing a friendly field name.
 */
export const VariantUseChangeOperationSchema = Schema.Union([
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('SAME_MEANING_RENAME'),
    reason: ProductReasonSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('EVIDENCED_VALUE_CORRECTION'),
    originalDataErrorEvidenceRef: ProductEvidenceReferenceSchema,
    reason: ProductReasonSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('EVIDENCED_MEMBERSHIP_CORRECTION'),
    reason: ProductReasonSchema,
    targetProductRef: ProductRefSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('MEMBERSHIP_TRANSFER'),
    reason: ProductReasonSchema,
    targetProductRef: ProductRefSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('NEW_REALIZATION'),
    reason: ProductReasonSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('AXIS_ADDITION'),
    reason: ProductReasonSchema,
  }),
  Schema.Struct({
    evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
    kind: Schema.Literal('AXIS_REMOVAL'),
    reason: ProductReasonSchema,
  }),
]);
export type VariantUseChangeOperation = typeof VariantUseChangeOperationSchema.Type;

export class VariantUseChangeConflict extends Schema.TaggedError<VariantUseChangeConflict>()(
  'VariantUseChangeConflict',
  {
    code: Schema.Literal('variant_use_change_conflict'),
    conflict: Schema.Literals([
      'NEW_REALIZATION_REQUIRES_NEW_VARIANT',
      'MEMBERSHIP_TRANSFER_REQUIRES_NEW_VARIANT',
      'MEMBERSHIP_CORRECTION_MUST_CHANGE_PRODUCT',
      'CORRECTION_EVIDENCE_REQUIRED',
      'MISSING_AXIS_VALUE',
      'DUPLICATE_COMBINATION',
      'INVALID_VALUE',
      'UNVERIFIABLE_VALUE',
      'UNRECORDED_COMBINATION',
      'WRONG_PRODUCT',
      'RETIRED_PARENT_PRODUCT',
      'RETIRED_PACKAGE_OPTION',
      'OPEN_SELECTION_REVALIDATION_REQUIRED',
    ]),
    reason: Schema.String,
  },
) {}

const conflict = (kind: VariantUseChangeConflict['conflict'], reason: string) =>
  new VariantUseChangeConflict({ code: 'variant_use_change_conflict', conflict: kind, reason });

/** One explicit revisioned decision; the caller records it, never infers it from a field diff. */
export interface VariantUseChangeDecision {
  readonly changeKind: 'AXIS_REVALIDATION' | 'CORRECTED' | 'PARENT_CORRECTION';
  readonly revalidation: 'NOT_REQUIRED' | 'REQUIRED';
}

const preserve = (
  changeKind: VariantUseChangeDecision['changeKind'],
  revalidation: VariantUseChangeDecision['revalidation'],
): VariantUseChangeDecision => ({ changeKind, revalidation });

export interface VariantUseChangeContext {
  readonly currentProductRef: typeof ProductRefSchema.Type;
}

/**
 * Classify a requested change by the real ordered thing. A same-meaning rename or a
 * documented correction preserves Variant identity; a genuine new atomic realization or a
 * transfer to a different business meaning requires a distinct Variant. Material changes
 * request #479 revalidation; the caller's owner-issued evidence remains the authority.
 */
export const decideVariantUseChange = (
  operation: VariantUseChangeOperation,
  context: VariantUseChangeContext,
): Effect.Effect<VariantUseChangeDecision, VariantUseChangeConflict> =>
  Match.value(operation).pipe(
    Match.discriminator('kind')('SAME_MEANING_RENAME', () => Effect.succeed(preserve('CORRECTED', 'NOT_REQUIRED'))),
    Match.discriminator('kind')('EVIDENCED_VALUE_CORRECTION', (change) =>
      change.evidenceRefs.includes(change.originalDataErrorEvidenceRef)
        ? Effect.succeed(preserve('CORRECTED', 'REQUIRED'))
        : Effect.fail(
            conflict('CORRECTION_EVIDENCE_REQUIRED', 'Correction evidence must identify the original data error'),
          ),
    ),
    Match.discriminator('kind')('EVIDENCED_MEMBERSHIP_CORRECTION', (change) =>
      change.targetProductRef.tenantId !== context.currentProductRef.tenantId ||
      change.targetProductRef.resourceId === context.currentProductRef.resourceId
        ? Effect.fail(
            conflict(
              'MEMBERSHIP_CORRECTION_MUST_CHANGE_PRODUCT',
              'An evidenced parent correction must name a different Product in the same Tenant',
            ),
          )
        : Effect.succeed(preserve('PARENT_CORRECTION', 'REQUIRED')),
    ),
    Match.discriminator('kind')('MEMBERSHIP_TRANSFER', () =>
      Effect.fail(
        conflict(
          'MEMBERSHIP_TRANSFER_REQUIRES_NEW_VARIANT',
          'Moving an existing Variant to another business meaning requires a distinct Variant',
        ),
      ),
    ),
    Match.discriminator('kind')('NEW_REALIZATION', () =>
      Effect.fail(
        conflict(
          'NEW_REALIZATION_REQUIRES_NEW_VARIANT',
          'A new atomic realization requires a distinct Variant identity',
        ),
      ),
    ),
    Match.discriminator('kind')('AXIS_ADDITION', () => Effect.succeed(preserve('AXIS_REVALIDATION', 'REQUIRED'))),
    Match.discriminator('kind')('AXIS_REMOVAL', () => Effect.succeed(preserve('AXIS_REVALIDATION', 'REQUIRED'))),
    Match.exhaustive,
  );

export interface VariantAxisChangeRevalidationInput {
  readonly candidates: readonly VariantAxisCandidate[];
  readonly conversions?: readonly UnitConversion[];
  readonly definitions: readonly VariantAxisDefinitionSnapshot[];
  readonly isAllowedValue?: (definition: AttributeDefinition, value: AttributeValue) => boolean | undefined;
  readonly isRecordedCombination?: (
    variant: VariantAxisCandidate['variant'],
    selections: readonly VariantAxisValue[],
  ) => boolean | undefined;
  readonly productRef: VariantAxisCandidate['variant']['productRef'];
  readonly productTypeRules: readonly ProductTypeAttributeRule[];
  readonly proposedAxes: readonly VariantAxis[];
}

const mapAxisIssue = (issue: ReturnType<typeof evaluateVariantAxes>['issues'][number]): VariantUseChangeConflict =>
  Match.value(issue).pipe(
    Match.discriminator('kind')('MISSING_AXIS', () =>
      conflict('MISSING_AXIS_VALUE', 'Every affected Variant needs a documented value for the new axis'),
    ),
    Match.discriminator('kind')('DUPLICATE_COMBINATION', () =>
      conflict('DUPLICATE_COMBINATION', 'The proposed axes would make two Current Variants indistinguishable'),
    ),
    Match.discriminator('kind')('DUPLICATE_VARIANT_RECORD', () =>
      conflict('DUPLICATE_COMBINATION', 'The proposed axes would make two Current Variants indistinguishable'),
    ),
    Match.discriminator('kind')('UNRECORDED_COMBINATION', () =>
      conflict('UNRECORDED_COMBINATION', 'The proposed combination is not an explicitly recorded Variant'),
    ),
    Match.discriminator('kind')('WRONG_PRODUCT', () =>
      conflict('WRONG_PRODUCT', 'A candidate Variant does not belong to the exact Product'),
    ),
    Match.discriminator('kind')('UNVERIFIABLE_VALUE', () =>
      conflict('UNVERIFIABLE_VALUE', 'Allowed values or recorded combinations cannot be verified'),
    ),
    Match.discriminator('kind')('UNVERIFIABLE_COMBINATION', () =>
      conflict('UNVERIFIABLE_VALUE', 'Allowed values or recorded combinations cannot be verified'),
    ),
    Match.orElse(() => conflict('INVALID_VALUE', 'The proposed axis value or combination is not permitted')),
  );

/**
 * Revalidate a proposed axis set against #438/#440 evidence. Candidates are reduced to the
 * proposed axes first, so an axis addition surfaces missing documented values and an axis
 * removal surfaces newly indistinguishable Current Variants. Missing values are never estimated.
 */
export const revalidateVariantAxisChange = (
  input: VariantAxisChangeRevalidationInput,
): Effect.Effect<VariantUseChangeDecision, VariantUseChangeConflict> => {
  const proposedIds = new Set(
    input.proposedAxes.map((axis) =>
      stableParts([axis.attributeDefinitionRef.tenantId, axis.attributeDefinitionRef.resourceId]),
    ),
  );
  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    effectiveAxisValues: candidate.effectiveAxisValues.filter((value) =>
      proposedIds.has(stableParts([value.attributeDefinitionRef.tenantId, value.attributeDefinitionRef.resourceId])),
    ),
  }));
  const result = evaluateVariantAxes({
    axes: input.proposedAxes,
    candidates,
    definitions: input.definitions,
    productRef: input.productRef,
    productTypeRules: input.productTypeRules,
    ...(input.conversions === undefined ? undefined : { conversions: input.conversions }),
    ...(input.isAllowedValue === undefined ? undefined : { isAllowedValue: input.isAllowedValue }),
    ...(input.isRecordedCombination === undefined ? undefined : { isRecordedCombination: input.isRecordedCombination }),
  });
  const [issue] = result.issues;
  return issue === undefined
    ? Effect.succeed(preserve('AXIS_REVALIDATION', 'REQUIRED'))
    : Effect.fail(mapAxisIssue(issue));
};

export interface VariantReactivationRequiredPackageOption {
  readonly lifecycle: 'ACTIVE' | 'RETIRED';
}

export interface VariantReactivationRevalidationInput {
  readonly activeCombinationKeys: readonly string[];
  readonly parentProductLifecycle: 'ACTIVE' | 'DRAFT' | 'RETIRED';
  readonly reactivationCombinationKey: string;
  readonly requiredPackageOptions: readonly VariantReactivationRequiredPackageOption[];
}

/**
 * A reactivated Variant must reproduce its recorded identity and cannot collide with a Current one.
 * A retired parent Product still blocks new Current use, and reactivation alone never restores an
 * individually retired or inactive Package Option.
 */
export const revalidateVariantReactivation = (
  input: VariantReactivationRevalidationInput,
): Effect.Effect<VariantUseChangeDecision, VariantUseChangeConflict> => {
  if (input.parentProductLifecycle === 'RETIRED') {
    return Effect.fail(
      conflict('RETIRED_PARENT_PRODUCT', 'A retired parent Product continues to block new Current use'),
    );
  }
  if (input.requiredPackageOptions.some((option) => option.lifecycle !== 'ACTIVE')) {
    return Effect.fail(
      conflict(
        'RETIRED_PACKAGE_OPTION',
        'Reactivation does not restore an individually retired or inactive Package Option',
      ),
    );
  }
  return input.activeCombinationKeys.some((key) => key === input.reactivationCombinationKey)
    ? Effect.fail(
        conflict('DUPLICATE_COMBINATION', 'Reactivation would collide with an existing Current Variant combination'),
      )
    : Effect.succeed(preserve('CORRECTED', 'REQUIRED'));
};

/** #479 consumes this handoff and performs final Current Catalog Selection revalidation. */
export const VariantSelectionRevalidationRequiredSchema = Schema.Struct({
  affectedVariantRef: VariantRefSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  kind: Schema.Literal('REVALIDATION_REQUIRED'),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  revision: ProductRevisionSchema,
}).check(
  Schema.makeFilter(({ affectedVariantRef, productRef }) =>
    affectedVariantRef.tenantId === productRef.tenantId
      ? undefined
      : 'Revalidation Variant must retain the same Product Tenant',
  ),
);
export type VariantSelectionRevalidationRequired = typeof VariantSelectionRevalidationRequiredSchema.Type;
