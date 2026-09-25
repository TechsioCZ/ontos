/* oxlint-disable unicorn/prefer-export-from -- Codesmith Action HTTP requires concrete local schema export declarations. */
import {
  ReleaseInventoryReservationErrorSchema as ErrorSchema,
  ReleaseInventoryReservationPayloadSchema as PayloadSchema,
  ReleaseInventoryReservationResultSchema as ResultSchema,
} from '../domain/inventory-reservation-release.ts';

export const ReleaseInventoryReservationErrorSchema = ErrorSchema;
export const ReleaseInventoryReservationPayloadSchema = PayloadSchema;
export const ReleaseInventoryReservationResultSchema = ResultSchema;
export type { ReleaseInventoryReservationPayload } from '../domain/inventory-reservation-release.ts';
/* oxlint-enable unicorn/prefer-export-from */
