import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { createAttributeDefinitionAction } from '../../src/actions/create-attribute-definition.action.ts';
import { createControlledAttributeValueAction } from '../../src/actions/create-controlled-attribute-value.action.ts';
import { reactivateControlledAttributeValueAction } from '../../src/actions/reactivate-controlled-attribute-value.action.ts';
import { removeProductAttributeValuesAction } from '../../src/actions/remove-product-attribute-values.action.ts';
import { removeVariantAttributeOverrideAction } from '../../src/actions/remove-variant-attribute-override.action.ts';
import { renameAttributeDefinitionAction } from '../../src/actions/rename-attribute-definition.action.ts';
import { renameControlledAttributeValueAction } from '../../src/actions/rename-controlled-attribute-value.action.ts';
import { retireControlledAttributeValueAction } from '../../src/actions/retire-controlled-attribute-value.action.ts';
import { setProductAttributeValuesAction } from '../../src/actions/set-product-attribute-values.action.ts';
import { setVariantAttributeOverrideAction } from '../../src/actions/set-variant-attribute-override.action.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:attribute-snapshot-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'attribute-snapshot-test',
};
const actionInvocationId = '00000000-0000-4000-8000-000000000003';
const ref = (resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId: '00000000-0000-4000-8000-000000000004',
  resourceType,
  tenantId: scope.tenantId,
});
const definitionRef = {
  ...ref('commerce.catalog.attribute-definition'),
  resourceType: 'commerce.catalog.attribute-definition' as const,
};
const controlledValueRef = ref('commerce.catalog.controlled-attribute-value');
const revision = Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(1);
const cases = [
  [
    'create-attribute-definition',
    createAttributeDefinitionAction,
    { attributeDefinitionRef: definitionRef, revision: 1 },
  ],
  [
    'rename-attribute-definition',
    renameAttributeDefinitionAction,
    { attributeDefinitionRef: definitionRef, changed: true, revision },
  ],
  ['create-controlled-attribute-value', createControlledAttributeValueAction, { controlledValueRef, revision: 1 }],
  [
    'rename-controlled-attribute-value',
    renameControlledAttributeValueAction,
    { changed: true, controlledValueRef, revision },
  ],
  [
    'retire-controlled-attribute-value',
    retireControlledAttributeValueAction,
    { changed: true, controlledValueRef, lifecycle: 'RETIRED', revision },
  ],
  [
    'reactivate-controlled-attribute-value',
    reactivateControlledAttributeValueAction,
    { changed: true, controlledValueRef, lifecycle: 'ACTIVE', revision },
  ],
  [
    'set-product-attribute-values',
    setProductAttributeValuesAction,
    { attributeValueSetId: actionInvocationId, revision: 1, state: 'SET' },
  ],
  [
    'remove-product-attribute-values',
    removeProductAttributeValuesAction,
    { attributeValueSetId: actionInvocationId, revision: 1, state: 'REMOVED' },
  ],
  [
    'set-variant-attribute-override',
    setVariantAttributeOverrideAction,
    { attributeValueSetId: actionInvocationId, revision: 1, state: 'SET' },
  ],
  [
    'remove-variant-attribute-override',
    removeVariantAttributeOverrideAction,
    { attributeValueSetId: actionInvocationId, revision: 1, state: 'REMOVED' },
  ],
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
    values: () => ({ onConflictDoNothing: () => ({ returning: () => Effect.fail(new Error('unavailable')) }) }),
  }),
};

describe('Attribute Action result capture', () => {
  it.effect('stores each decoded result with its exact Action identity in the supplied transaction', () =>
    Effect.gen(function* capturesResults() {
      const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
      const transaction = snapshotTransaction(rows);
      for (const [name, action, result] of cases) {
        // @ts-expect-error Focused mock implements only the snapshot insert chain.
        const services = yield* getActionServiceFactory(action)(transaction, scope);
        // @ts-expect-error Heterogeneous Action tuple; the paired result is checked by the hook below.
        const hook = getActionDecodedSuccessHook(action);
        expect(hook).toBeDefined();
        if (hook !== undefined) {
          // @ts-expect-error Each tuple's result is paired with its corresponding Action schema.
          yield* hook({ actionInvocationId, result, scope, services });
        }
        expect(rows.at(-1)).toMatchObject({ actionKey: `commerce.catalog.${name}`, schemaVersion: 1 });
      }
      expect(rows).toHaveLength(cases.length);
    }),
  );

  it.effect('aborts decoded success when snapshot storage fails', () =>
    Effect.gen(function* rejectsStorageFailure() {
      const transaction = failedSnapshotTransaction;
      // @ts-expect-error Focused mock implements only the failing snapshot insert chain.
      const services = yield* getActionServiceFactory(createAttributeDefinitionAction)(transaction, scope);
      const hook = getActionDecodedSuccessHook(createAttributeDefinitionAction);
      expect(hook).toBeDefined();
      if (hook !== undefined) {
        const failure = yield* Effect.flip(
          hook({ actionInvocationId, result: { attributeDefinitionRef: definitionRef, revision }, scope, services }),
        );
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
    }),
  );
});
