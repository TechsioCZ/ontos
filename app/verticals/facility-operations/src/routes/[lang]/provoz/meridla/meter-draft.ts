// The meter master-data card's values: a new meter is submitted once, an edit is sent on Uložit.
import { Option } from 'effect';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import type { Meter, MeterMedium } from '../../../../../shared/domain/meters.ts';
import { defaultUnitOf } from './meters-view.ts';

type MeterFields = Omit<Extract<OpsCommand, { readonly _tag: 'MeterCreate' }>, '_tag'>;
type MutableMeterFields = { -readonly [Key in keyof MeterFields]: MeterFields[Key] };
type UpdateCommand = Extract<OpsCommand, { readonly _tag: 'MeterUpdate' }>;

export interface MeterDraft {
  consumer: string;
  contract: string;
  location: string;
  medium: MeterMedium;
  note: string;
  retired: boolean;
  serialNumber: string;
  supplier: string;
  supplyPoint: string;
  unit: string;
}

/** Optional free texts; blank ones are left out of a command. */
const textKeys = ['consumer', 'contract', 'note', 'supplier', 'supplyPoint'] as const;

export const meterDraftOf = (meter?: Meter): MeterDraft => ({
  consumer: meter?.consumer ?? '',
  contract: meter?.contract ?? '',
  location: meter?.location === undefined ? '' : `${meter.location.kind}:${meter.location.id}`,
  medium: meter?.medium ?? 'ELECTRICITY',
  note: meter?.note ?? '',
  retired: meter?.status === 'RETIRED',
  serialNumber: meter?.serialNumber ?? '',
  supplier: meter?.supplier ?? '',
  supplyPoint: meter?.supplyPoint ?? '',
  unit: meter?.unit ?? defaultUnitOf.ELECTRICITY,
});

/** Drafts that store the same card: surrounding spaces do not count. */
export const sameMeterDraft = (left: MeterDraft, right: MeterDraft): boolean =>
  left.medium === right.medium &&
  left.location === right.location &&
  left.retired === right.retired &&
  left.serialNumber.trim() === right.serialNumber.trim() &&
  left.unit.trim() === right.unit.trim() &&
  textKeys.every((key) => left[key].trim() === right[key].trim());

export interface MeterProblems {
  readonly serialNumber: boolean;
  readonly unit: boolean;
}

export const meterProblems = (draft: MeterDraft): MeterProblems => ({
  serialNumber: draft.serialNumber.trim() === '',
  unit: draft.unit.trim() === '',
});

/** The stored fields of a draft: only filled-in optional values are sent. */
export const meterFieldsOf = (draft: MeterDraft, location?: PropertyRef): MeterFields => {
  const fields: MutableMeterFields = {
    medium: draft.medium,
    serialNumber: draft.serialNumber.trim(),
    unit: draft.unit.trim(),
  };
  for (const key of textKeys) {
    const value = draft[key].trim();
    if (value !== '') {
      fields[key] = value;
    }
  }
  if (location !== undefined) {
    fields.location = location;
  }
  return fields;
};

const valid = (draft: MeterDraft) => {
  const problems = meterProblems(draft);
  return !problems.serialNumber && !problems.unit;
};

/** The create a new meter card sends; None while the serial number or the unit is missing. */
export const meterCreateCommandOf = (draft: MeterDraft, location?: PropertyRef): Option.Option<OpsCommand> =>
  valid(draft) ? Option.some({ _tag: 'MeterCreate', ...meterFieldsOf(draft, location) }) : Option.none();

/** The update an edit sends; None while the serial number or the unit is missing. */
export const meterUpdateCommandOf = (
  draft: MeterDraft,
  meter: Meter,
  location?: PropertyRef,
): Option.Option<OpsCommand> => {
  if (!valid(draft)) {
    return Option.none();
  }
  const command: { -readonly [Key in keyof UpdateCommand]: UpdateCommand[Key] } = {
    _tag: 'MeterUpdate',
    ...meterFieldsOf(draft, location),
    meterId: meter.id,
    status: draft.retired ? 'RETIRED' : 'ACTIVE',
  };
  return Option.some(command);
};
