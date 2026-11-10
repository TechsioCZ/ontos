// @rstest-environment happy-dom
// The meter card edit saves against the revision its draft was built on: a page refresh that brings someone else's
// change never moves a dirty draft onto the newer revision, so that change is refused instead of overwritten.
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { MeterSchema } from '../../shared/domain/meters.ts';
import type { Meter } from '../../shared/domain/meters.ts';
import { MeterForm } from '../../src/routes/[lang]/provoz/meridla/meter-forms.tsx';
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

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const meterAt = (updatedAt: string, note: string): Meter =>
  Schema.decodeUnknownSync(MeterSchema)({
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: actor,
    id: 'meter-1',
    medium: 'ELECTRICITY',
    note,
    serialNumber: 'EL-2026-001',
    status: 'ACTIVE',
    supplier: 'PRE',
    unit: 'kWh',
    updatedAt,
    updatedBy: actor,
  });
const opened = meterAt('2026-10-20T08:00:00Z', 'Hlavní elektroměr');
const theirs = meterAt('2026-10-21T09:30:00Z', 'Jejich poznámka');
const supplier = '#meter-supplier';

const form = (meter: Meter, agenda: FakeAgenda, revision: number) =>
  createElement(MeterForm, { meter, onCancel: toPage, onSaved: toPage, run: runnerAt(agenda, revision) });

const sentRevisions = (agenda: FakeAgenda) => agenda.applied.map((entry) => entry.expectedRevision);

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('meter card save against the revision of its draft', () => {
  it.live('a dirty draft keeps its revision through a refresh, so the save is refused as a conflict', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(form(opened, agenda, 3));
      yield* typeInto(supplier, 'ČEZ');
      changeElsewhere(agenda);
      yield* panel.render(form(theirs, agenda, 4));
      expect(fieldValue(supplier)).toBe('ČEZ');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([3]);
      expect(bodyText()).toContain(labels.conflict);
      // „Načíst aktuální verzi“ takes their version and its revision.
      yield* click(labels.reloadLatest);
      expect(fieldValue(supplier)).toBe('PRE');
      yield* typeInto(supplier, 'ČEZ');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );

  it.live('a clean draft takes the refresh, with its revision', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(form(opened, agenda, 3));
      changeElsewhere(agenda);
      yield* panel.render(form(theirs, agenda, 4));
      expect(fieldValue('#meter-note')).toBe('Jejich poznámka');
      yield* typeInto(supplier, 'ČEZ');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );

  it.live('its own save advances the base, so the next save is not refused', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(form(opened, agenda, 3));
      yield* typeInto(supplier, 'ČEZ');
      yield* save(agenda, 1);
      // The page re-reads after the save: the record now carries this form's own change.
      const ours = { ...meterAt('2026-10-22T10:00:00Z', 'Hlavní elektroměr'), supplier: 'ČEZ' };
      yield* panel.render(form(ours, agenda, 4));
      yield* typeInto(supplier, 'E.ON');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );
});
