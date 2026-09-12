/* oxlint-disable effect-native/no-dependency-parameters effect-native/no-manual-tag-comparison effect-native/prefer-match-over-tag-switch -- Canonical catalog/policy ports remain explicit fail-closed composition inputs; decoded owner-routine outcomes are exhaustively narrowed here; expires: 2027-03-31. */
// oxlint-disable-next-line max-classes-per-file -- The four reservation failures form one colocated owner contract and exhaustive union; expires: 2027-03-31.
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { ReadHandlerUnavailable, defineScopedRoutine } from '@app/core-runtime';
import type { CurrentPaymentTermsResponse } from '@app/payment-term-catalog-contracts/current-payment-terms';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Effect, Option, Schema } from 'effect';

import type {
  CustomerPaymentTermEntitlementReadRequest,
  CustomerPaymentTermEntitlementReadResponse,
} from '../../shared/apis/customer-payment-term-entitlement-read.ts';
import type {
  PaymentTermsResolutionRequest,
  PaymentTermsResolutionResponse,
} from '../../shared/apis/payment-terms-resolution.ts';
import { ReservePaymentTermRetirementResultSchema } from '../../shared/actions/reserve-payment-term-retirement.ts';
import type {
  ReservePaymentTermRetirementPayload,
  ReservePaymentTermRetirementResult,
} from '../../shared/actions/reserve-payment-term-retirement.ts';
import type {
  ProfileReconciliationOwnerVerification,
  ProfileReconciliationOwnerVerificationRequest,
} from '../../shared/actions/resolve-profile-reconciliation.ts';
import type { CounterpartyRef } from '../../shared/domain/access-contract.ts';
import {
  CustomerPaymentTermsStateSchema,
  PaymentTermsTimestampSchema,
} from '../../shared/domain/payment-term-contracts.ts';
import type { CustomerPaymentTermsState, PaymentTermReference } from '../../shared/domain/payment-term-contracts.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import {
  changeCustomerPaymentTerms,
  projectCustomerPaymentTermsAt,
  removeCustomerPaymentTerm,
  resolvePaymentTerms,
} from '../../shared/domain/payment-terms.ts';
import type { CustomerPaymentTermsChange, PaymentTermsPolicyResolution } from '../../shared/domain/payment-terms.ts';
import type { CounterpartyPurchasingProfileRef } from '../../shared/resources/counterparty-purchasing-profile.ts';
import type { CustomerPaymentTermEntitlementRef } from '../../shared/resources/customer-payment-term-entitlement.ts';
import type { RetailCustomerProfileRef } from '../../shared/resources/retail-customer-profile.ts';
import { ProfileReconciliationOwnerVerificationFailure } from '../profile-reconciliation-owner-verifier-error.ts';
import type { ProfileReconciliationOwnerEvidenceVerifier } from '../profile-reconciliation-owner-verifier.ts';

const ownerModuleKey = 'commerce.customer-context';
const schema = 'commerce_customer_context';
type PaymentTermDefinition = CurrentPaymentTermsResponse['current'][number];

/* oxlint-disable effect-native/no-nullable-schema-field -- PostgreSQL object rows encode SQL NULL as null and are decoded before entering the domain; expires: 2027-03-31. */
const PaymentTermsRoutineRowSchema = Schema.Struct({
  current_revision: Schema.NullOr(Schema.Int),
  outcome: Schema.Literals([
    'APPLIED',
    'PRESENT',
    'PROFILE_COUNTERPARTY_MISMATCH',
    'PROFILE_INELIGIBLE',
    'PROFILE_NOT_FOUND',
    'REVISION_CONFLICT',
    'PAYMENT_TERM_RETIREMENT_RESERVED',
    'UNCHANGED',
  ]),
  payload: Schema.NullOr(Schema.Unknown),
});
/* oxlint-enable effect-native/no-nullable-schema-field */
type PaymentTermsRoutineRow = typeof PaymentTermsRoutineRowSchema.Type;

const PaymentTermAffectedUseRoutineRowSchema = Schema.Struct({
  current_customer_entitlement_count: Schema.Int,
  evidence_reference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  observed_at: Schema.Union([Schema.Date, Schema.String]),
  outcome: Schema.Literal('ASSESSED'),
});

const PaymentTermRetirementReservationPayloadSchema = Schema.Struct({
  effectiveAt: PaymentTermsTimestampSchema,
  lifecycle: Schema.Literals(['RESERVED', 'COMMITTED', 'RELEASED']),
  paymentTermResourceIds: ReservePaymentTermRetirementResultSchema.fields.paymentTermResourceIds,
  reservationRef: Schema.String.check(Schema.isUUID()),
});
const PaymentTermRetirementReservationRoutineRowSchema = Schema.Struct({
  outcome: Schema.Literals(['CONFLICT', 'INVALID_REQUEST', 'NOT_FOUND', 'RESERVED', 'COMMITTED', 'RELEASED']),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- PostgreSQL returns SQL NULL until the owner boundary validates the reservation state; expires: 2027-03-31.
  payload: Schema.NullOr(PaymentTermRetirementReservationPayloadSchema),
});

const PaymentTermsOwnerVerificationPayloadSchema = Schema.Struct({
  correlationRef: Schema.String,
  evidenceRef: Schema.String,
  owner: Schema.Literal('PAYMENT_TERMS'),
  status: Schema.Literals(['RESOLVED', 'NOT_APPLICABLE']),
});
const PaymentTermsOwnerVerificationRowSchema = Schema.Struct({
  outcome: Schema.Literals(['OWNER_CONFLICT', 'OWNER_UNAVAILABLE', 'VERIFIED']),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- PostgreSQL returns SQL NULL when the owner verification has no evidence projection; expires: 2027-03-31.
  payload: Schema.NullOr(PaymentTermsOwnerVerificationPayloadSchema),
});

type PaymentTermsActionContext = Readonly<{
  readonly actionInvocationId: string;
  readonly scope: OperationalScope;
}>;

interface ChangeCustomerPaymentTermsPayload {
  readonly changes: readonly CustomerPaymentTermsChange[];
  readonly counterpartyRef: CounterpartyRef;
  readonly expectedRevision: number;
  readonly profileRef: CounterpartyPurchasingProfileRef;
  readonly reason: string;
}

interface ChangeCustomerPaymentTermsResult {
  readonly changed: boolean;
  readonly state: CustomerPaymentTermsState;
}

const customerPaymentTermsActionRejectedFields = {
  code: Schema.Literals([
    'PROFILE_NOT_FOUND',
    'PROFILE_INELIGIBLE',
    'PROFILE_COUNTERPARTY_MISMATCH',
    'PAYMENT_TERM_NOT_FOUND',
    'PAYMENT_TERM_NOT_CURRENT',
    'PAYMENT_TERM_INCOMPATIBLE',
    'REVISION_CONFLICT',
    'ENTITLEMENT_OVERLAP',
    'PREFERENCE_CONFLICT',
    'PAYMENT_TERM_RETIREMENT_RESERVED',
    'ENTITLEMENT_NOT_FOUND',
    'REMOVAL_CONFLICT',
    'SCOPE_MISMATCH',
    'DEPENDENCY_UNAVAILABLE',
    'PERSISTENCE_UNAVAILABLE',
    'OUTCOME_INDETERMINATE',
  ]),
  currentRevision: Schema.optionalKey(Schema.Int),
  reason: Schema.String,
  retryable: Schema.Boolean,
} as const;
const CustomerPaymentTermsActionRejectedSchema = Schema.TaggedStruct(
  'CustomerPaymentTermsActionRejected',
  customerPaymentTermsActionRejectedFields,
);
const CustomerPaymentTermsActionRejected = Schema.TaggedError<typeof CustomerPaymentTermsActionRejectedSchema.Type>()(
  'CustomerPaymentTermsActionRejected',
  customerPaymentTermsActionRejectedFields,
);
type CustomerPaymentTermsActionRejectedError = InstanceType<typeof CustomerPaymentTermsActionRejected>;

export interface ChangeCustomerPaymentTermsServices {
  readonly change: (
    payload: ChangeCustomerPaymentTermsPayload,
    context: PaymentTermsActionContext,
  ) => Effect.Effect<ChangeCustomerPaymentTermsResult, CustomerPaymentTermsActionRejectedError>;
}

interface RemoveCustomerPaymentTermPayload {
  readonly counterpartyRef: CounterpartyRef;
  readonly effectiveAt: Extract<CustomerPaymentTermsChange, { readonly _tag: 'CLEAR_PREFERENCE' }>['effectiveAt'];
  readonly entitlementRef: CustomerPaymentTermEntitlementRef;
  readonly expectedRevision: number;
  readonly profileRef: CounterpartyPurchasingProfileRef;
  readonly reason: string;
}

interface RemoveCustomerPaymentTermResult extends ChangeCustomerPaymentTermsResult {
  readonly preferenceCleared: boolean;
  readonly removalKind: 'CANCELLED' | 'ENDED';
}

export interface RemoveCustomerPaymentTermServices {
  readonly remove: (
    payload: RemoveCustomerPaymentTermPayload,
    context: PaymentTermsActionContext,
  ) => Effect.Effect<RemoveCustomerPaymentTermResult, CustomerPaymentTermsActionRejectedError>;
}

type RetailPaymentTermPreferenceChange = Extract<
  CustomerPaymentTermsChange,
  { readonly _tag: 'CLEAR_PREFERENCE' | 'SET_PREFERENCE' }
>;

interface ChangeRetailPaymentTermPreferencePayload {
  readonly change: RetailPaymentTermPreferenceChange;
  readonly expectedRevision: number;
  readonly profileRef: RetailCustomerProfileRef;
}

type ChangeRetailPaymentTermPreferenceResult = ChangeCustomerPaymentTermsResult;

const retailPaymentTermPreferenceRejectedFields = {
  code: Schema.Literals([
    'PROFILE_NOT_FOUND',
    'PROFILE_INELIGIBLE',
    'PAYMENT_TERM_NOT_ENTITLED',
    'PAYMENT_TERM_NOT_CURRENT',
    'REVISION_CONFLICT',
    'PREFERENCE_CONFLICT',
    'PAYMENT_TERM_RETIREMENT_RESERVED',
    'SCOPE_MISMATCH',
    'PERSISTENCE_UNAVAILABLE',
    'OUTCOME_INDETERMINATE',
  ]),
  currentRevision: Schema.optionalKey(Schema.Int),
  reason: Schema.String,
  retryable: Schema.Boolean,
} as const;
const RetailPaymentTermPreferenceRejectedSchema = Schema.TaggedStruct(
  'RetailPaymentTermPreferenceRejected',
  retailPaymentTermPreferenceRejectedFields,
);
const RetailPaymentTermPreferenceRejected = Schema.TaggedError<typeof RetailPaymentTermPreferenceRejectedSchema.Type>()(
  'RetailPaymentTermPreferenceRejected',
  retailPaymentTermPreferenceRejectedFields,
);
type RetailPaymentTermPreferenceRejectedError = InstanceType<typeof RetailPaymentTermPreferenceRejected>;

export interface RetailPaymentTermPreferenceActionServices {
  readonly changePreference: (
    payload: ChangeRetailPaymentTermPreferencePayload,
    attribution: {
      readonly actionInvocationId: string;
      readonly legalEntityId: string;
      readonly principalId: string;
      readonly tenantId: string;
    },
  ) => Effect.Effect<ChangeRetailPaymentTermPreferenceResult, RetailPaymentTermPreferenceRejectedError>;
}

export interface CustomerPaymentTermEntitlementReadServices {
  readonly read: (
    input: CustomerPaymentTermEntitlementReadRequest,
  ) => Effect.Effect<CustomerPaymentTermEntitlementReadResponse, ReadHandlerUnavailable>;
}

interface PaymentTermsResolutionServices {
  readonly resolve: (
    input: PaymentTermsResolutionRequest,
  ) => Effect.Effect<PaymentTermsResolutionResponse, ReadHandlerUnavailable>;
}

/** Minimum owner-local capability accepted from Core's scoped transaction. */
export interface CustomerPaymentTermsScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const readPaymentTermsRoutine = defineScopedRoutine({
  name: 'read_customer_payment_terms',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
  ],
  resultSchema: PaymentTermsRoutineRowSchema,
  routineKey: 'payment-terms.read-state',
  schema,
});

const persistPaymentTermsRoutine = defineScopedRoutine({
  name: 'persist_customer_payment_terms',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PaymentTermsRoutineRowSchema,
  routineKey: 'payment-terms.persist-state',
  schema,
});

const assessPaymentTermEntitlementUseRoutine = defineScopedRoutine({
  name: 'assess_payment_term_entitlement_use',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid[]' },
    { source: 'input', type: 'timestamptz' },
  ],
  resultSchema: PaymentTermAffectedUseRoutineRowSchema,
  routineKey: 'payment-terms.assess-entitlement-use',
  schema,
});

const reservePaymentTermRetirementRoutine = defineScopedRoutine({
  name: 'reserve_payment_term_retirement',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PaymentTermRetirementReservationRoutineRowSchema,
  routineKey: 'payment-terms.reserve-retirement',
  schema,
});

const paymentTermsReconciliationIdentityParameters = [
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
] as const;
const paymentTermsReconciliationEvidenceParameters = [
  { source: 'input', type: 'integer' },
  { source: 'input', type: 'bigint' },
  { source: 'input', type: 'timestamptz' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
] as const;

/**
 * Verifies payment-term facts while the profile reconciliation case and all member profiles are
 * locked by the enclosing Resolve Action transaction. This intentionally remains an owner routine:
 * reconciliation never receives a customer-payment-term aggregate to merge or transfer.
 */
const verifyPaymentTermsReconciliationOwnerRoutine = defineScopedRoutine({
  name: 'verify_payment_terms_reconciliation_owner',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    ...paymentTermsReconciliationIdentityParameters,
    ...paymentTermsReconciliationEvidenceParameters,
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: PaymentTermsOwnerVerificationRowSchema,
  routineKey: 'payment-terms.reconciliation-owner-verify',
  schema,
});

export const paymentTermsRoutineAllowlist = Object.freeze([
  readPaymentTermsRoutine,
  assessPaymentTermEntitlementUseRoutine,
  persistPaymentTermsRoutine,
  reservePaymentTermRetirementRoutine,
  verifyPaymentTermsReconciliationOwnerRoutine,
]);

export interface PaymentTermDefinitionRequest {
  readonly at: string;
  readonly expectedSemanticRevisionId?: string;
  /** Canonical owner-authored Payment Term resource contract. */
  readonly paymentTermRef: PaymentTermRef;
}

export type PaymentTermCatalogPort = Readonly<{
  readonly resolveDefinitions: (
    requests: readonly PaymentTermDefinitionRequest[],
  ) => Effect.Effect<readonly PaymentTermDefinition[], PaymentTermsDependencyUnavailable>;
}>;

type CustomerCommercePaymentTermsPolicyPort = Readonly<{
  readonly resolve: (
    request: PaymentTermsResolutionRequest,
  ) => Effect.Effect<PaymentTermsPolicyResolution, PaymentTermsDependencyUnavailable>;
}>;

const dependencyUnavailable = (
  dependency: 'CUSTOMER_COMMERCE_POLICY' | 'PAYMENT_TERM_CATALOG',
): PaymentTermsDependencyUnavailable =>
  new PaymentTermsDependencyUnavailable({
    code: 'payment_terms_dependency_unavailable',
    dependency,
    reason: `${dependency === 'PAYMENT_TERM_CATALOG' ? 'Payment Term Catalog' : 'Customer Commerce Policy'} is not configured`,
  });

const unavailablePaymentTermCatalogPort: PaymentTermCatalogPort = Object.freeze({
  resolveDefinitions: () => Effect.fail(dependencyUnavailable('PAYMENT_TERM_CATALOG')),
});

const unavailableCustomerCommercePaymentTermsPolicyPort: CustomerCommercePaymentTermsPolicyPort = Object.freeze({
  resolve: () => Effect.fail(dependencyUnavailable('CUSTOMER_COMMERCE_POLICY')),
});

const profileKind = (profileRef: CustomerPaymentTermsState['profileRef']): 'COUNTERPARTY' | 'RETAIL' =>
  profileRef.resourceType === 'commerce.customer-context.retail-customer-profile' ? 'RETAIL' : 'COUNTERPARTY';

const scopeMatches = (
  scope: OperationalScope & { readonly legalEntityId: string },
  profileRef: CustomerPaymentTermsState['profileRef'],
): boolean => profileRef.tenantId === scope.tenantId && scope.legalEntityId.length > 0;

const operationScopesMatch = (
  expected: OperationalScope & { readonly legalEntityId: string },
  actual: OperationalScope,
): boolean => actual.tenantId === expected.tenantId && actual.legalEntityId === expected.legalEntityId;

const persistenceUnavailable = (failure: ScopedRoutineInvocationError | string): string =>
  Schema.is(Schema.String)(failure)
    ? failure
    : `The scoped Customer Payment Terms routine failed (${failure.routineKey})`;

const paymentTermRetirementReservedReason =
  'The Payment Term is reserved for retirement and must be explicitly migrated first';

const isPaymentTermRetirementReservationFailure = (failure: ScopedRoutineInvocationError | string): boolean =>
  !Schema.is(Schema.String)(failure) &&
  Option.isSome(failure.constraint) &&
  failure.constraint.value === 'payment_term_retirement_reservation';

const decodeState = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the owner routine's external JSONB payload and is decoded immediately below.
  payload: unknown,
  failure: (reason: string) => CustomerPaymentTermsActionRejectedError,
): Effect.Effect<CustomerPaymentTermsState, CustomerPaymentTermsActionRejectedError> =>
  Schema.decodeUnknownEffect(CustomerPaymentTermsStateSchema)(payload).pipe(
    // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Owner-boundary decoder diagnostics are deliberately sanitized.
    Effect.mapError((_decodeFailure) => failure('Customer Payment Terms persistence returned invalid state')),
  );

const ReadStateFailureSchema = Schema.Union([
  Schema.TaggedStruct('PROFILE_COUNTERPARTY_MISMATCH', {}),
  Schema.TaggedStruct('PROFILE_INELIGIBLE', {}),
  Schema.TaggedStruct('PROFILE_NOT_FOUND', {}),
  Schema.TaggedStruct('PERSISTENCE_UNAVAILABLE', { reason: Schema.String }),
]);
type ReadStateFailure = typeof ReadStateFailureSchema.Type;

const readState = (
  invoker: CustomerPaymentTermsScopedRoutineInvoker,
  scope: OperationalScope & { readonly legalEntityId: string },
  profileRef: CustomerPaymentTermsState['profileRef'],
  counterpartyResourceId: string | null,
): Effect.Effect<CustomerPaymentTermsState, ReadStateFailure> => {
  if (!scopeMatches(scope, profileRef)) {
    return Effect.fail({ _tag: 'PROFILE_NOT_FOUND' } as const);
  }
  return Effect.gen(function* readPaymentTermsState() {
    const [row] = yield* invoker
      .invoke(readPaymentTermsRoutine, [profileRef.resourceId, profileKind(profileRef), counterpartyResourceId])
      .pipe(
        Effect.mapError((failure): ReadStateFailure => ({
          _tag: 'PERSISTENCE_UNAVAILABLE',
          reason: persistenceUnavailable(failure),
        })),
      );
    if (row === undefined) {
      return yield* Effect.fail<ReadStateFailure>({
        _tag: 'PERSISTENCE_UNAVAILABLE',
        reason: 'The Customer Payment Terms routine returned no outcome',
      });
    }
    if (
      row.outcome === 'PROFILE_NOT_FOUND' ||
      row.outcome === 'PROFILE_INELIGIBLE' ||
      row.outcome === 'PROFILE_COUNTERPARTY_MISMATCH'
    ) {
      return yield* Effect.fail<ReadStateFailure>({ _tag: row.outcome });
    }
    return yield* Schema.decodeUnknownEffect(CustomerPaymentTermsStateSchema)(row.payload).pipe(
      Effect.mapError(
        // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Owner-boundary decoder diagnostics are deliberately sanitized.
        (_decodeFailure): ReadStateFailure => ({
          _tag: 'PERSISTENCE_UNAVAILABLE',
          reason: 'The Customer Payment Terms routine returned invalid state',
        }),
      ),
    );
  });
};

interface PersistStateInput {
  readonly actionInvocationId: string;
  readonly changed: boolean;
  readonly counterpartyResourceId: string | null;
  readonly expectedRevision: number;
  readonly principalId: string;
  readonly profileKind: 'COUNTERPARTY' | 'RETAIL';
  readonly profileResourceId: string;
  readonly reason: string;
  readonly state: CustomerPaymentTermsState;
}

const persistState = (
  invoker: CustomerPaymentTermsScopedRoutineInvoker,
  input: PersistStateInput,
): Effect.Effect<PaymentTermsRoutineRow, ScopedRoutineInvocationError | string> =>
  invoker
    .invoke(persistPaymentTermsRoutine, [input])
    .pipe(
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail('The Customer Payment Terms persistence routine returned no outcome')
          : Effect.succeed(row),
      ),
    );

const actionFailure = (
  code: ConstructorParameters<typeof CustomerPaymentTermsActionRejected>[0]['code'],
  reason: string,
  retryable = false,
  currentRevision?: number,
): CustomerPaymentTermsActionRejectedError =>
  currentRevision === undefined
    ? new CustomerPaymentTermsActionRejected({ code, reason, retryable })
    : new CustomerPaymentTermsActionRejected({
        code,
        currentRevision,
        reason,
        retryable,
      });

const mapReadFailureToAction = (failure: ReadStateFailure): CustomerPaymentTermsActionRejectedError => {
  switch (failure._tag) {
    case 'PROFILE_NOT_FOUND': {
      return actionFailure('PROFILE_NOT_FOUND', 'The Commerce Customer Profile does not exist');
    }
    case 'PROFILE_INELIGIBLE': {
      return actionFailure('PROFILE_INELIGIBLE', 'The Commerce Customer Profile is not active');
    }
    case 'PROFILE_COUNTERPARTY_MISMATCH': {
      return actionFailure(
        'PROFILE_COUNTERPARTY_MISMATCH',
        'The Commerce Customer Profile does not belong to the authorized Counterparty',
      );
    }
    case 'PERSISTENCE_UNAVAILABLE': {
      return actionFailure('PERSISTENCE_UNAVAILABLE', failure.reason, true);
    }
    default: {
      return failure;
    }
  }
};

const definitionRequestsForChanges = (
  payload: ChangeCustomerPaymentTermsPayload,
): readonly PaymentTermDefinitionRequest[] =>
  payload.changes.flatMap((change) => {
    if (change._tag === 'GRANT_ENTITLEMENT') {
      return [
        {
          at: change.effectiveFrom,
          expectedSemanticRevisionId: change.semanticRevisionId,
          paymentTermRef: change.paymentTermRef,
        },
      ];
    }
    return change._tag === 'SET_PREFERENCE'
      ? [{ at: change.effectiveFrom, paymentTermRef: change.paymentTermRef }]
      : [];
  });

const samePaymentTermRef = (left: PaymentTermReference, right: PaymentTermReference): boolean =>
  left.tenantId === right.tenantId &&
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;

const catalogDefinitionIsCurrentFor = (
  definition: PaymentTermDefinition,
  request: PaymentTermDefinitionRequest,
): boolean =>
  samePaymentTermRef(definition.paymentTermRef, request.paymentTermRef) &&
  definition.lifecycle.effectiveFrom <= request.at &&
  (definition.lifecycle.effectiveTo === null || request.at < definition.lifecycle.effectiveTo) &&
  (request.expectedSemanticRevisionId === undefined ||
    request.expectedSemanticRevisionId === definition.semanticRevisionId);

const catalogResolvedEveryRequest = (
  requests: readonly PaymentTermDefinitionRequest[],
  definitions: readonly PaymentTermDefinition[],
): boolean =>
  requests.every((request) => definitions.some((definition) => catalogDefinitionIsCurrentFor(definition, request)));

type PaymentTermUnusableReason = Extract<
  ReturnType<typeof changeCustomerPaymentTerms>,
  { readonly _tag: 'PAYMENT_TERM_UNUSABLE' }
>['reason'];

const paymentTermUnusableCode = (
  reason: PaymentTermUnusableReason,
): 'PAYMENT_TERM_INCOMPATIBLE' | 'PAYMENT_TERM_NOT_CURRENT' | 'PAYMENT_TERM_NOT_FOUND' => {
  let code: 'PAYMENT_TERM_INCOMPATIBLE' | 'PAYMENT_TERM_NOT_CURRENT' | 'PAYMENT_TERM_NOT_FOUND' =
    'PAYMENT_TERM_INCOMPATIBLE';
  if (reason === 'MISSING_DEFINITION') {
    code = 'PAYMENT_TERM_NOT_FOUND';
  } else if (reason === 'NOT_CURRENT') {
    code = 'PAYMENT_TERM_NOT_CURRENT';
  }
  return code;
};

const mapChangeOutcome = (
  outcome: ReturnType<typeof changeCustomerPaymentTerms>,
): Effect.Effect<
  Extract<ReturnType<typeof changeCustomerPaymentTerms>, { readonly _tag: 'CHANGED' }>,
  CustomerPaymentTermsActionRejectedError
> => {
  switch (outcome._tag) {
    case 'CHANGED': {
      return Effect.succeed(outcome);
    }
    case 'REVISION_CONFLICT': {
      return Effect.fail(
        actionFailure(
          'REVISION_CONFLICT',
          'Customer Payment Terms changed concurrently',
          false,
          outcome.currentRevision,
        ),
      );
    }
    case 'ENTITLEMENT_OVERLAP': {
      return Effect.fail(actionFailure('ENTITLEMENT_OVERLAP', 'Entitlement periods overlap'));
    }
    case 'PREFERENCE_CONFLICT': {
      return Effect.fail(actionFailure('PREFERENCE_CONFLICT', outcome.reason));
    }
    case 'ENTITLEMENT_NOT_FOUND': {
      return Effect.fail(actionFailure('ENTITLEMENT_NOT_FOUND', 'The entitlement does not exist'));
    }
    case 'REMOVAL_CONFLICT': {
      return Effect.fail(actionFailure('REMOVAL_CONFLICT', outcome.reason));
    }
    case 'INVALID_PAYMENT_TERMS_CHANGE': {
      return Effect.fail(actionFailure('PREFERENCE_CONFLICT', outcome.reason));
    }
    case 'PAYMENT_TERM_UNUSABLE': {
      return Effect.fail(
        actionFailure(paymentTermUnusableCode(outcome.reason), `Payment Term is unusable: ${outcome.reason}`),
      );
    }
    default: {
      return outcome;
    }
  }
};

const persistActionResult = (
  invoker: CustomerPaymentTermsScopedRoutineInvoker,
  input: PersistStateInput,
): Effect.Effect<ChangeCustomerPaymentTermsResult, CustomerPaymentTermsActionRejectedError> =>
  persistState(invoker, input).pipe(
    Effect.mapError((failure) =>
      isPaymentTermRetirementReservationFailure(failure)
        ? actionFailure('PAYMENT_TERM_RETIREMENT_RESERVED', paymentTermRetirementReservedReason)
        : actionFailure('PERSISTENCE_UNAVAILABLE', persistenceUnavailable(failure), true),
    ),
    Effect.flatMap((row) => {
      if (row.outcome === 'REVISION_CONFLICT') {
        return Effect.fail(
          actionFailure(
            'REVISION_CONFLICT',
            'Customer Payment Terms changed concurrently',
            false,
            row.current_revision ?? undefined,
          ),
        );
      }
      if (row.outcome === 'PAYMENT_TERM_RETIREMENT_RESERVED') {
        return Effect.fail(actionFailure('PAYMENT_TERM_RETIREMENT_RESERVED', paymentTermRetirementReservedReason));
      }
      if (
        row.outcome === 'PROFILE_NOT_FOUND' ||
        row.outcome === 'PROFILE_INELIGIBLE' ||
        row.outcome === 'PROFILE_COUNTERPARTY_MISMATCH'
      ) {
        return Effect.fail(mapReadFailureToAction({ _tag: row.outcome }));
      }
      return decodeState(row.payload, (reason) => actionFailure('PERSISTENCE_UNAVAILABLE', reason, true)).pipe(
        Effect.map((state) => ({ changed: row.outcome === 'APPLIED', state })),
      );
    }),
  );

const readUnavailable = (reason: string): ReadHandlerUnavailable =>
  new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason });

export interface PaymentTermsPersistenceContext {
  readonly invoker: CustomerPaymentTermsScopedRoutineInvoker;
  readonly scope: OperationalScope & { readonly legalEntityId: string };
}

interface PaymentTermAffectedUseAssessmentInput {
  readonly at: string;
  readonly paymentTermRefs: readonly PaymentTermRef[];
}

const PaymentTermAffectedUseAssessmentResultSchema = Schema.Struct({
  currentCustomerEntitlementCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  evidenceReference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  observedAt: PaymentTermsTimestampSchema,
});
type PaymentTermAffectedUseAssessmentResult = typeof PaymentTermAffectedUseAssessmentResultSchema.Type;

export type PaymentTermAffectedUseAssessmentServices = Readonly<{
  readonly assess: (
    input: PaymentTermAffectedUseAssessmentInput,
  ) => Effect.Effect<PaymentTermAffectedUseAssessmentResult, ReadHandlerUnavailable>;
}>;

class PaymentTermRetirementReservationConflict extends Schema.TaggedError<PaymentTermRetirementReservationConflict>()(
  'PaymentTermRetirementReservationConflict',
  {
    reason: Schema.String,
  },
) {}

class PaymentTermRetirementReservationInvalidRequest extends Schema.TaggedError<PaymentTermRetirementReservationInvalidRequest>()(
  'PaymentTermRetirementReservationInvalidRequest',
  {
    reason: Schema.String,
  },
) {}

class PaymentTermRetirementReservationNotFound extends Schema.TaggedError<PaymentTermRetirementReservationNotFound>()(
  'PaymentTermRetirementReservationNotFound',
  {
    reason: Schema.String,
  },
) {}

class PaymentTermRetirementReservationUnavailable extends Schema.TaggedError<PaymentTermRetirementReservationUnavailable>()(
  'PaymentTermRetirementReservationUnavailable',
  {
    reason: Schema.String,
  },
) {}

export type PaymentTermRetirementReservationFailure =
  | PaymentTermRetirementReservationConflict
  | PaymentTermRetirementReservationInvalidRequest
  | PaymentTermRetirementReservationNotFound
  | PaymentTermRetirementReservationUnavailable;

export type PaymentTermRetirementReservationServices = Readonly<{
  readonly execute: (
    payload: ReservePaymentTermRetirementPayload,
    attribution: Readonly<{
      readonly actionInvocationId: string;
      readonly actorPrincipalId: string;
      readonly tenantId: string;
    }>,
  ) => Effect.Effect<ReservePaymentTermRetirementResult, PaymentTermRetirementReservationFailure>;
}>;

const normalizedTimestamp = (value: Date | string): string =>
  Schema.is(Schema.Date)(value) ? value.toISOString() : value;

export const makePaymentTermAffectedUseAssessmentServices = (
  persistence: PaymentTermsPersistenceContext,
): PaymentTermAffectedUseAssessmentServices => ({
  assess: (input) => {
    if (
      input.paymentTermRefs.length === 0 ||
      input.paymentTermRefs.length > 200 ||
      input.paymentTermRefs.some(({ tenantId }) => tenantId !== persistence.scope.tenantId)
    ) {
      return Effect.fail(
        readUnavailable(
          'The Payment Term equivalence set is empty, too large, or outside the scoped affected-use assessment capability',
        ),
      );
    }
    const paymentTermResourceIds = [...new Set(input.paymentTermRefs.map(({ resourceId }) => resourceId))];
    return persistence.invoker.invoke(assessPaymentTermEntitlementUseRoutine, [paymentTermResourceIds, input.at]).pipe(
      Effect.mapError((failure) => failure.pipe(persistenceUnavailable, readUnavailable)),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(readUnavailable('The Payment Term affected-use routine returned no outcome'))
          : Effect.succeed({
              currentCustomerEntitlementCount: row.current_customer_entitlement_count,
              evidenceReference: row.evidence_reference,
              observedAt: normalizedTimestamp(row.observed_at),
            }),
      ),
    );
  },
});

const paymentTermRetirementReservationFailure = (
  _tag: 'CONFLICT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE',
  reason: string,
  cause?: unknown,
): PaymentTermRetirementReservationFailure => {
  const failure = (() => {
    switch (_tag) {
      case 'CONFLICT': {
        return new PaymentTermRetirementReservationConflict({ reason });
      }
      case 'INVALID_REQUEST': {
        return new PaymentTermRetirementReservationInvalidRequest({ reason });
      }
      case 'NOT_FOUND': {
        return new PaymentTermRetirementReservationNotFound({ reason });
      }
      case 'UNAVAILABLE': {
        return new PaymentTermRetirementReservationUnavailable({ reason });
      }
      default: {
        return new PaymentTermRetirementReservationUnavailable({ reason });
      }
    }
  })();
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { enumerable: false, value: cause });
};

const invalidPaymentTermRetirementState = (cause: unknown): PaymentTermRetirementReservationFailure =>
  paymentTermRetirementReservationFailure(
    'UNAVAILABLE',
    'The Payment Term retirement reservation returned invalid state',
    cause,
  );

const decodePaymentTermRetirementReservationResult = (
  result: typeof PaymentTermRetirementReservationPayloadSchema.Type,
) =>
  Schema.decodeEffect(ReservePaymentTermRetirementResultSchema)({
    effectiveAt: result.effectiveAt,
    lifecycle: result.lifecycle,
    paymentTermResourceIds: result.paymentTermResourceIds,
    reservationRef: result.reservationRef,
  }).pipe(Effect.mapError(invalidPaymentTermRetirementState));

/**
 * Stages Payment Term retirement in Customer Context.  The routine owns the reservation row and
 * locks one advisory key per canonical/alias resource id, so an entitlement grant cannot pass the
 * reservation barrier concurrently.  COMMIT is called only after the Payment catalog retirement
 * succeeds; RELEASE is safe for the compensating path.
 */
const makePaymentTermRetirementReservationServices = (
  persistence: PaymentTermsPersistenceContext,
): PaymentTermRetirementReservationServices => ({
  execute: (payload, attribution) => {
    const refs = [payload.paymentTermRef, ...payload.equivalentPaymentTermRefs];
    const sameOwner = refs.every(
      (ref) =>
        ref.tenantId === persistence.scope.tenantId &&
        ref.tenantId === attribution.tenantId &&
        ref.moduleId === 'payment.term-catalog' &&
        ref.resourceType === 'payment.term-catalog.payment-term',
    );
    if (!sameOwner || attribution.tenantId !== persistence.scope.tenantId) {
      return Effect.fail(
        paymentTermRetirementReservationFailure(
          'INVALID_REQUEST',
          'The Payment Term retirement reservation is outside the trusted scope',
        ),
      );
    }
    if (
      (payload.operation === 'RESERVE' && payload.reservationRef !== undefined) ||
      (payload.operation !== 'RESERVE' && payload.reservationRef === undefined)
    ) {
      return Effect.fail(
        paymentTermRetirementReservationFailure(
          'INVALID_REQUEST',
          'The reservation reference is valid only for COMMIT or RELEASE',
        ),
      );
    }
    const paymentTermResourceIds = [...new Set(refs.map((ref) => ref.resourceId))].toSorted((left, right) =>
      left.localeCompare(right),
    );
    return persistence.invoker
      .invoke(reservePaymentTermRetirementRoutine, [
        {
          actionInvocationId: attribution.actionInvocationId,
          actorPrincipalId: attribution.actorPrincipalId,
          effectiveAt: payload.effectiveAt,
          operation: payload.operation,
          paymentTermResourceIds,
          reason: payload.reason,
          reservationRef: payload.reservationRef ?? null,
        },
      ])
      .pipe(
        Effect.mapError((failure) =>
          paymentTermRetirementReservationFailure('UNAVAILABLE', persistenceUnavailable(failure)),
        ),
        Effect.flatMap(([row]) => {
          if (row === undefined) {
            return Effect.fail(
              paymentTermRetirementReservationFailure(
                'UNAVAILABLE',
                'The Payment Term retirement reservation routine returned no outcome',
              ),
            );
          }
          if (row.outcome === 'CONFLICT') {
            return Effect.fail(
              paymentTermRetirementReservationFailure(
                'CONFLICT',
                'The Payment Term or one of its aliases is already reserved for retirement',
              ),
            );
          }
          if (row.outcome === 'NOT_FOUND') {
            return Effect.fail(
              paymentTermRetirementReservationFailure(
                'NOT_FOUND',
                'The Payment Term retirement reservation does not exist',
              ),
            );
          }
          if (row.outcome === 'INVALID_REQUEST' || row.payload === null) {
            return Effect.fail(
              paymentTermRetirementReservationFailure(
                'INVALID_REQUEST',
                'The Payment Term retirement reservation request was rejected',
              ),
            );
          }
          return Schema.decodeEffect(PaymentTermRetirementReservationPayloadSchema)(row.payload).pipe(
            Effect.mapError(invalidPaymentTermRetirementState),
            Effect.flatMap(decodePaymentTermRetirementReservationResult),
          );
        }),
      );
  },
});

const paymentTermsReconciliationPolicyVersion = 'customer-payment-terms-reconciliation.v1';

/**
 * Builds the PAYMENT_TERMS owner verifier from the same scoped routine capability used by the
 * entitlement Actions. The caller's desired evidence is deliberately not forwarded: the routine
 * derives its receipt from locked durable entitlements/preferences and the locked reconciliation
 * case, so a caller cannot fabricate proof or silently transfer facts between profiles.
 */
export const verifyPaymentTermsReconciliationOwner = (
  transaction: CustomerPaymentTermsScopedRoutineInvoker,
  input: {
    readonly actionInvocationId: string;
    readonly principalId: string;
    readonly request: ProfileReconciliationOwnerVerificationRequest;
  },
) =>
  transaction
    .invoke(verifyPaymentTermsReconciliationOwnerRoutine, [
      input.request.caseRef.resourceId,
      input.request.desiredOutcome.owner,
      input.request.survivorProfileRef.resourceId,
      input.request.resultingState,
      input.request.desiredOutcome.status,
      input.request.expectedCaseRevision,
      input.request.expectedEventVersion,
      input.request.effectiveAt,
      input.request.reason,
      input.actionInvocationId,
      input.principalId,
      paymentTermsReconciliationPolicyVersion,
    ])
    .pipe(
      Effect.mapError((cause) => {
        const failure = new ProfileReconciliationOwnerVerificationFailure({
          code: 'OWNER_UNAVAILABLE',
          owner: 'PAYMENT_TERMS',
          reason: 'Customer Payment Terms reconciliation evidence is temporarily unavailable',
          retryable: true,
        });
        Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
        return failure;
      }),
      Effect.map(([row]): ProfileReconciliationOwnerVerification => {
        if (
          row?.outcome === 'VERIFIED' &&
          row.payload !== null &&
          Schema.is(PaymentTermsOwnerVerificationPayloadSchema)(row.payload)
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
              owner: 'PAYMENT_TERMS',
              reason: 'Customer Payment Terms entitlements or preferences conflict with the requested reconciliation',
            }
          : {
              _tag: 'UNAVAILABLE',
              owner: 'PAYMENT_TERMS',
              reason: 'Customer Payment Terms reconciliation evidence is unavailable for this case',
            };
      }),
    );

export const paymentTermsReconciliationOwnerEvidenceVerifierForTransaction = (
  transaction: CustomerPaymentTermsScopedRoutineInvoker,
): ProfileReconciliationOwnerEvidenceVerifier => ({
  owner: 'PAYMENT_TERMS',
  verify: (request, context) =>
    verifyPaymentTermsReconciliationOwner(transaction, {
      actionInvocationId: context.actionInvocationId,
      principalId: context.actorPrincipalId,
      request,
    }),
});

export const makeChangeCustomerPaymentTermsServices = (
  persistence: PaymentTermsPersistenceContext,
  catalog: PaymentTermCatalogPort = unavailablePaymentTermCatalogPort,
): ChangeCustomerPaymentTermsServices => ({
  change: Effect.fn('CustomerPaymentTermsPersistence.change')(function* changePaymentTerms(payload, context) {
    if (!operationScopesMatch(persistence.scope, context.scope)) {
      return yield* actionFailure(
        'SCOPE_MISMATCH',
        'The Action scope does not match the scoped Payment Terms persistence capability',
      );
    }
    const state = yield* readState(
      persistence.invoker,
      persistence.scope,
      payload.profileRef,
      payload.counterpartyRef.resourceId,
    ).pipe(Effect.mapError(mapReadFailureToAction));
    const definitionRequests = definitionRequestsForChanges(payload);
    const definitions =
      definitionRequests.length === 0
        ? []
        : yield* catalog
            .resolveDefinitions(definitionRequests)
            .pipe(Effect.mapError((failure) => actionFailure('DEPENDENCY_UNAVAILABLE', failure.reason, true)));
    if (!catalogResolvedEveryRequest(definitionRequests, definitions)) {
      return yield* actionFailure(
        'PAYMENT_TERM_NOT_CURRENT',
        'The requested Payment Term is not current in the canonical catalog',
      );
    }
    const outcome = yield* mapChangeOutcome(
      changeCustomerPaymentTerms({
        catalogDefinitions: definitions,
        changes: payload.changes,
        expectedRevision: payload.expectedRevision,
        state,
      }),
    );
    return yield* persistActionResult(persistence.invoker, {
      actionInvocationId: context.actionInvocationId,
      changed: outcome.changed,
      counterpartyResourceId: payload.counterpartyRef.resourceId,
      expectedRevision: payload.expectedRevision,
      principalId: context.scope.principalId,
      profileKind: 'COUNTERPARTY',
      profileResourceId: payload.profileRef.resourceId,
      reason: payload.reason,
      state: outcome.state,
    });
  }),
});

const makeRemoveCustomerPaymentTermServices = (
  persistence: PaymentTermsPersistenceContext,
): RemoveCustomerPaymentTermServices => ({
  remove: Effect.fn('CustomerPaymentTermsPersistence.remove')(function* removePaymentTerm(payload, context) {
    if (!operationScopesMatch(persistence.scope, context.scope)) {
      return yield* actionFailure(
        'SCOPE_MISMATCH',
        'The Action scope does not match the scoped Payment Terms persistence capability',
      );
    }
    const state = yield* readState(
      persistence.invoker,
      persistence.scope,
      payload.profileRef,
      payload.counterpartyRef.resourceId,
    ).pipe(Effect.mapError(mapReadFailureToAction));
    const outcome = removeCustomerPaymentTerm({
      effectiveAt: payload.effectiveAt,
      entitlementRef: payload.entitlementRef,
      expectedRevision: payload.expectedRevision,
      state,
    });
    if (outcome._tag !== 'REMOVED') {
      const mapped = yield* mapChangeOutcome(outcome);
      return yield* actionFailure(
        'OUTCOME_INDETERMINATE',
        `Removal resolved to an unexpected ${mapped._tag} outcome`,
        false,
      );
    }
    const persisted = yield* persistActionResult(persistence.invoker, {
      actionInvocationId: context.actionInvocationId,
      changed: outcome.changed,
      counterpartyResourceId: payload.counterpartyRef.resourceId,
      expectedRevision: payload.expectedRevision,
      principalId: context.scope.principalId,
      profileKind: 'COUNTERPARTY',
      profileResourceId: payload.profileRef.resourceId,
      reason: payload.reason,
      state: outcome.state,
    });
    return {
      changed: persisted.changed,
      preferenceCleared: outcome.preferenceCleared,
      removalKind: outcome.removalKind,
      state: persisted.state,
    } satisfies RemoveCustomerPaymentTermResult;
  }),
});

const retailFailure = (
  code: ConstructorParameters<typeof RetailPaymentTermPreferenceRejected>[0]['code'],
  reason: string,
  retryable = false,
  currentRevision?: number,
): RetailPaymentTermPreferenceRejectedError =>
  currentRevision === undefined
    ? new RetailPaymentTermPreferenceRejected({ code, reason, retryable })
    : new RetailPaymentTermPreferenceRejected({
        code,
        currentRevision,
        reason,
        retryable,
      });

const mapRetailReadStateFailure = (failure: ReadStateFailure): RetailPaymentTermPreferenceRejectedError => {
  switch (failure._tag) {
    case 'PROFILE_NOT_FOUND': {
      return retailFailure('PROFILE_NOT_FOUND', 'The Retail Customer Profile is missing');
    }
    case 'PROFILE_INELIGIBLE': {
      return retailFailure('PROFILE_INELIGIBLE', 'The Retail Customer Profile is not active');
    }
    case 'PROFILE_COUNTERPARTY_MISMATCH': {
      return retailFailure('SCOPE_MISMATCH', 'The Retail Customer Profile kind is invalid');
    }
    case 'PERSISTENCE_UNAVAILABLE': {
      return retailFailure('PERSISTENCE_UNAVAILABLE', failure.reason, true);
    }
    default: {
      return failure;
    }
  }
};

const retailDefinitionRequests = (
  change: RetailPaymentTermPreferenceChange,
): readonly PaymentTermDefinitionRequest[] =>
  change._tag === 'SET_PREFERENCE'
    ? [
        {
          at: change.effectiveFrom,
          paymentTermRef: change.paymentTermRef,
        },
      ]
    : [];

const mapRetailChangeOutcome = (
  outcome: ReturnType<typeof changeCustomerPaymentTerms>,
): Effect.Effect<
  Extract<ReturnType<typeof changeCustomerPaymentTerms>, { readonly _tag: 'CHANGED' }>,
  RetailPaymentTermPreferenceRejectedError
> => {
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- The existing default intentionally groups every non-preference payment-term failure into the owner-defined not-entitled outcome.
  switch (outcome._tag) {
    case 'CHANGED': {
      return Effect.succeed(outcome);
    }
    case 'REVISION_CONFLICT': {
      return Effect.fail(
        retailFailure(
          'REVISION_CONFLICT',
          'Retail Payment Term Preference changed concurrently',
          false,
          outcome.currentRevision,
        ),
      );
    }
    case 'PREFERENCE_CONFLICT': {
      return Effect.fail(retailFailure('PREFERENCE_CONFLICT', outcome.reason));
    }
    default: {
      return Effect.fail(
        retailFailure('PAYMENT_TERM_NOT_ENTITLED', 'The selected Payment Term is not a current entitlement'),
      );
    }
  }
};

const validateRetailPreferenceScope = (
  scope: PaymentTermsPersistenceContext['scope'],
  attribution: Parameters<RetailPaymentTermPreferenceActionServices['changePreference']>[1],
): Effect.Effect<void, RetailPaymentTermPreferenceRejectedError> => {
  if (attribution.tenantId !== scope.tenantId || attribution.legalEntityId !== scope.legalEntityId) {
    return Effect.fail(
      retailFailure(
        'SCOPE_MISMATCH',
        'The Action attribution does not match the scoped Payment Terms persistence capability',
      ),
    );
  }
  return Effect.void;
};

const makeRetailPaymentTermPreferenceServices = (
  persistence: PaymentTermsPersistenceContext,
  catalog: PaymentTermCatalogPort = unavailablePaymentTermCatalogPort,
): RetailPaymentTermPreferenceActionServices => ({
  changePreference: Effect.fn('CustomerPaymentTermsPersistence.changeRetailPreference')(
    function* changeRetailPreference(payload, attribution) {
      yield* validateRetailPreferenceScope(persistence.scope, attribution);
      const state = yield* readState(persistence.invoker, persistence.scope, payload.profileRef, null).pipe(
        Effect.mapError(mapRetailReadStateFailure),
      );
      const requests = retailDefinitionRequests(payload.change);
      const definitions =
        requests.length === 0
          ? []
          : yield* catalog
              .resolveDefinitions(requests)
              .pipe(Effect.mapError((failure) => retailFailure('PERSISTENCE_UNAVAILABLE', failure.reason, true)));
      if (!catalogResolvedEveryRequest(requests, definitions)) {
        return yield* retailFailure(
          'PAYMENT_TERM_NOT_CURRENT',
          'The selected Payment Term is not currently available from its owner',
        );
      }
      const outcome = yield* mapRetailChangeOutcome(
        changeCustomerPaymentTerms({
          catalogDefinitions: definitions,
          changes: [payload.change],
          expectedRevision: payload.expectedRevision,
          state,
        }),
      );
      const persisted = yield* persistState(persistence.invoker, {
        actionInvocationId: attribution.actionInvocationId,
        changed: outcome.changed,
        counterpartyResourceId: null,
        expectedRevision: payload.expectedRevision,
        principalId: attribution.principalId,
        profileKind: 'RETAIL',
        profileResourceId: payload.profileRef.resourceId,
        reason: 'Retail customer preference change',
        state: outcome.state,
      }).pipe(
        Effect.mapError((failure) =>
          isPaymentTermRetirementReservationFailure(failure)
            ? retailFailure('PAYMENT_TERM_RETIREMENT_RESERVED', paymentTermRetirementReservedReason)
            : retailFailure('PERSISTENCE_UNAVAILABLE', persistenceUnavailable(failure), true),
        ),
      );
      if (persisted.outcome === 'REVISION_CONFLICT') {
        return yield* retailFailure(
          'REVISION_CONFLICT',
          'Retail Payment Term Preference changed concurrently',
          false,
          persisted.current_revision ?? undefined,
        );
      }
      if (persisted.outcome === 'PAYMENT_TERM_RETIREMENT_RESERVED') {
        return yield* retailFailure('PAYMENT_TERM_RETIREMENT_RESERVED', paymentTermRetirementReservedReason);
      }
      if (persisted.outcome !== 'APPLIED' && persisted.outcome !== 'UNCHANGED') {
        return yield* retailFailure(
          persisted.outcome === 'PROFILE_INELIGIBLE' ? 'PROFILE_INELIGIBLE' : 'PROFILE_NOT_FOUND',
          'The Retail Customer Profile is unavailable',
        );
      }
      const persistedState = yield* Schema.decodeUnknownEffect(CustomerPaymentTermsStateSchema)(persisted.payload).pipe(
        // oxlint-disable-next-line effect-native/no-failure-discarding-error-callback -- Owner-boundary decoder diagnostics are deliberately sanitized.
        Effect.mapError((_decodeFailure) =>
          retailFailure('PERSISTENCE_UNAVAILABLE', 'Customer Payment Terms persistence returned invalid state', true),
        ),
      );
      return {
        changed: persisted.outcome === 'APPLIED',
        state: persistedState,
      } satisfies ChangeRetailPaymentTermPreferenceResult;
    },
  ),
});

export const makeCustomerPaymentTermEntitlementReadServices = (
  persistence: PaymentTermsPersistenceContext,
): CustomerPaymentTermEntitlementReadServices => ({
  read: (input) => {
    if (
      input.authorizationSubject.kind === 'COUNTERPARTY' &&
      input.authorizationSubject.counterpartyRef.tenantId !== persistence.scope.tenantId
    ) {
      return Effect.fail(readUnavailable('The authorization subject is outside the scoped Payment Terms capability'));
    }
    return readState(
      persistence.invoker,
      persistence.scope,
      input.profileRef,
      input.authorizationSubject.kind === 'COUNTERPARTY' ? input.authorizationSubject.counterpartyRef.resourceId : null,
    ).pipe(
      Effect.map((state) => ({
        _tag: 'CUSTOMER_PAYMENT_TERMS' as const,
        ...projectCustomerPaymentTermsAt(state, input.asOf, input.includeHistorical),
      })),
      /* oxlint-disable sonarjs/function-name -- Effect.catchTags keys intentionally match the schema-owned failure tags; expires: 2027-03-31. */
      Effect.catchTags({
        PERSISTENCE_UNAVAILABLE: ({ reason }) => Effect.fail(readUnavailable(reason)),
        PROFILE_COUNTERPARTY_MISMATCH: () =>
          Effect.succeed({
            _tag: 'BROKEN_CONFIGURATION' as const,
            profileRef: input.profileRef,
            reason: 'The profile is not associated with the requested Counterparty',
          }),
        PROFILE_INELIGIBLE: () =>
          Effect.succeed({
            _tag: 'BROKEN_CONFIGURATION' as const,
            profileRef: input.profileRef,
            reason: 'The Commerce Customer Profile is not active',
          }),
        PROFILE_NOT_FOUND: () =>
          Effect.succeed({
            _tag: 'PROFILE_NOT_FOUND' as const,
            profileRef: input.profileRef,
          }),
      }),
      /* oxlint-enable sonarjs/function-name */
    );
  },
});

const definitionRequestsForResolution = (
  entitlements: CustomerPaymentTermsState['entitlements'],
  policyResolution: Exclude<PaymentTermsPolicyResolution, { readonly _tag: string }>,
  explicitChoice: PaymentTermsResolutionRequest['explicitChoice'],
  at: PaymentTermsResolutionRequest['at'],
): readonly PaymentTermDefinitionRequest[] => {
  const candidateRefs = [
    ...entitlements.map(({ paymentTermRef }) => paymentTermRef),
    ...policyResolution.eligiblePaymentTermRefs,
    ...policyResolution.explicitlyPermittedPaymentTermRefs,
    ...policyResolution.fallbackPaymentTermRefs,
    ...(explicitChoice === undefined ? [] : [explicitChoice]),
  ];
  const definitionRequests = new Map<string, PaymentTermDefinitionRequest>();
  for (const entitlement of entitlements) {
    definitionRequests.set(
      `${entitlement.paymentTermRef.tenantId}:${entitlement.paymentTermRef.moduleId}:${entitlement.paymentTermRef.resourceType}:${entitlement.paymentTermRef.resourceId}`,
      {
        at,
        expectedSemanticRevisionId: entitlement.semanticRevisionId,
        paymentTermRef: entitlement.paymentTermRef,
      },
    );
  }
  for (const paymentTermRef of candidateRefs) {
    const key = `${paymentTermRef.tenantId}:${paymentTermRef.moduleId}:${paymentTermRef.resourceType}:${paymentTermRef.resourceId}`;
    if (!definitionRequests.has(key)) {
      definitionRequests.set(key, { at, paymentTermRef });
    }
  }
  return [...definitionRequests.values()];
};

export const makePaymentTermsResolutionServices = (
  persistence: PaymentTermsPersistenceContext,
  ports: CustomerPaymentTermsPersistencePorts = {},
): PaymentTermsResolutionServices => ({
  resolve: Effect.fn('CustomerPaymentTermsPersistence.resolve')(function* resolveCurrentPaymentTerms(input) {
    if (input.purchasingContext.sellingLegalEntityId !== persistence.scope.legalEntityId) {
      return yield* readUnavailable('The purchasing context is outside the scoped Payment Terms capability');
    }
    const catalog = ports.catalog ?? unavailablePaymentTermCatalogPort;
    const policy = ports.policy ?? unavailableCustomerCommercePaymentTermsPolicyPort;
    const state = yield* readState(
      persistence.invoker,
      persistence.scope,
      input.profileRef,
      input.authorizationSubject.kind === 'COUNTERPARTY' ? input.authorizationSubject.counterpartyRef.resourceId : null,
    ).pipe(
      Effect.mapError((failure) =>
        readUnavailable(
          failure._tag === 'PERSISTENCE_UNAVAILABLE'
            ? failure.reason
            : 'The Commerce Customer Profile is unavailable for Payment Terms resolution',
        ),
      ),
    );
    // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- The scope-verified owner read intentionally gates any external policy call for nonexistent or mismatched profiles.
    const policyResolution = yield* policy
      .resolve(input)
      .pipe(Effect.mapError((failure) => readUnavailable(failure.reason)));
    if ('_tag' in policyResolution) {
      return policyResolution;
    }
    const definitionRequests = definitionRequestsForResolution(
      state.entitlements,
      policyResolution,
      input.explicitChoice,
      input.at,
    );
    const definitions = yield* catalog
      .resolveDefinitions(definitionRequests)
      .pipe(Effect.mapError((failure) => readUnavailable(failure.reason)));
    const commonResolutionInput = {
      at: input.at,
      definitions,
      eligiblePaymentTermRefs: policyResolution.eligiblePaymentTermRefs,
      policyExplicitlyPermittedRefs: policyResolution.explicitlyPermittedPaymentTermRefs,
      policyFallbackRefs: policyResolution.fallbackPaymentTermRefs,
      policyRevision: policyResolution.policyRevision,
      policySource: policyResolution.policySource,
      purchasingContextRevision: input.purchasingContext.contextRevision,
      state,
    };
    return input.explicitChoice === undefined
      ? resolvePaymentTerms(commonResolutionInput)
      : resolvePaymentTerms({
          ...commonResolutionInput,
          explicitChoice: input.explicitChoice,
        });
  }),
});

export interface CustomerPaymentTermsPersistencePorts {
  readonly catalog?: PaymentTermCatalogPort;
  readonly policy?: CustomerCommercePaymentTermsPolicyPort;
}

export const paymentTermsPersistenceForTransaction = (
  persistence: PaymentTermsPersistenceContext,
  ports: CustomerPaymentTermsPersistencePorts = {},
) => ({
  affectedUseAssessment: makePaymentTermAffectedUseAssessmentServices(persistence),
  change: makeChangeCustomerPaymentTermsServices(persistence, ports.catalog ?? unavailablePaymentTermCatalogPort),
  entitlementRead: makeCustomerPaymentTermEntitlementReadServices(persistence),
  remove: makeRemoveCustomerPaymentTermServices(persistence),
  resolution: makePaymentTermsResolutionServices(persistence, ports),
  retailPreference: makeRetailPaymentTermPreferenceServices(
    persistence,
    ports.catalog ?? unavailablePaymentTermCatalogPort,
  ),
  retirementReservation: makePaymentTermRetirementReservationServices(persistence),
});
