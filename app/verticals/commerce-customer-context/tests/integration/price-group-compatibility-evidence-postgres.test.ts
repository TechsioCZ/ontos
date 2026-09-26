import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';

const tenantId = 'ca000000-0000-4000-8000-000000000001';
const legalEntityId = 'ca000000-0000-4000-8000-000000000002';
const principalId = 'ca000000-0000-4000-8000-000000000003';
const profileId = 'ca100000-0000-4000-8000-000000000001';
const assignmentId = 'ca200000-0000-4000-8000-000000000001';
const definitionRevisionId = 'ca300000-0000-4000-8000-000000000001';

interface EvidenceOutcome extends Record<string, unknown> {
  readonly changed?: boolean;
  readonly compatibility_verified_at: Date | string | null;
  readonly definition_revision_id: string | null;
  readonly meaning_fingerprint: string | null;
  readonly outcome: string;
}

const one = <Row>(rows: readonly Row[]): Row => {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected one compatibility evidence row');
  }
  return row;
};

it.live('round-trips canonical compatibility evidence while preserving legacy rows', () =>
  Effect.scoped(
    Effect.gen(function* compatibilityEvidenceRoundTrip() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceCustomerContextRelations);
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanFixtureScope() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.execute(
              sql`delete from commerce_customer_context.customer_price_group_assignments where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from commerce_customer_context.customer_profiles where tenant_id = ${tenantId}::uuid`,
            );
          }),
        );
      const inScope = <Value, Failure>(
        operation: (transaction: CommerceCustomerContextTransaction) => Effect.Effect<Value, Failure>,
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

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* admin.transaction((transaction) =>
        Effect.gen(function* createLegacyAssignment() {
          yield* transaction.execute(sql`
            insert into commerce_customer_context.customer_profiles
              (customer_profile_id, tenant_id, legal_entity_id, profile_kind, lifecycle, revision)
            values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL', 'ACTIVE', 1)
          `);
          yield* transaction.execute(sql`
            insert into commerce_customer_context.customer_price_group_assignments
              (customer_price_group_assignment_id, tenant_id, legal_entity_id, customer_profile_id,
               price_group_module_id, price_group_resource_type, price_group_resource_id,
               catalog_revision, compatibility_contract_id, compatibility_contract_revision,
               definition_revision, effective_from, lifecycle, revision, action_invocation_id,
               actor_principal_id, reason, recorded_at)
            values (${assignmentId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${profileId}::uuid,
              'pricing.catalog', 'pricing.catalog.price-group', 'contract-pricing', 7,
              'commerce.customer-price-group-assignment.v1', 1, 4,
              '2030-01-02T00:00:00Z'::timestamptz, 'ACTIVE', 1,
              'ca400000-0000-4000-8000-000000000001'::uuid, ${principalId}::uuid,
              'Legacy assignment', '2030-01-01T00:00:00Z'::timestamptz)
          `);
        }),
      );

      const read = () =>
        inScope((transaction) =>
          transaction
            .execute<EvidenceOutcome>(
              sql`select * from commerce_customer_context.read_price_group_assignment_compatibility_evidence(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${assignmentId}::text
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );
      const bind = (fingerprint: string, verifiedAt = '2030-01-02T00:00:01Z') =>
        inScope((transaction) =>
          transaction
            .execute<EvidenceOutcome>(
              sql`select * from commerce_customer_context.bind_price_group_assignment_compatibility_evidence(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${assignmentId}::text,
                'pricing.catalog'::text, 'pricing.catalog.price-group'::text, 'contract-pricing'::text,
                7, 'commerce.customer-price-group-assignment.v1'::text, 1, 4,
                ${definitionRevisionId}::uuid, ${fingerprint}::text,
                '2030-01-01T00:00:00Z'::timestamptz, null::timestamptz,
                '2030-01-02T00:00:00Z'::timestamptz, ${verifiedAt}::timestamptz
              )`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );

      expect(yield* read()).toMatchObject({ definition_revision_id: null, outcome: 'LEGACY' });
      expect(yield* bind('a'.repeat(64))).toMatchObject({ changed: true, outcome: 'BOUND' });
      expect(yield* read()).toMatchObject({
        definition_revision_id: definitionRevisionId,
        meaning_fingerprint: 'a'.repeat(64),
        outcome: 'FOUND',
      });
      expect(yield* bind('a'.repeat(64), '2030-01-02T00:00:02Z')).toMatchObject({
        changed: false,
        compatibility_verified_at: new Date('2030-01-02T00:00:01Z'),
        outcome: 'BOUND',
      });
      expect(yield* bind('b'.repeat(64), '2030-01-02T00:00:02Z')).toMatchObject({
        changed: false,
        outcome: 'CONFLICT',
      });
    }),
  ),
);
