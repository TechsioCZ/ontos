import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { CreatePackageDefinitionPayload } from '../../shared/actions/create-package-definition.ts';
import type { RetirePackageDefinitionPayload } from '../../shared/actions/retire-package-definition.ts';
import type { RevisePackageDefinitionPayload } from '../../shared/actions/revise-package-definition.ts';
import { PackageDefinitionContentInputSchema } from '../../shared/actions/package-definition-contract.ts';
import { PackageDefinitionSelectionRevisionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { PackageDefinitionRefSchema } from '../../shared/resources/package-definition.ts';
import { packageContentRevisions, packageDefinitions, productVariants, products } from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Content = typeof PackageDefinitionContentInputSchema.Type;
type DefinitionRow = typeof packageDefinitions.$inferSelect;
const packageType = 'commerce.catalog.package-definition';
const moduleId = 'commerce.catalog';
const variantType = 'commerce.catalog.variant';
const invalidReferencesReason = 'Package references or evidence are invalid';

/** A revision owns [effectiveAt, next effectiveAt); a future row never wins an earlier as-of read. */
export const resolveEffectiveRevision = (
  revisions: readonly { readonly effectiveAt: Date; readonly revision: number }[],
  at: Date,
): { readonly _tag: 'resolved'; readonly revision: number } | { readonly _tag: 'invalid' } => {
  const atMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(at));
  if (!Number.isFinite(atMillis)) {
    return { _tag: 'invalid' };
  }
  const ordered = revisions.toSorted((left, right) => left.revision - right.revision);
  let effective: number | undefined;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < ordered.length; index += 1) {
    const row = ordered[index];
    const rowMillis = row === undefined ? Number.NaN : DateTime.toEpochMillis(DateTime.makeUnsafe(row.effectiveAt));
    if (row === undefined || row.revision !== index + 1 || !Number.isFinite(rowMillis) || rowMillis <= previousTime) {
      return { _tag: 'invalid' };
    }
    previousTime = rowMillis;
    if (previousTime <= atMillis) {
      effective = row.revision;
    }
  }
  return effective === undefined ? { _tag: 'invalid' } : { _tag: 'resolved', revision: effective };
};

export class PackagePersistenceUnavailable extends Schema.TaggedError<PackagePersistenceUnavailable>()(
  'PackagePersistenceUnavailable',
  { code: Schema.Literal('package_persistence_unavailable'), reason: Schema.String },
) {}

/**
 * Supplied only by Catalog's owner-local Current-basis service, never by a request payload.
 * A true result must prove Unit existence/ownership and conversion, Product/Variant Current
 * parentage, exact lower-revision homogeneity and acyclicity, and Set composition when present.
 * Until that service exists, the optional port is absent and content writes fail closed.
 */
export interface PackageContentBasis {
  readonly verify: (input: {
    readonly content: Content;
    readonly definitionId: string;
    readonly tenantId: string;
  }) => Effect.Effect<boolean, PackagePersistenceUnavailable>;
}

interface Evidence {
  readonly actionInvocationId: string;
  readonly principalId: string;
}
interface CreatePackageInput extends Evidence {
  readonly payload: CreatePackageDefinitionPayload;
}
interface RevisePackageInput extends Evidence {
  readonly payload: RevisePackageDefinitionPayload;
}
interface RetirePackageInput extends Evidence {
  readonly payload: RetirePackageDefinitionPayload;
}

const SuccessFields = {
  contentRevision: PackageDefinitionSelectionRevisionSchema,
  definitionRef: PackageDefinitionRefSchema,
};
const PackageMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('created', SuccessFields),
  Schema.TaggedStruct('revised', SuccessFields),
  Schema.TaggedStruct('retired', SuccessFields),
  Schema.TaggedStruct('invalid', { reason: Schema.String }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('stale', { actualRevision: Schema.Int }),
]);
export type PackageMutationOutcome = typeof PackageMutationOutcomeSchema.Type;

export interface PackagePersistence {
  readonly create: (input: CreatePackageInput) => Effect.Effect<PackageMutationOutcome, PackagePersistenceUnavailable>;
  readonly retire: (input: RetirePackageInput) => Effect.Effect<PackageMutationOutcome, PackagePersistenceUnavailable>;
  readonly revise: (input: RevisePackageInput) => Effect.Effect<PackageMutationOutcome, PackagePersistenceUnavailable>;
}

const unavailable = (cause?: unknown): PackagePersistenceUnavailable => {
  const failure = new PackagePersistenceUnavailable({
    code: 'package_persistence_unavailable',
    reason: 'Authoritative Package Definition basis or persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/** Exact retained Package content, including its pinned lower and Set revisions. */
export const packageHistoryForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  getContentRevision: (definitionId: string, revision: number) =>
    transaction
      .select()
      .from(packageContentRevisions)
      .where(
        and(
          eq(packageContentRevisions.tenantId, scope.tenantId),
          eq(packageContentRevisions.packageDefinitionId, definitionId),
          eq(packageContentRevisions.revision, revision),
        ),
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => (rows[0] === undefined ? Option.none() : Option.some(rows[0]))),
        Effect.mapError(unavailable),
      ),
});

const result = Effect.fn('PackagePersistence.result')(function* result(
  tag: 'created' | 'revised' | 'retired',
  row: DefinitionRow,
) {
  const ref = yield* Schema.decodeEffect(PackageDefinitionRefSchema)({
    moduleId,
    resourceId: row.packageDefinitionId,
    resourceType: packageType,
    tenantId: row.tenantId,
  });
  const contentRevision = yield* Schema.decodeEffect(PackageDefinitionSelectionRevisionSchema)({
    resourceRef: ref,
    revision: row.currentRevision,
  });
  return {
    _tag: tag,
    contentRevision,
    definitionRef: ref,
  };
}, Effect.mapError(unavailable));

const sameRef = (
  ref: { readonly moduleId: string; readonly resourceType: string; readonly tenantId: string },
  tenantId: string,
  type: string,
) => ref.moduleId === 'commerce.catalog' && ref.resourceType === type && ref.tenantId === tenantId;

const validContent = (content: Content, tenantId: string, definitionId: string): boolean =>
  Schema.is(PackageDefinitionContentInputSchema)(content) &&
  sameRef(content.form.productRef, tenantId, 'commerce.catalog.product') &&
  sameRef(content.form.variantRef, tenantId, variantType) &&
  sameRef(content.unitRef, tenantId, 'commerce.catalog.product-unit') &&
  (content.lower === undefined ||
    (sameRef(content.lower.revision.resourceRef, tenantId, packageType) &&
      content.lower.revision.resourceRef.resourceId !== definitionId &&
      content.lower.revision.revisionId === undefined)) &&
  (content.setComposition === undefined ||
    (sameRef(content.setComposition.resourceRef, tenantId, 'commerce.catalog.set-composition') &&
      content.setComposition.revisionId === undefined));

const validEvidence = (
  input: Evidence & { readonly payload: { readonly evidenceRefs: readonly string[]; readonly reason: string } },
) =>
  input.payload.reason.length > 0 &&
  input.payload.reason.length <= 1000 &&
  input.payload.reason === input.payload.reason.trim() &&
  input.payload.evidenceRefs.every((ref) => ref.length > 0 && ref.length <= 1000 && ref === ref.trim());

const validRevisionIntent = (payload: RevisePackageDefinitionPayload): boolean =>
  payload.changeKind === 'physical_change'
    ? payload.priorErrorExplanation === undefined
    : payload.changeKind === 'correction' &&
      payload.priorErrorExplanation !== undefined &&
      payload.priorErrorExplanation.length > 0 &&
      payload.priorErrorExplanation.length <= 1000 &&
      payload.priorErrorExplanation === payload.priorErrorExplanation.trim();

/** Core owns the transaction and its tenant setting; every query also carries the trusted tenant predicate. */
export const packagePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  basis?: PackageContentBasis,
): PackagePersistence => {
  const { tenantId } = scope;
  const getDefinition = (id: string) =>
    transaction
      .select()
      .from(packageDefinitions)
      .where(and(eq(packageDefinitions.tenantId, tenantId), eq(packageDefinitions.packageDefinitionId, id)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const getContent = (id: string, revision: number) =>
    transaction
      .select()
      .from(packageContentRevisions)
      .where(
        and(
          eq(packageContentRevisions.tenantId, tenantId),
          eq(packageContentRevisions.packageDefinitionId, id),
          eq(packageContentRevisions.revision, revision),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const verify = (content: Content, definitionId: string) =>
    basis === undefined ? Effect.fail(unavailable()) : basis.verify({ content, definitionId, tenantId });
  const append = (
    row: DefinitionRow,
    content: Content,
    input: Evidence & { readonly payload: { readonly evidenceRefs: readonly string[]; readonly reason: string } },
    revision = row.currentRevision,
    intent?: { readonly changeKind: 'physical_change' | 'correction'; readonly priorErrorExplanation?: string },
  ) =>
    transaction
      .insert(packageContentRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        amount: content.amount,
        changeKind: intent?.changeKind ?? 'physical_change',
        configurationKey: content.configurationKey ?? null,
        effectiveAt: DateTime.toDateUtc(DateTime.makeUnsafe(content.effectiveAt)),
        evidenceRefs: [...input.payload.evidenceRefs],
        lifecycleState: row.lifecycleState,
        lowerCount: content.lower?.count ?? null,
        lowerPackageDefinitionId: content.lower?.revision.resourceRef.resourceId ?? null,
        lowerRevision: content.lower?.revision.revision ?? null,
        packageDefinitionId: row.packageDefinitionId,
        priorErrorExplanation: intent?.priorErrorExplanation ?? null,
        productId: row.productId,
        reason: input.payload.reason,
        revision,
        setCompositionResourceId: content.setComposition?.resourceRef.resourceId ?? null,
        setCompositionRevision: content.setComposition?.revision ?? null,
        tenantId,
        unitResourceId: content.unitRef.resourceId,
        unitResourceType: content.unitRef.resourceType,
        variantId: row.variantId,
      })
      .pipe(Effect.mapError(unavailable));
  const create: PackagePersistence['create'] = Effect.fn('PackagePersistence.create')(function* create(input) {
    const { content, definitionRef: requestedRef } = input.payload;
    if (
      !sameRef(requestedRef, tenantId, packageType) ||
      !validContent(content, tenantId, requestedRef.resourceId) ||
      !validEvidence(input)
    ) {
      return { _tag: 'invalid', reason: invalidReferencesReason };
    }
    const [product] = yield* transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, content.form.productRef.resourceId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return { _tag: 'not_found' };
    }
    const [variant] = yield* transaction
      .select()
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.productId, content.form.productRef.resourceId),
          eq(productVariants.variantId, content.form.variantRef.resourceId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (variant === undefined) {
      return { _tag: 'not_found' };
    }
    if (product.lifecycleState === 'RETIRED' || variant.lifecycleState === 'RETIRED') {
      return { _tag: 'invalid', reason: 'Retired Product or Variant cannot receive a new Package Definition' };
    }
    if (!(yield* verify(content, requestedRef.resourceId))) {
      return { _tag: 'invalid', reason: 'Package content basis is invalid' };
    }
    const [row] = yield* transaction
      .insert(packageDefinitions)
      .values({
        createdByActionInvocationId: input.actionInvocationId,
        createdByPrincipalId: input.principalId,
        currentRevision: 1,
        lifecycleState: 'DRAFT',
        optionState: 'NOT_SELECTABLE',
        packageDefinitionId: requestedRef.resourceId,
        productId: product.productId,
        tenantId,
        variantId: variant.variantId,
      })
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* unavailable();
    }
    yield* append(row, content, input);
    return yield* result('created', row);
  });
  const revise: PackagePersistence['revise'] = Effect.fn('PackagePersistence.revise')(function* revise(input) {
    const { content, expectedCurrent } = input.payload;
    const id = expectedCurrent.resourceRef.resourceId;
    if (
      !validRevisionIntent(input.payload) ||
      !sameRef(expectedCurrent.resourceRef, tenantId, packageType) ||
      expectedCurrent.revisionId !== undefined ||
      !validContent(content, tenantId, id) ||
      !validEvidence(input)
    ) {
      return { _tag: 'invalid', reason: invalidReferencesReason };
    }
    const [row] = yield* getDefinition(id);
    if (row === undefined) {
      return { _tag: 'not_found' };
    }
    if (row.currentRevision !== expectedCurrent.revision) {
      return { _tag: 'stale', actualRevision: row.currentRevision };
    }
    if (row.lifecycleState === 'RETIRED') {
      return { _tag: 'invalid', reason: 'Retired Package Definition cannot be revised' };
    }
    if (row.productId !== content.form.productRef.resourceId || row.variantId !== content.form.variantRef.resourceId) {
      return { _tag: 'invalid', reason: 'Package Definition cannot change Variant' };
    }
    const [prior] = yield* getContent(id, row.currentRevision);
    if (prior === undefined) {
      return yield* unavailable();
    }
    if (DateTime.toEpochMillis(DateTime.makeUnsafe(content.effectiveAt)) <= prior.effectiveAt.getTime()) {
      return { _tag: 'invalid', reason: 'Successor effectiveness must follow the prior content revision' };
    }
    const [pending] = yield* getContent(id, row.currentRevision + 1);
    if (pending !== undefined) {
      return { _tag: 'invalid', reason: 'A successor content revision is already scheduled' };
    }
    if (!(yield* verify(content, id))) {
      return { _tag: 'invalid', reason: 'Package content basis is invalid' };
    }
    const now = yield* DateTime.now;
    if (DateTime.toEpochMillis(DateTime.makeUnsafe(content.effectiveAt)) > DateTime.toEpochMillis(now)) {
      // Definition row is locked above. Keep its effective Current pointer stable; a second
      // schedule sees the immutable next revision and fails instead of overwriting it.
      yield* append(row, content, input, row.currentRevision + 1, input.payload);
      const ref = yield* Schema.decodeEffect(PackageDefinitionRefSchema)({
        moduleId,
        resourceId: id,
        resourceType: packageType,
        tenantId,
      }).pipe(Effect.mapError(unavailable));
      const contentRevision = yield* Schema.decodeEffect(PackageDefinitionSelectionRevisionSchema)({
        resourceRef: ref,
        revision: row.currentRevision + 1,
      }).pipe(Effect.mapError(unavailable));
      return { _tag: 'revised', contentRevision, definitionRef: ref };
    }
    const [updated] = yield* transaction
      .update(packageDefinitions)
      .set({ currentRevision: row.currentRevision + 1, updatedAt: DateTime.toDateUtc(yield* DateTime.now) })
      .where(
        and(
          eq(packageDefinitions.tenantId, tenantId),
          eq(packageDefinitions.packageDefinitionId, id),
          eq(packageDefinitions.currentRevision, row.currentRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return { _tag: 'stale', actualRevision: row.currentRevision };
    }
    yield* append(updated, content, input, updated.currentRevision, input.payload);
    return yield* result('revised', updated);
  });
  const retire: PackagePersistence['retire'] = Effect.fn('PackagePersistence.retire')(function* retire(input) {
    const { expectedCurrent } = input.payload;
    const id = expectedCurrent.resourceRef.resourceId;
    if (
      !sameRef(expectedCurrent.resourceRef, tenantId, packageType) ||
      expectedCurrent.revisionId !== undefined ||
      !validEvidence(input)
    ) {
      return { _tag: 'invalid', reason: invalidReferencesReason };
    }
    const [row] = yield* getDefinition(id);
    if (row === undefined) {
      return { _tag: 'not_found' };
    }
    if (row.currentRevision !== expectedCurrent.revision) {
      return { _tag: 'stale', actualRevision: row.currentRevision };
    }
    if (row.lifecycleState === 'RETIRED') {
      return { _tag: 'invalid', reason: 'Package Definition is already retired' };
    }
    // An ACTIVE Option is a separate historical role. This service cannot prove #479 open-selection
    // impact or append its role revision, so Definition retirement must not change that role silently.
    if (row.optionState === 'ACTIVE') {
      return yield* unavailable();
    }
    if (basis === undefined) {
      return yield* unavailable();
    }
    const [prior] = yield* getContent(id, row.currentRevision);
    if (prior === undefined) {
      return yield* unavailable();
    }
    const [pending] = yield* getContent(id, row.currentRevision + 1);
    if (pending !== undefined) {
      return { _tag: 'invalid', reason: 'Cannot retire while a successor content revision is scheduled' };
    }
    const retiredAt = DateTime.toDateUtc(yield* DateTime.now);
    if (retiredAt.getTime() <= prior.effectiveAt.getTime()) {
      return { _tag: 'invalid', reason: 'Cannot retire before the latest authored content becomes effective' };
    }
    const [updated] = yield* transaction
      .update(packageDefinitions)
      .set({
        currentRevision: row.currentRevision + 1,
        lifecycleState: 'RETIRED',
        updatedAt: DateTime.toDateUtc(yield* DateTime.now),
      })
      .where(
        and(
          eq(packageDefinitions.tenantId, tenantId),
          eq(packageDefinitions.packageDefinitionId, id),
          eq(packageDefinitions.currentRevision, row.currentRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return { _tag: 'stale', actualRevision: row.currentRevision };
    }
    yield* transaction
      .insert(packageContentRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        amount: prior.amount,
        changeKind: 'physical_change',
        configurationKey: prior.configurationKey,
        effectiveAt: retiredAt,
        evidenceRefs: [...input.payload.evidenceRefs],
        lifecycleState: 'RETIRED',
        lowerCount: prior.lowerCount,
        lowerPackageDefinitionId: prior.lowerPackageDefinitionId,
        lowerRevision: prior.lowerRevision,
        packageDefinitionId: row.packageDefinitionId,
        priorErrorExplanation: null,
        productId: row.productId,
        reason: input.payload.reason,
        revision: updated.currentRevision,
        setCompositionResourceId: prior.setCompositionResourceId,
        setCompositionRevision: prior.setCompositionRevision,
        tenantId,
        unitResourceId: prior.unitResourceId,
        unitResourceType: prior.unitResourceType,
        variantId: row.variantId,
      })
      .pipe(Effect.mapError(unavailable));
    return yield* result('retired', updated);
  });
  return { create, retire, revise };
};
