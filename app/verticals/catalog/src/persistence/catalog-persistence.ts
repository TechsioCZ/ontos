import type { ActionRuntime, OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { findPostgresFailure } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';

/* oxlint-disable anti-slop/no-conditional-empty-object-spread, effect-native/no-sequential-independent-yields, eslint/no-negated-condition, eslint/prefer-destructuring, perfectionist/sort-object-types, perfectionist/sort-objects, typescript/consistent-type-specifier-style -- Drizzle rows and optional SQL columns are decoded at this tenant-scoped persistence boundary; generated insert key order and transactional read ordering are intentional. expires: 2027-03-31. */
import {
  catalogReadiness,
  productActivationBlockers,
  ProductSchema,
  ProductVariantSchema,
  type Product,
  type ProductChangeKind,
  type ProductHistory,
  type ProductLifecycle,
  type ProductRevisionRecord,
  type ProductVariant,
} from '../../shared/domain/product.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import type { CreateProductResult } from '../../shared/actions/create-product.ts';
import { UpdateProductResultSchema } from '../../shared/actions/update-product.ts';
import type { UpdateProductResult } from '../../shared/actions/update-product.ts';
import { ProductRevisionReferenceSchema } from '../../shared/domain/catalog-revision-reference.ts';
import type { CatalogSelectionEvidenceReader } from '../../shared/domain/catalog-open-selection-population.ts';
import type { CatalogSelectionOwnerAssessmentResult } from '../../shared/domain/catalog-selection-owner-contract.ts';
import {
  recoverCatalogActionResult,
  recoverCatalogActionResultVersions,
} from '../api/catalog-action-result-recovery.ts';
import type { CatalogActionRecovery } from '../api/catalog-action-result-recovery.ts';
import { CatalogPersistenceConflict, CatalogPersistenceUnavailable } from './errors.ts';
import { catalogSelectionEvidenceForScope } from './catalog-selection-evidence-service.ts';
import {
  productLifecycleEvents,
  productLocalizedFacts,
  productRevisions,
  productVariantRevisions,
  productVariants,
  products,
} from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const ProductIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CatalogProductId'));

interface CreateProductPersistenceInput {
  readonly actionInvocationId: string;
  readonly description: string | undefined;
  readonly name: string | undefined;
  readonly principalId: string;
  readonly reason: string;
  readonly tenantId: string;
  readonly variantId: string | undefined;
}

interface UpdateProductPersistenceInput {
  readonly actionInvocationId: string;
  readonly activateVariantId: string | undefined;
  readonly description?: string;
  readonly expectedRevision: number;
  readonly name?: string;
  readonly principalId: string;
  readonly productId: string;
  readonly reason: string;
  readonly targetLifecycle: ProductLifecycle | undefined;
  readonly tenantId: string;
}

interface RetireProductPersistenceInput {
  readonly actionInvocationId: string;
  readonly effectiveAt: Date;
  readonly expectedRevision: number;
  readonly principalId: string;
  readonly productId: string;
  readonly reason: string;
  readonly tenantId: string;
}

interface ReactivateProductPersistenceInput {
  readonly actionInvocationId: string;
  readonly expectedRevision: number;
  readonly principalId: string;
  readonly productId: string;
  readonly reason: string;
  readonly tenantId: string;
}

interface CorrectProductPersistenceInput {
  readonly actionInvocationId: string;
  readonly description: string | undefined;
  readonly evidenceRefs: readonly string[];
  readonly expectedRevision: number;
  readonly name: string | undefined;
  readonly principalId: string;
  readonly productId: string;
  readonly reason: string;
  readonly tenantId: string;
  readonly variantId?: string;
}

const CreateProductCreatedSchema = Schema.TaggedStruct('created', {
  product: ProductSchema,
  variantId: ProductVariantSchema.fields.variantId,
});
const CreateProductConflictSchema = Schema.TaggedStruct('conflict', {});
const CreateProductPersistenceOutcomeSchema = Schema.Union([CreateProductCreatedSchema, CreateProductConflictSchema]);
type CreateProductPersistenceOutcome = typeof CreateProductPersistenceOutcomeSchema.Type;

const UpdateProductPersistenceOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('updated', {
    changed: Schema.Boolean,
    product: ProductSchema,
  }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Finite }),
  Schema.TaggedStruct('lifecycle_conflict', { product: ProductSchema }),
  Schema.TaggedStruct('variant_conflict', { product: ProductSchema }),
  Schema.TaggedStruct('not_catalog_ready', {
    product: ProductSchema,
    reasons: Schema.Array(Schema.String),
  }),
]);
type UpdateProductPersistenceOutcome = typeof UpdateProductPersistenceOutcomeSchema.Type;

const RetireProductPersistenceOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('retired', { product: ProductSchema }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Finite }),
  Schema.TaggedStruct('already_retired', { product: ProductSchema }),
]);
type RetireProductPersistenceOutcome = typeof RetireProductPersistenceOutcomeSchema.Type;

const ReactivateProductPersistenceOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('reactivated', { product: ProductSchema }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Finite }),
  Schema.TaggedStruct('lifecycle_conflict', { product: ProductSchema }),
  Schema.TaggedStruct('not_catalog_ready', {
    product: ProductSchema,
    reasons: Schema.Array(Schema.String),
  }),
]);
type ReactivateProductPersistenceOutcome = typeof ReactivateProductPersistenceOutcomeSchema.Type;

const CorrectProductPersistenceOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('corrected', {
    changed: Schema.Boolean,
    product: ProductSchema,
  }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Finite }),
  Schema.TaggedStruct('retired', { product: ProductSchema }),
  Schema.TaggedStruct('variant_conflict', {}),
]);
type CorrectProductPersistenceOutcome = typeof CorrectProductPersistenceOutcomeSchema.Type;

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

const conflict = (conflictKind: CatalogPersistenceConflict['conflict'], reason: string): CatalogPersistenceConflict =>
  new CatalogPersistenceConflict({
    code: 'catalog_persistence_conflict',
    conflict: conflictKind,
    reason,
  });

const uniqueViolationSqlState = ['23', '505'].join('');

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Drizzle driver causes stay opaque and are attached only as non-serialized diagnostics. expires: 2027-03-31.
export const mapCatalogWriteError = (error: unknown): CatalogPersistenceConflict | CatalogPersistenceUnavailable =>
  Option.isSome(
    findPostgresFailure(
      error,
      ({ code, constraint }) =>
        code === uniqueViolationSqlState &&
        (constraint === 'catalog_product_revisions_invocation_uk' ||
          constraint === 'catalog_product_variant_revisions_invocation_uk' ||
          constraint === 'catalog_product_lifecycle_invocation_uk'),
    ),
  )
    ? conflict('ACTION_INVOCATION_ID', 'Action invocation already recorded')
    : unavailable(error);

const productIdentityConstraints = ['products_pkey', 'catalog_products_scope_id_uk'] as const;
const variantIdentityConstraints = [
  'product_variants_pkey',
  'catalog_product_variants_scope_id_uk',
  'catalog_product_variants_product_id_variant_id_uk',
] as const;

export const mapCatalogIdentityWriteError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Driver causes are decoded by Core and retained only as non-serialized diagnostics. expires: 2027-03-31.
  error: unknown,
  identity: 'PRODUCT_ID' | 'VARIANT_ID',
): CatalogPersistenceConflict | CatalogPersistenceUnavailable => {
  const constraints = identity === 'PRODUCT_ID' ? productIdentityConstraints : variantIdentityConstraints;
  return Option.isSome(
    findPostgresFailure(
      error,
      ({ code, constraint }) =>
        code === uniqueViolationSqlState && constraints.some((approved) => approved === constraint),
    ),
  )
    ? conflict(
        identity,
        identity === 'PRODUCT_ID' ? 'Product identity already exists' : 'Variant identity already exists',
      )
    : unavailable(error);
};

const productRef = (tenantId: string, productId: string): ProductRef => ({
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
});

const toLifecycle = (value: string): ProductLifecycle => {
  if (value === 'ACTIVE' || value === 'RETIRED') {
    return value;
  }
  return 'DRAFT';
};

const toVariant = (row: typeof productVariants.$inferSelect): ProductVariant => ({
  lifecycle:
    row.lifecycleState === 'ACTIVE' || row.lifecycleState === 'RETIRED' ? row.lifecycleState : 'WORK_IN_PROGRESS',
  productRef: productRef(row.tenantId, row.productId),
  variantId: row.variantId,
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: row.variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId: row.tenantId,
  },
});

const toProduct = (
  tenantId: string,
  row: typeof products.$inferSelect,
  variants: readonly (typeof productVariants.$inferSelect)[],
  localizedNames: readonly string[],
  selectionEvidence: readonly CatalogSelectionOwnerAssessmentResult[],
): Product => {
  const lifecycle = toLifecycle(row.lifecycleState);
  const candidate = {
    lifecycle,
    ...(row.name === null ? {} : { name: row.name }),
    variants: variants.map(toVariant),
  } as const;
  const readiness = catalogReadiness(candidate, localizedNames, selectionEvidence);
  return {
    catalogReady: readiness.catalogReady,
    createdAt: row.createdAt.toISOString(),
    ...(row.description === null ? {} : { description: row.description }),
    lifecycle,
    ...(row.name === null ? {} : { name: row.name }),
    productRef: productRef(tenantId, row.productId),
    revision: row.currentRevision,
    updatedAt: row.updatedAt.toISOString(),
    variants: candidate.variants,
  };
};

const readProductSelectionEvidence = Effect.fn('CatalogPersistence.readProductSelectionEvidence')(
  function* readProductSelectionEvidence(
    product: Pick<Product, 'variants'>,
    selectionEvidence: CatalogSelectionEvidenceReader | undefined,
  ) {
    if (selectionEvidence === undefined) {
      return [];
    }
    return yield* Effect.forEach(
      product.variants.filter(({ lifecycle }) => lifecycle === 'ACTIVE'),
      ({ productRef: productReference, variantRef: variantReference }) =>
        selectionEvidence
          .assess({
            purpose: 'PURCHASE_ACCEPTANCE',
            selection: { productRef: productReference, variantRef: variantReference },
          })
          .pipe(Effect.map(({ evidence }) => evidence)),
      { concurrency: 1 },
    );
  },
);

const getProductRow = (transaction: ScopedTransaction, tenantId: string, productId: string) =>
  transaction
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
    .limit(1)
    .pipe(Effect.mapError(unavailable));

const getVariants = (transaction: ScopedTransaction, tenantId: string, productId: string) =>
  transaction
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productId)))
    .orderBy(asc(productVariants.createdAt))
    .pipe(Effect.mapError(unavailable));

const getLocalizedNames = (transaction: ScopedTransaction, tenantId: string, productId: string) =>
  transaction
    .select({ name: productLocalizedFacts.name, state: productLocalizedFacts.state })
    .from(productLocalizedFacts)
    .where(and(eq(productLocalizedFacts.tenantId, tenantId), eq(productLocalizedFacts.productId, productId)))
    .pipe(
      Effect.mapError(unavailable),
      Effect.map((rows) => rows.flatMap((row) => (row.state === 'SET' && row.name !== null ? [row.name] : []))),
    );

const loadProduct = Effect.fn('CatalogPersistence.loadProduct')(function* loadProduct(
  transaction: ScopedTransaction,
  tenantId: string,
  productId: string,
  selectionEvidence: CatalogSelectionEvidenceReader | undefined,
) {
  const [row] = yield* getProductRow(transaction, tenantId, productId);
  if (row === undefined) {
    return Option.none<Product>();
  }
  const variants = yield* getVariants(transaction, tenantId, productId);
  const localizedNames = yield* getLocalizedNames(transaction, tenantId, productId);
  const candidate = { variants: variants.map(toVariant) };
  const evidence = yield* readProductSelectionEvidence(candidate, selectionEvidence);
  return Option.some(toProduct(tenantId, row, variants, localizedNames, evidence));
});

const insertRevision = (
  transaction: ScopedTransaction,
  input: {
    readonly actionInvocationId: string;
    readonly actingPrincipalId: string;
    readonly changeKind: ProductChangeKind;
    readonly description: string | undefined;
    readonly evidenceRefs: readonly string[];
    readonly lifecycle: ProductLifecycle;
    readonly name: string | undefined;
    readonly productId: string;
    readonly reason: string;
    readonly revision: number;
    readonly tenantId: string;
  },
) =>
  transaction
    .insert(productRevisions)
    .values({
      actionInvocationId: input.actionInvocationId,
      actingPrincipalId: input.actingPrincipalId,
      changeKind: input.changeKind,
      description: input.description ?? null,
      evidenceRefs: [...input.evidenceRefs],
      lifecycleState: input.lifecycle,
      name: input.name ?? null,
      productId: input.productId,
      reason: input.reason,
      revision: input.revision,
      tenantId: input.tenantId,
    })
    .pipe(Effect.mapError(mapCatalogWriteError));

const insertLifecycleEvent = (
  transaction: ScopedTransaction,
  input: {
    readonly actionInvocationId: string;
    readonly actingPrincipalId: string;
    readonly effectiveAt: Date;
    readonly event: 'ACTIVATED' | 'RETIRED';
    readonly productId: string;
    readonly reason: string;
    readonly tenantId: string;
  },
) =>
  transaction
    .insert(productLifecycleEvents)
    .values({
      actionInvocationId: input.actionInvocationId,
      actingPrincipalId: input.actingPrincipalId,
      effectiveAt: input.effectiveAt,
      event: input.event,
      productId: input.productId,
      reason: input.reason,
      tenantId: input.tenantId,
    })
    .pipe(Effect.mapError(mapCatalogWriteError));

export interface CatalogPersistence {
  readonly correct: (
    input: CorrectProductPersistenceInput,
  ) => Effect.Effect<CorrectProductPersistenceOutcome, CatalogPersistenceConflict | CatalogPersistenceUnavailable>;
  readonly create: (
    input: CreateProductPersistenceInput,
  ) => Effect.Effect<CreateProductPersistenceOutcome, CatalogPersistenceConflict | CatalogPersistenceUnavailable>;
  readonly getCreatedByInvocation: (
    invocationId: string,
    principalId: string,
  ) => Effect.Effect<Option.Option<CreateProductResult>, CatalogPersistenceUnavailable>;
  readonly getCurrent: (productId: string) => Effect.Effect<Option.Option<Product>, CatalogPersistenceUnavailable>;
  readonly getHistory: (
    productId: string,
  ) => Effect.Effect<Option.Option<ProductHistory>, CatalogPersistenceUnavailable>;
  readonly reactivate: (
    input: ReactivateProductPersistenceInput,
  ) => Effect.Effect<ReactivateProductPersistenceOutcome, CatalogPersistenceConflict | CatalogPersistenceUnavailable>;
  readonly recoverCreateProduct: (
    invocationId: string,
  ) => Effect.Effect<CatalogActionRecovery<CreateProductResult>, never, ActionRuntime>;
  readonly recoverUpdateProduct: (
    invocationId: string,
  ) => Effect.Effect<CatalogActionRecovery<UpdateProductResult>, never, ActionRuntime>;
  readonly retire: (
    input: RetireProductPersistenceInput,
  ) => Effect.Effect<RetireProductPersistenceOutcome, CatalogPersistenceConflict | CatalogPersistenceUnavailable>;
  readonly update: (
    input: UpdateProductPersistenceInput,
  ) => Effect.Effect<UpdateProductPersistenceOutcome, CatalogPersistenceConflict | CatalogPersistenceUnavailable>;
}

export const catalogPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  selectionEvidence?: CatalogSelectionEvidenceReader,
): Effect.Effect<CatalogPersistence> => {
  const tenantId = scope.tenantId;

  const getCreatedByInvocation: CatalogPersistence['getCreatedByInvocation'] = Effect.fn(
    'CatalogPersistence.getCreatedByInvocation',
  )(function* getCreatedByInvocation(invocationId, principalId) {
    const [created] = yield* transaction
      .select()
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.createdByActionInvocationId, invocationId),
          eq(products.createdByPrincipalId, principalId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (created === undefined) {
      return Option.none<CreateProductResult>();
    }
    const [revision] = yield* transaction
      .select()
      .from(productRevisions)
      .where(
        and(
          eq(productRevisions.tenantId, tenantId),
          eq(productRevisions.productId, created.productId),
          eq(productRevisions.actionInvocationId, invocationId),
          eq(productRevisions.revision, 1),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const [variant] = yield* transaction
      .select()
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.productId, created.productId),
          eq(productVariants.createdByActionInvocationId, invocationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (revision?.changeKind !== 'CREATED' || variant === undefined) {
      return yield* unavailable();
    }
    const initialVariant = toVariant({ ...variant, lifecycleState: 'WORK_IN_PROGRESS' });
    const product = {
      catalogReady: false,
      createdAt: created.createdAt.toISOString(),
      ...(revision.description === null ? {} : { description: revision.description }),
      lifecycle: 'DRAFT' as const,
      ...(revision.name === null ? {} : { name: revision.name }),
      productRef: productRef(tenantId, created.productId),
      revision: 1,
      updatedAt: created.createdAt.toISOString(),
      variants: [initialVariant],
    };
    const result = yield* Schema.decodeEffect(CreateProductResultSchema)({
      product,
      variantId: variant.variantId,
    }).pipe(Effect.mapError(unavailable));
    return Option.some(result);
  });

  const recoverCreateProduct: CatalogPersistence['recoverCreateProduct'] = Effect.fn(
    'CatalogPersistence.recoverCreateProduct',
  )(function* recoverCreateProduct(invocationId) {
    return yield* recoverCatalogActionResultVersions([2, 1], (schemaVersion) =>
      recoverCatalogActionResult(
        transaction,
        scope,
        { actionInvocationId: invocationId, actionKey: 'commerce.catalog.create-product', schemaVersion },
        {
          decode: Schema.decodeUnknownEffect(CreateProductResultSchema),
          encode: Schema.encodeEffect(CreateProductResultSchema),
        },
      ),
    );
  });

  const recoverUpdateProduct: CatalogPersistence['recoverUpdateProduct'] = (invocationId) =>
    recoverCatalogActionResult(
      transaction,
      scope,
      { actionInvocationId: invocationId, actionKey: 'commerce.catalog.update-product', schemaVersion: 1 },
      {
        decode: Schema.decodeUnknownEffect(UpdateProductResultSchema),
        encode: Schema.encodeEffect(UpdateProductResultSchema),
      },
    );

  const getCurrent: CatalogPersistence['getCurrent'] = Effect.fn('CatalogPersistence.getCurrent')(
    function* getCurrent(productId) {
      const parsedProductId = Schema.decodeOption(ProductIdSchema)(productId);
      if (Option.isNone(parsedProductId)) {
        return Option.none<Product>();
      }
      return yield* loadProduct(transaction, tenantId, parsedProductId.value, selectionEvidence);
    },
  );

  const create: CatalogPersistence['create'] = Effect.fn('CatalogPersistence.create')(function* create(input) {
    const productId = randomUUID();
    const variantId = input.variantId ?? randomUUID();
    yield* transaction
      .insert(products)
      .values({
        createdByActionInvocationId: input.actionInvocationId,
        createdByPrincipalId: input.principalId,
        description: input.description ?? null,
        lifecycleState: 'DRAFT',
        name: input.name ?? null,
        productId,
        tenantId,
      })
      .pipe(Effect.mapError((error) => mapCatalogIdentityWriteError(error, 'PRODUCT_ID')));
    yield* transaction
      .insert(productVariants)
      .values({
        createdByActionInvocationId: input.actionInvocationId,
        createdByPrincipalId: input.principalId,
        lifecycleState: 'WORK_IN_PROGRESS',
        productId,
        tenantId,
        variantId,
      })
      .pipe(Effect.mapError((error) => mapCatalogIdentityWriteError(error, 'VARIANT_ID')));
    yield* transaction
      .insert(productVariantRevisions)
      .values({
        actionInvocationId: input.actionInvocationId,
        actingPrincipalId: input.principalId,
        changeKind: 'CREATED',
        combinationAxisRevision: null,
        combinationKey: null,
        evidenceRefs: [],
        lifecycleState: 'WORK_IN_PROGRESS',
        productId,
        reason: input.reason,
        revision: 1,
        tenantId,
        variantId,
      })
      .pipe(Effect.mapError(mapCatalogWriteError));
    yield* insertRevision(transaction, {
      actionInvocationId: input.actionInvocationId,
      actingPrincipalId: input.principalId,
      changeKind: 'CREATED',
      description: input.description,
      evidenceRefs: [],
      lifecycle: 'DRAFT',
      name: input.name,
      productId,
      reason: input.reason,
      revision: 1,
      tenantId,
    });
    const product = yield* loadProduct(transaction, tenantId, productId, selectionEvidence);
    if (Option.isNone(product)) {
      return yield* unavailable();
    }
    return { _tag: 'created' as const, product: product.value, variantId };
  });

  // oxlint-disable-next-line complexity -- Lifecycle and optimistic-concurrency branches are the complete Product update state machine. expires: 2027-03-31.
  const update: CatalogPersistence['update'] = Effect.fn('CatalogPersistence.update')(function* update(input) {
    const current = yield* loadProduct(transaction, tenantId, input.productId, selectionEvidence);
    if (Option.isNone(current)) {
      return { _tag: 'not_found' as const };
    }
    const existing = current.value;
    if (existing.revision !== input.expectedRevision) {
      return { _tag: 'revision_conflict' as const, actualRevision: existing.revision };
    }
    if (existing.lifecycle === 'RETIRED') {
      return { _tag: 'lifecycle_conflict' as const, product: existing };
    }
    const lifecycle = input.targetLifecycle ?? existing.lifecycle;
    if (lifecycle === 'RETIRED') {
      return { _tag: 'lifecycle_conflict' as const, product: existing };
    }
    const activatingVariant =
      input.activateVariantId === undefined
        ? undefined
        : existing.variants.find((variant) => variant.variantId === input.activateVariantId);
    if (
      input.activateVariantId !== undefined &&
      (activatingVariant === undefined || activatingVariant.lifecycle === 'RETIRED')
    ) {
      return { _tag: 'variant_conflict' as const, product: existing };
    }
    if (activatingVariant?.lifecycle === 'WORK_IN_PROGRESS') {
      // Product updates have no authoritative effective-axis/value proof or canonical combination
      // signature. An ACTIVE row requires both fields; never promote a draft by lifecycle alone.
      return yield* unavailable();
    }
    const candidate = {
      lifecycle,
      variants: existing.variants,
    } as const;
    if (lifecycle === 'ACTIVE') {
      const localizedNames = yield* getLocalizedNames(transaction, tenantId, input.productId);
      const blockers = productActivationBlockers(candidate, localizedNames);
      if (blockers.length > 0) {
        return { _tag: 'not_catalog_ready' as const, product: existing, reasons: blockers };
      }
    }
    const changed = input.name !== undefined || input.description !== undefined || lifecycle !== existing.lifecycle;
    if (!changed) {
      return { _tag: 'updated' as const, changed: false, product: existing };
    }
    const revision = existing.revision + 1;
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const [updated] = yield* transaction
      .update(products)
      .set({
        ...(input.description === undefined ? {} : { description: input.description }),
        lifecycleState: lifecycle,
        currentRevision: revision,
        ...(input.name === undefined ? {} : { name: input.name }),
        retiredEffectiveAt: null,
        retiredReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(products.productId, input.productId),
          eq(products.tenantId, tenantId),
          eq(products.currentRevision, input.expectedRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      const [latest] = yield* getProductRow(transaction, tenantId, input.productId);
      return {
        _tag: 'revision_conflict' as const,
        actualRevision: latest?.currentRevision ?? input.expectedRevision,
      };
    }
    yield* insertRevision(transaction, {
      actionInvocationId: input.actionInvocationId,
      actingPrincipalId: input.principalId,
      changeKind: lifecycle !== existing.lifecycle ? 'LIFECYCLE' : 'UPDATED',
      description: input.description ?? existing.description,
      evidenceRefs: [],
      lifecycle,
      name: input.name ?? existing.name,
      productId: input.productId,
      reason: input.reason,
      revision,
      tenantId,
    });
    if (lifecycle === 'ACTIVE' && existing.lifecycle !== 'ACTIVE') {
      yield* insertLifecycleEvent(transaction, {
        actionInvocationId: input.actionInvocationId,
        actingPrincipalId: input.principalId,
        effectiveAt: now,
        event: 'ACTIVATED',
        productId: input.productId,
        reason: input.reason,
        tenantId,
      });
    }
    const resulting = yield* loadProduct(transaction, tenantId, input.productId, selectionEvidence);
    return Option.isSome(resulting)
      ? { _tag: 'updated' as const, changed: true, product: resulting.value }
      : { _tag: 'not_found' as const };
  });

  const retire: CatalogPersistence['retire'] = Effect.fn('CatalogPersistence.retire')(function* retire(input) {
    const current = yield* loadProduct(transaction, tenantId, input.productId, selectionEvidence);
    if (Option.isNone(current)) {
      return { _tag: 'not_found' as const };
    }
    const existing = current.value;
    if (existing.revision !== input.expectedRevision) {
      return { _tag: 'revision_conflict' as const, actualRevision: existing.revision };
    }
    if (existing.lifecycle === 'RETIRED') {
      return { _tag: 'already_retired' as const, product: existing };
    }
    const revision = existing.revision + 1;
    const effectiveAt = input.effectiveAt;
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const [updated] = yield* transaction
      .update(products)
      .set({
        currentRevision: revision,
        lifecycleState: 'RETIRED',
        retiredEffectiveAt: effectiveAt,
        retiredReason: input.reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(products.productId, input.productId),
          eq(products.tenantId, tenantId),
          eq(products.currentRevision, input.expectedRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      const [latest] = yield* getProductRow(transaction, tenantId, input.productId);
      return {
        _tag: 'revision_conflict' as const,
        actualRevision: latest?.currentRevision ?? input.expectedRevision,
      };
    }
    yield* insertRevision(transaction, {
      actionInvocationId: input.actionInvocationId,
      actingPrincipalId: input.principalId,
      changeKind: 'LIFECYCLE',
      description: existing.description,
      evidenceRefs: [],
      lifecycle: 'RETIRED',
      name: existing.name,
      productId: input.productId,
      reason: input.reason,
      revision,
      tenantId,
    });
    yield* insertLifecycleEvent(transaction, {
      actionInvocationId: input.actionInvocationId,
      actingPrincipalId: input.principalId,
      effectiveAt,
      event: 'RETIRED',
      productId: input.productId,
      reason: input.reason,
      tenantId,
    });
    const resulting = yield* loadProduct(transaction, tenantId, input.productId, selectionEvidence);
    return Option.isSome(resulting)
      ? { _tag: 'retired' as const, product: resulting.value }
      : { _tag: 'not_found' as const };
  });

  const reactivate: CatalogPersistence['reactivate'] = Effect.fn('CatalogPersistence.reactivate')(
    function* reactivate(input) {
      const current = yield* loadProduct(transaction, tenantId, input.productId, selectionEvidence);
      if (Option.isNone(current)) {
        return { _tag: 'not_found' as const };
      }
      const existing = current.value;
      if (existing.revision !== input.expectedRevision) {
        return { _tag: 'revision_conflict' as const, actualRevision: existing.revision };
      }
      if (existing.lifecycle !== 'RETIRED') {
        return { _tag: 'lifecycle_conflict' as const, product: existing };
      }
      const localizedNames = yield* getLocalizedNames(transaction, tenantId, input.productId);
      const candidate = { lifecycle: 'ACTIVE' as const, variants: existing.variants };
      const localBlockers = productActivationBlockers(candidate, localizedNames);
      if (localBlockers.length > 0) {
        return { _tag: 'not_catalog_ready' as const, product: existing, reasons: localBlockers };
      }
      const [retiredRow] = yield* getProductRow(transaction, tenantId, input.productId);
      if (retiredRow === undefined) {
        return { _tag: 'not_found' as const };
      }
      const revision = existing.revision + 1;
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const [updated] = yield* transaction
        .update(products)
        .set({
          currentRevision: revision,
          lifecycleState: 'ACTIVE',
          retiredEffectiveAt: null,
          retiredReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(products.productId, input.productId),
            eq(products.tenantId, tenantId),
            eq(products.currentRevision, input.expectedRevision),
          ),
        )
        .returning()
        .pipe(Effect.mapError(unavailable));
      if (updated === undefined) {
        const [latest] = yield* getProductRow(transaction, tenantId, input.productId);
        return {
          _tag: 'revision_conflict' as const,
          actualRevision: latest?.currentRevision ?? input.expectedRevision,
        };
      }
      const currentEvidence = yield* readProductSelectionEvidence(candidate, selectionEvidence);
      const readiness = catalogReadiness(candidate, localizedNames, currentEvidence);
      if (!readiness.catalogReady) {
        const [restored] = yield* transaction
          .update(products)
          .set({
            currentRevision: input.expectedRevision,
            lifecycleState: retiredRow.lifecycleState,
            retiredEffectiveAt: retiredRow.retiredEffectiveAt,
            retiredReason: retiredRow.retiredReason,
            updatedAt: retiredRow.updatedAt,
          })
          .where(
            and(
              eq(products.productId, input.productId),
              eq(products.tenantId, tenantId),
              eq(products.currentRevision, revision),
            ),
          )
          .returning()
          .pipe(Effect.mapError(unavailable));
        if (restored === undefined) {
          return yield* unavailable();
        }
        return { _tag: 'not_catalog_ready' as const, product: existing, reasons: readiness.reasons };
      }
      yield* insertRevision(transaction, {
        actionInvocationId: input.actionInvocationId,
        actingPrincipalId: input.principalId,
        changeKind: 'LIFECYCLE',
        description: existing.description,
        evidenceRefs: [],
        lifecycle: 'ACTIVE',
        name: existing.name,
        productId: input.productId,
        reason: input.reason,
        revision,
        tenantId,
      });
      yield* insertLifecycleEvent(transaction, {
        actionInvocationId: input.actionInvocationId,
        actingPrincipalId: input.principalId,
        effectiveAt: now,
        event: 'ACTIVATED',
        productId: input.productId,
        reason: input.reason,
        tenantId,
      });
      const resulting = yield* loadProduct(transaction, tenantId, input.productId, selectionEvidence);
      return Option.isSome(resulting)
        ? { _tag: 'reactivated' as const, product: resulting.value }
        : { _tag: 'not_found' as const };
    },
  );

  const correct: CatalogPersistence['correct'] = Effect.fn('CatalogPersistence.correct')(function* correct(input) {
    const current = yield* loadProduct(transaction, tenantId, input.productId, selectionEvidence);
    if (Option.isNone(current)) {
      return { _tag: 'not_found' as const };
    }
    const existing = current.value;
    if (existing.revision !== input.expectedRevision) {
      return { _tag: 'revision_conflict' as const, actualRevision: existing.revision };
    }
    if (existing.lifecycle === 'RETIRED') {
      return { _tag: 'retired' as const, product: existing };
    }
    if (input.variantId !== undefined && !existing.variants.some((variant) => variant.variantId === input.variantId)) {
      return { _tag: 'variant_conflict' as const };
    }
    const changed = input.name !== undefined || input.description !== undefined;
    if (!changed) {
      return { _tag: 'corrected' as const, changed: false, product: existing };
    }
    const revision = existing.revision + 1;
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const [updated] = yield* transaction
      .update(products)
      .set({
        ...(input.description === undefined ? {} : { description: input.description }),
        currentRevision: revision,
        ...(input.name === undefined ? {} : { name: input.name }),
        updatedAt: now,
      })
      .where(
        and(
          eq(products.productId, input.productId),
          eq(products.tenantId, tenantId),
          eq(products.currentRevision, input.expectedRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      const [latest] = yield* getProductRow(transaction, tenantId, input.productId);
      return {
        _tag: 'revision_conflict' as const,
        actualRevision: latest?.currentRevision ?? input.expectedRevision,
      };
    }
    yield* insertRevision(transaction, {
      actionInvocationId: input.actionInvocationId,
      actingPrincipalId: input.principalId,
      changeKind: 'COSMETIC_CORRECTION',
      description: input.description ?? existing.description,
      evidenceRefs: input.evidenceRefs,
      lifecycle: existing.lifecycle,
      name: input.name ?? existing.name,
      productId: input.productId,
      reason: input.reason,
      revision,
      tenantId,
    });
    const resulting = yield* loadProduct(transaction, tenantId, input.productId, selectionEvidence);
    return Option.isSome(resulting)
      ? { _tag: 'corrected' as const, changed: true, product: resulting.value }
      : { _tag: 'not_found' as const };
  });

  const getHistory: CatalogPersistence['getHistory'] = Effect.fn('CatalogPersistence.getHistory')(
    function* getHistory(productId) {
      const parsedProductId = Schema.decodeOption(ProductIdSchema)(productId);
      if (Option.isNone(parsedProductId)) {
        return Option.none<ProductHistory>();
      }
      const current = yield* loadProduct(transaction, tenantId, parsedProductId.value, selectionEvidence);
      if (Option.isNone(current)) {
        return Option.none<ProductHistory>();
      }
      const revisions = yield* transaction
        .select()
        .from(productRevisions)
        .where(and(eq(productRevisions.tenantId, tenantId), eq(productRevisions.productId, parsedProductId.value)))
        .orderBy(asc(productRevisions.revision))
        .pipe(Effect.mapError(unavailable));
      const lifecycle = yield* transaction
        .select()
        .from(productLifecycleEvents)
        .where(
          and(
            eq(productLifecycleEvents.tenantId, tenantId),
            eq(productLifecycleEvents.productId, parsedProductId.value),
          ),
        )
        .orderBy(asc(productLifecycleEvents.effectiveAt))
        .pipe(Effect.mapError(unavailable));
      const revisionRecords: ProductRevisionRecord[] = yield* Effect.forEach(
        revisions,
        (row) =>
          Schema.decodeEffect(ProductRevisionReferenceSchema)({
            resourceRef: productRef(tenantId, row.productId),
            revision: row.revision,
            revisionId: row.productRevisionId,
          }).pipe(
            Effect.map((revisionReference): ProductRevisionRecord => ({
              actionInvocationId: row.actionInvocationId,
              changeKind:
                row.changeKind === 'COSMETIC_CORRECTION' ||
                row.changeKind === 'UPDATED' ||
                row.changeKind === 'LIFECYCLE'
                  ? row.changeKind
                  : 'CREATED',
              ...(row.description === null ? {} : { description: row.description }),
              evidenceRefs: row.evidenceRefs,
              lifecycle: toLifecycle(row.lifecycleState),
              ...(row.name === null ? {} : { name: row.name }),
              productRef: productRef(tenantId, row.productId),
              reason: row.reason,
              recordedAt: row.recordedAt.toISOString(),
              revision: row.revision,
              revisionReference,
            })),
            Effect.mapError(unavailable),
          ),
        { concurrency: 1 },
      );
      return Option.some<ProductHistory>({
        historical: true,
        lifecycle: lifecycle.map((row) => ({
          actionInvocationId: row.actionInvocationId,
          effectiveAt: row.effectiveAt.toISOString(),
          event: row.event === 'RETIRED' ? 'RETIRED' : 'ACTIVATED',
          productRef: productRef(tenantId, row.productId),
          reason: row.reason,
          recordedAt: row.recordedAt.toISOString(),
        })),
        productRef: current.value.productRef,
        revisions: revisionRecords,
      });
    },
  );

  return Effect.succeed(
    Object.freeze({
      correct,
      create,
      getCurrent,
      getCreatedByInvocation,
      getHistory,
      reactivate,
      recoverCreateProduct,
      recoverUpdateProduct,
      retire,
      update,
    }),
  );
};

/** Production composition: Catalog Current evidence stays bound to the same owner transaction. */
export const catalogPersistenceWithCurrentSelectionEvidenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  selectionEvidence: CatalogSelectionEvidenceReader = catalogSelectionEvidenceForScope(transaction, scope),
): Effect.Effect<CatalogPersistence> => catalogPersistenceForScope(transaction, scope, selectionEvidence);
