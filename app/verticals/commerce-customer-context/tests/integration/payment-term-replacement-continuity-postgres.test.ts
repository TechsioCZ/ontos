import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PaymentTermDefinitionSchema } from '@app/payment-term-catalog-contracts/payment-term';
import { sql } from 'drizzle-orm';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { paymentTermCatalogPort } from '../../src/integrations/payment-term-catalog.ts';
import { makePaymentTermsResolutionServices } from '../../src/persistence/payment-term-persistence.ts';
import { CustomerPaymentTermsStateSchema } from '../../shared/domain/payment-term-contracts.ts';
import { changeCustomerPaymentTerms } from '../../shared/domain/payment-terms.ts';

const tenantId = 'd3350000-0000-4000-8000-000000000001';
const legalEntityId = 'd3350000-0000-4000-8000-000000000002';
const principalId = 'd3350000-0000-4000-8000-000000000003';
const profileId = 'd3350000-0000-4000-8000-000000000004';
const actionInvocationId = 'd3350000-0000-4000-8000-000000000005';
const at = '2030-01-01T00:00:00.000Z';
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const scope = {
  authBindingId: 'd3350000-0000-4000-8000-000000000013',
  authContextRef: 'issue-1143-ccc-test-context',
  authMethod: 'session',
  correlationId: 'issue-1143-ccc-replacement',
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope & { readonly legalEntityId: string };
const provenance = { actionInvocationId, actorPrincipalId: principalId, at, reason: 'Public owner catalog fixture' };

const original = Schema.decodeUnknownSync(PaymentTermDefinitionSchema)({
  code: 'NET_14',
  compatibilityId: 'net_days.invoice_issue_date.calendar_days.v2',
  created: provenance,
  definitionRevisionId: 'd3350000-0000-4000-8000-000000000006',
  description: 'Fourteen calendar days after invoice issue DATE',
  lifecycle: { effectiveFrom: at, effectiveTo: null, state: 'ACTIVE' },
  metadataRevision: 1,
  name: 'Net 14',
  paymentTermRef: {
    moduleId: 'payment.term-catalog',
    resourceId: 'd3350000-0000-4000-8000-000000000007',
    resourceType: 'payment.term-catalog.payment-term',
    tenantId,
  },
  retired: null,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: 'd3350000-0000-4000-8000-000000000008',
  semantics: {
    calculationRuleVersion: 2,
    calendarRule: 'CALENDAR_DAYS',
    days: 14,
    dueDateAnchor: 'INVOICE_ISSUE_DATE',
    kind: 'NET_DAYS',
  },
  updated: provenance,
});
const replacement = Schema.decodeUnknownSync(PaymentTermDefinitionSchema)({
  ...original,
  code: 'NET_30',
  definitionRevisionId: 'd3350000-0000-4000-8000-000000000009',
  name: 'Net 30',
  paymentTermRef: { ...original.paymentTermRef, resourceId: 'd3350000-0000-4000-8000-000000000010' },
  semanticFingerprint: 'b'.repeat(64),
  semanticRevisionId: 'd3350000-0000-4000-8000-000000000011',
  semantics: { ...original.semantics, days: 30 },
});

interface RoutineRow extends Record<string, unknown> {
  readonly current_revision: number;
  readonly outcome: string;
  readonly payload: unknown;
}

// This proves real CCC assignment persistence and the public owner catalog boundary.
// Qualified ERP source acceptance is independently covered inside the Payment Term owner.
it.live('keeps persisted fourteen-day entitlement and preference after a thirty-day owner replacement', () =>
  Effect.scoped(
    Effect.gen(function* persistedReplacementContinuity() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceCustomerContextRelations);
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanCustomerFixture() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            for (const table of [
              'customer_payment_term_entitlements',
              'customer_payment_term_preferences',
              'customer_setting_revisions',
              'retail_customer_profiles',
              'customer_profiles',
            ] as const) {
              yield* transaction.execute(sql`delete from ${sql.identifier('commerce_customer_context')}.${sql.identifier(table)}
          where tenant_id = ${tenantId}::uuid`);
            }
          }),
        );
      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* admin.transaction((transaction) =>
        Effect.gen(function* createCustomerFixture() {
          yield* transaction.execute(sql`insert into commerce_customer_context.customer_profiles
        (customer_profile_id, tenant_id, legal_entity_id, profile_kind, lifecycle, revision)
        values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL', 'ACTIVE', 1)`);
          yield* transaction.execute(sql`insert into commerce_customer_context.retail_customer_profiles
        (retail_customer_profile_id, tenant_id, legal_entity_id, party_resource_id)
        values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'issue-1143-retail-party')`);
        }),
      );
      const initialState = Schema.decodeUnknownSync(CustomerPaymentTermsStateSchema)({
        entitlements: [],
        preferences: [],
        profileRef,
        revision: 1,
      });
      const assignment = changeCustomerPaymentTerms({
        catalogDefinitions: [original],
        changes: [
          {
            _tag: 'GRANT_ENTITLEMENT',
            effectiveFrom: at,
            entitlementRef: {
              moduleId: 'commerce.customer-context',
              resourceId: 'd3350000-0000-4000-8000-000000000012',
              resourceType: 'commerce.customer-context.customer-payment-term-entitlement',
              tenantId,
            },
            paymentTermRef: original.paymentTermRef,
            semanticRevisionId: original.semanticRevisionId,
          },
          { _tag: 'SET_PREFERENCE', effectiveFrom: at, paymentTermRef: original.paymentTermRef },
        ],
        expectedRevision: 1,
        state: initialState,
      });
      expect(Predicate.isTagged(assignment, 'CHANGED')).toBe(true);
      if (!Predicate.isTagged(assignment, 'CHANGED')) {
        return;
      }
      const persistInput = {
        actionInvocationId,
        changed: true,
        counterpartyResourceId: null,
        expectedRevision: 1,
        principalId,
        profileKind: 'RETAIL',
        profileResourceId: profileId,
        reason: 'Assign existing fourteen-day term',
        state: assignment.state,
      };
      yield* runtime.transaction((transaction) =>
        Effect.gen(function* persistOriginalAssignment() {
          yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true),
        set_config('ontos.legal_entity_id', ${legalEntityId}, true)`);
          const rows = yield* transaction.execute<RoutineRow>(
            sql`select * from commerce_customer_context.persist_customer_payment_terms(
        ${tenantId}::uuid, ${legalEntityId}::uuid, ${JSON.stringify(persistInput)}::jsonb)`,
            'objects',
          );
          expect(rows[0]?.outcome).toBe('APPLIED');
        }),
      );
      const catalog = paymentTermCatalogPort(scope.correlationId, (payload) =>
        Effect.succeed({
          current: [replacement],
          effectiveAt: payload.at,
          observedAt: payload.at,
          referenceOutcomes: payload.references.map(({ paymentTermRef }) => ({
            definition: paymentTermRef.resourceId === original.paymentTermRef.resourceId ? original : replacement,
            kind: 'USABLE',
            requestedPaymentTermRef: paymentTermRef,
          })),
          truncated: false,
        }),
      );
      const resolved = yield* runtime.transaction((transaction) =>
        Effect.gen(function* resolvePersistedOriginal() {
          yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true),
        set_config('ontos.legal_entity_id', ${legalEntityId}, true)`);
          const invoker = scopedRoutineInvokerFromTransaction(
            (statement) => transaction.execute<Record<string, never>>(statement, 'objects'),
            scope,
          );
          const services = makePaymentTermsResolutionServices(
            { invoker, scope },
            {
              catalog,
              policy: {
                resolve: () =>
                  Effect.succeed({
                    eligiblePaymentTermRefs: [original.paymentTermRef, replacement.paymentTermRef],
                    explicitlyPermittedPaymentTermRefs: [],
                    fallbackPaymentTermRefs: [replacement.paymentTermRef],
                    policyRevision: 'policy-v1',
                    policySource: 'CCC policy fixture',
                  }),
              },
            },
          );
          return yield* services.resolve({
            at,
            authorizationSubject: { kind: 'RETAIL' },
            profileRef,
            purchasingContext: {
              channelId: 'web',
              contextRevision: 'context-v1',
              marketId: 'cz',
              sellingLegalEntityId: legalEntityId,
              storefrontId: 'main',
            },
          });
        }),
      );
      expect(Predicate.isTagged(resolved, 'PREFERRED_ENTITLEMENT')).toBe(true);
      if (Predicate.isTagged(resolved, 'PREFERRED_ENTITLEMENT')) {
        expect(resolved.definition).toMatchObject({
          paymentTermRef: original.paymentTermRef,
          semanticRevisionId: original.semanticRevisionId,
          semantics: { calculationRuleVersion: 2, days: 14 },
        });
      }
      const retained = yield* runtime.transaction((transaction) =>
        Effect.gen(function* rereadPersistedAssignment() {
          yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true),
        set_config('ontos.legal_entity_id', ${legalEntityId}, true)`);
          const rows = yield* transaction.execute<RoutineRow>(
            sql`select * from commerce_customer_context.read_customer_payment_terms(
        ${tenantId}::uuid, ${legalEntityId}::uuid, ${profileId}::uuid, 'RETAIL'::text, null::text)`,
            'objects',
          );
          return yield* Schema.decodeUnknownEffect(CustomerPaymentTermsStateSchema)(rows[0]?.payload);
        }),
      );
      expect(retained).toEqual(assignment.state);
      expect(retained.entitlements[0]?.paymentTermRef).toEqual(original.paymentTermRef);
      expect(retained.entitlements[0]?.semanticRevisionId).toBe(original.semanticRevisionId);
      expect(retained.preferences[0]?.paymentTermRef).toEqual(original.paymentTermRef);
      expect(replacement.paymentTermRef).not.toEqual(original.paymentTermRef);
      expect(replacement.semantics).toMatchObject({ days: 30 });
      expect(original.semantics).toMatchObject({ days: 14 });
    }),
  ),
);
