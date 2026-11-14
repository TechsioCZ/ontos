import { makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';
import { salesPipelineRegistration } from '../../vertical.registration.ts';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { ActionPermissionDenied, ContextAccess } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  ApplyCommandPayloadSchema,
  SalesPipelinePermissionDenied,
  SalesPipelineReferenceUnavailable,
} from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:sales-pipeline-command',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeSync(ApplyCommandPayloadSchema)({
  command: {
    _tag: 'CreateOpportunity',
    expectedCloseDate: '2026-12-31',
    lines: [],
    partyId: '50000000-0000-4000-8000-000000000001',
    title: 'Regresní test',
  },
  expectedRevision: 0,
});
const unused = () => Effect.die('Unexpected permission adapter');

const accessForMutation = (decision: 'denied' | 'unavailable', checkOutsideSql: () => void) => {
  const gate = makeTestAccessDecision({ defaultAnswer: { outcome: decision === 'denied' ? 'DENIED' : 'UNAVAILABLE' } });
  return {
    ...gate,
    decide: (question: Parameters<typeof gate.decide>[0]) =>
      Effect.sync(checkOutsideSql).pipe(Effect.andThen(gate.decide(question))),
  };
};

it.layer(makeTestAccessGateLayers())('owner preflight', (suite) => {
  for (const decision of ['denied', 'unavailable'] as const) {
    suite.effect(`the registered sales-pipeline Action prepares ${decision} permissions before SQL`, () =>
      Effect.scoped(
        Effect.gen(function* preparedPermissions() {
          const harness = yield* makeActionTestHarness({
            access: 'allowed',
            compositionRevision: 'a'.repeat(64),
            ownerRegistration: salesPipelineRegistration,
          });
          let checks = 0;
          const gate = makeTestAccessDecision({
            defaultAnswer: { outcome: decision === 'denied' ? 'DENIED' : 'UNAVAILABLE' },
          });
          const access = {
            ...gate,
            list: (question: Parameters<typeof gate.list>[0]) =>
              Effect.sync(() => {
                expect(harness.snapshot().transactionCount).toBe(0);
                checks += 1;
              }).pipe(Effect.andThen(gate.list(question))),
          };
          const failure = yield* harness.runtime
            .runAction({
              payload,
              principal,
              registration: applyCommandAction,
              transport: {
                correlationId: 'sales-pipeline-command',
                idempotencyKey: `sales-pipeline-command-${decision}`,
              },
            })
            .pipe(Effect.provideService(AccessDecisionGate, access), Effect.flip);
          expect(
            decision === 'denied'
              ? Schema.is(SalesPipelinePermissionDenied)(failure)
              : Schema.is(SalesPipelineReferenceUnavailable)(failure),
          ).toBe(true);
          expect(checks).toBe(1);
          expect(harness.snapshot().committed).toEqual([]);
          expect(harness.snapshot().transactionCount).toBe(0);
        }),
      ),
    );
  }

  suite.effect('Core executor denial never reaches sales-pipeline permission preparation', () =>
    Effect.scoped(
      Effect.gen(function* executorDenied() {
        const harness = yield* makeActionTestHarness({
          access: 'denied',
          compositionRevision: 'a'.repeat(64),
          ownerRegistration: salesPipelineRegistration,
        });
        const failure = yield* harness.runtime
          .runAction({
            payload,
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'work-denied', idempotencyKey: 'work-denied' },
          })
          .pipe(
            Effect.provideService(ContextAccess, {
              contextPermissions: unused,
              legalEntities: unused,
              modules: unused,
              resources: unused,
              tenants: unused,
            }),
            Effect.flip,
          );
        expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
      }),
    ),
  );

  for (const decision of ['denied', 'unavailable'] as const) {
    suite.effect(`updates prepare ${decision} canonical mutation decisions before SQL`, () =>
      Effect.scoped(
        Effect.gen(function* restrictedMutation() {
          const harness = yield* makeActionTestHarness({
            access: 'allowed',
            compositionRevision: 'a'.repeat(64),
            ownerRegistration: salesPipelineRegistration,
          });
          const restrictedPayload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
            command: {
              _tag: 'UpdateOpportunity',
              id: '50000000-0000-4000-8000-000000000001',
              patch: { title: 'Příležitost' },
            },
            expectedRevision: 1,
          });
          let resourceChecks = 0;
          const failure = yield* harness.runtime
            .runAction({
              payload: restrictedPayload,
              principal,
              registration: applyCommandAction,
              transport: { correlationId: 'restricted-command', idempotencyKey: `restricted-${decision}` },
            })
            .pipe(
              Effect.provideService(
                AccessDecisionGate,
                accessForMutation(decision, () => {
                  expect(harness.snapshot().transactionCount).toBe(0);
                  resourceChecks += 1;
                }),
              ),
              Effect.flip,
            );
          expect(
            decision === 'denied'
              ? Schema.is(SalesPipelinePermissionDenied)(failure)
              : Schema.is(SalesPipelineReferenceUnavailable)(failure),
          ).toBe(true);
          expect(resourceChecks).toBe(1);
          expect(harness.snapshot().transactionCount).toBe(0);
        }),
      ),
    );
  }
});
