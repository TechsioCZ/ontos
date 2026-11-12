import { ActionPermissionCheckError, ActionPermissionDenied } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  SalesInsightsCommandPayloadSchema,
  SalesInsightsReferenceUnavailable,
} from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { SalesInsightsReferenceVerifier, prepareSalesInsightsCommand } from '../../src/services/persistence.service.ts';
import { salesInsightsRegistration } from '../../vertical.registration.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:sales-insights',
  authMethod: 'session' as const,
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
};
const payload = Schema.decodeSync(SalesInsightsCommandPayloadSchema)({
  command: {
    _tag: 'CreateMetric',
    contextRefs: [
      { moduleId: 'work.tasks', resourceId: 'task', resourceType: 'work.tasks.task', tenantId: principal.tenantId },
    ],
    title: 'Kontrola výsledku',
  },
  expectedRevision: 0,
});
for (const access of ['denied', 'unavailable'] as const) {
  it.effect(`the registered SalesInsights Action refuses ${access} before SQL`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const harness = yield* makeActionTestHarness({ access, ownerRegistration: salesInsightsRegistration });
        const failure = yield* harness.runtime
          .runAction({
            payload,
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'metric-denied', idempotencyKey: `metric-${access}` },
          })
          .pipe(Effect.flip);
        expect(Schema.is(access === 'denied' ? ActionPermissionDenied : ActionPermissionCheckError)(failure)).toBe(
          true,
        );
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toEqual([]);
      }),
    ),
  );
}
it.effect('remote reference failure stops the admitted Action before SQL', () =>
  Effect.scoped(
    Effect.gen(function* test() {
      const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: salesInsightsRegistration });
      let checked = false;
      const failure = yield* harness.runtime
        .runAction({
          payload,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'metric-reference', idempotencyKey: 'metric-reference' },
        })
        .pipe(
          Effect.provideService(SalesInsightsReferenceVerifier, {
            verify: () =>
              Effect.suspend(() => {
                expect(harness.snapshot().transactionCount).toBe(0);
                checked = true;
                return Effect.fail(
                  new SalesInsightsReferenceUnavailable({
                    code: 'sales_insights_reference_unavailable',
                    reason: 'Reference owner unavailable',
                  }),
                );
              }),
          }),
          Effect.flip,
        );
      expect(Schema.is(SalesInsightsReferenceUnavailable)(failure)).toBe(true);
      expect(checked).toBe(true);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  ),
);
it.effect('owner preparation does not re-decide run after an approval', () =>
  prepareSalesInsightsCommand(
    { _tag: 'CreateMetric', title: 'Schválená změna' },
    { ...principal, correlationId: 'approved-metric' },
  ),
);
