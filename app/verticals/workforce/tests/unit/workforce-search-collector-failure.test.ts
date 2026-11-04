import { ActionCollectorError, ContextAccess } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it, rstest } from 'effect-rstest';
import {
  ApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxPayloadSchema,
  ApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxProducerModuleKey,
  ApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxTopic,
  createApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxMessage as actualRefreshMessage,
} from '../../src/actions/apply-command-demo-workforce-search-refresh-requested-v1.outbox-message.ts' with {
  rstest: 'importActual',
};
import {
  RequestSearchRebuildDemoWorkforceSearchRebuildRequestedV1OutboxPayloadSchema,
  RequestSearchRebuildDemoWorkforceSearchRebuildRequestedV1OutboxProducerModuleKey,
  RequestSearchRebuildDemoWorkforceSearchRebuildRequestedV1OutboxTopic,
  createRequestSearchRebuildDemoWorkforceSearchRebuildRequestedV1OutboxMessage as actualRebuildMessage,
} from '../../src/actions/request-search-rebuild-demo-workforce-search-rebuild-requested-v1.outbox-message.ts' with {
  rstest: 'importActual',
};
import { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { employee, scope, unexpectedContextAccess } from './workforce-search-fixtures.ts';

// Fault only the owner message factory. The real Core collector must reject the foreign producer
// after collecting the Domain Event, and the real Action runtime must discard the whole attempt.
rstest.mock('../../src/actions/apply-command-demo-workforce-search-refresh-requested-v1.outbox-message.ts', () => ({
  ApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxPayloadSchema,
  ApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxProducerModuleKey,
  ApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxTopic,
  createApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxMessage: (
    payload: Parameters<typeof actualRefreshMessage>[0],
  ) => ({
    ...actualRefreshMessage(payload),
    producerModuleKey: 'foreign.owner',
  }),
}));

rstest.mock(
  '../../src/actions/request-search-rebuild-demo-workforce-search-rebuild-requested-v1.outbox-message.ts',
  () => ({
    createRequestSearchRebuildDemoWorkforceSearchRebuildRequestedV1OutboxMessage: (
      payload: Parameters<typeof actualRebuildMessage>[0],
    ) => ({
      ...actualRebuildMessage(payload),
      producerModuleKey: 'foreign.owner',
    }),
    RequestSearchRebuildDemoWorkforceSearchRebuildRequestedV1OutboxPayloadSchema,
    RequestSearchRebuildDemoWorkforceSearchRebuildRequestedV1OutboxProducerModuleKey,
    RequestSearchRebuildDemoWorkforceSearchRebuildRequestedV1OutboxTopic,
  }),
);

it.effect('collector failure after a successful employee apply does not commit a partial event or publish Search', () =>
  Effect.gen(function* mutationCollectorFailure() {
    let applies = 0;
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(applyCommandAction, {
          apply: () =>
            Effect.sync(() => {
              applies += 1;
              return { employees: [employee], revision: 1 };
            }),
          loadRecords: () => Effect.die('No records read'),
        }),
      ],
    });
    const payload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'CreateEmployee',
        active: employee.active,
        department: employee.department,
        email: employee.email,
        fullName: employee.fullName,
        id: employee.id,
        role: employee.role,
      },
      expectedRevision: 0,
    });
    const failure = yield* harness.runtime
      .runAction({
        payload,
        principal: scope,
        registration: applyCommandAction,
        transport: { correlationId: 'collector-failure', idempotencyKey: 'collector-failure' },
      })
      .pipe(Effect.flip);
    expect(Schema.is(ActionCollectorError)(failure)).toBe(true);
    expect(applies).toBe(1);
    expect(harness.snapshot().transactionCount).toBe(1);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().invocations[0]?.completedAt).toBeNull();
    expect(harness.snapshot().invocations[0]?.status).not.toBe('succeeded');
  }).pipe(Effect.provideService(ContextAccess, unexpectedContextAccess)),
);

it.effect('rebuild collector failure never acknowledges QUEUED or commits an orphan Domain Event', () =>
  Effect.gen(function* rebuildCollectorFailure() {
    const harness = yield* makeActionTestHarness({ actionPermission: 'allowed', tenantPermission: 'allowed' });
    const failure = yield* harness.runtime
      .runAction({
        payload: {},
        principal: scope,
        registration: requestSearchRebuildAction,
        transport: { correlationId: 'rebuild-collector-failure', idempotencyKey: 'rebuild-collector-failure' },
      })
      .pipe(Effect.flip);
    expect(Schema.is(ActionCollectorError)(failure)).toBe(true);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().invocations[0]?.completedAt).toBeNull();
  }),
);
