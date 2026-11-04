// Scope fence for the Facility agenda records store (use-agenda.ts). The store keys entries by agenda names only
// (agendaRecordsData.key), which is safe only while the Shell forces a full document reload on every identity or
// company switch: use-shell-controls.ts runSwitch -> endBrowserSession -> navigate({ reloadDocument: true }), and
// browser-request-cache.ts reloads every other document of this browser when a session boundary is announced.
// These tests drive the real store, preload and hook, and pin the document-scoped lifecycle that argument depends
// on: one document shares one entry per agenda list, and a reset document starts pending and reads again instead of
// serving the previous scope's records.
import { Effect, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type ReactRuntime from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { emptyAssetsState } from '../../shared/domain/assets.ts';
import type { AgendaId } from '../../shared/domain/common.ts';
import { emptyMetersState } from '../../shared/domain/meters.ts';
import { emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { agendaRecordsData, preloadAgendaRecords, useAgendaRecords } from '../../src/ui/use-agenda.ts';

// `useSyncExternalStore` is the React boundary; calling the snapshot directly runs the hook outside a component.
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof ReactRuntime>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

const { reads } = rstest.hoisted(() => ({ reads: { records: rstest.fn() } }));
rstest.mock('../../src/api/records-consumer.ts', () => ({
  executeRecords: (...invocation: readonly unknown[]) => reads.records(...invocation),
}));

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

const probe = (agenda: AgendaId) => {
  const Probe = () => {
    const ops = useAgendaRecords([agenda]);
    return createElement('output', null, `${ops.status}:${ops.data?.agendas[agenda]?.revision ?? 'none'}`);
  };
  return Probe;
};

const events = new EventTarget();

beforeAll(() => {
  rstest.stubGlobal('document', {});
  rstest.stubGlobal('addEventListener', events.addEventListener.bind(events));
  rstest.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
  rstest.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
});

afterAll(() => {
  rstest.unstubAllGlobals();
  return browserRuntime.dispose();
});

beforeEach(() => {
  rstest.resetAllMocks();
});

it.live('a preloaded page reveals the agenda records to the hook without a second read', () =>
  Effect.gen(function* preloadReveal() {
    reads.records.mockReturnValueOnce(Effect.succeed(recordsResponse(3)));
    yield* Effect.promise(() => preloadAgendaRecords(['assets'])(moduleProps));
    expect(reads.records).toHaveBeenCalledTimes(1);
    expect(reads.records).toHaveBeenCalledWith({ agendas: ['assets'] }, expect.any(String));
    expect(renderToStaticMarkup(createElement(probe('assets')))).toBe('<output>ready:3</output>');
    // A different agenda list is a different entry: the preloaded assets records never leak into another agenda.
    expect(renderToStaticMarkup(createElement(probe('security')))).toBe('<output>loading:none</output>');
    expect(reads.records).toHaveBeenCalledTimes(1);
    // What the hook's mount effect calls.
    agendaRecordsData.ensure(['assets']);
    expect(reads.records).toHaveBeenCalledTimes(1);
    const read = yield* agendaRecordsData.read(['assets']);
    expect(read.agendas.assets?.revision).toBe(3);
    expect(reads.records).toHaveBeenCalledTimes(1);
  }),
);

it.live('a forced document reset drops the ready entry and the fresh document reads again', () =>
  Effect.gen(function* documentReset() {
    reads.records.mockReturnValueOnce(Effect.succeed(recordsResponse(3)));
    yield* Effect.promise(() => preloadAgendaRecords(['meters'])(moduleProps));
    expect(reads.records).toHaveBeenCalledTimes(1);
    expect(renderToStaticMarkup(createElement(probe('meters')))).toBe('<output>ready:3</output>');

    // What navigate({ reloadDocument: true }) does to module-scope state: the next document evaluates the module
    // again, so the previous scope's entry cannot be reached from it.
    rstest.resetModules();
    const fresh = yield* Effect.promise(() => import('../../src/ui/use-agenda.ts'));
    const freshRuntime = yield* Effect.promise(() => import('../../src/runtime/browser-effect-runtime.ts'));
    yield* Effect.gen(function* freshDocument() {
      expect(fresh.agendaRecordsData.snapshot(['meters'])).toEqual({ state: 'pending' });
      reads.records.mockReturnValueOnce(Effect.succeed(recordsResponse(4)));
      yield* Effect.promise(() => fresh.preloadAgendaRecords(['meters'])(moduleProps));
      expect(reads.records).toHaveBeenCalledTimes(2);
      const freshRead = yield* fresh.agendaRecordsData.read(['meters']);
      expect(freshRead.agendas.meters?.revision).toBe(4);
      const FreshProbe = () => {
        const ops = fresh.useAgendaRecords(['meters']);
        return createElement('output', null, `${ops.status}:${ops.data?.agendas.meters?.revision ?? 'none'}`);
      };
      expect(renderToStaticMarkup(createElement(FreshProbe))).toBe('<output>ready:4</output>');
    }).pipe(Effect.ensuring(Effect.promise(() => freshRuntime.browserRuntime.dispose())));
  }),
);

it.live('the agenda store keeps nothing outside the document', () =>
  Effect.gen(function* noDurableStorage() {
    const storage = {
      clear: rstest.fn(),
      getItem: rstest.fn(),
      key: rstest.fn(),
      removeItem: rstest.fn(),
      setItem: rstest.fn(),
    };
    rstest.stubGlobal('localStorage', storage);
    rstest.stubGlobal('sessionStorage', storage);
    reads.records
      .mockReturnValueOnce(Effect.succeed(recordsResponse(5)))
      .mockReturnValueOnce(Effect.succeed(recordsResponse(6)));
    yield* Effect.promise(() => preloadAgendaRecords(['purchasing'])(moduleProps));
    yield* agendaRecordsData.refresh(['purchasing']);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  }),
);
