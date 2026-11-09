import { Schema } from 'effect';
import { CustomerPriceGroupAssignmentRefSchema } from '../resources/customer-price-group-assignment.ts';
import { CustomerProfileSourceAssertionSchema } from './customer-profile-source.ts';
import { CounterpartyRefSchema } from './access-contract.ts';
import {
  CounterpartyPriceGroupProfileTargetSchema,
  PriceGroupInstantJsonSchema,
  PriceGroupRefSchema,
  PriceGroupRevisionSchema,
} from './price-group-contracts.ts';

/** This is an explicit processing intent. A fresh governed Organization proof decides its eligibility. */
export const OrganizationPriceGroupAssignmentPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  effectiveFrom: PriceGroupInstantJsonSchema,
  effectiveTo: Schema.optionalKey(PriceGroupInstantJsonSchema),
  expectedProfileRevision: PriceGroupRevisionSchema,
  priceGroupRef: PriceGroupRefSchema,
  processingKind: Schema.Literal('ORGANIZATION_BUSINESS'),
  profile: CounterpartyPriceGroupProfileTargetSchema,
  reason: Schema.optionalKey(Schema.Never),
  source: CustomerProfileSourceAssertionSchema,
}).check(
  Schema.makeFilter((input) =>
    input.effectiveTo === undefined || input.effectiveTo > input.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
  ),
);
export type OrganizationPriceGroupAssignmentPayload = typeof OrganizationPriceGroupAssignmentPayloadSchema.Type;

/** Safe first response and event body. Historical reasons, compatibility details and actor data are absent. */
export const OrganizationPriceGroupAssignmentResultSchema = Schema.Struct({
  assignment: Schema.Struct({
    assignmentRef: CustomerPriceGroupAssignmentRefSchema,
    effectiveFrom: PriceGroupInstantJsonSchema,
    effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(PriceGroupInstantJsonSchema)),
    priceGroupRef: PriceGroupRefSchema,
    profile: CounterpartyPriceGroupProfileTargetSchema,
    recordedAt: PriceGroupInstantJsonSchema,
    revision: PriceGroupRevisionSchema,
    state: Schema.Literals(['ACTIVE', 'CANCELLED']),
  }),
  changed: Schema.Boolean,
  processingKind: Schema.Literal('ORGANIZATION_BUSINESS'),
  replacedAssignmentRef: Schema.toEncoded(Schema.OptionFromNullOr(CustomerPriceGroupAssignmentRefSchema)),
});
