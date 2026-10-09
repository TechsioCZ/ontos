import { defineScopedRoutine } from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import type { OwnerVerifiableSetCompletenessEvidenceEncoded } from '@app/shared-contracts';
import { Effect, Schema } from 'effect';

import {
  CommerceQuantityRuleAssignmentSchema,
  CustomerCommercePolicyAdministrationRejected,
  MarketBootstrapPolicyBatchCurrentResponseSchema,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import type {
  CommerceQuantityAssignmentSet,
  CustomerCommercePolicySet,
  MarketBootstrapPolicyBatchCurrentResponse,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import type {
  CommerceQuantityRuleRevision,
  MarketBootstrapPolicyRevision,
  PaymentTermPolicyRevision,
  PurchaseCurrencyPolicyRevision,
} from '../../shared/domain/customer-commerce-policy.ts';
import {
  CommerceQuantityRuleRevisionSchema,
  CustomerCommercePolicyInstantSchema,
  MarketBootstrapPolicyRevisionSchema,
  PaymentTermPolicyRevisionSchema,
  PurchaseCurrencyPolicyRevisionSchema,
} from '../../shared/domain/customer-commerce-policy.ts';

const MODULE_KEY = 'commerce.customer-context';
const ROUTINE_SCHEMA = 'commerce_customer_context';
const generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const RoutineResultSchema = Schema.Struct({ result: Schema.Json });
const loadParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;
const persistParameters = [
  ...loadParameters,
  { source: 'input', type: 'bigint' },
  { source: 'input', type: 'jsonb' },
] as const;
const batchBootstrapParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'input', type: 'uuid[]' },
  { source: 'input', type: 'timestamptz' },
] as const;

/* oxlint-disable effect-native/no-unbranded-identifier-schema -- Persistence decoders mirror domain-owned identifiers that were validated before storage. */
const commandReceipt = Schema.Struct({ fingerprint: Schema.String, idempotencyKey: Schema.String });
const lifecycleTransition = Schema.Struct({
  actionInvocationId: Schema.String,
  actorPrincipalId: Schema.String,
  effectiveAt: CustomerCommercePolicyInstantSchema,
  idempotencyKey: Schema.String,
  lifecycle: Schema.Literals(['ACTIVE', 'RETIRED']),
  observedAt: CustomerCommercePolicyInstantSchema,
  reason: Schema.String,
  revisionId: Schema.String,
});

const makePolicyStateSchema = <
  const Field extends 'COMMERCE_QUANTITY_RULE' | 'MARKET_BOOTSTRAP' | 'PAYMENT_TERM' | 'PURCHASE_CURRENCY',
  Revision extends Schema.Top,
>(
  field: Field,
  revision: Revision,
) =>
  Schema.Struct({
    commandReceipts: Schema.optionalKey(Schema.Array(commandReceipt)),
    field: Schema.Literal(field),
    generation,
    lifecycleTransitions: Schema.optionalKey(Schema.Array(lifecycleTransition)),
    revisions: Schema.Array(revision),
  });

const MarketBootstrapPolicyStateSchema = makePolicyStateSchema('MARKET_BOOTSTRAP', MarketBootstrapPolicyRevisionSchema);
const PurchaseCurrencyPolicyStateSchema = makePolicyStateSchema(
  'PURCHASE_CURRENCY',
  PurchaseCurrencyPolicyRevisionSchema,
);
const PaymentTermPolicyStateSchema = makePolicyStateSchema('PAYMENT_TERM', PaymentTermPolicyRevisionSchema);
const CommerceQuantityRuleStateSchema = makePolicyStateSchema(
  'COMMERCE_QUANTITY_RULE',
  CommerceQuantityRuleRevisionSchema,
);
const CommerceQuantityAssignmentStateSchema = Schema.Struct({
  assignments: Schema.Array(CommerceQuantityRuleAssignmentSchema),
  commandReceipts: Schema.optionalKey(Schema.Array(commandReceipt)),
  generation,
  unassignments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        actionInvocationId: Schema.String,
        actorPrincipalId: Schema.String,
        assignmentId: Schema.String,
        effectiveAt: CustomerCommercePolicyInstantSchema,
        idempotencyKey: Schema.String,
        observedAt: CustomerCommercePolicyInstantSchema,
        reason: Schema.String,
      }),
    ),
  ),
});
/* oxlint-enable effect-native/no-unbranded-identifier-schema */

const loadCurrentMarketBootstrapPolicyCandidatesRoutine = defineScopedRoutine({
  name: 'load_current_market_bootstrap_policy_candidates',
  ownerModuleKey: MODULE_KEY,
  parameters: batchBootstrapParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.load-current-market-bootstrap-policy-candidates',
  schema: ROUTINE_SCHEMA,
});

const loadMarketBootstrapPolicyStateRoutine = defineScopedRoutine({
  name: 'load_market_bootstrap_policy_state',
  ownerModuleKey: MODULE_KEY,
  parameters: loadParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.load-market-bootstrap-policy-state',
  schema: ROUTINE_SCHEMA,
});
const persistMarketBootstrapPolicyStateRoutine = defineScopedRoutine({
  name: 'persist_market_bootstrap_policy_state',
  ownerModuleKey: MODULE_KEY,
  parameters: persistParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.persist-market-bootstrap-policy-state',
  schema: ROUTINE_SCHEMA,
});
const loadPurchaseCurrencyPolicyStateRoutine = defineScopedRoutine({
  name: 'load_purchase_currency_policy_state',
  ownerModuleKey: MODULE_KEY,
  parameters: loadParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.load-purchase-currency-policy-state',
  schema: ROUTINE_SCHEMA,
});
const persistPurchaseCurrencyPolicyStateRoutine = defineScopedRoutine({
  name: 'persist_purchase_currency_policy_state',
  ownerModuleKey: MODULE_KEY,
  parameters: persistParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.persist-purchase-currency-policy-state',
  schema: ROUTINE_SCHEMA,
});
const loadPaymentTermPolicyStateRoutine = defineScopedRoutine({
  name: 'load_payment_term_policy_state',
  ownerModuleKey: MODULE_KEY,
  parameters: loadParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.load-payment-term-policy-state',
  schema: ROUTINE_SCHEMA,
});
const persistPaymentTermPolicyStateRoutine = defineScopedRoutine({
  name: 'persist_payment_term_policy_state',
  ownerModuleKey: MODULE_KEY,
  parameters: persistParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.persist-payment-term-policy-state',
  schema: ROUTINE_SCHEMA,
});
const loadCommerceQuantityRuleStateRoutine = defineScopedRoutine({
  name: 'load_commerce_quantity_rule_state',
  ownerModuleKey: MODULE_KEY,
  parameters: loadParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.load-commerce-quantity-rule-state',
  schema: ROUTINE_SCHEMA,
});
const persistCommerceQuantityRuleStateRoutine = defineScopedRoutine({
  name: 'persist_commerce_quantity_rule_state',
  ownerModuleKey: MODULE_KEY,
  parameters: persistParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.persist-commerce-quantity-rule-state',
  schema: ROUTINE_SCHEMA,
});
const loadCommerceQuantityRuleAssignmentsRoutine = defineScopedRoutine({
  name: 'load_commerce_quantity_rule_assignments',
  ownerModuleKey: MODULE_KEY,
  parameters: loadParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.load-commerce-quantity-rule-assignments',
  schema: ROUTINE_SCHEMA,
});
const persistCommerceQuantityRuleAssignmentsRoutine = defineScopedRoutine({
  name: 'persist_commerce_quantity_rule_assignments',
  ownerModuleKey: MODULE_KEY,
  parameters: persistParameters,
  resultSchema: RoutineResultSchema,
  routineKey: 'customer-commerce-policy.persist-commerce-quantity-rule-assignments',
  schema: ROUTINE_SCHEMA,
});

export interface CustomerCommercePolicyScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const persistenceUnavailable = (reason: string, cause?: unknown) => {
  const failure = new CustomerCommercePolicyAdministrationRejected({
    code: 'PERSISTENCE_UNAVAILABLE',
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });
};

const invokeJson = <Result, const Parameters extends readonly ScopedRoutineParameter[]>(
  transaction: CustomerCommercePolicyScopedRoutineInvoker,
  routine: ScopedRoutineDefinition<typeof RoutineResultSchema, Parameters>,
  values: ScopedRoutineInputValues<Parameters>,
  resultSchema: Schema.Decoder<Result>,
): Effect.Effect<Result, CustomerCommercePolicyAdministrationRejected> =>
  transaction.invoke(routine, values).pipe(
    Effect.mapError((cause) =>
      persistenceUnavailable(`Customer Commerce Policy routine failed (${routine.routineKey})`, cause),
    ),
    Effect.flatMap((rows) => {
      const [row] = rows;
      return row === undefined
        ? Effect.fail(
            persistenceUnavailable(`Customer Commerce Policy routine returned no result (${routine.routineKey})`),
          )
        : Schema.decodeEffect(resultSchema)(row.result).pipe(
            Effect.mapError((cause) =>
              persistenceUnavailable(
                `Customer Commerce Policy routine returned an invalid result (${routine.routineKey})`,
                cause,
              ),
            ),
          );
    }),
    Effect.withSpan(`commerce.customer-context.${routine.routineKey}`),
  );

const JsonValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Finite,
    Schema.Boolean,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
);
const JsonObjectSchema = Schema.Record(Schema.String, JsonValueSchema);
type JsonObject = typeof JsonObjectSchema.Type;

type CustomerCommercePolicyPersistencePayload = Readonly<{
  readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
  readonly state:
    | CommerceQuantityAssignmentSet
    | CustomerCommercePolicySet<CommerceQuantityRuleRevision>
    | CustomerCommercePolicySet<MarketBootstrapPolicyRevision>
    | CustomerCommercePolicySet<PaymentTermPolicyRevision>
    | CustomerCommercePolicySet<PurchaseCurrencyPolicyRevision>;
}>;

const encodeJson = (
  value: CustomerCommercePolicyPersistencePayload,
): Effect.Effect<JsonObject, CustomerCommercePolicyAdministrationRejected> =>
  Schema.decodeUnknownEffect(JsonObjectSchema)(value).pipe(
    Effect.mapError((cause) =>
      persistenceUnavailable('Unable to encode Customer Commerce Policy persistence input', cause),
    ),
  );

const PersistAcknowledgementSchema = Schema.Struct({ applied: Schema.Literal(true) });

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The owner-local factory returns this repository contract directly for one operational scope.
export interface CustomerCommercePolicyRepository {
  readonly loadCommerceQuantityRuleAssignments: Effect.Effect<
    CommerceQuantityAssignmentSet,
    CustomerCommercePolicyAdministrationRejected
  >;
  readonly loadCommerceQuantityRuleState: Effect.Effect<
    CustomerCommercePolicySet<CommerceQuantityRuleRevision>,
    CustomerCommercePolicyAdministrationRejected
  >;
  readonly loadCurrentMarketBootstrapPolicyCandidates: (
    eligibleSellingLegalEntityIds: readonly string[],
    at: string,
  ) => Effect.Effect<MarketBootstrapPolicyBatchCurrentResponse, CustomerCommercePolicyAdministrationRejected>;
  readonly loadMarketBootstrapPolicyState: Effect.Effect<
    CustomerCommercePolicySet<MarketBootstrapPolicyRevision>,
    CustomerCommercePolicyAdministrationRejected
  >;
  readonly loadPaymentTermPolicyState: Effect.Effect<
    CustomerCommercePolicySet<PaymentTermPolicyRevision>,
    CustomerCommercePolicyAdministrationRejected
  >;
  readonly loadPurchaseCurrencyPolicyState: Effect.Effect<
    CustomerCommercePolicySet<PurchaseCurrencyPolicyRevision>,
    CustomerCommercePolicyAdministrationRejected
  >;
  readonly persistCommerceQuantityRuleAssignments: (
    expectedGeneration: number,
    value: Readonly<{
      readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
      readonly state: CommerceQuantityAssignmentSet;
    }>,
  ) => Effect.Effect<void, CustomerCommercePolicyAdministrationRejected>;
  readonly persistCommerceQuantityRuleState: (
    expectedGeneration: number,
    value: Readonly<{
      readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
      readonly state: CustomerCommercePolicySet<CommerceQuantityRuleRevision>;
    }>,
  ) => Effect.Effect<void, CustomerCommercePolicyAdministrationRejected>;
  readonly persistMarketBootstrapPolicyState: (
    expectedGeneration: number,
    value: Readonly<{
      readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
      readonly state: CustomerCommercePolicySet<MarketBootstrapPolicyRevision>;
    }>,
  ) => Effect.Effect<void, CustomerCommercePolicyAdministrationRejected>;
  readonly persistPaymentTermPolicyState: (
    expectedGeneration: number,
    value: Readonly<{
      readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
      readonly state: CustomerCommercePolicySet<PaymentTermPolicyRevision>;
    }>,
  ) => Effect.Effect<void, CustomerCommercePolicyAdministrationRejected>;
  readonly persistPurchaseCurrencyPolicyState: (
    expectedGeneration: number,
    value: Readonly<{
      readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
      readonly state: CustomerCommercePolicySet<PurchaseCurrencyPolicyRevision>;
    }>,
  ) => Effect.Effect<void, CustomerCommercePolicyAdministrationRejected>;
}

export const customerCommercePolicyRepositoryForScope = (
  transaction: CustomerCommercePolicyScopedRoutineInvoker,
  _scope: OperationalScope,
): Effect.Effect<CustomerCommercePolicyRepository> => {
  const persist = (
    routine: ScopedRoutineDefinition<typeof RoutineResultSchema, typeof persistParameters>,
    expectedGeneration: number,
    value: CustomerCommercePolicyPersistencePayload,
  ) =>
    encodeJson(value).pipe(
      Effect.flatMap((encoded) =>
        invokeJson(transaction, routine, [BigInt(expectedGeneration), encoded], PersistAcknowledgementSchema),
      ),
      Effect.asVoid,
    );

  return Effect.succeed({
    loadCommerceQuantityRuleAssignments: invokeJson(
      transaction,
      loadCommerceQuantityRuleAssignmentsRoutine,
      [],
      CommerceQuantityAssignmentStateSchema,
    ),
    loadCommerceQuantityRuleState: invokeJson(
      transaction,
      loadCommerceQuantityRuleStateRoutine,
      [],
      CommerceQuantityRuleStateSchema,
    ),
    loadCurrentMarketBootstrapPolicyCandidates: (eligibleSellingLegalEntityIds, at) =>
      invokeJson(
        transaction,
        loadCurrentMarketBootstrapPolicyCandidatesRoutine,
        [eligibleSellingLegalEntityIds, at],
        MarketBootstrapPolicyBatchCurrentResponseSchema,
      ),
    loadMarketBootstrapPolicyState: invokeJson(
      transaction,
      loadMarketBootstrapPolicyStateRoutine,
      [],
      MarketBootstrapPolicyStateSchema,
    ),
    loadPaymentTermPolicyState: invokeJson(
      transaction,
      loadPaymentTermPolicyStateRoutine,
      [],
      PaymentTermPolicyStateSchema,
    ),
    loadPurchaseCurrencyPolicyState: invokeJson(
      transaction,
      loadPurchaseCurrencyPolicyStateRoutine,
      [],
      PurchaseCurrencyPolicyStateSchema,
    ),
    persistCommerceQuantityRuleAssignments: (expectedGeneration, value) =>
      persist(persistCommerceQuantityRuleAssignmentsRoutine, expectedGeneration, value),
    persistCommerceQuantityRuleState: (expectedGeneration, value) =>
      persist(persistCommerceQuantityRuleStateRoutine, expectedGeneration, value),
    persistMarketBootstrapPolicyState: (expectedGeneration, value) =>
      persist(persistMarketBootstrapPolicyStateRoutine, expectedGeneration, value),
    persistPaymentTermPolicyState: (expectedGeneration, value) =>
      persist(persistPaymentTermPolicyStateRoutine, expectedGeneration, value),
    persistPurchaseCurrencyPolicyState: (expectedGeneration, value) =>
      persist(persistPurchaseCurrencyPolicyStateRoutine, expectedGeneration, value),
  });
};
