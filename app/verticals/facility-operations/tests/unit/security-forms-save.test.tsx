// @rstest-environment happy-dom
// The security panels that create something (device card, fault report, inspection, resolution) send it on the shared
// Uložit only: one click sends the same command as the old button, and leaving with typed input asks first.
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { SecurityDeviceSchema, SecurityIncidentSchema } from '../../shared/domain/security.ts';
import {
  DeviceFormPanel,
  InspectionPanel,
  ReportFaultPanel,
  ResolvePanel,
} from '../../src/routes/[lang]/provoz/bezpecnost/device-forms.tsx';
import { click, labels, mountPanel, typeInto, unmountPanels } from './draft-base-fixture.ts';
import { leaveQuestionOpen, recordingRunner, saveButton, saveSent } from './form-save-fixture.ts';
import type { RecordingRunner } from './form-save-fixture.ts';

const toasts: string[] = [];
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/ui/property-options.ts', () => ({
  usePropertyOptions: () => ({ status: 'loading' }),
}));
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({
  Toaster: () => null,
  toaster: { attrs: {} },
  useToast: () => ({
    create: (toast: { readonly title?: string }) => {
      toasts.push(toast.title ?? '');
    },
  }),
}));

const copy = { cancel: 'facility-operations.common.cancel' };
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const device = Schema.decodeUnknownSync(SecurityDeviceSchema)({
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  deviceType: 'camera',
  id: 'camera-1',
  name: 'Kamera vstup',
  state: 'in_operation',
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
});
const incident = Schema.decodeUnknownSync(SecurityIncidentSchema)({
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  deviceId: device.id,
  id: 'incident-1',
  occurredOn: '2026-10-20',
  severity: 'high',
  state: 'reported',
  title: 'Nefunguje záznam',
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
});

const calls: string[] = [];
const page = (name: string) => () => {
  calls.push(name);
};

const mountCreate = (runner: RecordingRunner) =>
  mountPanel(
    createElement(DeviceFormPanel, {
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
    }),
  );
const mountReport = (runner: RecordingRunner) =>
  mountPanel(
    createElement(ReportFaultPanel, {
      devices: [device],
      initialDeviceId: device.id,
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
      tenantId: actor.tenantId,
    }),
  );
const mountInspection = (runner: RecordingRunner) =>
  mountPanel(
    createElement(InspectionPanel, {
      device,
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
    }),
  );
const mountResolve = (runner: RecordingRunner) =>
  mountPanel(
    createElement(ResolvePanel, {
      incident,
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
    }),
  );

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.length = 0;
  toasts.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('new device card', () => {
  it.live('types a name, saves once with the create command, toasts and goes on', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountCreate(runner);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#security-name', 'Kamera dvůr');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([expect.objectContaining({ _tag: 'SecurityDeviceCreate', name: 'Kamera dvůr' })]);
      expect(calls).toEqual(['saved']);
      expect(toasts).toHaveLength(1);
    }),
  );

  it.live('a refused save keeps the input; Zrušit with typed input asks, Zahodit změny leaves', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner(['forbidden']);
      yield* mountCreate(runner);
      yield* typeInto('#security-name', 'Kamera dvůr');
      yield* saveSent(runner, 1);
      expect(calls).toEqual([]);
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.discard);
      expect(calls).toEqual(['close']);
      expect(runner.sent).toHaveLength(1);
    }),
  );
});

describe('fault report', () => {
  it.live('types a title, saves once with the report command and leaves', () =>
    Effect.gen(function* scenario() {
      // No created id comes back, so no follow-up task is created here.
      const runner = recordingRunner([], []);
      yield* mountReport(runner);
      yield* typeInto('#security-incident-title', 'Nefunguje záznam');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({ _tag: 'SecurityIncidentReport', deviceId: device.id, title: 'Nefunguje záznam' }),
      ]);
      expect(calls).toEqual(['saved']);
    }),
  );

  it.live('an untouched report closes without asking', () =>
    Effect.gen(function* scenario() {
      yield* mountReport(recordingRunner());
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(false);
      expect(calls).toEqual(['close']);
    }),
  );
});

describe('inspection and resolution', () => {
  it.live('the inspection opens filled in: Uložit records it at once, with the same command', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountInspection(runner);
      expect(saveButton().disabled).toBe(false);
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({ _tag: 'SecurityDeviceRecordInspection', deviceId: device.id }),
      ]);
      expect(calls).toEqual(['saved']);
    }),
  );

  it.live('a typed inspection note asks before Zrušit; an untouched one closes', () =>
    Effect.gen(function* scenario() {
      yield* mountInspection(recordingRunner());
      yield* typeInto('#security-inspection-note', 'Vyčištěn objektiv');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.stay);
      expect(calls).toEqual([]);
    }),
  );

  it.live('resolves the fault with the typed note on Uložit', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountResolve(runner);
      yield* typeInto('#security-resolution', 'Vyměněn disk');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        {
          _tag: 'SecurityIncidentChangeState',
          incidentId: incident.id,
          resolution: 'Vyměněn disk',
          state: 'resolved',
        },
      ]);
      expect(calls).toEqual(['saved']);
    }),
  );
});
