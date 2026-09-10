import { defineScopedRoutine } from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineInvocationError,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { DateTime, Effect, Layer, Match, Option, Schema } from 'effect';

import { PurchaseApprovalTriggerEvidenceSourceFactory } from '../actions/trigger-purchase-approval.action.ts';
import type {
  PurchaseApprovalTriggerCurrentEvidence,
  PurchaseApprovalTriggerEvidenceSource,
  PurchaseApprovalTriggerEvidenceSourceFactoryContract,
} from '../actions/trigger-purchase-approval.action.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../profile-counterparty-role-eligibility.ts';
import { profilePersistenceServicesForTransaction } from './profile-persistence.ts';
import type { ProfilePersistenceDependencies } from './profile-persistence.ts';
import {
  PurchaseApprovalDependencyUnavailableSchema,
  PurchaseApprovalProfileEvidenceSchema,
  PurchaseApprovalProposalEvidenceSchema,
} from '../../shared/domain/purchase-limit-approval-trigger.ts';
import type { PurchaseApprovalDependencyUnavailable } from '../../shared/domain/purchase-limit-approval-trigger.ts';
import {
  PurchaseLimitDependencyUnavailableSchema,
  PurchaseLimitPolicyConflictSchema,
  PurchaseLimitPolicyServiceFactory,
  PurchaseLimitPolicySnapshotSchema,
  PurchaseLimitSubjectScopeMismatchSchema,
  resolveEffectivePurchaseLimitPolicy,
} from '../../shared/domain/purchase-limit-policy.ts';
import type {
  ChangeCounterpartyPurchaseLimitInput,
  ChangePrincipalPurchaseLimitOverrideInput,
  EffectivePurchaseLimitPolicyResult,
  PurchaseLimitDependencyUnavailable,
  PurchaseLimitPolicyConflict,
  PurchaseLimitPolicyMutationResult,
  PurchaseLimitPolicyService,
  PurchaseLimitPolicyServiceFactoryContract,
  PurchaseLimitPolicySnapshot,
  PurchaseLimitPolicySubject,
  PurchaseLimitSubjectScopeMismatch,
} from '../../shared/domain/purchase-limit-policy.ts';
import {
  PurchaseLimitComparableValueSchema,
  PurchaseLimitEvaluationSourceFactory,
  PurchaseLimitSellingLegalEntityIdSchema,
  PurchaseLimitSourceRevisionVectorSchema,
  PurchaseLimitStorefrontIdSchema,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import type {
  PurchaseLimitEvaluationInput,
  PurchaseLimitEvaluationSourceFactoryContract,
  PurchaseLimitEvaluationSourceService,
  PurchaseLimitSourceRevisionVector,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import {
  PurchaseLimitEvaluationCurrentFactsSchema,
  PurchaseLimitEvaluationCurrentnessPort,
} from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import type {
  PurchaseLimitEvaluationCurrentFacts,
  PurchaseLimitEvaluationCurrentnessPortService,
} from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseLimitFxUnavailableSchema } from '../../shared/domain/purchase-limit-fx-port.ts';
import type {
  PurchaseLimitFxPort,
  PurchaseLimitFxUnavailable,
} from '../../shared/domain/purchase-limit-fx-port.ts';
import type { PurchaseValue } from '../../shared/domain/purchase-limit.ts';

const MODULE_KEY = 'commerce.customer-context';
const POLICY_DEPENDENCY = 'commerce.customer-context.purchase-limit-policy';
const COUNTERPARTY_POLICY_SOURCE = 'counterparty-policy';
const PRINCIPAL_OVERRIDE_SOURCE = 'principal-override';
const PURCHASE_PROPOSAL_SOURCE = 'purchase-proposal';
const PURCHASING_PROFILE_SOURCE = 'purchasing-profile';
const PersistedPolicyKindSchema = Schema.Literals(['MONETARY_LIMIT', 'UNLIMITED']);

const PurchaseLimitPolicyRowSchema = Schema.Struct({
  amount: Schema.OptionFromNullOr(Schema.String),
  currency_code: Schema.OptionFromNullOr(Schema.String),
  outcome: Schema.Literals(['PRESENT', 'PROFILE_NOT_FOUND']),
  policy_id: Schema.OptionFromNullOr(Schema.String),
  policy_kind: Schema.OptionFromNullOr(Schema.Literals(['CLEARED', 'MONETARY_LIMIT', 'UNLIMITED'])),
  recorded_at: Schema.OptionFromNullOr(Schema.Union([Schema.Date, Schema.String])),
  revision: Schema.OptionFromNullOr(Schema.Int),
  source: Schema.OptionFromNullOr(Schema.Literals(['COUNTERPARTY_DEFAULT', 'PRINCIPAL_OVERRIDE'])),
  source_revision: Schema.OptionFromNullOr(Schema.String),
});
type PurchaseLimitPolicyRow = typeof PurchaseLimitPolicyRowSchema.Type;

const PurchaseLimitMutationRowSchema = Schema.Struct({
  current_amount: Schema.OptionFromNullOr(Schema.String),
  current_currency_code: Schema.OptionFromNullOr(Schema.String),
  current_policy_id: Schema.OptionFromNullOr(Schema.String),
  current_policy_kind: Schema.OptionFromNullOr(PersistedPolicyKindSchema),
  current_recorded_at: Schema.OptionFromNullOr(Schema.Union([Schema.Date, Schema.String])),
  current_revision: Schema.OptionFromNullOr(Schema.Int),
  outcome: Schema.Literals(['APPLIED', 'PROFILE_NOT_FOUND', 'REVISION_CONFLICT', 'UNCHANGED']),
  previous_amount: Schema.OptionFromNullOr(Schema.String),
  previous_currency_code: Schema.OptionFromNullOr(Schema.String),
  previous_policy_id: Schema.OptionFromNullOr(Schema.String),
  previous_policy_kind: Schema.OptionFromNullOr(PersistedPolicyKindSchema),
  previous_recorded_at: Schema.OptionFromNullOr(Schema.Union([Schema.Date, Schema.String])),
  previous_revision: Schema.OptionFromNullOr(Schema.Int),
});
type PurchaseLimitMutationRow = typeof PurchaseLimitMutationRowSchema.Type;

const readPurchaseLimitPoliciesRoutine = defineScopedRoutine({
  name: 'read_purchase_limit_policies',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: PurchaseLimitPolicyRowSchema,
  routineKey: 'purchase-limit.read-current-policies',
  schema: 'commerce_customer_context',
});

const changePurchaseLimitPolicyRoutine = defineScopedRoutine({
  name: 'change_purchase_limit_policy',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'numeric' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: PurchaseLimitMutationRowSchema,
  routineKey: 'purchase-limit.change-policy',
  schema: 'commerce_customer_context',
});

const PurchaseProposalCurrentnessRowSchema = Schema.Struct({ result: Schema.Json });
export const readCurrentPurchaseProposalRoutine = defineScopedRoutine({
  name: 'read_current_purchase_proposal_revision',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PurchaseProposalCurrentnessRowSchema,
  routineKey: 'purchase-approval.read-current-proposal',
  schema: 'commerce_customer_context',
});

const dependencyUnavailable = (
  dependency: string,
  failure?: ScopedRoutineInvocationError,
): PurchaseLimitDependencyUnavailable =>
  PurchaseLimitDependencyUnavailableSchema.make({
    code: 'purchase_limit_dependency_unavailable',
    dependency,
    reason:
      failure === undefined
        ? `${dependency} is not configured for production Currentness validation`
        : `The scoped Purchase Limit routine failed (${failure.routineKey})`,
  });

const subjectScopeMismatch = (reason: string) =>
  PurchaseLimitSubjectScopeMismatchSchema.make({
    code: 'purchase_limit_subject_scope_mismatch',
    reason,
  });

const timestamp = (value: Date | string): string =>
  Schema.is(Schema.Date)(value) ? value.toISOString() : value;

/** PostgreSQL numeric preserves scale; the public exact-decimal value uses canonical text. */
const canonicalDecimal = (value: string): string => {
  if (!value.includes('.')) {
    return value;
  }
  const canonical = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return canonical.length === 0 ? '0' : canonical;
};

const snapshotFromValues = (
  tenantId: string,
  subject: PurchaseLimitPolicySubject,
  values: Readonly<{
    amount: null | string;
    currencyCode: null | string;
    policyId: null | string;
    policyKind: 'MONETARY_LIMIT' | 'UNLIMITED' | null;
    recordedAt: Date | string | null;
    revision: null | number;
  }>,
): Effect.Effect<
  Option.Option<PurchaseLimitPolicySnapshot>,
  PurchaseLimitDependencyUnavailable
> => {
  if (
    values.policyId === null ||
    values.policyKind === null ||
    values.recordedAt === null ||
    values.revision === null
  ) {
    return Effect.succeed(Option.none());
  }
  let policy: Readonly<
    | { readonly _tag: 'UNLIMITED' }
    | {
        readonly _tag: 'MONETARY_LIMIT';
        readonly limit: Readonly<{
          readonly amount: string;
          readonly currency: string;
        }>;
      }
  > | null = null;
  if (values.policyKind === 'UNLIMITED') {
    policy = { _tag: 'UNLIMITED' };
  } else if (values.amount !== null && values.currencyCode !== null) {
    policy = {
      _tag: 'MONETARY_LIMIT',
      limit: {
        amount: canonicalDecimal(values.amount),
        currency: values.currencyCode,
      },
    };
  }
  if (policy === null) {
    return Effect.fail(dependencyUnavailable(POLICY_DEPENDENCY));
  }
  return Schema.decodeUnknownEffect(PurchaseLimitPolicySnapshotSchema)({
    changedAt: timestamp(values.recordedAt),
    policy,
    policyRef: {
      moduleId: MODULE_KEY,
      resourceId: values.policyId,
      resourceType: `${MODULE_KEY}.purchase-limit-policy`,
      tenantId,
    },
    revision: values.revision,
    subject,
  }).pipe(
    Effect.map(Option.some),
    Effect.mapError((parseFailure) => {
      const failure = dependencyUnavailable(POLICY_DEPENDENCY);
      Object.defineProperty(failure, 'cause', {
        configurable: true,
        value: parseFailure,
      });
      return failure;
    }),
  );
};

const snapshotFromReadRow = (
  tenantId: string,
  counterpartyRef: ChangeCounterpartyPurchaseLimitInput['counterpartyRef'],
  principalId: string,
  row: PurchaseLimitPolicyRow,
) => {
  const subject: PurchaseLimitPolicySubject =
    Option.getOrNull(row.source) === 'PRINCIPAL_OVERRIDE'
      ? {
          _tag: 'PRINCIPAL_OVERRIDE',
          counterpartyRef,
          principalRef: { principalId, tenantId },
        }
      : { _tag: 'COUNTERPARTY_DEFAULT', counterpartyRef };
  return snapshotFromValues(tenantId, subject, {
    amount: Option.getOrNull(row.amount),
    currencyCode: Option.getOrNull(row.currency_code),
    policyId: Option.getOrNull(row.policy_id),
    policyKind: Option.match(row.policy_kind, {
      onNone: () => null,
      onSome: (kind) => (kind === 'CLEARED' ? null : kind),
    }),
    recordedAt: Option.getOrNull(row.recorded_at),
    revision: Option.getOrNull(row.revision),
  });
};

const mutationSnapshots = (
  tenantId: string,
  subject: PurchaseLimitPolicySubject,
  row: PurchaseLimitMutationRow,
): Effect.Effect<
  Readonly<{
    currentPolicy: null | PurchaseLimitPolicySnapshot;
    previousPolicy: null | PurchaseLimitPolicySnapshot;
  }>,
  PurchaseLimitDependencyUnavailable
> =>
  Effect.all(
    {
      currentPolicy: snapshotFromValues(tenantId, subject, {
        amount: Option.getOrNull(row.current_amount),
        currencyCode: Option.getOrNull(row.current_currency_code),
        policyId: Option.getOrNull(row.current_policy_id),
        policyKind: Option.getOrNull(row.current_policy_kind),
        recordedAt: Option.getOrNull(row.current_recorded_at),
        revision: Option.getOrNull(row.current_revision),
      }).pipe(Effect.map(Option.getOrNull)),
      previousPolicy: snapshotFromValues(tenantId, subject, {
        amount: Option.getOrNull(row.previous_amount),
        currencyCode: Option.getOrNull(row.previous_currency_code),
        policyId: Option.getOrNull(row.previous_policy_id),
        policyKind: Option.getOrNull(row.previous_policy_kind),
        recordedAt: Option.getOrNull(row.previous_recorded_at),
        revision: Option.getOrNull(row.previous_revision),
      }).pipe(Effect.map(Option.getOrNull)),
    },
    { concurrency: 2 },
  );

interface ReadCurrentPurchaseLimitPolicyInput {
  readonly counterpartyRef: ChangeCounterpartyPurchaseLimitInput['counterpartyRef'];
  readonly principalRef: Readonly<{
    readonly principalId: string;
    readonly tenantId: string;
  }>;
  readonly tenantId: string;
}

interface CurrentPurchaseLimitPolicyState {
  readonly counterpartyPolicies: readonly PurchaseLimitPolicySnapshot[];
  readonly principalOverrides: readonly PurchaseLimitPolicySnapshot[];
  readonly result: EffectivePurchaseLimitPolicyResult;
  readonly sourceRevisions: PurchaseLimitSourceRevisionVector;
}

const policySourceRevision = (
  rows: readonly PurchaseLimitPolicyRow[],
  source: 'COUNTERPARTY_DEFAULT' | 'PRINCIPAL_OVERRIDE',
): Effect.Effect<PurchaseLimitSourceRevisionVector[number], PurchaseLimitDependencyUnavailable> => {
  const matching = rows.filter((row) => Option.getOrNull(row.source) === source);
  if (matching.length === 0) {
    const key =
      source === 'COUNTERPARTY_DEFAULT' ? COUNTERPARTY_POLICY_SOURCE : PRINCIPAL_OVERRIDE_SOURCE;
    return Effect.succeed({ revision: `${key}:absent`, source: key });
  }
  const [row] = matching;
  const revision = row === undefined ? null : Option.getOrNull(row.source_revision);
  if (matching.length !== 1 || revision === null) {
    return Effect.fail(dependencyUnavailable(POLICY_DEPENDENCY));
  }
  return Effect.succeed({
    revision,
    source:
      source === 'COUNTERPARTY_DEFAULT' ? COUNTERPARTY_POLICY_SOURCE : PRINCIPAL_OVERRIDE_SOURCE,
  });
};

export const readCurrentPurchaseLimitPolicyState = (
  transaction: ScopedTransactionExecutor,
  input: ReadCurrentPurchaseLimitPolicyInput,
): Effect.Effect<CurrentPurchaseLimitPolicyState, PurchaseLimitDependencyUnavailable> => {
  if (
    input.counterpartyRef.tenantId !== input.tenantId ||
    input.principalRef.tenantId !== input.tenantId
  ) {
    return Effect.fail(
      dependencyUnavailable('commerce.customer-context.purchase-limit-subject-scope'),
    );
  }
  return transaction
    .invoke(readPurchaseLimitPoliciesRoutine, [
      input.counterpartyRef.resourceId,
      input.principalRef.principalId,
    ])
    .pipe(
      Effect.mapError((failure) => dependencyUnavailable(POLICY_DEPENDENCY, failure)),
      Effect.flatMap((rows) =>
        rows.some(({ outcome }) => outcome === 'PROFILE_NOT_FOUND')
          ? Effect.fail(
              dependencyUnavailable('commerce.customer-context.counterparty-purchasing-profile'),
            )
          : Effect.all(
              {
                counterpartyRevision: policySourceRevision(rows, 'COUNTERPARTY_DEFAULT'),
                overrideRevision: policySourceRevision(rows, 'PRINCIPAL_OVERRIDE'),
                snapshots: Effect.all(
                  rows.map((row) =>
                    snapshotFromReadRow(
                      input.tenantId,
                      input.counterpartyRef,
                      input.principalRef.principalId,
                      row,
                    ),
                  ),
                  { concurrency: 2 },
                ),
              },
              { concurrency: 3 },
            ),
      ),
      Effect.map(({ counterpartyRevision, overrideRevision, snapshots }) => {
        const present = snapshots.flatMap((snapshot) =>
          Option.match(snapshot, {
            onNone: () => [],
            onSome: (value) => [value],
          }),
        );
        const counterpartyPolicies = present.filter(({ subject }) =>
          Match.value(subject).pipe(
            Match.tag('COUNTERPARTY_DEFAULT', () => true),
            Match.tag('PRINCIPAL_OVERRIDE', () => false),
            Match.exhaustive,
          ),
        );
        const principalOverrides = present.filter(({ subject }) =>
          Match.value(subject).pipe(
            Match.tag('COUNTERPARTY_DEFAULT', () => false),
            Match.tag('PRINCIPAL_OVERRIDE', () => true),
            Match.exhaustive,
          ),
        );
        return {
          counterpartyPolicies,
          counterpartyRef: input.counterpartyRef,
          principalOverrides,
          result: resolveEffectivePurchaseLimitPolicy({
            counterpartyPolicies,
            counterpartyRef: input.counterpartyRef,
            principalId: input.principalRef.principalId,
            principalOverrides,
          }),
          sourceRevisions: [counterpartyRevision, overrideRevision],
        };
      }),
    );
};

export const readCurrentPurchaseLimitPolicy = (
  transaction: ScopedTransactionExecutor,
  input: ReadCurrentPurchaseLimitPolicyInput,
): Effect.Effect<EffectivePurchaseLimitPolicyResult, PurchaseLimitDependencyUnavailable> =>
  readCurrentPurchaseLimitPolicyState(transaction, input).pipe(Effect.map(({ result }) => result));

const mutationArguments = (input: ChangeCounterpartyPurchaseLimitInput) =>
  Match.value(input.change).pipe(
    Match.tag('CLEAR', () => ['CLEAR', null, null, null] as const),
    Match.tag('SET', ({ policy }) =>
      Match.value(policy).pipe(
        Match.tag('UNLIMITED', () => ['SET', 'UNLIMITED', null, null] as const),
        Match.tag(
          'MONETARY_LIMIT',
          ({ limit }) => ['SET', 'MONETARY_LIMIT', limit.amount, limit.currency] as const,
        ),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );

type PurchaseLimitPolicyPersistenceError =
  | PurchaseLimitDependencyUnavailable
  | PurchaseLimitPolicyConflict
  | PurchaseLimitSubjectScopeMismatch;

const changePurchaseLimitPolicy = (
  transaction: ScopedTransactionExecutor,
  input: ChangeCounterpartyPurchaseLimitInput,
  principalId: null | string,
): Effect.Effect<PurchaseLimitPolicyMutationResult, PurchaseLimitPolicyPersistenceError> => {
  if (input.counterpartyRef.tenantId === '') {
    return Effect.fail(subjectScopeMismatch('The Counterparty Tenant is missing'));
  }
  const [changeKind, policyKind, amount, currencyCode] = mutationArguments(input);
  const subject: PurchaseLimitPolicySubject =
    principalId === null
      ? { _tag: 'COUNTERPARTY_DEFAULT', counterpartyRef: input.counterpartyRef }
      : {
          _tag: 'PRINCIPAL_OVERRIDE',
          counterpartyRef: input.counterpartyRef,
          principalRef: {
            principalId,
            tenantId: input.counterpartyRef.tenantId,
          },
        };
  return transaction
    .invoke(changePurchaseLimitPolicyRoutine, [
      input.counterpartyRef.resourceId,
      principalId,
      input.expectedRevision,
      changeKind,
      policyKind,
      amount,
      currencyCode,
      input.reason,
      input.actorPrincipalId,
      input.actionInvocationId,
    ])
    .pipe(
      Effect.mapError((failure) => dependencyUnavailable(POLICY_DEPENDENCY, failure)),
      Effect.flatMap(
        ([row]): Effect.Effect<
          PurchaseLimitPolicyMutationResult,
          PurchaseLimitPolicyPersistenceError
        > => {
          if (row === undefined) {
            return Effect.fail(dependencyUnavailable(POLICY_DEPENDENCY));
          }
          if (row.outcome === 'PROFILE_NOT_FOUND') {
            return Effect.fail(
              subjectScopeMismatch(
                'The Counterparty Purchasing Profile is not available in the verified scope',
              ),
            );
          }
          if (row.outcome === 'REVISION_CONFLICT') {
            return Effect.fail(
              PurchaseLimitPolicyConflictSchema.make({
                code: 'purchase_limit_policy_conflict',
                currentRevision: Option.getOrNull(row.current_revision),
                reason: 'The Purchase Limit policy changed concurrently',
              }),
            );
          }
          return mutationSnapshots(input.counterpartyRef.tenantId, subject, row).pipe(
            Effect.map(({ currentPolicy, previousPolicy }): PurchaseLimitPolicyMutationResult => ({
              currentPolicy,
              previousPolicy,
              status: row.outcome === 'APPLIED' ? 'CHANGED' : 'UNCHANGED',
            })),
          );
        },
      ),
    );
};

export const changeCounterpartyPurchaseLimit = (
  transaction: ScopedTransactionExecutor,
  input: ChangeCounterpartyPurchaseLimitInput,
): Effect.Effect<PurchaseLimitPolicyMutationResult, PurchaseLimitPolicyPersistenceError> =>
  changePurchaseLimitPolicy(transaction, input, null);

export const changePrincipalPurchaseLimitOverride = (
  transaction: ScopedTransactionExecutor,
  input: ChangePrincipalPurchaseLimitOverrideInput,
): Effect.Effect<PurchaseLimitPolicyMutationResult, PurchaseLimitPolicyPersistenceError> => {
  if (input.principalRef.tenantId !== input.counterpartyRef.tenantId) {
    return Effect.fail(
      subjectScopeMismatch('The Principal and Counterparty must belong to the same Tenant'),
    );
  }
  return changePurchaseLimitPolicy(transaction, input, input.principalRef.principalId);
};

export const purchaseLimitPolicyServiceForTransaction = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope & { readonly legalEntityId: string },
): PurchaseLimitPolicyService => ({
  changeCounterpartyPolicy: (input) => {
    if (
      input.counterpartyRef.tenantId !== scope.tenantId ||
      input.actorPrincipalId !== scope.principalId
    ) {
      return Effect.fail(
        subjectScopeMismatch(
          'The Counterparty and mutation Actor must match the verified operation scope',
        ),
      );
    }
    return changeCounterpartyPurchaseLimit(transaction, input);
  },
  changePrincipalOverride: (input) => {
    if (
      input.counterpartyRef.tenantId !== scope.tenantId ||
      input.principalRef.tenantId !== scope.tenantId ||
      input.actorPrincipalId !== scope.principalId
    ) {
      return Effect.fail(
        subjectScopeMismatch('The Principal and Counterparty must belong to the verified Tenant'),
      );
    }
    return changePrincipalPurchaseLimitOverride(transaction, input);
  },
  readCurrent: ({ counterpartyRef, principalRef }) =>
    readCurrentPurchaseLimitPolicy(transaction, {
      counterpartyRef,
      principalRef,
      tenantId: scope.tenantId,
    }),
});

const policyFactory: PurchaseLimitPolicyServiceFactoryContract = {
  make: <Transaction>(transaction: Transaction, scope: OperationalScope) => {
    if (scope.legalEntityId === undefined) {
      return Effect.fail(
        dependencyUnavailable('commerce.customer-context.purchase-limit-operational-scope'),
      );
    }
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Core invokes owner factories only with its branded, scope-installed transaction; expires: 2027-03-31.
    const scopedTransaction = transaction as ScopedTransactionExecutor;
    return Effect.succeed(
      purchaseLimitPolicyServiceForTransaction(scopedTransaction, {
        ...scope,
        legalEntityId: scope.legalEntityId,
      }),
    );
  },
};

export const purchaseLimitPolicyServiceFactoryLayer = Layer.succeed(
  PurchaseLimitPolicyServiceFactory,
  policyFactory,
);

const fxUnavailable = (reason: string, cause?: unknown): PurchaseLimitFxUnavailable => {
  const failure = PurchaseLimitFxUnavailableSchema.make({
    code: 'purchase_limit_fx_unavailable',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};

/** Launch supports exact same-currency Purchase Limit comparisons only. */
const purchaseLimitFxForLaunch = (decidedAt: string): PurchaseLimitFxPort => ({
  comparableValue: ({ purchaseValue, targetCurrency }) => {
    if (purchaseValue.monetaryAmount.currency !== targetCurrency) {
      return Effect.fail(
        fxUnavailable(
          `Cross-currency Purchase Limit comparison is not supported in the CZK Launch cutline (${purchaseValue.monetaryAmount.currency} to ${targetCurrency})`,
        ),
      );
    }

    return Schema.decodeUnknownEffect(PurchaseLimitComparableValueSchema)({
      decidedAt,
      decisionRef: purchaseValue.sourceRef,
      monetaryAmount: purchaseValue.monetaryAmount,
      purpose: 'PURCHASE_LIMIT_COMPARISON',
      roundingRuleRevision: purchaseValue.roundingRuleRevision,
      source: 'purchase-value',
      sourcePurchaseValueRevision: purchaseValue.sourceRevision,
      sourceRevision: purchaseValue.sourceRevision,
    }).pipe(
      Effect.mapError((cause) =>
        fxUnavailable('The same-currency Purchase Value evidence is invalid', cause),
      ),
    );
  },
});

const EVALUATION_CURRENTNESS_DEPENDENCY = 'commerce.purchase-limit-evaluation-currentness';
const FX_DEPENDENCY = 'commerce.customer-context.purchase-limit-cross-currency';
const REQUIRED_EXTERNAL_REVISION_SOURCES = [
  'customer-commerce-policy',
  PURCHASE_PROPOSAL_SOURCE,
  PURCHASING_PROFILE_SOURCE,
  'storefront-context',
] as const;
const OWNER_REVISION_SOURCES = new Set([COUNTERPARTY_POLICY_SOURCE, PRINCIPAL_OVERRIDE_SOURCE]);

const dependencyUnavailableFromCause = (
  dependency: string,
  reason: string,
  cause?: unknown,
): PurchaseLimitDependencyUnavailable => {
  const failure = PurchaseLimitDependencyUnavailableSchema.make({
    code: 'purchase_limit_dependency_unavailable',
    dependency,
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};

const approvalDependencyUnavailable = (
  dependency: 'CUSTOMER_PROFILE' | 'PURCHASE_LIMIT_EVALUATION',
  reason: string,
  cause?: unknown,
): PurchaseApprovalDependencyUnavailable => {
  const failure = PurchaseApprovalDependencyUnavailableSchema.make({
    code: 'purchase_approval_dependency_unavailable',
    dependency,
    reason,
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};

const authoritativeExternalFacts = (
  candidate: PurchaseLimitEvaluationCurrentFacts,
): Effect.Effect<
  typeof PurchaseLimitEvaluationCurrentFactsSchema.Type,
  PurchaseLimitDependencyUnavailable
> =>
  Schema.decodeUnknownEffect(PurchaseLimitEvaluationCurrentFactsSchema)(candidate).pipe(
    Effect.mapError((cause) =>
      dependencyUnavailableFromCause(
        EVALUATION_CURRENTNESS_DEPENDENCY,
        'The external Currentness provider returned invalid Purchase Limit facts',
        cause,
      ),
    ),
    Effect.filterOrFail(
      ({ currentSourceRevisions }) =>
        REQUIRED_EXTERNAL_REVISION_SOURCES.every((source) =>
          currentSourceRevisions.some((candidateRevision) => candidateRevision.source === source),
        ) && currentSourceRevisions.every(({ source }) => !OWNER_REVISION_SOURCES.has(source)),
      () =>
        dependencyUnavailableFromCause(
          EVALUATION_CURRENTNESS_DEPENDENCY,
          'The external Currentness provider omitted required evidence or claimed owner-local sources',
        ),
    ),
  );

const combinedSourceRevisions = (
  external: PurchaseLimitSourceRevisionVector,
  policy: PurchaseLimitSourceRevisionVector,
  comparable: Option.Option<typeof PurchaseLimitComparableValueSchema.Type>,
): Effect.Effect<PurchaseLimitSourceRevisionVector, PurchaseLimitDependencyUnavailable> =>
  Schema.decodeUnknownEffect(PurchaseLimitSourceRevisionVectorSchema)([
    ...external,
    ...policy,
    ...Option.match(comparable, {
      onNone: () => [],
      onSome: (value) => [{ revision: value.sourceRevision, source: value.source }],
    }),
  ]).pipe(
    Effect.mapError((cause) =>
      dependencyUnavailableFromCause(
        EVALUATION_CURRENTNESS_DEPENDENCY,
        'Current Purchase Limit evidence contains duplicate or invalid source revisions',
        cause,
      ),
    ),
  );

const comparableForPolicy = (
  policyState: CurrentPurchaseLimitPolicyState,
  purchaseValue: PurchaseValue,
  fx: PurchaseLimitFxPort,
) =>
  Match.value(policyState.result).pipe(
    Match.tag('EFFECTIVE_POLICY', ({ effectivePolicy }) =>
      Match.value(effectivePolicy.policy).pipe(
        Match.tag('UNLIMITED', () =>
          Effect.succeed(Option.none<typeof PurchaseLimitComparableValueSchema.Type>()),
        ),
        Match.tag('MONETARY_LIMIT', ({ limit }) =>
          limit.currency === purchaseValue.monetaryAmount.currency
            ? Effect.succeed(Option.none<typeof PurchaseLimitComparableValueSchema.Type>())
            : fx
                .comparableValue({
                  purchaseValue,
                  targetCurrency: limit.currency,
                })
                .pipe(
                  Effect.map(Option.some),
                  Effect.mapError((cause) =>
                    dependencyUnavailableFromCause(
                      FX_DEPENDENCY,
                      'A Current purpose-specific comparable Purchase Value is unavailable',
                      cause,
                    ),
                  ),
                ),
        ),
        Match.exhaustive,
      ),
    ),
    Match.orElse(() =>
      Effect.succeed(Option.none<typeof PurchaseLimitComparableValueSchema.Type>()),
    ),
  );

export const purchaseLimitEvaluationSourceForTransaction = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope & {
    readonly legalEntityId: string;
    readonly trustedStorefrontId: string;
  },
  // eslint-disable-next-line effect-native/no-dependency-parameters -- This owner-local constructor is used only by the factory after yielding the Context service and by focused adapter tests; expires: 2027-09-09.
  currentness: PurchaseLimitEvaluationCurrentnessPortService,
): PurchaseLimitEvaluationSourceService => {
  const currentnessForTransaction =
    currentness.forTransaction?.(transaction, {
      legalEntityId: scope.legalEntityId,
      principalId: scope.principalId,
      storefrontId: scope.trustedStorefrontId,
      tenantId: scope.tenantId,
    }) ?? currentness;
  return {
    loadCurrent: ({ principalId, query }) => {
      if (
        principalId !== scope.principalId ||
        query.counterpartyRef.tenantId !== scope.tenantId ||
        query.storefrontId !== scope.trustedStorefrontId
      ) {
        return Effect.fail(
          dependencyUnavailableFromCause(
            'commerce.customer-context.purchase-limit-evaluation-scope',
            'The Purchase Limit query does not match the trusted operation scope',
          ),
        );
      }

      return Effect.gen(function* loadCurrentPurchaseLimitEvaluation() {
        const decidedAt = yield* DateTime.now;
        const [facts, policyState, sellingLegalEntityId, storefrontId] = yield* Effect.all(
          [
            currentnessForTransaction
              .resolveCurrent({
                claimedPurchaseValue: query.purchaseValue,
                counterpartyRef: query.counterpartyRef,
                expectedSourceRevisions: query.expectedSourceRevisions,
                observedAt: decidedAt,
                scope: {
                  legalEntityId: scope.legalEntityId,
                  principalId: scope.principalId,
                  storefrontId: scope.trustedStorefrontId,
                  tenantId: scope.tenantId,
                },
              })
              .pipe(Effect.flatMap(authoritativeExternalFacts)),
            readCurrentPurchaseLimitPolicyState(transaction, {
              counterpartyRef: query.counterpartyRef,
              principalRef: {
                principalId: scope.principalId,
                tenantId: scope.tenantId,
              },
              tenantId: scope.tenantId,
            }),
            Schema.decodeUnknownEffect(PurchaseLimitSellingLegalEntityIdSchema)(
              scope.legalEntityId,
            ),
            Schema.decodeUnknownEffect(PurchaseLimitStorefrontIdSchema)(scope.trustedStorefrontId),
          ],
          { concurrency: 4 },
        ).pipe(
          Effect.mapError((cause) =>
            Schema.is(PurchaseLimitDependencyUnavailableSchema)(cause)
              ? cause
              : dependencyUnavailableFromCause(
                  'commerce.customer-context.purchase-limit-evaluation-scope',
                  'The trusted Purchase Limit operation scope is invalid',
                  cause,
                ),
          ),
        );

        if (
          facts.purchaseValue.sourceRef !== query.purchaseValue.sourceRef ||
          facts.currentSourceRevisions.find(({ source }) => source === PURCHASE_PROPOSAL_SOURCE)
            ?.revision !== facts.purchaseValue.sourceRevision
        ) {
          return yield* Effect.fail(
            dependencyUnavailableFromCause(
              EVALUATION_CURRENTNESS_DEPENDENCY,
              'The Current Purchase Value is not bound to the claimed proposal reference and revision',
            ),
          );
        }

        const fx = purchaseLimitFxForLaunch(DateTime.formatIso(decidedAt));
        const comparableValue = yield* comparableForPolicy(policyState, facts.purchaseValue, fx);
        const currentSourceRevisions = yield* combinedSourceRevisions(
          facts.currentSourceRevisions,
          policyState.sourceRevisions,
          comparableValue,
        );

        const evaluationInput = {
          counterpartyPolicies: policyState.counterpartyPolicies,
          counterpartyRef: query.counterpartyRef,
          currentSourceRevisions,
          decidedAt,
          expectedSourceRevisions: query.expectedSourceRevisions,
          principalId: scope.principalId,
          principalOverrides: policyState.principalOverrides,
          purchaseValue: facts.purchaseValue,
          sellingLegalEntityId,
          storefrontId,
        } satisfies PurchaseLimitEvaluationInput;
        return Option.match(comparableValue, {
          onNone: () => evaluationInput,
          onSome: (value) => ({ ...evaluationInput, comparableValue: value }),
        });
      });
    },
  };
};

const sameCounterpartyRef = (
  left: PurchaseApprovalTriggerCurrentEvidence['profileEvidence']['counterpartyRef'],
  right: PurchaseApprovalTriggerCurrentEvidence['profileEvidence']['counterpartyRef'],
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameProfileRef = (
  left: PurchaseApprovalTriggerCurrentEvidence['profileEvidence']['profileRef'],
  right: PurchaseApprovalTriggerCurrentEvidence['profileEvidence']['profileRef'],
): boolean =>
  left.kind === right.kind &&
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/**
 * Re-reads the owner-current profile gate and authoritative proposal facts inside the Action's
 * scoped transaction. No profile, Counterparty, proposal, Tenant, or Storefront identity is
 * promoted from an unverified payload.
 */
export const purchaseApprovalTriggerEvidenceSourceForTransaction = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope & {
    readonly legalEntityId: string;
    readonly trustedStorefrontId: string;
  },
  // eslint-disable-next-line effect-native/no-dependency-parameters -- The factory yields this explicit Currentness Context service before closing it into the scoped Action service; expires: 2027-09-09.
  currentness: PurchaseLimitEvaluationCurrentnessPortService,
  // The profile trading gate re-reads Party Registry role eligibility for Counterparty profiles.
  // Keep this dependency explicit so direct/unit callers cannot accidentally make production use
  // a local profile snapshot as an authorization substitute.
  profileDependencies: Pick<ProfilePersistenceDependencies, 'resolveCounterpartyRole'> = {},
): PurchaseApprovalTriggerEvidenceSource => {
  const currentnessForTransaction =
    currentness.forTransaction?.(transaction, {
      legalEntityId: scope.legalEntityId,
      principalId: scope.principalId,
      storefrontId: scope.trustedStorefrontId,
      tenantId: scope.tenantId,
    }) ?? currentness;
  return {
    loadCandidateCurrent: ({ payload, trustedContext }) => {
      const resolveCandidate = currentnessForTransaction.resolveCandidate;
      if (resolveCandidate === undefined) {
        return Effect.fail(
          approvalDependencyUnavailable(
            'PURCHASE_LIMIT_EVALUATION',
            'Candidate Purchase Proposal currentness is not configured; creation cannot reuse a persisted CURRENT row',
          ),
        );
      }
      if (
        payload.counterpartyRef.tenantId !== scope.tenantId ||
        payload.profileRef.tenantId !== scope.tenantId ||
        payload.storefrontId !== scope.trustedStorefrontId ||
        trustedContext.principalId !== scope.principalId ||
        trustedContext.sellingLegalEntityId !== scope.legalEntityId ||
        trustedContext.storefrontId !== scope.trustedStorefrontId ||
        !sameCounterpartyRef(trustedContext.counterpartyRef, payload.counterpartyRef)
      ) {
        return Effect.fail(
          approvalDependencyUnavailable(
            'CUSTOMER_PROFILE',
            'The candidate Purchase Proposal evidence request does not match the trusted operation scope',
          ),
        );
      }
      return Effect.gen(function* loadCandidatePurchaseApprovalEvidence() {
        const evaluatedAt = yield* DateTime.now;
        const profileServices = profilePersistenceServicesForTransaction(
          transaction,
          {
            legalEntityId: scope.legalEntityId,
            principalId: scope.principalId,
            tenantId: scope.tenantId,
          },
          profileDependencies,
        );
        const [facts, profile, policyState] = yield* Effect.all(
          [
            resolveCandidate({
              claimedPurchaseValue: payload.purchaseValue,
              counterpartyRef: payload.counterpartyRef,
              expectedSourceRevisions: payload.expectedSourceRevisions,
              observedAt: evaluatedAt,
              scope: {
                legalEntityId: scope.legalEntityId,
                principalId: scope.principalId,
                storefrontId: scope.trustedStorefrontId,
                tenantId: scope.tenantId,
              },
            }).pipe(
              Effect.flatMap(authoritativeExternalFacts),
              Effect.mapError((cause) =>
                approvalDependencyUnavailable(
                  'PURCHASE_LIMIT_EVALUATION',
                  'Candidate Purchase Proposal evidence is temporarily unavailable',
                  cause,
                ),
              ),
            ),
            profileServices.customerProfileTradingGate
              .evaluateGate(
                {
                  authorizationSubject: {
                    counterpartyRef: trustedContext.counterpartyRef,
                    kind: 'COUNTERPARTY',
                  },
                  profileRef: payload.profileRef,
                },
                scope.tenantId,
              )
              .pipe(
                Effect.mapError((cause) =>
                  approvalDependencyUnavailable(
                    'CUSTOMER_PROFILE',
                    'Current Customer Profile trading evidence is temporarily unavailable',
                    cause,
                  ),
                ),
              ),
            readCurrentPurchaseLimitPolicyState(transaction, {
              counterpartyRef: payload.counterpartyRef,
              principalRef: { principalId: scope.principalId, tenantId: scope.tenantId },
              tenantId: scope.tenantId,
            }).pipe(
              Effect.mapError((cause) =>
                approvalDependencyUnavailable(
                  'PURCHASE_LIMIT_EVALUATION',
                  'Current Purchase Limit policy evidence is temporarily unavailable',
                  cause,
                ),
              ),
            ),
          ],
          { concurrency: 3 },
        );
        const profileSourceRevision = facts.currentSourceRevisions.find(
          ({ source }) => source === PURCHASING_PROFILE_SOURCE,
        )?.revision;
        const proposalSourceRevision = facts.currentSourceRevisions.find(
          ({ source }) => source === PURCHASE_PROPOSAL_SOURCE,
        )?.revision;
        if (
          profile.subject.kind !== 'COUNTERPARTY' ||
          !sameCounterpartyRef(profile.subject.counterpartyRef, payload.counterpartyRef) ||
          !sameProfileRef(profile.profileRef, payload.profileRef) ||
          profileSourceRevision !== String(profile.revision) ||
          facts.purchaseValue.sourceRef !== payload.proposalRevisionRef ||
          proposalSourceRevision !== facts.purchaseValue.sourceRevision
        ) {
          return yield* Effect.fail(
            approvalDependencyUnavailable(
              'PURCHASE_LIMIT_EVALUATION',
              'Candidate owner facts are not bound to the requested proposal/profile revision',
            ),
          );
        }
        const currentSourceRevisions = yield* combinedSourceRevisions(
          facts.currentSourceRevisions,
          policyState.sourceRevisions,
          Option.none(),
        ).pipe(
          Effect.mapError((cause) =>
            approvalDependencyUnavailable(
              'PURCHASE_LIMIT_EVALUATION',
              'Candidate Purchase Approval evidence contains invalid or colliding revisions',
              cause,
            ),
          ),
        );
        const rawProfileEvaluatedAt: unknown = profile.evaluatedAt;
        const [profileEvidence, proposalEvidence] = yield* Effect.all(
          [
            Schema.decodeUnknownEffect(PurchaseApprovalProfileEvidenceSchema)({
              counterpartyRef: payload.counterpartyRef,
              evaluatedAt: DateTime.isDateTime(rawProfileEvaluatedAt)
                ? DateTime.formatIso(rawProfileEvaluatedAt)
                : rawProfileEvaluatedAt,
              evaluationContext: trustedContext,
              gate: profile.gate,
              profileRef: profile.profileRef,
              revision: profile.revision,
              sourceRevision: profileSourceRevision,
            }).pipe(
              Effect.mapError((cause) =>
                approvalDependencyUnavailable(
                  'CUSTOMER_PROFILE',
                  'Current Customer Profile evidence is invalid',
                  cause,
                ),
              ),
            ),
            Schema.decodeUnknownEffect(PurchaseApprovalProposalEvidenceSchema)({
              evaluatedAt: DateTime.formatIso(evaluatedAt),
              evaluationContext: trustedContext,
              proposalRevisionRef: facts.purchaseValue.sourceRef,
              purchaseValue: facts.purchaseValue,
              revision: facts.purchaseValue.sourceRevision,
              state: 'CURRENT',
            }).pipe(
              Effect.mapError((cause) =>
                approvalDependencyUnavailable(
                  'PURCHASE_LIMIT_EVALUATION',
                  'Current Purchase Proposal evidence is invalid',
                  cause,
                ),
              ),
            ),
          ],
          { concurrency: 2 },
        );
        return { currentSourceRevisions, profileEvidence, proposalEvidence };
      });
    },
    loadCurrent: ({ payload, trustedContext }) => {
      if (
        payload.counterpartyRef.tenantId !== scope.tenantId ||
        payload.profileRef.tenantId !== scope.tenantId ||
        payload.storefrontId !== scope.trustedStorefrontId ||
        trustedContext.principalId !== scope.principalId ||
        trustedContext.sellingLegalEntityId !== scope.legalEntityId ||
        trustedContext.storefrontId !== scope.trustedStorefrontId ||
        !sameCounterpartyRef(trustedContext.counterpartyRef, payload.counterpartyRef)
      ) {
        return Effect.fail(
          approvalDependencyUnavailable(
            'CUSTOMER_PROFILE',
            'The Purchase Approval evidence request does not match the trusted operation scope',
          ),
        );
      }

      return Effect.gen(function* loadCurrentPurchaseApprovalEvidence() {
        const evaluatedAt = yield* DateTime.now;
        const profileServices = profilePersistenceServicesForTransaction(
          transaction,
          {
            legalEntityId: scope.legalEntityId,
            principalId: scope.principalId,
            tenantId: scope.tenantId,
          },
          profileDependencies,
        );
        const [facts, profile, policyState] = yield* Effect.all(
          [
            currentnessForTransaction
              .resolveCurrent({
                claimedPurchaseValue: payload.purchaseValue,
                counterpartyRef: payload.counterpartyRef,
                expectedSourceRevisions: payload.expectedSourceRevisions,
                observedAt: evaluatedAt,
                scope: {
                  legalEntityId: scope.legalEntityId,
                  principalId: scope.principalId,
                  storefrontId: scope.trustedStorefrontId,
                  tenantId: scope.tenantId,
                },
              })
              .pipe(
                Effect.flatMap(authoritativeExternalFacts),
                Effect.mapError((cause) =>
                  approvalDependencyUnavailable(
                    'PURCHASE_LIMIT_EVALUATION',
                    'Current Purchase Proposal evidence is temporarily unavailable',
                    cause,
                  ),
                ),
              ),
            profileServices.customerProfileTradingGate
              .evaluateGate(
                {
                  authorizationSubject: {
                    counterpartyRef: trustedContext.counterpartyRef,
                    kind: 'COUNTERPARTY',
                  },
                  profileRef: payload.profileRef,
                },
                scope.tenantId,
              )
              .pipe(
                Effect.mapError((cause) =>
                  approvalDependencyUnavailable(
                    'CUSTOMER_PROFILE',
                    'Current Customer Profile trading evidence is temporarily unavailable',
                    cause,
                  ),
                ),
              ),
            readCurrentPurchaseLimitPolicyState(transaction, {
              counterpartyRef: payload.counterpartyRef,
              principalRef: {
                principalId: scope.principalId,
                tenantId: scope.tenantId,
              },
              tenantId: scope.tenantId,
            }).pipe(
              Effect.mapError((cause) =>
                approvalDependencyUnavailable(
                  'PURCHASE_LIMIT_EVALUATION',
                  'Current Purchase Limit policy evidence is temporarily unavailable',
                  cause,
                ),
              ),
            ),
          ],
          { concurrency: 3 },
        );

        const profileSourceRevision = facts.currentSourceRevisions.find(
          ({ source }) => source === PURCHASING_PROFILE_SOURCE,
        )?.revision;
        const proposalSourceRevision = facts.currentSourceRevisions.find(
          ({ source }) => source === PURCHASE_PROPOSAL_SOURCE,
        )?.revision;
        if (
          profile.subject.kind !== 'COUNTERPARTY' ||
          !sameCounterpartyRef(profile.subject.counterpartyRef, payload.counterpartyRef) ||
          !sameProfileRef(profile.profileRef, payload.profileRef) ||
          profileSourceRevision !== String(profile.revision)
        ) {
          return yield* Effect.fail(
            approvalDependencyUnavailable(
              'CUSTOMER_PROFILE',
              'Current Customer Profile evidence is not bound to the requested Counterparty and owner revision',
            ),
          );
        }
        if (
          facts.purchaseValue.sourceRef !== payload.proposalRevisionRef ||
          proposalSourceRevision !== facts.purchaseValue.sourceRevision
        ) {
          return yield* Effect.fail(
            approvalDependencyUnavailable(
              'PURCHASE_LIMIT_EVALUATION',
              'Current Purchase Proposal evidence is not bound to its immutable reference and revision',
            ),
          );
        }

        const currentSourceRevisions = yield* combinedSourceRevisions(
          facts.currentSourceRevisions,
          policyState.sourceRevisions,
          Option.none(),
        ).pipe(
          Effect.mapError((cause) =>
            approvalDependencyUnavailable(
              'PURCHASE_LIMIT_EVALUATION',
              'Current Purchase Approval evidence contains invalid or colliding revisions',
              cause,
            ),
          ),
        );
        const rawProfileEvaluatedAt: unknown = profile.evaluatedAt;
        const [profileEvidence, proposalEvidence] = yield* Effect.all(
          [
            Schema.decodeUnknownEffect(PurchaseApprovalProfileEvidenceSchema)({
              counterpartyRef: payload.counterpartyRef,
              evaluatedAt: DateTime.isDateTime(rawProfileEvaluatedAt)
                ? DateTime.formatIso(rawProfileEvaluatedAt)
                : rawProfileEvaluatedAt,
              evaluationContext: trustedContext,
              gate: profile.gate,
              profileRef: profile.profileRef,
              revision: profile.revision,
              sourceRevision: profileSourceRevision,
            }).pipe(
              Effect.mapError((cause) =>
                approvalDependencyUnavailable(
                  'CUSTOMER_PROFILE',
                  'Current Customer Profile evidence is invalid',
                  cause,
                ),
              ),
            ),
            Schema.decodeUnknownEffect(PurchaseApprovalProposalEvidenceSchema)({
              evaluatedAt: DateTime.formatIso(evaluatedAt),
              evaluationContext: trustedContext,
              proposalRevisionRef: facts.purchaseValue.sourceRef,
              purchaseValue: facts.purchaseValue,
              revision: facts.purchaseValue.sourceRevision,
              state: 'CURRENT',
            }).pipe(
              Effect.mapError((cause) =>
                approvalDependencyUnavailable(
                  'PURCHASE_LIMIT_EVALUATION',
                  'Current Purchase Proposal evidence is invalid',
                  cause,
                ),
              ),
            ),
          ],
          { concurrency: 2 },
        );
        return { currentSourceRevisions, profileEvidence, proposalEvidence };
      });
    },
  };
};

const evaluationSourceFactoryForCurrentness = (
  // eslint-disable-next-line effect-native/no-dependency-parameters -- The layer yields this Context service before closing it into the transaction factory; expires: 2027-09-09.
  currentness: PurchaseLimitEvaluationCurrentnessPortService,
): PurchaseLimitEvaluationSourceFactoryContract => ({
  make: <Transaction>(transaction: Transaction, scope: OperationalScope) => {
    if (scope.legalEntityId === undefined || scope.trustedStorefrontId === undefined) {
      return Effect.fail(
        dependencyUnavailableFromCause(
          'commerce.customer-context.purchase-limit-operational-scope',
          'Purchase Limit evaluation requires trusted Selling Legal Entity and Storefront scope',
        ),
      );
    }
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Core invokes owner factories only with its branded, scope-installed transaction; expires: 2027-03-31.
    const scopedTransaction = transaction as ScopedTransactionExecutor;
    return Effect.succeed(
      purchaseLimitEvaluationSourceForTransaction(
        scopedTransaction,
        {
          ...scope,
          legalEntityId: scope.legalEntityId,
          trustedStorefrontId: scope.trustedStorefrontId,
        },
        currentness,
      ),
    );
  },
});

const approvalEvidenceFactoryForCurrentness = (
  // eslint-disable-next-line effect-native/no-dependency-parameters -- The layer yields this Context service before closing it into the transaction factory; expires: 2027-09-09.
  currentness: PurchaseLimitEvaluationCurrentnessPortService,
  roleResolverFactory: typeof ProfileCounterpartyRoleEligibilityResolverFactory.Service,
): PurchaseApprovalTriggerEvidenceSourceFactoryContract => ({
  make: <Transaction>(transaction: Transaction, scope: OperationalScope) => {
    if (scope.legalEntityId === undefined || scope.trustedStorefrontId === undefined) {
      return Effect.fail(
        approvalDependencyUnavailable(
          'CUSTOMER_PROFILE',
          'Purchase Approval evidence requires trusted Selling Legal Entity and Storefront scope',
        ),
      );
    }
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Core invokes owner factories only with its branded, scope-installed transaction; expires: 2027-03-31.
    const scopedTransaction = transaction as ScopedTransactionExecutor;
    const resolveCounterpartyRole = roleResolverFactory.make({
      legalEntityId: scope.legalEntityId,
      requestCorrelation: scope.correlationId,
      tenantId: scope.tenantId,
    });
    return Effect.succeed(
      purchaseApprovalTriggerEvidenceSourceForTransaction(
        scopedTransaction,
        {
          ...scope,
          legalEntityId: scope.legalEntityId,
          trustedStorefrontId: scope.trustedStorefrontId,
        },
        currentness,
        { resolveCounterpartyRole },
      ),
    );
  },
});

/**
 * The checked-in proposal snapshot is an owner record, but it is not a currentness oracle for
 * Cart, Storefront, or Customer Commerce Policy. Until those owners supply a transaction-bound
 * adapter, the production layer is deliberately fail-closed rather than promoting its persisted
 * external source vector as fresh evidence. A deployment can replace this layer with the real
 * owner adapter without changing Action or SQL boundaries.
 */
const durablePurchaseLimitEvaluationCurrentness =
  (): PurchaseLimitEvaluationCurrentnessPortService => ({
    forTransaction: () => ({
      resolveCurrent: () =>
        Effect.fail(
          dependencyUnavailable('commerce.customer-context.purchase-approval-currentness'),
        ),
      resolveCandidate: () =>
        Effect.fail(
          dependencyUnavailable(
            'commerce.customer-context.purchase-approval-candidate-currentness',
          ),
        ),
    }),
    resolveCurrent: () =>
      Effect.fail(dependencyUnavailable('commerce.customer-context.purchase-approval-currentness')),
    resolveCandidate: () =>
      Effect.fail(
        dependencyUnavailable('commerce.customer-context.purchase-approval-candidate-currentness'),
      ),
  });

export const unavailablePurchaseLimitEvaluationCurrentness =
  (): PurchaseLimitEvaluationCurrentnessPortService => ({
    resolveCurrent: () =>
      Effect.fail(
        dependencyUnavailableFromCause(
          EVALUATION_CURRENTNESS_DEPENDENCY,
          'Current Purchase Proposal, profile, Storefront, and Customer Commerce Policy owners are not configured',
        ),
      ),
  });

export const purchaseLimitEvaluationCurrentnessUnavailableLayer = Layer.succeed(
  PurchaseLimitEvaluationCurrentnessPort,
  unavailablePurchaseLimitEvaluationCurrentness(),
);

/** Real transaction-bound Currentness adapter for approval-trigger evaluation. */
export const purchaseLimitEvaluationCurrentnessLive = Layer.succeed(
  PurchaseLimitEvaluationCurrentnessPort,
  durablePurchaseLimitEvaluationCurrentness(),
);

/** Real owner composition over scoped persistence, explicit Currentness, and published FX. */
export const purchaseLimitEvaluationSourceFactoryLayer = Layer.effect(
  PurchaseLimitEvaluationSourceFactory,
  Effect.map(PurchaseLimitEvaluationCurrentnessPort, (currentness) =>
    evaluationSourceFactoryForCurrentness(currentness),
  ),
);

export const purchaseApprovalTriggerEvidenceSourceFactoryLayer = Layer.effect(
  PurchaseApprovalTriggerEvidenceSourceFactory,
  Effect.all(
    [PurchaseLimitEvaluationCurrentnessPort, ProfileCounterpartyRoleEligibilityResolverFactory],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([currentness, roleResolverFactory]) =>
      approvalEvidenceFactoryForCurrentness(currentness, roleResolverFactory),
    ),
  ),
);

/**
 * Production exposes the real source factory while absent #323/#333 owner integrations remain an
 * explicit typed fail-closed leaf. Deployments replace that leaf with their authoritative adapter.
 */
export const purchaseLimitPersistenceLayer = Layer.mergeAll(
  purchaseLimitPolicyServiceFactoryLayer,
  purchaseLimitEvaluationSourceFactoryLayer,
  purchaseApprovalTriggerEvidenceSourceFactoryLayer,
);

export const purchaseLimitRoutineAllowlist = Object.freeze([
  readCurrentPurchaseProposalRoutine,
  readPurchaseLimitPoliciesRoutine,
  changePurchaseLimitPolicyRoutine,
]);
