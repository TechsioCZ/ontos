import { describe, it } from 'effect-rstest';
import { Effect } from 'effect';

/**
 * #1406 D.8 and AC-06/AC-09: BLOCKED POSITIVE END-TO-END of each flow against the REAL Privacy owner.
 *
 * Before the address of a Portal Auth account is verified, a supported Privacy owner path must bind the subject, the exact purpose
 * and version, the operation, the Tenant and the Legal Entity. The Privacy owner contract of this repository cannot represent
 * that binding today:
 *
 * 1. `IntendedProcessingScopeSchema` (`verticals/privacy/shared/domain/privacy-processing-eligibility.ts`) needs an existing
 *    `subjectRef`; there is no Privacy operation that creates or binds a Privacy Subject for an UNVERIFIED Portal Auth account, and
 *    inventing one by e-mail match, a presumed Party or an anonymous browser context is forbidden;
 * 2. `SourceProcessingEligibilityRequestSchema` (`shared/apis/source-processing-eligibility.ts`) admits `communications.core`
 *    only for a qualified source record (`PrivacySourceRecordIdentity`) or a Party target, and Privacy has no enrolled source issuer
 *    for Portal Auth issuance records, so a Portal Auth issuance locator is not a supported context;
 * 3. no Privacy purpose, purpose version, controller, operation, processing scope or data category is defined for the three activated
 *    Auth purposes (`commerce.customer-context.portal-auth.{verify-email,reset-password,otp}`), and the source context of Privacy
 *    requires a Legal Entity while a Portal Auth realm is Tenant-wide.
 *
 * Until the Privacy owner supplies that contract, the supported behaviour is the NEGATIVE path, which the three flow suites prove:
 * Auth's only production binding fails closed, the message stops as not-sent with Privacy never asked about a guess, and no
 * Subject or Party is invented. The positive paths in those suites run against a labelled Privacy DOUBLE and prove how
 * Communications reads an answer, never that Privacy gives it.
 */
describe('BLOCKED: positive end-to-end against the real Privacy owner (#1406 D.8)', () => {
  it.live.skip(
    'verify-email: a Portal Auth issuance is bound by Privacy before the address is verified, then sent',
    () => Effect.void,
  );
  it.live.skip(
    'password reset: a Portal Auth issuance is bound by Privacy before the address is verified, then sent',
    () => Effect.void,
  );
  it.live.skip(
    'one-time code: a Portal Auth issuance is bound by Privacy before the address is verified, then sent',
    () => Effect.void,
  );
});
