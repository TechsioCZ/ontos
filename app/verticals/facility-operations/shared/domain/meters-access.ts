// Explicit operational meter boundary. Full meter aggregates remain restricted.
import { optionalField } from './common.ts';
import { Match } from 'effect';
import type { MetersCommand } from '../commands/meters.ts';
import type { MetersState } from './meters.ts';

export interface MeterGrants {
  readonly readAll: boolean;
  readonly readOperational: boolean;
  readonly writeAll: boolean;
  readonly writeOperational: boolean;
}

export const meterAccess = (grants: MeterGrants) => ({
  canManage: grants.writeAll,
  canRead: grants.readAll || grants.writeAll || grants.readOperational || grants.writeOperational,
  canReadFinancial: grants.readAll || grants.writeAll,
  canWrite: grants.writeAll || grants.writeOperational,
});

/** Operational writers may append readings, never manage meters, void history or submit protected fields. */
export const canApplyMeterCommand = (grants: MeterGrants, command: MetersCommand): boolean =>
  grants.writeAll ||
  (grants.writeOperational &&
    Match.value(command).pipe(
      Match.tag('MeterReadingRecord', (reading) => reading.costMinor === undefined && reading.photo === undefined),
      Match.orElse(() => false),
    ));

/** Allowlist, not a cost-only denylist: contracts, attachments and internal free text stay on the server. */
export const operationalMetersState = (state: MetersState): MetersState => ({
  meters: state.meters.map((meter) => ({
    createdAt: meter.createdAt,
    createdBy: meter.createdBy,
    id: meter.id,
    medium: meter.medium,
    serialNumber: meter.serialNumber,
    unit: meter.unit,
    updatedAt: meter.updatedAt,
    updatedBy: meter.updatedBy,
    ...optionalField('location', meter.location),
    ...optionalField('supplyPoint', meter.supplyPoint),
    ...optionalField('status', meter.status),
    readings: (meter.readings ?? []).map((reading) => ({
      createdAt: reading.createdAt,
      createdBy: reading.createdBy,
      date: reading.date,
      id: reading.id,
      unit: reading.unit,
      updatedAt: reading.updatedAt,
      updatedBy: reading.updatedBy,
      value: reading.value,
      ...optionalField('readBy', reading.readBy),
      // Keep the cancellation marker for correct consumption calculations, without internal reasons.
      ...optionalField(
        'voided',
        reading.voided === undefined
          ? undefined
          : { at: reading.voided.at, by: reading.voided.by, reason: 'Interní údaj' },
      ),
    })),
  })),
});
