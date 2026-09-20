import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Redacted } from 'effect';

import type {
  CommercePortalAuthRecoveryReconciliationConflictClass,
  CommercePortalAuthRecoveryReconciliationRequired,
} from './contracts.ts';
import { CommercePortalAuthRecoveryStoreService } from './store-service.ts';
import type { CommercePortalAuthRecoveryUnavailable } from './unavailable.ts';

const RESET_OPERATION = 'reset-password';
const VERIFY_OPERATION = 'verify-email';

/** Which live operation is asking; the conflict class a mismatch is filed under depends on it. */
const CommercePortalAuthRecoveryReconciliationOperationSchema = Schema.Literals([RESET_OPERATION, VERIFY_OPERATION]);
export type CommercePortalAuthRecoveryReconciliationOperation =
  typeof CommercePortalAuthRecoveryReconciliationOperationSchema.Type;

/** Same-operation mismatch (subject still exists, just not the one the ledger names) files here. */
const conflictClassForMismatch = (
  operation: CommercePortalAuthRecoveryReconciliationOperation,
): CommercePortalAuthRecoveryReconciliationConflictClass =>
  operation === RESET_OPERATION ? 'IDENTIFIER_REBOUND' : 'VERIFICATION_LEDGER_SUBJECT_MISMATCH';

/**
 * Pure decision, no I/O: given what was true at issuance (the ledger's recorded subject for the
 * identifier) and what is true now (whether that subject still owns an active account, and which
 * subject the identifier currently belongs to, if any), names the conflict class a support operator
 * must reconcile — or `None` when the evidence is still consistent.
 *
 * Priority is deliberate: a subject that no longer names any account is always `TOKEN_SUBJECT_STALE`,
 * even when the identifier also now belongs to someone else — a deleted/recreated account is the
 * more specific fact, and collapsing it into a same-operation mismatch class would hide it.
 */
export const detectRecoveryReconciliationConflict = (input: {
  readonly currentAccountSubjectId: Option.Option<string>;
  readonly ledgerSubjectAccountExists: boolean;
  readonly ledgerSubjectId: string;
  readonly operation: CommercePortalAuthRecoveryReconciliationOperation;
}): Option.Option<CommercePortalAuthRecoveryReconciliationConflictClass> => {
  if (!input.ledgerSubjectAccountExists) {
    return Option.some('TOKEN_SUBJECT_STALE');
  }
  if (Option.isNone(input.currentAccountSubjectId) || input.currentAccountSubjectId.value !== input.ledgerSubjectId) {
    return Option.some(conflictClassForMismatch(input.operation));
  }
  return Option.none();
};

export interface CommercePortalAuthRecoveryReconciliationCheck {
  readonly operation: CommercePortalAuthRecoveryReconciliationOperation;
  readonly token: Redacted.Redacted;
}

export interface CommercePortalAuthRecoveryReconciliation {
  /**
   * Compares the named token's issuance-time ledger binding against the provider's current state
   * and, when they conflict, durably records the conflict for a support operator and returns the
   * terminal outcome. This never resolves a conflict and never restores access: recording the row
   * is its only effect, and the caller must treat a `Some` result as terminal for the request that
   * produced it — no token is granted, no password reset, no email marked verified.
   *
   * Returns `None` when there is nothing to reconcile: no ledger record for the token — the normal
   * flow's own token validation handles that case.
   */
  readonly detect: (
    input: CommercePortalAuthRecoveryReconciliationCheck,
  ) => Effect.Effect<
    Option.Option<CommercePortalAuthRecoveryReconciliationRequired>,
    CommercePortalAuthRecoveryUnavailable
  >;
  /**
   * Records that one dispatched reset ended with no knowable outcome — the provider never answered,
   * or answered after the completion evidence could no longer be written — and returns the terminal
   * outcome for the submission that discovered it.
   *
   * `None` means there is nothing indeterminate about this token: no row is claimed for a dispatch,
   * so the caller's own provider answer stands as it is. Like `detect`, recording the row is the
   * only effect this ever has: it resets no password, grants no token and clears no claim.
   */
  readonly recordIndeterminateReset: (input: {
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<
    Option.Option<CommercePortalAuthRecoveryReconciliationRequired>,
    CommercePortalAuthRecoveryUnavailable
  >;
}

export class CommercePortalAuthRecoveryReconciliationService extends Context.Service<
  CommercePortalAuthRecoveryReconciliationService,
  CommercePortalAuthRecoveryReconciliation
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/recovery/reconciliation/CommercePortalAuthRecoveryReconciliationService',
) {}

export const makeCommercePortalAuthRecoveryReconciliation = Effect.fn('CommercePortalAuthRecoveryReconciliation.make')(
  function* makeCommercePortalAuthRecoveryReconciliationEffect(): Effect.fn.Return<
    CommercePortalAuthRecoveryReconciliation,
    never,
    CommercePortalAuthRecoveryStoreService
  > {
    const store = yield* CommercePortalAuthRecoveryStoreService;

    const detect = Effect.fn('CommercePortalAuthRecoveryReconciliation.detect')(function* detectEffect(
      input: CommercePortalAuthRecoveryReconciliationCheck,
    ): Effect.fn.Return<
      Option.Option<CommercePortalAuthRecoveryReconciliationRequired>,
      CommercePortalAuthRecoveryUnavailable
    > {
      const peek =
        input.operation === VERIFY_OPERATION ? store.peekEmailVerificationLedger : store.peekPasswordResetLedger;

      const binding = yield* peek({ token: input.token });
      if (Option.isNone(binding)) {
        return Option.none();
      }

      // Independent reads against unrelated identities (the ledger's subject vs. the email's
      // current owner): safe and worth running concurrently, bounded to the two of them.
      const [ledgerSubjectAccountExists, currentAccountSubjectId] = yield* Effect.all(
        [
          store.accountExists({ providerSubjectId: binding.value.providerSubjectId }),
          store.findAccountSubjectForEmail({ email: binding.value.email }),
        ],
        { concurrency: 2 },
      );

      const conflictClass = detectRecoveryReconciliationConflict({
        currentAccountSubjectId,
        ledgerSubjectAccountExists,
        ledgerSubjectId: binding.value.providerSubjectId,
        operation: input.operation,
      });
      if (Option.isNone(conflictClass)) {
        return Option.none();
      }

      // Every conflict this function returns has already been recorded: there is exactly one exit
      // that reports `Some`, and this call is unconditional on the path to it.
      yield* store.recordRecoveryReconciliation({
        conflictClass: conflictClass.value,
        currentProviderSubjectId: currentAccountSubjectId,
        email: binding.value.email,
        operation: input.operation,
        providerSubjectId: binding.value.providerSubjectId,
      });

      return Option.some({
        conflictClass: conflictClass.value,
        outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED' as const,
      });
    });

    const recordIndeterminateReset = Effect.fn('CommercePortalAuthRecoveryReconciliation.recordIndeterminateReset')(
      function* recordIndeterminateResetEffect(input: {
        readonly token: Redacted.Redacted;
      }): Effect.fn.Return<
        Option.Option<CommercePortalAuthRecoveryReconciliationRequired>,
        CommercePortalAuthRecoveryUnavailable
      > {
        const binding = yield* store.peekDispatchedPasswordResetLedger({ token: input.token });
        if (Option.isNone(binding)) {
          return Option.none();
        }
        // Which account owns the identifier now is the first thing an operator asks of an
        // indeterminate reset, and it is the one column on the conflict row that answers it.
        const currentProviderSubjectId = yield* store.findAccountSubjectForEmail({ email: binding.value.email });
        yield* store.recordRecoveryReconciliation({
          conflictClass: 'RESET_OUTCOME_INDETERMINATE',
          currentProviderSubjectId,
          email: binding.value.email,
          operation: RESET_OPERATION,
          providerSubjectId: binding.value.providerSubjectId,
        });
        return Option.some({
          conflictClass: 'RESET_OUTCOME_INDETERMINATE' as const,
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED' as const,
        });
      },
    );

    return { detect, recordIndeterminateReset };
  },
);

/** The owner store is the only dependency; the composition root supplies it once. */
export const CommercePortalAuthRecoveryReconciliationServiceLive = Layer.effect(
  CommercePortalAuthRecoveryReconciliationService,
  makeCommercePortalAuthRecoveryReconciliation(),
);
