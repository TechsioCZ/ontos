import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { catalogRelations, products, productTypeUntypedDecisions } from '../../src/database/schema.ts';
import type { CatalogTransaction } from '../../src/database/types.ts';
import { productTypeUntypedDecisionPersistenceForScope } from '../../src/persistence/product-type-untyped-decision-persistence.ts';
import { DecideProductTypeUnnecessaryPayloadSchema } from '../../shared/actions/decide-product-type-unnecessary.ts';

// Append-only evidence belongs to fresh Tenant namespaces in the disposable integration database.
const tenantId = randomUUID();
const foreignTenantId = randomUUID();
const productId = randomUUID();
const principalId = randomUUID();

const scopeFor = (scopedTenantId: string) => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-type-untyped-postgres:run:1',
    authMethod: 'system',
    principalId,
    tenantId: scopedTenantId,
  }),
  correlationId: 'product-type-untyped-postgres',
});

const payloadFor = (decisionState: 'CONFIRMED' | 'REVOKED', expectedDecisionRevision: number) =>
  Schema.decodeUnknownSync(DecideProductTypeUnnecessaryPayloadSchema)({
    decisionState,
    evidenceRefs: ['catalog-review:postgres-proof'],
    expectedAxisRevision: 0,
    expectedDecisionRevision,
    expectedProductRevision: 1,
    expectedValueRevisionTokens: [],
    expectedVariantRevisionTokens: [],
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: productId,
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    reason: 'No structured attributes or variant axes required',
    structuredAttributesRequired: false,
    variantAxesRequired: false,
  });

it.live('appends and isolates explicit Product Type absence decisions in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* productTypeUntypedDecisionPostgres() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, catalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, catalogRelations);
      const withTenant = <Value, Failure>(
        scopedTenantId: string,
        operation: (transaction: CatalogTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedDecisionTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${scopedTenantId}, true)`, 'objects');
            return yield* operation(transaction);
          }),
        );
      const decide = (
        scopedTenantId: string,
        decisionState: 'CONFIRMED' | 'REVOKED',
        expectedDecisionRevision: number,
      ) =>
        withTenant(scopedTenantId, (transaction) =>
          Effect.gen(function* persistDecision() {
            const service = yield* productTypeUntypedDecisionPersistenceForScope(
              // @ts-expect-error The real Drizzle transaction lacks only Core's private scope brand.
              transaction,
              scopeFor(scopedTenantId),
            );
            return yield* service.decide({
              actionInvocationId: randomUUID(),
              payload: payloadFor(decisionState, expectedDecisionRevision),
              principalId,
            });
          }),
        );

      yield* admin.insert(products).values({
        createdByActionInvocationId: randomUUID(),
        createdByPrincipalId: principalId,
        productId,
        tenantId,
      });

      expect(yield* decide(tenantId, 'CONFIRMED', 0)).toMatchObject({
        decisionRevision: 1,
        decisionState: 'CONFIRMED',
      });
      const confirmed = yield* admin
        .select()
        .from(productTypeUntypedDecisions)
        .where(
          and(eq(productTypeUntypedDecisions.tenantId, tenantId), eq(productTypeUntypedDecisions.productId, productId)),
        );
      expect(confirmed).toMatchObject([{ decisionRevision: 1, decisionState: 'CONFIRMED', productId, tenantId }]);

      const failureTag = (scopedTenantId: string, decisionState: 'CONFIRMED' | 'REVOKED', revision: number) =>
        decide(scopedTenantId, decisionState, revision).pipe(
          Effect.match({
            onFailure: (failure) => failure._tag,
            onSuccess: () => 'unexpected_success',
          }),
        );
      expect(yield* failureTag(tenantId, 'CONFIRMED', 0)).toBe('ProductTypeUntypedDecisionRejected');
      expect(yield* failureTag(foreignTenantId, 'REVOKED', 1)).toBe('ProductTypeUntypedDecisionRejected');

      expect(yield* decide(tenantId, 'REVOKED', 1)).toMatchObject({
        decisionRevision: 2,
        decisionState: 'REVOKED',
      });
      const history = yield* admin
        .select()
        .from(productTypeUntypedDecisions)
        .where(
          and(eq(productTypeUntypedDecisions.tenantId, tenantId), eq(productTypeUntypedDecisions.productId, productId)),
        )
        .orderBy(desc(productTypeUntypedDecisions.decisionRevision));
      expect(history.at(0)).toMatchObject({ decisionRevision: 2, decisionState: 'REVOKED' });
      expect(history.map(({ decisionRevision, decisionState }) => ({ decisionRevision, decisionState }))).toEqual([
        { decisionRevision: 2, decisionState: 'REVOKED' },
        { decisionRevision: 1, decisionState: 'CONFIRMED' },
      ]);
      expect(
        yield* withTenant(foreignTenantId, (transaction) => transaction.select().from(productTypeUntypedDecisions)),
      ).toEqual([]);
      const runtimeRole = yield* runtime.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
        sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
        'objects',
      );
      expect(runtimeRole).toEqual([{ rolbypassrls: false, rolsuper: false }]);
    }),
  ),
);
