import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { ConfigurationUnitRefSchema } from '../../shared/resources/configuration-unit.ts';
import { createConfigurationUnitAction } from '../../src/actions/create-configuration-unit.action.ts';
import { retireConfigurationUnitAction } from '../../src/actions/retire-configuration-unit.action.ts';
import { reviseConfigurationUnitAction } from '../../src/actions/revise-configuration-unit.action.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actionInvocationId = '44444444-4444-4444-8444-444444444444';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:configuration-unit-action-test:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'configuration-unit-action-test',
};
const unit = Schema.decodeUnknownSync(ConfigurationUnitRefSchema)({
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.unit',
  tenantId,
});
const actions = [createConfigurationUnitAction, reviseConfigurationUnitAction, retireConfigurationUnitAction] as const;
type SnapshotRow = typeof catalogResultSnapshots.$inferInsert;
const returnSnapshot = (rows: SnapshotRow[], row: SnapshotRow, fail: boolean) => () => {
  if (fail) {
    return Effect.fail(new Error('snapshot unavailable'));
  }
  rows.push(row);
  return Effect.succeed([row]);
};
const values = (rows: SnapshotRow[], fail: boolean) => (row: SnapshotRow) => ({
  onConflictDoNothing: () => ({ returning: returnSnapshot(rows, row, fail) }),
});
const transaction = (rows: SnapshotRow[], fail = false) => ({
  insert: (table: typeof catalogResultSnapshots) => {
    expect(table).toBe(catalogResultSnapshots);
    return { values: values(rows, fail) };
  },
});

describe('Configuration Unit decoded-success capture', () => {
  it.effect('captures exact owner Action identity and aborts on snapshot failure', () =>
    Effect.gen(function* capture() {
      for (const action of actions) {
        const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
        // @ts-expect-error Focused transaction mock implements the snapshot insert path only.
        const services = yield* getActionServiceFactory(action)(transaction(rows), scope);
        // @ts-expect-error Action tuple members have distinct payload schemas but the same result hook contract.
        const hook = getActionDecodedSuccessHook(action);
        expect(hook).toBeDefined();
        if (hook !== undefined) {
          yield* hook({ actionInvocationId, result: { revision: 2, unit }, scope, services });
        }
        expect(rows).toMatchObject([
          { actionKey: action.descriptor.actionKey, encodedResult: { revision: 2 }, schemaVersion: 1 },
        ]);
      }
      // @ts-expect-error Focused transaction mock implements the failing snapshot insert path only.
      const services = yield* getActionServiceFactory(createConfigurationUnitAction)(transaction([], true), scope);
      const hook = getActionDecodedSuccessHook(createConfigurationUnitAction);
      expect(hook).toBeDefined();
      if (hook !== undefined) {
        const failure = yield* Effect.flip(
          hook({ actionInvocationId, result: { revision: 2, unit }, scope, services }),
        );
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
    }),
  );
});
