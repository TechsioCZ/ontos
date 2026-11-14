import { NodeCrypto } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase } from '../../src/db/client.ts';
import {
  DatabaseIdentityEnrollmentContext,
  defineDatabaseIdentityEnrollment,
} from '../../src/db/database-identities.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { legalEntities } from '../../src/db/schema.ts';
import { OperationalScopeResolver } from '../../src/operations/context.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';

const scope = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:read-harness-owner-services',
  authMethod: 'session',
  correlationId: 'read-harness-owner-services',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
} satisfies OperationalScope;

it.layer(NodeCrypto.layer)('Read harness owner services', (suite) => {
  suite.effect('reuses the exact captured services and the original scoped SQL transport', () =>
    Effect.scoped(
      Effect.gen(function* originalOwnerServices() {
        const enrollment = defineDatabaseIdentityEnrollment([]);
        const harness = yield* makeReadTestHarness({
          databaseIdentities: enrollment,
          executeOwnerQuery: ({ params, scope: installed, sql: statement }) => {
            expect(statement).toContain('select 42');
            expect(statement).toContain('from "core"."legal_entities"');
            expect(statement).toContain('"tenant_id" =');
            expect(statement).toContain('"legal_entity_id" =');
            expect(params).toEqual([scope.tenantId, scope.legalEntityId, 1]);
            expect(installed).toEqual({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
            return Effect.succeed([{ value: 42 }]);
          },
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T09:00:00Z')),
          scope,
        });
        const original = yield* Layer.build(harness.layer);
        const services = yield* Layer.build(harness.ownerServices);
        const repeated = yield* Layer.build(harness.ownerServices);
        const database = Context.get(services, CoreDatabase);
        expect(database).toBe(Context.get(repeated, CoreDatabase));
        expect(Context.get(services, DatabaseIdentityEnrollmentContext)).toBe(enrollment);
        expect(Context.get(services, OperationalScopeResolver)).toBe(Context.get(repeated, OperationalScopeResolver));
        expect(Context.get(services, ContextAccess)).toBe(Context.get(original, ContextAccess));
        expect(harness.snapshot().statements).toEqual([]);
        const rows = yield* database.executor.transaction((transaction) =>
          installOperationalScope(transaction, scope, Context.get(services, DatabaseIdentityEnrollmentContext)).pipe(
            Effect.flatMap((scoped) =>
              scoped
                .select({ value: sql<number>`42` })
                .from(legalEntities)
                .where(
                  and(eq(legalEntities.tenantId, scope.tenantId), eq(legalEntities.legalEntityId, scope.legalEntityId)),
                )
                .limit(1),
            ),
          ),
        );
        expect(rows).toEqual([{ value: 42 }]);
        const snapshot = harness.snapshot();
        expect(snapshot.ownerQueries).toHaveLength(1);
        expect(snapshot.statements.filter((statement) => /^begin/iu.test(statement))).toHaveLength(1);
        expect(snapshot.statements.filter((statement) => /^commit/iu.test(statement))).toHaveLength(1);
        expect(snapshot.evidenceWrites).toBe(0);
      }),
    ),
  );
});
