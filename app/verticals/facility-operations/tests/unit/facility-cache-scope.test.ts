// @rstest-environment happy-dom
// One document shares an entry per agenda list; reads go through the real gateway and records client.
import '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { afterAll, afterEach, beforeEach, expect, it } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { emptyAssetsState } from '../../shared/domain/assets.ts';
import type { AgendaId } from '../../shared/domain/common.ts';
import { emptyMetersState } from '../../shared/domain/meters.ts';
import { emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { agendaRecordsData, preloadAgendaRecords, useAgendaRecords } from '../../src/ui/use-agenda.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const principalId = '72000000-0000-4000-8000-000000000021';
const legalEntityId = '71000000-0000-4000-8000-000000000022';

/** What the Shell hands to `preloadPage`; the facility preload accepts it and keys the store by agenda names only. */
const moduleProps = {
  context: { displayName: 'Vedoucí', legalEntityId, principalId, tenantId },
  routeParams: {},
  search: '',
};

const envelope = <State>(state: State, revision: number) => ({
  canWrite: true,
  revision,
  state,
  updatedAt: '2026-11-04T09:00:00.000Z',
});

const recordsResponse = (revision: number) =>
  Schema.decodeSync(RecordsResponseSchema)({
    access: [
      { agenda: 'assets', canRead: true, canWrite: true },
      { agenda: 'meters', canRead: true, canWrite: true },
      { agenda: 'purchasing', canRead: true, canWrite: true },
    ],
    actorPrincipalRef: { principalId, tenantId },
    agendas: {
      assets: envelope(emptyAssetsState, revision),
      meters: { ...envelope(emptyMetersState, revision), canManage: true, canReadFinancial: true },
      purchasing: envelope(emptyPurchasingState, revision),
    },
  });

const probe = (agendas: readonly AgendaId[]) => {
  const Probe = () => {
    const ops = useAgendaRecords(agendas);
    return createElement('output', null, `${ops.status}:${ops.data?.agendas.assets?.revision ?? 'none'}`);
  };
  return Probe;
};

const reads: { readonly correlation: string | undefined; readonly payload: RecordsRequest }[] = [];
let revision = 3;
const OwnerRecordsApi = RecordsApi.prefix('/facility-operations-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload, request }) =>
        Effect.sync(() => {
          reads.push({ correlation: request.headers['x-correlation-id'], payload });
          const response = recordsResponse(revision);
          revision += 1;
          return response;
        }),
      ),
    ),
  ),
);

const unmounts: (() => void)[] = [];
const mountProbe = (agendas: readonly AgendaId[]) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(probe(agendas))));
  return container;
};

afterAll(() => browserRuntime.dispose());
afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
});
beforeEach(() => {
  reads.length = 0;
  agendaRecordsData.invalidate();
});

it.live('preload and mounted readers canonicalize agenda sets while different agendas stay separate', () =>
  Effect.gen(function* agendaKeyComposition() {
    yield* pinTestDocument;
    revision = 3;
    yield* Effect.promise(() => preloadAgendaRecords(['meters', 'assets', 'meters'])(moduleProps));
    expect(reads.map(({ payload }) => payload)).toEqual([{ agendas: ['assets', 'meters'] }]);
    const mounted = mountProbe(['meters', 'assets', 'assets']);
    expect(mounted.textContent).toBe('ready:3');
    expect(agendaRecordsData.snapshot(['purchasing'])).toEqual({ state: 'pending' });

    yield* Effect.promise(() => preloadAgendaRecords(['purchasing'])(moduleProps));
    expect(reads.map(({ payload }) => payload)).toEqual([
      { agendas: ['assets', 'meters'] },
      { agendas: ['purchasing'] },
    ]);
    expect(agendaRecordsData.snapshot(['purchasing'])).toMatchObject({
      state: 'ready',
      value: { agendas: { purchasing: { revision: 4 } } },
    });
    expect(agendaRecordsData.snapshot(['assets', 'meters'])).toMatchObject({
      state: 'ready',
      value: { agendas: { assets: { revision: 3 }, meters: { revision: 3 } } },
    });
  }).pipe(Effect.provide(network)),
);

/** Everything a storage object holds, by key. */
const contentsOf = (storage: Storage) =>
  Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? '').map((key) => [
      key,
      storage.getItem(key),
    ]),
  );

it.live('the agenda store keeps nothing outside the document', () =>
  Effect.gen(function* noDurableStorage() {
    yield* pinTestDocument;
    // What another part of the page already keeps in both real storages; the agenda store must leave it as it is.
    localStorage.setItem('facility-cache-scope.local', 'kept');
    sessionStorage.setItem('facility-cache-scope.session', 'kept');
    const before = { local: contentsOf(localStorage), session: contentsOf(sessionStorage) };
    revision = 5;
    yield* Effect.promise(() => preloadAgendaRecords(['purchasing'])(moduleProps));
    yield* networkIdle;
    // Nothing was restored from storage: the preload read the owner, and the store holds the owner's answer.
    expect(reads).toHaveLength(1);
    expect(agendaRecordsData.snapshot(['purchasing'])).toMatchObject({
      state: 'ready',
      value: { agendas: { purchasing: { revision: 5 } } },
    });
    yield* agendaRecordsData.refresh(['purchasing']);
    expect(reads).toHaveLength(2);
    expect(agendaRecordsData.snapshot(['purchasing'])).toMatchObject({
      state: 'ready',
      value: { agendas: { purchasing: { revision: 6 } } },
    });
    // Nothing was written, replaced or removed in either storage.
    expect({ local: contentsOf(localStorage), session: contentsOf(sessionStorage) }).toEqual(before);
    localStorage.removeItem('facility-cache-scope.local');
    sessionStorage.removeItem('facility-cache-scope.session');
  }).pipe(Effect.provide(network)),
);
