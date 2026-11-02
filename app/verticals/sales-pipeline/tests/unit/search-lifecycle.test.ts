import { ActionAlreadyCommitted } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { company, scope } from './search-fixtures.ts';

const principal = {
  ...scope,
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'session:search',
  authMethod: 'session',
  legalEntityId: company,
} as const;
it.effect('rebuild needs explicit execution AND tenant management; denial queues no message', () =>
  Effect.gen(function* test() {
    for (const [execution, management] of [
      ['allowed', 'allowed'],
      ['denied', 'allowed'],
      ['allowed', 'denied'],
    ] as const) {
      const harness = yield* makeActionTestHarness({ actionPermission: execution, tenantPermission: management });
      const input = {
        payload: {},
        principal,
        registration: requestSearchRebuildAction,
        transport: { correlationId: 'rebuild', idempotencyKey: 'rebuild-test' },
      };
      const result = yield* harness.runtime.runAction(input).pipe(Effect.exit);
      const allowed = execution === 'allowed' && management === 'allowed';
      expect(Exit.isSuccess(result)).toBe(allowed);
      expect(harness.snapshot().committed).toHaveLength(allowed ? 1 : 0);
      if (allowed) {
        expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toMatchObject([
          {
            message: {
              producerModuleKey: 'demo.sales-pipeline',
              topic: 'demo.sales-pipeline.search-rebuild-requested.v1',
            },
          },
        ]);
        const replay = yield* harness.runtime.runAction(input).pipe(Effect.flip);
        expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
        expect(harness.snapshot().committed).toHaveLength(1);
      }
    }
  }),
);
