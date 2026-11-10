// @rstest-environment happy-dom
// The sales quote edit saves against the revision its draft was built on: a page refresh that brings someone else's
// change never moves a dirty draft onto the newer revision, so that change is refused instead of overwritten.
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { SalesQuoteSchema } from '../../shared/domain/purchasing.ts';
import type { SalesQuote } from '../../shared/domain/purchasing.ts';
import { SalesQuoteFormPanel } from '../../src/routes/[lang]/provoz/nakupy/sales-tab.tsx';
import {
  agendaAt,
  bodyText,
  changeElsewhere,
  click,
  fieldValue,
  labels,
  mountPanel,
  toPage,
  runnerAt,
  save,
  typeInto,
  unmountPanels,
} from './draft-base-fixture.ts';
import type { FakeAgenda } from './draft-base-fixture.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@app/party-registry/api/client', () => ({
  // Read when the panel loads its customers, long after the imports resolved.
  listCustomers: () =>
    Effect.succeed([
      {
        counterpartyRef: {
          resourceId: '44444444-4444-4444-8444-444444444444',
          tenantId: '70000000-0000-4000-8000-000000000020',
        },
        displayName: 'Kavárna Dolce',
        partyId: 'party-1',
      },
    ]),
}));

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const quoteAt = (updatedAt: string, validUntil: string, note: string): SalesQuote =>
  Schema.decodeUnknownSync(SalesQuoteSchema)({
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: actor,
    currency: 'CZK',
    customer: { counterpartyId: '44444444-4444-4444-8444-444444444444', name: 'Kavárna Dolce', tenantId },
    date: '2026-10-20',
    id: 'quote-1',
    lines: [
      { description: 'Servis vzduchotechniky', id: 'line-1', quantity: 1, unitPriceMinor: 1_500_000, vatRate: 21 },
    ],
    note,
    number: 'NAB-2026-014',
    status: 'draft',
    updatedAt,
    updatedBy: actor,
    validUntil,
  });
const opened = quoteAt('2026-10-20T08:00:00Z', '2026-11-19', 'Servis do konce měsíce');
const theirs = quoteAt('2026-10-21T09:30:00Z', '2026-11-30', 'Servis do konce měsíce');
const note = '#sales-quote-note';
const validUntil = '#sales-quote-valid';

const panelOf = (quote: SalesQuote, agenda: FakeAgenda, revision: number) =>
  createElement(SalesQuoteFormPanel, { onClose: toPage, onSaved: toPage, quote, run: runnerAt(agenda, revision) });

const sentRevisions = (agenda: FakeAgenda) => agenda.applied.map((entry) => entry.expectedRevision);

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('sales quote edit save against the revision of its draft', () => {
  it.live('a dirty draft keeps its revision through a refresh, so the save is refused as a conflict', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(panelOf(opened, agenda, 3));
      yield* typeInto(note, 'Servis do pátku');
      changeElsewhere(agenda);
      yield* panel.render(panelOf(theirs, agenda, 4));
      expect(fieldValue(note)).toBe('Servis do pátku');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([3]);
      expect(bodyText()).toContain(labels.conflict);
      yield* click(labels.reloadLatest);
      expect(fieldValue(validUntil)).toBe('2026-11-30');
      yield* typeInto(note, 'Servis do pátku');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );

  it.live('a clean draft takes the refresh, with its revision', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(panelOf(opened, agenda, 3));
      changeElsewhere(agenda);
      yield* panel.render(panelOf(theirs, agenda, 4));
      expect(fieldValue(validUntil)).toBe('2026-11-30');
      yield* typeInto(note, 'Servis do pátku');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );

  it.live('its own save advances the base, so the next save is not refused', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(panelOf(opened, agenda, 3));
      yield* typeInto(note, 'Servis do pátku');
      yield* save(agenda, 1);
      // The page re-reads after the save: the record now carries this form's own change.
      yield* panel.render(panelOf(quoteAt('2026-10-22T10:00:00Z', '2026-11-19', 'Servis do pátku'), agenda, 4));
      yield* typeInto(note, 'Servis do Vánoc');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );
});
