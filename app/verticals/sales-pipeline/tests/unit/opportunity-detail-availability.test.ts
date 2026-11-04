import { readFileSync } from 'node:fs';
import { Schema } from 'effect';
import { beforeAll, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import {
  OpportunityDetailNotice,
  opportunityDetailState,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-detail-panel.tsx';
import type { OpportunityDetailNoticeStatus } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-detail-panel.tsx';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

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
  renderToStaticMarkup(createElement(OpportunityDetailNotice, { status })).replaceAll(/<[^>]*>/gu, '');

describe('opportunity detail availability', () => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  beforeAll(() => {
    rstest.stubGlobal('React', React);
  });

  it('keeps the panel closed until a record is requested', () => {
    expect(opportunityDetailState({ hasResponse: true, items: [], pending: false })).toEqual({ status: 'closed' });
  });

  it('keeps a requested record loading while the authorized read is pending', () => {
    expect(opportunityDetailState({ ...completedRead([]), hasResponse: false, pending: true })).toEqual({
      status: 'pending',
    });
    // A missing response without a terminal failure is still a pending read, never a missing record.
    expect(opportunityDetailState({ ...completedRead([]), hasResponse: false, pending: false })).toEqual({
      status: 'pending',
    });
    expect(noticeText('pending')).toBe('sales-pipeline.loading');
    expect(noticeText('pending')).not.toContain('sales-pipeline.detail.missing');
  });

  it('distinguishes a denied read from a failed read and a missing record', () => {
    expect(
      opportunityDetailState({ ...completedRead([]), hasResponse: false, loadError: 'forbidden', pending: true }),
    ).toEqual({ status: 'denied' });
    expect(opportunityDetailState({ ...completedRead([]), hasResponse: false, loadError: 'unavailable' })).toEqual({
      status: 'unavailable',
    });
    expect(noticeText('denied')).toBe('sales-pipeline.pages.records.forbidden');
    expect(noticeText('denied')).not.toContain('unavailable');
    expect(noticeText('unavailable')).toBe('sales-pipeline.pages.records.unavailable');
  });

  it('reports a requested record missing only after a completed authorized read, without naming another record', () => {
    const other = opportunity(2, 'Jiná příležitost');
    expect(opportunityDetailState(completedRead([other]))).toEqual({ status: 'missing' });
    const missing = noticeText('missing');
    expect(missing).toBe('sales-pipeline.detail.missing');
    expect(missing).not.toContain(other.title);
    expect(missing).not.toContain('neexistuje');
    expect(missing).not.toEqual(noticeText('denied'));
    expect(missing).not.toEqual(noticeText('unavailable'));
  });

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

  it('passes the requested id and the authorized read state to the detail panel', () => {
    const source = readFileSync(
      new URL('../../src/routes/[lang]/prodej/prilezitosti/page.tsx', import.meta.url),
      'utf-8',
    );
    expect(source).toContain('hasResponse={response !== undefined}');
    expect(source).toContain('items={items}');
    expect(source).toContain('loadError={loadError}');
    expect(source).toContain('pending={pending}');
    expect(source).toContain('requestedId={detailId}');
    expect(source).not.toContain('items.find((item) => item.id === detailId)');
  });
});
