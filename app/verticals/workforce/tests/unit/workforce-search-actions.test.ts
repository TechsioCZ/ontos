import {
  ActionAlreadyCommitted,
  ActionCommitIndeterminate,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionResultValidationError,
  ContextAccess,
} from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { DateTime, Effect, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema, WorkforcePersistenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayload, WorkforceCommand } from '../../shared/actions/apply-command.ts';
import type { WorkforceState } from '../../shared/apis/records.ts';
import { OutboxPayloadSchema as RefreshPayloadSchema } from '../../shared/outbox/demo-workforce-search-refresh-requested-v1.ts';
import { OutboxPayloadSchema as RebuildPayloadSchema } from '../../shared/outbox/demo-workforce-search-rebuild-requested-v1.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { evolveEmployeeState } from '../../src/services/persistence.service.ts';
import { employee, employeeId, otherEmployeeId, scope, unexpectedContextAccess } from './workforce-search-fixtures.ts';

const now = DateTime.makeUnsafe('2026-11-04T01:00:00.000Z');
const create = Schema.decodeSync(ApplyCommandPayloadSchema)({
  command: {
    _tag: 'CreateEmployee',
    active: employee.active,
    department: employee.department,
    email: employee.email,
    fullName: employee.fullName,
    id: employee.id,
    phone: employee.phone,
    principalRef: employee.principalRef,
    role: employee.role,
  },
  expectedRevision: 0,
});

const cases: readonly {
  readonly name: string;
  readonly payload: ApplyCommandPayload;
  readonly state: WorkforceState;
}[] = [
  { name: 'create', payload: create, state: { employees: [] } },
  {
    name: 'rename and role/department update',
    payload: Schema.decodeSync(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'UpdateEmployee',
        id: employeeId,
        patch: { department: 'Podpora', fullName: 'Petr Černý', role: 'SUPPORT' },
      },
      expectedRevision: 1,
    }),
    state: { employees: [employee] },
  },
  {
    name: 'bulk archive',
    payload: Schema.decodeSync(ApplyCommandPayloadSchema)({
      command: { _tag: 'BulkUpdateEmployees', ids: [employeeId, otherEmployeeId], patch: { active: false } },
      expectedRevision: 2,
    }),
    state: { employees: [employee, { ...employee, email: 'second-private@example.test', id: otherEmployeeId }] },
  },
];

for (const { name, payload, state } of cases) {
  it.effect(`${name} commits one linked refresh request after apply and never republishes on Action replay`, () =>
    Effect.gen(function* committedRefresh() {
      let applies = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(applyCommandAction, {
            apply: (command: WorkforceCommand, expectedRevision: number) => {
              applies += 1;
              expect(command).toEqual(payload.command);
              expect(expectedRevision).toBe(payload.expectedRevision);
              return evolveEmployeeState(state, command, { now }).pipe(
                Effect.map((change) => ({ employees: change.employees, revision: expectedRevision + 1 })),
              );
            },
            loadRecords: () => Effect.die('An Action must not call the records endpoint'),
          }),
        ],
      });
      const request = {
        payload,
        principal: scope,
        registration: applyCommandAction,
        transport: { correlationId: 'workforce-refresh-test', idempotencyKey: name },
      };
      // No Core Search services are installed: the Action must only collect, never publish synchronously.
      const result = yield* harness.runtime.runAction(request);
      expect(result.revision).toBe(payload.expectedRevision + 1);
      const replay = yield* harness.runtime.runAction(request).pipe(Effect.flip);
      expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
      expect(applies).toBe(1);
      const { committed, invocations } = harness.snapshot();
      expect(committed.length).toBe(1);
      expect(invocations[0]?.status).toBe('succeeded');
      const evidence = committed[0]?.evidence;
      expect(evidence?.domainEvents.length).toBe(1);
      expect(evidence?.outboxMessages.length).toBe(1);
      const event = evidence?.domainEvents[0];
      const message = evidence?.outboxMessages[0];
      const expectedPayload = { requestId: invocations[0]?.actionInvocationId };
      expect(event?.eventType).toBe('demo.workforce.search-refresh-requested.v1');
      expect(event?.producerModuleKey).toBe('demo.workforce');
      expect(event?.payloadJson).toEqual(expectedPayload);
      expect(message?.domainEventIndex).toBe(0);
      expect(message?.message).toEqual({
        payloadJson: expectedPayload,
        producerModuleKey: 'demo.workforce',
        topic: 'demo.workforce.search-refresh-requested.v1',
      });
      expect(JSON.stringify(evidence)).not.toMatch(/private-employee|777111222|principalRef|Účetní|Novotný/u);
    }).pipe(Effect.provideService(ContextAccess, unexpectedContextAccess)),
  );
}

it.effect('a failed employee write leaves no committed event, outbox message or projection publication', () =>
  Effect.gen(function* failedMutation() {
    let applies = 0;
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(applyCommandAction, {
          apply: () => {
            applies += 1;
            return Effect.fail(
              new WorkforcePersistenceUnavailable({
                code: 'workforce_persistence_unavailable',
                reason: 'Test employee write rolled back',
              }),
            );
          },
          loadRecords: () => Effect.die('No records read'),
        }),
      ],
    });
    const failure = yield* harness.runtime
      .runAction({
        payload: create,
        principal: scope,
        registration: applyCommandAction,
        transport: { correlationId: 'failed-write', idempotencyKey: 'failed-write' },
      })
      .pipe(Effect.flip);
    expect(Schema.is(WorkforcePersistenceUnavailable)(failure)).toBe(true);
    expect(applies).toBe(1);
    expect(harness.snapshot().transactionCount).toBe(1);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().invocations[0]?.completedAt).toBeNull();
    expect(harness.snapshot().invocations[0]?.status).not.toBe('succeeded');
  }).pipe(Effect.provideService(ContextAccess, unexpectedContextAccess)),
);

it.effect('a post-handler transaction rejection discards already-collected refresh evidence', () =>
  Effect.gen(function* resultRejected() {
    let applies = 0;
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(applyCommandAction, {
          apply: () =>
            Effect.sync(() => {
              applies += 1;
              // Structurally typed as number, but invalid for the Action's integer result contract.
              return { employees: [employee], revision: 1.5 };
            }),
          loadRecords: () => Effect.die('No records read'),
        }),
      ],
    });
    const failure = yield* harness.runtime
      .runAction({
        payload: create,
        principal: scope,
        registration: applyCommandAction,
        transport: { correlationId: 'rejected-result', idempotencyKey: 'rejected-result' },
      })
      .pipe(Effect.flip);
    expect(Schema.is(ActionResultValidationError)(failure)).toBe(true);
    expect(applies).toBe(1);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().invocations[0]?.completedAt).toBeNull();
    expect(harness.snapshot().invocations[0]?.status).not.toBe('succeeded');
  }).pipe(Effect.provideService(ContextAccess, unexpectedContextAccess)),
);

it.effect('a lost commit acknowledgement never duplicates the durable refresh request on retry', () =>
  Effect.gen(function* uncertainCommit() {
    let applies = 0;
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      commitAcknowledgement: 'indeterminate-once',
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
    const request = {
      payload: create,
      principal: scope,
      registration: applyCommandAction,
      transport: { correlationId: 'uncertain-commit', idempotencyKey: 'uncertain-commit' },
    };
    expect(Schema.is(ActionCommitIndeterminate)(yield* harness.runtime.runAction(request).pipe(Effect.flip))).toBe(
      true,
    );
    expect(Schema.is(ActionAlreadyCommitted)(yield* harness.runtime.runAction(request).pipe(Effect.flip))).toBe(true);
    expect(applies).toBe(1);
    expect(harness.snapshot().committed.length).toBe(1);
    expect(harness.snapshot().committed[0]?.evidence.outboxMessages.length).toBe(1);
  }).pipe(Effect.provideService(ContextAccess, unexpectedContextAccess)),
);

it.effect('authorized tenant rebuild without a selected company enqueues only and is idempotent', () =>
  Effect.gen(function* rebuild() {
    const { descriptor } = requestSearchRebuildAction;
    expect(descriptor.legalEntityScope).toBe('optional');
    expect(descriptor.tenantPermission?.({})).toBe('manage_identity');
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
    const harness = yield* makeActionTestHarness({ actionPermission: 'allowed', tenantPermission: 'allowed' });
    const request = {
      payload: {},
      principal: Struct.omit(scope, ['legalEntityId']),
      registration: requestSearchRebuildAction,
      transport: { correlationId: 'rebuild', idempotencyKey: 'rebuild' },
    };
    // No source/store services are installed, so population cannot run inside this Action.
    const result = yield* harness.runtime.runAction(request);
    expect(result).toEqual({ requestId: harness.snapshot().invocations[0]?.actionInvocationId, status: 'QUEUED' });
    expect(Schema.is(ActionAlreadyCommitted)(yield* harness.runtime.runAction(request).pipe(Effect.flip))).toBe(true);
    const { committed } = harness.snapshot();
    expect(committed.length).toBe(1);
    expect(committed[0]?.evidence.domainEvents.length).toBe(1);
    expect(committed[0]?.evidence.outboxMessages.length).toBe(1);
    expect(committed[0]?.evidence.domainEvents[0]?.eventType).toBe('demo.workforce.search-rebuild-requested.v1');
    expect(committed[0]?.evidence.outboxMessages[0]).toEqual({
      domainEventIndex: 0,
      message: {
        payloadJson: { requestId: result.requestId },
        producerModuleKey: 'demo.workforce',
        topic: 'demo.workforce.search-rebuild-requested.v1',
      },
    });
  }),
);

for (const [actionPermission, tenantPermission] of [
  ['denied', 'allowed'],
  ['allowed', 'denied'],
  ['unavailable', 'allowed'],
  ['allowed', 'unavailable'],
] as const) {
  it.effect(`rebuild refuses executor=${actionPermission}, manage_identity=${tenantPermission} before enqueue`, () =>
    Effect.gen(function* rebuildDenied() {
      const harness = yield* makeActionTestHarness({ actionPermission, tenantPermission });
      const failure = yield* harness.runtime
        .runAction({
          payload: {},
          principal: scope,
          registration: requestSearchRebuildAction,
          transport: { correlationId: 'denied-rebuild', idempotencyKey: 'denied-rebuild' },
        })
        .pipe(Effect.flip);
      const unavailable = actionPermission === 'unavailable' || tenantPermission === 'unavailable';
      expect(
        unavailable ? Schema.is(ActionPermissionCheckError)(failure) : Schema.is(ActionPermissionDenied)(failure),
      ).toBe(true);
      expect(harness.snapshot().committed).toEqual([]);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  );
}

it.effect('both message contracts admit only a UUID request identity, never caller-supplied employee data', () =>
  Effect.gen(function* minimalMessages() {
    for (const schema of [RefreshPayloadSchema, RebuildPayloadSchema]) {
      expect(Schema.is(schema)({ requestId: employeeId })).toBe(true);
      for (const value of [
        { data: { employees: [employee] } },
        { requestId: 'not-a-uuid' },
        { employees: [employee], requestId: employeeId },
      ]) {
        yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(Effect.flip);
      }
    }
  }),
);
