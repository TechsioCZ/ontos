import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRuntime } from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapUpdateProductActionProblem } from '../../api/update-product-action-problems.ts';
import { UpdateProductResultSchema } from '../../shared/actions/update-product.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
// oxlint-disable sonarjs/no-nested-functions -- Scoped Drizzle transaction mock needs the select/from/where/limit chain. owner: Catalog #478; expires: 2027-03-31.

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const invocationId = '33333333-3333-4333-8333-333333333333';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const result = Schema.decodeUnknownSync(UpdateProductResultSchema)({
  changed: true,
  product: {
    catalogReady: false,
    createdAt: '2026-09-17T10:00:00.000Z',
    lifecycle: 'DRAFT',
    name: 'Original update result',
    productRef,
    revision: 2,
    updatedAt: '2026-09-17T10:01:00.000Z',
    variants: [
      {
        lifecycle: 'WORK_IN_PROGRESS',
        productRef,
        variantId: '77777777-7777-4777-8777-777777777777',
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: '77777777-7777-4777-8777-777777777777',
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
    ],
  },
});
const scope = {
  authBindingId: '55555555-5555-4555-8555-555555555555',
  authContextRef: 'better-auth-session:update-recovery-test',
  authMethod: 'session' as const,
  correlationId: 'update-recovery-test',
  principalId,
  tenantId,
};
const snapshot = (overrides: Partial<typeof catalogResultSnapshots.$inferSelect> = {}) => ({
  actingPrincipalId: principalId,
  actionInvocationId: invocationId,
  actionKey: 'commerce.catalog.update-product',
  encodedResult: result,
  recordedAt: new Date('2026-09-17T10:01:00.000Z'),
  schemaVersion: 1,
  tenantId,
  ...overrides,
});
const recover = (row?: typeof catalogResultSnapshots.$inferSelect) => {
  let reads = 0;
  const transaction = {
    select: () => ({
      from: (table: typeof catalogResultSnapshots) => {
        expect(table).toBe(catalogResultSnapshots);
        return {
          where: () => ({
            limit: () => {
              reads += 1;
              return Effect.succeed(row === undefined ? [] : [row]);
            },
          }),
        };
      },
    }),
  };
  return {
    get reads() {
      return reads;
    },
    services: catalogPersistenceForScope(
      // @ts-expect-error Focused mock implements only snapshot reads.
      transaction,
      scope,
    ),
  };
};
const runtime = (resolution: ActionRuntimeService['resolveActionCommit']): ActionRuntimeService => ({
  resolveActionCommit: resolution,
  runAction: () => Effect.die('Recovery must never replay the Action'),
});
const committed = new ActionAlreadyCommitted({
  code: 'action_already_committed',
  invocationId,
  reason: 'Committed',
});

describe('Update Product immutable recovery', () => {
  it('directs committed and uncertain retries to recovery without replaying the command', () => {
    expect(mapUpdateProductActionProblem(committed)).toMatchObject({
      invocationId,
      resolution: 'RECOVER_UPDATE_PRODUCT',
      retryCommand: false,
      status: 409,
    });
    expect(
      mapUpdateProductActionProblem(
        new ActionCommitIndeterminate({
          code: 'action_commit_indeterminate',
          invocationId,
          reason: 'Unknown commit outcome',
        }),
      ),
    ).toMatchObject({ invocationId, resolution: 'RECOVER_UPDATE_PRODUCT', retryCommand: false, status: 503 });
  });

  it.effect('returns the original revision even if Current has since advanced', () =>
    Effect.gen(function* committedUpdate() {
      const test = recover(snapshot());
      const services = yield* test.services;
      const recovery = yield* services.recoverUpdateProduct(invocationId).pipe(
        Effect.provideService(
          ActionRuntime,
          runtime(() => Effect.fail(committed)),
        ),
      );
      expect(recovery).toEqual({ result, status: 'committed' });
      expect(test.reads).toBe(2);
    }),
  );

  it.effect('does not disclose another principal or Action and never guesses from a missing snapshot', () =>
    Effect.gen(function* scopedRecovery() {
      for (const [row, status] of [
        [snapshot({ actingPrincipalId: '66666666-6666-4666-8666-666666666666' }), 'absent'],
        [snapshot({ actionKey: 'commerce.catalog.create-product' }), 'absent'],
        [undefined, 'unavailable'],
      ] as const) {
        const services = yield* recover(row).services;
        const recovery = yield* services.recoverUpdateProduct(invocationId).pipe(
          Effect.provideService(
            ActionRuntime,
            runtime(() => Effect.fail(committed)),
          ),
        );
        expect(recovery.status).toBe(status);
      }
    }),
  );
});
