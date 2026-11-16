import type { ActionRegistration } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { SalesInsightsErrorSchema } from '../../shared/actions/apply-command.ts';
import { SalesInsightsCommandPayloadSchema, ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { salesInsightsRegistration } from '../../vertical.registration.ts';
import { updateMetricAction } from '../../src/actions/update-metric.action.ts';
import { assignMetricAction } from '../../src/actions/assign-metric.action.ts';
import { changeMetricStateAction } from '../../src/actions/change-metric-state.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const allowedId = '50000000-0000-4000-8000-000000000001';
const otherId = '50000000-0000-4000-8000-000000000002';
const now = '2026-11-02T00:00:00.000Z';
const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:record-write',
  authMethod: 'session' as const,
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId,
  tenantId,
};
const metricRef = {
  moduleId: 'demo.sales-insights',
  resourceId: allowedId,
  resourceType: 'demo.sales-insights.metric',
  tenantId,
} as const;
const result = Schema.decodeSync(ApplyCommandResultSchema)({
  metric: {
    collectionRef: {
      moduleId: 'demo.sales-insights',
      resourceId: 'collection',
      resourceType: 'demo.sales-insights.metric-collection',
      tenantId,
    },
    contextRefs: [],
    createdAt: now,
    priority: 'NORMAL',
    ref: metricRef,
    state: 'IN_PROGRESS',
    title: 'Updated',
    updatedAt: now,
  },
  revision: 2,
});
const recordWriteTests = <Payload extends Schema.ConstraintDecoder<unknown>, Owner extends string>(
  registration: ActionRegistration<
    Payload,
    typeof ApplyCommandResultSchema,
    typeof SalesInsightsErrorSchema,
    typeof updateMetricAction.descriptor.domainEvents,
    Owner,
    NonNullable<typeof updateMetricAction._services>
  >,
  command: (typeof SalesInsightsCommandPayloadSchema.Encoded)['command'],
) => {
  it.effect(`${registration.descriptor.actionKey} authorizes exactly its command record in the trusted scope`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const payload = Schema.decodeSync(SalesInsightsCommandPayloadSchema)({ command, expectedRevision: 1 });
        const granted = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
        const denied = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'DENIED' } });
        const accessDecision: typeof granted.bound = {
          ...granted.bound,
          decide: (input, transaction) => {
            expect(input.carrier.accessDeclaration).toEqual(registration.descriptor.accessDeclaration);
            expect(input.target?.moduleKey).toBe(registration.descriptor.owningModuleKey);
            expect(input.scope.tenantId).toBe(tenantId);
            expect(input.scope.legalEntityId).toBe(principal.legalEntityId);
            return (input.target?.recordKey === allowedId ? granted : denied).bound.decide(input, transaction);
          },
        };
        let writes = 0;
        const harness = yield* makeActionTestHarness({
          accessDecision,
          ownerRegistration: salesInsightsRegistration,
          services: [
            bindActionTestServices(registration, {
              apply: () =>
                Effect.sync(() => {
                  writes += 1;
                  return result;
                }),
              loadRecords: () => Effect.die('A write must not call the records read'),
            }),
          ],
        });
        const request = {
          payload: Schema.encodeSync(SalesInsightsCommandPayloadSchema)(payload),
          principal,
          registration,
          transport: { correlationId: 'record-write', idempotencyKey: registration.descriptor.actionKey },
        };
        const success = yield* harness.runtime.runAction(request);
        expect(success.revision).toBe(2);
        expect(writes).toBe(1);
        expect(harness.snapshot().committed).toHaveLength(1);
        const encoded = Schema.encodeSync(SalesInsightsCommandPayloadSchema)(payload);
        const other = { ...encoded, command: { ...command, metricRef: { ...metricRef, resourceId: otherId } } };
        const failure = yield* harness.runtime
          .runAction({
            ...request,
            payload: other,
            transport: { correlationId: 'record-denied', idempotencyKey: `${registration.descriptor.actionKey}-other` },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect(writes).toBe(1);
        expect(harness.snapshot().committed).toHaveLength(1);
      }),
    ),
  );
  it.effect(`${registration.descriptor.actionKey} never treats approval-only authority as a write`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const harness = yield* makeActionTestHarness({
          access: 'needs_approval',
          ownerRegistration: salesInsightsRegistration,
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: { command, expectedRevision: 1 },
            principal,
            registration,
            transport: { correlationId: 'approval-only', idempotencyKey: registration.descriptor.actionKey },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect('code' in failure && failure.code).toBe('action_approval_required');
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toEqual([]);
      }),
    ),
  );
  it.effect(`the former scope-wide dispatcher cannot bypass ${registration.descriptor.actionKey}`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          ownerRegistration: salesInsightsRegistration,
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: { command, expectedRevision: 1 },
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'no-dispatch-bypass', idempotencyKey: registration.descriptor.actionKey },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPayloadValidationError')).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toEqual([]);
      }),
    ),
  );
};

recordWriteTests(updateMetricAction, { _tag: 'UpdateMetric', metricRef, title: 'Updated' });
recordWriteTests(assignMetricAction, { _tag: 'AssignMetric', metricRef, ownerPrincipalRef: { principalId, tenantId } });
recordWriteTests(changeMetricStateAction, { _tag: 'ChangeMetricState', metricRef, state: 'IN_PROGRESS' });
