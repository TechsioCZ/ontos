import { ActionAlreadyCommitted, ActionRuntime, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { recoverCatalogActionResult } from '../../src/api/catalog-action-result-recovery.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';
import { catalogActionResultSnapshotForScope } from '../../src/persistence/catalog-action-result-snapshot.ts';
import { CatalogPersistenceConflict } from '../../src/persistence/errors.ts';

/* oxlint-disable sonarjs/no-nested-functions -- A scoped in-memory transaction exercises the immutable retry boundary. owner: Catalog #478; expires: 2027-03-31. */

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const identity = {
  actionInvocationId: '00000000-0000-4000-8000-000000000003',
  actionKey: 'commerce.catalog.create-product',
  schemaVersion: 1,
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:exact-recovery-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'exact-recovery-test',
};
const resultSchema = Schema.Struct({ productId: Schema.String.pipe(Schema.brand('ProductId')) });
const codec = {
  decode: Schema.decodeUnknownEffect(resultSchema),
  encode: Schema.encodeEffect(resultSchema),
};

const committed = new ActionAlreadyCommitted({
  code: 'action_already_committed',
  invocationId: identity.actionInvocationId,
  reason: 'committed',
});

const snapshotTransaction = () => {
  let stored: typeof catalogResultSnapshots.$inferInsert | undefined;
  let inserts = 0;
  const tx = {
    insert: (table: typeof catalogResultSnapshots) => {
      expect(table).toBe(catalogResultSnapshots);
      return {
        values: (row: typeof catalogResultSnapshots.$inferInsert) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              inserts += 1;
              if (stored !== undefined) {
                return Effect.succeed([]);
              }
              stored = row;
              return Effect.succeed([row]);
            },
          }),
        }),
      };
    },
    select: () => ({
      from: (table: typeof catalogResultSnapshots) => {
        expect(table).toBe(catalogResultSnapshots);
        return { where: () => ({ limit: () => Effect.succeed(stored === undefined ? [] : [stored]) }) };
      },
    }),
  };
  return {
    get inserts() {
      return inserts;
    },
    get stored() {
      return stored;
    },
    tx,
  };
};

describe('Catalog exact committed result recovery', () => {
  it.effect('returns the original result after Current changes, without replaying the Action', () =>
    Effect.gen(function* originalResult() {
      const database = snapshotTransaction();
      // @ts-expect-error This transaction implements only the snapshot query chains.
      const snapshots = catalogActionResultSnapshotForScope(database.tx, scope, codec);
      const originalProductId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('ProductId')))('original');
      const changedProductId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('ProductId')))(
        'new-current-value',
      );
      yield* snapshots.insert(identity, { productId: originalProductId });
      const currentProduct = { productId: changedProductId };
      let actionRuns = 0;
      let resolutions = 0;
      const runtime: ActionRuntimeService = {
        resolveActionCommit: () => {
          resolutions += 1;
          return Effect.fail(committed);
        },
        runAction: () => {
          actionRuns += 1;
          return Effect.die('Action must not replay');
        },
      };
      const recover = (requestedScope: typeof scope, requestedIdentity = identity) =>
        recoverCatalogActionResult(
          // @ts-expect-error This transaction implements only the snapshot query chains.
          database.tx,
          requestedScope,
          requestedIdentity,
          codec,
        ).pipe(Effect.provideService(ActionRuntime, runtime));

      expect(yield* recover(scope)).toEqual({ result: { productId: originalProductId }, status: 'committed' });
      expect(currentProduct.productId).toBe(changedProductId);
      expect(resolutions).toBe(1);
      expect(actionRuns).toBe(0);
      expect(database.inserts).toBe(1);

      const denied = [
        yield* recover({ ...scope, tenantId: '00000000-0000-4000-8000-000000000099' }),
        yield* recover({ ...scope, principalId: '00000000-0000-4000-8000-000000000099' }),
        yield* recover(scope, { ...identity, actionKey: 'commerce.catalog.other' }),
      ];
      expect(denied).toEqual([{ status: 'unavailable' }, { status: 'absent' }, { status: 'absent' }]);
      expect(yield* recover(scope, { ...identity, schemaVersion: 2 })).toEqual({ status: 'unavailable' });
      expect(actionRuns).toBe(0);

      const divergentProductId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('ProductId')))(
        'different-payload-result',
      );
      const conflict = yield* Effect.flip(snapshots.insert(identity, { productId: divergentProductId }));
      expect(Schema.is(CatalogPersistenceConflict)(conflict)).toBe(true);
      expect(database.stored?.encodedResult).toEqual({ productId: 'original' });
      expect(yield* recover(scope)).toEqual({ result: { productId: originalProductId }, status: 'committed' });
      expect(actionRuns).toBe(0);
    }),
  );
});
