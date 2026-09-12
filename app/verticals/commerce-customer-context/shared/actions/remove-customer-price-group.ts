import { Schema } from 'effect';
import {
  CustomerPriceGroupAssignmentSchema,
  PriceGroupInstantJsonSchema,
  PriceGroupReasonSchema,
  PriceGroupRevisionSchema,
  RetailPriceGroupProfileTargetSchema,
} from '../domain/price-group-contracts.ts';
import { CustomerPriceGroupAssignmentRefSchema } from '../resources/customer-price-group-assignment.ts';

export const RemoveCustomerPriceGroupPayloadSchema = Schema.Struct({
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  effectiveAt: PriceGroupInstantJsonSchema,
  expectedRevision: PriceGroupRevisionSchema,
  profile: RetailPriceGroupProfileTargetSchema,
  reason: PriceGroupReasonSchema,
});
export type RemoveCustomerPriceGroupPayload = typeof RemoveCustomerPriceGroupPayloadSchema.Type;

export const RemoveCustomerPriceGroupResultSchema = Schema.Struct({
  assignment: CustomerPriceGroupAssignmentSchema,
  changed: Schema.Boolean,
});
