import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';

const tenantId = 'c9000000-0000-4000-8000-000000000001';
const legalEntityId = 'c9000000-0000-4000-8000-000000000002';
const principalId = 'c9000000-0000-4000-8000-000000000003';
const profileId = 'c9100000-0000-4000-8000-000000000001';
const replacementProfileId = 'c9100000-0000-4000-8000-000000000002';
const currentAssignmentId = 'c9200000-0000-4000-8000-000000000001';
const boundedAssignmentId = 'c9200000-0000-4000-8000-000000000002';

interface RoutineOutcome extends Record<string, unknown> {
  readonly assignment_id: string | null;
  readonly changed: boolean;
  readonly current_revision?: number;
  readonly outcome: string;
  readonly replaced_assignment_id?: string | null;
}

interface AssignmentState extends Record<string, unknown> {
  readonly action_invocation_id: string;
  readonly effective_to: Date | null;
  readonly lifecycle: string;
  readonly revision: number;
}

interface AssignmentIdentity extends Record<string, unknown> {
  readonly assignment_id: string;
}

const one = <Row>(rows: readonly Row[]): Row => {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected one routine result row');
  }
  return row;
};

it.live('proves exact-current resolution and temporal assignment idempotency in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* postgresAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
        (pool) => Effect.promise(() => pool.end()).pipe(Effect.orDie),
      );
      const runtimePool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connections.runtime.connectionString })),
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
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.execute(
              sql`delete from commerce_customer_context.customer_price_group_assignments
                    where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from commerce_customer_context.customer_profile_lifecycle_history
                    where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from commerce_customer_context.retail_customer_profiles
                    where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from commerce_customer_context.customer_profiles
                    where tenant_id = ${tenantId}::uuid`,
            );
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
              sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                           set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            return yield* operation(transaction);
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      yield* admin.transaction((transaction) =>
        Effect.gen(function* createFixtures() {
          yield* transaction.execute(sql`
              insert into commerce_customer_context.customer_profiles
                (customer_profile_id, tenant_id, legal_entity_id, profile_kind, lifecycle, revision)
              values
                (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL', 'ACTIVE', 1),
                (${replacementProfileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL', 'ACTIVE', 1)
            `);
          yield* transaction.execute(sql`
              insert into commerce_customer_context.retail_customer_profiles
                (retail_customer_profile_id, tenant_id, legal_entity_id, party_resource_id)
              values
                (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'party-price-live-1'),
                (${replacementProfileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'party-price-live-2')
            `);
          yield* transaction.execute(sql`
              insert into commerce_customer_context.customer_profile_lifecycle_history
                (tenant_id, legal_entity_id, customer_profile_id, revision, from_lifecycle,
                 to_lifecycle, action_invocation_id, actor_principal_id, reason, recorded_at)
              values
                (${tenantId}::uuid, ${legalEntityId}::uuid, ${profileId}::uuid, 1, null,
                 'ACTIVE', 'c9300000-0000-4000-8000-000000000001'::uuid, ${principalId}::uuid,
                 'PostgreSQL acceptance fixture', '2030-01-01T08:00:00Z'::timestamptz),
                (${tenantId}::uuid, ${legalEntityId}::uuid, ${replacementProfileId}::uuid, 1, null,
                 'ACTIVE', 'c9300000-0000-4000-8000-000000000002'::uuid, ${principalId}::uuid,
                 'PostgreSQL acceptance fixture', '2030-01-01T08:00:00Z'::timestamptz)
            `);
          yield* transaction.execute(sql`
              insert into commerce_customer_context.customer_price_group_assignments
                (customer_price_group_assignment_id, tenant_id, legal_entity_id,
                 customer_profile_id, price_group_module_id, price_group_resource_type,
                 price_group_resource_id, catalog_revision, compatibility_contract_id,
                 compatibility_contract_revision, definition_revision, effective_from,
                 effective_to, lifecycle, revision, action_invocation_id, actor_principal_id,
                 reason, recorded_at)
              values
                (${currentAssignmentId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid,
                 ${profileId}::uuid, 'pricing.catalog', 'pricing.catalog.price-group',
                 'current', 1, 'commerce.customer-price-group-assignment.v1', 1, 1,
                 '2030-01-01T10:00:00Z'::timestamptz, '2030-01-01T11:00:00Z'::timestamptz,
                 'ACTIVE', 1, 'c9300000-0000-4000-8000-000000000003'::uuid,
                 ${principalId}::uuid, 'Current assignment', '2030-01-01T09:00:00Z'::timestamptz),
                (${boundedAssignmentId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid,
                 ${replacementProfileId}::uuid, 'pricing.catalog', 'pricing.catalog.price-group',
                 'bounded-source', 1, 'commerce.customer-price-group-assignment.v1', 1, 1,
                 '2030-01-01T10:00:00Z'::timestamptz, '2030-01-01T14:00:00Z'::timestamptz,
                 'ACTIVE', 1, 'c9300000-0000-4000-8000-000000000004'::uuid,
                 ${principalId}::uuid, 'Bounded assignment', '2030-01-01T09:00:00Z'::timestamptz)
            `);
          yield* transaction.execute(sql`
              insert into commerce_customer_context.customer_price_group_assignments
                (tenant_id, legal_entity_id, customer_profile_id, price_group_module_id,
                 price_group_resource_type, price_group_resource_id, catalog_revision,
                 compatibility_contract_id, compatibility_contract_revision, definition_revision,
                 effective_from, effective_to, lifecycle, revision, action_invocation_id,
                 actor_principal_id, reason, recorded_at)
              select ${tenantId}::uuid, ${legalEntityId}::uuid, ${profileId}::uuid,
                'pricing.catalog', 'pricing.catalog.price-group', 'future-' || future.slot::text,
                1, 'commerce.customer-price-group-assignment.v1', 1, 1,
                '2030-01-01T11:00:00Z'::timestamptz + future.slot * interval '1 hour',
                '2030-01-01T11:00:00Z'::timestamptz + (future.slot + 1) * interval '1 hour',
                'ACTIVE', 1, 'c9300000-0000-4000-8000-000000000005'::uuid,
                ${principalId}::uuid, 'Future assignment', '2030-01-01T09:00:00Z'::timestamptz
              from generate_series(0, 200) as future(slot)
            `);
        }),
      );

      const current = yield* inScope((transaction) =>
        transaction
          .execute<RoutineOutcome>(
            sql`select * from commerce_customer_context.resolve_price_group_assignments(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${profileId}::text, 'RETAIL'::text,
                '2030-01-01T10:30:00Z'::timestamptz
              )`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(current).toMatchObject({
        assignment_id: currentAssignmentId,
        outcome: 'FOUND',
      });

      const exactBoundaryRemoval = yield* inScope((transaction) =>
        transaction
          .execute<RoutineOutcome>(
            sql`select * from commerce_customer_context.remove_price_group_assignment(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${profileId}::text, 'RETAIL'::text,
                null::text, ${currentAssignmentId}::text,
                '2030-01-01T11:00:00Z'::timestamptz, 1, 'Already scheduled boundary'::text,
                '2030-01-01T09:30:00Z'::timestamptz, ${principalId}::uuid,
                'c9300000-0000-4000-8000-000000000006'::uuid
              )`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(exactBoundaryRemoval).toMatchObject({ changed: false, outcome: 'REMOVED' });

      const futureAssignment = yield* admin
        .execute<AssignmentIdentity>(
          sql`select customer_price_group_assignment_id::text as assignment_id
                from commerce_customer_context.customer_price_group_assignments
                where tenant_id = ${tenantId}::uuid
                  and price_group_resource_id = 'future-0'`,
          'objects',
        )
        .pipe(Effect.map(one));
      const cancelFuture = (effectiveAt: string, invocationId: string) =>
        inScope((transaction) =>
          transaction
            .execute<RoutineOutcome>(
              sql`select * from commerce_customer_context.remove_price_group_assignment(
                  ${tenantId}::uuid, ${legalEntityId}::uuid, ${profileId}::text, 'RETAIL'::text,
                  null::text, ${futureAssignment.assignment_id}::text,
                  ${effectiveAt}::timestamptz, 1, 'Cancel future assignment'::text,
                  '2030-01-01T09:30:00Z'::timestamptz, ${principalId}::uuid,
                  ${invocationId}::uuid
                )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );
      const cancellation = yield* cancelFuture(
        '2030-01-01T11:00:00Z',
        'c9300000-0000-4000-8000-000000000009',
      );
      expect(cancellation).toMatchObject({ changed: true, outcome: 'REMOVED' });
      const cancellationReplay = yield* cancelFuture(
        '2030-01-01T11:00:00Z',
        'c9300000-0000-4000-8000-000000000010',
      );
      expect(cancellationReplay).toMatchObject({ changed: false, outcome: 'REMOVED' });
      const changedCancellationSchedule = yield* cancelFuture(
        '2030-01-01T11:00:01Z',
        'c9300000-0000-4000-8000-000000000011',
      );
      expect(changedCancellationSchedule).toMatchObject({
        changed: false,
        outcome: 'REMOVAL_CONFLICT',
      });

      const replacement = yield* inScope((transaction) =>
        transaction
          .execute<RoutineOutcome>(
            sql`select * from commerce_customer_context.assign_price_group(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${replacementProfileId}::text,
                'RETAIL'::text, null::text, 'pricing.catalog'::text,
                'pricing.catalog.price-group'::text, 'bounded-target'::text,
                2, 'commerce.customer-price-group-assignment.v1'::text, 1, 2,
                '2030-01-01T13:00:00Z'::timestamptz,
                '2030-01-01T13:30:00Z'::timestamptz, 1, 'Bounded replacement'::text,
                '2030-01-01T09:30:00Z'::timestamptz, ${principalId}::uuid,
                'c9300000-0000-4000-8000-000000000007'::uuid
              )`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(replacement).toMatchObject({
        changed: true,
        outcome: 'ASSIGNED',
        replaced_assignment_id: boundedAssignmentId,
      });

      if (replacement.assignment_id === null) {
        throw new Error('Expected the bounded replacement assignment id');
      }
      const sameStartReplacement = yield* inScope((transaction) =>
        transaction
          .execute<RoutineOutcome>(
            sql`select * from commerce_customer_context.assign_price_group(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${replacementProfileId}::text,
                'RETAIL'::text, null::text, 'pricing.catalog'::text,
                'pricing.catalog.price-group'::text, 'same-start-target'::text,
                3, 'commerce.customer-price-group-assignment.v1'::text, 1, 3,
                '2030-01-01T13:00:00Z'::timestamptz,
                '2030-01-01T13:30:00Z'::timestamptz, 1, 'Same-start replacement'::text,
                '2030-01-01T09:30:00Z'::timestamptz, ${principalId}::uuid,
                'c9300000-0000-4000-8000-000000000012'::uuid
              )`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(sameStartReplacement).toMatchObject({
        changed: true,
        outcome: 'ASSIGNED',
        replaced_assignment_id: replacement.assignment_id,
      });

      const sourceState = yield* admin
        .execute<AssignmentState>(
          sql`select action_invocation_id::text, effective_to, lifecycle, revision
                from commerce_customer_context.customer_price_group_assignments
                where customer_price_group_assignment_id = ${boundedAssignmentId}::uuid`,
          'objects',
        )
        .pipe(Effect.map(one));
      expect(sourceState).toMatchObject({
        action_invocation_id: 'c9300000-0000-4000-8000-000000000004',
        effective_to: new Date('2030-01-01T13:00:00.000Z'),
        lifecycle: 'ENDED',
        revision: 2,
      });

      const retroactive = yield* inScope((transaction) =>
        transaction
          .execute<RoutineOutcome>(
            sql`select * from commerce_customer_context.assign_price_group(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${replacementProfileId}::text,
                'RETAIL'::text, null::text, 'pricing.catalog'::text,
                'pricing.catalog.price-group'::text, 'retroactive'::text,
                1, 'commerce.customer-price-group-assignment.v1'::text, 1, 1,
                '2030-01-01T08:00:00Z'::timestamptz, null::timestamptz, 1,
                'Retroactive assignment'::text, '2030-01-01T09:30:00Z'::timestamptz,
                ${principalId}::uuid, 'c9300000-0000-4000-8000-000000000008'::uuid
              )`,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(retroactive).toMatchObject({ changed: false, outcome: 'RETROACTIVE_SCHEDULE' });
    }),
  ),
);
