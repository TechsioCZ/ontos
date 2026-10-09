import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, inArray } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { ProductRelationshipSchema, productRelationshipIsCurrent } from '../../shared/domain/product-relationship.ts';
import type { ProductRelationship, ProductRelationshipEndpoint } from '../../shared/domain/product-relationship.ts';
import { productRelationshipRevisions, productRelationships } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type AssertionRow = typeof productRelationships.$inferSelect;
type RevisionRow = typeof productRelationshipRevisions.$inferSelect;
interface EffectivePeriodSnapshot {
  effectiveFrom?: string;
  effectiveTo?: string;
}

const RevisionMetadataSchema = Schema.Struct({ recordedAt: Schema.DateTimeUtc });
type RevisionMetadata = typeof RevisionMetadataSchema.Type;

interface ProductRelationshipRevisionRead {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly changeKind: 'CREATED' | 'CORRECTED' | 'ENDED';
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
  readonly recordedAt: RevisionMetadata['recordedAt'];
  readonly relationship: ProductRelationship;
  readonly relationshipId: string;
  readonly revision: number;
}

interface ProductRelationshipRead extends ProductRelationshipRevisionRead {
  readonly current: boolean;
}

export interface ProductRelationshipReads {
  readonly forward: (
    endpoint: ProductRelationshipEndpoint,
    at: string,
  ) => Effect.Effect<readonly ProductRelationshipRead[], CatalogPersistenceUnavailable>;
  readonly get: (
    relationshipId: string,
    at: string,
  ) => Effect.Effect<Option.Option<ProductRelationshipRead>, CatalogPersistenceUnavailable>;
  readonly history: (
    relationshipId: string,
  ) => Effect.Effect<readonly ProductRelationshipRevisionRead[], CatalogPersistenceUnavailable>;
  readonly reverse: (
    endpoint: ProductRelationshipEndpoint,
    at: string,
  ) => Effect.Effect<readonly ProductRelationshipRead[], CatalogPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog relationship read is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const product = 'commerce.catalog.product';
const variant = 'commerce.catalog.variant';
const moduleId = 'commerce.catalog';
const validEndpoint = (endpoint: ProductRelationshipEndpoint, tenantId: string) =>
  endpoint.tenantId === tenantId &&
  endpoint.moduleId === moduleId &&
  (endpoint.resourceType === product || endpoint.resourceType === variant) &&
  endpoint.resourceId.length > 0;

const endpointOf = (tenantId: string, productId: string | null, variantId: string | null) => {
  if ((productId === null) === (variantId === null)) {
    return null;
  }
  return {
    moduleId,
    resourceId: productId ?? variantId ?? '',
    resourceType: productId === null ? variant : product,
    tenantId,
  };
};

const snapshot = Effect.fn('ProductRelationshipReads.snapshot')(function* snapshot(row: RevisionRow, tenantId: string) {
  if (
    row.tenantId !== tenantId ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Array.isArray(row.evidenceRefs) ||
    Number.isNaN(row.recordedAt.getTime())
  ) {
    return yield* unavailable();
  }
  const changeKind = yield* Schema.decodeUnknownEffect(Schema.Literals(['CREATED', 'CORRECTED', 'ENDED']))(
    row.changeKind,
  ).pipe(Effect.mapError(unavailable));
  const source = endpointOf(tenantId, row.sourceProductId, row.sourceVariantId);
  const target = endpointOf(tenantId, row.targetProductId, row.targetVariantId);
  if (
    source === null ||
    target === null ||
    (row.effectiveFrom !== null && Number.isNaN(row.effectiveFrom.getTime())) ||
    (row.effectiveTo !== null && Number.isNaN(row.effectiveTo.getTime()))
  ) {
    return yield* unavailable();
  }
  const effectivePeriod: EffectivePeriodSnapshot = {};
  if (row.effectiveFrom !== null) {
    effectivePeriod.effectiveFrom = row.effectiveFrom.toISOString();
  }
  if (row.effectiveTo !== null) {
    effectivePeriod.effectiveTo = row.effectiveTo.toISOString();
  }
  const decoded = yield* Schema.decodeUnknownEffect(ProductRelationshipSchema)({
    effectivePeriod,
    evidenceRefs: row.evidenceRefs,
    reason: row.reason,
    source,
    target,
    type: row.relationshipType,
  }).pipe(Effect.mapError(unavailable));
  if (!validEndpoint(decoded.source, tenantId) || !validEndpoint(decoded.target, tenantId)) {
    return yield* unavailable();
  }
  return {
    actingPrincipalId: row.actingPrincipalId,
    actionInvocationId: row.actionInvocationId,
    changeKind,
    evidenceRefs: row.evidenceRefs,
    reason: row.reason,
    recordedAt: DateTime.makeUnsafe(row.recordedAt),
    relationship: decoded,
    relationshipId: row.relationshipId,
    revision: row.revision,
  };
});

const matchesHead = (head: AssertionRow, revision: RevisionRow) =>
  head.tenantId === revision.tenantId &&
  head.relationshipId === revision.relationshipId &&
  head.currentRevision === revision.revision &&
  head.relationshipType === revision.relationshipType &&
  head.sourceProductId === revision.sourceProductId &&
  head.sourceVariantId === revision.sourceVariantId &&
  head.targetProductId === revision.targetProductId &&
  head.targetVariantId === revision.targetVariantId &&
  head.effectiveFrom?.getTime() === revision.effectiveFrom?.getTime() &&
  head.effectiveTo?.getTime() === revision.effectiveTo?.getTime();

const orderedHistory = (rows: readonly RevisionRow[], head: AssertionRow) => {
  const ordered = rows.toSorted((a, b) => a.revision - b.revision);
  if (
    head.currentRevision < 1 ||
    ordered.length !== head.currentRevision ||
    ordered.some(
      (row, index) =>
        row.tenantId !== head.tenantId ||
        row.relationshipId !== head.relationshipId ||
        row.revision !== index + 1 ||
        (index === 0 && row.changeKind !== 'CREATED') ||
        (index > 0 && row.changeKind === 'CREATED'),
    )
  ) {
    return null;
  }
  const latest = ordered.at(-1);
  return latest !== undefined && matchesHead(head, latest) ? ordered : null;
};

const validInstant = (at: string) => Option.isSome(DateTime.make(at));

const readHead = Effect.fn('ProductRelationshipReads.readHead')(function* readHead(
  head: AssertionRow,
  revisions: readonly RevisionRow[],
  tenantId: string,
  at: string,
) {
  const rows = revisions.filter((row) => row.relationshipId === head.relationshipId);
  const ordered = orderedHistory(rows, head);
  if (head.tenantId !== tenantId || ordered === null) {
    return yield* unavailable();
  }
  const latest = ordered.at(-1);
  if (latest === undefined) {
    return yield* unavailable();
  }
  const read = yield* snapshot(latest, tenantId);
  return { ...read, current: productRelationshipIsCurrent(read.relationship, at) };
});

/** All queries use Core's already scoped read transaction; no client-provided Tenant selects the scope. */
export const productRelationshipReadsForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ProductRelationshipReads => {
  const { tenantId } = scope;
  const readHeads = (condition: ReturnType<typeof eq>) =>
    transaction
      .select()
      .from(productRelationships)
      .where(and(eq(productRelationships.tenantId, tenantId), condition))
      .pipe(Effect.mapError(unavailable));
  const assemble = Effect.fn('ProductRelationshipReads.assemble')(function* assemble(
    heads: readonly AssertionRow[],
    at: string,
  ) {
    if (heads.length === 0) {
      return [];
    }
    const ids = heads.map((head) => head.relationshipId);
    const revisions = yield* transaction
      .select()
      .from(productRelationshipRevisions)
      .where(
        and(
          eq(productRelationshipRevisions.tenantId, tenantId),
          inArray(productRelationshipRevisions.relationshipId, ids),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    return yield* Effect.forEach(heads, (head) => readHead(head, revisions, tenantId, at), { concurrency: 1 });
  });
  const query = Effect.fn('ProductRelationshipReads.query')(function* query(
    endpoint: ProductRelationshipEndpoint,
    at: string,
    direction: 'forward' | 'reverse',
  ) {
    if (!validEndpoint(endpoint, tenantId) || !validInstant(at)) {
      return yield* unavailable();
    }
    let column;
    if (direction === 'forward') {
      column =
        endpoint.resourceType === product ? productRelationships.sourceProductId : productRelationships.sourceVariantId;
    } else {
      column =
        endpoint.resourceType === product ? productRelationships.targetProductId : productRelationships.targetVariantId;
    }
    const heads = yield* readHeads(eq(column, endpoint.resourceId));
    return yield* assemble(heads, at);
  });
  return {
    forward: (endpoint, at) => query(endpoint, at, 'forward'),
    get: Effect.fn('ProductRelationshipReads.get')(function* get(relationshipId, at) {
      if (!validInstant(at)) {
        return yield* unavailable();
      }
      const heads = yield* readHeads(eq(productRelationships.relationshipId, relationshipId));
      const rows = yield* assemble(heads, at);
      const [first] = rows;
      return Option.fromNullishOr(first);
    }),
    history: Effect.fn('ProductRelationshipReads.history')(function* history(relationshipId) {
      const heads = yield* readHeads(eq(productRelationships.relationshipId, relationshipId));
      const [head] = heads;
      if (head === undefined) {
        return [];
      }
      const revisions = yield* transaction
        .select()
        .from(productRelationshipRevisions)
        .where(
          and(
            eq(productRelationshipRevisions.tenantId, tenantId),
            eq(productRelationshipRevisions.relationshipId, relationshipId),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      const ordered = orderedHistory(revisions, head);
      if (head.tenantId !== tenantId || ordered === null) {
        return yield* unavailable();
      }
      return yield* Effect.forEach(ordered, (row) => snapshot(row, tenantId), { concurrency: 1 });
    }),
    reverse: (endpoint, at) => query(endpoint, at, 'reverse'),
  };
};
