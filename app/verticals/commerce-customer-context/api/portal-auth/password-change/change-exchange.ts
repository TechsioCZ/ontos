import { Context } from 'effect';
import type { Redacted } from 'effect';

/**
 * The portal route's own request, as the password change Action's owner routine needs it after the Action committed:
 * the two passwords (redacted, so no log, error or inspection prints them), the request's own headers that Better Auth
 * verifies the live session from, and the admitted session's reference for the portal audit. It is provided by the
 * route around its one Action invocation. None of it is ever part of the Action's payload, so none of it reaches the
 * request hash, the invocation row, Core's evidence or an idempotency record.
 */
export class CustomerOwnPasswordChangeExchange extends Context.Service<
  CustomerOwnPasswordChangeExchange,
  {
    readonly currentPassword: Redacted.Redacted;
    readonly newPassword: Redacted.Redacted;
    readonly requestHeaders: Headers;
    readonly sessionRef: string;
  }
>()(
  '@app/commerce-customer-context/api/portal-auth/password-change/change-exchange/CustomerOwnPasswordChangeExchange',
) {}
