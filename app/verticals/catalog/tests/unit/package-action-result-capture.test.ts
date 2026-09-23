import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { activatePackageDefinitionAction } from '../../src/actions/activate-package-definition.action.ts';
import { activatePackageOptionAction } from '../../src/actions/activate-package-option.action.ts';
import { createPackageDefinitionAction } from '../../src/actions/create-package-definition.action.ts';
import { retirePackageDefinitionAction } from '../../src/actions/retire-package-definition.action.ts';
import { retirePackageOptionAction } from '../../src/actions/retire-package-option.action.ts';
import { revisePackageDefinitionAction } from '../../src/actions/revise-package-definition.action.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:package-snapshot-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'package-snapshot-test',
};
const actionInvocationId = '00000000-0000-4000-8000-000000000003';
const definitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '00000000-0000-4000-8000-000000000004',
  resourceType: 'commerce.catalog.package-definition',
  tenantId: scope.tenantId,
} as const;
const contentRevision = {
  resourceRef: definitionRef,
  revision: Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(2),
};
const definitions = [
  ['create-package-definition', createPackageDefinitionAction],
  ['revise-package-definition', revisePackageDefinitionAction],
  ['activate-package-definition', activatePackageDefinitionAction],
  ['retire-package-definition', retirePackageDefinitionAction],
] as const;
const options = [
  ['activate-package-option', activatePackageOptionAction],
  ['retire-package-option', retirePackageOptionAction],
] as const;

const storeRow =
  (rows: (typeof catalogResultSnapshots.$inferInsert)[], row: typeof catalogResultSnapshots.$inferInsert) => () => {
    rows.push(row);
    return Effect.succeed([row]);
  };
const snapshotTransaction = (rows: (typeof catalogResultSnapshots.$inferInsert)[]) => ({
  insert: (table: typeof catalogResultSnapshots) => {
    expect(table).toBe(catalogResultSnapshots);
    return {
      values: (row: typeof catalogResultSnapshots.$inferInsert) => ({
        onConflictDoNothing: () => ({ returning: storeRow(rows, row) }),
      }),
    };
  },
});
const failedSnapshotTransaction = {
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning: () => Effect.fail(new Error('snapshot storage unavailable')) }),
    }),
  }),
};

describe('Package Action result capture', () => {
  it.effect('stores exact decoded results and Action identities in the supplied transaction', () =>
    Effect.gen(function* capturesPackageResults() {
      const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
      const transaction = snapshotTransaction(rows);
      for (const [, action] of definitions) {
        // @ts-expect-error Focused transaction mock implements only the snapshot insert chain.
        const services = yield* getActionServiceFactory(action)(transaction, scope);
        // @ts-expect-error Heterogeneous Action tuple; each result is paired with its Action below.
        const hook = getActionDecodedSuccessHook(action);
        expect(hook).toBeDefined();
        if (hook !== undefined) {
          yield* hook({ actionInvocationId, result: { contentRevision, definitionRef }, scope, services });
        }
      }
      for (const [name, action] of options) {
        // @ts-expect-error Focused transaction mock implements only the snapshot insert chain.
        const services = yield* getActionServiceFactory(action)(transaction, scope);
        const hook = getActionDecodedSuccessHook(action);
        expect(hook).toBeDefined();
        if (hook !== undefined) {
          yield* hook({
            actionInvocationId,
            result: {
              contentRevision,
              definitionRef,
              optionRevision: 3,
              state: name === 'activate-package-option' ? 'ACTIVE' : 'RETIRED',
            },
            scope,
            services,
          });
        }
      }
      expect(rows.map(({ actionKey, schemaVersion }) => ({ actionKey, schemaVersion }))).toEqual(
        [...definitions, ...options].map(([name]) => ({ actionKey: `commerce.catalog.${name}`, schemaVersion: 1 })),
      );
      expect(
        rows
          .slice(0, 4)
          .every((row) => Schema.is(Schema.Struct({ contentRevision: Schema.Unknown }))(row.encodedResult)),
      ).toBe(true);
      expect(rows.slice(4).map((row) => row.encodedResult)).toMatchObject([
        { optionRevision: 3, state: 'ACTIVE' },
        { optionRevision: 3, state: 'RETIRED' },
      ]);
    }),
  );

  it.effect('fails the decoded-success hook if snapshot storage fails', () =>
    Effect.gen(function* rejectsSnapshotFailure() {
      const transaction = failedSnapshotTransaction;
      // @ts-expect-error Focused transaction mock implements only the failing snapshot insert chain.
      const services = yield* getActionServiceFactory(createPackageDefinitionAction)(transaction, scope);
      const hook = getActionDecodedSuccessHook(createPackageDefinitionAction);
      expect(hook).toBeDefined();
      if (hook !== undefined) {
        const failure = yield* Effect.flip(
          hook({ actionInvocationId, result: { contentRevision, definitionRef }, scope, services }),
        );
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
    }),
  );
});
