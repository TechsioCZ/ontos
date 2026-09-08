import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  OrganizationEngagementProfileAuthenticationProblemSchema,
  OrganizationEngagementProfileForbiddenProblemSchema,
  OrganizationEngagementProfileInternalProblemSchema,
  OrganizationEngagementProfileInvalidProblemSchema,
  OrganizationEngagementProfileNotFoundProblemSchema,
  OrganizationEngagementProfilePolicyConflictProblemSchema,
  OrganizationEngagementProfilePolicyProblemSchema,
  OrganizationEngagementProfileUnavailableProblemSchema,
} from '../shared/apis/organization-engagement-profile.ts';
import { organizationEngagementProfileRead } from '../src/api/organization-engagement-profile.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';
import { governedReadProblemStatus } from './read-server-support.ts';

const authenticationProblem = () =>
  OrganizationEngagementProfileAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: governedReadProblemStatus.authentication,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = () =>
  OrganizationEngagementProfileUnavailableProblemSchema.make({
    detail: 'The governed read is temporarily unavailable.',
    retryable: true,
    status: governedReadProblemStatus.unavailable,
    title: 'Read unavailable',
    type: 'https://ontos.dev/problems/read-unavailable',
  });
const invalidProblem = () =>
  OrganizationEngagementProfileInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: governedReadProblemStatus.invalid,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  OrganizationEngagementProfileForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: governedReadProblemStatus.forbidden,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  OrganizationEngagementProfileNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: governedReadProblemStatus.notFound,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === 409
    ? OrganizationEngagementProfilePolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: governedReadProblemStatus.policyConflict,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : OrganizationEngagementProfilePolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: governedReadProblemStatus.policyDenied,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  OrganizationEngagementProfileInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: governedReadProblemStatus.internal,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof OrganizationEngagementProfileAuthenticationProblemSchema.Type
  | typeof OrganizationEngagementProfileForbiddenProblemSchema.Type
  | typeof OrganizationEngagementProfileInternalProblemSchema.Type
  | typeof OrganizationEngagementProfileInvalidProblemSchema.Type
  | typeof OrganizationEngagementProfileNotFoundProblemSchema.Type
  | typeof OrganizationEngagementProfilePolicyConflictProblemSchema.Type
  | typeof OrganizationEngagementProfilePolicyProblemSchema.Type
  | typeof OrganizationEngagementProfileUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(OrganizationEngagementProfileAuthenticationProblemSchema),
};

export const organizationEngagementProfileReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'organizationEngagementProfile',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'organizationEngagementProfileReadApiLive.execute',
        registration: organizationEngagementProfileRead,
        problems,
      }),
    ),
);
