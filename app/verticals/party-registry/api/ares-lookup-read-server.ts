import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  AresLookupAuthenticationProblemSchema,
  AresLookupForbiddenProblemSchema,
  AresLookupInternalProblemSchema,
  AresLookupInvalidProblemSchema,
  AresLookupNotFoundProblemSchema,
  AresLookupPolicyConflictProblemSchema,
  AresLookupPolicyProblemSchema,
  AresLookupUnavailableProblemSchema,
} from '../shared/apis/ares-lookup.ts';
import { aresLookupRead } from '../src/api/ares-lookup.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';

const problemStatus = {
  authentication: 401,
  conflict: 409,
  forbidden: 403,
  internal: 500,
  invalid: 400,
  notFound: 404,
  unavailable: 503,
  unprocessable: 422,
} as const;

const authenticationProblem = () =>
  AresLookupAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: problemStatus.authentication,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = () =>
  AresLookupUnavailableProblemSchema.make({
    detail: 'The governed read is temporarily unavailable.',
    retryable: true,
    status: problemStatus.unavailable,
    title: 'Read unavailable',
    type: 'https://ontos.dev/problems/read-unavailable',
  });
const invalidProblem = () =>
  AresLookupInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: problemStatus.invalid,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  AresLookupForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: problemStatus.forbidden,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  AresLookupNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: problemStatus.notFound,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === problemStatus.conflict
    ? AresLookupPolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: problemStatus.conflict,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : AresLookupPolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: problemStatus.unprocessable,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  AresLookupInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: problemStatus.internal,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof AresLookupAuthenticationProblemSchema.Type
  | typeof AresLookupForbiddenProblemSchema.Type
  | typeof AresLookupInternalProblemSchema.Type
  | typeof AresLookupInvalidProblemSchema.Type
  | typeof AresLookupNotFoundProblemSchema.Type
  | typeof AresLookupPolicyConflictProblemSchema.Type
  | typeof AresLookupPolicyProblemSchema.Type
  | typeof AresLookupUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(AresLookupAuthenticationProblemSchema),
};

export const aresLookupReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'aresLookup',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'aresLookupReadApiLive.execute',
        registration: aresLookupRead,
        problems,
      }),
    ),
);
