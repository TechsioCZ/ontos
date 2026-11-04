import {
  PasswordChangeAuthenticationProblemSchema,
  PasswordChangeCurrentInvalidProblemSchema,
  PasswordChangeForbiddenProblemSchema,
  PasswordChangeInvalidProblemSchema,
  PasswordChangeRateLimitedProblemSchema,
  PasswordChangeUnavailableProblemSchema,
} from '../../../shared/portal-auth/password-change-api.ts';

const PASSWORD_CHANGE_TYPE = 'https://ontos.dev/problems/customer-password-change-';

export const passwordChangeInvalid = () =>
  PasswordChangeInvalidProblemSchema.make({
    code: 'invalid_request',
    detail: 'The password change request is invalid.',
    status: 400,
    title: 'Invalid password change request',
    type: `${PASSWORD_CHANGE_TYPE}invalid`,
  });
export const passwordChangeCurrentInvalid = () =>
  PasswordChangeCurrentInvalidProblemSchema.make({
    code: 'current_password_invalid',
    detail: 'The current password is not correct.',
    status: 400,
    title: 'Current password is not correct',
    type: `${PASSWORD_CHANGE_TYPE}current-invalid`,
  });
export const passwordChangeAuthentication = () =>
  PasswordChangeAuthenticationProblemSchema.make({
    code: 'authentication_failed',
    detail: 'A current verified Commerce portal session is required.',
    status: 401,
    title: 'Customer authentication required',
    type: `${PASSWORD_CHANGE_TYPE}authentication`,
  });
export const passwordChangeForbidden = () =>
  PasswordChangeForbiddenProblemSchema.make({
    code: 'password_change_forbidden',
    detail: 'This caller or session cannot change the password.',
    status: 403,
    title: 'Password change forbidden',
    type: `${PASSWORD_CHANGE_TYPE}forbidden`,
  });
export const passwordChangeRateLimited = () =>
  PasswordChangeRateLimitedProblemSchema.make({
    code: 'rate_limited',
    detail: 'Too many password change attempts. Try again later.',
    status: 429,
    title: 'Password change rate limited',
    type: `${PASSWORD_CHANGE_TYPE}rate-limited`,
  });
export const passwordChangeUnavailable = () =>
  PasswordChangeUnavailableProblemSchema.make({
    code: 'password_change_unavailable',
    detail: 'The password could not be changed. Try again later.',
    retryable: true,
    status: 503,
    title: 'Password change unavailable',
    type: `${PASSWORD_CHANGE_TYPE}unavailable`,
  });
