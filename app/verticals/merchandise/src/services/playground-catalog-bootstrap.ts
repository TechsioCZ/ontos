import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Config, DateTime, Effect, Predicate, Schema } from 'effect';
import type { BootstrapPlaygroundCatalogPayloadSchema } from '../../shared/actions/bootstrap-playground-catalog.ts';
import {
  BootstrapCheckpointSchema,
  PLAYGROUND_COMPANY,
  PLAYGROUND_MANIFEST_DIGEST,
  PLAYGROUND_SOURCE_FINGERPRINT,
  PLAYGROUND_TENANT,
  bootstrapBatchNeedsAppend,
  bootstrapDigest,
  bootstrapRejected,
} from '../../shared/domain/playground-catalog-bootstrap.ts';
import type { BootstrapBatch, BootstrapCheckpoint } from '../../shared/domain/playground-catalog-bootstrap.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { MerchandisePersistenceUnavailable } from '../../shared/errors/merchandise-persistence-unavailable.ts';
import {
  catalogHeads,
  categories,
  marketProductOffers,
  marketSettings,
  orders,
  priceTiers,
  products,
  productVariants,
  stockMovements,
} from '../database/schema.ts';
import { currentRatesOf, insertSnapshotPart, query, whereScope } from './merchandise-store.ts';

type Payload = typeof BootstrapPlaygroundCatalogPayloadSchema.Type;
const unavailable = <Cause>(cause: Cause) =>
  Object.defineProperty(
    new MerchandisePersistenceUnavailable({
      code: 'merchandise_persistence_unavailable',
      reason: 'Catalog bootstrap storage is temporarily unavailable',
    }),
    'cause',
    { enumerable: false, value: cause },
  );
const decodeCheckpoint = <Value>(value: Value) =>
  Schema.decodeUnknownEffect(BootstrapCheckpointSchema)(value).pipe(
    Effect.mapError((cause) => bootstrapRejected('Target has no matching resumable import', cause)),
  );

/** Owner transaction port. The Action commits rows and checkpoint together, or rolls both back. */
export interface BootstrapTransaction {
  readonly append: (
    batch: BootstrapBatch,
    index: number,
    invocationId: string,
  ) => Effect.Effect<void, BootstrapFailure>;
  readonly begin: (manifest: BootstrapCheckpoint['manifest']) => Effect.Effect<BootstrapCheckpoint, BootstrapFailure>;
  readonly checkpoint: () => Effect.Effect<BootstrapCheckpoint, BootstrapFailure>;
  readonly save: (checkpoint: BootstrapCheckpoint) => Effect.Effect<void, BootstrapFailure>;
  readonly verify: (checkpoint: BootstrapCheckpoint) => Effect.Effect<void, BootstrapFailure>;
}
type BootstrapFailure = ReturnType<typeof bootstrapRejected> | MerchandisePersistenceUnavailable;

export const runPlaygroundBootstrap = Effect.fn('Merchandise.runPlaygroundBootstrap')(function* runBootstrap(
  transaction: BootstrapTransaction,
  payload: Payload,
  invocationId: string,
) {
  let checkpoint: BootstrapCheckpoint;
  if (Predicate.isTagged(payload, 'Begin')) {
    if ((yield* bootstrapDigest(payload.manifest)) !== PLAYGROUND_MANIFEST_DIGEST) {
      return yield* bootstrapRejected('Manifest differs from the approved frozen source');
    }
    checkpoint = yield* transaction.begin(payload.manifest);
    if ((yield* bootstrapDigest(checkpoint.manifest)) !== PLAYGROUND_MANIFEST_DIGEST) {
      return yield* bootstrapRejected('Target belongs to another import');
    }
  } else {
    checkpoint = yield* transaction.checkpoint();
    if ((yield* bootstrapDigest(checkpoint.manifest)) !== PLAYGROUND_MANIFEST_DIGEST) {
      return yield* bootstrapRejected('Persisted import does not match the frozen source');
    }
    if (Predicate.isTagged(payload, 'Batch')) {
      if (yield* bootstrapBatchNeedsAppend(checkpoint, payload.index, payload.batch)) {
        yield* transaction.append(payload.batch, payload.index, invocationId);
        checkpoint = { ...checkpoint, nextBatch: checkpoint.nextBatch + 1 };
        yield* transaction.save(checkpoint);
      }
    } else {
      if (checkpoint.nextBatch !== checkpoint.manifest.batchDigests.length) {
        return yield* bootstrapRejected('Catalog import is incomplete');
      }
      // Check rows again on a retry, not just the retained completion flag.
      yield* transaction.verify(checkpoint);
      if (checkpoint.status !== 'VERIFIED') {
        checkpoint = { ...checkpoint, status: 'VERIFIED' };
        yield* transaction.save(checkpoint);
      }
    }
  }
  return {
    nextBatch: checkpoint.nextBatch,
    sourceFingerprint: PLAYGROUND_SOURCE_FINGERPRINT,
    status: checkpoint.status,
  } as const;
});

interface BootstrapActor {
  readonly authMethod?: string | undefined;
  readonly legalEntityId?: string | undefined;
  readonly tenantId?: string | undefined;
}
export const assertPlaygroundBootstrapScope = (scope: BootstrapActor, environment: string) =>
  environment === 'stage' &&
  scope.tenantId === PLAYGROUND_TENANT &&
  scope.legalEntityId === PLAYGROUND_COMPANY &&
  scope.authMethod === 'session'
    ? Effect.void
    : Effect.fail(bootstrapRejected('Bootstrap requires the stage playground administrator session'));

/** Native opening movements feed the same stock projection as ordinary merchandise writes. */
export const bootstrapStateForBatch = (batch: BootstrapBatch, index: number, invocationId: string, at: DateTime.Utc) =>
  Schema.decodeUnknownEffect(MerchandiseStateSchema)({
    categories: batch.categories,
    movements: batch.products.flatMap(({ product, stock }, productIndex) =>
      stock.map(({ quantity, variantId }, stockIndex) => {
        const movement = {
          at: DateTime.formatIso(at),
          delta: quantity,
          id: `${invocationId}:bootstrap:${index}:${productIndex}:${stockIndex}`,
          note: 'Opening balance from approved frozen AKROS source',
          productId: product.id,
          reason: 'ADJUSTMENT',
        };
        return variantId === undefined ? movement : { ...movement, variantId };
      }),
    ),
    orders: [],
    products: batch.products.map(({ product }) => product),
  }).pipe(Effect.mapError((cause) => bootstrapRejected('Bootstrap data does not match the merchandise model', cause)));

export const playgroundBootstrapServices = Effect.fn('Merchandise.playgroundBootstrapServices')(function* makeServices(
  db: ScopedTransactionExecutor,
  scope: OperationalScope,
) {
  const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
    Config.withDefault(''),
    Effect.mapError((cause) =>
      Object.defineProperty(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Bootstrap environment is unavailable',
        }),
        'cause',
        { enumerable: false, value: cause },
      ),
    ),
  );
  const store = { legalEntityId: PLAYGROUND_COMPANY, tenantId: PLAYGROUND_TENANT };
  const readHead = () =>
    query(db.select().from(catalogHeads).where(whereScope(catalogHeads, store)).limit(1).for('update')).pipe(
      Effect.mapError(unavailable),
    );
  const checkpoint = Effect.fn('Merchandise.bootstrapCheckpoint')(function* readCheckpoint() {
    const [head] = yield* readHead();
    return yield* decodeCheckpoint(head?.bootstrapCheckpoint);
  });
  const begin: BootstrapTransaction['begin'] = Effect.fn('Merchandise.beginBootstrap')(function* begin(manifest) {
    const initial: BootstrapCheckpoint = { manifest, nextBatch: 0, status: 'IMPORTING' };
    const inserted = yield* query(
      db
        .insert(catalogHeads)
        .values({ ...store, bootstrapCheckpoint: initial, revision: 0 })
        .onConflictDoNothing()
        .returning({ revision: catalogHeads.revision }),
    ).pipe(Effect.mapError(unavailable));
    if (inserted.length === 0) {
      return yield* checkpoint();
    }
    // Includes orphaned rows and markets, not just products or the head. Rejection rolls back the claim.
    yield* Effect.forEach(
      [products, productVariants, priceTiers, categories, stockMovements, orders, marketSettings, marketProductOffers],
      Effect.fn('Merchandise.assertBootstrapTableEmpty')(function* checkEmpty(table) {
        const existing = yield* query(
          db.select({ tenantId: table.tenantId }).from(table).where(whereScope(table, store)).limit(1),
        ).pipe(Effect.mapError(unavailable));
        if (existing.length > 0) {
          return yield* bootstrapRejected('Target merchandise is not empty');
        }
        return yield* Effect.void;
      }),
      { concurrency: 1, discard: true },
    );
    return initial;
  });
  const save: BootstrapTransaction['save'] = (state) => {
    const fields =
      state.status === 'VERIFIED'
        ? {
            bootstrapCheckpoint: state,
            homepageFeaturedProductIds: [...state.manifest.homepageFeaturedProductIds],
            revision: 1,
          }
        : { bootstrapCheckpoint: state };
    return query(db.update(catalogHeads).set(fields).where(whereScope(catalogHeads, store))).pipe(
      Effect.asVoid,
      Effect.mapError(unavailable),
    );
  };
  const append: BootstrapTransaction['append'] = Effect.fn('Merchandise.appendBootstrap')(
    function* append(batch, index, invocationId) {
      // Imported prices without a stored gross are entered at the company's current rates (none before its first sync).
      const { rates, state } = yield* bootstrapStateForBatch(batch, index, invocationId, yield* DateTime.now).pipe(
        Effect.flatMap((built) =>
          currentRatesOf(db, store).pipe(
            Effect.mapError(unavailable),
            Effect.map((priced) => ({ rates: priced, state: built })),
          ),
        ),
      );
      yield* insertSnapshotPart(db, store, state, rates).pipe(Effect.mapError(unavailable));
    },
  );
  const verify: BootstrapTransaction['verify'] = Effect.fn('Merchandise.verifyBootstrap')(function* verify(state) {
    yield* Effect.forEach(
      [
        [categories, state.manifest.categories],
        [products, state.manifest.products],
        [productVariants, state.manifest.variants],
        [orders, 0],
      ] as const,
      Effect.fn('Merchandise.verifyBootstrapCount')(function* checkCount([table, expected]) {
        const [row] = yield* query(
          db
            .select({ count: sql<number>`count(*)::integer` })
            .from(table)
            .where(whereScope(table, store)),
        ).pipe(Effect.mapError(unavailable));
        if (row?.count !== expected) {
          return yield* bootstrapRejected('Persisted catalog counts differ from the frozen source');
        }
        return yield* Effect.void;
      }),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      state.manifest.homepageFeaturedProductIds,
      Effect.fn('Merchandise.verifyBootstrapFeatured')(function* checkFeatured(id) {
        const rows = yield* query(
          db
            .select({ id: products.id })
            .from(products)
            .where(sql`${whereScope(products, store)} and ${eq(products.id, id)}`)
            .limit(1),
        ).pipe(Effect.mapError(unavailable));
        if (rows.length !== 1) {
          return yield* bootstrapRejected('A featured product is missing');
        }
        return yield* Effect.void;
      }),
      { concurrency: 1, discard: true },
    );
  });
  const transaction: BootstrapTransaction = { append, begin, checkpoint, save, verify };
  return {
    bootstrap: (payload: Payload, invocationId: string) =>
      assertPlaygroundBootstrapScope(scope, environment).pipe(
        Effect.andThen(runPlaygroundBootstrap(transaction, payload, invocationId)),
      ),
  };
});
