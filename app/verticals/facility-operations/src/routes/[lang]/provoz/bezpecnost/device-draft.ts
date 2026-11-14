// The security device card's values: a new device is submitted once, an edit of an existing one is sent on Uložit.
import { Option } from 'effect';
import type { Types } from 'effect';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { IsoDateSchema, PropertyRef } from '../../../../../shared/domain/common.ts';
import type { SecurityDevice, SecurityDeviceState, SecurityDeviceType } from '../../../../../shared/domain/security.ts';

type DeviceFields = Omit<Extract<OpsCommand, { readonly _tag: 'SecurityDeviceCreate' }>, '_tag'>;
type MutableDeviceFields = Types.Mutable<DeviceFields>;
type UpdateCommand = Extract<OpsCommand, { readonly _tag: 'SecurityDeviceUpdate' }>;

export interface DeviceDraft {
  administrator: string;
  deviceType: SecurityDeviceType;
  lastInspectionDate: typeof IsoDateSchema.Encoded;
  location: string;
  locationDetail: string;
  name: string;
  nextInspectionDate: typeof IsoDateSchema.Encoded;
  note: string;
  serialNumber: string;
  state: SecurityDeviceState;
  supplier: string;
}

const textKeys = ['administrator', 'locationDetail', 'note', 'serialNumber', 'supplier'] as const;
const dateKeys = ['lastInspectionDate', 'nextInspectionDate'] as const;

export const deviceDraftOf = (device?: SecurityDevice): DeviceDraft => {
  if (device === undefined) {
    return {
      administrator: '',
      deviceType: 'camera',
      lastInspectionDate: '',
      location: '',
      locationDetail: '',
      name: '',
      nextInspectionDate: '',
      note: '',
      serialNumber: '',
      state: 'in_operation',
      supplier: '',
    };
  }
  return {
    administrator: device.administrator ?? '',
    deviceType: device.deviceType,
    lastInspectionDate: device.lastInspectionDate ?? '',
    location: device.location === undefined ? '' : `${device.location.kind}:${device.location.id}`,
    locationDetail: device.locationDetail ?? '',
    name: device.name,
    nextInspectionDate: device.nextInspectionDate ?? '',
    note: device.note ?? '',
    serialNumber: device.serialNumber ?? '',
    state: device.state,
    supplier: device.supplier ?? '',
  };
};

/** Drafts that store the same device card: surrounding spaces do not count. */
export const sameDeviceDraft = (left: DeviceDraft, right: DeviceDraft): boolean =>
  left.deviceType === right.deviceType &&
  left.location === right.location &&
  left.state === right.state &&
  left.name.trim() === right.name.trim() &&
  [...textKeys, ...dateKeys].every((key) => left[key].trim() === right[key].trim());

/** A device card needs its name; every other field is optional. */
export const deviceNameMissing = (draft: DeviceDraft) => draft.name.trim() === '';

/** The stored fields of a draft: only filled-in optional values are sent. */
export const deviceFieldsOf = (draft: DeviceDraft, location?: PropertyRef): DeviceFields => {
  const fields: MutableDeviceFields = {
    deviceType: draft.deviceType,
    name: draft.name.trim(),
    state: draft.state,
  };
  for (const key of [...textKeys, ...dateKeys]) {
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

/** The create a new device card sends. */
export const deviceCreateCommandOf = (draft: DeviceDraft, location?: PropertyRef): Option.Option<OpsCommand> =>
  deviceNameMissing(draft)
    ? Option.none()
    : Option.some({ _tag: 'SecurityDeviceCreate', ...deviceFieldsOf(draft, location) });

/**
 * The update an edit sends; None while the name is missing, so an invalid draft is never saved. Emptied optional
 * fields are cleared explicitly, because an omitted field would keep its stored value.
 */
export const deviceUpdateCommandOf = (
  draft: DeviceDraft,
  device: SecurityDevice,
  location?: PropertyRef,
): Option.Option<OpsCommand> => {
  if (deviceNameMissing(draft)) {
    return Option.none();
  }
  const command: Types.Mutable<UpdateCommand> = {
    _tag: 'SecurityDeviceUpdate',
    ...deviceFieldsOf(draft, location),
    clear: [
      ...[...textKeys, ...dateKeys].filter((key) => draft[key].trim() === '' && device[key] !== undefined),
      ...(location === undefined && device.location !== undefined ? (['location'] as const) : []),
    ],
    deviceId: device.id,
  };
  return Option.some(command);
};
