import { Schema } from 'effect';
import {
  CustomerPriceGroupAssignmentSchema,
  PriceGroupInstantJsonSchema,
  PriceGroupReasonSchema,
  PriceGroupRefSchema,
  PriceGroupRevisionSchema,
  RetailPriceGroupProfileTargetSchema,
} from '../domain/price-group-contracts.ts';

export const AssignCustomerPriceGroupPayloadSchema = Schema.Struct({
  effectiveFrom: PriceGroupInstantJsonSchema,
  effectiveTo: Schema.optionalKey(PriceGroupInstantJsonSchema),
  expectedProfileRevision: PriceGroupRevisionSchema,
  priceGroupRef: PriceGroupRefSchema,
  profile: RetailPriceGroupProfileTargetSchema,
  reason: PriceGroupReasonSchema,
}).check(
  Schema.makeFilter((payload) =>
    payload.effectiveTo === undefined || payload.effectiveTo > payload.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
  ),
);
export type AssignCustomerPriceGroupPayload = typeof AssignCustomerPriceGroupPayloadSchema.Type;

export const AssignCustomerPriceGroupResultSchema = Schema.Struct({
  assignment: CustomerPriceGroupAssignmentSchema,
  changed: Schema.Boolean,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the existing wire sentinel for no replaced assignment.
  replacedAssignmentRef: Schema.NullOr(CustomerPriceGroupAssignmentSchema.fields.assignmentRef),
});
