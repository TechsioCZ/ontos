import { startAutosave } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { SecurityDeviceSchema } from '../../shared/domain/security.ts';
import {
  deviceCreateCommandOf,
  deviceDraftOf,
  deviceNameMissing,
  deviceUpdateCommandOf,
  sameDeviceDraft,
} from '../../src/routes/[lang]/provoz/bezpecnost/device-draft.ts';
import type { DeviceDraft } from '../../src/routes/[lang]/provoz/bezpecnost/device-draft.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const device = Schema.decodeUnknownSync(SecurityDeviceSchema)({
  createdAt: at,
  createdBy: actor,
  deviceType: 'camera',
  id: 'camera-1',
  location: { id: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b', kind: 'property', label: 'Rezidence Parková' },
  name: 'Kamera vstup',
  note: 'Krytá chodba',
  state: 'in_operation',
  supplier: 'Bezpečnost Praha',
  updatedAt: at,
  updatedBy: actor,
});
const stored = deviceDraftOf(device);

describe('security device draft', () => {
  it('starts from the stored card and compares without surrounding spaces', () => {
    expect(stored.name).toBe('Kamera vstup');
    expect(stored.location).toBe(`property:${device.location?.id}`);
    expect(sameDeviceDraft(stored, { ...stored, supplier: ' Bezpečnost Praha ' })).toBe(true);
    expect(sameDeviceDraft(stored, { ...stored, state: 'fault' })).toBe(false);
    // Renaming the card is a change: only surrounding spaces are ignored.
    expect(sameDeviceDraft(stored, { ...stored, name: 'Kamera zadní vstup' })).toBe(false);
  });

  it('never saves a card without a name', () => {
    const blank = { ...stored, name: '   ' };
    expect(deviceNameMissing(blank)).toBe(true);
    expect(Option.isNone(deviceCreateCommandOf(blank))).toBe(true);
    expect(Option.isNone(deviceUpdateCommandOf(blank, device))).toBe(true);
  });

  it('sends only the filled-in fields on create', () => {
    const command = Option.getOrThrow(deviceCreateCommandOf({ ...stored, administrator: '  ' }));
    expect(command).toMatchObject({ name: 'Kamera vstup' });
    expect('administrator' in command).toBe(false);
    expect('location' in command).toBe(false);
  });

  it('clears emptied fields and a removed location on update', () => {
    const command = Option.getOrThrow(
      deviceUpdateCommandOf({ ...stored, location: '', note: '', supplier: 'Bezpečnost Praha s.r.o.' }, device),
    );
    expect(command).toMatchObject({ clear: ['note', 'location'], deviceId: device.id });
  });
});

const panel = Effect.fnUntraced(function* panel(outcome: AutosaveOutcome) {
  const sent: DeviceDraft[] = [];
  const controller = yield* startAutosave(stored, {
    equals: sameDeviceDraft,
    isValid: (value: DeviceDraft) => Option.isSome(deviceUpdateCommandOf(value, device)),
    save: (value: DeviceDraft) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('security device edit panel autosave', () => {
  it.effect('saves a typed note after the quiet time; a blank name stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...stored, name: '' });
      controller.flush();
      expect(controller.status()).toBe('invalid');
      controller.change({ ...stored, note: 'Krytá chodba, nový zámek' });
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ note }) => note)).toEqual(['Krytá chodba, nový zámek']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...stored, supplier: 'Bezpečnost Praha s.r.o.' });
      controller.flush();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...stored, supplier: 'Bezpečnost Praha a.s.' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );
});
