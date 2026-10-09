import { randomUUID } from 'node:crypto';

import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';
import { RetailPurchasingSubjectCurrentV1RequestSchema } from '../../shared/apis/retail-purchasing-subject-current-v1.ts';
import type { RetailPurchasingSubjectCurrentV1Response } from '../../shared/apis/retail-purchasing-subject-current-v1.ts';
import { VerifyRetailPurchasingSubjectCurrentV1RequestSchema } from '../../shared/apis/verify-retail-purchasing-subject-current-v1.ts';
import type { VerifyRetailPurchasingSubjectCurrentV1Response } from '../../shared/apis/verify-retail-purchasing-subject-current-v1.ts';
import { readRetailPurchasingSubjectCurrentV1 } from '../../src/api/retail-purchasing-subject-current-v1.read.ts';
import { verifyRetailPurchasingSubjectCurrentV1 } from '../../src/api/verify-retail-purchasing-subject-current-v1.read.ts';
import { profilePersistenceServicesForTransaction } from '../../src/persistence/profile-persistence.ts';

const schemaName = 'commerce_customer_context';

interface RoutineRow extends Record<string, unknown> {
  readonly outcome: string;
  readonly payload: { readonly profileRef?: { readonly resourceId: string } } | null;
}

const outcome = (result: RetailPurchasingSubjectCurrentV1Response | VerifyRetailPurchasingSubjectCurrentV1Response) =>
  Match.value(result).pipe(
    Match.tag('CURRENT', () => 'CURRENT'),
    Match.tag('STALE', () => 'STALE'),
    Match.tag('UNAVAILABLE', () => 'UNAVAILABLE'),
    Match.exhaustive,
  );

const servicesFor = (
  transaction: CommerceCustomerContextTransaction,
  transactionScope: {
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  },
) => {
  const invoker = scopedRoutineInvokerFromTransaction(
    (statement) => transaction.execute<Record<string, never>>(statement, 'objects'),
    transactionScope,
  );
  const persistence = profilePersistenceServicesForTransaction(invoker, transactionScope);
  return { retailPrincipalResolution: persistence.retailPrincipalResolution };
};

it.live('verifies a Retail purchasing subject against committed owner binding rows', () =>
  Effect.scoped(
    Effect.gen(function* postgresOwnerProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceCustomerContextRelations);

      const tenantId = randomUUID();
      const legalEntityId = randomUUID();
      const principalId = randomUUID();
      const otherPrincipalId = randomUUID();
      const actionInvocationId = randomUUID();
      const authBindingId = randomUUID();
      const at = '2026-09-28T10:00:00.000Z';
      const scope = { legalEntityId, principalId, tenantId } as const;
      const partyResourceId = `retail-subject-proof-${randomUUID()}`;

      const inScope = <Value, Failure>(
        transactionScope: { readonly legalEntityId: string; readonly tenantId: string },
        operation: (transaction: CommerceCustomerContextTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* runInScope() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${transactionScope.tenantId}, true), set_config('ontos.legal_entity_id', ${transactionScope.legalEntityId}, true)`,
              'objects',
            );
            return yield* operation(transaction);
          }),
        );

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanupFixture() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.execute(
              sql`delete from ${sql.identifier(schemaName)}.retail_portal_profile_binding_history where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from ${sql.identifier(schemaName)}.retail_portal_profile_bindings where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from ${sql.identifier(schemaName)}.customer_profile_lifecycle_history where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from ${sql.identifier(schemaName)}.retail_customer_profiles where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from ${sql.identifier(schemaName)}.customer_profiles where tenant_id = ${tenantId}::uuid`,
            );
          }),
        );

      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const profileResourceId = yield* inScope(scope, (transaction) =>
        Effect.gen(function* createOwnerRows() {
          const ensured = yield* transaction.execute<RoutineRow>(
            sql`select * from ${sql.identifier(schemaName)}.ensure_retail_profile(
              ${tenantId}::uuid, ${legalEntityId}::uuid, ${partyResourceId}::text, null::text,
              'AUTHENTICATED'::text, ${at}::timestamptz, 'AUTHORIZED_ONBOARDING'::text,
              ${actionInvocationId}::uuid, ${principalId}::uuid
            )`,
            'objects',
          );
          const [ensuredRow] = ensured;
          expect(ensuredRow?.outcome).toBe('PROFILE_CREATED');
          const createdProfileResourceId = ensuredRow?.payload?.profileRef?.resourceId;
          expect(createdProfileResourceId).toBeDefined();
          if (createdProfileResourceId === undefined) {
            throw new Error('The Retail profile owner routine returned no profile reference');
          }

          const bound = yield* transaction.execute<RoutineRow>(
            sql`select * from ${sql.identifier(schemaName)}.mutate_retail_portal_binding(
              ${tenantId}::uuid, ${legalEntityId}::uuid, ${createdProfileResourceId}::uuid,
              ${principalId}::uuid, ${authBindingId}::uuid, 'owner-proof-enrollment'::text,
              null::text, null::integer, 'BIND'::text, ${at}::timestamptz,
              'PostgreSQL owner proof fixture'::text, ${randomUUID()}::uuid, ${principalId}::uuid
            )`,
            'objects',
          );
          expect(bound[0]?.outcome).toBe('BINDING_ACTIVATED');
          return createdProfileResourceId;
        }),
      );

      const profileRef = {
        moduleId: 'commerce.customer-context',
        resourceId: profileResourceId,
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId,
      } as const;
      const currentRequest = Schema.decodeUnknownSync(RetailPurchasingSubjectCurrentV1RequestSchema)({ profileRef });
      const observed = yield* inScope(scope, (transaction) =>
        readRetailPurchasingSubjectCurrentV1(currentRequest, scope, servicesFor(transaction, scope)),
      );
      const observedProof = Match.value(observed).pipe(
        Match.tag('CURRENT', ({ proof }) => proof),
        Match.tag('STALE', () => null),
        Match.tag('UNAVAILABLE', () => null),
        Match.exhaustive,
      );
      expect(observedProof).not.toBeNull();
      if (observedProof === null) {
        return;
      }

      const verifyRequest = Schema.decodeUnknownSync(VerifyRetailPurchasingSubjectCurrentV1RequestSchema)({
        observedProof,
        profileRef,
      });
      const beforeRevoke = yield* inScope(scope, (transaction) =>
        verifyRetailPurchasingSubjectCurrentV1(verifyRequest, scope, servicesFor(transaction, scope)),
      );
      expect(outcome(beforeRevoke)).toBe('CURRENT');

      const absentPrincipalScope = { ...scope, principalId: otherPrincipalId };
      const absentPrincipal = yield* inScope(absentPrincipalScope, (transaction) =>
        readRetailPurchasingSubjectCurrentV1(
          currentRequest,
          absentPrincipalScope,
          servicesFor(transaction, absentPrincipalScope),
        ),
      );
      expect(outcome(absentPrincipal)).toBe('STALE');
    }),
  ),
);
