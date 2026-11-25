import type { OperationalScope, ReadServiceFactory, ScopedTransactionExecutor } from '@app/core-runtime';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { and, asc, count, eq, getTableColumns, gt, ilike, or } from 'drizzle-orm';
import { Effect, Schema, Struct } from 'effect';
import { encode as encodeHex } from 'effect/encoding/Hex';

import { CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import type { CreateProductPayload, CreateProductResult } from '../../shared/actions/create-product.ts';
import { CreateVariantPayloadSchema, CreateVariantResultSchema } from '../../shared/actions/create-variant.ts';
import type { CreateVariantPayload, CreateVariantResult } from '../../shared/actions/create-variant.ts';
import type { CatalogSourceCorrelation } from '../../shared/domain/catalog-source-correlation.ts';
import type { BindInitialVariantSourcePayload } from '../../shared/actions/bind-initial-variant-source.ts';
import { BindInitialVariantSourceResultSchema } from '../../shared/actions/bind-initial-variant-source.ts';
import { recoverCatalogActionResult } from '../api/catalog-action-result-recovery.ts';
import { ProductPersistenceConflict } from '../../shared/domain/product-errors.ts';
import { catalogResultSnapshots, catalogSourceCorrelations, products } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import type { CatalogSourceProductPageRequest } from '../../shared/apis/catalog-source-product-page.ts';
import type { CatalogSourceProductsRequest } from '../../shared/apis/catalog-source-products.ts';
import { catalogPersistenceWithCurrentSelectionEvidenceForScope } from './catalog-persistence.ts';
import { catalogProductCreateFingerprint as fingerprint } from './catalog-source-product-intent.ts';

const sourceCorrelationConflict = () =>
  new ProductPersistenceConflict({
    code: 'product_persistence_conflict',
    conflict: 'ACTION_INVOCATION_ID',
    reason: 'Qualified source identity already has a different Catalog creation intent',
  });
const unavailable = (cause?: unknown) => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog source correlation evidence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { value: cause });
  }
  return failure;
};

/** Occurrence evidence changes the Core request identity, never the stable business create intent. */
const businessSourceCorrelation = <Source extends CatalogSourceCorrelation>(source: Source) =>
  Struct.omit(source, ['sourceOccurrenceId']);

const businessSourcePayload = <Payload extends { readonly sourceCorrelation?: CatalogSourceCorrelation }>(
  payload: Payload,
) =>
  payload.sourceCorrelation === undefined
    ? payload
    : { ...payload, sourceCorrelation: businessSourceCorrelation(payload.sourceCorrelation) };

const variantFingerprint = (payload: CreateVariantPayload) =>
  Schema.encodeEffect(Schema.fromJsonString(CreateVariantPayloadSchema))(businessSourcePayload(payload)).pipe(
    Effect.map((encoded) => encodeHex(sha256(utf8ToBytes(encoded)))),
    Effect.mapError(unavailable),
  );
export const catalogSourceCorrelationForScope = (transaction: ScopedTransactionExecutor, scope: OperationalScope) => {
  const find = (source: CatalogSourceCorrelation, entityKind: 'PRODUCT' | 'VARIANT') =>
    transaction
      .select()
      .from(catalogSourceCorrelations)
      .where(
        and(
          eq(catalogSourceCorrelations.tenantId, scope.tenantId),
          eq(catalogSourceCorrelations.issuerId, source.issuerId),
          eq(catalogSourceCorrelations.routeScope, source.routeScope),
          eq(catalogSourceCorrelations.recordNamespace, source.recordNamespace),
          eq(catalogSourceCorrelations.entityKind, entityKind),
          eq(catalogSourceCorrelations.recordId, source.recordId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
  const recoverProduct = Effect.fn('CatalogSourceCorrelation.recoverProduct')(function* recoverProduct(
    payload: CreateProductPayload,
  ) {
    if (payload.sourceCorrelation === undefined) {
      return null;
    }
    const [row] = yield* find(payload.sourceCorrelation, 'PRODUCT');
    if (row === undefined) {
      return null;
    }
    if (row.actingPrincipalId !== scope.principalId || row.intentFingerprint !== (yield* fingerprint(payload))) {
      return yield* sourceCorrelationConflict();
    }
    const [snapshot] = yield* transaction
      .select()
      .from(catalogResultSnapshots)
      .where(
        and(
          eq(catalogResultSnapshots.tenantId, scope.tenantId),
          eq(catalogResultSnapshots.actionInvocationId, row.actionInvocationId),
          eq(catalogResultSnapshots.actionKey, 'commerce.catalog.create-product'),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (snapshot === undefined) {
      return yield* unavailable();
    }
    const result = yield* Schema.decodeUnknownEffect(CreateProductResultSchema)(snapshot.encodedResult).pipe(
      Effect.mapError(unavailable),
    );
    if (
      result.businessOriginalCreateInvocationId !== undefined &&
      result.businessOriginalCreateInvocationId !== row.actionInvocationId
    ) {
      return yield* unavailable();
    }
    return { ...result, businessOriginalCreateInvocationId: row.actionInvocationId };
  });
  const captureProduct = Effect.fn('CatalogSourceCorrelation.captureProduct')(function* captureProduct(
    payload: CreateProductPayload,
    result: CreateProductResult,
    actionInvocationId: string,
  ) {
    const source = payload.sourceCorrelation;
    if (source === undefined) {
      return yield* Effect.void;
    }
    const common = {
      actingPrincipalId: scope.principalId,
      actionInvocationId,
      intentFingerprint: yield* fingerprint(payload),
      issuerId: source.issuerId,
      mappingRevision: source.mappingRevision,
      productId: result.product.productRef.resourceId,
      recordNamespace: source.recordNamespace,
      routeScope: source.routeScope,
      tenantId: scope.tenantId,
      variantId: result.variantId,
    };
    const rows = [
      { ...common, entityKind: 'PRODUCT', recordId: source.recordId },
      ...(source.initialVariantRecordId === undefined
        ? []
        : [{ ...common, entityKind: 'VARIANT', recordId: source.initialVariantRecordId }]),
    ];
    const inserted = yield* transaction
      .insert(catalogSourceCorrelations)
      .values(rows)
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (inserted.length !== rows.length) {
      return yield* sourceCorrelationConflict();
    }
    return yield* Effect.void;
  });
  const recoverVariant = Effect.fn('CatalogSourceCorrelation.recoverVariant')(function* recoverVariant(
    payload: CreateVariantPayload,
  ) {
    if (payload.sourceCorrelation === undefined) {
      return null;
    }
    const [row] = yield* find(payload.sourceCorrelation, 'VARIANT');
    if (row === undefined) {
      return null;
    }
    if (row.actingPrincipalId !== scope.principalId || row.intentFingerprint !== (yield* variantFingerprint(payload))) {
      return yield* sourceCorrelationConflict();
    }
    const [snapshot] = yield* transaction
      .select()
      .from(catalogResultSnapshots)
      .where(
        and(
          eq(catalogResultSnapshots.tenantId, scope.tenantId),
          eq(catalogResultSnapshots.actionInvocationId, row.actionInvocationId),
          eq(catalogResultSnapshots.actionKey, 'commerce.catalog.create-variant'),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (snapshot === undefined) {
      return yield* unavailable();
    }
    const result = yield* Schema.decodeUnknownEffect(CreateVariantResultSchema)(snapshot.encodedResult).pipe(
      Effect.mapError(unavailable),
    );
    if (
      result.businessOriginalCreateInvocationId !== undefined &&
      result.businessOriginalCreateInvocationId !== row.actionInvocationId
    ) {
      return yield* unavailable();
    }
    return { ...result, businessOriginalCreateInvocationId: row.actionInvocationId };
  });
  const captureVariant = Effect.fn('CatalogSourceCorrelation.captureVariant')(function* captureVariant(
    payload: CreateVariantPayload,
    result: CreateVariantResult,
    actionInvocationId: string,
  ) {
    const source = payload.sourceCorrelation;
    if (source === undefined) {
      return yield* Effect.void;
    }
    const inserted = yield* transaction
      .insert(catalogSourceCorrelations)
      .values({
        ...businessSourceCorrelation(source),
        actingPrincipalId: scope.principalId,
        actionInvocationId,
        entityKind: 'VARIANT',
        intentFingerprint: yield* variantFingerprint(payload),
        productId: result.variant.productRef.resourceId,
        tenantId: scope.tenantId,
        variantId: result.variant.variantId,
      })
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (inserted.length !== 1) {
      return yield* sourceCorrelationConflict();
    }
    return yield* Effect.void;
  });
  const bindInitialVariant = Effect.fn('CatalogSourceCorrelation.bindInitialVariant')(function* bindInitialVariant(
    payload: BindInitialVariantSourcePayload,
  ) {
    const [product] = yield* find(payload.productSource, 'PRODUCT');
    if (
      product === undefined ||
      product.actionInvocationId !== payload.expectedCreateInvocationId ||
      product.mappingRevision !== payload.productSource.mappingRevision
    ) {
      return yield* sourceCorrelationConflict();
    }
    const result = {
      originalCreateInvocationId: product.actionInvocationId,
      productId: product.productId,
      variantId: product.variantId,
    };
    const inserted = yield* transaction
      .insert(catalogSourceCorrelations)
      .values({ ...product, entityKind: 'VARIANT', recordId: payload.initialVariantRecordId })
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (inserted.length === 1) {
      return { ...result, changed: true };
    }
    const source = { ...payload.productSource, recordId: payload.initialVariantRecordId };
    const [existing] = yield* find(source, 'VARIANT');
    if (
      existing === undefined ||
      existing.productId !== product.productId ||
      existing.variantId !== product.variantId ||
      existing.actionInvocationId !== product.actionInvocationId
    ) {
      return yield* sourceCorrelationConflict();
    }
    return { ...result, changed: false };
  });
  return { bindInitialVariant, captureProduct, captureVariant, find, recoverProduct, recoverVariant };
};

const sourceRecordPredicate = (input: CatalogSourceProductsRequest) => {
  if (input.operation === 'LOOKUP') {
    return eq(catalogSourceCorrelations.recordId, input.recordId);
  }
  return input.afterRecordId === undefined ? undefined : gt(catalogSourceCorrelations.recordId, input.afterRecordId);
};

type SourceQualifier = Pick<CatalogSourceProductsRequest, 'issuerId' | 'recordNamespace' | 'routeScope'>;

export const catalogSourceProductsForScope = (
  transaction: Parameters<ReadServiceFactory<void>>[0],
  scope: Parameters<ReadServiceFactory<void>>[1],
) =>
  catalogPersistenceWithCurrentSelectionEvidenceForScope(transaction, scope).pipe(
    Effect.map((catalog) => ({
      getCurrent: catalog.getCurrent,
      rows: (input: CatalogSourceProductsRequest) =>
        transaction
          .select()
          .from(catalogSourceCorrelations)
          .where(
            and(
              eq(catalogSourceCorrelations.tenantId, scope.tenantId),
              eq(catalogSourceCorrelations.issuerId, input.issuerId),
              eq(catalogSourceCorrelations.routeScope, input.routeScope),
              eq(catalogSourceCorrelations.recordNamespace, input.recordNamespace),
              eq(catalogSourceCorrelations.entityKind, input.operation === 'LIST' ? 'PRODUCT' : input.entityKind),
              sourceRecordPredicate(input),
            ),
          )
          .orderBy(asc(catalogSourceCorrelations.recordId))
          .limit(input.operation === 'LIST' ? input.limit + 1 : 1)
          .pipe(Effect.mapError(unavailable)),
      variants: (input: SourceQualifier, productId: string) =>
        transaction
          .select()
          .from(catalogSourceCorrelations)
          .where(
            and(
              eq(catalogSourceCorrelations.tenantId, scope.tenantId),
              eq(catalogSourceCorrelations.issuerId, input.issuerId),
              eq(catalogSourceCorrelations.routeScope, input.routeScope),
              eq(catalogSourceCorrelations.recordNamespace, input.recordNamespace),
              eq(catalogSourceCorrelations.entityKind, 'VARIANT'),
              eq(catalogSourceCorrelations.productId, productId),
            ),
          )
          .orderBy(asc(catalogSourceCorrelations.recordId))
          .pipe(Effect.mapError(unavailable)),
    })),
  );

/** `%`, `_` and the escape character itself match literally inside a LIKE pattern. */
const containsPattern = (text: string) => {
  const literal = text.replaceAll(/[\\%_]/gu, String.raw`\$&`);
  return `%${literal}%`;
};

const sourceProductsMatching = (tenantId: string, input: CatalogSourceProductPageRequest) =>
  and(
    eq(catalogSourceCorrelations.tenantId, tenantId),
    eq(catalogSourceCorrelations.issuerId, input.issuerId),
    eq(catalogSourceCorrelations.routeScope, input.routeScope),
    eq(catalogSourceCorrelations.recordNamespace, input.recordNamespace),
    eq(catalogSourceCorrelations.entityKind, 'PRODUCT'),
    input.search === undefined
      ? undefined
      : or(
          ilike(products.name, containsPattern(input.search)),
          ilike(products.description, containsPattern(input.search)),
        ),
  );
const onlyTotal = (rows: readonly { readonly total: number }[]) =>
  rows.length === 1 && rows[0] !== undefined ? Effect.succeed(rows[0].total) : Effect.fail(unavailable());
const sourceProductOf = and(
  eq(products.tenantId, catalogSourceCorrelations.tenantId),
  eq(products.productId, catalogSourceCorrelations.productId),
);

/**
 * A page of the source products of one qualified scope, ordered by source record id, with the total of the
 * same predicate. `search` keeps the products whose name or description contains the text, ignoring case.
 */
export const catalogSourceProductPageForScope = (
  transaction: Parameters<ReadServiceFactory<void>>[0],
  scope: Parameters<ReadServiceFactory<void>>[1],
) =>
  catalogSourceProductsForScope(transaction, scope).pipe(
    Effect.map(({ getCurrent, variants }) => ({
      count: (input: CatalogSourceProductPageRequest) =>
        transaction
          .select({ total: count() })
          .from(catalogSourceCorrelations)
          .innerJoin(products, sourceProductOf)
          .where(sourceProductsMatching(scope.tenantId, input))
          .pipe(Effect.mapError(unavailable), Effect.flatMap(onlyTotal)),
      getCurrent,
      rows: (input: CatalogSourceProductPageRequest) =>
        transaction
          .select(getTableColumns(catalogSourceCorrelations))
          .from(catalogSourceCorrelations)
          .innerJoin(products, sourceProductOf)
          .where(sourceProductsMatching(scope.tenantId, input))
          .orderBy(asc(catalogSourceCorrelations.recordId))
          .limit(input.limit)
          .offset(input.offset)
          .pipe(Effect.mapError(unavailable)),
      variants,
    })),
  );

export const catalogInitialVariantSourceRecoveryForScope = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) => ({
  recover: (actionInvocationId: string) =>
    recoverCatalogActionResult(
      transaction,
      scope,
      { actionInvocationId, actionKey: 'commerce.catalog.bind-initial-variant-source', schemaVersion: 1 },
      {
        decode: Schema.decodeUnknownEffect(BindInitialVariantSourceResultSchema),
      },
    ),
});
