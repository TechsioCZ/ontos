import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  PersonEngagementProfileAuthenticationProblemSchema,
  PersonEngagementProfileForbiddenProblemSchema,
  PersonEngagementProfileInternalProblemSchema,
  PersonEngagementProfileInvalidProblemSchema,
  PersonEngagementProfileNotFoundProblemSchema,
  PersonEngagementProfilePolicyConflictProblemSchema,
  PersonEngagementProfilePolicyProblemSchema,
  PersonEngagementProfileUnavailableProblemSchema,
} from '../shared/apis/person-engagement-profile.ts';
import { personEngagementProfileRead } from '../src/api/person-engagement-profile.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';
import { governedReadProblemStatus } from './read-server-support.ts';

const authenticationProblem = () =>
  PersonEngagementProfileAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: governedReadProblemStatus.authentication,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = () =>
  PersonEngagementProfileUnavailableProblemSchema.make({
    detail: 'The governed read is temporarily unavailable.',
    retryable: true,
    status: governedReadProblemStatus.unavailable,
    title: 'Read unavailable',
    type: 'https://ontos.dev/problems/read-unavailable',
  });
const invalidProblem = () =>
  PersonEngagementProfileInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: governedReadProblemStatus.invalid,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  PersonEngagementProfileForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: governedReadProblemStatus.forbidden,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  PersonEngagementProfileNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: governedReadProblemStatus.notFound,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === 409
    ? PersonEngagementProfilePolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: governedReadProblemStatus.policyConflict,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : PersonEngagementProfilePolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: governedReadProblemStatus.policyDenied,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  PersonEngagementProfileInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: governedReadProblemStatus.internal,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof PersonEngagementProfileAuthenticationProblemSchema.Type
  | typeof PersonEngagementProfileForbiddenProblemSchema.Type
  | typeof PersonEngagementProfileInternalProblemSchema.Type
  | typeof PersonEngagementProfileInvalidProblemSchema.Type
  | typeof PersonEngagementProfileNotFoundProblemSchema.Type
  | typeof PersonEngagementProfilePolicyConflictProblemSchema.Type
  | typeof PersonEngagementProfilePolicyProblemSchema.Type
  | typeof PersonEngagementProfileUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(PersonEngagementProfileAuthenticationProblemSchema),
};

export const personEngagementProfileReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'personEngagementProfile',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'personEngagementProfileReadApiLive.execute',
        registration: personEngagementProfileRead,
        problems,
      }),
    ),
);
