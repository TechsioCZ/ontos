import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { assignCatalogMediaAction } from '../../src/actions/assign-catalog-media.action.ts';
import { reorderCatalogMediaAction } from '../../src/actions/reorder-catalog-media.action.ts';
import { removeCatalogMediaAction } from '../../src/actions/remove-catalog-media.action.ts';
import { setProductLocalizedFactsAction } from '../../src/actions/set-product-localized-facts.action.ts';
import { removeProductLocalizedFactsAction } from '../../src/actions/remove-product-localized-facts.action.ts';
import { setVariantLocalizedFactsAction } from '../../src/actions/set-variant-localized-facts.action.ts';
import { removeVariantLocalizedFactsAction } from '../../src/actions/remove-variant-localized-facts.action.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';

/* oxlint-disable sonarjs/no-nested-functions -- The focused transaction mock reproduces Drizzle's nested insert builder. owner: Catalog #478; remove with a shared transaction fixture. expires: 2027-03-31. */

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:descriptive-snapshot-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'descriptive-snapshot-test',
};
const actionInvocationId = '00000000-0000-4000-8000-000000000003';

describe('Catalog descriptive Action result capture', () => {
  it.effect('fails the decoded-success hook when its transactional snapshot write fails', () =>
    Effect.gen(function* rejectsSnapshotFailure() {
      const transaction = {
        insert: (table: typeof catalogResultSnapshots) => {
          expect(table).toBe(catalogResultSnapshots);
          return {
            values: () => ({
              onConflictDoNothing: () => ({
                returning: () => Effect.fail(new Error('snapshot storage unavailable')),
              }),
            }),
          };
        },
      };
      // @ts-expect-error Focused transaction mock implements only the failing snapshot insert chain.
      const services = yield* getActionServiceFactory(assignCatalogMediaAction)(transaction, scope);
      const hook = getActionDecodedSuccessHook(assignCatalogMediaAction);
      expect(hook).toBeDefined();
      if (hook !== undefined) {
        const failure = yield* Effect.flip(
          hook({ actionInvocationId, result: { assignmentId: actionInvocationId, setRevision: 2 }, scope, services }),
        );
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
    }),
  );

  it.effect('captures each media and localized-facts result with its exact identity in the supplied transaction', () =>
    Effect.gen(function* capturesResults() {
      const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
      const transaction = {
        insert: (table: typeof catalogResultSnapshots) => {
          expect(table).toBe(catalogResultSnapshots);
          return {
            values: (row: typeof catalogResultSnapshots.$inferInsert) => ({
              onConflictDoNothing: () => ({
                returning: () => {
                  rows.push(row);
                  return Effect.succeed([row]);
                },
              }),
            }),
          };
        },
      };
      for (const action of [assignCatalogMediaAction, reorderCatalogMediaAction, removeCatalogMediaAction] as const) {
        // @ts-expect-error Focused transaction mock implements only the snapshot insert chain.
        const services = yield* getActionServiceFactory(action)(transaction, scope);
        // @ts-expect-error Action tuple members have different payload schemas but the same result and hook contract.
        const hook = getActionDecodedSuccessHook(action);
        expect(hook).toBeDefined();
        if (hook !== undefined) {
          yield* hook({
            actionInvocationId,
            result: { assignmentId: actionInvocationId, setRevision: 2 },
            scope,
            services,
          });
        }
      }
      for (const action of [
        setProductLocalizedFactsAction,
        removeProductLocalizedFactsAction,
        setVariantLocalizedFactsAction,
        removeVariantLocalizedFactsAction,
      ] as const) {
        // @ts-expect-error Focused transaction mock implements only the snapshot insert chain.
        const services = yield* getActionServiceFactory(action)(transaction, scope);
        // @ts-expect-error Action tuple members have different payload schemas but the same result and hook contract.
        const hook = getActionDecodedSuccessHook(action);
        expect(hook).toBeDefined();
        if (hook !== undefined) {
          yield* hook({ actionInvocationId, result: { changed: true, revision: 2 }, scope, services });
        }
      }
      expect(
        rows.map(({ actionKey, encodedResult, schemaVersion }) => ({ actionKey, encodedResult, schemaVersion })),
      ).toEqual([
        ...['assign-catalog-media', 'reorder-catalog-media', 'remove-catalog-media'].map((name) => ({
          actionKey: `commerce.catalog.${name}`,
          encodedResult: { assignmentId: actionInvocationId, setRevision: 2 },
          schemaVersion: 1,
        })),
        ...[
          'set-product-localized-facts',
          'remove-product-localized-facts',
          'set-variant-localized-facts',
          'remove-variant-localized-facts',
        ].map((name) => ({
          actionKey: `commerce.catalog.${name}`,
          encodedResult: { changed: true, revision: 2 },
          schemaVersion: 1,
        })),
      ]);
    }),
  );
});
