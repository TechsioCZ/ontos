import { defineScopedRoutine } from '@app/core-runtime';
import type {
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type {
  ProfileReconciliationOwnerVerification,
  ProfileReconciliationOwnerVerificationRequest,
} from '../../shared/actions/resolve-profile-reconciliation.ts';
import {
  CustomerCurrencyCodeUnrecognized,
  CustomerCurrencyPreferenceConflict,
  CustomerCurrencyPreferencePersistenceUnavailable,
} from '../../shared/domain/customer-currency-preference.ts';
import type {
  ChangeCustomerCurrencyPreferenceCommand,
  ChangeCustomerCurrencyPreferenceError,
  CustomerCurrencyAuthorizationSubject,
  CustomerCurrencyPreferenceChangeResult,
  CustomerCurrencyPreferenceSnapshot,
  CustomerProfileRef,
} from '../../shared/domain/customer-currency-preference.ts';
import { CurrencyCodeSchema } from '../../shared/domain/currency.ts';
import type { CurrencyCode } from '../../shared/domain/currency.ts';
import { ProfileReconciliationOwnerVerificationFailure } from '../profile-reconciliation-owner-verifier-error.ts';
import type {
  ProfileReconciliationOwnerEvidenceVerifier,
  ProfileReconciliationOwnerVerifierService,
} from '../profile-reconciliation-owner-verifier.ts';

const customerContextModuleKey = 'commerce.customer-context';
const currencyPreferenceReconciliationPolicyVersion = 'currency-preference-reconciliation.v1';
const DatabaseTimestampSchema = Schema.Union([Schema.Date, Schema.String]);
// Scoped routine rows are the decoded PostgreSQL wire shape, where SQL NULL is intentional.
// Core validates result schemas on their Type side, so codec-based Option fields cannot decode here.
const NullableDatabaseTimestampSchema = Schema.Union([DatabaseTimestampSchema, Schema.Null]);
const NullableCurrencyCodeSchema = Schema.Union([CurrencyCodeSchema, Schema.Null]);
const NullableDatabaseTextSchema = Schema.Union([Schema.String, Schema.Null]);
const CurrencyPreferenceOutcomeSchema = Schema.Literals([
  'ABSENT',
  'APPLIED',
  'CURRENCY_UNRECOGNIZED',
  'PRESENT',
  'PROFILE_NOT_FOUND',
  'RECONCILIATION_REQUIRED',
  'REVISION_CONFLICT',
  'SUBJECT_MISMATCH',
  'UNCHANGED',
]);
const CurrencyPreferenceReadRowSchema = Schema.Struct({
  created_at: NullableDatabaseTimestampSchema,
  currency_code: NullableCurrencyCodeSchema,
  outcome: CurrencyPreferenceOutcomeSchema,
  preference_id: NullableDatabaseTextSchema,
  revision: Schema.Int,
  updated_at: NullableDatabaseTimestampSchema,
});
const CurrencyPreferenceChangeRowSchema = Schema.Struct({
  created_at: NullableDatabaseTimestampSchema,
  currency_code: NullableCurrencyCodeSchema,
  outcome: CurrencyPreferenceOutcomeSchema,
  preference_id: NullableDatabaseTextSchema,
  previous_currency_code: NullableCurrencyCodeSchema,
  revision: Schema.Int,
  updated_at: NullableDatabaseTimestampSchema,
});
const CurrencyPreferenceOwnerVerificationPayloadSchema = Schema.Struct({
  correlationRef: Schema.String,
  evidenceRef: Schema.String,
  owner: Schema.Literal('CURRENCY_PREFERENCE'),
  status: Schema.Literals(['RESOLVED', 'NOT_APPLICABLE']),
});
const CurrencyPreferenceOwnerVerificationRowSchema = Schema.Struct({
  outcome: Schema.Literals(['OWNER_CONFLICT', 'OWNER_UNAVAILABLE', 'VERIFIED']),
  payload: Schema.Union([CurrencyPreferenceOwnerVerificationPayloadSchema, Schema.Null]),
});
type CurrencyPreferenceRow = typeof CurrencyPreferenceReadRowSchema.Type;

/** Minimum owner-local capability accepted from Core's scoped transaction. */
export interface CustomerContextScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const readCurrencyPreferenceRoutine = defineScopedRoutine({
  name: 'read_currency_preference',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
  ],
  resultSchema: CurrencyPreferenceReadRowSchema,
  routineKey: 'currency-preference.read-current',
  schema: 'commerce_customer_context',
});

const changeCurrencyPreferenceRoutine = defineScopedRoutine({
  name: 'change_currency_preference',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text[]' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: CurrencyPreferenceChangeRowSchema,
  routineKey: 'currency-preference.change',
  schema: 'commerce_customer_context',
});
const verifyCurrencyPreferenceReconciliationOwnerRoutine = defineScopedRoutine({
  name: 'verify_currency_preference_reconciliation_owner',
  ownerModuleKey: customerContextModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: CurrencyPreferenceOwnerVerificationRowSchema,
  routineKey: 'currency-preference.reconciliation-owner-verify',
  schema: 'commerce_customer_context',
});

const unavailableFromReason = (reason: string) =>
  CustomerCurrencyPreferencePersistenceUnavailable.make({
    code: 'customer_currency_preference_persistence_unavailable',
    reason,
  });

const unavailableFromRoutine = (failure: ScopedRoutineInvocationError) =>
  unavailableFromReason(`The scoped Currency Preference routine failed (${failure.routineKey})`);

const profileKind = (profileRef: CustomerProfileRef): 'COUNTERPARTY' | 'RETAIL' =>
  profileRef.resourceType === 'commerce.customer-context.retail-customer-profile'
    ? 'RETAIL'
    : 'COUNTERPARTY';

const timestamp = (value: Date | string): string =>
  Schema.is(Schema.String)(value) ? value : value.toISOString();

const preferenceConflictReason = (outcome: typeof CurrencyPreferenceOutcomeSchema.Type): string => {
  if (outcome === 'REVISION_CONFLICT') {
    return 'The Currency Preference changed concurrently';
  }
  if (outcome === 'RECONCILIATION_REQUIRED') {
    return 'The Currency Preference is locked by an open profile reconciliation';
  }
  return 'The Customer Profile does not match the authorized subject and scope';
};

const snapshotFromRow = (
  profileRef: CustomerProfileRef,
  row: CurrencyPreferenceRow,
): CustomerCurrencyPreferenceSnapshot => {
  if (
    row.outcome !== 'PRESENT' &&
    row.outcome !== 'APPLIED' &&
    !(row.outcome === 'UNCHANGED' && row.currency_code !== null)
  ) {
    return { profileRef, revision: row.revision, state: 'ABSENT' };
  }
  if (
    row.currency_code === null ||
    row.preference_id === null ||
    row.created_at === null ||
    row.updated_at === null
  ) {
    return { profileRef, revision: row.revision, state: 'ABSENT' };
  }
  return {
    preference: {
      createdAt: timestamp(row.created_at),
      currencyCode: row.currency_code,
      preferenceRef: {
        moduleId: customerContextModuleKey,
        resourceId: row.preference_id,
        resourceType: 'commerce.customer-context.customer-currency-preference',
        tenantId: profileRef.tenantId,
      },
      profileRef,
      revision: row.revision,
      updatedAt: timestamp(row.updated_at),
    },
    profileRef,
    revision: row.revision,
    state: 'PRESENT',
  };
};

export interface FindCurrentCustomerCurrencyPreferenceInput {
  readonly authorizationSubject: CustomerCurrencyAuthorizationSubject;
  readonly legalEntityId: string;
  readonly profileRef: CustomerProfileRef;
  readonly tenantId: string;
}

export const findCurrentCustomerCurrencyPreference = (
  transaction: CustomerContextScopedRoutineInvoker,
  input: FindCurrentCustomerCurrencyPreferenceInput,
): Effect.Effect<
  CustomerCurrencyPreferenceSnapshot,
  ReturnType<typeof CustomerCurrencyPreferencePersistenceUnavailable.make>
> => {
  if (input.profileRef.tenantId !== input.tenantId) {
    return Effect.fail(
      unavailableFromReason('The requested Currency Preference scope is inconsistent'),
    );
  }
  const counterpartyResourceId =
    input.authorizationSubject.kind === 'COUNTERPARTY'
      ? input.authorizationSubject.counterpartyRef.resourceId
      : null;
  return transaction
    .invoke(readCurrencyPreferenceRoutine, [
      input.profileRef.resourceId,
      profileKind(input.profileRef),
      counterpartyResourceId,
    ])
    .pipe(
      Effect.mapError(unavailableFromRoutine),
      Effect.flatMap(([row]) =>
        row === undefined ||
        row.outcome === 'PROFILE_NOT_FOUND' ||
        row.outcome === 'SUBJECT_MISMATCH'
          ? Effect.fail(
              unavailableFromReason('The Customer Profile is unavailable in the verified scope'),
            )
          : Effect.succeed(snapshotFromRow(input.profileRef, row)),
      ),
    );
};

export interface ChangeCustomerCurrencyPreferencePersistenceInput {
  readonly actionInvocationId: string;
  readonly command: ChangeCustomerCurrencyPreferenceCommand;
  readonly principalId: string;
  readonly recognizedCurrencies: readonly CurrencyCode[];
}

export const changeCustomerCurrencyPreference = (
  transaction: CustomerContextScopedRoutineInvoker,
  input: ChangeCustomerCurrencyPreferencePersistenceInput,
): Effect.Effect<CustomerCurrencyPreferenceChangeResult, ChangeCustomerCurrencyPreferenceError> => {
  const counterpartyResourceId =
    input.command.authorizationSubject.kind === 'COUNTERPARTY'
      ? input.command.authorizationSubject.counterpartyRef.resourceId
      : null;
  const requestedCurrency =
    input.command.change.kind === 'SET' ? input.command.change.currencyCode : null;
  return transaction
    .invoke(changeCurrencyPreferenceRoutine, [
      input.command.profileRef.resourceId,
      profileKind(input.command.profileRef),
      counterpartyResourceId,
      input.command.expectedRevision,
      input.command.change.kind,
      requestedCurrency,
      input.recognizedCurrencies,
      input.principalId,
      input.actionInvocationId,
    ])
    .pipe(
      Effect.mapError(unavailableFromRoutine),
      Effect.flatMap(
        ([row]): Effect.Effect<
          CustomerCurrencyPreferenceChangeResult,
          ChangeCustomerCurrencyPreferenceError
        > => {
          if (row === undefined) {
            return Effect.fail(
              unavailableFromReason('The Currency Preference routine returned no outcome'),
            );
          }
          if (row.outcome === 'CURRENCY_UNRECOGNIZED' && requestedCurrency !== null) {
            return Effect.fail(
              CustomerCurrencyCodeUnrecognized.make({
                code: 'customer_currency_code_unrecognized',
                currencyCode: requestedCurrency,
                reason: 'The requested currency is not recognized by the current catalog',
              }),
            );
          }
          if (
            row.outcome === 'REVISION_CONFLICT' ||
            row.outcome === 'PROFILE_NOT_FOUND' ||
            row.outcome === 'SUBJECT_MISMATCH' ||
            row.outcome === 'RECONCILIATION_REQUIRED'
          ) {
            return Effect.fail(
              CustomerCurrencyPreferenceConflict.make({
                code: 'customer_currency_preference_conflict',
                currentRevision: row.revision,
                expectedRevision: input.command.expectedRevision,
                reason: preferenceConflictReason(row.outcome),
              }),
            );
          }
          const result: CustomerCurrencyPreferenceChangeResult = {
            changed: row.outcome === 'APPLIED',
            current: snapshotFromRow(input.command.profileRef, row),
            previousCurrencyCode: row.previous_currency_code,
          };
          return Effect.succeed(result);
        },
      ),
    );
};

export interface CustomerCurrencyPreferencePersistence {
  readonly change: (
    command: ChangeCustomerCurrencyPreferenceCommand,
    attribution: {
      readonly actionInvocationId: string;
      readonly principalId: string;
      readonly tenantId: string;
    },
  ) => ReturnType<typeof changeCustomerCurrencyPreference>;
  readonly findCurrent: (input: {
    readonly authorizationSubject: CustomerCurrencyAuthorizationSubject;
    readonly profileRef: CustomerProfileRef;
  }) => ReturnType<typeof findCurrentCustomerCurrencyPreference>;
}

export const customerCurrencyPreferencePersistenceForTransaction = (
  transaction: CustomerContextScopedRoutineInvoker,
  scope: { readonly legalEntityId: string; readonly tenantId: string },
  recognizedCurrencies?: readonly CurrencyCode[],
): CustomerCurrencyPreferencePersistence => ({
  change: (command, attribution) => {
    if (recognizedCurrencies === undefined && command.change.kind === 'SET') {
      return Effect.fail(
        unavailableFromReason('The trusted Currency Catalog is unavailable for this change'),
      );
    }
    return changeCustomerCurrencyPreference(transaction, {
      actionInvocationId: attribution.actionInvocationId,
      command,
      principalId: attribution.principalId,
      recognizedCurrencies: recognizedCurrencies ?? [],
    });
  },
  findCurrent: ({ authorizationSubject, profileRef }) =>
    findCurrentCustomerCurrencyPreference(transaction, {
      authorizationSubject,
      legalEntityId: scope.legalEntityId,
      profileRef,
      tenantId: scope.tenantId,
    }),
});

/**
 * Transaction-bound owner verifier. The database locks the exact case, members, and Current
 * preferences, then derives a versioned receipt only for already-satisfied or exact-absence state.
 * Conflicting preferences are never changed by Resolve.
 */
export const verifyCurrencyPreferenceReconciliationOwner = (
  transaction: CustomerContextScopedRoutineInvoker,
  input: {
    readonly actionInvocationId: string;
    readonly principalId: string;
    readonly request: ProfileReconciliationOwnerVerificationRequest;
  },
) =>
  transaction
    .invoke(verifyCurrencyPreferenceReconciliationOwnerRoutine, [
      input.request.caseRef.resourceId,
      input.request.desiredOutcome.owner,
      input.request.survivorProfileRef.resourceId,
      input.request.resultingState,
      input.request.expectedCaseRevision,
      input.request.expectedEventVersion,
      input.request.effectiveAt,
      input.actionInvocationId,
      input.principalId,
      currencyPreferenceReconciliationPolicyVersion,
    ])
    .pipe(
      Effect.mapError((cause) => {
        const failure = new ProfileReconciliationOwnerVerificationFailure({
          code: 'OWNER_UNAVAILABLE',
          owner: 'CURRENCY_PREFERENCE',
          reason: 'Currency Preference reconciliation evidence is temporarily unavailable',
          retryable: true,
        });
        Object.defineProperty(failure, 'cause', {
          configurable: true,
          value: cause,
        });
        return failure;
      }),
      Effect.map(([row]): ProfileReconciliationOwnerVerification => {
        if (
          row?.outcome === 'VERIFIED' &&
          row.payload !== null &&
          Schema.is(CurrencyPreferenceOwnerVerificationPayloadSchema)(row.payload)
        ) {
          return {
            _tag: 'VERIFIED',
            correlationRef: row.payload.correlationRef,
            durableOutcome: {
              evidenceRef: row.payload.evidenceRef,
              owner: row.payload.owner,
              status: row.payload.status,
            },
          };
        }
        return row?.outcome === 'OWNER_CONFLICT'
          ? {
              _tag: 'CONFLICT',
              owner: 'CURRENCY_PREFERENCE',
              reason:
                'Current Currency Preference facts conflict with the requested reconciliation',
            }
          : {
              _tag: 'UNAVAILABLE',
              owner: 'CURRENCY_PREFERENCE',
              reason: 'Currency Preference reconciliation evidence is unavailable for this case',
            };
      }),
    );

export const currencyPreferenceReconciliationOwnerVerifierForTransaction = (
  transaction: CustomerContextScopedRoutineInvoker,
  scope?: {
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  },
): ProfileReconciliationOwnerVerifierService => ({
  verify: (request, context) => {
    const scopeMismatch =
      request.desiredOutcome.owner !== 'CURRENCY_PREFERENCE' ||
      request.caseRef.tenantId !== context.tenantId ||
      request.survivorProfileRef.tenantId !== context.tenantId ||
      (scope !== undefined &&
        (scope.tenantId !== context.tenantId ||
          scope.legalEntityId !== context.legalEntityId ||
          scope.principalId !== context.actorPrincipalId ||
          request.caseRef.tenantId !== scope.tenantId ||
          request.survivorProfileRef.tenantId !== scope.tenantId));
    if (scopeMismatch) {
      return Effect.fail(
        new ProfileReconciliationOwnerVerificationFailure({
          code: 'OUTCOME_INDETERMINATE',
          owner: 'CURRENCY_PREFERENCE',
          reason: 'Currency Preference verification requires the exact verified operational scope',
          retryable: false,
        }),
      );
    }
    return verifyCurrencyPreferenceReconciliationOwner(transaction, {
      actionInvocationId: context.actionInvocationId,
      principalId: context.actorPrincipalId,
      request,
    });
  },
});

export const currencyPreferenceReconciliationOwnerEvidenceVerifierForTransaction = (
  transaction: CustomerContextScopedRoutineInvoker,
  scope?: {
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  },
): ProfileReconciliationOwnerEvidenceVerifier => ({
  owner: 'CURRENCY_PREFERENCE',
  verify: currencyPreferenceReconciliationOwnerVerifierForTransaction(transaction, scope).verify,
});

export const currencyPreferenceRoutineAllowlist = Object.freeze([
  readCurrencyPreferenceRoutine,
  changeCurrencyPreferenceRoutine,
  verifyCurrencyPreferenceReconciliationOwnerRoutine,
]);
