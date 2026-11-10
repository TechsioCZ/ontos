import { startDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { MeterSchema } from '../../shared/domain/meters.ts';
import {
  meterCreateCommandOf,
  meterDraftOf,
  meterProblems,
  meterUpdateCommandOf,
  sameMeterDraft,
} from '../../src/routes/[lang]/provoz/meridla/meter-draft.ts';
import type { MeterDraft } from '../../src/routes/[lang]/provoz/meridla/meter-draft.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const meter = Schema.decodeUnknownSync(MeterSchema)({
  createdAt: at,
  createdBy: actor,
  id: 'meter-1',
  location: { id: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b', kind: 'property', label: 'Rezidence Parková' },
  medium: 'ELECTRICITY',
  note: 'Hlavní elektroměr',
  serialNumber: 'EL-2026-001',
  status: 'ACTIVE',
  supplier: 'PRE',
  unit: 'kWh',
  updatedAt: at,
  updatedBy: actor,
});
const stored = meterDraftOf(meter);

describe('meter card draft', () => {
  it('starts from the stored meter and compares without surrounding spaces', () => {
    expect(stored.serialNumber).toBe('EL-2026-001');
    expect(stored.location).toBe(`property:${meter.location?.id}`);
    expect(stored.retired).toBe(false);
    expect(sameMeterDraft(stored, { ...stored, supplier: ' PRE ' })).toBe(true);
    expect(sameMeterDraft(stored, { ...stored, serialNumber: 'EL-2026-002' })).toBe(false);
    expect(sameMeterDraft(stored, { ...stored, retired: true })).toBe(false);
  });

  it('never saves a card without a serial number or a unit', () => {
    const missingSerial = { ...stored, serialNumber: '  ' };
    const missingUnit = { ...stored, unit: '' };
    expect(meterProblems(missingSerial).serialNumber).toBe(true);
    expect(Option.isNone(meterCreateCommandOf(missingSerial))).toBe(true);
    expect(Option.isNone(meterUpdateCommandOf(missingUnit, meter))).toBe(true);
  });

  it('sends the trimmed fields and the requested status on update', () => {
    const command = Option.getOrThrow(
      meterUpdateCommandOf({ ...stored, note: '  Vyměněn 2026  ', retired: true }, meter),
    );
    expect(command).toMatchObject({ meterId: meter.id, note: 'Vyměněn 2026', status: 'RETIRED' });
    const created = Option.getOrThrow(meterCreateCommandOf({ ...stored, supplier: '' }));
    expect(created).toMatchObject({ serialNumber: 'EL-2026-001', unit: 'kWh' });
    expect('supplier' in created).toBe(false);
  });
});

const panel = Effect.fnUntraced(function* panel(outcome: SaveOutcome) {
  const sent: MeterDraft[] = [];
  const controller = yield* startDraftSave(stored, {
    equals: sameMeterDraft,
    isValid: (value: MeterDraft) => Option.isSome(meterUpdateCommandOf(value, meter)),
    save: (value: MeterDraft) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('meter card edit autosave', () => {
  it.effect('saves a retyped serial number after the quiet time; an empty unit stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...stored, unit: '' });
      controller.save();
      expect(controller.status()).toBe('invalid');
      controller.change({ ...stored, serialNumber: 'EL-2026-042' });
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ serialNumber }) => serialNumber)).toEqual(['EL-2026-042']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...stored, note: 'Vyměněn 2026' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...stored, note: 'Vyměněn 2027' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );
});
