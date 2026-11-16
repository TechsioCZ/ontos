import { Schema } from 'effect';
import { CustomerProfileSourceAssertionSchema } from '../domain/customer-profile-source.ts';
import { CounterpartyRefSchema } from '../domain/access-contract.ts';
import {
  OrganizationPriceGroupAssignmentPayloadSchema,
  OrganizationPriceGroupAssignmentResultSchema,
} from '../domain/organization-price-assignment.ts';
import {
  CounterpartyPriceGroupProfileTargetSchema,
  CustomerPriceGroupAssignmentSchema,
  PriceGroupInstantJsonSchema,
  PriceGroupReasonSchema,
  PriceGroupRefSchema,
  PriceGroupRevisionSchema,
} from '../domain/price-group-contracts.ts';

const PersonalCounterpartyPriceGroupPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  effectiveFrom: PriceGroupInstantJsonSchema,
  effectiveTo: Schema.optionalKey(PriceGroupInstantJsonSchema),
  expectedProfileRevision: PriceGroupRevisionSchema,
  priceGroupRef: PriceGroupRefSchema,
  processingKind: Schema.optionalKey(Schema.Literal('PERSONAL_DATA')),
  profile: CounterpartyPriceGroupProfileTargetSchema,
  reason: PriceGroupReasonSchema,
  source: Schema.optionalKey(CustomerProfileSourceAssertionSchema),
}).check(
  Schema.makeFilter((payload) =>
    payload.effectiveTo === undefined || payload.effectiveTo > payload.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
  ),
);
export const AssignCounterpartyPriceGroupPayloadSchema = Schema.Union([
  PersonalCounterpartyPriceGroupPayloadSchema,
  OrganizationPriceGroupAssignmentPayloadSchema,
]);
export type AssignCounterpartyPriceGroupPayload = typeof AssignCounterpartyPriceGroupPayloadSchema.Type;

export const PersonalCounterpartyPriceGroupResultSchema = Schema.Struct({
  assignment: CustomerPriceGroupAssignmentSchema,
  changed: Schema.Boolean,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the existing wire sentinel for no replaced assignment.
  replacedAssignmentRef: Schema.NullOr(CustomerPriceGroupAssignmentSchema.fields.assignmentRef),
});
export const AssignCounterpartyPriceGroupResultSchema = Schema.Union([
  PersonalCounterpartyPriceGroupResultSchema,
  OrganizationPriceGroupAssignmentResultSchema,
]);
