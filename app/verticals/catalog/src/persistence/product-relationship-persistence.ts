import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { findPostgresFailure } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  ChangeProductRelationshipPayload,
  CreateProductRelationshipPayload,
  RemoveProductRelationshipPayload,
} from '../../shared/actions/product-relationship-mutations.ts';
import { ProductRelationshipSchema } from '../../shared/domain/product-relationship.ts';
import type { ProductRelationship, ProductRelationshipEndpoint } from '../../shared/domain/product-relationship.ts';
import { productRelationshipRevisions, productRelationships, productVariants, products } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Row = typeof productRelationships.$inferSelect;
interface Evidence {
  readonly actionInvocationId: string;
  readonly principalId: string;
}
interface EffectivePeriodSnapshot {
  effectiveFrom?: string;
  effectiveTo?: string;
}
type CreateProductRelationshipPersistenceInput = CreateProductRelationshipPayload & Evidence;
type ChangeProductRelationshipPersistenceInput = ChangeProductRelationshipPayload & Evidence;
type RemoveProductRelationshipPersistenceInput = RemoveProductRelationshipPayload & Evidence;
const FailureSchema = Schema.Union([
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('duplicate', {}),
  Schema.TaggedStruct('identity_conflict', {}),
  Schema.TaggedStruct('lifecycle_conflict', {}),
  Schema.TaggedStruct('invalid_change', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Int }),
]);
type Failure = typeof FailureSchema.Type;
interface Success<Tag extends 'created' | 'changed' | 'removed'> {
  readonly _tag: Tag;
  readonly relationship: ProductRelationship;
  readonly relationshipId: string;
  readonly revision: number;
}
export interface ProductRelationshipPersistence {
  readonly change: (
    input: ChangeProductRelationshipPersistenceInput,
  ) => Effect.Effect<Failure | Success<'changed'>, CatalogPersistenceUnavailable>;
  readonly create: (
    input: CreateProductRelationshipPersistenceInput,
  ) => Effect.Effect<Failure | Success<'created'>, CatalogPersistenceUnavailable>;
  readonly remove: (
    input: RemoveProductRelationshipPersistenceInput,
  ) => Effect.Effect<Failure | Success<'removed'>, CatalogPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog relationship persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
const PRODUCT = 'commerce.catalog.product';
const VARIANT = 'commerce.catalog.variant';
const MODULE = 'commerce.catalog';
const validEndpoint = (ref: ProductRelationshipEndpoint, tenantId: string) =>
  ref.tenantId === tenantId &&
  ref.moduleId === MODULE &&
  (ref.resourceType === PRODUCT || ref.resourceType === VARIANT);
const validAssertion = (value: ProductRelationship, tenantId: string) =>
  validEndpoint(value.source, tenantId) &&
  validEndpoint(value.target, tenantId) &&
  (value.source.resourceType !== value.target.resourceType || value.source.resourceId !== value.target.resourceId) &&
  (value.effectivePeriod.effectiveFrom === undefined ||
    value.effectivePeriod.effectiveTo === undefined ||
    value.effectivePeriod.effectiveFrom < value.effectivePeriod.effectiveTo) &&
  value.reason === value.reason.trim() &&
  value.reason.length > 0 &&
  value.reason.length <= 1000 &&
  value.evidenceRefs.length > 0 &&
  value.evidenceRefs.every((ref) => ref === ref.trim() && ref.length > 0 && ref.length <= 1000);
const fields = (value: ProductRelationship) => ({
  effectiveFrom:
    value.effectivePeriod.effectiveFrom === undefined
      ? null
      : DateTime.toDateUtc(DateTime.makeUnsafe(value.effectivePeriod.effectiveFrom)),
  effectiveTo:
    value.effectivePeriod.effectiveTo === undefined
      ? null
      : DateTime.toDateUtc(DateTime.makeUnsafe(value.effectivePeriod.effectiveTo)),
  relationshipType: value.type,
  sourceProductId: value.source.resourceType === PRODUCT ? value.source.resourceId : null,
  sourceVariantId: value.source.resourceType === VARIANT ? value.source.resourceId : null,
  targetProductId: value.target.resourceType === PRODUCT ? value.target.resourceId : null,
  targetVariantId: value.target.resourceType === VARIANT ? value.target.resourceId : null,
});
const endpoint = (tenantId: string, productId: string | null, variantId: string | null): ProductRelationshipEndpoint =>
  productId === null
    ? { moduleId: MODULE, resourceId: variantId ?? '', resourceType: VARIANT, tenantId }
    : { moduleId: MODULE, resourceId: productId, resourceType: PRODUCT, tenantId };
const assertion = (row: Row, reason: string, evidenceRefs: readonly string[]) => {
  const effectivePeriod: EffectivePeriodSnapshot = {};
  if (row.effectiveFrom !== null) {
    effectivePeriod.effectiveFrom = row.effectiveFrom.toISOString();
  }
  if (row.effectiveTo !== null) {
    effectivePeriod.effectiveTo = row.effectiveTo.toISOString();
  }
  return Schema.decodeUnknownEffect(ProductRelationshipSchema)({
    effectivePeriod,
    evidenceRefs,
    reason,
    source: endpoint(row.tenantId, row.sourceProductId, row.sourceVariantId),
    target: endpoint(row.tenantId, row.targetProductId, row.targetVariantId),
    type: row.relationshipType,
  }).pipe(Effect.mapError(unavailable));
};
class RelationshipWriteConflict extends Schema.TaggedError<RelationshipWriteConflict>()('RelationshipWriteConflict', {
  conflict: Schema.Literals(['duplicate', 'identity_conflict']),
}) {}
const mapWriteError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Core decodes the opaque driver cause. expires: 2027-03-31.
  error: unknown,
): RelationshipWriteConflict | CatalogPersistenceUnavailable => {
  const uniqueViolation = ['23', '505'].join('');
  const duplicate = findPostgresFailure(
    error,
    ({ code, constraint }) => code === uniqueViolation && constraint === 'catalog_product_relationships_exact_uk',
  );
  if (Option.isSome(duplicate)) {
    return new RelationshipWriteConflict({ conflict: 'duplicate' });
  }
  const identity = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolation &&
      ['product_relationships_pkey', 'catalog_product_relationships_scope_id_uk'].includes(constraint ?? ''),
  );
  return Option.isSome(identity)
    ? new RelationshipWriteConflict({ conflict: 'identity_conflict' })
    : unavailable(error);
};

/** Uses only Core's trusted, already-scoped transaction. */
export const productRelationshipPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ProductRelationshipPersistence => {
  const { tenantId } = scope;
  const get = (id: string) =>
    transaction
      .select()
      .from(productRelationships)
      .where(and(eq(productRelationships.tenantId, tenantId), eq(productRelationships.relationshipId, id)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const exists = (ref: ProductRelationshipEndpoint): Effect.Effect<boolean, CatalogPersistenceUnavailable> =>
    ref.resourceType === PRODUCT
      ? transaction
          .select({ id: products.productId })
          .from(products)
          .where(and(eq(products.tenantId, tenantId), eq(products.productId, ref.resourceId)))
          .limit(1)
          .pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.mapError(unavailable),
          )
      : transaction
          .select({ id: productVariants.variantId })
          .from(productVariants)
          .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, ref.resourceId)))
          .limit(1)
          .pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.mapError(unavailable),
          );
  const revise = (
    row: Row,
    evidence: Evidence,
    value: ProductRelationship,
    changeKind: 'CREATED' | 'CORRECTED' | 'ENDED',
  ) =>
    transaction
      .insert(productRelationshipRevisions)
      .values({
        ...fields(value),
        actingPrincipalId: evidence.principalId,
        actionInvocationId: evidence.actionInvocationId,
        changeKind,
        evidenceRefs: [...value.evidenceRefs],
        reason: value.reason,
        relationshipId: row.relationshipId,
        revision: row.currentRevision,
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
  const create: ProductRelationshipPersistence['create'] = Effect.fn('ProductRelationshipPersistence.create')(
    function* create(input) {
      if (!validAssertion(input.relationship, tenantId)) {
        return { _tag: 'invalid_change' };
      }
      const [source, target] = yield* Effect.all(
        [exists(input.relationship.source), exists(input.relationship.target)],
        { concurrency: 1 },
      );
      if (!source || !target) {
        return { _tag: 'not_found' };
      }
      const inserted = yield* transaction
        .insert(productRelationships)
        .values({ ...fields(input.relationship), currentRevision: 1, relationshipId: input.relationshipId, tenantId })
        .returning()
        .pipe(
          Effect.mapError(mapWriteError),
          Effect.catchTag('RelationshipWriteConflict', ({ conflict }) => Effect.succeed({ _tag: conflict })),
        );
      if (!Array.isArray(inserted)) {
        return inserted;
      }
      const [row] = inserted;
      if (row === undefined) {
        return yield* unavailable();
      }
      yield* revise(row, input, input.relationship, 'CREATED');
      return {
        _tag: 'created',
        relationship: input.relationship,
        relationshipId: row.relationshipId,
        revision: row.currentRevision,
      };
    },
  );
  const change: ProductRelationshipPersistence['change'] = Effect.fn('ProductRelationshipPersistence.change')(
    function* change(input) {
      if (!validAssertion(input.relationship, tenantId)) {
        return { _tag: 'invalid_change' };
      }
      const [row] = yield* get(input.relationshipId);
      if (row === undefined) {
        return { _tag: 'not_found' };
      }
      if (row.currentRevision !== input.expectedRevision) {
        return { _tag: 'revision_conflict', actualRevision: row.currentRevision };
      }
      // New real-world facts require a separate assertion, never an overwrite of this history.
      if (input.classification !== 'EVIDENCED_CORRECTION') {
        return { _tag: 'invalid_change' };
      }
      const [source, target] = yield* Effect.all(
        [exists(input.relationship.source), exists(input.relationship.target)],
        { concurrency: 1 },
      );
      if (!source || !target) {
        return { _tag: 'not_found' };
      }
      const updated = yield* transaction
        .update(productRelationships)
        .set({
          ...fields(input.relationship),
          currentRevision: row.currentRevision + 1,
          updatedAt: DateTime.toDateUtc(yield* DateTime.now),
        })
        .where(
          and(
            eq(productRelationships.tenantId, tenantId),
            eq(productRelationships.relationshipId, row.relationshipId),
            eq(productRelationships.currentRevision, row.currentRevision),
          ),
        )
        .returning()
        .pipe(
          Effect.mapError(mapWriteError),
          Effect.catchTag('RelationshipWriteConflict', ({ conflict }) => Effect.succeed({ _tag: conflict })),
        );
      if (!Array.isArray(updated)) {
        return updated;
      }
      const [changedRow] = updated;
      if (changedRow === undefined) {
        return yield* unavailable();
      }
      yield* revise(changedRow, input, input.relationship, 'CORRECTED');
      return {
        _tag: 'changed',
        relationship: input.relationship,
        relationshipId: changedRow.relationshipId,
        revision: changedRow.currentRevision,
      };
    },
  );
  const remove: ProductRelationshipPersistence['remove'] = Effect.fn('ProductRelationshipPersistence.remove')(
    function* remove(input) {
      const [row] = yield* get(input.relationshipId);
      if (row === undefined) {
        return { _tag: 'not_found' };
      }
      if (row.currentRevision !== input.expectedRevision) {
        return { _tag: 'revision_conflict', actualRevision: row.currentRevision };
      }
      if (row.effectiveTo !== null) {
        return { _tag: 'lifecycle_conflict' };
      }
      if (row.effectiveFrom !== null && input.effectiveTo <= row.effectiveFrom.toISOString()) {
        return { _tag: 'invalid_change' };
      }
      const current = yield* assertion(row, input.reason, input.evidenceRefs);
      const ended: ProductRelationship = {
        ...current,
        effectivePeriod: { ...current.effectivePeriod, effectiveTo: input.effectiveTo },
      };
      if (!validAssertion(ended, tenantId)) {
        return { _tag: 'invalid_change' };
      }
      const updated = yield* transaction
        .update(productRelationships)
        .set({
          currentRevision: row.currentRevision + 1,
          effectiveTo: DateTime.toDateUtc(DateTime.makeUnsafe(input.effectiveTo)),
          updatedAt: DateTime.toDateUtc(yield* DateTime.now),
        })
        .where(
          and(
            eq(productRelationships.tenantId, tenantId),
            eq(productRelationships.relationshipId, row.relationshipId),
            eq(productRelationships.currentRevision, row.currentRevision),
          ),
        )
        .returning()
        .pipe(
          Effect.mapError(mapWriteError),
          Effect.catchTag('RelationshipWriteConflict', ({ conflict }) => Effect.succeed({ _tag: conflict })),
        );
      if (!Array.isArray(updated)) {
        return updated;
      }
      const [endedRow] = updated;
      if (endedRow === undefined) {
        return yield* unavailable();
      }
      yield* revise(endedRow, input, ended, 'ENDED');
      return {
        _tag: 'removed',
        relationship: ended,
        relationshipId: endedRow.relationshipId,
        revision: endedRow.currentRevision,
      };
    },
  );
  return { change, create, remove };
};
