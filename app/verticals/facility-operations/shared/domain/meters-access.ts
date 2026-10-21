// Explicit operational meter boundary. Full meter aggregates remain restricted.
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
    command._tag === 'MeterReadingRecord' &&
    command.costMinor === undefined &&
    command.photo === undefined);

/** Allowlist, not a cost-only denylist: contracts, attachments and internal free text stay on the server. */
export const operationalMetersState = (state: MetersState): MetersState => ({
  meters: state.meters.map((meter) => ({
    id: meter.id,
    serialNumber: meter.serialNumber,
    medium: meter.medium,
    unit: meter.unit,
    createdAt: meter.createdAt,
    createdBy: meter.createdBy,
    updatedAt: meter.updatedAt,
    updatedBy: meter.updatedBy,
    ...(meter.location === undefined ? {} : { location: meter.location }),
    ...(meter.supplyPoint === undefined ? {} : { supplyPoint: meter.supplyPoint }),
    ...(meter.status === undefined ? {} : { status: meter.status }),
    readings: (meter.readings ?? []).map((reading) => ({
      id: reading.id,
      date: reading.date,
      value: reading.value,
      unit: reading.unit,
      createdAt: reading.createdAt,
      createdBy: reading.createdBy,
      updatedAt: reading.updatedAt,
      updatedBy: reading.updatedBy,
      ...(reading.readBy === undefined ? {} : { readBy: reading.readBy }),
      // Keep the cancellation marker for correct consumption calculations, without internal reasons.
      ...(reading.voided === undefined
        ? {}
        : {
            voided: { at: reading.voided.at, by: reading.voided.by, reason: 'Interní údaj' },
          }),
    })),
  })),
});
