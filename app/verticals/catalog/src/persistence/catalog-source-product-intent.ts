import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import type { ProductRef } from '@app/catalog-selection-contracts/resources/product';
import type { VariantRef } from '@app/catalog-selection-contracts/resources/variant';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema, Struct } from 'effect';
import { encode as encodeHex } from 'effect/encoding/Hex';

import { CreateProductPayloadSchema } from '../../shared/actions/create-product.ts';
import type { CreateProductPayload } from '../../shared/actions/create-product.ts';
import type { CatalogProductSourceCorrelation } from '../../shared/domain/catalog-source-correlation.ts';
import { catalogSourceCorrelations } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

const unavailable = (cause: unknown) =>
  Object.assign(
    new CatalogPersistenceUnavailable({
      code: 'catalog_persistence_unavailable',
      reason: 'Catalog source Product intent is unavailable',
    }),
    { cause },
  );

export const catalogProductCreateFingerprint = (payload: CreateProductPayload) =>
  Schema.encodeEffect(Schema.fromJsonString(CreateProductPayloadSchema))(
    payload.sourceCorrelation === undefined
      ? payload
      : {
          ...payload,
          sourceCorrelation: Struct.omit(payload.sourceCorrelation, ['sourceOccurrenceId']),
        },
  ).pipe(
    Effect.map((encoded) => encodeHex(sha256(utf8ToBytes(encoded)))),
    Effect.mapError(unavailable),
  );

const matchesSourceRow = (
  row: typeof catalogSourceCorrelations.$inferSelect,
  expected: {
    readonly productRef: ProductRef;
    readonly scope: OperationalScope;
    readonly source: CatalogProductSourceCorrelation;
    readonly variantRef: VariantRef | undefined;
  },
) =>
  row.tenantId === expected.scope.tenantId &&
  row.actingPrincipalId === expected.scope.principalId &&
  row.entityKind === 'PRODUCT' &&
  row.issuerId === expected.source.issuerId &&
  row.routeScope === expected.source.routeScope &&
  row.recordNamespace === expected.source.recordNamespace &&
  row.recordId === expected.source.recordId &&
  row.mappingRevision === expected.source.mappingRevision &&
  row.productId === expected.productRef.resourceId &&
  (expected.variantRef === undefined || row.variantId === expected.variantRef.resourceId);

/** A source witness authorizes only adoption of an identical decision, never a stale mutation. */
export const catalogSourceProductIntentMatches = Effect.fn('CatalogSourceProductIntent.matches')(
  function* catalogSourceProductIntentMatches(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    input: {
      readonly productRef: ProductRef;
      readonly sourceProduct: CreateProductPayload | undefined;
      readonly variantRef?: VariantRef;
    },
  ) {
    const source = input.sourceProduct?.sourceCorrelation;
    if (
      source === undefined ||
      input.sourceProduct === undefined ||
      input.productRef.tenantId !== scope.tenantId ||
      input.productRef.moduleId !== 'commerce.catalog' ||
      input.productRef.resourceType !== 'commerce.catalog.product' ||
      (input.variantRef !== undefined &&
        (input.variantRef.tenantId !== scope.tenantId ||
          input.variantRef.moduleId !== 'commerce.catalog' ||
          input.variantRef.resourceType !== 'commerce.catalog.variant'))
    ) {
      return false;
    }
    const rows = yield* transaction
      .select()
      .from(catalogSourceCorrelations)
      .where(
        and(
          eq(catalogSourceCorrelations.tenantId, scope.tenantId),
          eq(catalogSourceCorrelations.issuerId, source.issuerId),
          eq(catalogSourceCorrelations.routeScope, source.routeScope),
          eq(catalogSourceCorrelations.recordNamespace, source.recordNamespace),
          eq(catalogSourceCorrelations.entityKind, 'PRODUCT'),
          eq(catalogSourceCorrelations.recordId, source.recordId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const [row] = rows;
    return (
      rows.length === 1 &&
      row !== undefined &&
      matchesSourceRow(row, { productRef: input.productRef, scope, source, variantRef: input.variantRef }) &&
      row.intentFingerprint === (yield* catalogProductCreateFingerprint(input.sourceProduct))
    );
  },
);
