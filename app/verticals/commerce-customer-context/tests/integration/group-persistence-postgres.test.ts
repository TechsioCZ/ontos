import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  commerceCustomerContextRelations,
  customerGroupLifecyclePeriods,
  customerGroupMemberships,
  customerGroupRevisions,
  customerGroups,
  customerProfileLifecycleHistory,
  customerProfiles,
  customerSettingRevisions,
} from '../../src/database/schema.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';

const tenantId = 'c7000000-0000-4000-8000-000000000001';
const legalEntityId = 'c7000000-0000-4000-8000-000000000002';
const principalId = 'c7000000-0000-4000-8000-000000000003';

const profileTemporal = 'c7100000-0000-4000-8000-000000000001';
const profileCancelled = 'c7100000-0000-4000-8000-000000000002';
const profilePeriods = 'c7100000-0000-4000-8000-000000000003';
const profileConcurrent = 'c7100000-0000-4000-8000-000000000004';
const profileRace = 'c7100000-0000-4000-8000-000000000005';

const date = (value: string): Date => new Date(value);

interface RoutineOutcome extends Record<string, unknown> {
  readonly changed: boolean;
  readonly outcome: string;
}

interface GroupOutcome extends RoutineOutcome {
  readonly actual_revision: number;
  readonly group_json: {
    readonly groupRef: { readonly resourceId: string };
  } | null;
}

interface MembershipOutcome extends RoutineOutcome {
  readonly membership_json: {
    readonly membershipRef: { readonly resourceId: string };
    readonly state: string;
  } | null;
}

interface ReadOutcome extends Record<string, unknown> {
  readonly items_json: readonly unknown[];
  readonly outcome: string;
}

const one = <Row>(rows: readonly Row[]): Row => {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected one routine result row');
  }
  return row;
};

it.live('preserves Customer Group temporal, replay, and concurrency invariants in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* postgresAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
        (pool) => Effect.promise(() => pool.end()).pipe(Effect.orDie),
      );
      const runtimePool = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Pool({
              connectionString: connections.runtime.connectionString,
              max: 4,
            }),
        ),
        (pool) => Effect.promise(() => pool.end()).pipe(Effect.orDie),
      );
      const admin = yield* makeTestDatabaseFromPool(adminPool, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromPool(
        runtimePool,
        commerceCustomerContextRelations,
      );

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanFixtureScope() {
            // Test cleanup is isolated to this admin transaction. Runtime remains unable to bypass
            // the append-only triggers, which stay enabled for every production connection.
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction
              .delete(customerGroupMemberships)
              .where(eq(customerGroupMemberships.tenantId, tenantId));
            yield* transaction
              .delete(customerSettingRevisions)
              .where(eq(customerSettingRevisions.tenantId, tenantId));
            yield* transaction
              .delete(customerGroupLifecyclePeriods)
              .where(eq(customerGroupLifecyclePeriods.tenantId, tenantId));
            yield* transaction
              .delete(customerGroupRevisions)
              .where(eq(customerGroupRevisions.tenantId, tenantId));
            yield* transaction.delete(customerGroups).where(eq(customerGroups.tenantId, tenantId));
            yield* transaction
              .delete(customerProfileLifecycleHistory)
              .where(eq(customerProfileLifecycleHistory.tenantId, tenantId));
            yield* transaction
              .delete(customerProfiles)
              .where(eq(customerProfiles.tenantId, tenantId));
          }),
        );

      const inScope = <Value, Failure>(
        operation: (
          transaction: CommerceCustomerContextTransaction,
        ) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedOperation() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            return yield* operation(transaction);
          }),
        );

      const createGroup = (suffix: string, recordedAt: Date, invocationId: string) =>
        inScope((transaction) =>
          transaction
            .execute<GroupOutcome>(
              sql`select * from commerce_customer_context.create_customer_group(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${`GROUP_${suffix}`}::text,
                ${`test.group-${suffix.toLowerCase()}`}::text,
                ${`Description ${suffix}`}::text,
                ${`Criteria ${suffix}`}::text,
                ${`Group ${suffix}`}::text,
                ${`Purpose ${suffix}`}::text,
                ${'PostgreSQL acceptance fixture'}::text,
                ${recordedAt}::timestamptz,
                ${principalId}::uuid,
                ${invocationId}::uuid
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const assign = (
        groupId: string,
        profileId: string,
        effectiveFrom: Date,
        effectiveTo: Date | null,
        recordedAt: Date,
        invocationId: string,
      ) =>
        inScope((transaction) =>
          transaction
            .execute<MembershipOutcome>(
              sql`select * from commerce_customer_context.assign_customer_group_membership(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${groupId}::uuid,
                ${profileId}::uuid,
                ${'RETAIL'}::text,
                ${effectiveFrom}::timestamptz,
                ${effectiveTo}::timestamptz,
                ${'PostgreSQL acceptance assignment'}::text,
                ${recordedAt}::timestamptz,
                ${principalId}::uuid,
                ${invocationId}::uuid
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const remove = (
        membershipId: string,
        groupId: string,
        profileId: string,
        effectiveAt: Date,
        recordedAt: Date,
        invocationId: string,
      ) =>
        inScope((transaction) =>
          transaction
            .execute<MembershipOutcome>(
              sql`select * from commerce_customer_context.remove_customer_group_membership(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${membershipId}::uuid,
                ${groupId}::uuid,
                ${profileId}::uuid,
                ${'RETAIL'}::text,
                ${effectiveAt}::timestamptz,
                ${'PostgreSQL acceptance removal'}::text,
                ${recordedAt}::timestamptz,
                ${principalId}::uuid,
                ${invocationId}::uuid
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const readEffective = (profileId: string, effectiveAt: Date) =>
        inScope((transaction) =>
          transaction
            .execute<ReadOutcome>(
              sql`select * from commerce_customer_context.read_effective_customer_group_memberships(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${profileId}::uuid,
                ${'RETAIL'}::text,
                ${effectiveAt}::timestamptz
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const readHistoryAt = (groupId: string, asOf: Date) =>
        inScope((transaction) =>
          transaction
            .execute<ReadOutcome>(
              sql`select * from commerce_customer_context.read_customer_group_history(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${groupId}::uuid,
                ${asOf}::timestamptz,
                ${null}::text,
                ${50}::integer
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      const archive = (
        groupId: string,
        effectiveAt: Date,
        recordedAt: Date,
        invocationId: string,
      ) =>
        inScope((transaction) =>
          transaction
            .execute<GroupOutcome>(
              sql`select * from commerce_customer_context.archive_customer_group(
                ${tenantId}::uuid,
                ${legalEntityId}::uuid,
                ${groupId}::uuid,
                ${1}::integer,
                ${effectiveAt}::timestamptz,
                ${'PostgreSQL acceptance archive'}::text,
                ${recordedAt}::timestamptz,
                ${principalId}::uuid,
                ${invocationId}::uuid
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* cleanup();
      const profiles = [
        profileTemporal,
        profileCancelled,
        profilePeriods,
        profileConcurrent,
        profileRace,
      ] as const;
      yield* admin.insert(customerProfiles).values(
        profiles.map((customerProfileId) => ({
          customerProfileId,
          legalEntityId,
          profileKind: 'RETAIL',
          tenantId,
        })),
      );
      yield* admin.insert(customerProfileLifecycleHistory).values(
        profiles.map((customerProfileId, index) => ({
          actionInvocationId: `c7200000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          actorPrincipalId: principalId,
          customerProfileId,
          fromLifecycle: null,
          legalEntityId,
          reason: 'PostgreSQL acceptance profile fixture',
          recordedAt: date('2026-01-01T00:00:00.000Z'),
          revision: 1,
          tenantId,
          toLifecycle: 'ACTIVE',
        })),
      );

      const temporalGroup = yield* createGroup(
        'TEMPORAL',
        date('2026-01-01T00:00:00.000Z'),
        'c7300000-0000-4000-8000-000000000001',
      );
      const temporalGroupId = temporalGroup.group_json?.groupRef.resourceId;
      expect(temporalGroup.outcome).toBe('CREATED');
      expect(temporalGroupId).toBeDefined();
      if (temporalGroupId === undefined) {
        return;
      }
      const temporalAssignment = yield* assign(
        temporalGroupId,
        profileTemporal,
        date('2026-01-02T00:00:00.000Z'),
        null,
        date('2026-01-02T00:00:00.000Z'),
        'c7300000-0000-4000-8000-000000000002',
      );
      const temporalMembershipId = temporalAssignment.membership_json?.membershipRef.resourceId;
      expect(temporalAssignment.outcome).toBe('ASSIGNED');
      expect(temporalMembershipId).toBeDefined();
      if (temporalMembershipId === undefined) {
        return;
      }
      expect(
        (yield* remove(
          temporalMembershipId,
          temporalGroupId,
          profileTemporal,
          date('2026-02-01T00:00:00.000Z'),
          date('2026-01-15T00:00:00.000Z'),
          'c7300000-0000-4000-8000-000000000003',
        )).outcome,
      ).toBe('REMOVED');
      expect(
        (yield* readEffective(profileTemporal, date('2026-01-31T23:59:59.999Z'))).items_json,
      ).toHaveLength(1);
      expect(
        (yield* readEffective(profileTemporal, date('2026-02-01T00:00:00.000Z'))).items_json,
      ).toHaveLength(0);
      expect(
        (yield* readHistoryAt(temporalGroupId, date('2026-01-31T23:59:59.999Z'))).items_json,
      ).toHaveLength(1);
      expect(
        (yield* readHistoryAt(temporalGroupId, date('2026-02-01T00:00:00.000Z'))).items_json,
      ).toHaveLength(0);

      yield* admin
        .update(customerProfiles)
        .set({ lifecycle: 'SUSPENDED', revision: 2 })
        .where(eq(customerProfiles.customerProfileId, profileTemporal));
      yield* admin.insert(customerProfileLifecycleHistory).values({
        actionInvocationId: 'c7300000-0000-4000-8000-000000000004',
        actorPrincipalId: principalId,
        customerProfileId: profileTemporal,
        fromLifecycle: 'ACTIVE',
        legalEntityId,
        reason: 'PostgreSQL acceptance suspension',
        recordedAt: date('2026-01-20T00:00:00.000Z'),
        revision: 2,
        tenantId,
        toLifecycle: 'SUSPENDED',
      });
      expect(
        (yield* readEffective(profileTemporal, date('2026-01-19T23:59:59.999Z'))).items_json,
      ).toHaveLength(1);
      expect(
        (yield* readEffective(profileTemporal, date('2026-01-20T00:00:00.000Z'))).items_json,
      ).toHaveLength(0);

      const cancelledGroup = yield* createGroup(
        'CANCELLED',
        date('2026-01-01T00:00:00.000Z'),
        'c7400000-0000-4000-8000-000000000001',
      );
      const cancelledGroupId = cancelledGroup.group_json?.groupRef.resourceId;
      if (cancelledGroupId === undefined) {
        return;
      }
      const cancelledAssignment = yield* assign(
        cancelledGroupId,
        profileCancelled,
        date('2026-04-01T00:00:00.000Z'),
        date('2026-05-01T00:00:00.000Z'),
        date('2026-03-01T00:00:00.000Z'),
        'c7400000-0000-4000-8000-000000000002',
      );
      const cancelledMembershipId = cancelledAssignment.membership_json?.membershipRef.resourceId;
      if (cancelledMembershipId === undefined) {
        return;
      }
      expect(
        (yield* remove(
          cancelledMembershipId,
          cancelledGroupId,
          profileCancelled,
          date('2026-03-15T00:00:00.000Z'),
          date('2026-03-15T00:00:00.000Z'),
          'c7400000-0000-4000-8000-000000000003',
        )).membership_json?.state,
      ).toBe('CANCELLED');
      yield* admin
        .update(customerProfiles)
        .set({ lifecycle: 'SUSPENDED', revision: 2 })
        .where(eq(customerProfiles.customerProfileId, profileCancelled));
      expect(
        (yield* archive(
          cancelledGroupId,
          date('2026-03-20T00:00:00.000Z'),
          date('2026-03-20T00:00:00.000Z'),
          'c7400000-0000-4000-8000-000000000004',
        )).outcome,
      ).toBe('ARCHIVED');
      const cancelledReplay = yield* assign(
        cancelledGroupId,
        profileCancelled,
        date('2026-04-01T00:00:00.000Z'),
        date('2026-05-01T00:00:00.000Z'),
        date('2026-03-21T00:00:00.000Z'),
        'c7400000-0000-4000-8000-000000000005',
      );
      expect(cancelledReplay.outcome).toBe('ALREADY_ASSIGNED');
      expect(cancelledReplay.membership_json?.state).toBe('CANCELLED');

      const periodGroup = yield* createGroup(
        'PERIODS',
        date('2026-01-01T00:00:00.000Z'),
        'c7500000-0000-4000-8000-000000000001',
      );
      const periodGroupId = periodGroup.group_json?.groupRef.resourceId;
      if (periodGroupId === undefined) {
        return;
      }
      expect(
        (yield* assign(
          periodGroupId,
          profilePeriods,
          date('2026-02-01T00:00:00.000Z'),
          date('2026-03-01T00:00:00.000Z'),
          date('2026-01-10T00:00:00.000Z'),
          'c7500000-0000-4000-8000-000000000002',
        )).outcome,
      ).toBe('ASSIGNED');
      expect(
        (yield* assign(
          periodGroupId,
          profilePeriods,
          date('2026-03-01T00:00:00.000Z'),
          date('2026-04-01T00:00:00.000Z'),
          date('2026-01-10T00:00:00.000Z'),
          'c7500000-0000-4000-8000-000000000003',
        )).outcome,
      ).toBe('ASSIGNED');
      expect(
        (yield* assign(
          periodGroupId,
          profilePeriods,
          date('2026-02-15T00:00:00.000Z'),
          date('2026-03-15T00:00:00.000Z'),
          date('2026-01-10T00:00:00.000Z'),
          'c7500000-0000-4000-8000-000000000004',
        )).outcome,
      ).toBe('OVERLAP');

      const concurrentGroup = yield* createGroup(
        'CONCURRENT',
        date('2026-01-01T00:00:00.000Z'),
        'c7600000-0000-4000-8000-000000000001',
      );
      const concurrentGroupId = concurrentGroup.group_json?.groupRef.resourceId;
      if (concurrentGroupId === undefined) {
        return;
      }
      const concurrentOutcomes = yield* Effect.all(
        [
          assign(
            concurrentGroupId,
            profileConcurrent,
            date('2026-02-01T00:00:00.000Z'),
            null,
            date('2026-01-15T00:00:00.000Z'),
            'c7600000-0000-4000-8000-000000000002',
          ),
          assign(
            concurrentGroupId,
            profileConcurrent,
            date('2026-02-01T00:00:00.000Z'),
            null,
            date('2026-01-15T00:00:00.000Z'),
            'c7600000-0000-4000-8000-000000000003',
          ),
        ],
        { concurrency: 2 },
      );
      expect(new Set(concurrentOutcomes.map(({ outcome }) => outcome))).toEqual(
        new Set(['ALREADY_ASSIGNED', 'ASSIGNED']),
      );
      expect(
        yield* admin
          .select({ id: customerGroupMemberships.customerGroupMembershipId })
          .from(customerGroupMemberships)
          .where(
            and(
              eq(customerGroupMemberships.customerGroupId, concurrentGroupId),
              eq(customerGroupMemberships.customerProfileId, profileConcurrent),
            ),
          ),
      ).toHaveLength(1);

      const raceGroup = yield* createGroup(
        'RACE',
        date('2026-01-01T00:00:00.000Z'),
        'c7700000-0000-4000-8000-000000000001',
      );
      const raceGroupId = raceGroup.group_json?.groupRef.resourceId;
      if (raceGroupId === undefined) {
        return;
      }
      const [raceAssignment, raceArchive] = yield* Effect.all(
        [
          assign(
            raceGroupId,
            profileRace,
            date('2026-01-02T00:00:00.000Z'),
            null,
            date('2026-01-02T00:00:00.000Z'),
            'c7700000-0000-4000-8000-000000000002',
          ),
          archive(
            raceGroupId,
            date('2026-01-03T00:00:00.000Z'),
            date('2026-01-04T00:00:00.000Z'),
            'c7700000-0000-4000-8000-000000000003',
          ),
        ],
        { concurrency: 2 },
      );
      expect(['ASSIGNED', 'GROUP_INACTIVE']).toContain(raceAssignment.outcome);
      expect(raceArchive.outcome).toBe('ARCHIVED');
      expect(
        (yield* readEffective(profileRace, date('2026-01-04T00:00:00.000Z'))).items_json,
      ).toHaveLength(0);

      const replayInvocation = 'c7800000-0000-4000-8000-000000000001';
      const firstCreate = yield* createGroup(
        'REPLAY',
        date('2026-01-01T00:00:00.000Z'),
        replayInvocation,
      );
      const replayCreate = yield* createGroup(
        'REPLAY',
        date('2026-01-01T00:00:00.000Z'),
        replayInvocation,
      );
      expect(firstCreate.outcome).toBe('CREATED');
      expect(replayCreate.outcome).toBe('REUSED');
      expect(replayCreate.changed).toBe(false);
      expect(
        yield* admin
          .select({ id: customerGroups.customerGroupId })
          .from(customerGroups)
          .where(
            and(
              eq(customerGroups.tenantId, tenantId),
              eq(customerGroups.stableCode, 'GROUP_REPLAY'),
            ),
          ),
      ).toHaveLength(1);
      expect(
        yield* admin
          .select({ id: customerGroupRevisions.customerGroupRevisionId })
          .from(customerGroupRevisions)
          .where(eq(customerGroupRevisions.actionInvocationId, replayInvocation)),
      ).toHaveLength(1);
      expect(
        yield* admin
          .select({ id: customerGroupLifecyclePeriods.customerGroupLifecyclePeriodId })
          .from(customerGroupLifecyclePeriods)
          .where(eq(customerGroupLifecyclePeriods.actionInvocationId, replayInvocation)),
      ).toHaveLength(1);
    }),
  ),
);
