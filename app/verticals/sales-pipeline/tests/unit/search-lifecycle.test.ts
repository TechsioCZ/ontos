import { ActionAlreadyCommitted } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { company, scope } from './search-fixtures.ts';
import { salesPipelineRegistration } from '../../vertical.registration.ts';

const principal = {
  ...scope,
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'session:search',
  authMethod: 'session',
  legalEntityId: company,
} as const;
const rebuildCapability = 'demo.sales-pipeline.request-search-rebuild.write';

it.effect(
  'only the registered rebuild capability admits execution; denial or unavailable authority queues nothing',
  () =>
    Effect.gen(function* test() {
      expect(requestSearchRebuildAction.descriptor.accessDeclaration?.key).toBe(rebuildCapability);
      for (const outcome of ['ALLOWED', 'DENIED', 'UNAVAILABLE', 'NEEDS_APPROVAL'] as const) {
        const gate = makeTestBoundAccessGate({ answers: { [rebuildCapability]: { outcome } } });
        const harness = yield* makeActionTestHarness({
          accessDecision: gate.bound,
          ownerRegistration: salesPipelineRegistration,
        });
        const input = {
          payload: {},
          principal,
          registration: requestSearchRebuildAction,
          transport: { correlationId: 'rebuild', idempotencyKey: 'rebuild-test' },
        };
        const result = yield* harness.runtime.runAction(input).pipe(Effect.exit);
        const allowed = outcome === 'ALLOWED';
        expect(Exit.isSuccess(result)).toBe(allowed);
        expect(harness.snapshot().committed).toHaveLength(allowed ? 1 : 0);
        expect(gate.accessDecision.askedDecisions.length).toBeGreaterThan(0);
        for (const question of gate.accessDecision.askedDecisions) {
          expect(question.carrier.accessDeclaration?.key).toBe(rebuildCapability);
          expect(question.scope).toMatchObject({ legalEntityId: company, tenantId: principal.tenantId });
        }
        if (allowed) {
          expect(Exit.isSuccess(result) && result.value).toEqual({
            requestId: harness.snapshot().committed[0]?.actionInvocationId,
            status: 'QUEUED',
          });
          expect(harness.snapshot().committed[0]?.evidence.domainEvents).toHaveLength(1);
          expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toMatchObject([
            {
              domainEventIndex: 0,
              message: {
                payloadJson: { requestId: harness.snapshot().committed[0]?.actionInvocationId },
                producerModuleKey: 'demo.sales-pipeline',
                topic: 'demo.sales-pipeline.search-rebuild-requested.v1',
              },
            },
          ]);
          const replay = yield* harness.runtime.runAction(input).pipe(Effect.flip);
          expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
          expect(harness.snapshot().committed).toHaveLength(1);
          expect(harness.snapshot().transactionCount).toBe(1);
        } else if (Exit.isFailure(result)) {
          const failure = yield* Effect.failCause(result.cause).pipe(Effect.flip);
          expect(failure._tag).toBe(
            outcome === 'UNAVAILABLE' ? 'ActionPermissionCheckError' : 'ActionPermissionDenied',
          );
          const denialCode = outcome === 'NEEDS_APPROVAL' ? 'action_approval_required' : 'action_permission_denied';
          expect(failure.code).toBe(outcome === 'UNAVAILABLE' ? 'action_permission_check_failed' : denialCode);
          expect(harness.snapshot().transactionCount).toBe(0);
          expect(harness.snapshot().stages).not.toContain('handler_executed');
        }
      }
    }),
);

it.effect('the rebuild capability never substitutes for a current authenticated operational scope', () =>
  Effect.gen(function* refuseInvalidScope() {
    for (const status of ['denied', 'unavailable'] as const) {
      const harness = yield* makeActionTestHarness({
        access: { [rebuildCapability]: 'allowed' },
        ownerRegistration: salesPipelineRegistration,
        scope: status,
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: {},
          principal,
          registration: requestSearchRebuildAction,
          transport: { correlationId: 'rebuild-scope', idempotencyKey: `rebuild-scope-${status}` },
        })
        .pipe(Effect.flip);
      expect(failure._tag).toBe(status === 'denied' ? 'OperationContextDenied' : 'OperationContextUnavailable');
      expect(harness.snapshot().committed).toEqual([]);
      expect(harness.snapshot().transactionCount).toBe(0);
      expect(harness.snapshot().stages).not.toContain('handler_executed');
    }
  }),
);
