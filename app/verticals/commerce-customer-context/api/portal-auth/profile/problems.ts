import {
  CUSTOMER_PROFILE_STATUS,
  ProfileAuthenticationProblemSchema,
  ProfileConflictProblemSchema,
  ProfileForbiddenProblemSchema,
  ProfileInvalidProblemSchema,
  ProfileUnavailableProblemSchema,
} from '../../../shared/portal-auth/profile-api.ts';

export const profileInvalid = () =>
  ProfileInvalidProblemSchema.make({
    code: 'invalid_request',
    detail: 'The profile request is invalid.',
    status: CUSTOMER_PROFILE_STATUS.invalid,
    title: 'Invalid profile request',
    type: 'https://ontos.dev/problems/customer-profile-invalid',
  });
export const profileAuthentication = () =>
  ProfileAuthenticationProblemSchema.make({
    code: 'authentication_failed',
    detail: 'A verified Commerce portal session is required.',
    status: CUSTOMER_PROFILE_STATUS.authentication,
    title: 'Customer authentication required',
    type: 'https://ontos.dev/problems/customer-profile-authentication',
  });
export const profileForbidden = () =>
  ProfileForbiddenProblemSchema.make({
    code: 'profile_forbidden',
    detail: 'This caller cannot perform the requested customer self-service operation.',
    status: CUSTOMER_PROFILE_STATUS.forbidden,
    title: 'Customer profile forbidden',
    type: 'https://ontos.dev/problems/customer-profile-forbidden',
  });
export const profileConflict = () =>
  ProfileConflictProblemSchema.make({
    code: 'profile_conflict',
    detail: 'Profile data changed. Read the current profile before submitting a new change.',
    status: CUSTOMER_PROFILE_STATUS.conflict,
    title: 'Customer profile conflict',
    type: 'https://ontos.dev/problems/customer-profile-conflict',
  });
export const profileUnavailable = () =>
  ProfileUnavailableProblemSchema.make({
    code: 'profile_unavailable',
    detail:
      'The customer profile operation could not be confirmed. Read the current profile before submitting a new change.',
    retryable: true,
    status: CUSTOMER_PROFILE_STATUS.unavailable,
    title: 'Customer profile unavailable',
    type: 'https://ontos.dev/problems/customer-profile-unavailable',
  });
