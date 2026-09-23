import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { createProductTypeAction } from '../../src/actions/create-product-type.action.ts';
import { reviseProductTypeAction } from '../../src/actions/revise-product-type.action.ts';
import { setProductTypeAction } from '../../src/actions/set-product-type.action.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-type-snapshot-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'product-type-snapshot-test',
};
const actionInvocationId = '00000000-0000-4000-8000-000000000003';
const productTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '00000000-0000-4000-8000-000000000004',
  resourceType: 'commerce.catalog.product-type',
  tenantId: scope.tenantId,
} as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '00000000-0000-4000-8000-000000000005',
  resourceType: 'commerce.catalog.product',
  tenantId: scope.tenantId,
} as const;

const returnSnapshotRow =
  (rows: (typeof catalogResultSnapshots.$inferInsert)[], row: typeof catalogResultSnapshots.$inferInsert) => () => {
    rows.push(row);
    return Effect.succeed([row]);
  };

const successfulSnapshotTransaction = (rows: (typeof catalogResultSnapshots.$inferInsert)[]) => ({
  insert: (table: typeof catalogResultSnapshots) => {
    expect(table).toBe(catalogResultSnapshots);
    return {
      values: (row: typeof catalogResultSnapshots.$inferInsert) => ({
        onConflictDoNothing: () => ({
          returning: returnSnapshotRow(rows, row),
        }),
      }),
    };
  },
});

const failedSnapshotTransaction = {
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning: () => Effect.fail(new Error('database unavailable')) }),
    }),
  }),
};

describe('Product Type Action result capture', () => {
  it.effect('captures exact decoded results under each declared Action identity', () =>
    Effect.gen(function* captureResults() {
      const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
      const transaction = successfulSnapshotTransaction(rows);
      const cases = [
        [createProductTypeAction, { productTypeRef, revision: 1 }],
        [
          reviseProductTypeAction,
          { effectiveFrom: '2026-09-18T10:00:00.000Z', productTypeRef, revision: 2, unresolvedProductRefs: [] },
        ],
        [
          setProductTypeAction,
          { currentProductTypeRef: productTypeRef, productRef, revision: 2, unresolvedProductRefs: [] },
        ],
      ] as const;
      for (const [action, result] of cases) {
        // @ts-expect-error The focused transaction mock implements only the snapshot insert chain.
        const services = yield* getActionServiceFactory(action)(transaction, scope);
        // @ts-expect-error Union of distinct Action result schemas cannot satisfy one registration generic.
        const hook = getActionDecodedSuccessHook(action);
        expect(hook).toBeDefined();
        if (hook !== undefined) {
          // @ts-expect-error Each result matches its corresponding Action in the cases tuple.
          yield* hook({ actionInvocationId, result, scope, services });
        }
      }
      expect(rows.map(({ actionKey, schemaVersion }) => ({ actionKey, schemaVersion }))).toEqual([
        { actionKey: 'commerce.catalog.create-product-type', schemaVersion: 1 },
        { actionKey: 'commerce.catalog.revise-product-type', schemaVersion: 1 },
        { actionKey: 'commerce.catalog.set-product-type', schemaVersion: 1 },
      ]);
      expect(rows.map(({ encodedResult }) => encodedResult)).toEqual(cases.map(([, result]) => result));
    }),
  );

  it.effect('fails the success hook when the snapshot write fails', () =>
    Effect.gen(function* rejectCaptureFailure() {
      const transaction = failedSnapshotTransaction;
      // @ts-expect-error The focused transaction mock implements only the failing snapshot insert chain.
      const services = yield* getActionServiceFactory(createProductTypeAction)(transaction, scope);
      const hook = getActionDecodedSuccessHook(createProductTypeAction);
      expect(hook).toBeDefined();
      if (hook !== undefined) {
        const failure = yield* Effect.flip(
          hook({
            actionInvocationId,
            result: Schema.decodeUnknownSync(createProductTypeAction.descriptor.resultSchema)({
              productTypeRef,
              revision: 1,
            }),
            scope,
            services,
          }),
        );
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
    }),
  );
});
