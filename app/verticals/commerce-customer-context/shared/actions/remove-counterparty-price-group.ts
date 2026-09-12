import { Schema } from 'effect';
import { CounterpartyRefSchema } from '../domain/access-contract.ts';
import {
  CounterpartyPriceGroupProfileTargetSchema,
  CustomerPriceGroupAssignmentSchema,
  PriceGroupInstantJsonSchema,
  PriceGroupReasonSchema,
  PriceGroupRevisionSchema,
} from '../domain/price-group-contracts.ts';
import { CustomerPriceGroupAssignmentRefSchema } from '../resources/customer-price-group-assignment.ts';

export const RemoveCounterpartyPriceGroupPayloadSchema = Schema.Struct({
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  counterpartyRef: CounterpartyRefSchema,
  effectiveAt: PriceGroupInstantJsonSchema,
  expectedRevision: PriceGroupRevisionSchema,
  profile: CounterpartyPriceGroupProfileTargetSchema,
  reason: PriceGroupReasonSchema,
});
export type RemoveCounterpartyPriceGroupPayload = typeof RemoveCounterpartyPriceGroupPayloadSchema.Type;

export const RemoveCounterpartyPriceGroupResultSchema = Schema.Struct({
  assignment: CustomerPriceGroupAssignmentSchema,
  changed: Schema.Boolean,
});
