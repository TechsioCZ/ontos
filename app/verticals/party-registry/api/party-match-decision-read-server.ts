/* eslint-disable effect-native/no-hand-built-problem-details -- These literals instantiate the shared typed schemas; the rule cannot recognize factory-produced contract schemas. expires: 2027-03-31. */
import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  PartyMatchDecisionAuthenticationProblemSchema,
  PartyMatchDecisionForbiddenProblemSchema,
  PartyMatchDecisionInternalProblemSchema,
  PartyMatchDecisionInvalidProblemSchema,
  PartyMatchDecisionNotFoundProblemSchema,
  PartyMatchDecisionPolicyConflictProblemSchema,
  PartyMatchDecisionPolicyProblemSchema,
  PartyMatchDecisionUnavailableProblemSchema,
} from '../shared/apis/party-match-decision.ts';
import { partyMatchDecisionRead } from '../src/api/party-match-decision.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';

const authenticationProblem = () =>
  PartyMatchDecisionAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = (cause?: unknown) => {
  const problem = PartyMatchDecisionUnavailableProblemSchema.make({
    detail: 'The governed read is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Read unavailable',
    type: 'https://ontos.dev/problems/read-unavailable',
  });
  return cause === undefined
    ? problem
    : Object.defineProperty(problem, 'cause', { enumerable: false, value: cause });
};
const invalidProblem = () =>
  PartyMatchDecisionInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: 400,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  PartyMatchDecisionForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: 403,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  PartyMatchDecisionNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: 404,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === 409
    ? PartyMatchDecisionPolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: 409,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : PartyMatchDecisionPolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: 422,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  PartyMatchDecisionInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: 500,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof PartyMatchDecisionAuthenticationProblemSchema.Type
  | typeof PartyMatchDecisionForbiddenProblemSchema.Type
  | typeof PartyMatchDecisionInternalProblemSchema.Type
  | typeof PartyMatchDecisionInvalidProblemSchema.Type
  | typeof PartyMatchDecisionNotFoundProblemSchema.Type
  | typeof PartyMatchDecisionPolicyConflictProblemSchema.Type
  | typeof PartyMatchDecisionPolicyProblemSchema.Type
  | typeof PartyMatchDecisionUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(PartyMatchDecisionAuthenticationProblemSchema),
};

export const partyMatchDecisionReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyMatchDecision',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'partyMatchDecisionReadApiLive.execute',
        registration: partyMatchDecisionRead,
        problems,
      }),
    ),
);
