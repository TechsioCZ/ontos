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
  expect(meterAccess(external)).toEqual({ canRead: true, canWrite: true, canReadFinancial: false, canManage: false });
  expect(meterAccess({ ...external, writeOperational: false }).canWrite).toBe(false);
  expect(meterAccess({ ...external, readOperational: false, writeOperational: false }).canRead).toBe(false);
});

it('separates financial reads, nonfinancial reading writes and full management', () => {
  expect(meterAccess(finance)).toEqual({ canRead: true, canWrite: false, canReadFinancial: true, canManage: false });
  expect(meterAccess(operations)).toEqual({ canRead: true, canWrite: true, canReadFinancial: true, canManage: true });
  const reading = command({ _tag: 'MeterReadingRecord', meterId: 'm1', date: '2026-10-20', value: 1250 });
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
      command({ _tag: 'MeterCreate', serialNumber: 'EL-1', medium: 'ELECTRICITY', unit: 'kWh' }),
    ),
  ).toBe(false);
  expect(
    canApplyMeterCommand(
      external,
      command({ _tag: 'MeterUpdate', meterId: 'm1', serialNumber: 'EL-1', medium: 'ELECTRICITY', unit: 'kWh' }),
    ),
  ).toBe(false);
  expect(
    canApplyMeterCommand(
      external,
      command({ _tag: 'MeterReadingVoid', meterId: 'm1', readingId: 'r1', reason: 'oprava' }),
    ),
  ).toBe(false);
  expect(canApplyMeterCommand(operations, command({ ...reading, costMinor: 31000 }))).toBe(true);
});

it('allowlists operational fields, strips free text and documents, and preserves truthful consumption and voids', () => {
  const audit = {
    createdAt: '2026-10-20T08:00:00Z',
    updatedAt: '2026-10-20T08:00:00Z',
    createdBy: {
      principalId: '72000000-0000-4000-8000-000000000021',
      tenantId: '70000000-0000-4000-8000-000000000020',
    },
    updatedBy: {
      principalId: '72000000-0000-4000-8000-000000000021',
      tenantId: '70000000-0000-4000-8000-000000000020',
    },
  };
  const original = Schema.decodeUnknownSync(MetersStateSchema)({
    meters: [
      {
        ...audit,
        id: 'm1',
        serialNumber: 'EL-1',
        medium: 'ELECTRICITY',
        unit: 'kWh',
        supplier: 'protected supplier',
        consumer: 'protected consumer',
        contract: 'protected contract',
        note: 'protected meter note',
        readings: [
          {
            ...audit,
            id: 'r1',
            date: '2026-10-17',
            value: 1200,
            unit: 'kWh',
            note: 'protected reading note',
            costMinor: 12000,
            photo: { id: 'f1', name: 'protected photo', mime: 'image/png', size: 1 },
          },
          {
            ...audit,
            id: 'r2',
            date: '2026-10-18',
            value: 1220,
            unit: 'kWh',
            voided: { at: audit.createdAt, by: audit.createdBy, reason: 'protected cancellation' },
          },
          { ...audit, id: 'r3', date: '2026-10-20', value: 1250, unit: 'kWh', costMinor: 31000, readBy: 'Provoz' },
        ],
      },
    ],
  });
  const projected = operationalMetersState(original);
  expect(Schema.is(MetersStateSchema)(projected)).toBe(true);
  expect(JSON.stringify(projected)).not.toContain('protected');
  expect(JSON.stringify(projected)).not.toContain('costMinor');
  expect(readingRows(projected.meters[0]!)[1]?.consumption).toBe(50);
  expect(monthlySeries(projected.meters)[0]?.costMinor).toBeUndefined();
  expect(original.meters[0]?.readings?.[2]?.costMinor).toBe(31000);
  expect(original.meters[0]?.contract).toBe('protected contract');
});
