import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { propertiesRead } from '../../src/search/properties.provider.ts';
import { unitsRead } from '../../src/search/units.provider.ts';
import { outboxWorkers } from '../../src/workers/index.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:property-search-test',
  authMethod: 'session',
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;

it.effect('governed rebuild needs an explicit Action grant, selected company, and idempotency', () =>
  Effect.gen(function* scenario() {
    const request = {
      payload: {},
      principal,
      registration: requestSearchRebuildAction,
      transport: { correlationId: 'property-search-test', idempotencyKey: 'rebuild-1' },
    };
    const harness = yield* makeActionTestHarness({ actionPermission: 'allowed', tenantPermission: 'allowed' });
    const first = yield* harness.runtime.runAction(request);
    expect(first.status).toBe('QUEUED');
    expect(
      Predicate.isTagged(yield* harness.runtime.runAction(request).pipe(Effect.flip), 'ActionAlreadyCommitted'),
    ).toBe(true);
    expect(harness.snapshot().committed.length).toBe(1);
    expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toEqual([
      {
        domainEventIndex: 0,
        message: {
          payloadJson: { requestId: first.requestId },
          producerModuleKey: 'property.portfolio',
          topic: 'property.portfolio.search-rebuild-requested.v1',
        },
      },
    ]);
    const denied = yield* makeActionTestHarness({ actionPermission: 'denied', tenantPermission: 'allowed' });
    expect(
      Predicate.isTagged(yield* denied.runtime.runAction(request).pipe(Effect.flip), 'ActionPermissionDenied'),
    ).toBe(true);
    expect(denied.snapshot().committed).toEqual([]);
    const noTenantAdministration = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'denied',
    });
    expect(
      Predicate.isTagged(
        yield* noTenantAdministration.runtime.runAction(request).pipe(Effect.flip),
        'ActionPermissionDenied',
      ),
    ).toBe(true);
    expect(noTenantAdministration.snapshot().committed).toEqual([]);
    expect(requestSearchRebuildAction.descriptor.tenantPermission?.({})).toBe('manage_identity');
    expect(requestSearchRebuildAction.descriptor.legalEntityScope).toBe('required');
    expect(requestSearchRebuildAction.descriptor.entrypoint.authorization).toMatchObject({ provisioning: 'explicit' });
  }),
);

it.effect('successful business writes atomically queue projection intent and do not call the projector', () =>
  Effect.gen(function* scenario() {
    const resourceRef = {
      moduleId: 'property.portfolio',
      resourceId: '40000000-0000-4000-8000-000000000001',
      resourceType: 'property.portfolio.property',
      tenantId,
    } as const;
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(applyCommandAction, {
          apply: () => Effect.succeed({ resourceRef, revision: 1 }),
          load: () => Effect.succeed({ revision: 0, state: { assets: [], properties: [], units: [] } }),
        }),
      ],
    });
    yield* harness.runtime.runAction({
      payload: {
        command: { _tag: 'CreateProperty', address: 'Parková 12', code: 'PARK', name: 'Parková' },
        expectedRevision: 0,
      },
      principal,
      registration: applyCommandAction,
      transport: { correlationId: 'property-search-test', idempotencyKey: 'create-1' },
    });
    const { committed } = harness.snapshot();
    expect(committed.length).toBe(1);
    expect(committed[0]?.evidence.outboxMessages[0]?.message.topic).toBe(
      'property.portfolio.search-refresh-requested.v1',
    );
    expect(committed[0]?.evidence.domainEvents.length).toBe(1);
  }),
);

it('registers both candidate-checked providers and both governed owner workers', () => {
  expect(propertiesRead.descriptor.legalEntityScope).toBe('required');
  expect(unitsRead.descriptor.legalEntityScope).toBe('required');
  expect(propertiesRead.descriptor.permissionTarget).toBe('module');
  expect(unitsRead.descriptor.permissionTarget).toBe('module');
  expect(outboxWorkers.map((worker) => worker.descriptor.workerKey).toSorted()).toEqual([
    'property.portfolio.rebuild-search',
    'property.portfolio.refresh-search',
  ]);
});
