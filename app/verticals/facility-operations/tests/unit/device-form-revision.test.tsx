// @rstest-environment happy-dom
// The device card edit saves against the revision its draft was built on: a page refresh that brings someone else's
// change never moves a dirty draft onto the newer revision, so that change is refused instead of overwritten.
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { SecurityDeviceSchema } from '../../shared/domain/security.ts';
import type { SecurityDevice } from '../../shared/domain/security.ts';
import { DeviceFormPanel } from '../../src/routes/[lang]/provoz/bezpecnost/device-forms.tsx';
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
const deviceAt = (updatedAt: string, fields: { readonly note: string; readonly supplier: string }): SecurityDevice =>
  Schema.decodeUnknownSync(SecurityDeviceSchema)({
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: actor,
    deviceType: 'camera',
    id: 'camera-1',
    name: 'Kamera vstup',
    note: fields.note,
    state: 'in_operation',
    supplier: fields.supplier,
    updatedAt,
    updatedBy: actor,
  });
const opened = deviceAt('2026-10-20T08:00:00Z', { note: 'Krytá chodba', supplier: 'Bezpečnost Praha' });
const theirs = deviceAt('2026-10-21T09:30:00Z', { note: 'Jejich poznámka', supplier: 'Bezpečnost Praha' });
const supplier = '#security-supplier';

const panelOf = (device: SecurityDevice, agenda: FakeAgenda, revision: number) =>
  createElement(DeviceFormPanel, {
    device,
    onClose: toPage,
    onSaved: toPage,
    open: true,
    run: runnerAt(agenda, revision),
  });

const sentRevisions = (agenda: FakeAgenda) => agenda.applied.map((entry) => entry.expectedRevision);

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('device card save against the revision of its draft', () => {
  it.live('a dirty draft keeps its revision through a refresh, so the save is refused as a conflict', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(panelOf(opened, agenda, 3));
      yield* typeInto(supplier, 'Alarm servis');
      changeElsewhere(agenda);
      yield* panel.render(panelOf(theirs, agenda, 4));
      expect(fieldValue(supplier)).toBe('Alarm servis');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([3]);
      expect(bodyText()).toContain(labels.conflict);
      yield* click(labels.reloadLatest);
      expect(fieldValue('#security-note')).toBe('Jejich poznámka');
      yield* typeInto(supplier, 'Alarm servis');
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
      expect(fieldValue('#security-note')).toBe('Jejich poznámka');
      yield* typeInto(supplier, 'Alarm servis');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );

  it.live('its own save advances the base, so the next save is not refused', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(panelOf(opened, agenda, 3));
      yield* typeInto(supplier, 'Alarm servis');
      yield* save(agenda, 1);
      // The page re-reads after the save: the record now carries this form's own change.
      yield* panel.render(
        panelOf(deviceAt('2026-10-22T10:00:00Z', { note: 'Krytá chodba', supplier: 'Alarm servis' }), agenda, 4),
      );
      yield* typeInto(supplier, 'Alarm servis Brno');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(bodyText()).toContain(labels.saved);
    }),
  );
});
