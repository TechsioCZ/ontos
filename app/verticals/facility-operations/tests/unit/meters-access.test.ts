import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { metersAgenda, MetersCommandSchema } from '../../shared/commands/meters.ts';
import { canApplyMeterCommand, meterAccess, operationalMetersState } from '../../shared/domain/meters-access.ts';
import { MetersStateSchema, monthlySeries, readingRows } from '../../shared/domain/meters.ts';
import { canReadAgenda, canWriteAgenda } from '../../src/services/persistence.service.ts';

const external = { readAll: false, readOperational: true, writeAll: false, writeOperational: true };
const finance = { readAll: true, readOperational: false, writeAll: false, writeOperational: false };
const operations = { ...finance, writeAll: true };
const command = Schema.decodeUnknownSync(MetersCommandSchema);

it('keeps full meter aggregates restricted while allowing the explicit operational projection', () => {
  expect(metersAgenda.sensitivity).toBe('restricted');
  expect(canReadAgenda(external, metersAgenda.sensitivity)).toBe(false);
  expect(canWriteAgenda(external, metersAgenda.sensitivity)).toBe(false);
  expect(meterAccess(external)).toEqual({ canManage: false, canRead: true, canReadFinancial: false, canWrite: true });
  expect(meterAccess({ ...external, writeOperational: false }).canWrite).toBe(false);
  expect(meterAccess({ ...external, readOperational: false, writeOperational: false }).canRead).toBe(false);
});

it('separates financial reads, nonfinancial reading writes and full management', () => {
  expect(meterAccess(finance)).toEqual({ canManage: false, canRead: true, canReadFinancial: true, canWrite: false });
  expect(meterAccess(operations)).toEqual({ canManage: true, canRead: true, canReadFinancial: true, canWrite: true });
  const reading = command({ _tag: 'MeterReadingRecord', date: '2026-10-20', meterId: 'm1', value: 1250 });
  expect(canApplyMeterCommand(external, reading)).toBe(true);
  expect(canApplyMeterCommand(finance, reading)).toBe(false);
  expect(canApplyMeterCommand(external, command({ ...reading, costMinor: 0 }))).toBe(false);
  expect(
    canApplyMeterCommand(
      external,
      command({ ...reading, photo: { id: 'f1', mime: 'image/png', name: 'foto', size: 1 } }),
    ),
  ).toBe(false);
  expect(
    canApplyMeterCommand(
      external,
      command({ _tag: 'MeterCreate', medium: 'ELECTRICITY', serialNumber: 'EL-1', unit: 'kWh' }),
    ),
  ).toBe(false);
  expect(
    canApplyMeterCommand(
      external,
      command({ _tag: 'MeterUpdate', medium: 'ELECTRICITY', meterId: 'm1', serialNumber: 'EL-1', unit: 'kWh' }),
    ),
  ).toBe(false);
  expect(
    canApplyMeterCommand(
      external,
      command({ _tag: 'MeterReadingVoid', meterId: 'm1', readingId: 'r1', reason: 'oprava' }),
    ),
  ).toBe(false);
  expect(canApplyMeterCommand(operations, command({ ...reading, costMinor: 31_000 }))).toBe(true);
});

it('allowlists operational fields, strips free text and documents, and preserves truthful consumption and voids', () => {
  const audit = {
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: {
      principalId: '72000000-0000-4000-8000-000000000021',
      tenantId: '70000000-0000-4000-8000-000000000020',
    },
    updatedAt: '2026-10-20T08:00:00Z',
    updatedBy: {
      principalId: '72000000-0000-4000-8000-000000000021',
      tenantId: '70000000-0000-4000-8000-000000000020',
    },
  };
  const original = Schema.decodeUnknownSync(MetersStateSchema)({
    meters: [
      {
        ...audit,
        consumer: 'protected consumer',
        contract: 'protected contract',
        id: 'm1',
        medium: 'ELECTRICITY',
        note: 'protected meter note',
        readings: [
          {
            ...audit,
            costMinor: 12_000,
            date: '2026-10-17',
            id: 'r1',
            note: 'protected reading note',
            photo: { id: 'f1', mime: 'image/png', name: 'protected photo', size: 1 },
            unit: 'kWh',
            value: 1200,
          },
          {
            ...audit,
            date: '2026-10-18',
            id: 'r2',
            unit: 'kWh',
            value: 1220,
            voided: { at: audit.createdAt, by: audit.createdBy, reason: 'protected cancellation' },
          },
          { ...audit, costMinor: 31_000, date: '2026-10-20', id: 'r3', readBy: 'Provoz', unit: 'kWh', value: 1250 },
        ],
        serialNumber: 'EL-1',
        supplier: 'protected supplier',
        unit: 'kWh',
      },
    ],
  });
  const projected = operationalMetersState(original);
  expect(Schema.is(MetersStateSchema)(projected)).toBe(true);
  expect(JSON.stringify(projected)).not.toContain('protected');
  expect(JSON.stringify(projected)).not.toContain('costMinor');
  expect(readingRows(projected.meters[0])[1]?.consumption).toBe(50);
  expect(monthlySeries(projected.meters)[0]?.costMinor).toBeUndefined();
  expect(original.meters[0]?.readings?.[2]?.costMinor).toBe(31_000);
  expect(original.meters[0]?.contract).toBe('protected contract');
});
