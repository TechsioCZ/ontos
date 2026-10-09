import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { SizeEquivalenceAssertion, SizeUsageList } from '../../shared/domain/attribute-vocabulary.ts';
import { SizeEquivalenceAssertionSchema, SizeUsageListSchema } from '../../shared/domain/attribute-vocabulary.ts';
import {
  controlledAttributeValues,
  productSizeUsageItems,
  productSizeUsageRevisionItems,
  productSizeUsageRevisions,
  productSizeUsageSets,
  products,
  sizeEquivalenceAssertions,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const MODULE = 'commerce.catalog';
const SIZE_TYPE = 'commerce.catalog.controlled-attribute-value';
const validRef = (
  ref: { readonly moduleId: string; readonly resourceType: string; readonly tenantId: string },
  tenantId: string,
  type: string,
) => ref.tenantId === tenantId && ref.moduleId === MODULE && ref.resourceType === type;
const validEvidence = (reason: string, evidenceRefs: readonly string[]) =>
  reason === reason.trim() &&
  reason.length > 0 &&
  reason.length <= 1000 &&
  evidenceRefs.every((ref) => ref === ref.trim() && ref.length > 0 && ref.length <= 1000);
const unavailable = (cause: unknown) => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog Size persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export class SizePersistenceConflict extends Schema.TaggedError<SizePersistenceConflict>()('SizePersistenceConflict', {
  code: Schema.Literal('size_persistence_conflict'),
  conflict: Schema.Literals(['INVALID_INPUT', 'NOT_FOUND', 'REVISION', 'RETIRED', 'ACTION_INVOCATION_ID']),
  reason: Schema.String,
}) {}
const conflict = (kind: SizePersistenceConflict['conflict'], reason: string) =>
  new SizePersistenceConflict({ code: 'size_persistence_conflict', conflict: kind, reason });

interface ReplaceProductSizesInput {
  readonly actionInvocationId: string;
  readonly evidenceRefs: readonly string[];
  /** Zero denotes that no usage list has yet been recorded. */
  readonly expectedRevision: number;
  readonly list: SizeUsageList;
  readonly principalId: string;
  readonly reason: string;
}
interface AssertSizeEquivalenceInput {
  readonly actionInvocationId: string;
  readonly assertion: SizeEquivalenceAssertion;
  readonly principalId: string;
}
export interface SizeUsagePersistence {
  readonly assertEquivalence: (
    input: AssertSizeEquivalenceInput,
  ) => Effect.Effect<string, SizePersistenceConflict | CatalogPersistenceUnavailable>;
  readonly read: (
    productId: string,
  ) => Effect.Effect<
    Option.Option<{ readonly orderedSizeIds: readonly string[]; readonly revision: number }>,
    CatalogPersistenceUnavailable
  >;
  readonly replace: (
    input: ReplaceProductSizesInput,
  ) => Effect.Effect<number, SizePersistenceConflict | CatalogPersistenceUnavailable>;
}

/** Construct only inside Core's tenant-scoped owner transaction. */
export const sizeUsagePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): SizeUsagePersistence => {
  const { tenantId } = scope;
  const replace = Effect.fn('SizeUsagePersistence.replace')(function* replace(input: ReplaceProductSizesInput) {
    const { list } = input;
    if (
      !Schema.is(SizeUsageListSchema)(list) ||
      !validRef(list.productRef, tenantId, 'commerce.catalog.product') ||
      list.orderedSizeRefs.some((ref) => !validRef(ref, tenantId, SIZE_TYPE)) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      input.expectedRevision >= 2_147_483_647 ||
      !validEvidence(input.reason, input.evidenceRefs)
    ) {
      return yield* conflict('INVALID_INPUT', 'Invalid Size usage list or evidence');
    }
    const productId = list.productRef.resourceId;
    const [product] = yield* transaction
      .select({ state: products.lifecycleState })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return yield* conflict('NOT_FOUND', 'Product not found');
    }
    if (product.state === 'RETIRED') {
      return yield* conflict('RETIRED', 'Retired Product cannot change Size usage');
    }
    const [set] = yield* transaction
      .select({ revision: productSizeUsageSets.currentRevision })
      .from(productSizeUsageSets)
      .where(and(eq(productSizeUsageSets.tenantId, tenantId), eq(productSizeUsageSets.productId, productId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if ((set?.revision ?? 0) !== input.expectedRevision) {
      return yield* conflict('REVISION', 'Size usage revision changed');
    }
    const existing =
      set === undefined
        ? []
        : yield* transaction
            .select({ id: productSizeUsageItems.sizeValueId })
            .from(productSizeUsageItems)
            .where(and(eq(productSizeUsageItems.tenantId, tenantId), eq(productSizeUsageItems.productId, productId)))
            .pipe(Effect.mapError(unavailable));
    const existingIds = new Set(existing.map((item) => item.id));
    yield* Effect.forEach(
      list.orderedSizeRefs,
      Effect.fn('SizeUsagePersistence.validateUsageSize')(function* validateSize(ref) {
        const [value] = yield* transaction
          .select({ state: controlledAttributeValues.lifecycleState })
          .from(controlledAttributeValues)
          .where(
            and(
              eq(controlledAttributeValues.tenantId, tenantId),
              eq(controlledAttributeValues.controlledAttributeValueId, ref.resourceId),
              eq(controlledAttributeValues.specialization, 'SIZE'),
            ),
          )
          .for('share')
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (value === undefined) {
          return yield* conflict('NOT_FOUND', 'Size identity not found');
        }
        if (value.state === 'RETIRED' && !existingIds.has(ref.resourceId)) {
          return yield* conflict('RETIRED', 'Retired Size cannot be newly assigned');
        }
        return null;
      }),
      { concurrency: 1, discard: true },
    );
    const revision = input.expectedRevision + 1;
    if (set === undefined) {
      yield* transaction
        .insert(productSizeUsageSets)
        .values({ currentRevision: revision, productId, tenantId })
        .pipe(Effect.mapError(unavailable));
    } else {
      yield* transaction
        .update(productSizeUsageSets)
        .set({ currentRevision: revision, updatedAt: DateTime.toDateUtc(yield* DateTime.now) })
        .where(and(eq(productSizeUsageSets.tenantId, tenantId), eq(productSizeUsageSets.productId, productId)))
        .pipe(Effect.mapError(unavailable));
      yield* transaction
        .delete(productSizeUsageItems)
        .where(and(eq(productSizeUsageItems.tenantId, tenantId), eq(productSizeUsageItems.productId, productId)))
        .pipe(Effect.mapError(unavailable));
    }
    yield* transaction
      .insert(productSizeUsageRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        evidenceRefs: [...input.evidenceRefs],
        productId,
        reason: input.reason,
        revision,
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
    if (list.orderedSizeRefs.length > 0) {
      const rows = list.orderedSizeRefs.map((ref, position) => ({
        position,
        productId,
        sizeSpecialization: 'SIZE',
        sizeValueId: ref.resourceId,
        tenantId,
      }));
      yield* transaction.insert(productSizeUsageItems).values(rows).pipe(Effect.mapError(unavailable));
      yield* transaction
        .insert(productSizeUsageRevisionItems)
        .values(rows.map((row) => ({ ...row, revision })))
        .pipe(Effect.mapError(unavailable));
    }
    return revision;
  });

  const assertEquivalence = Effect.fn('SizeUsagePersistence.assertEquivalence')(function* assertEquivalence(
    input: AssertSizeEquivalenceInput,
  ) {
    const { assertion } = input;
    const fromDate = assertion.validFrom === undefined ? Option.none() : DateTime.make(assertion.validFrom);
    const untilDate = assertion.validUntil === undefined ? Option.none() : DateTime.make(assertion.validUntil);
    if (
      !Schema.is(SizeEquivalenceAssertionSchema)(assertion) ||
      !validRef(assertion.leftSizeRef, tenantId, SIZE_TYPE) ||
      !validRef(assertion.rightSizeRef, tenantId, SIZE_TYPE) ||
      (assertion.validFrom !== undefined && Option.isNone(fromDate)) ||
      (assertion.validUntil !== undefined && Option.isNone(untilDate)) ||
      (Option.isSome(fromDate) &&
        Option.isSome(untilDate) &&
        DateTime.toEpochMillis(untilDate.value) <= DateTime.toEpochMillis(fromDate.value)) ||
      assertion.scope.length > 1000 ||
      assertion.evidence.length > 1000
    ) {
      return yield* conflict('INVALID_INPUT', 'Invalid scoped Size equivalence evidence');
    }
    const from = Option.match(fromDate, { onNone: () => null, onSome: DateTime.toDateUtc });
    const until = Option.match(untilDate, { onNone: () => null, onSome: DateTime.toDateUtc });
    yield* Effect.forEach(
      [assertion.leftSizeRef, assertion.rightSizeRef],
      Effect.fn('SizeUsagePersistence.validateEquivalenceSize')(function* validateSize(ref) {
        const [value] = yield* transaction
          .select({ state: controlledAttributeValues.lifecycleState })
          .from(controlledAttributeValues)
          .where(
            and(
              eq(controlledAttributeValues.tenantId, tenantId),
              eq(controlledAttributeValues.controlledAttributeValueId, ref.resourceId),
              eq(controlledAttributeValues.specialization, 'SIZE'),
            ),
          )
          .for('share')
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (value === undefined) {
          return yield* conflict('NOT_FOUND', 'Size identity not found');
        }
        if (value.state === 'RETIRED') {
          return yield* conflict('RETIRED', 'Retired Size cannot support a new equivalence assertion');
        }
        return null;
      }),
      { concurrency: 1, discard: true },
    );
    const [saved] = yield* transaction
      .insert(sizeEquivalenceAssertions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        evidenceRef: assertion.evidence,
        leftSizeValueId: assertion.leftSizeRef.resourceId,
        rightSizeValueId: assertion.rightSizeRef.resourceId,
        scope: assertion.scope,
        tenantId,
        validFrom: from,
        validUntil: until,
      })
      .returning({ id: sizeEquivalenceAssertions.assertionId })
      .pipe(Effect.mapError(unavailable));
    if (saved === undefined) {
      return yield* unavailable('Size assertion insert returned no identity');
    }
    return saved.id;
  });

  const read = Effect.fn('SizeUsagePersistence.read')(function* read(productId: string) {
    const [set] = yield* transaction
      .select({ revision: productSizeUsageSets.currentRevision })
      .from(productSizeUsageSets)
      .where(and(eq(productSizeUsageSets.tenantId, tenantId), eq(productSizeUsageSets.productId, productId)))
      .limit(1);
    if (set === undefined) {
      return Option.none();
    }
    if (!Number.isSafeInteger(set.revision) || set.revision <= 0) {
      return yield* unavailable('Invalid current Size usage revision');
    }
    const [recorded] = yield* transaction
      .select({ revision: productSizeUsageRevisions.revision })
      .from(productSizeUsageRevisions)
      .where(
        and(
          eq(productSizeUsageRevisions.tenantId, tenantId),
          eq(productSizeUsageRevisions.productId, productId),
          eq(productSizeUsageRevisions.revision, set.revision),
        ),
      )
      .limit(1);
    if (recorded === undefined) {
      return yield* unavailable('Current Size usage revision has no recorded evidence');
    }
    const items = yield* transaction
      .select({ id: productSizeUsageItems.sizeValueId, position: productSizeUsageItems.position })
      .from(productSizeUsageItems)
      .where(and(eq(productSizeUsageItems.tenantId, tenantId), eq(productSizeUsageItems.productId, productId)))
      .orderBy(asc(productSizeUsageItems.position));
    if (items.some((item, index) => item.position !== index)) {
      return yield* unavailable('Current Size usage order is not contiguous');
    }
    return Option.some({ orderedSizeIds: items.map((item) => item.id), revision: set.revision });
  }, Effect.mapError(unavailable));
  return { assertEquivalence, read, replace };
};
