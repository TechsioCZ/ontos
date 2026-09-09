import { ScopedRoutineInvocationError } from '@app/core-runtime';
import type { ScopedRoutineDefinition, ScopedRoutineParameter } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  changeCustomerCurrencyPreference,
  customerCurrencyPreferencePersistenceForTransaction,
  currencyPreferenceRoutineAllowlist,
  findCurrentCustomerCurrencyPreference,
  verifyCurrencyPreferenceReconciliationOwner,
} from '../../src/persistence/currency-persistence.ts';
import type { CustomerContextScopedRoutineInvoker } from '../../src/persistence/currency-persistence.ts';
import {
  CustomerCurrencyPreferenceConflict,
  CustomerCurrencyPreferencePersistenceUnavailable,
} from '../../shared/domain/customer-currency-preference.ts';
import {
  ProfileReconciliationOwnerConflictSchema,
  ProfileReconciliationOwnerUnavailableSchema,
  ProfileReconciliationOwnerVerificationRequestSchema,
  ProfileReconciliationOwnerVerifiedSchema,
} from '../../shared/actions/resolve-profile-reconciliation.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '40000000-0000-4000-8000-000000000001';
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const counterpartyA = {
  moduleId: 'party.registry',
  resourceId: '70000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const counterpartyProfileB = {
  ...profileRef,
  resourceId: '10000000-0000-4000-8000-000000000002',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
} as const;
const reconciliationVerificationRequest = () =>
  Schema.decodeUnknownSync(ProfileReconciliationOwnerVerificationRequestSchema)({
    caseRef: {
      moduleId: 'commerce.customer-context',
      resourceId: '70000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.customer-context.profile-reconciliation-case',
      tenantId,
    },
    desiredOutcome: {
      evidenceRef: 'caller-fabricated-evidence',
      owner: 'CURRENCY_PREFERENCE',
      status: 'RESOLVED',
    },
    effectiveAt: '2026-09-09T12:00:00.000Z',
    expectedCaseRevision: 4,
    expectedEventVersion: '8',
    reason: 'Resolve exact currency preference ownership',
    resultingState: 'ACTIVE',
    survivorProfileRef: { ...profileRef, kind: 'RETAIL' },
  });

const routineFailure = (routineKey: string) =>
  new ScopedRoutineInvocationError({
    code: 'scoped_routine_result_invalid',
    constraint: Option.none(),
    ownerModuleKey: 'commerce.customer-context',
    postgresCode: Option.none(),
    reason: 'The test routine row did not satisfy its declared result schema',
    routineKey,
  });

const decodeRoutineRows = <
  RowSchema extends Schema.ConstraintDecoder<object>,
  const Parameters extends readonly ScopedRoutineParameter[],
>(
  routine: ScopedRoutineDefinition<RowSchema, Parameters>,
  rows: readonly object[],
): Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError> =>
  Schema.decodeUnknownEffect(Schema.Array(Schema.toType(routine.resultSchema)))(rows).pipe(
    Effect.mapError(() => routineFailure(routine.routineKey)),
  );

const transactionReturning = (rows: readonly object[]): CustomerContextScopedRoutineInvoker => ({
  invoke: (routine) => decodeRoutineRows(routine, rows),
});

const failingTransaction: CustomerContextScopedRoutineInvoker = {
  invoke: (routine) =>
    Effect.fail(
      new ScopedRoutineInvocationError({
        code: 'scoped_routine_invocation_failed',
        constraint: Option.none(),
        ownerModuleKey: 'commerce.customer-context',
        postgresCode: Option.none(),
        reason: 'sanitized',
        routineKey: routine.routineKey,
      }),
    ),
};

it('declares immutable exact allowlist descriptors matching the granted routines', () => {
  expect(
    currencyPreferenceRoutineAllowlist.map(({ name, routineKey }) => [name, routineKey]),
  ).toEqual([
    ['read_currency_preference', 'currency-preference.read-current'],
    ['change_currency_preference', 'currency-preference.change'],
    [
      'verify_currency_preference_reconciliation_owner',
      'currency-preference.reconciliation-owner-verify',
    ],
  ]);
  for (const routine of currencyPreferenceRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('commerce.customer-context');
    expect(routine.parameters[0]).toEqual({ source: 'tenantId', type: 'uuid' });
    expect(routine.parameters[1]).toEqual({
      source: 'legalEntityId',
      type: 'uuid',
    });
  }
});

it.effect('maps an owner-routine Current preference to the public snapshot', () =>
  Effect.gen(function* currentPreference() {
    const result = yield* findCurrentCustomerCurrencyPreference(
      transactionReturning([
        {
          created_at: '2026-09-09T09:00:00.000Z',
          currency_code: 'CZK',
          outcome: 'PRESENT',
          preference_id: '30000000-0000-4000-8000-000000000001',
          revision: 3,
          updated_at: '2026-09-09T09:00:00.000Z',
        },
      ]),
      {
        authorizationSubject: { kind: 'RETAIL' },
        legalEntityId,
        profileRef,
        tenantId,
      },
    );
    expect(result).toMatchObject({
      preference: { currencyCode: 'CZK', revision: 3 },
      profileRef,
      revision: 3,
      state: 'PRESENT',
    });
  }),
);

it.effect('derives reconciliation evidence from locked owner facts, never caller evidence', () =>
  Effect.gen(function* authoritativeReconciliationReceipt() {
    let values: readonly unknown[] = [];
    const transaction: CustomerContextScopedRoutineInvoker = {
      invoke: (routine, inputValues) => {
        values = inputValues;
        return decodeRoutineRows(routine, [
          {
            outcome: 'VERIFIED',
            payload: {
              correlationRef: 'currency-preference-owner:trusted-receipt',
              evidenceRef: 'currency-preference-owner:trusted-receipt',
              owner: 'CURRENCY_PREFERENCE',
              status: 'RESOLVED',
            },
          },
        ]);
      },
    };
    const request = reconciliationVerificationRequest();

    const result = yield* verifyCurrencyPreferenceReconciliationOwner(transaction, {
      actionInvocationId: '50000000-0000-4000-8000-000000000001',
      principalId: '60000000-0000-4000-8000-000000000001',
      request,
    });

    expect(Schema.is(ProfileReconciliationOwnerVerifiedSchema)(result)).toBe(true);
    if (Schema.is(ProfileReconciliationOwnerVerifiedSchema)(result)) {
      expect(result.durableOutcome).toEqual({
        evidenceRef: 'currency-preference-owner:trusted-receipt',
        owner: 'CURRENCY_PREFERENCE',
        status: 'RESOLVED',
      });
      expect(result.durableOutcome.evidenceRef).not.toBe('caller-fabricated-evidence');
    }
    expect(values).toEqual([
      request.caseRef.resourceId,
      'CURRENCY_PREFERENCE',
      request.survivorProfileRef.resourceId,
      'ACTIVE',
      4,
      8n,
      request.effectiveAt,
      '50000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      'currency-preference-reconciliation.v1',
    ]);
  }),
);

it.effect('preserves idempotent-before-revision semantics from the atomic routine outcome', () =>
  Effect.gen(function* unchangedPreference() {
    const result = yield* changeCustomerCurrencyPreference(
      transactionReturning([
        {
          created_at: '2026-09-09T09:00:00.000Z',
          currency_code: 'CZK',
          outcome: 'UNCHANGED',
          preference_id: '30000000-0000-4000-8000-000000000001',
          previous_currency_code: 'CZK',
          revision: 4,
          updated_at: '2026-09-09T09:00:00.000Z',
        },
      ]),
      {
        actionInvocationId: '50000000-0000-4000-8000-000000000001',
        command: {
          authorizationSubject: { kind: 'RETAIL' },
          change: { currencyCode: 'CZK', kind: 'SET' },
          expectedRevision: 1,
          profileRef,
        },
        principalId: '60000000-0000-4000-8000-000000000001',
        recognizedCurrencies: ['CZK'],
      },
    );
    expect(result).toMatchObject({
      changed: false,
      current: { revision: 4, state: 'PRESENT' },
      previousCurrencyCode: 'CZK',
    });
  }),
);

it.effect('maps a routine CAS miss to the typed public conflict without leaking SQL', () =>
  Effect.gen(function* revisionConflict() {
    const error = yield* Effect.flip(
      changeCustomerCurrencyPreference(
        transactionReturning([
          {
            created_at: null,
            currency_code: null,
            outcome: 'REVISION_CONFLICT',
            preference_id: null,
            previous_currency_code: null,
            revision: 8,
            updated_at: null,
          },
        ]),
        {
          actionInvocationId: '50000000-0000-4000-8000-000000000001',
          command: {
            authorizationSubject: { kind: 'RETAIL' },
            change: { kind: 'CLEAR' },
            expectedRevision: 7,
            profileRef,
          },
          principalId: '60000000-0000-4000-8000-000000000001',
          recognizedCurrencies: ['CZK'],
        },
      ),
    );
    expect(Schema.is(CustomerCurrencyPreferenceConflict)(error)).toBe(true);
    if (Schema.is(CustomerCurrencyPreferenceConflict)(error)) {
      expect(error.currentRevision).toBe(8);
      expect(error.expectedRevision).toBe(7);
    }
  }),
);

it.effect('blocks ordinary preference mutation while profile reconciliation is open', () =>
  Effect.gen(function* openReconciliationGuard() {
    const error = yield* Effect.flip(
      changeCustomerCurrencyPreference(
        transactionReturning([
          {
            created_at: null,
            currency_code: null,
            outcome: 'RECONCILIATION_REQUIRED',
            preference_id: null,
            previous_currency_code: null,
            revision: 5,
            updated_at: null,
          },
        ]),
        {
          actionInvocationId: '50000000-0000-4000-8000-000000000001',
          command: {
            authorizationSubject: { kind: 'RETAIL' },
            change: { kind: 'CLEAR' },
            expectedRevision: 5,
            profileRef,
          },
          principalId: '60000000-0000-4000-8000-000000000001',
          recognizedCurrencies: [],
        },
      ),
    );
    expect(Schema.is(CustomerCurrencyPreferenceConflict)(error)).toBe(true);
    if (Schema.is(CustomerCurrencyPreferenceConflict)(error)) {
      expect(error.reason).toContain('open profile reconciliation');
    }
  }),
);

it.effect('fails closed when a write adapter has no trusted Currency Catalog', () =>
  Effect.gen(function* missingCurrencyCatalog() {
    let invoked = false;
    const transaction: CustomerContextScopedRoutineInvoker = {
      invoke: () => {
        invoked = true;
        return Effect.die('The routine must not be invoked without a trusted Currency Catalog');
      },
    };
    const persistence = customerCurrencyPreferencePersistenceForTransaction(transaction, {
      legalEntityId,
      tenantId,
    });

    const error = yield* Effect.flip(
      persistence.change(
        {
          authorizationSubject: { kind: 'RETAIL' },
          change: { currencyCode: 'CZK', kind: 'SET' },
          expectedRevision: 0,
          profileRef,
        },
        {
          actionInvocationId: '50000000-0000-4000-8000-000000000001',
          principalId: '60000000-0000-4000-8000-000000000001',
          tenantId,
        },
      ),
    );

    expect(invoked).toBe(false);
    expect(Schema.is(CustomerCurrencyPreferencePersistenceUnavailable)(error)).toBe(true);
    if (Schema.is(CustomerCurrencyPreferencePersistenceUnavailable)(error)) {
      expect(error.reason).toContain('Currency Catalog');
    }
  }),
);

it.effect('clears without consulting or requiring a Currency Catalog', () =>
  Effect.gen(function* clearWithoutCatalog() {
    let invoked = false;
    const persistence = customerCurrencyPreferencePersistenceForTransaction(
      {
        invoke: (routine) => {
          invoked = true;
          return decodeRoutineRows(routine, [
            {
              created_at: null,
              currency_code: null,
              outcome: 'APPLIED',
              preference_id: null,
              previous_currency_code: 'CZK',
              revision: 2,
              updated_at: null,
            },
          ]);
        },
      },
      { legalEntityId, tenantId },
    );

    const result = yield* persistence.change(
      {
        authorizationSubject: { kind: 'RETAIL' },
        change: { kind: 'CLEAR' },
        expectedRevision: 1,
        profileRef,
      },
      {
        actionInvocationId: '50000000-0000-4000-8000-000000000001',
        principalId: '60000000-0000-4000-8000-000000000001',
        tenantId,
      },
    );

    expect(invoked).toBe(true);
    expect(result).toMatchObject({
      changed: true,
      current: { revision: 2, state: 'ABSENT' },
      previousCurrencyCode: 'CZK',
    });
  }),
);

it.effect('re-verifies durable currency facts after a transient partial-progress retry', () =>
  Effect.gen(function* retryOwnerVerification() {
    let invocation = 0;
    const transaction: CustomerContextScopedRoutineInvoker = {
      invoke: (routine) => {
        invocation += 1;
        return decodeRoutineRows(
          routine,
          invocation === 1
            ? [{ outcome: 'OWNER_UNAVAILABLE', payload: null }]
            : [
                {
                  outcome: 'VERIFIED',
                  payload: {
                    correlationRef: 'currency-preference-owner:retry-receipt',
                    evidenceRef: 'currency-preference-owner:retry-receipt',
                    owner: 'CURRENCY_PREFERENCE',
                    status: 'RESOLVED',
                  },
                },
              ],
        );
      },
    };
    const input = {
      actionInvocationId: '50000000-0000-4000-8000-000000000001',
      principalId: '60000000-0000-4000-8000-000000000001',
      request: reconciliationVerificationRequest(),
    };

    const first = yield* verifyCurrencyPreferenceReconciliationOwner(transaction, input);
    expect(Schema.is(ProfileReconciliationOwnerUnavailableSchema)(first)).toBe(true);
    const retried = yield* verifyCurrencyPreferenceReconciliationOwner(transaction, input);
    expect(Schema.is(ProfileReconciliationOwnerVerifiedSchema)(retried)).toBe(true);
    if (Schema.is(ProfileReconciliationOwnerVerifiedSchema)(retried)) {
      expect(retried.durableOutcome.evidenceRef).toBe('currency-preference-owner:retry-receipt');
    }
    expect(invocation).toBe(2);
  }),
);

it.effect('surfaces conflicting member preferences without producing a receipt', () =>
  Effect.gen(function* conflictingMemberPreference() {
    const result = yield* verifyCurrencyPreferenceReconciliationOwner(
      transactionReturning([{ outcome: 'OWNER_CONFLICT', payload: null }]),
      {
        actionInvocationId: '50000000-0000-4000-8000-000000000001',
        principalId: '60000000-0000-4000-8000-000000000001',
        request: reconciliationVerificationRequest(),
      },
    );
    expect(Schema.is(ProfileReconciliationOwnerConflictSchema)(result)).toBe(true);
    expect('correlationRef' in result).toBe(false);
  }),
);

it.effect('maps the Core routine failure to the owner domain error', () =>
  Effect.gen(function* unavailableRoutine() {
    const error = yield* Effect.flip(
      findCurrentCustomerCurrencyPreference(failingTransaction, {
        authorizationSubject: { kind: 'RETAIL' },
        legalEntityId,
        profileRef,
        tenantId,
      }),
    );
    expect(Schema.is(CustomerCurrencyPreferencePersistenceUnavailable)(error)).toBe(true);
    if (Schema.is(CustomerCurrencyPreferencePersistenceUnavailable)(error)) {
      expect(error.code).toBe('customer_currency_preference_persistence_unavailable');
      expect(error.reason).toContain('currency-preference.read-current');
      expect(error.reason).not.toContain('SQL');
    }
  }),
);

it.effect('fails closed when permission subject A is used to read Counterparty profile B', () =>
  Effect.gen(function* mismatchedCounterparty() {
    let values: readonly unknown[] = [];
    const transaction: CustomerContextScopedRoutineInvoker = {
      invoke: (routine, inputValues) => {
        values = inputValues;
        return decodeRoutineRows(routine, [
          {
            created_at: null,
            currency_code: null,
            outcome: 'SUBJECT_MISMATCH',
            preference_id: null,
            revision: 0,
            updated_at: null,
          },
        ]);
      },
    };

    const error = yield* Effect.flip(
      findCurrentCustomerCurrencyPreference(transaction, {
        authorizationSubject: {
          counterpartyRef: counterpartyA,
          kind: 'COUNTERPARTY',
        },
        legalEntityId,
        profileRef: counterpartyProfileB,
        tenantId,
      }),
    );
    expect(values).toEqual([
      counterpartyProfileB.resourceId,
      'COUNTERPARTY',
      counterpartyA.resourceId,
    ]);
    expect(Schema.is(CustomerCurrencyPreferencePersistenceUnavailable)(error)).toBe(true);
    if (Schema.is(CustomerCurrencyPreferencePersistenceUnavailable)(error)) {
      expect(error.code).toBe('customer_currency_preference_persistence_unavailable');
      expect(error.reason).not.toContain(counterpartyA.resourceId);
      expect(error.reason).not.toContain(counterpartyProfileB.resourceId);
    }
  }),
);
