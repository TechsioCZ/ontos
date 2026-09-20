import { Context } from 'effect';

import type { Effect, Option, Redacted } from 'effect';

import type { CommercePortalAuthAuditEvent } from '../../../../src/portal-auth/audit/audit-contracts.ts';
import type {
  CommercePortalAuthEmailVerificationTokenRegistration,
  CommercePortalAuthRecoveryReconciliationConflictClass,
} from './contracts.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryUnavailable } from './unavailable.ts';

/** A non-destructive read of one ledger's recorded issuance-time binding. */
export interface CommercePortalAuthRecoveryLedgerBinding {
  readonly email: string;
  readonly providerSubjectId: string;
  /** The stored digest of the token this binding was read by; the audit trail's correlation key. */
  readonly tokenDigest: string;
}

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
   * provider is asked to spend the token. The claim is what makes a lost provider answer
   * recoverable: Better Auth consumes its own token row atomically inside `resetPassword`, so a
   * timeout after it committed leaves this realm unable to tell a never-started reset from a
   * completed one — and a `pending` row would let the retry be answered as a confident rejection.
   */
  readonly dispatchPasswordResetLedger: (input: {
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<void, CommercePortalAuthRecoveryUnavailable>;
  /** Read-only: the provider subject that currently owns the identifier, if one does. */
  readonly findAccountSubjectForEmail: (input: {
    readonly email: string;
  }) => Effect.Effect<Option.Option<string>, CommercePortalAuthRecoveryUnavailable>;
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
