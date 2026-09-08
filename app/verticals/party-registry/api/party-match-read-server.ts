/* eslint-disable effect-native/no-hand-built-problem-details -- These literals instantiate the shared typed schemas; the rule cannot recognize factory-produced contract schemas. expires: 2027-03-31. */
import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  PartyMatchAuthenticationProblemSchema,
  PartyMatchForbiddenProblemSchema,
  PartyMatchInternalProblemSchema,
  PartyMatchInvalidProblemSchema,
  PartyMatchNotFoundProblemSchema,
  PartyMatchPolicyConflictProblemSchema,
  PartyMatchPolicyProblemSchema,
  PartyMatchUnavailableProblemSchema,
} from '../shared/apis/party-match.ts';
import { partyMatchRead } from '../src/api/party-match.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';

const authenticationProblem = () =>
  PartyMatchAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = (cause?: unknown) => {
  const problem = PartyMatchUnavailableProblemSchema.make({
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
  PartyMatchInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: 400,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  PartyMatchForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: 403,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  PartyMatchNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: 404,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === 409
    ? PartyMatchPolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: 409,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : PartyMatchPolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: 422,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  PartyMatchInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: 500,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof PartyMatchAuthenticationProblemSchema.Type
  | typeof PartyMatchForbiddenProblemSchema.Type
  | typeof PartyMatchInternalProblemSchema.Type
  | typeof PartyMatchInvalidProblemSchema.Type
  | typeof PartyMatchNotFoundProblemSchema.Type
  | typeof PartyMatchPolicyConflictProblemSchema.Type
  | typeof PartyMatchPolicyProblemSchema.Type
  | typeof PartyMatchUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(PartyMatchAuthenticationProblemSchema),
};

export const partyMatchReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyMatch',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'partyMatchReadApiLive.execute',
        registration: partyMatchRead,
        problems,
      }),
    ),
);
