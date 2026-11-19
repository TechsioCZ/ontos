// @rstest-environment happy-dom
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import { preloadPage as preloadHome } from '../../src/components/home-summary.tsx';
import { crmRecordsData } from '../../src/crm/records.ts';
import { preloadPage as preloadApprovals } from '../../src/routes/[lang]/crm/schvalovani-ai/page.tsx';

const response = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignmentCandidates: [],
  departedPrincipalIds: [],
  now: '2026-11-18T12:00:00.000Z',
  revision: 19,
  state: {
    ...initialCrmState,
    clients: {
      ...initialCrmState.clients,
      items: [
        {
          createdAt: '2026-11-18T10:00:00.000Z',
          createdBy: 'principal-1',
          id: 'client-opening',
          kind: 'organization',
          name: 'Nájempark Šťastný',
          status: 'active',
          updatedAt: '2026-11-18T10:00:00.000Z',
        },
      ],
    },
  },
  viewer: {
    assign: true,
    principalId: '20000000-0000-4000-8000-000000000062',
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  },
});
const requests: RecordsRequest[] = [];
const Owner = RecordsApi.prefix('/crm-api');
const network = browserNetwork(
  shellGatewayIssuer({ crm: '/crm-api' }).application,
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          requests.push(payload);
          return response;
        }),
      ),
    ),
  ),
);

it.live.each([
  { preload: preloadHome, screen: 'home summary' },
  { preload: preloadApprovals, screen: 'AI approvals' },
])('$screen preloads governed CRM data before opening without a refresh click', ({ preload }) =>
  Effect.gen(function* opensScreen() {
    yield* pinTestDocument;
    crmRecordsData.invalidate();
    requests.length = 0;
    yield* Effect.promise(() => preload({ routeParams: {}, search: '' }));
    yield* networkIdle;
    expect(crmRecordsData.snapshot({})).toMatchObject({
      refreshing: false,
      state: 'ready',
      value: {
        revision: 19,
        state: { clients: { items: [{ id: 'client-opening', name: 'Nájempark Šťastný' }] } },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.clientId).toBeUndefined();
  }).pipe(Effect.provide(network)),
);
