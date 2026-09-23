import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, isNull } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import type { CatalogDocumentResourceRef } from '../../shared/domain/catalog-media-assignment.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import {
  catalogMediaAssignmentRevisions,
  catalogMediaAssignments,
  catalogMediaAssignmentSetRevisions,
  catalogMediaAssignmentSets,
  productVariants,
  products,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type SubjectRef = ProductRef | VariantRef;
type AssignmentRow = typeof catalogMediaAssignments.$inferSelect;
type SetRow = typeof catalogMediaAssignmentSets.$inferSelect;
interface Evidence {
  readonly actionInvocationId: string;
  readonly evidenceRefs: readonly string[];
  readonly principalId: string;
  readonly reason: string;
}
interface Mutation extends Evidence {
  readonly assignmentId: string;
  readonly expectedSetRevision: number;
  readonly subjectRef: SubjectRef;
}
interface AssignCatalogMediaPersistenceInput extends Mutation {
  readonly order: number;
  readonly purpose: string;
  readonly resourceKind: 'MEDIA' | 'DOCUMENT';
  readonly resourceRef: CatalogDocumentResourceRef;
}
interface ReorderCatalogMediaPersistenceInput extends Mutation {
  readonly order: number;
}
type RemoveCatalogMediaPersistenceInput = Mutation;
const FailureSchema = Schema.Union([
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('invalid_change', {}),
  Schema.TaggedStruct('identity_conflict', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Int }),
]);
type Failure = typeof FailureSchema.Type;
interface Success<Tag extends string> {
  readonly _tag: Tag;
  readonly assignmentId: string;
  readonly setRevision: number;
}
export type CatalogMediaOutcome = Failure | Success<'assigned'> | Success<'reordered'> | Success<'removed'>;
export interface CatalogMediaPersistence {
  readonly assign: (
    input: AssignCatalogMediaPersistenceInput,
  ) => Effect.Effect<Failure | Success<'assigned'>, CatalogPersistenceUnavailable>;
  readonly remove: (
    input: RemoveCatalogMediaPersistenceInput,
  ) => Effect.Effect<Failure | Success<'removed'>, CatalogPersistenceUnavailable>;
  readonly reorder: (
    input: ReorderCatalogMediaPersistenceInput,
  ) => Effect.Effect<Failure | Success<'reordered'>, CatalogPersistenceUnavailable>;
}

const unavailable = (cause?: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog media persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
const validEvidence = (input: Evidence) =>
  input.reason === input.reason.trim() &&
  input.reason.length > 0 &&
  input.reason.length <= 1000 &&
  input.evidenceRefs.every((ref) => ref === ref.trim() && ref.length > 0 && ref.length <= 1000);
const CATALOG_MODULE = 'commerce.catalog';
const VARIANT_RESOURCE = 'commerce.catalog.variant';
const PRODUCT_RESOURCE = 'commerce.catalog.product';
const validSubject = (ref: SubjectRef, tenantId: string) =>
  ref.tenantId === tenantId &&
  ref.moduleId === CATALOG_MODULE &&
  (ref.resourceType === PRODUCT_RESOURCE || ref.resourceType === VARIANT_RESOURCE);
const validOrder = (order: number) => Number.isSafeInteger(order) && order > 0 && order <= 2_147_483_647;
const revisionValues = (row: AssignmentRow, setRevision: number, input: Evidence) => ({
  actingPrincipalId: input.principalId,
  actionInvocationId: input.actionInvocationId,
  assignmentId: row.assignmentId,
  assignmentSetId: row.assignmentSetId,
  evidenceRefs: [...input.evidenceRefs],
  ownerModuleId: row.ownerModuleId,
  ownerResourceId: row.ownerResourceId,
  ownerResourceType: row.ownerResourceType,
  ownerTenantId: row.ownerTenantId,
  position: row.position,
  purpose: row.purpose,
  reason: input.reason,
  resourceKind: row.resourceKind,
  revision: row.currentRevision,
  setRevision,
  state: row.state,
  tenantId: row.tenantId,
});

/** Owner-local service. Core installs verified tenant scope and owns the surrounding transaction. */
export const catalogMediaPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): CatalogMediaPersistence => {
  const { tenantId } = scope;
  const getSubject = (ref: SubjectRef) =>
    ref.resourceType === PRODUCT_RESOURCE
      ? transaction
          .select({ productId: products.productId })
          .from(products)
          .where(and(eq(products.tenantId, tenantId), eq(products.productId, ref.resourceId)))
          .for('update')
          .limit(1)
          .pipe(Effect.mapError(unavailable))
      : transaction
          .select({ productId: productVariants.productId })
          .from(productVariants)
          .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, ref.resourceId)))
          .for('update')
          .limit(1)
          .pipe(Effect.mapError(unavailable));
  const getSet = (productId: string, ref: SubjectRef) =>
    transaction
      .select()
      .from(catalogMediaAssignmentSets)
      .where(
        and(
          eq(catalogMediaAssignmentSets.tenantId, tenantId),
          eq(catalogMediaAssignmentSets.productId, productId),
          ref.resourceType === PRODUCT_RESOURCE
            ? isNull(catalogMediaAssignmentSets.variantId)
            : eq(catalogMediaAssignmentSets.variantId, ref.resourceId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const getPrevious = (input: Mutation) =>
    transaction
      .select({
        assignmentSetId: catalogMediaAssignmentSetRevisions.assignmentSetId,
        revision: catalogMediaAssignmentSetRevisions.revision,
      })
      .from(catalogMediaAssignmentSetRevisions)
      .where(
        and(
          eq(catalogMediaAssignmentSetRevisions.tenantId, tenantId),
          eq(catalogMediaAssignmentSetRevisions.actionInvocationId, input.actionInvocationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const getRows = (set: SetRow) =>
    transaction
      .select()
      .from(catalogMediaAssignments)
      .where(
        and(
          eq(catalogMediaAssignments.tenantId, tenantId),
          eq(catalogMediaAssignments.assignmentSetId, set.assignmentSetId),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(unavailable));
  const saveRevision = (row: AssignmentRow, revision: number, input: Evidence) =>
    transaction
      .insert(catalogMediaAssignmentRevisions)
      .values(revisionValues(row, revision, input))
      .pipe(Effect.mapError(unavailable));
  const saveSetRevision = (set: SetRow, revision: number, input: Evidence) =>
    transaction
      .insert(catalogMediaAssignmentSetRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        assignmentSetId: set.assignmentSetId,
        evidenceRefs: [...input.evidenceRefs],
        reason: input.reason,
        revision,
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
  const incrementSet = Effect.fn('CatalogMediaPersistence.incrementSet')(function* incrementSet(
    set: SetRow,
    input: Evidence,
  ) {
    const revision = set.currentRevision + 1;
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    yield* transaction
      .update(catalogMediaAssignmentSets)
      .set({ currentRevision: revision, updatedAt })
      .where(
        and(
          eq(catalogMediaAssignmentSets.tenantId, tenantId),
          eq(catalogMediaAssignmentSets.assignmentSetId, set.assignmentSetId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    yield* saveSetRevision(set, revision, input);
    return revision;
  });
  const updateRow = Effect.fn('CatalogMediaPersistence.updateRow')(function* updateRow(
    row: AssignmentRow,
    position: number,
    state: 'ACTIVE' | 'REMOVED',
    revision: number,
    input: Evidence,
  ) {
    const updatedAt = DateTime.toDateUtc(yield* DateTime.now);
    const [updated] = yield* transaction
      .update(catalogMediaAssignments)
      .set({ currentRevision: row.currentRevision + 1, position, state, updatedAt })
      .where(
        and(eq(catalogMediaAssignments.tenantId, tenantId), eq(catalogMediaAssignments.assignmentId, row.assignmentId)),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return yield* unavailable();
    }
    yield* saveRevision(updated, revision, input);
    return updated;
  });
  const reindex = Effect.fn('CatalogMediaPersistence.reindex')(function* reindex(
    rows: readonly AssignmentRow[],
    revision: number,
    input: Evidence,
  ) {
    const changed = rows.filter((row, index) => row.position !== index + 1);
    yield* Effect.forEach(
      changed,
      (row) =>
        transaction
          .update(catalogMediaAssignments)
          .set({ state: 'REMOVED' })
          .where(
            and(
              eq(catalogMediaAssignments.tenantId, tenantId),
              eq(catalogMediaAssignments.assignmentId, row.assignmentId),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      rows,
      (row, index) => (row.position === index + 1 ? Effect.void : updateRow(row, index + 1, 'ACTIVE', revision, input)),
      { concurrency: 1, discard: true },
    );
  });
  const prepare = Effect.fn('CatalogMediaPersistence.prepare')(function* prepare(input: Mutation) {
    if (
      !validEvidence(input) ||
      !validSubject(input.subjectRef, tenantId) ||
      !Number.isSafeInteger(input.expectedSetRevision) ||
      input.expectedSetRevision < 0
    ) {
      return { kind: 'failed', outcome: { _tag: 'invalid_change' } } as const;
    }
    const [subject] = yield* getSubject(input.subjectRef);
    if (subject === undefined) {
      return { kind: 'failed', outcome: { _tag: 'not_found' } } as const;
    }
    const [[set], [previous]] = yield* Effect.all([getSet(subject.productId, input.subjectRef), getPrevious(input)], {
      concurrency: 1,
    });
    if (previous !== undefined) {
      return set !== undefined && previous.assignmentSetId === set.assignmentSetId
        ? ({ kind: 'replayed', setRevision: previous.revision } as const)
        : ({ kind: 'failed', outcome: { _tag: 'identity_conflict' } } as const);
    }
    if ((set?.currentRevision ?? 0) !== input.expectedSetRevision) {
      return {
        kind: 'failed',
        outcome: { _tag: 'revision_conflict', actualRevision: set?.currentRevision ?? 0 },
      } as const;
    }
    return { kind: 'ready', productId: subject.productId, set } as const;
  });
  const assign: CatalogMediaPersistence['assign'] = Effect.fn('CatalogMediaPersistence.assign')(
    function* assign(input) {
      if (
        !validOrder(input.order) ||
        input.purpose !== input.purpose.trim() ||
        input.purpose.length < 1 ||
        input.purpose.length > 100 ||
        input.resourceRef.tenantId !== tenantId ||
        !input.resourceRef.resourceType.startsWith(`${input.resourceRef.moduleId}.`) ||
        input.resourceRef.moduleId.length < 1 ||
        input.resourceRef.moduleId.length > 160 ||
        input.resourceRef.resourceType.length > 160
      ) {
        return { _tag: 'invalid_change' };
      }
      const prepared = yield* prepare(input);
      if (prepared.kind === 'replayed') {
        return { _tag: 'assigned', assignmentId: input.assignmentId, setRevision: prepared.setRevision };
      }
      if (prepared.kind === 'failed') {
        return prepared.outcome;
      }
      let { set } = prepared;
      if (set === undefined) {
        if (input.order !== 1) {
          return { _tag: 'invalid_change' };
        }
        const inserted = yield* transaction
          .insert(catalogMediaAssignmentSets)
          .values({
            currentRevision: 1,
            productId: prepared.productId,
            tenantId,
            variantId: input.subjectRef.resourceType === VARIANT_RESOURCE ? input.subjectRef.resourceId : null,
          })
          .returning()
          .pipe(Effect.mapError(unavailable));
        [set] = inserted;
        if (set === undefined) {
          return yield* unavailable();
        }
        yield* saveSetRevision(set, 1, input);
      }
      const rows = yield* getRows(set);
      if (rows.some((row) => row.assignmentId === input.assignmentId)) {
        return { _tag: 'identity_conflict' };
      }
      const active = rows
        .filter((row) => row.state === 'ACTIVE' && row.resourceKind === input.resourceKind)
        .toSorted((a, b) => a.position - b.position || a.assignmentId.localeCompare(b.assignmentId));
      if (input.order > active.length + 1) {
        return { _tag: 'invalid_change' };
      }
      const revision = prepared.set === undefined ? 1 : yield* incrementSet(set, input);
      // Park shifted rows outside the partial active-position index, then restore final positions.
      const shifted = active.slice(input.order - 1);
      yield* Effect.forEach(
        shifted,
        (row) =>
          transaction
            .update(catalogMediaAssignments)
            .set({ state: 'REMOVED' })
            .where(
              and(
                eq(catalogMediaAssignments.tenantId, tenantId),
                eq(catalogMediaAssignments.assignmentId, row.assignmentId),
              ),
            )
            .pipe(Effect.mapError(unavailable)),
        { concurrency: 1, discard: true },
      );
      const [created] = yield* transaction
        .insert(catalogMediaAssignments)
        .values({
          assignmentId: input.assignmentId,
          assignmentSetId: set.assignmentSetId,
          currentRevision: 1,
          ownerModuleId: input.resourceRef.moduleId,
          ownerResourceId: input.resourceRef.resourceId,
          ownerResourceType: input.resourceRef.resourceType,
          ownerTenantId: input.resourceRef.tenantId,
          position: input.order,
          purpose: input.purpose,
          resourceKind: input.resourceKind,
          state: 'ACTIVE',
          tenantId,
        })
        .returning()
        .pipe(Effect.mapError(unavailable));
      if (created === undefined) {
        return yield* unavailable();
      }
      yield* saveRevision(created, revision, input);
      yield* Effect.forEach(shifted, (row) => updateRow(row, row.position + 1, 'ACTIVE', revision, input), {
        concurrency: 1,
        discard: true,
      });
      return { _tag: 'assigned', assignmentId: created.assignmentId, setRevision: revision };
    },
  );
  const reorder: CatalogMediaPersistence['reorder'] = Effect.fn('CatalogMediaPersistence.reorder')(
    function* reorder(input) {
      if (!validOrder(input.order)) {
        return { _tag: 'invalid_change' };
      }
      const prepared = yield* prepare(input);
      if (prepared.kind === 'replayed') {
        return { _tag: 'reordered', assignmentId: input.assignmentId, setRevision: prepared.setRevision };
      }
      if (prepared.kind === 'failed') {
        return prepared.outcome;
      }
      if (prepared.set === undefined) {
        return { _tag: 'not_found' };
      }
      const rows = yield* getRows(prepared.set);
      const target = rows.find((row) => row.assignmentId === input.assignmentId && row.state === 'ACTIVE');
      if (target === undefined) {
        return { _tag: 'not_found' };
      }
      const active = rows
        .filter((row) => row.state === 'ACTIVE' && row.resourceKind === target.resourceKind)
        .toSorted((a, b) => a.position - b.position || a.assignmentId.localeCompare(b.assignmentId));
      if (input.order > active.length) {
        return { _tag: 'invalid_change' };
      }
      const ordered = active.filter((row) => row.assignmentId !== input.assignmentId);
      ordered.splice(input.order - 1, 0, target);
      const revision = yield* incrementSet(prepared.set, input);
      yield* reindex(ordered, revision, input);
      return { _tag: 'reordered', assignmentId: input.assignmentId, setRevision: revision };
    },
  );
  const remove: CatalogMediaPersistence['remove'] = Effect.fn('CatalogMediaPersistence.remove')(
    function* remove(input) {
      const prepared = yield* prepare(input);
      if (prepared.kind === 'replayed') {
        return { _tag: 'removed', assignmentId: input.assignmentId, setRevision: prepared.setRevision };
      }
      if (prepared.kind === 'failed') {
        return prepared.outcome;
      }
      if (prepared.set === undefined) {
        return { _tag: 'not_found' };
      }
      const rows = yield* getRows(prepared.set);
      const target = rows.find((row) => row.assignmentId === input.assignmentId && row.state === 'ACTIVE');
      if (target === undefined) {
        return { _tag: 'not_found' };
      }
      const active = rows
        .filter(
          (row) =>
            row.state === 'ACTIVE' &&
            row.resourceKind === target.resourceKind &&
            row.assignmentId !== target.assignmentId,
        )
        .toSorted((a, b) => a.position - b.position || a.assignmentId.localeCompare(b.assignmentId));
      const revision = yield* incrementSet(prepared.set, input);
      yield* updateRow(target, target.position, 'REMOVED', revision, input);
      yield* reindex(active, revision, input);
      return { _tag: 'removed', assignmentId: input.assignmentId, setRevision: revision };
    },
  );
  return { assign, remove, reorder };
};
