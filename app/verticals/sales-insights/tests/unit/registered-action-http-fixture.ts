import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { TrustedPrincipalContextSchema, GatewayAssertionRedemptionService } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { Clock, Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder } from 'effect/http-api';
import { rstest } from 'effect-rstest';

import type { SalesInsightsCommand, SalesInsightsCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';

import { salesInsightsRegistration } from '../../vertical.registration.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { applyCommandActionApiLive } from '../../api/apply-command-action-server.ts';
import { UpdateMetricActionApi } from '../../shared/apis/update-metric-action.ts';
import { updateMetricAction } from '../../src/actions/update-metric.action.ts';
import { updateMetricActionApiLive } from '../../api/update-metric-action-server.ts';
import { AssignMetricActionApi } from '../../shared/apis/assign-metric-action.ts';
import { assignMetricAction } from '../../src/actions/assign-metric.action.ts';
import { assignMetricActionApiLive } from '../../api/assign-metric-action-server.ts';
import { ChangeMetricStateActionApi } from '../../shared/apis/change-metric-state-action.ts';
import { changeMetricStateAction } from '../../src/actions/change-metric-state.action.ts';
import { changeMetricStateActionApiLive } from '../../api/change-metric-state-action-server.ts';
// Authentication is an external port here. The real HTTP endpoint, payload decoder, owner binding,
// canonical gate, handler, invocation repository and commit evidence all remain in the test.
rstest.mock('../../api/auth/action-principal.ts', () => ({
  authenticateOperationPrincipal: () =>
    Effect.succeed(
      Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:sales-insights-http',
        authMethod: 'session',
        legalEntityId: '30000000-0000-4000-8000-000000000001',
        principalId: '20000000-0000-4000-8000-000000000001',
        tenantId: '10000000-0000-4000-8000-000000000001',
      }),
    ),
}));

export const registrations = [
  applyCommandAction,
  updateMetricAction,
  assignMetricAction,
  changeMetricStateAction,
] as const;

const id = '50000000-0000-4000-8000-000000000001';
const tenantId = '10000000-0000-4000-8000-000000000001';
const metricRef = {
  moduleId: 'demo.sales-insights',
  resourceId: id,
  resourceType: 'demo.sales-insights.metric',
  tenantId,
} as const;
const result = Schema.decodeUnknownSync(ApplyCommandResultSchema)({
  metric: {
    collectionRef: { ...metricRef, resourceType: 'demo.sales-insights.metric-collection' },
    contextRefs: [],
    createdAt: '2026-11-07T12:00:00Z',
    priority: 'NORMAL',
    ref: metricRef,
    state: 'NEW',
    title: 'HTTP metric',
    updatedAt: '2026-11-07T12:00:00Z',
  },
  revision: 2,
});
const httpApi = HttpApi.make('SalesInsightsApi')
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(UpdateMetricActionApi)
  .addHttpApi(AssignMetricActionApi)
  .addHttpApi(ChangeMetricStateActionApi);
const handlers = Layer.mergeAll(
  applyCommandActionApiLive,
  updateMetricActionApiLive,
  assignMetricActionApiLive,
  changeMetricStateActionApiLive,
);
export const makeFixture = (options: Pick<ActionTestHarnessOptions, 'access' | 'mandateDispatch'> = {}) =>
  Effect.gen(function* fixture() {
    const writes: SalesInsightsCommand[] = [];
    const services = {
      apply: (command: SalesInsightsCommand) =>
        Effect.sync(() => {
          writes.push(command);
          return result;
        }),
      loadRecords: () => Effect.die('HTTP writes must not read the records endpoint'),
    };

    const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: salesInsightsRegistration });
    const compositionRevision = owner.snapshot.composition.revision;
    const clock = yield* Clock.Clock;
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      applicationComposition: owner.applicationComposition,
      expectedDeployment: owner.expectedDeployment,
      ownerRegistration: salesInsightsRegistration,
      services: [
        bindActionTestServices(applyCommandAction, services),
        bindActionTestServices(updateMetricAction, services),
        bindActionTestServices(assignMetricAction, services),
        bindActionTestServices(changeMetricStateAction, services),
      ],
      ...options,
    });
    const requestContext = yield* Layer.build(
      Layer.mergeAll(
        harness.layer,
        Layer.succeed(Clock.Clock, clock),
        Layer.succeed(ActiveApplicationCompositionService, owner.applicationComposition),
        Layer.mock(GatewayAssertionRedemptionService, {}),
        Layer.mock(GatewayPrincipalVerifierConfiguration, {}),
      ),
    );
    const router = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(httpApi).pipe(
            Layer.provide(handlers),
            Layer.provide(harness.layer),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (value) => Effect.promise(async () => await value.dispose()),
    );
    const request = (
      path: string,
      command: (typeof SalesInsightsCommandPayloadSchema.Encoded)['command'],
      key: string,
      intent?: 'propose',
    ) => {
      const headers = new Headers({
        authorization: 'Bearer fixture',
        'content-type': 'application/json',
        'idempotency-key': key,
        'x-composition-revision': compositionRevision,
        'x-correlation-id': key,
      });
      if (intent !== undefined) {
        headers.set('x-action-intent', intent);
      }
      return Effect.promise(
        async () =>
          await router.handler(
            new Request(`https://owner.test${path}`, {
              body: JSON.stringify({ command, expectedRevision: 1 }),
              headers,
              method: 'POST',
            }),
            requestContext,
          ),
      );
    };
    return { compositionRevision, harness, request, requestContext, router, writes };
  });

export const cases = [
  { command: { _tag: 'CreateMetric', title: 'HTTP metric' }, slug: 'apply-command' },
  { command: { _tag: 'UpdateMetric', metricRef, title: 'Updated metric' }, slug: 'update-metric' },
  {
    command: {
      _tag: 'AssignMetric',
      metricRef,
      ownerPrincipalRef: { principalId: '20000000-0000-4000-8000-000000000001', tenantId },
    },
    slug: 'assign-metric',
  },
  { command: { _tag: 'ChangeMetricState', metricRef, state: 'DONE' }, slug: 'change-metric-state' },
] as const;
