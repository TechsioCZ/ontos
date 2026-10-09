import { Schema } from 'effect';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  CommerceSessionReferenceSchema,
} from '../../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';

/**
 * The session surface is deliberately smaller than Better Auth's response model. In particular,
 * `token` is provider state and is never part of a Commerce session reference or evidence object.
 */
export const COMMERCE_PORTAL_AUTH_SESSION_POLICY_VERSION = COMMERCE_PORTAL_AUTH_POLICY.policyVersion;
export const COMMERCE_PORTAL_AUTH_SESSION_ABSOLUTE_LIFETIME_SECONDS =
  COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds;
export const COMMERCE_PORTAL_AUTH_SESSION_INACTIVITY_LIFETIME_SECONDS =
  COMMERCE_PORTAL_AUTH_POLICY.session.inactivityLifetimeSeconds;
export const COMMERCE_PORTAL_AUTH_SESSION_MAX_ACTIVE_SESSIONS =
  COMMERCE_PORTAL_AUTH_POLICY.session.concurrentDevice.maxActiveSessions;

export const COMMERCE_PORTAL_AUTH_SESSION_PUBLIC_ROUTE_ALLOWLIST = Object.freeze([
  '/get-session',
  '/refresh',
  '/sign-in/email',
  '/sign-out',
] as const);

/** The second-factor methods Better Auth offers when sign-in stops short of a session. */
export const CommercePortalAuthSessionMfaMethodSchema = Schema.Literals(['otp', 'totp']);
type CommercePortalAuthSessionMfaMethod = typeof CommercePortalAuthSessionMfaMethodSchema.Type;

const EmailSchema = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(3), Schema.isMaxLength(320));
const PasswordSchema = Schema.Redacted(
  Schema.String.check(
    Schema.isMinLength(COMMERCE_PORTAL_AUTH_POLICY.password.minLength),
    Schema.isMaxLength(COMMERCE_PORTAL_AUTH_POLICY.password.maxLength),
  ),
);
/** The single branded declaration of a Commerce provider subject identifier. */
export const CommercePortalAuthProviderSubjectIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
).pipe(Schema.brand('CommercePortalAuthProviderSubjectId'));
type CommercePortalAuthProviderSubjectId = typeof CommercePortalAuthProviderSubjectIdSchema.Type;
const UserIdSchema = CommercePortalAuthProviderSubjectIdSchema;
const SessionReasonSchema = Schema.Literals([
  'credential-change',
  'privilege-boundary',
  'recovery',
  'sign-in',
  'step-up',
]);

export const CommercePortalAuthSignInInputSchema = Schema.Struct({
  // Better Auth would redirect to a caller-chosen `callbackURL`; the portal refuses the key outright.
  callbackURL: Schema.optionalKey(Schema.Never),
  email: EmailSchema,
  password: PasswordSchema,
  rememberMe: Schema.optionalKey(Schema.Boolean),
});
export type CommercePortalAuthSignInInput = typeof CommercePortalAuthSignInInputSchema.Type;

export const CommercePortalAuthSessionReferenceInputSchema = Schema.Struct({
  expectedProviderSubjectId: Schema.optionalKey(UserIdSchema),
  sessionRef: CommerceSessionReferenceSchema,
});
export type CommercePortalAuthSessionReferenceInput = typeof CommercePortalAuthSessionReferenceInputSchema.Type;

export const CommercePortalAuthSessionRotationInputSchema = Schema.Struct({
  expectedProviderSubjectId: Schema.optionalKey(UserIdSchema),
  reason: SessionReasonSchema,
  sessionRef: CommerceSessionReferenceSchema,
});
export type CommercePortalAuthSessionRotationInput = typeof CommercePortalAuthSessionRotationInputSchema.Type;
type CommercePortalAuthSessionRotationReason = typeof SessionReasonSchema.Type;

export const CommercePortalAuthAccountSubjectInputSchema = Schema.Struct({
  providerSubjectId: UserIdSchema,
});

export interface CommercePortalAuthSessionRecord {
  /**
   * The session's last primary or step-up authentication. Better Auth creates the row at sign-in
   * and does not know this column, so a row it wrote answers `null` — and `createdAt` is that
   * session's authentication time. Identifier rotation preserves `createdAt` so the absolute
   * lifetime survives, which is exactly why "recently authenticated" needs its own column.
   */
  readonly authenticatedAt: Date | null;
  readonly banExpiresAt: Date | null;
  readonly banned: boolean;
  readonly createdAt: Date;
  readonly emailVerified: boolean;
  readonly expiresAt: Date;
  /** Better Auth's session.id; callers must wrap it in a namespaced safe reference. */
  readonly id: string;
  /** Better Auth's user.id; this is the stable Commerce account subject. */
  readonly providerSubjectId: string;
  /** Provider-only lookup material. Never copy this to an outcome, event, or evidence object. */
  readonly token?: string;
  readonly updatedAt: Date;
}

export interface CommercePortalAuthSessionSnapshot {
  readonly authenticatedAt: Date;
  readonly authenticationNamespaceId: typeof COMMERCE_AUTHENTICATION_NAMESPACE_ID;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly policyVersion: string;
  readonly providerSubjectId: CommercePortalAuthProviderSubjectId;
  readonly sessionRef: typeof CommerceSessionReferenceSchema.Type;
  readonly subjectType: 'user';
  readonly updatedAt: Date;
}

export interface CommercePortalAuthSessionEvidence extends CommercePortalAuthSessionSnapshot {
  readonly assurance: 'password' | 'reauthenticated' | 'step-up';
  readonly observedAt: Date;
}

export const CommercePortalAuthSessionEvidenceSchema = Schema.Struct({
  assurance: Schema.Literals(['password', 'reauthenticated', 'step-up']),
  authenticatedAt: Schema.Date,
  authenticationNamespaceId: Schema.Literal(COMMERCE_AUTHENTICATION_NAMESPACE_ID),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  observedAt: Schema.Date,
  policyVersion: Schema.String,
  providerSubjectId: UserIdSchema,
  sessionRef: CommerceSessionReferenceSchema,
  subjectType: Schema.Literal('user'),
  updatedAt: Schema.Date,
});

export type CommercePortalAuthSessionOutcome =
  | {
      readonly outcome: 'SESSION_CREATED';
      readonly session: CommercePortalAuthSessionSnapshot;
    }
  | {
      readonly identifierRotated: false;
      readonly outcome: 'SESSION_REFRESHED';
      readonly session: CommercePortalAuthSessionSnapshot;
    }
  | {
      readonly existed: boolean;
      readonly outcome: 'SESSION_REVOKED';
      readonly sessionRef: typeof CommerceSessionReferenceSchema.Type;
    }
  | {
      readonly outcome: 'AUTHENTICATION_FAILED';
    }
  | {
      readonly outcome: 'ACCOUNT_DISABLED';
      readonly providerSubjectId: string;
    }
  | {
      readonly expiredAt: Date;
      readonly outcome: 'SESSION_EXPIRED';
      readonly sessionRef: typeof CommerceSessionReferenceSchema.Type;
    }
  | {
      readonly outcome: 'VERIFICATION_REQUIRED';
    }
  | {
      readonly outcome: 'RATE_LIMITED';
    }
  /**
   * The account already holds `COMMERCE_PORTAL_AUTH_SESSION_MAX_ACTIVE_SESSIONS` live sessions and
   * the overflow policy is `reject-new`. This is a distinct outcome from `RATE_LIMITED` because its
   * remedy is distinct: ending one of the account's other sessions clears it and waiting never does.
   */
  | {
      readonly outcome: 'SESSION_LIMIT_REACHED';
    }
  | {
      readonly outcome: 'SESSION_IDENTIFIER_ROTATED';
      readonly previousSessionRef: typeof CommerceSessionReferenceSchema.Type;
      readonly reason: CommercePortalAuthSessionRotationReason;
      readonly session: CommercePortalAuthSessionSnapshot;
    };

/**
 * Internal representation passed from the provider bridge after a successful Better Auth call.
 * The provider cookies travel with it so the transport can forward them without a second call.
 */
interface CommercePortalAuthProviderSignInSuccess {
  readonly setCookieHeaders: readonly string[];
  readonly token: string;
}

/** Sign-in stopped at the second factor. Better Auth already issued its challenge cookie. */
interface CommercePortalAuthProviderSignInPendingMfa {
  readonly methods: readonly CommercePortalAuthSessionMfaMethod[];
  readonly outcome: 'MFA_REQUIRED';
  readonly setCookieHeaders: readonly string[];
}

export type CommercePortalAuthProviderSignInRejection =
  | { readonly outcome: 'AUTHENTICATION_FAILED' }
  | { readonly outcome: 'RATE_LIMITED' }
  | { readonly outcome: 'SESSION_LIMIT_REACHED' }
  | { readonly outcome: 'VERIFICATION_REQUIRED' };

/** The admission outcome the sign-in transport publishes, including the pending-MFA variant. */
export type CommercePortalAuthSessionSignInOutcome =
  | CommercePortalAuthSessionOutcome
  | Omit<CommercePortalAuthProviderSignInPendingMfa, 'setCookieHeaders'>;

/**
 * Owner-private sign-in result. The cookie strings are provider transport state: they are handed
 * to the response hook and never enter an outcome, event, evidence object or canonical data.
 */
export interface CommercePortalAuthSessionSignInResult {
  readonly outcome: CommercePortalAuthSessionSignInOutcome;
  readonly setCookieHeaders: readonly string[];
}

/**
 * Owner-private result used to hand a rotated provider token to the cookie signer. This value is
 * never part of `CommercePortalAuthSessionOutcome`, HTTP JSON, Core evidence or canonical data.
 */
export interface CommercePortalAuthSessionCookieHandoff {
  readonly previousSessionRef: typeof CommerceSessionReferenceSchema.Type;
  readonly providerToken: string;
  readonly reason: CommercePortalAuthSessionRotationReason;
  readonly session: CommercePortalAuthSessionSnapshot;
}

export type CommercePortalAuthProviderSignInResult =
  | CommercePortalAuthProviderSignInSuccess
  | CommercePortalAuthProviderSignInPendingMfa
  | CommercePortalAuthProviderSignInRejection;
