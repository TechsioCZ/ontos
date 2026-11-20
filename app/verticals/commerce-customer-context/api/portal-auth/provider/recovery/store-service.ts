import { Context, Schema } from 'effect';

import type { Effect, Option, Redacted } from 'effect';

import type { CommercePortalAuthAuditEvent } from '../../../../src/portal-auth/audit/audit-contracts.ts';
import type {
  CommercePortalAuthEmailVerificationTokenRegistration,
  CommercePortalAuthRecoveryReconciliationConflictClass,
} from './contracts.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryUnavailable } from './unavailable.ts';

/**
 * What one attempt to claim a password-reset row for a dispatch actually did: `claimed` (this
 * caller now owns the dispatch), `already-dispatched` (somebody else holds it, outcome unknown), or
 * `not-pending` (no row to claim; the provider stays authoritative).
 */
const CommercePortalAuthRecoveryResetClaimSchema = Schema.Literals(['already-dispatched', 'claimed', 'not-pending']);
export type CommercePortalAuthRecoveryResetClaim = typeof CommercePortalAuthRecoveryResetClaimSchema.Type;

/** A non-destructive read of one ledger's recorded issuance-time binding. */
export interface CommercePortalAuthRecoveryLedgerBinding {
  readonly email: string;
  /** The expiry Auth's own ledger stored for the token (the instant the issuance stops being usable); set by the real store. */
  readonly expiresAt?: Date;
  readonly providerSubjectId: string;
  /** The stored digest of the token this binding was read by; the audit trail's correlation key. */
  readonly tokenDigest: string;
}

/** What Better Auth's two-factor plugin itself stored for ONE issued one-time code: the challenge it lives under and its real state. */
export interface CommercePortalAuthOtpChallenge {
  /** Failed presentations Better Auth counted against the code; the code is exhausted at the plugin's own limit. */
  readonly attempts: number;
  /** The verification row identifier the code is stored under (Better Auth's hashed form); opaque, never logged. */
  readonly challenge: Redacted.Redacted;
  readonly expiresAt: Date;
}

/**
 * Which two-factor challenge a freshly issued one-time code belongs to: the key Better Auth's two-factor plugin stores the code
 * under. Never the code, never an address; a sign-in challenge is named by its signed challenge cookie (the pending row it
 * names holds the user), a challenge of a signed-in session by that session.
 */
export type CommercePortalAuthOtpChallengeKey =
  | { readonly cookie: Redacted.Redacted; readonly kind: 'SIGN_IN' }
  | { readonly kind: 'SESSION'; readonly sessionId: string };

/**
 * What Auth's own stored state says about ONE issuance it issued, read from the rows that really exist, never guessed:
 * - CURRENT: the issuance is still offered, for the same subject (and, for a one-time code, the same code);
 * - EXPIRED: its row is still there but past its expiry (or terminal as expired);
 * - CONSUMED: the issuance was spent (a completed reset or verification, a verified one-time code, or one exhausted at the
 *   plugin's failed-attempt limit);
 * - SUPERSEDED: a newer issuance replaced it (the token is re-registered for another binding, or a newer code replaced the code);
 * - NOT_LOCATED: Auth's rows no longer say anything about it, so it can only be reported as not resumable, never as revoked.
 */
const CommercePortalAuthIssuanceLedgerStateSchema = Schema.Literals([
  'CONSUMED',
  'CURRENT',
  'EXPIRED',
  'NOT_LOCATED',
  'SUPERSEDED',
]);
export type CommercePortalAuthIssuanceLedgerState = typeof CommercePortalAuthIssuanceLedgerStateSchema.Type;

export interface CommercePortalAuthRecoveryStore {
  /** Read-only: true when the named provider subject still names an active account. */
  readonly accountExists: (input: {
    readonly providerSubjectId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Marks an email-verification ledger token terminal and flips `user.emailVerified` in the same
   * transaction that writes the verification's completion audit row. Consuming the token *is* what
   * marks the address verified, so a flip that commits with no completion row is a verified address
   * the audit outage hides, and a completion row over a token that was never actually spent is
   * evidence for a verification that never happened. A refused write leaves the token, and the
   * account, exactly as they were: `Option.none` means the token was invalid, expired, already
   * consumed, or no longer names the current subject/email/unverified state, and neither the ledger
   * nor the account changed.
   */
  readonly consumeEmailVerificationWithAudit: (input: {
    readonly audit: CommercePortalAuthAuditEvent;
    readonly now: Date;
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<Option.Option<string>, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Marks a password-reset token's ledger row terminal after the provider accepted it, and writes
   * the reset's completion audit row in the same transaction. A spent token must never be
   * reconciled against the account's current state again: it changed nothing the second time, so
   * any drift since the reset is not a conflict it caused.
   *
   * The two writes are one transaction because either alone is a broken outcome: a consumed row
   * with no completion evidence is a reset nothing records, and a completion row over a still
   * `pending`/`dispatched` row is a spent token the ledger still offers. A refused write leaves the
   * row claimed, which is what lets the caller answer the reconciliation outcome instead.
   */
  readonly consumePasswordResetLedgerWithAudit: (input: {
    readonly audit: CommercePortalAuthAuditEvent;
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<void, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Spends one unit of the durable budget the key names, answering `false` once the rule's window
   * is exhausted. The counter lives in the deployment's own store, so concurrent replicas spend one
   * budget; a store that cannot answer fails instead of granting an uncounted request.
   */
  readonly consumeRateLimitBudget: (input: {
    readonly key: string;
    readonly rule: CommercePortalAuthRecoveryRateLimitRule;
  }) => Effect.Effect<boolean, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Claims a `pending` ledger row for one dispatch, in its own transaction, immediately before the
   * provider is asked to spend the token — the claim is what makes a lost provider answer
   * recoverable. The returned `CommercePortalAuthRecoveryResetClaim` tells the caller which of the
   * three outcomes happened, since two submissions of one link race on the same row and the loser
   * must not treat a zero-row update as success.
   */
  readonly dispatchPasswordResetLedger: (input: {
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<CommercePortalAuthRecoveryResetClaim, CommercePortalAuthRecoveryUnavailable>;
  /** Read-only: the provider subject that currently owns the identifier, if one does. */
  readonly findAccountSubjectForEmail: (input: {
    readonly email: string;
  }) => Effect.Effect<Option.Option<string>, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Read-only: the stored challenge of a one-time code that was just issued, found by the two-factor challenge KEY it is stored
   * under (never by the code: the code is not a query parameter, so no failure of the statement can echo it) and bound to the
   * user it was issued for. The code is compared in-process, in constant time. None when that challenge holds no live code,
   * another code, or belongs to another user.
   */
  readonly locateOtpChallenge: (input: {
    readonly challengeKey: CommercePortalAuthOtpChallengeKey;
    readonly otp: Redacted.Redacted;
    readonly userId: string;
  }) => Effect.Effect<Option.Option<CommercePortalAuthOtpChallenge>, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Non-destructive: reads the binding of a password-reset row that is still claimed for a dispatch
   * whose outcome never came back. Unlike `peekPasswordResetLedger` this deliberately ignores
   * expiry — the token can no longer be spent, but whether the earlier dispatch changed the
   * password is still unknown, and that question outlives the token.
   */
  readonly peekDispatchedPasswordResetLedger: (input: {
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<Option.Option<CommercePortalAuthRecoveryLedgerBinding>, CommercePortalAuthRecoveryUnavailable>;
  /** Non-destructive: reads the email-verification ledger's issuance-time binding for a token. */
  readonly peekEmailVerificationLedger: (input: {
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<Option.Option<CommercePortalAuthRecoveryLedgerBinding>, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Non-destructive: reads the password-reset ledger's issuance-time binding for a token, for the
   * one purpose that must only see a token nobody has spent yet — fresh reconciliation. A
   * `dispatched` row is excluded exactly as a `consumed` one is: the provider was already asked to
   * spend that token, so drift since then is not a conflict this submission caused.
   */
  readonly peekPasswordResetLedger: (input: {
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<Option.Option<CommercePortalAuthRecoveryLedgerBinding>, CommercePortalAuthRecoveryUnavailable>;
  /** Read-only: the real state of ONE issued verification link, by the ledger row it was registered under. */
  readonly readEmailVerificationIssuanceState: (input: {
    readonly providerSubjectId: string;
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<CommercePortalAuthIssuanceLedgerState, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Read-only: the real state of ONE issued one-time code under its stored challenge. No row means Better Auth spent the
   * challenge (a verification consumed it); a newer code under the same challenge supersedes the held one; a row at the plugin's
   * own failed-attempt limit is spent.
   */
  readonly readOtpIssuanceState: (input: {
    readonly challenge: Redacted.Redacted;
    readonly maxFailedAttempts: number;
    readonly otp: Redacted.Redacted;
  }) => Effect.Effect<CommercePortalAuthIssuanceLedgerState, CommercePortalAuthRecoveryUnavailable>;
  /** Read-only: the real state of ONE issued reset link, by the reset ledger row it was registered under. */
  readonly readPasswordResetIssuanceState: (input: {
    readonly providerSubjectId: string;
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<CommercePortalAuthIssuanceLedgerState, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Records one detected conflict. Writing this row is the only effect detection ever has: it
   * never updates `user`, `session` or `account`, and a duplicate detection of the same conflict
   * dedupes onto the same row rather than growing without bound.
   */
  readonly recordRecoveryReconciliation: (input: {
    readonly conflictClass: CommercePortalAuthRecoveryReconciliationConflictClass;
    readonly currentProviderSubjectId: Option.Option<string>;
    readonly email: string;
    readonly operation: string;
    readonly providerSubjectId: string;
  }) => Effect.Effect<void, CommercePortalAuthRecoveryUnavailable>;
  readonly registerEmailVerificationToken: (
    input: CommercePortalAuthEmailVerificationTokenRegistration & {
      readonly expiresAt: Date;
    },
  ) => Effect.Effect<boolean, CommercePortalAuthRecoveryUnavailable>;
  /** Records the issuance-time email/subject binding for a password-reset token, before delivery. */
  readonly registerPasswordResetToken: (input: {
    readonly email: string;
    readonly expiresAt: Date;
    readonly providerSubjectId: string;
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<boolean, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Gives a dispatch claim back when the provider's rejection proves the token was never spent, so
   * the customer's corrected retry finds a pending row instead of a stale claim. Guarded on
   * `dispatched`, so it can never revive a `consumed` or `expired` row.
   */
  readonly releasePasswordResetLedger: (input: {
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<void, CommercePortalAuthRecoveryUnavailable>;
  readonly reserveEmailVerificationSubject: (input: {
    readonly email: string;
    readonly providerSubjectId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthRecoveryUnavailable>;
}

export class CommercePortalAuthRecoveryStoreService extends Context.Service<
  CommercePortalAuthRecoveryStoreService,
  CommercePortalAuthRecoveryStore
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/recovery/store-service/CommercePortalAuthRecoveryStoreService',
) {}
