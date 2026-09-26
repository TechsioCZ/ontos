import { sql } from 'drizzle-orm';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type {
  MarketRetirementImpactAssessment,
  ReservedMarketRetirementImpactAssessment,
} from '../../shared/domain/market-retirement-impact.ts';
import { commerceMarketCatalogRelations } from '../../src/database/schema.ts';

const tenantId = 'e3460000-0000-4000-8000-000000000001';
const otherTenantId = 'e3460000-0000-4000-8000-000000000002';
const sellerId = 'e3460000-0000-4000-8000-000000000003';
const otherSellerId = 'e3460000-0000-4000-8000-000000000004';
const principalId = 'e3460000-0000-4000-8000-000000000005';
const marketId = 'e3461000-0000-4000-8000-000000000001';
const duplicateMarketId = 'e3461000-0000-4000-8000-000000000002';
const associationId = 'e3462000-0000-4000-8000-000000000001';
const overlappingAssociationId = 'e3462000-0000-4000-8000-000000000002';

type MarketCatalogTestDatabase = TestDatabaseFromClient<typeof commerceMarketCatalogRelations>;
type MarketCatalogTransaction = Parameters<Parameters<MarketCatalogTestDatabase['transaction']>[0]>[0];

const OutcomeRowSchema = Schema.Struct({ payload: Schema.Record(Schema.String, Schema.Unknown) });
const oneOutcome = (rows: readonly unknown[]) => Schema.decodeUnknownSync(OutcomeRowSchema)(rows[0]).payload;
type DatabaseOutcome = (typeof OutcomeRowSchema.Type)['payload'];
interface ExpectedOutcome {
  readonly actualRevision?: number;
  readonly changed?: boolean;
  readonly generation?: number;
  readonly lifecycle?: string;
  readonly previousRevision?: number;
  readonly revision?: number;
}
const expectOutcome = (value: DatabaseOutcome, tag: string, expected: ExpectedOutcome = {}) => {
  expect(Predicate.isTagged(value, tag)).toBe(true);
  expect(value).toMatchObject(expected);
};

const scoped = <Value, Failure>(
  database: MarketCatalogTestDatabase,
  operation: (transaction: MarketCatalogTransaction) => Effect.Effect<Value, Failure>,
  scopeTenantId = tenantId,
  scopeSellerId = sellerId,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* scopedOperation() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${scopeTenantId}, true),
                   set_config('ontos.legal_entity_id', ${scopeSellerId}, true)`,
        'objects',
      );
      return yield* operation(transaction);
    }),
  );

const command = (actionInvocationId: string) => ({
  actionInvocationId,
  principalId,
  recordedAt: '2030-01-01T00:00:00.000Z',
});

const reference = (resourceId: string, resourceType: string, scopeTenantId = tenantId) => ({
  moduleId: 'commerce.market-catalog',
  resourceId,
  resourceType,
  tenantId: scopeTenantId,
});

const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const retirementImpactAssessment = (
  marketRevision: number,
  effectiveAt: string,
): ReservedMarketRetirementImpactAssessment => ({
  assessedMarketRef: marketRef,
  assessedMarketRevision: marketRevision,
  assessmentDigest: 'a'.repeat(64),
  effectiveAt,
  providers: [
    {
      completenessEvidenceReference: 'customer-context:market-impact-completeness:17',
      currentnessEvidenceReference: 'customer-context:market-impact-currentness:17',
      effectiveAt,
      liveBlockingReferences: { count: 0, evidenceReference: 'customer-context:live-market-references:17' },
      observedAt: '2031-12-31T23:59:59.000Z',
      ownerModuleKey: 'commerce.customer-context',
      ownerRevision: 'customer-context-policy:17',
      retainedHistoryEvidence: { count: 1, evidenceReference: 'customer-context:retained-market-history:17' },
      versionToken: 'customer-context-market-impact:17',
    },
  ],
  requiredProviderModuleKeys: ['commerce.customer-context'],
  reservation: {
    token: 'e3464000-0000-4000-8000-000000000001',
    version: 7,
  },
});
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
};
const storefrontRef = { appId: 'czech-storefront', tenantId };

it.live('enforces CAS, idempotency, temporal associations, terminal retirement, and immutable history', () =>
  Effect.scoped(
    Effect.gen(function* marketAdministrationAcceptance() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceMarketCatalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceMarketCatalogRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanMarketFixtures() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            for (const table of [
              'storefront_association_revisions',
              'storefront_associations',
              'market_lifecycle_periods',
              'market_definition_revisions',
              'markets',
              'market_catalog_completeness_generations',
            ] as const) {
              yield* transaction.execute(
                sql.raw(`delete from commerce_market_catalog.${table} where tenant_id = '${tenantId}'::uuid`),
              );
            }
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const createPayload = {
        ...command('e3463000-0000-4000-8000-000000000001'),
        channels: ['B2C'],
        effectivePeriod: { startsAt: '2030-01-01T00:00:00.000Z' },
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        lifecycle: 'ACTIVE',
        marketCode: 'CZ_MAIN',
        marketId,
        purpose: 'Czech direct commerce.',
        reason: 'Create the canonical Czech Market.',
        sellingLegalEntityRef: sellerRef,
        supportedLocales: ['cs-CZ'],
      };
      const create = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.create_market(
              ${tenantId}::uuid, ${sellerId}::uuid, ${JSON.stringify(createPayload)}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(create, 'created', { changed: true, generation: 1, revision: 1 });
      const definitionRevisionId = Schema.decodeUnknownSync(Schema.String)(create.definitionRevisionId);

      const replay = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.create_market(
              ${tenantId}::uuid, ${sellerId}::uuid, ${JSON.stringify(createPayload)}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(replay, 'reused', { changed: false, generation: 1 });

      const duplicateCode = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.create_market(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({ ...createPayload, ...command('e3463000-0000-4000-8000-000000000002'), marketId: duplicateMarketId })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(duplicateCode, 'market_code_conflict');

      const revisedDefinition = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.revise_market_definition(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...command('e3463000-0000-4000-8000-000000000003'),
                channels: ['B2C', 'B2B'],
                effectivePeriod: { startsAt: '2030-02-01T00:00:00.000Z' },
                expectedCurrentDefinitionRevisionRef: reference(
                  definitionRevisionId,
                  'commerce.market-catalog.market-definition-revision',
                ),
                expectedRevision: 1,
                jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
                marketRef,
                purpose: 'Czech direct and business commerce.',
                reason: 'Enable the approved B2B channel.',
                supportedLocales: ['cs-CZ', 'en-CZ'],
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(revisedDefinition, 'revised', { changed: true, generation: 2, revision: 2 });
      const currentDefinitionRevisionId = Schema.decodeUnknownSync(Schema.String)(
        revisedDefinition.definitionRevisionId,
      );
      const replayAfterRevision = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.create_market(
              ${tenantId}::uuid, ${sellerId}::uuid, ${JSON.stringify(createPayload)}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(replayAfterRevision, 'reused', { changed: false, generation: 2, revision: 1 });
      expect(replayAfterRevision).toMatchObject({ definitionRevisionId });

      const staleRevision = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.revise_market_definition(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...command('e3463000-0000-4000-8000-000000000004'),
                channels: ['B2C'],
                effectivePeriod: { startsAt: '2030-03-01T00:00:00.000Z' },
                expectedCurrentDefinitionRevisionRef: reference(
                  definitionRevisionId,
                  'commerce.market-catalog.market-definition-revision',
                ),
                expectedRevision: 1,
                jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
                marketRef,
                purpose: 'Stale change.',
                reason: 'Exercise stale expected-current evidence.',
                supportedLocales: ['cs-CZ'],
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(staleRevision, 'revision_conflict', { actualRevision: 2 });

      const associationPayload = {
        ...command('e3463000-0000-4000-8000-000000000005'),
        associationId,
        channel: 'B2C',
        effectivePeriod: { endsAt: '2031-01-01T00:00:00.000Z', startsAt: '2030-04-01T00:00:00.000Z' },
        expectedMarketDefinitionRevisionRef: reference(
          currentDefinitionRevisionId,
          'commerce.market-catalog.market-definition-revision',
        ),
        marketRef,
        provenance: { kind: 'MANUAL', reference: 'acceptance-test' },
        reason: 'Associate the Czech Storefront.',
        sellingLegalEntityRef: sellerRef,
        storefrontRef,
      };
      const associated = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.associate_storefront(
              ${tenantId}::uuid, ${sellerId}::uuid, ${JSON.stringify(associationPayload)}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(associated, 'associated', { changed: true, generation: 3, revision: 1 });

      const overlap = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.associate_storefront(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...associationPayload,
                ...command('e3463000-0000-4000-8000-000000000006'),
                associationId: overlappingAssociationId,
                effectivePeriod: { startsAt: '2030-12-31T00:00:00.000Z' },
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(overlap, 'overlapping_association');

      const revisedAssociation = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.revise_storefront_association(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...associationPayload,
                ...command('e3463000-0000-4000-8000-000000000007'),
                associationRef: reference(associationId, 'commerce.market-catalog.storefront-association'),
                effectivePeriod: { startsAt: '2031-01-01T00:00:00.000Z' },
                expectedRevision: 1,
                reason: 'Move to the adjacent effective period.',
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(revisedAssociation, 'revised', {
        changed: true,
        generation: 4,
        previousRevision: 1,
        revision: 2,
      });

      const removed = oneOutcome(
        yield* scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.remove_storefront_association(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify({
                ...command('e3463000-0000-4000-8000-000000000008'),
                associationRef: reference(associationId, 'commerce.market-catalog.storefront-association'),
                effectiveAt: '2031-06-01T00:00:00.000Z',
                expectedRevision: 2,
                marketRef,
                reason: 'Remove the retired Storefront association.',
                storefrontRef,
              })}::jsonb)`,
            'objects',
          ),
        ),
      );
      expectOutcome(removed, 'removed', { changed: true, generation: 5, revision: 3 });

      const transition = (
        lifecycle: 'ACTIVE' | 'RETIRED' | 'SUSPENDED',
        actionId: string,
        effectiveAt: string,
        expectedRevision: number,
        retirementImpactOverride?: MarketRetirementImpactAssessment,
      ) => {
        const payload: ReturnType<typeof command> & {
          effectiveAt: ReturnType<typeof retirementImpactAssessment>['effectiveAt'];
          expectedCurrentDefinitionRevisionId: string;
          expectedRevision: number;
          lifecycle: 'ACTIVE' | 'RETIRED' | 'SUSPENDED';
          marketId: string;
          reason: string;
          retirementImpactAssessment?: MarketRetirementImpactAssessment;
          tenantId: string;
        } = {
          ...command(actionId),
          effectiveAt,
          expectedCurrentDefinitionRevisionId: currentDefinitionRevisionId,
          expectedRevision,
          lifecycle,
          marketId,
          reason: `${lifecycle} lifecycle acceptance.`,
          tenantId,
        };
        if (lifecycle === 'RETIRED') {
          payload.retirementImpactAssessment =
            retirementImpactOverride ?? retirementImpactAssessment(expectedRevision, effectiveAt);
        }
        return scoped(runtime, (transaction) =>
          transaction.execute(
            sql`select * from commerce_market_catalog.transition_market_lifecycle(
              ${tenantId}::uuid, ${sellerId}::uuid,
              ${JSON.stringify(payload)}::jsonb)`,
            'objects',
          ),
        );
      };
      expectOutcome(
        oneOutcome(
          yield* transition('SUSPENDED', 'e3463000-0000-4000-8000-000000000009', '2030-06-01T00:00:00.000Z', 2),
        ),
        'transitioned',
        { changed: true, generation: 6, lifecycle: 'SUSPENDED', revision: 3 },
      );
      expectOutcome(
        oneOutcome(yield* transition('RETIRED', 'e3463000-0000-4000-8000-000000000010', '2032-01-01T00:00:00.000Z', 2)),
        'revision_conflict',
        { actualRevision: 3 },
      );
      expectOutcome(
        oneOutcome(yield* transition('ACTIVE', 'e3463000-0000-4000-8000-000000000011', '2030-07-01T00:00:00.000Z', 3)),
        'transitioned',
        { changed: true, generation: 7, lifecycle: 'ACTIVE', revision: 4 },
      );
      const retirementEffectiveAt = '2032-01-01T00:00:00.000Z';
      const validRetirementImpact = retirementImpactAssessment(4, retirementEffectiveAt);
      const { reservation: _reservation, ...impactWithoutReservation } = validRetirementImpact;
      const invalidRetirementImpacts = [
        [
          'e3463000-0000-4000-8000-000000000014',
          { ...impactWithoutReservation, reservationToken: validRetirementImpact.reservation.token },
        ],
        ['e3463000-0000-4000-8000-000000000015', { ...validRetirementImpact, assessmentDigest: 'invalid' }],
        [
          'e3463000-0000-4000-8000-000000000016',
          { ...validRetirementImpact, reservation: { ...validRetirementImpact.reservation, version: 0 } },
        ],
      ] as const;
      for (const [actionId, invalidImpact] of invalidRetirementImpacts) {
        expectOutcome(
          oneOutcome(yield* transition('RETIRED', actionId, retirementEffectiveAt, 4, invalidImpact)),
          'replacement_impact_unresolved',
        );
      }
      expectOutcome(
        oneOutcome(yield* transition('RETIRED', 'e3463000-0000-4000-8000-000000000012', retirementEffectiveAt, 4)),
        'transitioned',
        { changed: true, generation: 8, lifecycle: 'RETIRED', revision: 5 },
      );
      expectOutcome(
        oneOutcome(yield* transition('ACTIVE', 'e3463000-0000-4000-8000-000000000013', '2032-02-01T00:00:00.000Z', 5)),
        'invalid_lifecycle_transition',
      );

      yield* Effect.flip(
        scoped(
          runtime,
          (transaction) =>
            transaction.execute(
              sql`select * from commerce_market_catalog.create_market(
                ${otherTenantId}::uuid, ${otherSellerId}::uuid, ${JSON.stringify(createPayload)}::jsonb)`,
            ),
          tenantId,
          sellerId,
        ),
      );
      yield* Effect.flip(
        admin.execute(sql`update commerce_market_catalog.market_definition_revisions
                          set purpose = 'Mutated history' where tenant_id = ${tenantId}::uuid`),
      );
      yield* Effect.flip(
        admin.execute(sql`delete from commerce_market_catalog.storefront_association_revisions
                          where tenant_id = ${tenantId}::uuid`),
      );

      const [history] = yield* admin.execute<{
        readonly association_revisions: number;
        readonly definition_revisions: number;
        readonly generation: number;
        readonly lifecycle_periods: number;
        readonly retirement_impact_assessment: unknown;
      }>(
        sql`select
          (select count(*)::integer from commerce_market_catalog.storefront_association_revisions where tenant_id = ${tenantId}::uuid) as association_revisions,
          (select count(*)::integer from commerce_market_catalog.market_definition_revisions where tenant_id = ${tenantId}::uuid) as definition_revisions,
          (select generation from commerce_market_catalog.market_catalog_completeness_generations where tenant_id = ${tenantId}::uuid) as generation,
          (select count(*)::integer from commerce_market_catalog.market_lifecycle_periods where tenant_id = ${tenantId}::uuid) as lifecycle_periods,
          (select retirement_impact_assessment from commerce_market_catalog.market_lifecycle_periods
            where tenant_id = ${tenantId}::uuid and lifecycle = 'RETIRED') as retirement_impact_assessment`,
        'objects',
      );
      expect(history).toEqual({
        association_revisions: 3,
        definition_revisions: 2,
        generation: 8,
        lifecycle_periods: 4,
        retirement_impact_assessment: retirementImpactAssessment(4, '2032-01-01T00:00:00.000Z'),
      });
    }),
  ),
);

it.live('exposes only the six governed mutations and three governed reads over forced Tenant RLS', () =>
  Effect.scoped(
    Effect.gen(function* marketSecurityCatalog() {
      const { admin: adminClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceMarketCatalogRelations);
      const [catalog] = yield* admin.execute<{
        readonly executable_routines: number;
        readonly forced_tables: number;
        readonly private_routines_executable: boolean;
        readonly runtime_table_grants: number;
      }>(
        sql`select
          (select count(*)::integer from pg_proc routine join pg_namespace ns on ns.oid = routine.pronamespace
            where ns.nspname = 'commerce_market_catalog' and routine.prosecdef
              and has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')) as executable_routines,
          (select count(*)::integer from pg_class relation join pg_namespace ns on ns.oid = relation.relnamespace
            where ns.nspname = 'commerce_market_catalog' and relation.relkind = 'r'
              and relation.relrowsecurity and relation.relforcerowsecurity) as forced_tables,
          has_function_privilege('ontos_runtime', 'commerce_market_catalog.assert_operation_scope(uuid,uuid)', 'EXECUTE')
            or has_function_privilege('ontos_runtime', 'commerce_market_catalog.advance_completeness_generation(uuid,uuid)', 'EXECUTE')
            as private_routines_executable,
          (select count(*)::integer from information_schema.role_table_grants
            where grantee = 'ontos_runtime' and table_schema = 'commerce_market_catalog') as runtime_table_grants`,
        'objects',
      );
      expect(catalog).toEqual({
        executable_routines: 9,
        forced_tables: 6,
        private_routines_executable: false,
        runtime_table_grants: 0,
      });
    }),
  ),
);
