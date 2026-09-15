import {
  findPostgresFailure,
  loadDatabaseConnectionPair,
  scopedRoutineInvokerFromTransaction,
} from '@app/core-runtime';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  acquireTestPool,
  makeTestDatabaseFromPool,
  privacyMeasureDeferredCases,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  commerceCustomerContextRelations,
  customerProfileLifecycleHistory,
  customerProfiles,
  privacyMeasureExecutions,
} from '../../src/database/schema.ts';
import { privacyMeasureExecutionService } from '../../src/services/privacy-measure-execution.service.ts';

const tenantId = 'f1000000-0000-4000-8000-000000000001';
const legalEntityId = 'f2000000-0000-4000-8000-000000000002';
const principalId = 'f3000000-0000-4000-8000-000000000003';
const profileId = 'f4000000-0000-4000-8000-000000000004';
const firstInvocationId = 'f5000000-0000-4000-8000-000000000005';
const replayInvocationId = 'f5000000-0000-4000-8000-000000000006';

const handoff: PrivacyMeasureHandoff = {
  contentScopeRefs: ['commerce.customer-context.customer-profile.lifecycle'],
  controllerObligationRef: 'obligation:commerce-owner-postgres',
  dispositionDecision: 'RESTRICT',
  expectedEvidenceRefs: ['commerce.customer-context.customer-profile.restricted'],
  idempotencyKey: 'commerce-owner-postgres:1',
  kind: 'RESTRICT',
  measureId: 'measure:commerce-owner-postgres',
  owningCapability: 'commerce.customer-context',
  preconditionRefs: ['decision:commerce-owner-postgres'],
  requestedAt: '2026-09-14T10:00:00.000Z',
  requestedResult: 'RESTRICTED',
  resourceRefs: [
    `commerce.customer-context|commerce.customer-context.retail-customer-profile|${legalEntityId}|${profileId}`,
  ],
  right: null,
  sourceDecisionRef: 'decision:commerce-owner-postgres',
  sourceDecisionRevision: 1,
  subjectRef: 'subject:commerce-owner-postgres',
  taskId: 'task:commerce-owner-postgres',
  tenantId,
};

it.live('records unsupported Commerce measures without changing canonical lifecycle state', () =>
  Effect.scoped(
    Effect.gen(function* commercePrivacyMeasurePostgresAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* acquireTestPool(connections.admin.connectionString);
      const runtimePool = yield* acquireTestPool(connections.runtime.connectionString);
      const admin = yield* makeTestDatabaseFromPool(adminPool, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, commerceCustomerContextRelations);
      const scope = {
        authMethod: 'system' as const,
        correlationId: 'commerce-owner-postgres',
        legalEntityId,
        principalId,
        tenantId,
      };
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanCommerceOwnerFixture() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.delete(privacyMeasureExecutions).where(eq(privacyMeasureExecutions.tenantId, tenantId));
            yield* transaction
              .delete(customerProfileLifecycleHistory)
              .where(eq(customerProfileLifecycleHistory.tenantId, tenantId));
            yield* transaction.delete(customerProfiles).where(eq(customerProfiles.tenantId, tenantId));
          }),
        );
      const execute = (actionInvocationId: string, input = handoff) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* executeInScope() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            const invoker = scopedRoutineInvokerFromTransaction(
              // oxlint-disable-next-line sonarjs/no-nested-functions -- This transaction-bound adapter must close over the current runtime transaction to preserve atomic scoped-routine execution.
              (statement) => transaction.execute(statement, 'objects'),
              scope,
            );
            const service = yield* privacyMeasureExecutionService(invoker, scope);
            return yield* service.execute(input, actionInvocationId);
          }),
        );
      const transitionLifecycle = (
        targetState: 'ACTIVE' | 'SUSPENDED',
        actionInvocationId: string,
        expectedRevision: number,
        expectedState: 'ACTIVE' | 'SUSPENDED',
        effectiveAt: string,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* transitionInScope() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            yield* transaction.execute(
              sql`select * from commerce_customer_context.transition_profile(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${profileId}::uuid,
                'RETAIL',
                ${expectedState},
                ${expectedRevision},
                ${targetState},
                ${effectiveAt}::timestamptz,
                ${`Owner-approved ${targetState.toLowerCase()} transition`},
                true,
                true,
                ${actionInvocationId}::uuid,
                ${principalId}::uuid
              )`,
              'objects',
            );
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* admin.insert(customerProfiles).values({
        customerProfileId: profileId,
        legalEntityId,
        profileKind: 'RETAIL',
        tenantId,
      });
      yield* admin.insert(customerProfileLifecycleHistory).values({
        actionInvocationId: firstInvocationId,
        actorPrincipalId: principalId,
        customerProfileId: profileId,
        fromLifecycle: null,
        legalEntityId,
        reason: 'Commerce owner PostgreSQL fixture',
        revision: 1,
        tenantId,
        toLifecycle: 'ACTIVE',
      });

      const first = yield* execute(firstInvocationId);
      const replay = yield* execute(replayInvocationId);
      expect(first.status).toBe('BUSINESS_REJECTED');
      expect(first.includedResourceRefs).toEqual([]);
      expect(first.remainingResourceRefs).toEqual(handoff.resourceRefs);
      expect(replay).toEqual(first);
      const [profile] = yield* admin
        .select({ lifecycle: customerProfiles.lifecycle, revision: customerProfiles.revision })
        .from(customerProfiles)
        .where(eq(customerProfiles.customerProfileId, profileId));
      expect(profile).toEqual({ lifecycle: 'ACTIVE', revision: 1 });
      expect(
        yield* admin
          .select({ outcomeId: privacyMeasureExecutions.outcomeId })
          .from(privacyMeasureExecutions)
          .where(eq(privacyMeasureExecutions.tenantId, tenantId)),
      ).toEqual([{ outcomeId: first.outcomeId }]);
      expect(
        yield* admin
          .select({ toLifecycle: customerProfileLifecycleHistory.toLifecycle })
          .from(customerProfileLifecycleHistory)
          .where(eq(customerProfileLifecycleHistory.tenantId, tenantId)),
      ).toEqual([{ toLifecycle: 'ACTIVE' }]);

      const processingRestriction = yield* execute('e6000000-0000-4000-8000-000000000008', {
        ...handoff,
        dispositionDecision: null,
        expectedEvidenceRefs: ['commerce.customer-context.customer-profile.processing-restricted'],
        idempotencyKey: 'commerce-owner-postgres:processing-restriction',
        measureId: 'measure:commerce-owner-postgres:processing-restriction',
        requestedResult: 'SUSPENDED',
        right: 'RESTRICTION',
      });
      expect(processingRestriction.status).toBe('BUSINESS_REJECTED');
      expect(processingRestriction.includedResourceRefs).toEqual([]);
      expect(processingRestriction.remainingResourceRefs).toEqual(handoff.resourceRefs);

      for (const [index, measure] of privacyMeasureDeferredCases.entries()) {
        const later = yield* execute(`f5100000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, {
          ...handoff,
          ...measure,
          idempotencyKey: `commerce-owner-postgres:${measure.kind.toLowerCase()}`,
          measureId: `measure:commerce-owner-postgres:${measure.kind.toLowerCase()}`,
          requestedResult: `${measure.kind.toLowerCase()} deferred`,
        });
        expect(later.status).toBe('BUSINESS_REJECTED');
        expect(later.includedResourceRefs).toEqual([]);
        expect(later.remainingResourceRefs).toEqual(handoff.resourceRefs);
      }

      yield* transitionLifecycle(
        'SUSPENDED',
        'f5200000-0000-4000-8000-000000000001',
        1,
        'ACTIVE',
        '2026-09-15T11:00:00.000Z',
      );
      yield* transitionLifecycle(
        'ACTIVE',
        'f5200000-0000-4000-8000-000000000002',
        2,
        'SUSPENDED',
        '2026-09-15T12:00:00.000Z',
      );
      expect(
        yield* admin
          .select({ lifecycle: customerProfiles.lifecycle, revision: customerProfiles.revision })
          .from(customerProfiles)
          .where(eq(customerProfiles.customerProfileId, profileId)),
      ).toEqual([{ lifecycle: 'ACTIVE', revision: 3 }]);

      const immutableFailure = yield* Effect.flip(
        admin
          .update(privacyMeasureExecutions)
          .set({ occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-14T11:00:00.000Z')) })
          .where(eq(privacyMeasureExecutions.tenantId, tenantId)),
      );
      expect(Option.exists(findPostgresFailure(immutableFailure), ({ code }) => code === '55000')).toBe(true);
    }),
  ),
);
