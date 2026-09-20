import { Context } from 'effect';

import type { Effect, Option, Redacted } from 'effect';

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
  readonly consumeEmailVerification: (input: {
    readonly now: Date;
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<Option.Option<string>, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Marks a password-reset token's ledger row terminal after the provider accepted it. A spent
   * token must never be reconciled against the account's current state again: it changed nothing
   * the second time, so any drift since the reset is not a conflict it caused.
   */
  readonly consumePasswordResetLedger: (input: {
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
  /** Read-only: the provider subject that currently owns the identifier, if one does. */
  readonly findAccountSubjectForEmail: (input: {
    readonly email: string;
  }) => Effect.Effect<Option.Option<string>, CommercePortalAuthRecoveryUnavailable>;
  /** Non-destructive: reads the email-verification ledger's issuance-time binding for a token. */
  readonly peekEmailVerificationLedger: (input: {
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<Option.Option<CommercePortalAuthRecoveryLedgerBinding>, CommercePortalAuthRecoveryUnavailable>;
  /** Non-destructive: reads the password-reset ledger's issuance-time binding for a token. */
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
