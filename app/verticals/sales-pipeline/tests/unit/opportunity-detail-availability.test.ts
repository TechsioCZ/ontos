// @rstest-environment happy-dom
import { text, unmountAll } from '@app/admin-ui/testing/module-ui';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
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
});
