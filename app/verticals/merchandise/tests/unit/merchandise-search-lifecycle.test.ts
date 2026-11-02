import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { ContextAccess } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { HttpClient, HttpServerRequest } from 'effect/http';
import { Effect, Layer, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { merchandiseMcpContribution } from '../../shared/mcp/contribution.ts';
import { EntityIdSchema } from '../../shared/domain/merchandise-model.ts';
import { MerchandiseRevisionConflict } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { productsRead } from '../../src/search/products.provider.ts';
import { ordersRead } from '../../src/search/orders.provider.ts';
import { outboxWorkers } from '../../src/workers/index.ts';

/** Substituted owner services never use these. Any accidental remote call fails the test. */
const unusedRuntimeDependencies = Layer.mergeAll(
  Layer.mock(ContextAccess, {}),
  Layer.mock(ActiveApplicationCompositionService, {}),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die('Unexpected reference HTTP call')),
  ),
  Layer.mock(GatewayPrincipalVerifierConfiguration, {}),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('http://merchandise.test/search-fixture')),
  ),
);

const tenantId = '10000000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:merchandise-search-test',
  authMethod: 'session',
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
const request = {
  payload: {},
  principal,
  registration: requestSearchRebuildAction,
  transport: { correlationId: 'merchandise-search-test', idempotencyKey: 'rebuild-1' },
};

it.effect('authorized tenant administrator queues one rebuild and idempotent replay cannot enqueue twice', () =>
  Effect.gen(function* scenario() {
    const harness = yield* makeActionTestHarness({ actionPermission: 'allowed', tenantPermission: 'allowed' });
    const result = yield* harness.runtime.runAction(request);
    expect(result.status).toBe('QUEUED');
    expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toEqual([
      {
        domainEventIndex: 0,
        message: {
          payloadJson: { requestId: result.requestId },
          producerModuleKey: 'demo.merchandise',
          topic: 'demo.merchandise.search-rebuild-requested.v1',
        },
      },
    ]);
    expect(
      Predicate.isTagged(yield* harness.runtime.runAction(request).pipe(Effect.flip), 'ActionAlreadyCommitted'),
    ).toBe(true);
    expect(harness.snapshot().committed.length).toBe(1);
    expect(harness.snapshot().committed[0]?.evidence.dataAccessEvents).toEqual([]);
  }),
);

it.effect('neither an Action grant alone nor tenant administration alone can request a rebuild', () =>
  Effect.gen(function* scenario() {
    const noTenantPermission = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'denied',
    });
    expect(
      Predicate.isTagged(
        yield* noTenantPermission.runtime.runAction(request).pipe(Effect.flip),
        'ActionPermissionDenied',
      ),
    ).toBe(true);
    expect(noTenantPermission.snapshot().committed).toEqual([]);
    const noActionPermission = yield* makeActionTestHarness({
      actionPermission: 'denied',
      tenantPermission: 'allowed',
    });
    expect(
      Predicate.isTagged(
        yield* noActionPermission.runtime.runAction(request).pipe(Effect.flip),
        'ActionPermissionDenied',
      ),
    ).toBe(true);
    expect(noActionPermission.snapshot().committed).toEqual([]);
    expect(requestSearchRebuildAction.descriptor.tenantPermission?.({})).toBe('manage_identity');
    expect(requestSearchRebuildAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
  }),
);

it.effect('business mutation commits its targeted projection request atomically without projection I/O', () =>
  Effect.gen(function* scenario() {
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(applyCommandAction, {
          apply: () => Effect.succeed({ entityIds: [EntityIdSchema.make('product-1')], revision: 1 }),
          productImage: () => Effect.die('No media read during mutation'),
          records: () => Effect.die('No records read during mutation'),
        }),
      ],
    });
    yield* harness.runtime
      .runAction({
        payload: {
          command: { _tag: 'ArchiveDemoProduct', id: 'product-1', reason: 'Remove demo fixture' },
          expectedRevision: 0,
        },
        principal,
        registration: applyCommandAction,
        transport: { correlationId: 'merchandise-search-test', idempotencyKey: 'archive-1' },
      })
      .pipe(Effect.provide(unusedRuntimeDependencies));
    const { committed } = harness.snapshot();
    expect(committed.length).toBe(1);
    expect(committed[0]?.evidence.outboxMessages[0]?.message).toEqual({
      payloadJson: { legalEntityId: principal.legalEntityId, orderIds: [], productIds: ['product-1'], rebuild: false },
      producerModuleKey: 'demo.merchandise',
      topic: 'demo.merchandise.search-refresh-requested.v1',
    });
  }),
);

it.effect('failed business mutation leaves no projection intent or outbox message', () =>
  Effect.gen(function* scenario() {
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(applyCommandAction, {
          apply: () =>
            Effect.fail(
              new MerchandiseRevisionConflict({ code: 'merchandise_revision_conflict', reason: 'Stale revision' }),
            ),
          productImage: () => Effect.die('No media read during mutation'),
          records: () => Effect.die('No records read during mutation'),
        }),
      ],
    });
    const error = yield* harness.runtime
      .runAction({
        payload: {
          command: { _tag: 'ArchiveDemoProduct', id: 'product-1', reason: 'Remove demo fixture' },
          expectedRevision: 0,
        },
        principal,
        registration: applyCommandAction,
        transport: { correlationId: 'merchandise-search-test', idempotencyKey: 'archive-conflict-1' },
      })
      .pipe(Effect.provide(unusedRuntimeDependencies), Effect.flip);
    expect(Predicate.isTagged(error, 'MerchandiseRevisionConflict')).toBe(true);
    expect(harness.snapshot().committed).toEqual([]);
  }),
);

it('registers company-scoped row-resource checked reads and both governed projection workers', () => {
  expect(merchandiseMcpContribution.actions?.['request-search-rebuild']).toBe('hidden');
  expect(productsRead.descriptor.legalEntityScope).toBe('required');
  expect(ordersRead.descriptor.legalEntityScope).toBe('required');
  expect(productsRead.descriptor.permissionTarget).toBe('module');
  expect(ordersRead.descriptor.permissionTarget).toBe('module');
  expect(outboxWorkers.map((worker) => worker.descriptor.workerKey)).toEqual([
    'demo.merchandise.rebuild-search',
    'demo.merchandise.refresh-search',
  ]);
});
