import { Effect } from 'effect';
import type { Device as OwnerDevice } from './imported-device-owner.ts';
import type { CivilDaySchema } from './imported-device-owner.ts';

interface Draft {
  readonly title: string;
  readonly dueDate: typeof CivilDaySchema.Type;
}
export const createOwnerTask = (draft: Draft, device: OwnerDevice, tenantId: string) =>
  Effect.succeed({ deviceId: device.id, draft, tenantId });
