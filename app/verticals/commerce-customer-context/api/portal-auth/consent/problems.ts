import {
  ConsentAuthorityAuthenticationProblemSchema,
  ConsentAuthorityForbiddenProblemSchema,
  ConsentAuthorityInvalidProblemSchema,
  ConsentAuthorityUnavailableProblemSchema,
} from '@app/consent-authority-contracts/api';
import { CUSTOMER_CONSENT_STATUS, ConsentConflictProblemSchema } from '../../../shared/portal-auth/consent-api.ts';

export const consentInvalid = () =>
  ConsentAuthorityInvalidProblemSchema.make({
    code: 'invalid_request',
    detail: 'The consent request is invalid.',
    status: CUSTOMER_CONSENT_STATUS.invalid,
    title: 'Invalid consent request',
    type: 'https://ontos.dev/problems/customer-consent-invalid',
  });
export const consentAuthentication = () =>
  ConsentAuthorityAuthenticationProblemSchema.make({
    code: 'authentication_failed',
    detail: 'A current verified Commerce portal session is required.',
    status: CUSTOMER_CONSENT_STATUS.authentication,
    title: 'Customer authentication required',
    type: 'https://ontos.dev/problems/customer-consent-authentication',
  });
export const consentForbidden = () =>
  ConsentAuthorityForbiddenProblemSchema.make({
    code: 'consent_forbidden',
    detail: 'This caller or session cannot authorize the exact consent scope.',
    status: CUSTOMER_CONSENT_STATUS.forbidden,
    title: 'Customer consent forbidden',
    type: 'https://ontos.dev/problems/customer-consent-forbidden',
  });
export const consentUnavailable = () =>
  ConsentAuthorityUnavailableProblemSchema.make({
    code: 'consent_unavailable',
    detail: 'Consent could not be confirmed. Read the current owner state before retrying.',
    retryable: true,
    status: CUSTOMER_CONSENT_STATUS.unavailable,
    title: 'Customer consent unavailable',
    type: 'https://ontos.dev/problems/customer-consent-unavailable',
  });
export const consentConflict = () =>
  ConsentConflictProblemSchema.make({
    code: 'consent_conflict',
    detail: 'The notice, purpose, session or request changed. Read the current notice before submitting.',
    status: CUSTOMER_CONSENT_STATUS.conflict,
    title: 'Customer consent conflict',
    type: 'https://ontos.dev/problems/customer-consent-conflict',
  });
