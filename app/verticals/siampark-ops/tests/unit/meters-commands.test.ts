import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { evolveMeters, MetersCommandSchema } from '../../shared/commands/meters.ts';
import { MetersStateSchema, monthlySeries, readingProblem, readingRows, recentAnomalyRow } from '../../shared/domain/meters.ts';
import type { MetersState } from '../../shared/domain/meters.ts';
import { seedMetersState } from '../../scripts/seed/meters.mts';

const actor = { principalId: '72000000-0000-4000-8000-000000000022', tenantId: '70000000-0000-4000-8000-000000000020' };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const decodeCommand = Schema.decodeUnknownSync(MetersCommandSchema);
const empty: MetersState = { meters: [] };

const apply = (state: MetersState, command: typeof MetersCommandSchema.Encoded, resourceId: string) =>
  evolveMeters(state, decodeCommand(command), { actor, now, resourceId });

const meterId = 'meter-1';
const withMeter = () =>
  apply(empty, { _tag: 'MeterCreate', medium: 'ELECTRICITY', serialNumber: 'EL-1', unit: 'kWh' }, meterId);

const read = (state: MetersState, date: string, value: number, id: string, extra: Record<string, unknown> = {}) =>
  apply(state, { _tag: 'MeterReadingRecord', date, meterId, value, ...extra }, id);

it.effect('S04-01: 1 200 kWh then 1 250 kWh on one meter shows a difference of 50 kWh', () =>
  Effect.gen(function* () {
    const created = yield* withMeter();
    const first = yield* read(created.state, '2026-09-01', 1200, 'r1');
    const second = yield* read(first.state, '2026-10-01', 1250, 'r2');
    const rows = readingRows(second.state.meters[0] ?? { readings: [] });
    expect(rows.map((row) => row.status)).toEqual(['first', 'ok']);
    expect(rows[1]?.consumption).toBe(50);
    expect(rows[1]?.days).toBe(30);
    expect(second.entityIds).toEqual([meterId, 'r2']);
  }),
);

it.effect('S04-02: the first reading never shows an invented consumption', () =>
  Effect.gen(function* () {
    const created = yield* withMeter();
    const first = yield* read(created.state, '2026-09-01', 1200, 'r1');
    const [row] = readingRows(first.state.meters[0] ?? { readings: [] });
    expect(row?.status).toBe('first');
    expect(row?.consumption).toBeUndefined();
    expect(monthlySeries(first.state.meters)).toEqual([]);
  }),
);

it.effect('refuses lower values, duplicate dates and future dates; out-of-order readings must fit', () =>
  Effect.gen(function* () {
    const created = yield* withMeter();
    const first = yield* read(created.state, '2026-09-01', 1200, 'r1');
    const second = yield* read(first.state, '2026-10-01', 1250, 'r2');
    const lower = yield* Effect.flip(read(second.state, '2026-10-10', 1240, 'r3'));
    expect(lower._tag).toBe('SiamparkOpsLifecycleConflict');
    const duplicate = yield* Effect.flip(read(second.state, '2026-10-01', 1260, 'r3'));
    expect(duplicate._tag).toBe('SiamparkOpsLifecycleConflict');
    const future = yield* Effect.flip(read(second.state, '2026-10-21', 1300, 'r3'));
    expect(future._tag).toBe('SiamparkOpsLifecycleConflict');
    const tooHigh = yield* Effect.flip(read(second.state, '2026-09-15', 1251, 'r3'));
    expect(tooHigh._tag).toBe('SiamparkOpsLifecycleConflict');
    const between = yield* read(second.state, '2026-09-15', 1220, 'r3');
    const rows = readingRows(between.state.meters[0] ?? { readings: [] });
    expect(rows.map((row) => row.consumption)).toEqual([undefined, 20, 30]);
    const missing = yield* Effect.flip(
      apply(second.state, { _tag: 'MeterReadingRecord', date: '2026-10-02', meterId: 'nope', value: 1 }, 'r9'),
    );
    expect(missing._tag).toBe('SiamparkOpsNotFound');
  }),
);

it.effect('flags a jump of the daily consumption above 30 % as an anomaly', () =>
  Effect.gen(function* () {
    const created = yield* withMeter();
    const a = yield* read(created.state, '2026-07-01', 1000, 'r1');
    const b = yield* read(a.state, '2026-07-31', 1300, 'r2'); // 10 / day
    const c = yield* read(b.state, '2026-08-30', 1620, 'r3'); // 10.67 / day (+6.7 %)
    const d = yield* read(c.state, '2026-09-29', 2100, 'r4'); // 16 / day (+50 %)
    const rows = readingRows(d.state.meters[0] ?? { readings: [] });
    expect(rows.map((row) => row.anomaly)).toEqual([false, false, false, true]);
    expect(Math.round((rows[3]?.change ?? 0) * 100)).toBe(50);
  }),
);

it.effect('a voided reading stays in history but is skipped by calculations', () =>
  Effect.gen(function* () {
    const created = yield* withMeter();
    const a = yield* read(created.state, '2026-09-01', 1200, 'r1');
    const typo = yield* read(a.state, '2026-09-15', 2100, 'r2');
    const voided = yield* apply(typo.state, { _tag: 'MeterReadingVoid', meterId, readingId: 'r2', reason: 'Překlep' }, 'v1');
    const meter = voided.state.meters[0];
    expect(meter?.readings?.length).toBe(2);
    expect(meter?.readings?.[1]?.voided?.reason).toBe('Překlep');
    const after = yield* read(voided.state, '2026-10-01', 1250, 'r3');
    expect(readingRows(after.state.meters[0] ?? { readings: [] }).map((row) => row.consumption)).toEqual([undefined, 50]);
    const again = yield* Effect.flip(
      apply(after.state, { _tag: 'MeterReadingVoid', meterId, readingId: 'r2', reason: 'znovu' }, 'v2'),
    );
    expect(again._tag).toBe('SiamparkOpsLifecycleConflict');
  }),
);

it.effect('a unit change of the meter stops the difference (same meter and unit only)', () =>
  Effect.gen(function* () {
    const created = yield* withMeter();
    const a = yield* read(created.state, '2026-09-01', 1200, 'r1');
    const updated = yield* apply(
      a.state,
      { _tag: 'MeterUpdate', meterId, medium: 'ELECTRICITY', serialNumber: 'EL-1', unit: 'MWh' },
      'u1',
    );
    const b = yield* read(updated.state, '2026-10-01', 1.25, 'r2');
    const rows = readingRows(b.state.meters[0] ?? { readings: [] });
    expect(rows[1]?.status).toBe('unitChanged');
    expect(rows[1]?.consumption).toBeUndefined();
    const retired = yield* apply(
      b.state,
      { _tag: 'MeterUpdate', meterId, medium: 'ELECTRICITY', serialNumber: 'EL-1', status: 'RETIRED', unit: 'MWh' },
      'u2',
    );
    expect(readingProblem(retired.state.meters[0] ?? { readings: [], unit: 'MWh' }, { date: '2026-10-02', value: 2 }, '2026-10-20')).toBe(
      'retired',
    );
  }),
);

it.effect('rejects a duplicate serial number', () =>
  Effect.gen(function* () {
    const created = yield* withMeter();
    const duplicate = yield* Effect.flip(
      apply(created.state, { _tag: 'MeterCreate', medium: 'WATER', serialNumber: 'el-1', unit: 'm³' }, 'm2'),
    );
    expect(duplicate._tag).toBe('SiamparkOpsLifecycleConflict');
  }),
);

it.effect('the seed decodes, covers every Siampark unit and stages the demo cases', () =>
  Effect.gen(function* () {
    const state = yield* Schema.decodeUnknownEffect(MetersStateSchema)(seedMetersState());
    const unitIds = new Set(state.meters.flatMap((meter) => (meter.location?.kind === 'unit' ? [meter.location.id] : [])));
    expect(unitIds.size).toBe(8);
    const bySerial = (serial: string) => state.meters.find((meter) => meter.serialNumber === serial) ?? { readings: [] };
    expect(readingRows(bySerial('VO-PK-A202')).some((row) => row.anomaly)).toBe(true);
    expect(readingRows(bySerial('EL-RV-R101')).some((row) => row.anomaly)).toBe(true);
    expect(readingRows(bySerial('EL-RV-S01-CH')).map((row) => row.status)).toEqual(['first']);
    const anomalies = state.meters.filter((meter) => readingRows(meter).some((row) => row.anomaly));
    expect(anomalies.map((meter) => meter.serialNumber).sort()).toEqual(['EL-RV-R101', 'VO-PK-A202']);
    // Both staged anomalies are still highlighted on 20. 10. 2026, and expire after the window.
    expect(recentAnomalyRow(bySerial('VO-PK-A202'), '2026-10-20')?.reading.date).toBe('2026-09-30');
    expect(recentAnomalyRow(bySerial('EL-RV-R101'), '2026-10-20')?.reading.date).toBe('2026-08-31');
    expect(recentAnomalyRow(bySerial('EL-RV-R101'), '2026-12-31')).toBeUndefined();
  }),
);
