import { bindActionTestServices } from '@app/core-runtime/testing/actions';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder } from 'effect/http-api';

import {
  registeredActionGateway,
  relayActionWrite,
} from '../../../../packages/gateway-principal-verifier/tests/support/registered-action-http.ts';

import type { SalesInsightsCommand, SalesInsightsCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';

import { salesInsightsRegistration } from '../../vertical.registration.ts';
import { ACTION_GATEWAY_AUDIENCE } from '../../api/auth/action-principal.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
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

    const gateway = yield* registeredActionGateway(
      {
        apiMarker: ultramodernApiMarker,
        audience: ACTION_GATEWAY_AUDIENCE,
        ownerRegistration: salesInsightsRegistration,
      },
      {
        services: [
          bindActionTestServices(applyCommandAction, services),
          bindActionTestServices(updateMetricAction, services),
          bindActionTestServices(assignMetricAction, services),
          bindActionTestServices(changeMetricStateAction, services),
        ],
        ...options,
      },
    );
    const requestContext = yield* Layer.build(gateway.requestLayer);
    const router = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(httpApi).pipe(
            Layer.provide(handlers),
            Layer.provide(gateway.harness.layer),
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
    ) =>
      relayActionWrite(gateway, async (relayed) => await router.handler(relayed, requestContext), {
        body: JSON.stringify({ command, expectedRevision: 1 }),
        intent,
        key,
        path,
      });
    return { ...gateway, request, requestContext, router, writes };
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
