import { Effect, Option, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CommercePortalAuthRecoveryStoreService,
  detectRecoveryReconciliationConflict,
  makeCommercePortalAuthRecoveryReconciliation,
} from '../../api/portal-auth/provider/recovery/index.ts';
import type {
  CommercePortalAuthRecoveryLedgerBinding,
  CommercePortalAuthRecoveryStore,
} from '../../api/portal-auth/provider/recovery/index.ts';

const EMAIL = 'reconciliation-customer@example.test';
const LEDGER_SUBJECT = 'commerce-user-ledger-subject';
const CURRENT_SUBJECT = 'commerce-user-current-subject';
const TOKEN = Redacted.make('reconciliation-token');
const TOKEN_DIGEST = 'reconciliation-token-digest';

/**
 * Everything the reconciliation service needs, wired to explicit fixture state. Every store method
 * outside detection's own reads is stubbed with `Effect.die` — `detect` never calls them, so a test
 * that invokes one has a bug and should fail loudly rather than silently return a placeholder. The
 * dispatched-row read is among them: it belongs to `recordIndeterminateReset`, which the tests at
 * the end of this file drive with a fixture of its own.
 */
interface ReconciliationStoreFixture {
  readonly recordedConflicts: () => readonly Parameters<
    CommercePortalAuthRecoveryStore['recordRecoveryReconciliation']
  >[0][];
  readonly store: CommercePortalAuthRecoveryStore;
}

const unusedRequiredMethod = () => Effect.die('unused in reconciliation detection tests');

const makeReconciliationStore = (input: {
  readonly accountExists: boolean;
  readonly currentAccountSubjectId: Option.Option<string>;
  readonly ledgerBinding: Option.Option<CommercePortalAuthRecoveryLedgerBinding>;
}): ReconciliationStoreFixture => {
  const recorded: Parameters<CommercePortalAuthRecoveryStore['recordRecoveryReconciliation']>[0][] = [];
  return {
    recordedConflicts: () => recorded,
    store: {
      accountExists: () => Effect.succeed(input.accountExists),
      consumeEmailVerificationWithAudit: unusedRequiredMethod,
      consumePasswordResetLedgerWithAudit: unusedRequiredMethod,
      consumeRateLimitBudget: unusedRequiredMethod,
      dispatchPasswordResetLedger: unusedRequiredMethod,
      findAccountSubjectForEmail: () => Effect.succeed(input.currentAccountSubjectId),
      peekDispatchedPasswordResetLedger: unusedRequiredMethod,
      peekEmailVerificationLedger: () => Effect.succeed(input.ledgerBinding),
      peekPasswordResetLedger: () => Effect.succeed(input.ledgerBinding),
      recordRecoveryReconciliation: (conflict) =>
        Effect.sync(() => {
          recorded.push(conflict);
        }),
      registerEmailVerificationToken: unusedRequiredMethod,
      registerPasswordResetToken: unusedRequiredMethod,
      reserveEmailVerificationSubject: unusedRequiredMethod,
    },
  };
};

const runDetect = (store: CommercePortalAuthRecoveryStore, operation: 'reset-password' | 'verify-email') =>
  makeCommercePortalAuthRecoveryReconciliation().pipe(
    Effect.flatMap((service) => service.detect({ operation, token: TOKEN })),
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
  );

// -- Pure decision function: one case per conflict class, plus the no-conflict case. -----------

it.effect('detectRecoveryReconciliationConflict names TOKEN_SUBJECT_STALE when the ledger subject has no account', () =>
  Effect.sync(() => {
    const result = detectRecoveryReconciliationConflict({
      currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
      ledgerSubjectAccountExists: false,
      ledgerSubjectId: LEDGER_SUBJECT,
      operation: 'verify-email',
    });
    expect(Option.isSome(result) && result.value).toBe('TOKEN_SUBJECT_STALE');
  }),
);

it.effect(
  'detectRecoveryReconciliationConflict names VERIFICATION_LEDGER_SUBJECT_MISMATCH for a verify-email disagreement',
  () =>
    Effect.sync(() => {
      const result = detectRecoveryReconciliationConflict({
        currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
        ledgerSubjectAccountExists: true,
        ledgerSubjectId: LEDGER_SUBJECT,
        operation: 'verify-email',
      });
      expect(Option.isSome(result) && result.value).toBe('VERIFICATION_LEDGER_SUBJECT_MISMATCH');
    }),
);

it.effect('detectRecoveryReconciliationConflict names IDENTIFIER_REBOUND for a reset-password disagreement', () =>
  Effect.sync(() => {
    const result = detectRecoveryReconciliationConflict({
      currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
      ledgerSubjectAccountExists: true,
      ledgerSubjectId: LEDGER_SUBJECT,
      operation: 'reset-password',
    });
    expect(Option.isSome(result) && result.value).toBe('IDENTIFIER_REBOUND');
  }),
);

it.effect('detectRecoveryReconciliationConflict names TOKEN_SUBJECT_STALE ahead of a same-operation mismatch', () =>
  Effect.sync(() => {
    // The ledger subject no longer names any account AND the identifier now belongs to someone
    // else: the deleted/recreated-account fact is more specific and must not be hidden by the
    // ordinary mismatch class.
    const result = detectRecoveryReconciliationConflict({
      currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
      ledgerSubjectAccountExists: false,
      ledgerSubjectId: LEDGER_SUBJECT,
      operation: 'reset-password',
    });
    expect(Option.isSome(result) && result.value).toBe('TOKEN_SUBJECT_STALE');
  }),
);

it.effect('detectRecoveryReconciliationConflict finds no conflict when the evidence still agrees', () =>
  Effect.sync(() => {
    const result = detectRecoveryReconciliationConflict({
      currentAccountSubjectId: Option.some(LEDGER_SUBJECT),
      ledgerSubjectAccountExists: true,
      ledgerSubjectId: LEDGER_SUBJECT,
      operation: 'verify-email',
    });
    expect(Option.isNone(result)).toBe(true);
  }),
);

// -- Service-level detect(): wires the store and asserts the durable side effect. ----------------

it.effect(
  'detect raises ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED exactly once for VERIFICATION_LEDGER_SUBJECT_MISMATCH',
  () =>
    Effect.gen(function* test() {
      const fixture = makeReconciliationStore({
        accountExists: true,
        currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
        ledgerBinding: Option.some({ email: EMAIL, providerSubjectId: LEDGER_SUBJECT, tokenDigest: TOKEN_DIGEST }),
      });
      const outcome = yield* runDetect(fixture.store, 'verify-email');
      expect(Option.isSome(outcome)).toBe(true);
      if (Option.isSome(outcome)) {
        expect(outcome.value).toStrictEqual({
          conflictClass: 'VERIFICATION_LEDGER_SUBJECT_MISMATCH',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
      }
      expect(fixture.recordedConflicts()).toHaveLength(1);
      expect(fixture.recordedConflicts()[0]?.conflictClass).toBe('VERIFICATION_LEDGER_SUBJECT_MISMATCH');
    }),
);

it.effect('detect raises ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED exactly once for IDENTIFIER_REBOUND', () =>
  Effect.gen(function* test() {
    const fixture = makeReconciliationStore({
      accountExists: true,
      currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
      ledgerBinding: Option.some({ email: EMAIL, providerSubjectId: LEDGER_SUBJECT, tokenDigest: TOKEN_DIGEST }),
    });
    const outcome = yield* runDetect(fixture.store, 'reset-password');
    expect(Option.isSome(outcome)).toBe(true);
    if (Option.isSome(outcome)) {
      expect(outcome.value).toStrictEqual({
        conflictClass: 'IDENTIFIER_REBOUND',
        outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
      });
    }
    expect(fixture.recordedConflicts()).toHaveLength(1);
    expect(fixture.recordedConflicts()[0]?.conflictClass).toBe('IDENTIFIER_REBOUND');
  }),
);

it.effect('detect raises ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED exactly once for TOKEN_SUBJECT_STALE', () =>
  Effect.gen(function* test() {
    const fixture = makeReconciliationStore({
      accountExists: false,
      currentAccountSubjectId: Option.none(),
      ledgerBinding: Option.some({ email: EMAIL, providerSubjectId: LEDGER_SUBJECT, tokenDigest: TOKEN_DIGEST }),
    });
    const outcome = yield* runDetect(fixture.store, 'reset-password');
    expect(Option.isSome(outcome)).toBe(true);
    if (Option.isSome(outcome)) {
      expect(outcome.value).toStrictEqual({
        conflictClass: 'TOKEN_SUBJECT_STALE',
        outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
      });
    }
    expect(fixture.recordedConflicts()).toHaveLength(1);
    expect(fixture.recordedConflicts()[0]?.conflictClass).toBe('TOKEN_SUBJECT_STALE');
    // Never resolves and never restores access: recording the row is the only effect detection has.
    expect(fixture.recordedConflicts()[0]?.currentProviderSubjectId).toStrictEqual(Option.none());
  }),
);

it.effect('detect returns None and records nothing when the evidence still agrees', () =>
  Effect.gen(function* test() {
    const fixture = makeReconciliationStore({
      accountExists: true,
      currentAccountSubjectId: Option.some(LEDGER_SUBJECT),
      ledgerBinding: Option.some({ email: EMAIL, providerSubjectId: LEDGER_SUBJECT, tokenDigest: TOKEN_DIGEST }),
    });
    const outcome = yield* runDetect(fixture.store, 'verify-email');
    expect(Option.isNone(outcome)).toBe(true);
    expect(fixture.recordedConflicts()).toHaveLength(0);
  }),
);

it.effect('detect returns None and records nothing when there is no ledger record for the token', () =>
  Effect.gen(function* test() {
    const fixture = makeReconciliationStore({
      accountExists: true,
      currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
      ledgerBinding: Option.none(),
    });
    const outcome = yield* runDetect(fixture.store, 'verify-email');
    expect(Option.isNone(outcome)).toBe(true);
    expect(fixture.recordedConflicts()).toHaveLength(0);
  }),
);

it.effect('detect never restores access: a conflicting result carries no subject, email, or token', () =>
  Effect.gen(function* test() {
    const fixture = makeReconciliationStore({
      accountExists: true,
      currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
      ledgerBinding: Option.some({ email: EMAIL, providerSubjectId: LEDGER_SUBJECT, tokenDigest: TOKEN_DIGEST }),
    });
    const outcome = yield* runDetect(fixture.store, 'verify-email');
    expect(Option.isSome(outcome)).toBe(true);
    if (Option.isSome(outcome)) {
      const keys = Object.keys(outcome.value);
      expect(keys).toHaveLength(2);
      expect(keys).toContain('conflictClass');
      expect(keys).toContain('outcome');
    }
  }),
);

// -- The indeterminate-reset recorder: the dispatched row is the whole evidence. ----------------

/**
 * The same store fixture, with only the reads `recordIndeterminateReset` makes wired: the claimed
 * row's binding and the identifier's current owner. Detection's own reads stay fatal here for the
 * same reason they are stubbed above — this path must never re-run detection.
 */
const makeIndeterminateStore = (input: {
  readonly currentAccountSubjectId: Option.Option<string>;
  readonly dispatchedBinding: Option.Option<CommercePortalAuthRecoveryLedgerBinding>;
}): ReconciliationStoreFixture => {
  const recorded: Parameters<CommercePortalAuthRecoveryStore['recordRecoveryReconciliation']>[0][] = [];
  return {
    recordedConflicts: () => recorded,
    store: {
      accountExists: unusedRequiredMethod,
      consumeEmailVerificationWithAudit: unusedRequiredMethod,
      consumePasswordResetLedgerWithAudit: unusedRequiredMethod,
      consumeRateLimitBudget: unusedRequiredMethod,
      dispatchPasswordResetLedger: unusedRequiredMethod,
      findAccountSubjectForEmail: () => Effect.succeed(input.currentAccountSubjectId),
      peekDispatchedPasswordResetLedger: () => Effect.succeed(input.dispatchedBinding),
      peekEmailVerificationLedger: unusedRequiredMethod,
      peekPasswordResetLedger: unusedRequiredMethod,
      recordRecoveryReconciliation: (conflict) =>
        Effect.sync(() => {
          recorded.push(conflict);
        }),
      registerEmailVerificationToken: unusedRequiredMethod,
      registerPasswordResetToken: unusedRequiredMethod,
      reserveEmailVerificationSubject: unusedRequiredMethod,
    },
  };
};

const runRecordIndeterminate = (store: CommercePortalAuthRecoveryStore) =>
  makeCommercePortalAuthRecoveryReconciliation().pipe(
    Effect.flatMap((service) => service.recordIndeterminateReset({ token: TOKEN })),
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
  );

it.effect('recordIndeterminateReset files RESET_OUTCOME_INDETERMINATE for a row still claimed for a dispatch', () =>
  Effect.gen(function* test() {
    const fixture = makeIndeterminateStore({
      currentAccountSubjectId: Option.some(LEDGER_SUBJECT),
      dispatchedBinding: Option.some({ email: EMAIL, providerSubjectId: LEDGER_SUBJECT, tokenDigest: TOKEN_DIGEST }),
    });
    const outcome = yield* runRecordIndeterminate(fixture.store);
    expect(Option.isSome(outcome)).toBe(true);
    if (Option.isSome(outcome)) {
      expect(outcome.value).toStrictEqual({
        conflictClass: 'RESET_OUTCOME_INDETERMINATE',
        outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
      });
    }
    expect(fixture.recordedConflicts()).toHaveLength(1);
    expect(fixture.recordedConflicts()[0]?.conflictClass).toBe('RESET_OUTCOME_INDETERMINATE');
    expect(fixture.recordedConflicts()[0]?.operation).toBe('reset-password');
    expect(fixture.recordedConflicts()[0]?.providerSubjectId).toBe(LEDGER_SUBJECT);
    // The identifier's current owner is the column a support operator reads first.
    expect(fixture.recordedConflicts()[0]?.currentProviderSubjectId).toStrictEqual(Option.some(LEDGER_SUBJECT));
  }),
);

it.effect('recordIndeterminateReset records nothing when no row is claimed for a dispatch', () =>
  Effect.gen(function* test() {
    const fixture = makeIndeterminateStore({
      currentAccountSubjectId: Option.some(CURRENT_SUBJECT),
      dispatchedBinding: Option.none(),
    });
    const outcome = yield* runRecordIndeterminate(fixture.store);
    // None is what lets the caller's own provider answer stand: a token nobody claimed was never
    // dispatched, so a rejection of it is a rejection, not an unknown outcome.
    expect(Option.isNone(outcome)).toBe(true);
    expect(fixture.recordedConflicts()).toHaveLength(0);
  }),
);
