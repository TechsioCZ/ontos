import { findPostgresFailure } from '@app/core-runtime';
import type { ActionRuntime, OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { CreateVariantResultSchema } from '../../shared/actions/create-variant.ts';
import type { CreateVariantResult } from '../../shared/actions/create-variant.ts';
import { ProductVariantSchema } from '../../shared/domain/product.ts';
import type { ProductVariant } from '../../shared/domain/product.ts';
import { VariantCombinationKeySchema } from '../../shared/domain/variant-axes.ts';
import { AttributeDefinitionRefSchema } from '../../shared/resources/attribute-definition.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import { manufacturerRelations, productVariantRevisions, productVariants, products } from '../database/schema.ts';
import {
  recoverCatalogActionResult,
  recoverCatalogActionResultVersions,
} from '../api/catalog-action-result-recovery.ts';
import type { CatalogActionRecovery } from '../api/catalog-action-result-recovery.ts';
import type { VariantUseChangeConflict } from '../../shared/domain/variant-use-change.ts';
import type { VariantUseChangePersistence } from './variant-use-change-persistence.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { axisFreeCombinationKey } from './variant-current-basis.ts';
import {
  VariantAxisBasisUnavailable,
  effectiveValueItemKeyHash,
  recordedVariantCombinationKey,
  variantAxisPersistenceForScope,
} from './variant-axis-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type VariantRow = typeof productVariants.$inferSelect;

export class VariantCurrentBasisUnavailable extends Schema.TaggedError<VariantCurrentBasisUnavailable>()(
  'VariantCurrentBasisUnavailable',
  { code: Schema.Literal('variant_current_basis_unavailable'), reason: Schema.String },
) {}
const VariantIdentityConflictSchema = Schema.TaggedStruct('VariantIdentityConflict', {});

interface ChangeEvidence {
  readonly actionInvocationId: string;
  readonly evidenceRefs: readonly string[];
  readonly principalId: string;
  readonly reason: string;
}

export interface CreateVariantPersistenceInput extends ChangeEvidence {
  readonly expectedProductRevision: number;
  readonly productRef: ProductRef;
  readonly variantRef: VariantRef;
}

export interface ChangeVariantPersistenceInput extends ChangeEvidence {
  readonly classification: 'SAME_MEANING' | 'EVIDENCED_CORRECTION' | 'EVIDENCED_PARENT_CORRECTION';
  readonly currentProductRef: ProductRef;
  readonly expectedRevision: number;
  readonly originalDataErrorEvidenceRef?: string | undefined;
  readonly targetProductRef?: ProductRef | undefined;
  readonly variantRef: VariantRef;
}

export interface VariantLifecyclePersistenceInput extends ChangeEvidence {
  readonly expectedRevision: number;
  readonly variantRef: VariantRef;
}

export interface ConfirmVariantCombinationPersistenceInput extends ChangeEvidence {
  readonly expectedAxisRevision: number;
  readonly expectedVariantRevision: number;
  readonly productRef: ProductRef;
  readonly variantRef: VariantRef;
}

/**
 * Typed confirmation outcomes. Duplicate, missing axis, impermissible value, and stale basis
 * stay distinct so a caller can tell a real duplicate from an unverifiable basis (#440 R7).
 * An unavailable basis is raised as {@link VariantCurrentBasisUnavailable}, never as success.
 */
export const ConfirmedVariantCombinationSchema = Schema.TaggedStruct('confirmed', {
  combinationAxisRevision: Schema.Int,
  combinationKey: VariantCombinationKeySchema,
  revision: Schema.Int,
  variant: ProductVariantSchema,
});
export const DuplicateVariantCombinationSchema = Schema.TaggedStruct('duplicate_combination', {});
export const ImpermissibleVariantCombinationSchema = Schema.TaggedStruct('impermissible_value', {
  attributeDefinitionId: AttributeDefinitionRefSchema.fields.resourceId,
});
const InvalidVariantCombinationChangeSchema = Schema.TaggedStruct('invalid_change', {});
const LifecycleVariantCombinationConflictSchema = Schema.TaggedStruct('lifecycle_conflict', {});
export const MissingVariantCombinationAxisSchema = Schema.TaggedStruct('missing_axis', {
  attributeDefinitionId: AttributeDefinitionRefSchema.fields.resourceId,
});
const VariantCombinationNotFoundSchema = Schema.TaggedStruct('not_found', {});
export const VariantCombinationRevisionConflictSchema = Schema.TaggedStruct('revision_conflict', {
  actualRevision: Schema.Int,
});
export const VariantCombinationStaleBasisSchema = Schema.TaggedStruct('stale_basis', {
  actualAxisRevision: Schema.Int,
  expectedAxisRevision: Schema.Int,
});
export const ConfirmVariantCombinationOutcomeSchema = Schema.Union([
  ConfirmedVariantCombinationSchema,
  DuplicateVariantCombinationSchema,
  ImpermissibleVariantCombinationSchema,
  InvalidVariantCombinationChangeSchema,
  LifecycleVariantCombinationConflictSchema,
  MissingVariantCombinationAxisSchema,
  VariantCombinationNotFoundSchema,
  VariantCombinationRevisionConflictSchema,
  VariantCombinationStaleBasisSchema,
]);
type ConfirmVariantCombinationOutcome = typeof ConfirmVariantCombinationOutcomeSchema.Type;

const FailureOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('lifecycle_conflict', {}),
  Schema.TaggedStruct('identity_conflict', {}),
  Schema.TaggedStruct('invalid_change', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Int }),
]);
type FailureOutcome = typeof FailureOutcomeSchema.Type;
/**
 * Reactivation-specific rejection: open Cart selections still reference the Variant, so it may not
 * be re-promoted to Current use until they are explicitly reselected (#441 rule 11 / #479). Kept
 * distinct from `lifecycle_conflict` so the caller can tell a reselection requirement from a
 * retired parent or Package Option.
 */
const SelectionRevalidationRequiredSchema = Schema.TaggedStruct('selection_revalidation_required', {});
const CreatedOutcomeSchema = Schema.TaggedStruct('created', { revision: Schema.Int, variant: ProductVariantSchema });
const ChangedOutcomeSchema = Schema.TaggedStruct('changed', { revision: Schema.Int, variant: ProductVariantSchema });
const RetiredOutcomeSchema = Schema.TaggedStruct('retired', { revision: Schema.Int, variant: ProductVariantSchema });
type SuccessOutcome<Tag extends 'created' | 'changed' | 'retired'> = Extract<
  typeof CreatedOutcomeSchema.Type | typeof ChangedOutcomeSchema.Type | typeof RetiredOutcomeSchema.Type,
  { readonly _tag: Tag }
>;
export interface VariantPersistence {
  readonly change: (
    input: ChangeVariantPersistenceInput,
  ) => Effect.Effect<
    FailureOutcome | SuccessOutcome<'changed'>,
    CatalogPersistenceUnavailable | VariantCurrentBasisUnavailable
  >;
  readonly confirm: (
    input: ConfirmVariantCombinationPersistenceInput,
  ) => Effect.Effect<ConfirmVariantCombinationOutcome, CatalogPersistenceUnavailable | VariantCurrentBasisUnavailable>;
  readonly create: (
    input: CreateVariantPersistenceInput,
  ) => Effect.Effect<FailureOutcome | SuccessOutcome<'created'>, CatalogPersistenceUnavailable>;
  readonly reactivate: (
    input: VariantLifecyclePersistenceInput,
  ) => Effect.Effect<
    FailureOutcome | typeof SelectionRevalidationRequiredSchema.Type | SuccessOutcome<'changed'>,
    CatalogPersistenceUnavailable | VariantCurrentBasisUnavailable
  >;
  readonly recoverCreateVariant: (
    invocationId: string,
  ) => Effect.Effect<CatalogActionRecovery<CreateVariantResult>, never, ActionRuntime>;
  readonly retire: (
    input: VariantLifecyclePersistenceInput,
  ) => Effect.Effect<FailureOutcome | SuccessOutcome<'retired'>, CatalogPersistenceUnavailable>;
}

const unavailable = (cause?: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/** Exact retained Variant form; absence never falls back to the Current Variant. */
export const variantHistoryForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  getRevision: (variantId: string, revision: number) =>
    transaction
      .select()
      .from(productVariantRevisions)
      .where(
        and(
          eq(productVariantRevisions.tenantId, scope.tenantId),
          eq(productVariantRevisions.variantId, variantId),
          eq(productVariantRevisions.revision, revision),
        ),
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? Option.none() : Option.some(rows[0]))),
        Effect.mapError(unavailable),
      ),
});

const basisUnavailable = () =>
  new VariantCurrentBasisUnavailable({
    code: 'variant_current_basis_unavailable',
    reason: 'Catalog cannot verify current effective axes, allowed values, and dependent selections',
  });

const CATALOG_MODULE = 'commerce.catalog';
const VARIANT_RESOURCE = 'commerce.catalog.variant';
const PRODUCT_RESOURCE = 'commerce.catalog.product';
const isRef = (ref: ProductRef | VariantRef, tenantId: string, type: string) =>
  ref.tenantId === tenantId && ref.moduleId === CATALOG_MODULE && ref.resourceType === type;
const validEvidence = (input: ChangeEvidence) =>
  input.reason === input.reason.trim() &&
  input.reason.length > 0 &&
  input.reason.length <= 1000 &&
  input.evidenceRefs.every((ref) => ref === ref.trim() && ref.length > 0 && ref.length <= 1000);

const variant = (row: VariantRow): ProductVariant => ({
  lifecycle:
    row.lifecycleState === 'ACTIVE' || row.lifecycleState === 'RETIRED' ? row.lifecycleState : 'WORK_IN_PROGRESS',
  productRef: {
    moduleId: CATALOG_MODULE,
    resourceId: row.productId,
    resourceType: PRODUCT_RESOURCE,
    tenantId: row.tenantId,
  },
  variantId: row.variantId,
  variantRef: {
    moduleId: CATALOG_MODULE,
    resourceId: row.variantId,
    resourceType: VARIANT_RESOURCE,
    tenantId: row.tenantId,
  },
});

const mapInsertError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Core classifies an opaque PostgreSQL driver cause. expires: 2027-03-31.
  error: unknown,
): typeof VariantIdentityConflictSchema.Type | CatalogPersistenceUnavailable => {
  const uniqueViolation = ['23', '505'].join('');
  const matched = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolation &&
      [
        'product_variants_pkey',
        'catalog_product_variants_scope_id_uk',
        'catalog_product_variants_product_id_variant_id_uk',
      ].includes(constraint ?? ''),
  );
  return Option.isSome(matched) ? { _tag: 'VariantIdentityConflict' } : unavailable(error);
};

const CombinationDuplicateSignalSchema = Schema.TaggedStruct('CombinationDuplicateSignal', {});
const mapCombinationError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Core classifies an opaque PostgreSQL driver cause. expires: 2027-03-31.
  error: unknown,
): typeof CombinationDuplicateSignalSchema.Type | CatalogPersistenceUnavailable => {
  const uniqueViolation = ['23', '505'].join('');
  const matched = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolation && constraint === 'catalog_product_variants_active_combination_uk',
  );
  return Option.isSome(matched) ? { _tag: 'CombinationDuplicateSignal' } : unavailable(error);
};

/**
 * Maps the #441 reactivation assessment's typed conflict to the exact lifecycle outcome. A
 * duplicate combination is an identity conflict; an out-of-allowance value is an invalid change;
 * open Cart selections require explicit reselection; every other conflict is a lifecycle conflict.
 */
const reactivationConflictOutcome = (
  conflict: VariantUseChangeConflict['conflict'],
): 'identity_conflict' | 'invalid_change' | 'lifecycle_conflict' | 'selection_revalidation_required' => {
  if (conflict === 'DUPLICATE_COMBINATION') {
    return 'identity_conflict';
  }
  if (conflict === 'INVALID_VALUE') {
    return 'invalid_change';
  }
  return conflict === 'OPEN_SELECTION_REVALIDATION_REQUIRED' ? 'selection_revalidation_required' : 'lifecycle_conflict';
};

/**
 * The owner service uses only Core's already-scoped transaction; no caller can supply an axis
 * signature. Reactivation additionally consumes the #441 assessment, which itself resolves the
 * Catalog-owned Current facts and the injected Cart open-selection owner contract; without it the
 * reactivation stays typed fail-closed.
 */
export const variantPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  reactivation?: VariantUseChangePersistence,
): VariantPersistence => {
  const { tenantId } = scope;
  const recoverCreateVariant: VariantPersistence['recoverCreateVariant'] = (invocationId) =>
    recoverCatalogActionResultVersions([2, 1], (schemaVersion) =>
      recoverCatalogActionResult(
        transaction,
        scope,
        { actionInvocationId: invocationId, actionKey: 'commerce.catalog.create-variant', schemaVersion },
        {
          decode: Schema.decodeUnknownEffect(CreateVariantResultSchema),
          encode: Schema.encodeEffect(CreateVariantResultSchema),
        },
      ),
    );
  const getVariant = (variantId: string) =>
    transaction
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, variantId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const getProduct = (productId: string) =>
    transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const revision = (row: VariantRow, input: ChangeEvidence, kind: 'CREATED' | 'CORRECTED' | 'LIFECYCLE') =>
    transaction
      .insert(productVariantRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        changeKind: kind,
        combinationAxisRevision: row.combinationAxisRevision,
        combinationKey: row.combinationKey,
        evidenceRefs: [...input.evidenceRefs],
        lifecycleState: row.lifecycleState,
        productId: row.productId,
        reason: input.reason,
        revision: row.currentRevision,
        tenantId,
        variantId: row.variantId,
      })
      .pipe(Effect.mapError(unavailable));

  const create: VariantPersistence['create'] = Effect.fn('VariantPersistence.create')(function* create(input) {
    if (
      !isRef(input.productRef, tenantId, PRODUCT_RESOURCE) ||
      !isRef(input.variantRef, tenantId, VARIANT_RESOURCE) ||
      !validEvidence(input)
    ) {
      return { _tag: 'invalid_change' };
    }
    const [parent] = yield* getProduct(input.productRef.resourceId);
    if (parent === undefined) {
      return { _tag: 'not_found' };
    }
    if (parent.currentRevision !== input.expectedProductRevision) {
      return { _tag: 'revision_conflict', actualRevision: parent.currentRevision };
    }
    if (parent.lifecycleState === 'RETIRED') {
      return { _tag: 'lifecycle_conflict' };
    }
    // The Product row lock serializes this check with Manufacturer Relation mutations.
    // A Product-wide assertion cannot silently acquire another exact form without amended evidence.
    const productManufacturerRelations = yield* transaction
      .select()
      .from(manufacturerRelations)
      .where(and(eq(manufacturerRelations.tenantId, tenantId), eq(manufacturerRelations.productId, parent.productId)))
      .for('update')
      .pipe(Effect.mapError(unavailable));
    const now = DateTime.toDateUtc(yield* DateTime.now);
    if (
      productManufacturerRelations.some(
        (relation) =>
          relation.disposition === 'CONFIRMED' && (relation.effectiveTo === null || relation.effectiveTo > now),
      )
    ) {
      return { _tag: 'identity_conflict' };
    }
    const inserted = yield* transaction
      .insert(productVariants)
      .values({
        createdByActionInvocationId: input.actionInvocationId,
        createdByPrincipalId: input.principalId,
        currentRevision: 1,
        lifecycleState: 'WORK_IN_PROGRESS',
        productId: parent.productId,
        tenantId,
        variantId: input.variantRef.resourceId,
      })
      .returning()
      .pipe(
        Effect.mapError(mapInsertError),
        Effect.catchTag('VariantIdentityConflict', () => Effect.succeed({ _tag: 'identity_conflict' as const })),
      );
    if (!Array.isArray(inserted)) {
      return inserted;
    }
    const [row] = inserted;
    if (row === undefined) {
      return yield* unavailable();
    }
    yield* revision(row, input, 'CREATED');
    return { _tag: 'created', revision: 1, variant: variant(row) };
  });

  const change: VariantPersistence['change'] = Effect.fn('VariantPersistence.change')(function* change(input) {
    if (
      !isRef(input.currentProductRef, tenantId, PRODUCT_RESOURCE) ||
      !isRef(input.variantRef, tenantId, VARIANT_RESOURCE) ||
      !validEvidence(input) ||
      (input.targetProductRef !== undefined && !isRef(input.targetProductRef, tenantId, PRODUCT_RESOURCE))
    ) {
      return { _tag: 'invalid_change' };
    }
    const [row] = yield* getVariant(input.variantRef.resourceId);
    if (row === undefined) {
      return { _tag: 'not_found' };
    }
    if (row.currentRevision !== input.expectedRevision) {
      return { _tag: 'revision_conflict', actualRevision: row.currentRevision };
    }
    if (row.lifecycleState === 'RETIRED') {
      return { _tag: 'lifecycle_conflict' };
    }
    if (row.productId !== input.currentProductRef.resourceId) {
      return { _tag: 'invalid_change' };
    }
    if (
      input.classification === 'EVIDENCED_PARENT_CORRECTION' ||
      (input.targetProductRef !== undefined && input.targetProductRef.resourceId !== row.productId)
    ) {
      return yield* basisUnavailable();
    }
    if (
      input.classification === 'EVIDENCED_CORRECTION' &&
      (input.originalDataErrorEvidenceRef === undefined ||
        !input.evidenceRefs.includes(input.originalDataErrorEvidenceRef))
    ) {
      return { _tag: 'invalid_change' };
    }
    // A same-meaning or evidenced record-correction attestation changes no effective axis,
    // parent, or identity. Material value writes remain in their value-owner Actions.
    const [updated] = yield* transaction
      .update(productVariants)
      .set({ currentRevision: row.currentRevision + 1, updatedAt: DateTime.toDateUtc(yield* DateTime.now) })
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.variantId, row.variantId),
          eq(productVariants.currentRevision, row.currentRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return yield* unavailable();
    }
    yield* revision(updated, input, 'CORRECTED');
    return { _tag: 'changed', revision: updated.currentRevision, variant: variant(updated) };
  });

  const retire: VariantPersistence['retire'] = Effect.fn('VariantPersistence.retire')(function* retire(input) {
    if (!isRef(input.variantRef, tenantId, VARIANT_RESOURCE) || !validEvidence(input)) {
      return { _tag: 'invalid_change' };
    }
    const [row] = yield* getVariant(input.variantRef.resourceId);
    if (row === undefined) {
      return { _tag: 'not_found' };
    }
    if (row.currentRevision !== input.expectedRevision) {
      return { _tag: 'revision_conflict', actualRevision: row.currentRevision };
    }
    if (row.lifecycleState === 'RETIRED') {
      return { _tag: 'lifecycle_conflict' };
    }
    const [updated] = yield* transaction
      .update(productVariants)
      .set({
        combinationAxisRevision: null,
        combinationKey: null,
        currentRevision: row.currentRevision + 1,
        lifecycleState: 'RETIRED',
        updatedAt: DateTime.toDateUtc(yield* DateTime.now),
      })
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.variantId, row.variantId),
          eq(productVariants.currentRevision, row.currentRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return yield* unavailable();
    }
    yield* revision(updated, input, 'LIFECYCLE');
    return { _tag: 'retired', revision: updated.currentRevision, variant: variant(updated) };
  });

  const reactivate: VariantPersistence['reactivate'] = Effect.fn('VariantPersistence.reactivate')(
    function* reactivate(input) {
      if (!isRef(input.variantRef, tenantId, VARIANT_RESOURCE) || !validEvidence(input)) {
        return { _tag: 'invalid_change' };
      }
      const [row] = yield* getVariant(input.variantRef.resourceId);
      if (row === undefined) {
        return { _tag: 'not_found' };
      }
      if (row.currentRevision !== input.expectedRevision) {
        return { _tag: 'revision_conflict', actualRevision: row.currentRevision };
      }
      if (row.lifecycleState !== 'RETIRED') {
        return { _tag: 'lifecycle_conflict' };
      }
      const [parent] = yield* getProduct(row.productId);
      if (parent === undefined) {
        return yield* unavailable();
      }
      if (parent.lifecycleState === 'RETIRED') {
        return { _tag: 'lifecycle_conflict' };
      }
      if (reactivation === undefined) {
        return yield* basisUnavailable();
      }
      const assessed = yield* reactivation
        .assessReactivation({
          productRef: {
            moduleId: CATALOG_MODULE,
            resourceId: row.productId,
            resourceType: PRODUCT_RESOURCE,
            tenantId,
          },
          variantRef: input.variantRef,
        })
        .pipe(
          Effect.map((assessment) => ({ assessment, kind: 'PROVEN' as const })),
          Effect.catchTags({
            // oxlint-disable sonarjs/function-name -- Effect catchTags keys are schema-owned error tags; #441 reactivation integration. expires: 2027-03-31.
            VariantUseChangeBasisUnavailable: () => Effect.fail(basisUnavailable()),
            VariantUseChangeConflict: (failure) =>
              Effect.succeed({ kind: reactivationConflictOutcome(failure.conflict) }),
            // oxlint-enable sonarjs/function-name
          }),
        );
      if (assessed.kind !== 'PROVEN') {
        return { _tag: assessed.kind };
      }
      const { assessment } = assessed;
      const updated = yield* transaction
        .update(productVariants)
        .set({
          combinationAxisRevision: assessment.combinationAxisRevision,
          combinationKey: assessment.combinationKey,
          currentRevision: row.currentRevision + 1,
          lifecycleState: 'ACTIVE',
          updatedAt: DateTime.toDateUtc(yield* DateTime.now),
        })
        .where(
          and(
            eq(productVariants.tenantId, tenantId),
            eq(productVariants.variantId, row.variantId),
            eq(productVariants.currentRevision, row.currentRevision),
          ),
        )
        .returning()
        .pipe(
          Effect.mapError(mapCombinationError),
          Effect.catchTag('CombinationDuplicateSignal', () => Effect.succeed<VariantRow[]>([])),
        );
      const [written] = updated;
      if (written === undefined) {
        return { _tag: 'identity_conflict' };
      }
      yield* revision(written, input, 'LIFECYCLE');
      return { _tag: 'changed', revision: written.currentRevision, variant: variant(written) };
    },
  );
  // oxlint-disable-next-line complexity -- Confirmation enumerates the complete typed outcome set (duplicate, missing axis, impermissible, stale basis, unverifiable) in one owner-local transaction. expires: 2027-03-31.
  const confirm: VariantPersistence['confirm'] = Effect.fn('VariantPersistence.confirm')(function* confirm(input) {
    if (
      !isRef(input.productRef, tenantId, PRODUCT_RESOURCE) ||
      !isRef(input.variantRef, tenantId, VARIANT_RESOURCE) ||
      !Number.isSafeInteger(input.expectedAxisRevision) ||
      input.expectedAxisRevision < 0 ||
      !validEvidence(input)
    ) {
      return { _tag: 'invalid_change' };
    }
    const [parent] = yield* getProduct(input.productRef.resourceId);
    if (parent === undefined) {
      return { _tag: 'not_found' };
    }
    if (parent.lifecycleState === 'RETIRED') {
      return { _tag: 'lifecycle_conflict' };
    }
    const [row] = yield* getVariant(input.variantRef.resourceId);
    if (row === undefined || row.productId !== parent.productId || row.tenantId !== tenantId) {
      return { _tag: 'not_found' };
    }
    if (row.currentRevision !== input.expectedVariantRevision) {
      return { _tag: 'revision_conflict', actualRevision: row.currentRevision };
    }

    const axisReader = variantAxisPersistenceForScope(transaction, scope);
    const mapAxisBasisError = (
      error: CatalogPersistenceUnavailable | VariantAxisBasisUnavailable,
    ): CatalogPersistenceUnavailable | VariantCurrentBasisUnavailable =>
      Schema.is(VariantAxisBasisUnavailable)(error) ? basisUnavailable() : error;
    const axisBasis = <A, R>(
      effect: Effect.Effect<A, CatalogPersistenceUnavailable | VariantAxisBasisUnavailable, R>,
    ) => effect.pipe(Effect.mapError(mapAxisBasisError));
    const current = yield* axisBasis(axisReader.readCurrent(input.productRef));
    if (!Number.isSafeInteger(current.axisRevision) || current.axisRevision < 1) {
      return yield* basisUnavailable();
    }
    if (current.axisRevision !== input.expectedAxisRevision) {
      return {
        _tag: 'stale_basis',
        actualAxisRevision: current.axisRevision,
        expectedAxisRevision: input.expectedAxisRevision,
      };
    }

    let combinationKey: string;
    if (current.axes.length === 0) {
      combinationKey = axisFreeCombinationKey();
    } else {
      const allowed = yield* axisBasis(axisReader.readCurrentAllowedValues(input.productRef, current));
      const allowedByAxis = new Map(allowed.map((item) => [item.attributeDefinitionId, new Set(item.valueKeys)]));
      const values = yield* axisBasis(axisReader.readEffectiveValues(input.productRef, input.variantRef, current));
      const valuesByAxis = new Map(values.map((item) => [item.attributeDefinitionId, item]));
      for (const axis of current.axes) {
        const value = valuesByAxis.get(axis.attributeDefinitionId);
        if (value === undefined || value.source === 'MISSING' || value.items.length === 0) {
          return { _tag: 'missing_axis', attributeDefinitionId: axis.attributeDefinitionId };
        }
        const allowedKeys = allowedByAxis.get(axis.attributeDefinitionId);
        if (allowedKeys === undefined) {
          return yield* basisUnavailable();
        }
        if (value.items.some((item) => !allowedKeys.has(effectiveValueItemKeyHash(item)))) {
          return { _tag: 'impermissible_value', attributeDefinitionId: axis.attributeDefinitionId };
        }
      }
      combinationKey = recordedVariantCombinationKey(values, tenantId);
    }

    const conflicts = yield* transaction
      .select({ variantId: productVariants.variantId })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.productId, parent.productId),
          eq(productVariants.lifecycleState, 'ACTIVE'),
          eq(productVariants.combinationKey, combinationKey),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (conflicts.some((item) => item.variantId !== row.variantId)) {
      return { _tag: 'duplicate_combination' };
    }
    if (
      row.lifecycleState === 'ACTIVE' &&
      row.combinationKey === combinationKey &&
      row.combinationAxisRevision === current.axisRevision
    ) {
      return {
        _tag: 'confirmed',
        combinationAxisRevision: current.axisRevision,
        combinationKey,
        revision: row.currentRevision,
        variant: variant(row),
      };
    }

    const updated = yield* transaction
      .update(productVariants)
      .set({
        combinationAxisRevision: current.axisRevision,
        combinationKey,
        currentRevision: row.currentRevision + 1,
        lifecycleState: 'ACTIVE',
        updatedAt: DateTime.toDateUtc(yield* DateTime.now),
      })
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.variantId, row.variantId),
          eq(productVariants.currentRevision, row.currentRevision),
        ),
      )
      .returning()
      .pipe(
        Effect.mapError(mapCombinationError),
        Effect.catchTag('CombinationDuplicateSignal', () => Effect.succeed<VariantRow[]>([])),
      );
    const [written] = updated;
    if (written === undefined) {
      return { _tag: 'duplicate_combination' };
    }
    yield* revision(written, input, 'LIFECYCLE');
    return {
      _tag: 'confirmed',
      combinationAxisRevision: written.combinationAxisRevision ?? current.axisRevision,
      combinationKey: written.combinationKey ?? combinationKey,
      revision: written.currentRevision,
      variant: variant(written),
    };
  });

  return { change, confirm, create, reactivate, recoverCreateVariant, retire };
};
