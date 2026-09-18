import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { HttpApiMiddleware } from 'effect/unstable/httpapi';

import {
  CommercePortalAuthProviderSubjectIdSchema,
  CommercePortalAuthSessionMfaMethodSchema,
  CommercePortalAuthSignInInputSchema,
} from '../../api/portal-auth/session/contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID, CommerceSessionReferenceSchema } from '../portal-auth-contracts.ts';

/**
 * The declared endpoint paths mirror the owner route allowlist
 * (`COMMERCE_PORTAL_AUTH_SESSION_PUBLIC_ROUTE_ALLOWLIST`) under the internal base path: the
 * router, not a prefix match, is what rejects an undeclared path. Paths are internal; the BFF
 * runtime publishes them under `COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH`.
 */

/** Callers send no fields on the cookie-authenticated routes; an extra field is a rejected request. */
const CommercePortalAuthSessionEmptyPayloadSchema = Schema.Struct({}).annotate({
  parseOptions: { onExcessProperty: 'error' },
});

/**
 * The wire projection of `CommercePortalAuthSessionSnapshot`. Dates encode as ISO-8601 strings, so
 * the published body is identical to the one the hand-built transport produced.
 */
const CommercePortalAuthSessionSnapshotSchema = Schema.Struct({
  authenticatedAt: Schema.Date,
  authenticationNamespaceId: Schema.Literal(COMMERCE_AUTHENTICATION_NAMESPACE_ID),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  policyVersion: Schema.String,
  providerSubjectId: CommercePortalAuthProviderSubjectIdSchema,
  sessionRef: CommerceSessionReferenceSchema,
  subjectType: Schema.Literal('user'),
  updatedAt: Schema.Date,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommercePortalAuthSessionSnapshotWire = typeof CommercePortalAuthSessionSnapshotSchema.Type;

export const CommercePortalAuthSessionInvalidProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthSessionInvalidProblem',
  400,
  { code: Schema.Literal('invalid_request') },
);
export const CommercePortalAuthSessionAuthenticationProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthSessionAuthenticationProblem',
  401,
  { code: Schema.Literals(['authentication_failed', 'session_expired', 'session_revoked']) },
);
export const CommercePortalAuthSessionForbiddenProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthSessionForbiddenProblem',
  403,
  {
    code: Schema.Literals([
      'account_disabled',
      'origin_not_trusted',
      /** The concurrent-device cap: distinct from the 429 throttle because waiting never clears it. */
      'session_limit_reached',
      'verification_required',
    ]),
  },
);
export const CommercePortalAuthSessionRateLimitedProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthSessionRateLimitedProblem',
  429,
  {
    code: Schema.Literal('rate_limited'),
    retryAfterSeconds: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  },
);
export const CommercePortalAuthSessionUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CommercePortalAuthSessionUnavailableProblem',
  503,
  { code: Schema.Literal('authentication_unavailable') },
);

/** A rejected payload, path parameter or header answers with the group's own 400 problem body. */
export class CommercePortalAuthSessionSchemaErrorMiddleware extends HttpApiMiddleware.Service<CommercePortalAuthSessionSchemaErrorMiddleware>()(
  'commerce-customer-context/CommercePortalAuthSessionSchemaErrorMiddleware',
  { error: CommercePortalAuthSessionInvalidProblemSchema },
) {}

const signInErrors = [
  CommercePortalAuthSessionInvalidProblemSchema,
  CommercePortalAuthSessionAuthenticationProblemSchema,
  CommercePortalAuthSessionForbiddenProblemSchema,
  CommercePortalAuthSessionRateLimitedProblemSchema,
  CommercePortalAuthSessionUnavailableProblemSchema,
] as const;
const signOutErrors = [
  CommercePortalAuthSessionForbiddenProblemSchema,
  CommercePortalAuthSessionUnavailableProblemSchema,
] as const;
const refreshErrors = [
  CommercePortalAuthSessionAuthenticationProblemSchema,
  CommercePortalAuthSessionForbiddenProblemSchema,
  CommercePortalAuthSessionRateLimitedProblemSchema,
  CommercePortalAuthSessionUnavailableProblemSchema,
] as const;
const getSessionErrors = [
  CommercePortalAuthSessionAuthenticationProblemSchema,
  CommercePortalAuthSessionForbiddenProblemSchema,
  CommercePortalAuthSessionUnavailableProblemSchema,
] as const;

/**
 * The customer-facing session surface. `password` crosses the wire as its encoded string and is
 * re-decoded into `Schema.Redacted` by the owner contract inside the handler.
 *
 * The endpoint chain stays a `const`. The MicroVertical API boundary checker walks a root API's
 * operands through const bindings only, so a class declaration hides the composed endpoints from
 * it. The exported group is annotated with a named type alias so its type still has a name: `shared/api.ts`
 * merges roughly a hundred group types into one `HttpApi` and declaration emit serializes that
 * union verbatim, so an anonymous group type pushes the composed contract past the compiler's
 * serialization limit (TS7056).
 *
 * The same checker reads declared routes syntactically, so each path is written as a literal
 * rather than composed from `COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH` (`/api/portal-auth`) and the
 * owner's `COMMERCE_PORTAL_AUTH_SESSION_PUBLIC_ROUTE_ALLOWLIST`; the literals below are exactly
 * that base path followed by each allowlisted route.
 */
const commercePortalAuthSessionGroupDefinition = HttpApiGroup.make('portalAuthSession')
  .add(
    HttpApiEndpoint.post('signIn', '/api/portal-auth/sign-in/email', {
      error: signInErrors,
      payload: Schema.toEncoded(CommercePortalAuthSignInInputSchema),
      success: Schema.Union([
        Schema.Struct({
          outcome: Schema.Literal('SESSION_CREATED'),
          session: CommercePortalAuthSessionSnapshotSchema,
        }),
        Schema.Struct({
          methods: Schema.Array(CommercePortalAuthSessionMfaMethodSchema),
          outcome: Schema.Literal('MFA_REQUIRED'),
        }),
      ]),
    }),
  )
  .add(
    HttpApiEndpoint.post('signOut', '/api/portal-auth/sign-out', {
      error: signOutErrors,
      payload: CommercePortalAuthSessionEmptyPayloadSchema,
      success: Schema.Struct({ outcome: Schema.Literal('SESSION_REVOKED') }),
    }),
  )
  .add(
    HttpApiEndpoint.post('refresh', '/api/portal-auth/refresh', {
      error: refreshErrors,
      payload: CommercePortalAuthSessionEmptyPayloadSchema,
      success: Schema.Union([
        Schema.Struct({
          identifierRotated: Schema.Literal(false),
          outcome: Schema.Literal('SESSION_REFRESHED'),
          session: CommercePortalAuthSessionSnapshotSchema,
        }),
        Schema.Struct({ expiredAt: Schema.Date, outcome: Schema.Literal('SESSION_EXPIRED') }),
      ]),
    }),
  )
  .add(
    HttpApiEndpoint.get('getSession', '/api/portal-auth/get-session', {
      error: getSessionErrors,
      success: Schema.Union([
        Schema.Struct({ state: Schema.Literal('anonymous') }),
        Schema.Struct({
          session: CommercePortalAuthSessionSnapshotSchema,
          state: Schema.Literal('authenticated'),
        }),
      ]),
    }),
  )
  .middleware(CommercePortalAuthSessionSchemaErrorMiddleware);

export type CommercePortalAuthSessionGroupContract = HttpApiGroup.HttpApiGroup<
  'portalAuthSession',
  HttpApiGroup.Endpoints<typeof commercePortalAuthSessionGroupDefinition>
>;

const CommercePortalAuthSessionGroup: CommercePortalAuthSessionGroupContract = commercePortalAuthSessionGroupDefinition;

export const CommercePortalAuthSessionApi =
  HttpApi.make('CommercePortalAuthSessionApi').add(CommercePortalAuthSessionGroup);
