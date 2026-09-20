import { Context } from 'effect';
import type { Effect, Schema } from 'effect';

import type {
  CommercePortalAuthAccountSubjectInputSchema,
  CommercePortalAuthSessionCookieHandoff,
  CommercePortalAuthSessionEvidence,
  CommercePortalAuthSessionOutcome,
  CommercePortalAuthSessionReferenceInputSchema,
  CommercePortalAuthSessionRotationInputSchema,
  CommercePortalAuthSessionSignInResult,
  CommercePortalAuthSignInInputSchema,
} from './contracts.ts';
import type {
  CommercePortalAuthProviderUnavailable,
  CommercePortalAuthSessionEvidenceRejected,
  CommercePortalAuthSessionInvalidRequest,
  CommercePortalAuthSessionRefreshConflict,
  CommercePortalAuthSessionRotationRejected,
  CommercePortalAuthSessionUnavailable,
} from './errors.ts';

export interface CommercePortalAuthSessionLifecycleService {
  readonly disableAccount: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthAccountSubjectInputSchema>,
  ) => Effect.Effect<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'ACCOUNT_DISABLED' | 'AUTHENTICATION_FAILED' }>,
    CommercePortalAuthSessionFailure
  >;
  readonly evidenceForSession: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ) => Effect.Effect<CommercePortalAuthSessionEvidence, CommercePortalAuthSessionEvidenceFailure>;
  readonly refresh: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ) => Effect.Effect<CommercePortalAuthSessionOutcome, CommercePortalAuthSessionFailure>;
  readonly revoke: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ) => Effect.Effect<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'SESSION_REVOKED' }>,
    CommercePortalAuthSessionFailure
  >;
  readonly revokeAll: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthAccountSubjectInputSchema>,
  ) => Effect.Effect<number, CommercePortalAuthSessionFailure>;
  /**
   * The compensating deletion for a sign-in whose completion evidence was refused, and the only
   * caller this exists for. It writes no audit row on purpose: the row an audited revoke would
   * write goes to the very store that just refused, so its own transaction would roll the deletion
   * back and leave the live credential this call exists to take back. The sign-in intent row is
   * already persisted, so the interrupted attempt still has its evidence.
   */
  readonly revokeUnaudited: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ) => Effect.Effect<boolean, CommercePortalAuthSessionFailure>;
  /** Owner-private rotation result for the provider cookie signer. */
  readonly rotateIdentifierForCookie: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionRotationInputSchema>,
  ) => Effect.Effect<CommercePortalAuthSessionCookieHandoff, CommercePortalAuthSessionFailure>;
  /** The result carries the provider cookies for the transport response hook, never for a caller. */
  readonly signIn: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSignInInputSchema>,
  ) => Effect.Effect<CommercePortalAuthSessionSignInResult, CommercePortalAuthSessionFailure>;
  readonly signOut: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ) => Effect.Effect<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'SESSION_REVOKED' }>,
    CommercePortalAuthSessionFailure
  >;
}

export type CommercePortalAuthSessionFailure =
  | CommercePortalAuthSessionInvalidRequest
  | CommercePortalAuthSessionUnavailable
  | CommercePortalAuthSessionRefreshConflict
  | CommercePortalAuthSessionRotationRejected
  | CommercePortalAuthProviderUnavailable;

export type CommercePortalAuthSessionEvidenceFailure =
  | CommercePortalAuthSessionInvalidRequest
  | CommercePortalAuthSessionUnavailable
  | CommercePortalAuthSessionEvidenceRejected;

export class CommercePortalAuthSessionLifecycle extends Context.Service<
  CommercePortalAuthSessionLifecycle,
  CommercePortalAuthSessionLifecycleService
>()('@app/commerce-customer-context/api/portal-auth/session/lifecycle-service/CommercePortalAuthSessionLifecycle') {}
