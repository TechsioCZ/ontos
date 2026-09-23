import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  coreRelations,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/permissions/owner-authorization-overlay.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { toBusinessPermissionAccessKey } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { createPriceGroupAction } from '../../src/actions/create-price-group.action.ts';
import { retirePriceGroupAction } from '../../src/actions/retire-price-group.action.ts';
import {
  priceGroupCatalogLedger,
  priceGroupCatalogRelations,
  priceGroupCompatibilitySupport,
  priceGroupContainmentProjectionIntents,
  priceGroupDefinitionEffectiveIntervals,
  priceGroupDefinitionRevisions,
  priceGroupRetirements,
  priceGroups,
} from '../../src/database/schema.ts';

const tenantId = randomUUID();
const principalId = randomUUID();
const authBindingId = randomUUID();
const authenticationNamespaceId = 'test.price-group-management-action.v1';
const principal = {
  authBindingId,
  authContextRef: `better-auth-session:${authBindingId}`,
  authenticationNamespaceId,
  authMethod: 'session' as const,
  principalId,
  tenantId,
};

interface DatabaseClockRow extends Record<string, unknown> {
  readonly currentTime: Date;
}

const allowedPermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

const contextAccess: ContextAccessService = {
  businessPermissions: (input) =>
    Effect.succeed(
      input.targets.map((target) => ({
        decision: 'allowed' as const,
        key: toBusinessPermissionAccessKey(target),
      })),
    ),
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

it.live('commits a scheduled retirement with server-trusted acceptance chronology through the Action runtime', () =>
  Effect.scoped(
    Effect.gen(function* scheduledRetirementAction() {
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, priceGroupCatalogRelations);
      const database = yield* makeTestDatabaseFromPool(runtimePool, coreRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanupTenant() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.delete(priceGroupRetirements).where(eq(priceGroupRetirements.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupCompatibilitySupport)
              .where(eq(priceGroupCompatibilitySupport.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupContainmentProjectionIntents)
              .where(eq(priceGroupContainmentProjectionIntents.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupDefinitionEffectiveIntervals)
              .where(eq(priceGroupDefinitionEffectiveIntervals.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupDefinitionRevisions)
              .where(eq(priceGroupDefinitionRevisions.tenantId, tenantId));
            yield* transaction.delete(priceGroups).where(eq(priceGroups.tenantId, tenantId));
            yield* transaction.delete(priceGroupCatalogLedger).where(eq(priceGroupCatalogLedger.tenantId, tenantId));
            yield* transaction.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
            yield* transaction.delete(principals).where(eq(principals.tenantId, tenantId));
            yield* transaction.delete(tenants).where(eq(tenants.tenantId, tenantId));
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* admin.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Scheduled retirement Action integration',
        slug: `scheduled-retirement-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* admin.insert(principals).values({
        displayName: 'Scheduled retirement operator',
        kind: 'human',
        principalId,
        status: 'active',
        tenantId,
      });
      yield* admin.insert(principalAuthBindings).values({
        authenticationNamespaceId,
        principalAuthBindingId: authBindingId,
        principalId,
        provider: 'better_auth',
        providerSubjectId: `scheduled-retirement-${principalId}`,
        status: 'active',
        subjectType: 'user',
        tenantId,
      });

      const runtime = makeActionRuntime(
        { executor: database },
        makeActionRepository(),
        allowedPermission,
        testOperationalScopeResolver,
        {
          ...openActionRuntimeOptions,
          contextAccess,
          ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
        },
      );
      const [clock] = yield* admin.execute<DatabaseClockRow>(sql`select clock_timestamp() as "currentTime"`, 'objects');
      if (clock === undefined) {
        throw new Error('Expected the database clock');
      }
      const now = DateTime.fromDateUnsafe(clock.currentTime);
      const effectiveFrom = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
      const retirementEffectiveAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
      const created = yield* runtime.runAction({
        payload: {
          businessCode: 'SCHEDULED_RETIREMENT',
          classificationPurpose: 'Proves scheduled Price Group retirement chronology.',
          compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
          description: 'Price Group created for the scheduled retirement Action regression.',
          displayName: 'Scheduled retirement',
          effectiveFrom,
          effectiveTo: null,
          expectedCatalogRevision: 0,
          meaningFingerprint: 'a'.repeat(64),
          reason: 'Create the Price Group used by the scheduled retirement proof.',
        },
        principal,
        registration: createPriceGroupAction,
        transport: {
          correlationId: 'scheduled-retirement-create',
          idempotencyKey: 'scheduled-retirement-create',
        },
      });
      const expectedCurrent = {
        catalogRevision: created.definition.acceptedCatalogRevision,
        definitionRevisionId: created.definition.definitionRevisionId,
        definitionRevisionNumber: created.definition.revisionNumber,
        meaningFingerprint: created.definition.meaningFingerprint,
        priceGroupRef: created.definition.priceGroupRef,
      };

      const accepted = yield* runtime.runAction({
        payload: {
          effectiveAt: retirementEffectiveAt,
          expectedCurrent,
          reason: 'Schedule retirement after server-trusted acceptance.',
        },
        principal,
        registration: retirePriceGroupAction,
        transport: {
          correlationId: 'scheduled-retirement-accept',
          idempotencyKey: 'scheduled-retirement-accept',
        },
      });
      const [persistedRetirement] = yield* admin
        .select()
        .from(priceGroupRetirements)
        .where(
          and(
            eq(priceGroupRetirements.tenantId, tenantId),
            eq(priceGroupRetirements.actionInvocationId, accepted.retirementProvenance.actionInvocationId),
          ),
        );
      const [persistedLedger] = yield* admin
        .select()
        .from(priceGroupCatalogLedger)
        .where(
          and(
            eq(priceGroupCatalogLedger.tenantId, tenantId),
            eq(priceGroupCatalogLedger.actionInvocationId, accepted.retirementProvenance.actionInvocationId),
          ),
        );

      expect(persistedRetirement).toBeDefined();
      expect(persistedLedger).toBeDefined();
      if (persistedRetirement === undefined || persistedLedger === undefined) {
        throw new Error('Expected committed retirement and ledger evidence');
      }
      expect(accepted.retirementEffectiveAt).toBe(retirementEffectiveAt);
      expect(persistedRetirement.effectiveAt.toISOString()).toBe(retirementEffectiveAt);
      expect(Date.parse(accepted.retirementEffectiveAt)).toBeGreaterThan(
        Date.parse(accepted.retirementProvenance.trustedAt),
      );
      expect(accepted.retirementProvenance.trustedAt).toBe(accepted.trustedOperationAt);
      expect(Date.parse(accepted.trustedOperationAt)).toBeLessThanOrEqual(Date.parse(accepted.verifiedAt));
      expect(persistedLedger.trustedEffectiveAt.toISOString()).toBe(accepted.retirementProvenance.trustedAt);
      expect(Date.parse(accepted.retirementProvenance.trustedAt)).toBeLessThanOrEqual(
        persistedRetirement.recordedAt.getTime(),
      );
      expect(persistedRetirement.recordedAt.getTime()).toBe(Date.parse(accepted.verifiedAt));
    }),
  ),
);
