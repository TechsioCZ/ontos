import { Schema } from 'effect';
import { CounterpartyRefSchema } from '../domain/access-contract.ts';
import {
  CounterpartyPriceGroupProfileTargetSchema,
  CustomerPriceGroupAssignmentSchema,
  PriceGroupInstantJsonSchema,
  PriceGroupReasonSchema,
  PriceGroupRefSchema,
  PriceGroupRevisionSchema,
} from '../domain/price-group-contracts.ts';

export const AssignCounterpartyPriceGroupPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  effectiveFrom: PriceGroupInstantJsonSchema,
  effectiveTo: Schema.optionalKey(PriceGroupInstantJsonSchema),
  expectedProfileRevision: PriceGroupRevisionSchema,
  priceGroupRef: PriceGroupRefSchema,
  profile: CounterpartyPriceGroupProfileTargetSchema,
  reason: PriceGroupReasonSchema,
}).check(
  Schema.makeFilter((payload) =>
    payload.effectiveTo === undefined || payload.effectiveTo > payload.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
  ),
);
export type AssignCounterpartyPriceGroupPayload =
  typeof AssignCounterpartyPriceGroupPayloadSchema.Type;

export const AssignCounterpartyPriceGroupResultSchema = Schema.Struct({
  assignment: CustomerPriceGroupAssignmentSchema,
  changed: Schema.Boolean,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the existing wire sentinel for no replaced assignment.
  replacedAssignmentRef: Schema.NullOr(CustomerPriceGroupAssignmentSchema.fields.assignmentRef),
});
export type AssignCounterpartyPriceGroupResult =
  typeof AssignCounterpartyPriceGroupResultSchema.Type;
