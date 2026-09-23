import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import type {
  CreateBrandPayload,
  ReactivateBrandPayload,
  RenameBrandPayload,
  RetireBrandPayload,
  SetProductBrandPayload,
} from '../../shared/actions/brand-mutations.ts';
import {
  CreateBrandPayloadSchema,
  ProductBrandAssignmentSchema,
  RenameBrandPayloadSchema,
  RetireBrandPayloadSchema,
  SetProductBrandPayloadSchema,
} from '../../shared/actions/brand-mutations.ts';
import { BrandRefSchema } from '../../shared/resources/brand.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import {
  brandRevisions,
  brands,
  productBrandAssignmentRevisions,
  productBrandAssignments,
  products,
} from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

interface Input<Payload> {
  readonly actionInvocationId: string;
  readonly payload: Payload;
  readonly principalId: string;
}

const FailedMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('invalid', { reason: Schema.String }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('stale', { actualRevision: Schema.Int }),
]);
const BrandMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('applied', { result: Schema.Struct({ brandRef: BrandRefSchema, revision: Schema.Int }) }),
  FailedMutationOutcomeSchema,
]);
const ProductBrandMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('applied', {
    result: Schema.Struct({
      assignment: ProductBrandAssignmentSchema,
      productRef: ProductRefSchema,
      revision: Schema.Int,
    }),
  }),
  FailedMutationOutcomeSchema,
]);
export type BrandMutationOutcome = typeof BrandMutationOutcomeSchema.Type;
export type ProductBrandMutationOutcome = typeof ProductBrandMutationOutcomeSchema.Type;

export class BrandPersistenceUnavailable extends Schema.TaggedError<BrandPersistenceUnavailable>()(
  'BrandPersistenceUnavailable',
  { code: Schema.Literal('brand_persistence_unavailable'), reason: Schema.String },
) {}

export interface BrandPersistence {
  readonly create: (
    input: Input<CreateBrandPayload>,
  ) => Effect.Effect<BrandMutationOutcome, BrandPersistenceUnavailable>;
  readonly reactivate: (
    input: Input<ReactivateBrandPayload>,
  ) => Effect.Effect<BrandMutationOutcome, BrandPersistenceUnavailable>;
  readonly rename: (
    input: Input<RenameBrandPayload>,
  ) => Effect.Effect<BrandMutationOutcome, BrandPersistenceUnavailable>;
  readonly retire: (
    input: Input<RetireBrandPayload>,
  ) => Effect.Effect<BrandMutationOutcome, BrandPersistenceUnavailable>;
  readonly setProductBrand: (
    input: Input<SetProductBrandPayload>,
  ) => Effect.Effect<ProductBrandMutationOutcome, BrandPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const failure = new BrandPersistenceUnavailable({
    code: 'brand_persistence_unavailable',
    reason: 'Authoritative Brand and Product Brand persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const claimColumns = (payload: SetProductBrandPayload) => {
  if (payload.assignment.kind === 'brand') {
    return {
      brandId: payload.assignment.brandRef.resourceId,
      claimKind: 'BRANDED',
      evidenceRef: payload.evidenceRefs[0],
    } as const;
  }
  if (payload.assignment.kind === 'confirmed_unbranded') {
    return { brandId: null, claimKind: 'CONFIRMED_UNBRANDED', evidenceRef: payload.evidenceRefs[0] } as const;
  }
  return { brandId: null, claimKind: 'UNKNOWN', evidenceRef: null } as const;
};

export const brandPersistenceForScope = (transaction: ScopedTransaction, scope: OperationalScope): BrandPersistence => {
  const { tenantId } = scope;
  const validBrandRef = (ref: typeof BrandRefSchema.Type) =>
    Schema.is(BrandRefSchema)(ref) && ref.tenantId === tenantId;
  const validProductRef = (ref: typeof ProductRefSchema.Type) =>
    Schema.is(ProductRefSchema)(ref) && ref.tenantId === tenantId;
  const getBrand = (brandId: string) =>
    transaction
      .select()
      .from(brands)
      .where(and(eq(brands.tenantId, tenantId), eq(brands.brandId, brandId)))
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
  const getAssignment = (productId: string) =>
    transaction
      .select()
      .from(productBrandAssignments)
      .where(and(eq(productBrandAssignments.tenantId, tenantId), eq(productBrandAssignments.productId, productId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const appendBrandRevision = (
    row: typeof brands.$inferSelect,
    input: Input<CreateBrandPayload | RenameBrandPayload | RetireBrandPayload>,
    changeKind: 'CREATED' | 'RENAMED' | 'RETIRED' | 'REACTIVATED',
  ) =>
    transaction
      .insert(brandRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        brandId: row.brandId,
        changeKind,
        evidenceRefs: [...input.payload.evidenceRefs],
        lifecycleState: row.lifecycleState,
        name: row.name,
        reason: input.payload.reason,
        revision: row.currentRevision,
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
  const appendAssignmentRevision = (
    row: typeof productBrandAssignments.$inferSelect,
    input: Input<SetProductBrandPayload>,
  ) =>
    transaction
      .insert(productBrandAssignmentRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        brandId: row.brandId,
        claimKind: row.claimKind,
        evidenceRef: row.evidenceRef,
        productId: row.productId,
        reason: input.payload.reason,
        revision: row.currentRevision,
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));

  const create: BrandPersistence['create'] = Effect.fn('BrandPersistence.create')(function* create(input) {
    const { brandRef, name } = input.payload;
    if (!Schema.is(CreateBrandPayloadSchema)(input.payload) || !validBrandRef(brandRef)) {
      return { _tag: 'invalid', reason: 'Brand identity, name, or evidence is invalid' };
    }
    const [existing] = yield* getBrand(brandRef.resourceId);
    if (existing !== undefined) {
      return { _tag: 'invalid', reason: 'Brand identity already exists' };
    }
    const [row] = yield* transaction
      .insert(brands)
      .values({ brandId: brandRef.resourceId, currentRevision: 1, lifecycleState: 'ACTIVE', name, tenantId })
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* unavailable();
    }
    yield* appendBrandRevision(row, input, 'CREATED');
    return { _tag: 'applied', result: { brandRef, revision: 1 } };
  });

  const changeBrand = Effect.fn('BrandPersistence.changeBrand')(function* changeBrand(
    input: Input<RenameBrandPayload | RetireBrandPayload>,
    changeKind: 'RENAMED' | 'RETIRED' | 'REACTIVATED',
    renamedTo?: string,
  ) {
    const { brandRef, expectedRevision } = input.payload;
    const validPayload =
      Schema.is(RetireBrandPayloadSchema)(input.payload) &&
      (changeKind !== 'RENAMED' || Schema.is(RenameBrandPayloadSchema)(input.payload));
    if (!validPayload || !validBrandRef(brandRef)) {
      return { _tag: 'invalid', reason: 'Brand change or evidence is invalid' } as const;
    }
    const [row] = yield* getBrand(brandRef.resourceId);
    if (row === undefined) {
      return { _tag: 'not_found' } as const;
    }
    if (row.currentRevision !== expectedRevision) {
      return { _tag: 'stale', actualRevision: row.currentRevision } as const;
    }
    if (changeKind === 'RETIRED' && row.lifecycleState !== 'ACTIVE') {
      return { _tag: 'invalid', reason: 'Brand is already retired' } as const;
    }
    if (changeKind === 'REACTIVATED' && row.lifecycleState !== 'RETIRED') {
      return { _tag: 'invalid', reason: 'Brand is already active' } as const;
    }
    const name = renamedTo ?? row.name;
    if (changeKind === 'RENAMED' && name === row.name) {
      return { _tag: 'invalid', reason: 'Brand name is unchanged' } as const;
    }
    let { lifecycleState } = row;
    if (changeKind === 'RETIRED') {
      lifecycleState = 'RETIRED';
    } else if (changeKind === 'REACTIVATED') {
      lifecycleState = 'ACTIVE';
    }
    const [updated] = yield* transaction
      .update(brands)
      .set({
        currentRevision: row.currentRevision + 1,
        lifecycleState,
        name,
        updatedAt: DateTime.toDateUtc(yield* DateTime.now),
      })
      .where(
        and(
          eq(brands.tenantId, tenantId),
          eq(brands.brandId, row.brandId),
          eq(brands.currentRevision, row.currentRevision),
          eq(brands.lifecycleState, row.lifecycleState),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return { _tag: 'stale', actualRevision: row.currentRevision } as const;
    }
    yield* appendBrandRevision(updated, input, changeKind);
    return { _tag: 'applied', result: { brandRef, revision: updated.currentRevision } } as const;
  });

  const setProductBrand: BrandPersistence['setProductBrand'] = Effect.fn('BrandPersistence.setProductBrand')(
    function* setProductBrand(input) {
      const { assignment, expectedRevision, productRef } = input.payload;
      if (
        !Schema.is(SetProductBrandPayloadSchema)(input.payload) ||
        !validProductRef(productRef) ||
        (assignment.kind === 'brand' && !validBrandRef(assignment.brandRef))
      ) {
        return { _tag: 'invalid', reason: 'Product Brand claim or evidence is invalid' };
      }
      const [product] = yield* getProduct(productRef.resourceId);
      if (product === undefined) {
        return { _tag: 'not_found' };
      }
      const [current] = yield* getAssignment(productRef.resourceId);
      if (current !== undefined && current.currentRevision !== expectedRevision) {
        return { _tag: 'stale', actualRevision: current.currentRevision };
      }
      if (current === undefined && expectedRevision !== 0) {
        return { _tag: 'stale', actualRevision: 0 };
      }
      if (assignment.kind === 'brand') {
        const [brand] = yield* getBrand(assignment.brandRef.resourceId);
        if (brand === undefined) {
          return { _tag: 'not_found' };
        }
        if (brand.lifecycleState !== 'ACTIVE') {
          return { _tag: 'invalid', reason: 'Retired Brand cannot be newly assigned' };
        }
      }
      const { brandId, claimKind, evidenceRef } = claimColumns(input.payload);
      if (evidenceRef === undefined && assignment.kind !== 'unknown') {
        return { _tag: 'invalid', reason: 'Confirmed Brand claim requires evidence' };
      }
      const revision = current === undefined ? 1 : current.currentRevision + 1;
      const [updated] = yield* (
        current === undefined
          ? transaction
              .insert(productBrandAssignments)
              .values({
                brandId,
                claimKind,
                currentRevision: revision,
                evidenceRef,
                productId: productRef.resourceId,
                tenantId,
              })
              .returning()
          : transaction
              .update(productBrandAssignments)
              .set({
                brandId,
                claimKind,
                currentRevision: revision,
                evidenceRef,
                updatedAt: DateTime.toDateUtc(yield* DateTime.now),
              })
              .where(
                and(
                  eq(productBrandAssignments.tenantId, tenantId),
                  eq(productBrandAssignments.productId, productRef.resourceId),
                  eq(productBrandAssignments.currentRevision, current.currentRevision),
                ),
              )
              .returning()
      ).pipe(Effect.mapError(unavailable));
      if (updated === undefined) {
        return { _tag: 'stale', actualRevision: current?.currentRevision ?? 0 };
      }
      yield* appendAssignmentRevision(updated, input);
      return { _tag: 'applied', result: { assignment, productRef, revision: updated.currentRevision } };
    },
  );
  return {
    create,
    reactivate: (input) => changeBrand(input, 'REACTIVATED'),
    rename: (input) => changeBrand(input, 'RENAMED', input.payload.name),
    retire: (input) => changeBrand(input, 'RETIRED'),
    setProductBrand,
  };
};
