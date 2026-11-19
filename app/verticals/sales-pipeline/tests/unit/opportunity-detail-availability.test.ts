// @rstest-environment happy-dom
import { DETAIL_VIEW_MODE_KEY } from '@app/admin-ui';
import { text, unmountAll } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { act, createElement } from 'react';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import {
  RecordsApi,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  RecordsUnavailableProblemSchema,
} from '../../shared/apis/records.ts';
import { RecordsPage } from '../../src/routes/[lang]/prodej/prilezitosti/page.tsx';
import {
  OpportunityDetailNotice,
  opportunityDetailState,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-detail-panel.tsx';
import type { OpportunityDetailNoticeStatus } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-detail-panel.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const czech = moduleText('cs');

const idOf = (suffix: number) => `0196a8a0-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
const partyId = '0196a8a0-0000-7000-8000-0000000000aa';
const requestedId = idOf(1);

const opportunity = (suffix: number, title = `Příležitost ${suffix}`) =>
  Schema.decodeUnknownSync(OpportunitySchema)({
    amountMinor: 0,
    createdAt: '2026-10-13T08:00:00.000Z',
    currency: 'CZK',
    expectedCloseDate: '2026-11-30',
    id: idOf(suffix),
    lines: [],
    partyId,
    probability: 10,
    stage: 'LEAD',
    stageHistory: [],
    title,
    updatedAt: '2026-10-13T08:00:00.000Z',
  });

const completedRead = (items: readonly ReturnType<typeof opportunity>[]) => ({
  hasResponse: true,
  items,
  pending: false,
  requestedId,
});

const noticeText = (status: OpportunityDetailNoticeStatus) =>
  Effect.gen(function* notice() {
    yield* mountInRoute(createElement(OpportunityDetailNotice, { status }));
    const content = text();
    unmountAll();
    return content;
  });

const pageRecords = (items: readonly ReturnType<typeof opportunity>[]) =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: { principalId: partyId, tenantId: partyId },
    canWrite: false,
    indicators: {
      byStage: [],
      lostCount: 0,
      openCount: items.length,
      openValueMinor: 0,
      weightedValueMinor: 0,
      winRate: null,
      wonCount: 0,
      wonValueMinor: 0,
    },
    items: items.map((item) => Schema.encodeSync(OpportunitySchema)(item)),
    revision: 1,
  });

const openPage = () =>
  mountInRoute(createElement(RecordsPage), {
    path: 'prodej/prilezitosti',
    url: `/cs/prodej/prilezitosti?opportunityId=${requestedId}`,
  });

const panelText = () => document.querySelector('[role="dialog"]')?.textContent;
const flushReact = Effect.promise(() => act(() => Promise.resolve()));
const pageNetwork = (
  read: Effect.Effect<
    typeof RecordsResponseSchema.Type,
    typeof RecordsForbiddenProblemSchema.Type | typeof RecordsUnavailableProblemSchema.Type
  >,
) => {
  const Owner = RecordsApi.prefix('/sales-pipeline-api');
  return browserNetwork(
    shellGatewayIssuer({ 'sales-pipeline': '/sales-pipeline-api' }).application,
    serveApi(
      Owner,
      HttpApiBuilder.group(Owner, 'records', (group) => group.handle('execute', () => read)),
    ),
  );
};

afterEach(unmountAll);

describe('opportunity detail availability', () => {
  it('keeps the panel closed until a record is requested', () => {
    expect(opportunityDetailState({ hasResponse: true, items: [], pending: false })).toEqual({ status: 'closed' });
  });

  it.live('keeps a requested record loading while the authorized read is pending', () =>
    Effect.gen(function* pendingRead() {
      expect(opportunityDetailState({ ...completedRead([]), hasResponse: false, pending: true })).toEqual({
        status: 'pending',
      });
      // A missing response without a terminal failure is still a pending read, never a missing record.
      expect(opportunityDetailState({ ...completedRead([]), hasResponse: false, pending: false })).toEqual({
        status: 'pending',
      });
      const pending = yield* noticeText('pending');
      expect(pending).toBe(czech('sales-pipeline.loading'));
      expect(pending).not.toContain(czech('sales-pipeline.detail.missing'));
    }),
  );

  it.live('distinguishes a denied read from a failed read and a missing record', () =>
    Effect.gen(function* deniedRead() {
      expect(
        opportunityDetailState({ ...completedRead([]), hasResponse: false, loadError: 'forbidden', pending: true }),
      ).toEqual({ status: 'denied' });
      expect(opportunityDetailState({ ...completedRead([]), hasResponse: false, loadError: 'unavailable' })).toEqual({
        status: 'unavailable',
      });
      const denied = yield* noticeText('denied');
      expect(denied).toBe(czech('sales-pipeline.pages.records.forbidden'));
      expect(denied).not.toContain('unavailable');
      expect(denied).not.toContain(czech('sales-pipeline.pages.records.unavailable'));
      expect(yield* noticeText('unavailable')).toBe(czech('sales-pipeline.pages.records.unavailable'));
    }),
  );

  it.live(
    'reports a requested record missing only after a completed authorized read, without naming another record',
    () =>
      Effect.gen(function* missingRead() {
        const other = opportunity(2, 'Jiná příležitost');
        expect(opportunityDetailState(completedRead([other]))).toEqual({ status: 'missing' });
        const missing = yield* noticeText('missing');
        expect(missing).toBe(czech('sales-pipeline.detail.missing'));
        expect(missing).not.toContain(other.title);
        expect(missing).not.toContain('neexistuje');
        expect(missing).not.toEqual(yield* noticeText('denied'));
        expect(missing).not.toEqual(yield* noticeText('unavailable'));
      }),
  );

  it('shows exactly the requested record when the completed read contains it', () => {
    const target = opportunity(1);
    const other = opportunity(2, 'Jiná příležitost');
    const state = opportunityDetailState(completedRead([other, target]));
    expect(state.status).toBe('present');
    if (state.status !== 'present') {
      return;
    }
    expect(state.opportunity).toBe(target);
  });

  it.live('passes the requested id and the authorized read state to the detail panel', () =>
    Effect.gen(function* pageWiring() {
      yield* pinTestDocument;
      const target = opportunity(1, 'Vybraná obchodní příležitost');
      const other = opportunity(2, 'Jiná příležitost');
      const forbidden = Schema.decodeUnknownSync(RecordsForbiddenProblemSchema)({
        _tag: 'RecordsForbiddenProblem',
        detail: 'Přístup byl odepřen.',
        status: 403,
        title: 'Zakázáno',
        type: 'about:blank',
      });
      const unavailable = Schema.decodeUnknownSync(RecordsUnavailableProblemSchema)({
        _tag: 'RecordsUnavailableProblem',
        detail: 'Registr není dostupný.',
        retryable: true,
        status: 503,
        title: 'Nedostupné',
        type: 'about:blank',
      });
      let reply: Effect.Effect<typeof RecordsResponseSchema.Type, typeof forbidden | typeof unavailable> =
        Effect.succeed(pageRecords([other, target]));
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      let firstGate = true;
      const held = new Set<string>();
      const network = pageNetwork(
        Effect.gen(function* readPage() {
          if (firstGate) {
            firstGate = false;
            held.add('initial-records');
            yield* Deferred.succeed(entered, true);
            yield* Deferred.await(release).pipe(Effect.ensuring(Effect.sync(() => held.delete('initial-records'))));
          }
          return yield* reply;
        }),
      );
      yield* Effect.gen(function* readStates() {
        localStorage.setItem(DETAIL_VIEW_MODE_KEY, 'panel');
        yield* openPage();
        yield* Deferred.await(entered);
        yield* networkQuietExcept(held.size);
        expect(panelText()).toContain(czech('sales-pipeline.loading'));
        yield* Deferred.succeed(release, true);
        yield* networkIdle;
        yield* flushReact;
        expect(panelText()).toContain(target.title);
        unmountAll();

        const states = [
          { expected: czech('sales-pipeline.detail.missing'), response: Effect.succeed(pageRecords([other])) },
          { expected: czech('sales-pipeline.pages.records.forbidden'), response: Effect.fail(forbidden) },
          { expected: czech('sales-pipeline.pages.records.unavailable'), response: Effect.fail(unavailable) },
        ];
        for (const state of states) {
          reply = state.response;
          yield* openPage();
          yield* networkIdle;
          yield* flushReact;
          expect(panelText()).toContain(state.expected);
          unmountAll();
        }
      }).pipe(
        Effect.provide(network),
        Effect.ensuring(
          Deferred.succeed(release, true).pipe(
            Effect.andThen(
              Effect.sync(() => {
                unmountAll();
                localStorage.removeItem(DETAIL_VIEW_MODE_KEY);
              }),
            ),
          ),
        ),
      );
    }),
  );
});
