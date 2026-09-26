import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';

const tenantId = 'd3300000-0000-4000-8000-000000000001';
const otherTenantId = 'd3300000-0000-4000-8000-000000000002';
const legalEntityId = 'd3300000-0000-4000-8000-000000000003';
const emptyLegalEntityId = 'd3300000-0000-4000-8000-000000000004';
const actorId = 'd3300000-0000-4000-8000-000000000005';
const currencyRevisionId = 'd3310000-0000-4000-8000-000000000001';
const adjacentCurrencyRevisionId = 'd3310000-0000-4000-8000-000000000002';
const quantityRevisionId = 'd3320000-0000-4000-8000-000000000001';
const paymentTermRevisionId = 'd3320000-0000-4000-8000-000000000002';
const bootstrapRevisionId = 'd3330000-0000-4000-8000-000000000001';
const replacementBootstrapRevisionId = 'd3330000-0000-4000-8000-000000000002';
const dormantBootstrapRevisionId = 'd3330000-0000-4000-8000-000000000003';
const firstAssignmentId = 'd3340000-0000-4000-8000-000000000001';
const replacementAssignmentId = 'd3340000-0000-4000-8000-000000000002';
const replacementBoundary = '2031-01-01T00:00:00Z';

interface JsonResult extends Record<string, unknown> {
  readonly result: unknown;
}

interface PurchaseCurrencyStateResult extends Record<string, unknown> {
  readonly result: {
    readonly commandReceipts: readonly { readonly fingerprint: string; readonly idempotencyKey: string }[];
    readonly generation: number;
    readonly lifecycleTransitions: readonly { readonly revisionId: string }[];
    readonly revisions: readonly {
      readonly effectiveTo: null | string;
      readonly lifecycle: 'ACTIVE' | 'RETIRED' | 'SCHEDULED';
      readonly revisionId: string;
    }[];
  };
}

interface PaymentTermStateResult extends Record<string, unknown> {
  readonly result: {
    readonly generation: number;
    readonly revisions: readonly {
      readonly revisionId: string;
      readonly value: {
        readonly kind: string;
        readonly paymentTermRef: { readonly resourceId: string };
      };
    }[];
  };
}

interface CommerceQuantityRuleStateResult extends Record<string, unknown> {
  readonly result: {
    readonly generation: number;
    readonly revisions: readonly {
      readonly revisionId: string;
      readonly value: {
        readonly basis: {
          readonly targetDivisibilityRevision: number;
          readonly targetRef: { readonly resourceId: string };
          readonly unitRuleRevision: number;
        };
        readonly envelope: { readonly kind: string };
      };
    }[];
  };
}

interface BootstrapCandidatesResult extends Record<string, unknown> {
  readonly result: {
    readonly sellers: readonly {
      readonly candidates: readonly { readonly policyRevisionId: string }[];
      readonly completeness: {
        readonly nextApplicabilityBoundary?: unknown;
        readonly observedAt: unknown;
        readonly ownerRevision: string;
      };
    }[];
  };
}

interface RevisionIdentity extends Record<string, unknown> {
  readonly revisionId: string;
}

type CommerceCustomerContextTestDatabase = TestDatabaseFromClient<typeof commerceCustomerContextRelations>;

const one = <Row>(rows: readonly Row[]): Row => {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected one database row');
  }
  return row;
};

const scoped = <Value, Failure>(
  database: CommerceCustomerContextTestDatabase,
  operation: (transaction: CommerceCustomerContextTransaction) => Effect.Effect<Value, Failure>,
  scopeTenantId = tenantId,
  scopeLegalEntityId = legalEntityId,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* scopedOperation() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${scopeTenantId}, true),
                   set_config('ontos.legal_entity_id', ${scopeLegalEntityId}, true)`,
        'objects',
      );
      return yield* operation(transaction);
    }),
  );

const currencyRevision = (
  revisionId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  lifecycle: 'ACTIVE' | 'SCHEDULED' = 'ACTIVE',
) => ({
  actionInvocationId: actorId,
  actorPrincipalId: actorId,
  effectiveFrom,
  effectiveTo,
  field: 'PURCHASE_CURRENCY',
  idempotencyKey: `currency-${revisionId}`,
  lifecycle,
  reason: 'PostgreSQL policy acceptance',
  revisionId,
  scope: { kind: 'SELLER', sellingLegalEntityId: legalEntityId },
  tenantId,
  value: { currencyCode: 'EUR', kind: 'DEFAULT_CURRENCY' },
});

type CurrencyRevision = ReturnType<typeof currencyRevision>;

interface LifecycleTransition {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly effectiveAt: unknown;
  readonly idempotencyKey: string;
  readonly lifecycle: 'ACTIVE' | 'RETIRED';
  readonly observedAt: unknown;
  readonly reason: string;
  readonly revisionId: string;
}

const commandReceiptsThrough = (generation: number) => {
  const receipts: { readonly fingerprint: string; readonly idempotencyKey: string }[] = [];
  for (let currentGeneration = 1; currentGeneration <= generation; currentGeneration += 1) {
    receipts.push({
      fingerprint: `generation-${currentGeneration}`,
      idempotencyKey: `generation-${currentGeneration}`,
    });
  }
  return receipts;
};

const lifecycleTransition = (revisionId: string, lifecycle: LifecycleTransition['lifecycle']): LifecycleTransition => ({
  actionInvocationId: actorId,
  actorPrincipalId: actorId,
  effectiveAt: replacementBoundary,
  idempotencyKey: `${revisionId}:${lifecycle.toLowerCase()}`,
  lifecycle,
  observedAt: '2029-01-01T00:00:00Z',
  reason: 'Scheduled replacement boundary',
  revisionId,
});

const currencyPayload = (
  generation: number,
  revisions: readonly CurrencyRevision[],
  lifecycleTransitions: readonly LifecycleTransition[] = [],
) => ({
  completeness: {
    observedAt: '2029-01-01T00:00:00Z',
    ownerRevision: `PURCHASE_CURRENCY:${generation}`,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: 'commerce.customer-context.policy.purchase_currency.current',
    },
  },
  state: {
    commandReceipts: commandReceiptsThrough(generation),
    field: 'PURCHASE_CURRENCY',
    generation,
    lifecycleTransitions,
    revisions,
  },
});

type CurrencyPayload = ReturnType<typeof currencyPayload>;

const quantityAssignment = (assignmentId: string, effectiveFrom: string) => ({
  actionInvocationId: actorId,
  actorPrincipalId: actorId,
  assignmentId,
  effectiveFrom,
  effectiveTo: '2035-01-01T00:00:00Z',
  idempotencyKey: `assignment-${assignmentId}`,
  lifecycle: 'ACTIVE',
  profile: {
    kind: 'RETAIL',
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'profile-1',
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    },
  },
  reason: 'PostgreSQL assignment acceptance',
  recordedAt: '2029-01-01T00:00:00Z',
  ruleRevisionRef: {
    moduleId: 'commerce.customer-context',
    resourceId: quantityRevisionId,
    resourceType: 'commerce.customer-context.commerce-quantity-rule',
    tenantId,
  },
  sellingLegalEntityId: legalEntityId,
});

type QuantityAssignment = ReturnType<typeof quantityAssignment>;

const quantityUnassignment = (idempotencyKey: string) => ({
  actionInvocationId: actorId,
  actorPrincipalId: actorId,
  assignmentId: firstAssignmentId,
  effectiveAt: '2032-01-01T00:00:00Z',
  idempotencyKey,
  observedAt: '2029-01-01T00:00:00Z',
  reason: 'Scheduled unassignment',
});

type QuantityUnassignment = ReturnType<typeof quantityUnassignment>;

const assignmentPayload = (
  generation: number,
  assignments: readonly QuantityAssignment[],
  unassignments: readonly QuantityUnassignment[],
) => ({
  completeness: {
    observedAt: '2029-01-01T00:00:00Z',
    ownerRevision: `COMMERCE_QUANTITY_ASSIGNMENT:${generation}`,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: 'commerce.customer-context.policy.commerce_quantity_assignment.current',
    },
  },
  state: {
    assignments,
    commandReceipts: commandReceiptsThrough(generation),
    generation,
    unassignments,
  },
});

type AssignmentPayload = ReturnType<typeof assignmentPayload>;

it.live('enforces immutable temporal policy history, typed scopes, assignment integrity, and CAS persistence', () =>
  Effect.scoped(
    Effect.gen(function* postgresPolicyAcceptance() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceCustomerContextRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanPolicyFixtures() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            for (const table of [
              'market_bootstrap_policy_candidate_revisions',
              'market_bootstrap_policy_candidate_generations',
              'commerce_quantity_rule_assignments',
              'customer_commerce_policy_completeness_generations',
              'market_bootstrap_policy_revisions',
              'purchase_currency_policy_revisions',
              'payment_term_policy_revisions',
              'commerce_quantity_rule_revisions',
            ] as const) {
              yield* transaction.execute(
                sql.raw(`delete from commerce_customer_context.${table} where tenant_id = '${tenantId}'::uuid`),
              );
            }
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const firstRevision = currencyRevision(currencyRevisionId, '2030-01-01T00:00:00Z', null);
      const secondRevision = currencyRevision(adjacentCurrencyRevisionId, replacementBoundary, null, 'SCHEDULED');
      const replacementTransitions = [
        lifecycleTransition(currencyRevisionId, 'RETIRED'),
        lifecycleTransition(adjacentCurrencyRevisionId, 'ACTIVE'),
      ] as const;
      const persistCurrency = (expectedGeneration: number, payload: CurrencyPayload) =>
        scoped(runtime, (transaction) =>
          transaction.execute<JsonResult>(
            sql`select * from commerce_customer_context.persist_purchase_currency_policy_state(
                  ${tenantId}::uuid, ${legalEntityId}::uuid, ${expectedGeneration}::bigint,
                  ${JSON.stringify(payload)}::jsonb)`,
            'objects',
          ),
        );

      yield* persistCurrency(0, currencyPayload(1, [firstRevision]));
      yield* persistCurrency(1, currencyPayload(2, [firstRevision, secondRevision], replacementTransitions));

      const loaded = yield* scoped(runtime, (transaction) =>
        transaction
          .execute<PurchaseCurrencyStateResult>(
            sql`select * from commerce_customer_context.load_purchase_currency_policy_state(
                  ${tenantId}::uuid, ${legalEntityId}::uuid)`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(loaded.result).toMatchObject({ generation: 2 });
      expect(loaded.result.revisions).toHaveLength(2);
      expect(loaded.result.commandReceipts).toHaveLength(2);
      expect(loaded.result.lifecycleTransitions).toHaveLength(2);
      expect(loaded.result.revisions.find(({ revisionId }) => revisionId === currencyRevisionId)).toMatchObject({
        effectiveTo: null,
        lifecycle: 'ACTIVE',
      });

      const beforeBoundary = yield* scoped(admin, (transaction) =>
        transaction
          .execute<RevisionIdentity>(
            sql`select policy_revision_id::text as "revisionId"
                  from commerce_customer_context.purchase_currency_policy_revisions
                 where tenant_id = ${tenantId}::uuid
                   and legal_entity_id = ${legalEntityId}::uuid
                   and applicable_from <= '2030-12-31T23:59:59Z'::timestamptz
                   and (applicable_to is null or '2030-12-31T23:59:59Z'::timestamptz < applicable_to)`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      const atBoundary = yield* scoped(admin, (transaction) =>
        transaction
          .execute<RevisionIdentity>(
            sql`select policy_revision_id::text as "revisionId"
                  from commerce_customer_context.purchase_currency_policy_revisions
                 where tenant_id = ${tenantId}::uuid
                   and legal_entity_id = ${legalEntityId}::uuid
                   and applicable_from <= ${replacementBoundary}::timestamptz
                   and (applicable_to is null or ${replacementBoundary}::timestamptz < applicable_to)`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(beforeBoundary.revisionId).toBe(currencyRevisionId);
      expect(atBoundary.revisionId).toBe(adjacentCurrencyRevisionId);

      yield* scoped(admin, (transaction) =>
        transaction.execute(sql`update commerce_customer_context.purchase_currency_policy_revisions
                                   set applicable_to = '2032-01-01T00:00:00Z'
                                 where policy_revision_id = ${adjacentCurrencyRevisionId}::uuid`),
      );
      yield* scoped(admin, (transaction) =>
        transaction.execute(sql`update commerce_customer_context.purchase_currency_policy_revisions
                                   set applicable_to = null
                                 where policy_revision_id = ${adjacentCurrencyRevisionId}::uuid`),
      );

      yield* Effect.flip(
        persistCurrency(1, currencyPayload(2, [firstRevision, secondRevision], replacementTransitions)),
      );
      yield* Effect.flip(persistCurrency(2, currencyPayload(3, [secondRevision], replacementTransitions)));

      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`update commerce_customer_context.purchase_currency_policy_revisions
                                     set currency_code = 'USD'
                                   where policy_revision_id = ${currencyRevisionId}::uuid`),
        ),
      );
      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`delete from commerce_customer_context.purchase_currency_policy_revisions
                                   where policy_revision_id = ${currencyRevisionId}::uuid`),
        ),
      );
      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`insert into commerce_customer_context.purchase_currency_policy_revisions
            (policy_revision_id, tenant_id, legal_entity_id, scope_kind, channel_id, storefront_id,
             effective_from, applicable_from, lifecycle, idempotency_key, action_invocation_id, actor_principal_id,
             reason, rule_kind, currency_code)
            values (gen_random_uuid(), ${tenantId}::uuid, ${legalEntityId}::uuid,
              'STOREFRONT_CHANNEL_SELLER', 'web', 'store', '2032-01-01T00:00:00Z',
              '2032-01-01T00:00:00Z', 'ACTIVE',
              'invalid-storefront-scope', ${actorId}::uuid, ${actorId}::uuid, 'Invalid scope',
              'DEFAULT_CURRENCY', 'EUR')`),
        ),
      );
      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`insert into commerce_customer_context.purchase_currency_policy_revisions
            (policy_revision_id, tenant_id, legal_entity_id, scope_kind, effective_from, effective_to,
             applicable_from, applicable_to, lifecycle, idempotency_key, action_invocation_id,
             actor_principal_id, reason, rule_kind, currency_code)
            values (gen_random_uuid(), ${tenantId}::uuid, ${legalEntityId}::uuid, 'SELLER',
              '2030-06-01T00:00:00Z', '2030-07-01T00:00:00Z', '2030-06-01T00:00:00Z',
              '2030-07-01T00:00:00Z', 'ACTIVE', 'overlap',
              ${actorId}::uuid, ${actorId}::uuid, 'Overlap', 'DEFAULT_CURRENCY', 'USD')`),
        ),
      );
      for (const [idempotencyKey, currencyCode] of [
        ['allowed-currency-eur', 'EUR'],
        ['allowed-currency-usd', 'USD'],
      ] as const) {
        yield* scoped(admin, (transaction) =>
          transaction.execute(sql`insert into commerce_customer_context.purchase_currency_policy_revisions
            (policy_revision_id, tenant_id, legal_entity_id, scope_kind, effective_from, effective_to,
             applicable_from, applicable_to, lifecycle, idempotency_key, action_invocation_id,
             actor_principal_id, reason, rule_kind, currency_code)
            values (gen_random_uuid(), ${tenantId}::uuid, ${legalEntityId}::uuid, 'SELLER',
              '2030-06-01T00:00:00Z', '2030-07-01T00:00:00Z', '2030-06-01T00:00:00Z',
              '2030-07-01T00:00:00Z', 'ACTIVE', ${idempotencyKey},
              ${actorId}::uuid, ${actorId}::uuid, 'Allowed currency',
          'ALLOWED_CURRENCY_CONSTRAINT', ${currencyCode})`),
        );
      }

      const paymentTermPayload = {
        completeness: {
          observedAt: '2029-01-01T00:00:00Z',
          ownerRevision: 'PAYMENT_TERM:1',
          scope: {
            kind: 'EXACT_PREDICATE',
            predicateRef: 'commerce.customer-context.policy.payment_term.current',
          },
        },
        state: {
          commandReceipts: commandReceiptsThrough(1),
          field: 'PAYMENT_TERM',
          generation: 1,
          lifecycleTransitions: [],
          revisions: [
            {
              actionInvocationId: actorId,
              actorPrincipalId: actorId,
              effectiveFrom: '2041-01-01T00:00:00Z',
              effectiveTo: '2042-01-01T00:00:00Z',
              field: 'PAYMENT_TERM',
              idempotencyKey: 'payment-term-persisted',
              lifecycle: 'ACTIVE',
              reason: 'PostgreSQL Payment Term policy acceptance',
              revisionId: paymentTermRevisionId,
              scope: { kind: 'SELLER', sellingLegalEntityId: legalEntityId },
              tenantId,
              value: {
                kind: 'FALLBACK_PAYMENT_TERM',
                paymentTermRef: {
                  moduleId: 'payment.term-catalog',
                  resourceId: 'term-persisted',
                  resourceType: 'payment.term-catalog.payment-term',
                  tenantId,
                },
              },
            },
          ],
        },
      };
      yield* scoped(runtime, (transaction) =>
        transaction.execute<JsonResult>(
          sql`select * from commerce_customer_context.persist_payment_term_policy_state(
            ${tenantId}::uuid, ${legalEntityId}::uuid, 0::bigint, ${JSON.stringify(paymentTermPayload)}::jsonb)`,
          'objects',
        ),
      );
      const loadedPaymentTerm = yield* scoped(runtime, (transaction) =>
        transaction
          .execute<PaymentTermStateResult>(
            sql`select * from commerce_customer_context.load_payment_term_policy_state(
              ${tenantId}::uuid, ${legalEntityId}::uuid)`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(loadedPaymentTerm.result).toMatchObject({ generation: 1 });
      expect(loadedPaymentTerm.result.revisions).toHaveLength(1);
      expect(loadedPaymentTerm.result.revisions[0]).toMatchObject({
        revisionId: paymentTermRevisionId,
        value: {
          kind: 'FALLBACK_PAYMENT_TERM',
          paymentTermRef: { resourceId: 'term-persisted' },
        },
      });
      yield* Effect.flip(
        scoped(runtime, (transaction) =>
          transaction.execute<JsonResult>(
            sql`select * from commerce_customer_context.persist_payment_term_policy_state(
              ${tenantId}::uuid, ${legalEntityId}::uuid, 0::bigint, ${JSON.stringify(paymentTermPayload)}::jsonb)`,
            'objects',
          ),
        ),
      );

      yield* scoped(admin, (transaction) =>
        transaction.execute(sql`insert into commerce_customer_context.payment_term_policy_revisions
          (policy_revision_id, tenant_id, legal_entity_id, scope_kind, effective_from, effective_to,
           applicable_from, applicable_to, lifecycle, idempotency_key, action_invocation_id,
           actor_principal_id, reason, rule_kind, payment_term_resource_id)
          values (gen_random_uuid(), ${tenantId}::uuid, ${legalEntityId}::uuid, 'SELLER',
            '2030-01-01T00:00:00Z', '2031-01-01T00:00:00Z', '2030-01-01T00:00:00Z',
            '2031-01-01T00:00:00Z', 'ACTIVE', 'fallback-payment-term-a',
            ${actorId}::uuid, ${actorId}::uuid, 'Fallback payment term', 'FALLBACK_PAYMENT_TERM', 'term-a')`),
      );
      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`insert into commerce_customer_context.payment_term_policy_revisions
            (policy_revision_id, tenant_id, legal_entity_id, scope_kind, effective_from, effective_to,
             applicable_from, applicable_to, lifecycle, idempotency_key, action_invocation_id,
             actor_principal_id, reason, rule_kind, payment_term_resource_id)
            values (gen_random_uuid(), ${tenantId}::uuid, ${legalEntityId}::uuid, 'SELLER',
              '2030-06-01T00:00:00Z', '2030-07-01T00:00:00Z', '2030-06-01T00:00:00Z',
              '2030-07-01T00:00:00Z', 'ACTIVE', 'fallback-payment-term-b',
              ${actorId}::uuid, ${actorId}::uuid, 'Conflicting fallback', 'FALLBACK_PAYMENT_TERM', 'term-b')`),
        ),
      );
      for (const [idempotencyKey, paymentTermResourceId] of [
        ['applicable-payment-term-a', 'term-a'],
        ['applicable-payment-term-b', 'term-b'],
      ] as const) {
        yield* scoped(admin, (transaction) =>
          transaction.execute(sql`insert into commerce_customer_context.payment_term_policy_revisions
            (policy_revision_id, tenant_id, legal_entity_id, scope_kind, effective_from, effective_to,
             applicable_from, applicable_to, lifecycle, idempotency_key, action_invocation_id,
             actor_principal_id, reason, rule_kind, payment_term_resource_id)
            values (gen_random_uuid(), ${tenantId}::uuid, ${legalEntityId}::uuid, 'SELLER',
              '2030-06-01T00:00:00Z', '2030-07-01T00:00:00Z', '2030-06-01T00:00:00Z',
              '2030-07-01T00:00:00Z', 'ACTIVE', ${idempotencyKey},
              ${actorId}::uuid, ${actorId}::uuid, 'Applicable payment term',
              'APPLICABLE_PAYMENT_TERM_CONSTRAINT', ${paymentTermResourceId})`),
        );
      }
      yield* Effect.flip(
        scoped(
          runtime,
          (transaction) =>
            transaction.execute(sql`select * from commerce_customer_context.load_purchase_currency_policy_state(
              ${otherTenantId}::uuid, ${legalEntityId}::uuid)`),
          tenantId,
        ),
      );

      const bootstrapPayload = {
        completeness: {
          observedAt: '2029-01-01T00:00:00Z',
          ownerRevision: 'MARKET_BOOTSTRAP:1',
          scope: {
            kind: 'EXACT_PREDICATE',
            predicateRef: 'commerce.customer-context.policy.market_bootstrap.current',
          },
        },
        state: {
          field: 'MARKET_BOOTSTRAP',
          generation: 1,
          lifecycleTransitions: [
            lifecycleTransition(bootstrapRevisionId, 'RETIRED'),
            lifecycleTransition(replacementBootstrapRevisionId, 'ACTIVE'),
          ],
          revisions: [
            {
              actionInvocationId: actorId,
              actorPrincipalId: actorId,
              effectiveFrom: '2030-01-01T00:00:00Z',
              effectiveTo: null,
              field: 'MARKET_BOOTSTRAP',
              idempotencyKey: 'bootstrap-1',
              lifecycle: 'ACTIVE',
              reason: 'Bootstrap fixture',
              revisionId: bootstrapRevisionId,
              scope: { kind: 'SELLER', sellingLegalEntityId: legalEntityId },
              tenantId,
              value: {
                defaultChannelId: 'web',
                defaultCommerceMarketId: 'cz',
                defaultSellingLegalEntityId: legalEntityId,
                kind: 'DEFAULT_MARKET_TUPLE',
              },
            },
            {
              actionInvocationId: actorId,
              actorPrincipalId: actorId,
              effectiveFrom: replacementBoundary,
              effectiveTo: null,
              field: 'MARKET_BOOTSTRAP',
              idempotencyKey: 'bootstrap-2',
              lifecycle: 'SCHEDULED',
              reason: 'Replacement bootstrap fixture',
              revisionId: replacementBootstrapRevisionId,
              scope: { kind: 'SELLER', sellingLegalEntityId: legalEntityId },
              tenantId,
              value: {
                defaultChannelId: 'mobile',
                defaultCommerceMarketId: 'sk',
                defaultSellingLegalEntityId: legalEntityId,
                kind: 'DEFAULT_MARKET_TUPLE',
              },
            },
            {
              actionInvocationId: actorId,
              actorPrincipalId: actorId,
              effectiveFrom: '2031-03-01T00:00:00Z',
              effectiveTo: '2031-09-01T00:00:00Z',
              field: 'MARKET_BOOTSTRAP',
              idempotencyKey: 'bootstrap-dormant',
              lifecycle: 'SCHEDULED',
              reason: 'Dormant bounded bootstrap fixture',
              revisionId: dormantBootstrapRevisionId,
              scope: { channelId: 'dormant', kind: 'CHANNEL_SELLER', sellingLegalEntityId: legalEntityId },
              tenantId,
              value: {
                defaultChannelId: 'dormant',
                defaultCommerceMarketId: 'cz',
                defaultSellingLegalEntityId: legalEntityId,
                kind: 'DEFAULT_MARKET_TUPLE',
              },
            },
          ],
        },
      };
      yield* scoped(runtime, (transaction) =>
        transaction.execute(sql`select * from commerce_customer_context.persist_market_bootstrap_policy_state(
          ${tenantId}::uuid, ${legalEntityId}::uuid, 0::bigint, ${JSON.stringify(bootstrapPayload)}::jsonb)`),
      );
      const bootstrapCandidates = yield* scoped(runtime, (transaction) =>
        transaction
          .execute<BootstrapCandidatesResult>(
            sql`select * from commerce_customer_context.load_current_market_bootstrap_policy_candidates(
              ${tenantId}::uuid,
              array[${legalEntityId}::uuid, ${legalEntityId}::uuid, ${emptyLegalEntityId}::uuid],
              '2030-06-01T00:00:00Z'::timestamptz)`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      const sellerPartitions = bootstrapCandidates.result.sellers;
      expect(sellerPartitions).toHaveLength(2);
      expect(sellerPartitions[0]?.candidates).toHaveLength(1);
      expect(sellerPartitions[0]?.candidates[0]?.policyRevisionId).toBe(bootstrapRevisionId);
      expect(sellerPartitions[0]?.completeness.observedAt).toBe('2030-06-01T00:00:00+00:00');
      expect(sellerPartitions[0]?.completeness.nextApplicabilityBoundary).toBe('2031-01-01T00:00:00+00:00');
      expect(sellerPartitions[1]?.candidates).toHaveLength(0);
      expect(sellerPartitions[1]?.completeness.ownerRevision).toBe(
        `MARKET_BOOTSTRAP:${tenantId}:${emptyLegalEntityId}:0`,
      );
      const bootstrapCandidatesAtBoundary = yield* scoped(runtime, (transaction) =>
        transaction
          .execute<BootstrapCandidatesResult>(
            sql`select * from commerce_customer_context.load_current_market_bootstrap_policy_candidates(
              ${tenantId}::uuid, array[${legalEntityId}::uuid], ${replacementBoundary}::timestamptz)`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(bootstrapCandidatesAtBoundary.result.sellers[0]?.candidates[0]?.policyRevisionId).toBe(
        replacementBootstrapRevisionId,
      );
      expect(bootstrapCandidatesAtBoundary.result.sellers[0]?.completeness.observedAt).toBe(
        '2031-01-01T00:00:00+00:00',
      );
      expect(bootstrapCandidatesAtBoundary.result.sellers[0]?.completeness.nextApplicabilityBoundary).toBe(
        '2031-09-01T00:00:00+00:00',
      );

      const quantityRulePayload = {
        completeness: {
          observedAt: '2029-01-01T00:00:00Z',
          ownerRevision: 'COMMERCE_QUANTITY_RULE:1',
          scope: {
            kind: 'EXACT_PREDICATE',
            predicateRef: 'commerce.customer-context.policy.commerce_quantity_rule.current',
          },
        },
        state: {
          commandReceipts: commandReceiptsThrough(1),
          field: 'COMMERCE_QUANTITY_RULE',
          generation: 1,
          lifecycleTransitions: [],
          revisions: [
            {
              actionInvocationId: actorId,
              actorPrincipalId: actorId,
              effectiveFrom: '2030-01-01T00:00:00Z',
              effectiveTo: '2040-01-01T00:00:00Z',
              field: 'COMMERCE_QUANTITY_RULE',
              idempotencyKey: 'quantity-valid',
              lifecycle: 'ACTIVE',
              reason: 'PostgreSQL Commerce Quantity Rule acceptance',
              revisionId: quantityRevisionId,
              scope: { channelId: 'web', kind: 'CHANNEL_SELLER', sellingLegalEntityId: legalEntityId },
              tenantId,
              value: {
                basis: {
                  targetDivisibilityRevision: 1,
                  targetRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: '55555555-5555-4555-8555-555555555555',
                    resourceType: 'commerce.catalog.variant',
                    tenantId,
                  },
                  unitRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: '66666666-6666-4666-8666-666666666666',
                    resourceType: 'commerce.catalog.product-unit',
                    tenantId,
                  },
                  unitRuleRevision: 1,
                },
                constraintMode: 'REPLACEABLE_ENVELOPE',
                envelope: { kind: 'NO_COMMERCIAL_QUANTITY_RESTRICTION' },
                kind: 'COMMERCE_QUANTITY_RULE',
                selector: { kind: 'ALL' },
              },
            },
          ],
        },
      };
      yield* scoped(runtime, (transaction) =>
        transaction.execute<JsonResult>(
          sql`select * from commerce_customer_context.persist_commerce_quantity_rule_state(
            ${tenantId}::uuid, ${legalEntityId}::uuid, 0::bigint, ${JSON.stringify(quantityRulePayload)}::jsonb)`,
          'objects',
        ),
      );
      const loadedQuantityRule = yield* scoped(runtime, (transaction) =>
        transaction
          .execute<CommerceQuantityRuleStateResult>(
            sql`select * from commerce_customer_context.load_commerce_quantity_rule_state(
              ${tenantId}::uuid, ${legalEntityId}::uuid)`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(loadedQuantityRule.result).toMatchObject({ generation: 1 });
      expect(loadedQuantityRule.result.revisions).toHaveLength(1);
      expect(loadedQuantityRule.result.revisions[0]).toMatchObject({
        revisionId: quantityRevisionId,
        value: {
          basis: {
            targetDivisibilityRevision: 1,
            targetRef: { resourceId: '55555555-5555-4555-8555-555555555555' },
            unitRuleRevision: 1,
          },
          envelope: { kind: 'NO_COMMERCIAL_QUANTITY_RESTRICTION' },
        },
      });
      yield* Effect.flip(
        scoped(runtime, (transaction) =>
          transaction.execute<JsonResult>(
            sql`select * from commerce_customer_context.persist_commerce_quantity_rule_state(
              ${tenantId}::uuid, ${legalEntityId}::uuid, 0::bigint, ${JSON.stringify(quantityRulePayload)}::jsonb)`,
            'objects',
          ),
        ),
      );

      const firstAssignment = quantityAssignment(firstAssignmentId, '2030-01-01T00:00:00Z');
      const replacementAssignment = quantityAssignment(replacementAssignmentId, '2032-01-01T00:00:00Z');
      const unassignment = quantityUnassignment('unassign-first');
      const persistAssignments = (expectedGeneration: number, payload: AssignmentPayload) =>
        scoped(runtime, (transaction) =>
          transaction.execute<JsonResult>(
            sql`select * from commerce_customer_context.persist_commerce_quantity_rule_assignments(
              ${tenantId}::uuid, ${legalEntityId}::uuid, ${expectedGeneration}::bigint,
              ${JSON.stringify(payload)}::jsonb)`,
            'objects',
          ),
        );
      yield* persistAssignments(0, assignmentPayload(1, [firstAssignment], []));
      yield* persistAssignments(1, assignmentPayload(2, [firstAssignment], [unassignment]));
      yield* persistAssignments(2, assignmentPayload(3, [firstAssignment, replacementAssignment], [unassignment]));
      yield* Effect.flip(
        persistAssignments(
          3,
          assignmentPayload(
            4,
            [firstAssignment, replacementAssignment],
            [unassignment, quantityUnassignment('repeat-unassign-first')],
          ),
        ),
      );
      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`update commerce_customer_context.commerce_quantity_rule_assignments
                                     set effective_to = '2034-01-01T00:00:00Z'
                                   where quantity_rule_assignment_id = ${firstAssignmentId}::uuid`),
        ),
      );
      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`insert into commerce_customer_context.commerce_quantity_rule_revisions
            (tenant_id, legal_entity_id, scope_kind, effective_from, applicable_from, lifecycle, idempotency_key,
             action_invocation_id, actor_principal_id, reason, selector_kind, rule_kind,
             quantity_target_module_id, quantity_target_resource_type, quantity_target_resource_id,
             quantity_target_tenant_id, quantity_target_divisibility_revision, quantity_unit_module_id,
             quantity_unit_resource_type, quantity_unit_resource_id, quantity_unit_tenant_id,
             quantity_unit_rule_revision, restriction_kind)
            values (${tenantId}::uuid, ${legalEntityId}::uuid, 'SELLER', '2030-01-01T00:00:00Z',
              '2030-01-01T00:00:00Z', 'ACTIVE', 'quantity-invalid-seller',
              ${actorId}::uuid, ${actorId}::uuid, 'Invalid seller',
              'ALL', 'REPLACEABLE_ENVELOPE', 'commerce.catalog', 'commerce.catalog.variant',
              '55555555-5555-4555-8555-555555555555'::uuid, ${tenantId}::uuid, 1, 'commerce.catalog',
              'commerce.catalog.product-unit', '66666666-6666-4666-8666-666666666666'::uuid,
              ${tenantId}::uuid, 1,
              'NO_COMMERCIAL_QUANTITY_RESTRICTION')`),
        ),
      );
      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`insert into commerce_customer_context.commerce_quantity_rule_assignments
            (tenant_id, legal_entity_id, policy_revision_id, profile_kind, profile_resource_id,
             effective_from, effective_to, applicable_from, applicable_to, lifecycle,
             idempotency_key, action_invocation_id,
             actor_principal_id, reason)
            values (${tenantId}::uuid, ${legalEntityId}::uuid, ${quantityRevisionId}::uuid,
              'RETAIL', 'profile-1', '2029-01-01T00:00:00Z', '2031-01-01T00:00:00Z',
              '2029-01-01T00:00:00Z', '2031-01-01T00:00:00Z', 'ACTIVE',
              'assignment-outside-revision', ${actorId}::uuid, ${actorId}::uuid, 'Outside revision')`),
        ),
      );
      yield* Effect.flip(
        scoped(admin, (transaction) =>
          transaction.execute(sql`insert into commerce_customer_context.commerce_quantity_rule_assignments
            (tenant_id, legal_entity_id, policy_revision_id, profile_kind, profile_resource_id,
             effective_from, effective_to, applicable_from, applicable_to, lifecycle,
             idempotency_key, action_invocation_id,
             actor_principal_id, reason)
            values (${tenantId}::uuid, ${legalEntityId}::uuid, gen_random_uuid(), 'RETAIL', 'profile-1',
              '2031-01-01T00:00:00Z', '2032-01-01T00:00:00Z',
              '2031-01-01T00:00:00Z', '2032-01-01T00:00:00Z', 'ACTIVE', 'assignment-missing-rule',
              ${actorId}::uuid, ${actorId}::uuid, 'Missing rule')`),
        ),
      );
    }),
  ),
);
