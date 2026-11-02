import { ActiveApplicationCompositionService } from '@app/core-runtime';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { leasesRead } from '../../src/search/leases.provider.ts';
import { outboxWorkers } from '../../src/workers/index.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:lease-search-test',
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
      transport: { correlationId: 'lease-search-test', idempotencyKey: 'rebuild-1' },
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
          producerModuleKey: 'property.leasing',
          topic: 'property.leasing.search-rebuild-requested.v1',
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
    const payload = {
      command: {
        _tag: 'UpdateCounterpartyDossier',
        archived: false,
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceId: '40000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.counterparty',
          tenantId,
        },
      },
      expectedRevision: 0,
    } as const;
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(applyCommandAction, {
          load: () => Effect.succeed({ revision: 0, snapshot: { occupancies: [] } }),
          prepared: { payload, transition: { resourceRef: null, snapshot: { occupancies: [] } } },
          save: () => Effect.succeed(1),
        }),
      ],
    });
    yield* harness.runtime
      .runAction({
        payload,
        principal,
        registration: applyCommandAction,
        transport: { correlationId: 'lease-search-test', idempotencyKey: 'create-1' },
      })
      .pipe(
        Effect.provideService(ActiveApplicationCompositionService, {
          load: Effect.die('Unexpected reference transport in a lifecycle-only test'),
        }),
        Effect.provideService(GatewayPrincipalVerifierConfiguration, {
          configuration: Effect.die('Unexpected gateway configuration in a lifecycle-only test'),
        }),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://ontos.test/lease-search')),
        ),
      );
    const { committed } = harness.snapshot();
    expect(committed.length).toBe(1);
    expect(committed[0]?.evidence.outboxMessages[0]?.message.topic).toBe(
      'property.leasing.search-refresh-requested.v1',
    );
    expect(committed[0]?.evidence.domainEvents.length).toBe(1);
  }),
);

it('registers the candidate-checked provider and both governed owner workers', () => {
  expect(leasesRead.descriptor.legalEntityScope).toBe('required');
  expect(leasesRead.descriptor.permissionTarget).toBe('module');
  expect(outboxWorkers.map((worker) => worker.descriptor.workerKey).toSorted()).toEqual([
    'property.leasing.rebuild-search',
    'property.leasing.refresh-search',
  ]);
});
