/* oxlint-disable unicorn/prefer-export-from -- Codesmith Action HTTP requires concrete local schema export declarations. */
import {
  CreateInventoryReservationErrorSchema as ErrorSchema,
  CreateInventoryReservationPayloadSchema as PayloadSchema,
  CreateInventoryReservationResultSchema as ResultSchema,
} from '../domain/inventory-reservation-create.ts';

export const CreateInventoryReservationErrorSchema = ErrorSchema;
export const CreateInventoryReservationPayloadSchema = PayloadSchema;
export const CreateInventoryReservationResultSchema = ResultSchema;
export type { CreateInventoryReservationPayload } from '../domain/inventory-reservation-create.ts';
/* oxlint-enable unicorn/prefer-export-from */
