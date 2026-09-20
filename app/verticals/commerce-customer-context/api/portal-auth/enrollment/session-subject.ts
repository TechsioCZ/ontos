import { Effect, Option, Schema } from 'effect';

import { CommercePortalAccountSubjectSchema } from '../../../shared/enrollment-contracts.ts';
import type { CommercePortalAccountSubject } from '../../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../../shared/portal-auth-contracts.ts';
import { withCause } from '../../../src/enrollment/attempts/errors.ts';
import { commercePortalAuthMfaSessionReadApiFromBetterAuth } from '../provider/mfa/http.ts';
import type { CommercePortalAuthMfaSessionReadApi } from '../provider/mfa/http.ts';
import { encodeCommerceSessionReference } from '../provider/session-reference.ts';
import type { CommercePortalAuthService } from '../session/http.ts';
import type { CommercePortalAuthSessionLifecycle } from '../session/lifecycle-service.ts';

/**
 * Who the caller of an enrollment start already is.
 *
 * The Existing-account journey binds an account someone already holds to a Tenant it has never
 * belonged to, so the start must name that account's *authenticated* owner rather than accept an
 * address a request typed. This is that read, and it is deliberately the same two-step one the
 * sibling MFA gate makes: Better Auth resolves the request's own cookie to a session identity, and
 * the owner's session lifecycle decides whether that session is live evidence for that subject.
 * Neither half is trusted alone — the provider knows nothing about the owner's expiry, ban and
 * verification rules, and the owner's store cannot see which cookie this request carried.
 */

/** Why no authenticated subject could be read. The failing value is kept as a private `cause`. */
class CommercePortalAuthEnrollmentSessionUnreadable extends Schema.TaggedError<CommercePortalAuthEnrollmentSessionUnreadable>()(
  'CommercePortalAuthEnrollmentSessionUnreadable',
  { reason: Schema.String },
) {}

const unreadable = (reason: string, cause: unknown): CommercePortalAuthEnrollmentSessionUnreadable =>
  withCause(new CommercePortalAuthEnrollmentSessionUnreadable({ reason }), cause);

/** Exactly the lifecycle read this gate makes; nothing here may change session state. */
export type CommercePortalAuthEnrollmentSessionEvidence = Pick<
  CommercePortalAuthSessionLifecycle['Service'],
  'evidenceForSession'
>;

/**
 * The authenticated subject of one request, or `none`.
 *
 * Every failure collapses into `none`: no session, a session the owner refuses as expired, banned
 * or unverified, an unreachable provider and an unparseable envelope are all "this request carries
 * no proven owner", and the route answers each of them with the group's one unauthenticated
 * problem. A gate that distinguished them would answer a caller probing addresses with the reason,
 * so only a fixed diagnostic reason is logged and never an identifier.
 */
const commercePortalAuthEnrollmentSessionSubjectFromApi = (
  api: CommercePortalAuthMfaSessionReadApi,
  lifecycle: CommercePortalAuthEnrollmentSessionEvidence,
  headers: Headers,
): Effect.Effect<Option.Option<CommercePortalAccountSubject>> =>
  Effect.gen(function* readEnrollmentSessionSubject() {
    const current = yield* api
      .getSession({
        asResponse: false,
        headers,
        // The cookie cache is a signed copy of a session the owner may already have revoked, and a
        // refresh would renew a credential this read is only identifying.
        query: { disableCookieCache: true, disableRefresh: true },
        returnHeaders: true,
      })
      .pipe(Effect.mapError((cause) => unreadable('provider-session-unreadable', cause)));
    if (Option.isNone(current)) {
      return Option.none<CommercePortalAccountSubject>();
    }
    const sessionRef = yield* encodeCommerceSessionReference(current.value.session.id).pipe(
      Effect.mapError((cause) => unreadable('provider-session-reference-invalid', cause)),
    );
    const evidence = yield* lifecycle
      .evidenceForSession({ expectedProviderSubjectId: current.value.user.id, sessionRef })
      .pipe(Effect.mapError((cause) => unreadable('session-evidence-rejected', cause)));
    return Option.some(
      yield* Schema.decodeEffect(CommercePortalAccountSubjectSchema)({
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        providerSubjectId: evidence.providerSubjectId,
        subjectType: 'user',
      }).pipe(Effect.mapError((cause) => unreadable('session-subject-unrepresentable', cause))),
    );
  }).pipe(
    Effect.matchEffect({
      onFailure: (failure: CommercePortalAuthEnrollmentSessionUnreadable) =>
        Effect.annotateLogs(Effect.logWarning('The Commerce enrollment start read no authenticated portal session'), {
          reason: failure.reason,
        }).pipe(Effect.as(Option.none<CommercePortalAccountSubject>())),
      onSuccess: (subject: Option.Option<CommercePortalAccountSubject>) => Effect.succeed(subject),
    }),
  );

/**
 * The same read over the two tags the portal-auth groups already publish, so the enrollment group
 * adds no requirement of its own: the installed realm and the fail-closed realm a host that opted
 * out gets both satisfy them, and on the uninstalled realm every call refuses and the gate denies.
 *
 * The Better Auth edge is the vertical's one `getSession` driver — the sibling MFA gate's — rather
 * than a second Promise conversion of the same provider route.
 */
export const commercePortalAuthEnrollmentSessionSubject = (
  provider: CommercePortalAuthService['Service'],
  lifecycle: CommercePortalAuthEnrollmentSessionEvidence,
  headers: Headers,
): Effect.Effect<Option.Option<CommercePortalAccountSubject>> =>
  commercePortalAuthEnrollmentSessionSubjectFromApi(
    commercePortalAuthMfaSessionReadApiFromBetterAuth(provider.api),
    lifecycle,
    headers,
  );
