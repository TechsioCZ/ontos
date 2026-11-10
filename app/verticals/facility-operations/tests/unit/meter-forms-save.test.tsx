// @rstest-environment happy-dom
// A new meter and a meter reading are sent by the shared Uložit only: typing changes the draft, one click sends the
// same command as the old button did, and leaving with typed input asks first while an untouched form just closes.
import { requiredLabelFor } from '@app/admin-ui';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { MeterSchema } from '../../shared/domain/meters.ts';
import { MeterForm, ReadingForm } from '../../src/routes/[lang]/provoz/meridla/meter-forms.tsx';
import { bodyText, click, labels, mountPanel, typeInto, unmountPanels } from './draft-base-fixture.ts';
import { leaveQuestionOpen, recordingRunner, saveButton, saveSent } from './form-save-fixture.ts';
import type { RecordingRunner } from './form-save-fixture.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/ui/property-options.ts', () => ({
  usePropertyOptions: () => ({ status: 'loading' }),
}));

const copy = { cancel: 'facility-operations.common.cancel', required: 'facility-operations.common.required' };
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const meter = Schema.decodeUnknownSync(MeterSchema)({
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  id: 'meter-1',
  medium: 'WATER',
  serialNumber: 'VO-1',
  status: 'ACTIVE',
  unit: 'm3',
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
});

const calls: string[] = [];
const record = (name: string) => (value?: string) => {
  calls.push(`${name}:${value ?? ''}`);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

const mountMeter = (runner: RecordingRunner) =>
  mountPanel(createElement(MeterForm, { onCancel: record('cancel'), onSaved: record('saved'), run: runner.run }));
const mountReading = (runner: RecordingRunner) =>
  mountPanel(
    createElement(ReadingForm, {
      canRecordCosts: false,
      canUploadPhoto: false,
      fixedMeterId: meter.id,
      meters: [meter],
      onCancel: record('cancel'),
      onSaved: record('saved'),
      run: runner.run,
    }),
  );

describe('new meter', () => {
  it.live('types, saves once with the create command, and goes on to the new meter', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountMeter(runner);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#meter-serial', 'EL-77');
      yield* saveSent(runner, 1);
      expect(runner.sent).toHaveLength(1);
      expect(runner.sent[0]).toMatchObject({ _tag: 'MeterCreate', serialNumber: 'EL-77' });
      expect(calls).toEqual(['saved:created-1']);
    }),
  );

  it.live('reads the required text of a required field in Czech', () =>
    Effect.gen(function* scenario() {
      yield* mountMeter(recordingRunner());
      expect(document.body.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
      const label = document.querySelector('label[for="meter-serial"]');
      expect(label?.textContent ?? '').toContain(requiredLabelFor('cs'));
    }),
  );

  it.live('a refused save keeps the input and says why; the next Uložit sends it again', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner(['unavailable']);
      yield* mountMeter(runner);
      yield* typeInto('#meter-serial', 'EL-77');
      yield* saveSent(runner, 1);
      expect(bodyText()).toContain('facility-operations.common.errors.unavailable');
      expect(calls).toEqual([]);
      yield* saveSent(runner, 2);
      expect(runner.sent[1]).toEqual(runner.sent[0]);
      expect(calls).toEqual(['saved:created-1']);
    }),
  );

  it.live('an untouched form closes at once; typed input asks before Zrušit leaves', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountMeter(runner);
      yield* click(copy.cancel);
      expect(calls).toEqual(['cancel:']);
      yield* typeInto('#meter-serial', 'EL-77');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      expect(calls).toEqual(['cancel:']);
      yield* click(labels.discard);
      expect(calls).toEqual(['cancel:', 'cancel:']);
      expect(runner.sent).toEqual([]);
    }),
  );
});

describe('meter reading', () => {
  it.live('types a value, saves once with the reading command, and leaves', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountReading(runner);
      yield* typeInto('#reading-value', '12,5');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({ _tag: 'MeterReadingRecord', meterId: meter.id, value: 12.5 }),
      ]);
      expect(calls).toEqual([`saved:${meter.id}`]);
    }),
  );

  it.live('leaving with a typed value asks; Zůstat keeps the input', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountReading(runner);
      yield* typeInto('#reading-value', '3');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.stay);
      expect(calls).toEqual([]);
      yield* saveSent(runner, 1);
      expect(calls).toEqual([`saved:${meter.id}`]);
    }),
  );
});
