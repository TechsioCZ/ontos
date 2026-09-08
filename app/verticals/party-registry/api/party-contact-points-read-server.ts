import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import {
  PartyContactPointsAuthenticationProblemSchema,
  PartyContactPointsForbiddenProblemSchema,
  PartyContactPointsInternalProblemSchema,
  PartyContactPointsInvalidProblemSchema,
  PartyContactPointsNotFoundProblemSchema,
  PartyContactPointsPolicyConflictProblemSchema,
  PartyContactPointsPolicyProblemSchema,
  PartyContactPointsUnavailableProblemSchema,
  partyRegistryApi,
} from '../shared/api.ts';
import { partyContactPointsRead } from '../src/api/party-contact-points.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';

const problemStatus = {
  authentication: 401,
  conflict: 409,
  forbidden: 403,
  ineligible: 422,
  internal: 500,
  invalid: 400,
  notFound: 404,
  unavailable: 503,
} as const;

const authenticationProblem = () =>
  PartyContactPointsAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: problemStatus.authentication,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = () =>
  PartyContactPointsUnavailableProblemSchema.make({
    detail: 'The governed read is temporarily unavailable.',
    retryable: true,
    status: problemStatus.unavailable,
    title: 'Read unavailable',
    type: 'https://ontos.dev/problems/read-unavailable',
  });
const invalidProblem = () =>
  PartyContactPointsInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: problemStatus.invalid,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  PartyContactPointsForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: problemStatus.forbidden,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  PartyContactPointsNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: problemStatus.notFound,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === problemStatus.conflict
    ? PartyContactPointsPolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: problemStatus.conflict,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : PartyContactPointsPolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: problemStatus.ineligible,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  PartyContactPointsInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: problemStatus.internal,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof PartyContactPointsAuthenticationProblemSchema.Type
  | typeof PartyContactPointsForbiddenProblemSchema.Type
  | typeof PartyContactPointsInternalProblemSchema.Type
  | typeof PartyContactPointsInvalidProblemSchema.Type
  | typeof PartyContactPointsNotFoundProblemSchema.Type
  | typeof PartyContactPointsPolicyConflictProblemSchema.Type
  | typeof PartyContactPointsPolicyProblemSchema.Type
  | typeof PartyContactPointsUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(PartyContactPointsAuthenticationProblemSchema),
};

export const partyContactPointsReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyContactPoints',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'partyContactPointsReadApiLive.execute',
        registration: partyContactPointsRead,
        problems,
      }),
    ),
);
