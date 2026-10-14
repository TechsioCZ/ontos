import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
import { CounterpartyRefSchema } from '../domain/access-contract.ts';
import {
  CommerceCustomerGroupMembershipSchema,
  CommerceCustomerGroupSchema,
  CustomerGroupBusinessCodeSchema,
  CustomerGroupIsoTimestampSchema,
} from '../domain/group-contract.ts';

/**
 * Current group memberships of COUNTERPARTY customers, looked up by group business code and Party counterparty.
 * Unknown business codes and counterparties without a purchasing profile are absent from the response.
 */
export const CounterpartyCustomerGroupMembershipsRequestSchema = Schema.Struct({
  businessCodes: Schema.Array(CustomerGroupBusinessCodeSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  counterpartyRefs: Schema.Array(CounterpartyRefSchema).check(Schema.isMaxLength(200)),
});
export type CounterpartyCustomerGroupMembershipsRequest = typeof CounterpartyCustomerGroupMembershipsRequestSchema.Type;
export const CounterpartyCustomerGroupMembershipsResponseSchema = Schema.Struct({
  effectiveAt: CustomerGroupIsoTimestampSchema,
  groups: Schema.Array(CommerceCustomerGroupSchema),
  items: Schema.Array(
    Schema.Struct({ counterpartyRef: CounterpartyRefSchema, membership: CommerceCustomerGroupMembershipSchema }),
  ),
});
export type CounterpartyCustomerGroupMembershipsResponse =
  typeof CounterpartyCustomerGroupMembershipsResponseSchema.Type;

export const CounterpartyCustomerGroupMembershipsAuthenticationProblemSchema = makeProblemDetailsSchema(
  'CounterpartyCustomerGroupMembershipsAuthenticationProblem',
  401,
);
export const CounterpartyCustomerGroupMembershipsInvalidProblemSchema = makeProblemDetailsSchema(
  'CounterpartyCustomerGroupMembershipsInvalidProblem',
  400,
);
export const CounterpartyCustomerGroupMembershipsUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CounterpartyCustomerGroupMembershipsUnavailableProblem',
  503,
);
export const CounterpartyCustomerGroupMembershipsForbiddenProblemSchema = makeProblemDetailsSchema(
  'CounterpartyCustomerGroupMembershipsForbiddenProblem',
  403,
);
export const CounterpartyCustomerGroupMembershipsNotFoundProblemSchema = makeProblemDetailsSchema(
  'CounterpartyCustomerGroupMembershipsNotFoundProblem',
  404,
);
export const CounterpartyCustomerGroupMembershipsPolicyProblemSchema = makeProblemDetailsSchema(
  'CounterpartyCustomerGroupMembershipsPolicyProblem',
  422,
);
export const CounterpartyCustomerGroupMembershipsPolicyConflictProblemSchema = makeProblemDetailsSchema(
  'CounterpartyCustomerGroupMembershipsPolicyConflictProblem',
  409,
);
export const CounterpartyCustomerGroupMembershipsInternalProblemSchema = makeProblemDetailsSchema(
  'CounterpartyCustomerGroupMembershipsInternalProblem',
  500,
);

export const CounterpartyCustomerGroupMembershipsApi = HttpApi.make('CounterpartyCustomerGroupMembershipsApi').add(
  HttpApiGroup.make('counterpartyCustomerGroupMemberships').add(
    HttpApiEndpoint.post('execute', '/reads/counterparty-customer-group-memberships', {
      error: [
        CounterpartyCustomerGroupMembershipsInvalidProblemSchema,
        CounterpartyCustomerGroupMembershipsAuthenticationProblemSchema,
        CounterpartyCustomerGroupMembershipsForbiddenProblemSchema,
        CounterpartyCustomerGroupMembershipsNotFoundProblemSchema,
        CounterpartyCustomerGroupMembershipsPolicyConflictProblemSchema,
        CounterpartyCustomerGroupMembershipsPolicyProblemSchema,
        CounterpartyCustomerGroupMembershipsUnavailableProblemSchema,
        CounterpartyCustomerGroupMembershipsInternalProblemSchema,
      ],
      payload: CounterpartyCustomerGroupMembershipsRequestSchema,
      success: CounterpartyCustomerGroupMembershipsResponseSchema,
    }),
  ),
);
