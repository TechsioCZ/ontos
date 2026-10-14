import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { commerceCustomerContextApi } from '../shared/api.ts';
import {
  CounterpartyCustomerGroupMembershipsAuthenticationProblemSchema,
  CounterpartyCustomerGroupMembershipsForbiddenProblemSchema,
  CounterpartyCustomerGroupMembershipsInternalProblemSchema,
  CounterpartyCustomerGroupMembershipsInvalidProblemSchema,
  CounterpartyCustomerGroupMembershipsNotFoundProblemSchema,
  CounterpartyCustomerGroupMembershipsPolicyConflictProblemSchema,
  CounterpartyCustomerGroupMembershipsPolicyProblemSchema,
  CounterpartyCustomerGroupMembershipsUnavailableProblemSchema,
} from '../shared/apis/counterparty-customer-group-memberships.ts';
import { counterpartyCustomerGroupMembershipsRead } from '../src/api/counterparty-customer-group-memberships.read.ts';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';

const problems = makeGovernedReadProblems({
  authentication: CounterpartyCustomerGroupMembershipsAuthenticationProblemSchema,
  forbidden: CounterpartyCustomerGroupMembershipsForbiddenProblemSchema,
  internal: CounterpartyCustomerGroupMembershipsInternalProblemSchema,
  invalid: CounterpartyCustomerGroupMembershipsInvalidProblemSchema,
  notFound: CounterpartyCustomerGroupMembershipsNotFoundProblemSchema,
  policyConflict: CounterpartyCustomerGroupMembershipsPolicyConflictProblemSchema,
  policyIneligible: CounterpartyCustomerGroupMembershipsPolicyProblemSchema,
  unavailable: CounterpartyCustomerGroupMembershipsUnavailableProblemSchema,
});

export const counterpartyCustomerGroupMembershipsReadApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'counterpartyCustomerGroupMemberships',
  (handlers) =>
    handlers.handle(
      'execute',
      makeGovernedReadHttpHandler({
        authenticatePrincipal: authenticateOperationPrincipal,
        problems,
        registration: counterpartyCustomerGroupMembershipsRead,
      }),
    ),
);
