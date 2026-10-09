import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import {
  ActionAlreadyCommitted,
  ActionRequestHashConflict,
  ActionRuntime,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';

import { CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import { mapCreateProductActionProblem } from '../../api/create-product-action-problems.ts';
import { recoverCreateProduct } from '../../src/api/create-product-recovery.read.ts';
import { catalogResultSnapshots, productRevisions, products, productVariants } from '../../src/database/schema.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import type { CatalogPersistence } from '../../src/persistence/catalog-persistence.ts';
// oxlint-disable sonarjs/no-nested-functions -- Focused Drizzle transaction mock needs the select/from/where/limit chain. owner: Catalog #478; expires: 2027-03-31.

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const invocationId = '33333333-3333-4333-8333-333333333333';
const productId = '44444444-4444-4444-8444-444444444444';
const variantId = '55555555-5555-4555-8555-555555555555';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const result = Schema.decodeUnknownSync(CreateProductResultSchema)({
  classification: { kind: 'INDEPENDENT_PRODUCT' },
  product: {
    catalogReady: false,
    createdAt: '2026-09-17T10:00:00.000Z',
    lifecycle: 'DRAFT',
    name: 'Original',
    productRef,
    revision: 1,
    updatedAt: '2026-09-17T10:00:00.000Z',
    variants: [
      {
        lifecycle: 'WORK_IN_PROGRESS',
        productRef,
        variantId,
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: variantId,
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
    ],
  },
  variantId,
});
const scope = {
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:test',
  authMethod: 'session' as const,
  correlationId: 'test',
  principalId,
  tenantId,
};
const runtime: ActionRuntimeService = {
  resolveActionCommit: () => Effect.die('recovery service owns the Core check'),
  runAction: () => Effect.die('unused'),
};
const services = (recover: CatalogPersistence['recoverCreateProduct']): CatalogPersistence => ({
  correct: () => Effect.die('unused'),
  create: () => Effect.die('unused'),
  getCreatedByInvocation: () => Effect.die('unused'),
  getCurrent: () => Effect.die('unused'),
  getHistory: () => Effect.die('unused'),
  reactivate: () => Effect.die('unused'),
  recoverCreateProduct: recover,
  recoverUpdateProduct: () => Effect.die('unused'),
  retire: () => Effect.die('unused'),
  update: () => Effect.die('unused'),
});

describe('create Product recovery', () => {
  it.effect('reconciles a lost create response to the original result without treating the retry as a new write', () =>
    Effect.gen(function* lostCreateResponse() {
      const retry = mapCreateProductActionProblem(
        new ActionAlreadyCommitted({
          code: 'action_already_committed',
          invocationId,
          reason: 'The original create committed',
        }),
      );
      expect(retry).toMatchObject({
        invocationId,
        resolution: 'RECOVER_CREATE_PRODUCT',
        retryCommand: false,
        status: 409,
      });

      let recoveryCalls = 0;
      const recovered = yield* recoverCreateProduct(
        { invocationId },
        {
          readKey: 'commerce.catalog.api.create-product-recovery',
          scope,
          services: services((id) => {
            recoveryCalls += 1;
            expect(id).toBe(invocationId);
            return Effect.succeed({ result, status: 'committed' });
          }),
        },
      ).pipe(Effect.provideService(ActionRuntime, runtime));
      expect(recovered).toEqual(result);
      expect(recoveryCalls).toBe(1);

      const changedPayload = mapCreateProductActionProblem(
        new ActionRequestHashConflict({
          code: 'action_request_hash_conflict',
          reason: 'The idempotency key belongs to a different create intent',
        }),
      );
      expect(changedPayload.status).toBe(409);
      expect('resolution' in changedPayload).toBe(false);
      expect('invocationId' in changedPayload).toBe(false);
    }),
  );
  it.effect('returns the immutable committed snapshot', () =>
    Effect.gen(function* recoverCommittedCreateCase() {
      const recovered = yield* recoverCreateProduct(
        { invocationId },
        {
          readKey: 'commerce.catalog.api.create-product-recovery',
          scope,
          services: services((id) => {
            expect(id).toBe(invocationId);
            return Effect.succeed({ result, status: 'committed' });
          }),
        },
      ).pipe(Effect.provideService(ActionRuntime, runtime));
      expect(recovered).toEqual(result);
    }),
  );

  for (const status of ['absent', 'rejected', 'open', 'indeterminate', 'unavailable'] as const) {
    it.effect(`maps ${status} without returning a mutable Product`, () =>
      Effect.gen(function* recoverNoncommittedCreateCase() {
        const failure = yield* recoverCreateProduct(
          { invocationId },
          {
            readKey: 'commerce.catalog.api.create-product-recovery',
            scope,
            services: services(() => Effect.succeed({ status })),
          },
        ).pipe(Effect.provideService(ActionRuntime, runtime), Effect.flip);
        expect(Schema.is(status === 'absent' ? ReadHandlerNotFound : ReadHandlerUnavailable)(failure)).toBe(true);
      }),
    );
  }
});

const committedRuntime: ActionRuntimeService = {
  resolveActionCommit: () =>
    Effect.fail(
      new ActionAlreadyCommitted({
        code: 'action_already_committed',
        invocationId,
        reason: 'The original create committed',
      }),
    ),
  runAction: () => Effect.die('Recovery must never replay the create Action'),
};

const canonicalCreateRows = () => {
  const recordedAt = new Date('2026-09-17T10:00:00.000Z');
  return {
    created: {
      createdAt: recordedAt,
      createdByActionInvocationId: invocationId,
      createdByPrincipalId: principalId,
      currentRevision: 1,
      description: null,
      lifecycleState: 'DRAFT',
      name: 'Original',
      productId,
      retiredEffectiveAt: null,
      retiredReason: null,
      tenantId,
      updatedAt: recordedAt,
    },
    revision: {
      actingPrincipalId: principalId,
      actionInvocationId: invocationId,
      changeKind: 'CREATED',
      description: null,
      evidenceRefs: [],
      lifecycleState: 'DRAFT',
      name: 'Original',
      productId,
      productRevisionId: '77777777-7777-4777-8777-777777777777',
      reason: 'Create Product',
      recordedAt,
      revision: 1,
      tenantId,
    },
    variant: {
      combinationAxisRevision: null,
      combinationKey: null,
      createdAt: recordedAt,
      createdByActionInvocationId: invocationId,
      createdByPrincipalId: principalId,
      currentRevision: 1,
      lifecycleState: 'WORK_IN_PROGRESS',
      productId,
      tenantId,
      updatedAt: recordedAt,
      variantId,
    },
  };
};

type CanonicalCreateRows = ReturnType<typeof canonicalCreateRows>;
type CatalogTable = typeof catalogResultSnapshots | typeof products | typeof productRevisions | typeof productVariants;

interface SnapshotRow {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly encodedResult: object;
  readonly schemaVersion: number;
  readonly tenantId: string;
}

const reconciliationTransaction = (rows?: CanonicalCreateRows, snapshot?: SnapshotRow) => {
  let snapshotReads = 0;
  const limit = (table: CatalogTable) => {
    if (table === catalogResultSnapshots) {
      snapshotReads += 1;
      return Effect.succeed(snapshot === undefined ? [] : [snapshot]);
    }
    if (rows === undefined) {
      return Effect.succeed([]);
    }
    if (table === products) {
      return Effect.succeed([rows.created]);
    }
    if (table === productRevisions) {
      return Effect.succeed([rows.revision]);
    }
    if (table === productVariants) {
      return Effect.succeed([rows.variant]);
    }
    return Effect.die('unexpected Catalog table');
  };
  const transaction = {
    select: () => ({
      from: (table: CatalogTable) => ({
        where: () => ({
          limit: () => limit(table),
        }),
      }),
    }),
  };
  return {
    get snapshotReads() {
      return snapshotReads;
    },
    transaction,
  };
};

describe('create Product exact result recovery (#415/#478)', () => {
  it.effect('recovers the exact v2 Product result including its creation classification', () =>
    Effect.gen(function* reconcileLostCreate() {
      const encodedResult = yield* Schema.encodeEffect(CreateProductResultSchema)(result);
      const mock = reconciliationTransaction(undefined, {
        actingPrincipalId: principalId,
        actionInvocationId: invocationId,
        actionKey: 'commerce.catalog.create-product',
        encodedResult,
        schemaVersion: 2,
        tenantId,
      });
      const persistence = yield* catalogPersistenceForScope(
        // @ts-expect-error Focused mock implements only snapshot and canonical-row select chains.
        mock.transaction,
        scope,
      );
      const recovery = yield* persistence
        .recoverCreateProduct(invocationId)
        .pipe(Effect.provideService(ActionRuntime, committedRuntime));
      expect(recovery).toEqual({ result, status: 'committed' });
      expect(recovery).toMatchObject({ result: { classification: { kind: 'INDEPENDENT_PRODUCT' } } });
      expect(mock.snapshotReads).toBe(2);
    }),
  );

  it.effect('recovers an explicit legacy v1 Product result without manufacturing a classification', () =>
    Effect.gen(function* recoverLegacyCreate() {
      const { classification: _classification, ...legacyResult } = result;
      const encodedResult = yield* Schema.encodeEffect(CreateProductResultSchema)(legacyResult);
      const mock = reconciliationTransaction(undefined, {
        actingPrincipalId: principalId,
        actionInvocationId: invocationId,
        actionKey: 'commerce.catalog.create-product',
        encodedResult,
        schemaVersion: 1,
        tenantId,
      });
      const persistence = yield* catalogPersistenceForScope(
        // @ts-expect-error Focused mock implements only snapshot select chains.
        mock.transaction,
        scope,
      );
      const recovery = yield* persistence
        .recoverCreateProduct(invocationId)
        .pipe(Effect.provideService(ActionRuntime, committedRuntime));
      expect(recovery).toEqual({ result: legacyResult, status: 'committed' });
      expect(mock.snapshotReads).toBe(3);
    }),
  );

  it.effect('does not invent a classification from canonical Product rows when the v2 snapshot is missing', () =>
    Effect.gen(function* rejectIncompleteFallback() {
      const mock = reconciliationTransaction(canonicalCreateRows());
      const persistence = yield* catalogPersistenceForScope(
        // @ts-expect-error Focused mock implements only snapshot and canonical-row select chains.
        mock.transaction,
        scope,
      );
      const recovery = yield* persistence
        .recoverCreateProduct(invocationId)
        .pipe(Effect.provideService(ActionRuntime, committedRuntime));
      expect(recovery).toEqual({ status: 'unavailable' });
      expect(mock.snapshotReads).toBe(2);
    }),
  );

  it.effect(
    'keeps a committed create without any canonical Product row indeterminate instead of inventing a result',
    () =>
      Effect.gen(function* missingCanonicalRow() {
        const persistence = yield* catalogPersistenceForScope(
          // @ts-expect-error Focused mock implements only snapshot and canonical-row select chains.
          reconciliationTransaction().transaction,
          scope,
        );
        const recovery = yield* persistence
          .recoverCreateProduct(invocationId)
          .pipe(Effect.provideService(ActionRuntime, committedRuntime));
        expect(recovery).toEqual({ status: 'unavailable' });
      }),
  );
});
