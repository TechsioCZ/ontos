// @rstest-environment happy-dom
import { DETAIL_VIEW_MODE_KEY } from '@app/admin-ui';
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Option, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { PipelineDetailPanel } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-detail-panel.tsx';
import { RecordsPage } from '../../src/routes/[lang]/prodej/prilezitosti/page.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const id = '10000000-0000-4000-8000-000000000001';
const title = 'Regály pro nový sklad';
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canWrite: false,
  indicators: {
    byStage: [],
    lostCount: 0,
    openCount: 1,
    openValueMinor: 0,
    weightedValueMinor: 0,
    winRate: null,
    wonCount: 0,
    wonValueMinor: 0,
  },
  items: [
    {
      amountMinor: 0,
      createdAt: '2026-10-13T08:00:00Z',
      currency: 'CZK',
      expectedCloseDate: '2026-11-30',
      id,
      lines: [],
      partyId: '10000000-0000-4000-8000-000000000002',
      probability: 10,
      stage: 'LEAD',
      stageHistory: [],
      title,
      updatedAt: '2026-10-13T08:00:00Z',
    },
  ],
  revision: 7,
});
const Owner = RecordsApi.prefix('/sales-pipeline-api');
const network = browserNetwork(
  // Other producers are deliberately unavailable to this composition, as on a restricted seller account.
  shellGatewayIssuer({ 'sales-pipeline': '/sales-pipeline-api' }).application,
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'records', (group) => group.handle('execute', () => Effect.succeed(records))),
  ),
);
const czech = moduleText('cs');
const button = (name: string) => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));
const opportunityRow = () =>
  [...document.querySelectorAll<HTMLElement>('tr')].find((row) => row.textContent?.includes('Regály'));
const mount = Effect.gen(function* mountRecords() {
  yield* pinTestDocument;
  localStorage.removeItem(DETAIL_VIEW_MODE_KEY);
  const mounted = yield* mountInRoute(<RecordsPage />, { path: 'prodej/prilezitosti', url: '/cs/prodej/prilezitosti' });
  yield* waitUntil(() => opportunityRow() !== undefined);
  return mounted;
});
const openRecord = () => acted(() => Option.getOrThrow(Option.fromUndefinedOr(opportunityRow())).click());

afterEach(() => {
  unmountAll();
  localStorage.removeItem(DETAIL_VIEW_MODE_KEY);
});

it.live(
  'the page header choice opens a real opportunity as a non-blocking quick view and remembers the choice',
  () =>
    Effect.gen(function* quickView() {
      const { router } = yield* mount;
      expect(button(czech('sales-pipeline.detailView.page')).getAttribute('aria-pressed')).toBe('true');
      yield* acted(() => button(czech('sales-pipeline.detailView.panel')).click());
      yield* waitUntil(
        () =>
          button(czech('sales-pipeline.detailView.panel')).getAttribute('aria-pressed') === 'true' &&
          localStorage.getItem(DETAIL_VIEW_MODE_KEY) === 'panel',
      );
      expect(button(czech('sales-pipeline.detailView.panel')).getAttribute('aria-pressed')).toBe('true');
      expect(localStorage.getItem(DETAIL_VIEW_MODE_KEY)).toBe('panel');
      yield* openRecord();
      yield* waitUntil(() => document.querySelector('[role="dialog"]') !== null);
      const dialog = Option.getOrThrow(Option.fromNullOr(document.querySelector('[role="dialog"]')));
      expect(dialog.textContent).toContain(title);
      expect(dialog.getAttribute('aria-modal')).not.toBe('true');
      expect(router.state.location.href).toBe('/cs/prodej/prilezitosti');
      const search = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('#pipeline-search')));
      yield* acted(() => {
        search.focus();
        search.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
        search.click();
      });
      yield* settle;
      expect(document.activeElement).toBe(search);
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(title);
      expect(opportunityRow()?.closest('[aria-hidden="true"]')).toBeNull();
    }).pipe(Effect.provide(network)),
  // The file's first mount of the real opportunities page, the same cold load that took 5.17 s on a loaded runner.
  { timeout: 20_000 },
);

it.live('the default detail choice navigates to the selected opportunity full page', () =>
  Effect.gen(function* fullPage() {
    const { router } = yield* mount;
    yield* openRecord();
    yield* waitUntil(() => router.state.location.href.includes(`opportunityId=${id}`));
    expect(router.state.location.href).toContain(`opportunityId=${id}`);
    yield* waitUntil(() => [...document.querySelectorAll('h1')].some((heading) => heading.textContent === title));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('a pending opportunity quick view also leaves the list usable and stays open on outside presses', () =>
  Effect.gen(function* pendingQuickView() {
    const closed: boolean[] = [];
    yield* mountInRoute(
      <>
        <button type="button">Další příležitost</button>
        <PipelineDetailPanel
          canWrite={false}
          hasResponse={false}
          items={[]}
          loadError={undefined}
          lookups={{
            customerById: new Map(),
            customersStatus: 'loading',
            employeeById: new Map(),
            employeesStatus: 'loading',
            tagsBySubject: null,
          }}
          onClose={() => {
            closed.push(true);
          }}
          onEdit={() => {
            throw new Error('Pending records cannot be edited');
          }}
          onStage={() => {
            throw new Error('Pending records cannot change stage');
          }}
          peek
          pending
          requestedId={id}
          revision={0}
        />
      </>,
    );
    const dialog = Option.getOrThrow(Option.fromNullOr(document.querySelector('[role="dialog"]')));
    expect(dialog.textContent).toContain(czech('sales-pipeline.loading'));
    expect(dialog.getAttribute('aria-modal')).not.toBe('true');
    const outside = button('Další příležitost');
    yield* acted(() => {
      outside.focus();
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      outside.click();
    });
    yield* settle;
    expect(document.activeElement).toBe(outside);
    expect(closed).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  }),
);
