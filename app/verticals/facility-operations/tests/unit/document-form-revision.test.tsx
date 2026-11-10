// @rstest-environment happy-dom
// The document edit saves against the revision its draft was built on: a page refresh that brings someone else's
// change never moves a dirty draft onto the newer revision, so that change is refused instead of overwritten.
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { DocumentSchema } from '../../shared/domain/documents.ts';
import type { DocumentRecord } from '../../shared/domain/documents.ts';
import { DocumentFormPanel } from '../../src/routes/[lang]/provoz/dokumenty/document-form.tsx';
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
rstest.mock('../../src/ui/property-options.ts', () => ({
  usePropertyOptions: () => ({ status: 'loading' }),
}));
rstest.mock('../../src/ui/party-invoice-options.ts', () => ({
  useContactOptions: () => ({ status: 'loading' }),
  useInvoiceOptions: () => ({ status: 'loading' }),
}));

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const documentAt = (
  updatedAt: string,
  fields: { readonly description: string; readonly title: string },
): DocumentRecord =>
  Schema.decodeUnknownSync(DocumentSchema)({
    category: 'other',
    createdAt: '2026-10-01T08:00:00Z',
    createdBy: actor,
    description: fields.description,
    id: 'doc-1',
    links: [],
    title: fields.title,
    updatedAt,
    updatedBy: actor,
    versions: [],
  });
const opened = documentAt('2026-10-20T08:00:00Z', { description: 'Původní popis', title: 'Revize kotle' });
const theirs = documentAt('2026-10-21T09:30:00Z', { description: 'Jejich popis', title: 'Revize kotle' });
const title = '#document-title';
const description = '#document-description';

const panelOf = (document: DocumentRecord, agenda: FakeAgenda, revision: number) =>
  createElement(DocumentFormPanel, {
    contracts: [],
    mode: { document, kind: 'edit' },
    onClose: toPage,
    onSaved: toPage,
    open: true,
    run: runnerAt(agenda, revision),
    tasks: { status: 'loading' },
  });

const sentRevisions = (agenda: FakeAgenda) => agenda.applied.map((entry) => entry.expectedRevision);

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('document edit save against the revision of its draft', () => {
  it.live('a dirty draft keeps its revision through a refresh, so the save is refused as a conflict', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(panelOf(opened, agenda, 3));
      yield* typeInto(title, 'Revize kotle 2026');
      changeElsewhere(agenda);
      yield* panel.render(panelOf(theirs, agenda, 4));
      expect(fieldValue(title)).toBe('Revize kotle 2026');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([3]);
      expect(bodyText()).toContain(labels.conflict);
      yield* click(labels.reloadLatest);
      expect(fieldValue(description)).toBe('Jejich popis');
      yield* typeInto(title, 'Revize kotle 2026');
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
      expect(fieldValue(description)).toBe('Jejich popis');
      yield* typeInto(title, 'Revize kotle 2026');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );

  it.live('its own save advances the base, so the next save is not refused', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(panelOf(opened, agenda, 3));
      yield* typeInto(title, 'Revize kotle 2026');
      yield* save(agenda, 1);
      // The page re-reads after the save: the record now carries this form's own change.
      yield* panel.render(
        panelOf(
          documentAt('2026-10-22T10:00:00Z', { description: 'Původní popis', title: 'Revize kotle 2026' }),
          agenda,
          4,
        ),
      );
      yield* typeInto(title, 'Revize kotle 2027');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );
});
