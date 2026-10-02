import { sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';

const tenantId = 'e7970000-0000-4000-8000-000000000001';
const legalEntityId = 'e7970000-0000-4000-8000-000000000002';
const principalId = 'e7970000-0000-4000-8000-000000000003';
const priceId = 'e7970000-0000-4000-8000-000000000004';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: 'e7970000-0000-4000-8000-000000000005',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: 'e7970000-0000-4000-8000-000000000006',
  resourceType: 'commerce.catalog.variant',
  tenantId,
};
const identityKey = {
  priceRef: { moduleId: 'commerce.pricing', resourceId: priceId, resourceType: 'commerce.pricing.price', tenantId },
  quantityBasis: {
    catalogQuantityBasis: {
      targetDivisibilityRevision: 7,
      targetRef: variantRef,
      unitRef,
      unitRuleRevision: 11,
    },
    priceUnitBasis: { quantity: '1', unitRef },
  },
  thresholdQuantity: '10',
};

type TestDb = TestDatabaseFromClient<typeof coreRelations>;
type Transaction = Parameters<Parameters<TestDb['transaction']>[0]>[0];
interface RoutinePayload {
  readonly acknowledgement?: object;
  readonly actionInvocationId?: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly result?: RoutinePayload;
  readonly schedule?: {
    readonly current?: {
      readonly definition: {
        readonly identityKey: object;
        readonly revision: { readonly revision: number; readonly revisionId: string };
      };
      readonly effectivePeriod: { readonly effectiveFrom: string; readonly effectiveTo: string | null };
    };
    readonly revisions: readonly {
      readonly definition: {
        readonly revision: {
          readonly resultingUnitPrice?: { readonly amount: string; readonly currencyCode: string };
          readonly revisionId: string;
        };
      };
      readonly effectivePeriod: { readonly effectiveFrom: string; readonly effectiveTo: string | null };
      readonly lineage?: {
        readonly correctedRevisionId: null | string;
        readonly kind: string;
        readonly previousRevisionId: null | string;
      };
    }[];
    readonly scheduleRevision: number;
  };
}
interface Result {
  readonly payload: RoutinePayload;
}
const JsonUtcTimestampSchema = Schema.toEncoded(Schema.DateTimeUtcFromString);
type JsonUtcTimestamp = Schema.Schema.Type<typeof JsonUtcTimestampSchema>;
interface TierSetProofPayload {
  readonly authority?: {
    readonly generation: number;
    readonly observedAt: JsonUtcTimestamp;
    readonly ownerRevision: string;
    readonly ownerRootRef: string;
    readonly predicateRef: string;
    readonly verificationRef: string;
  };
  readonly currentFacts?: readonly object[];
  readonly outcome: string;
  readonly tierSet?: object;
}
const call = <Input extends { readonly actingPrincipalId: string; readonly actionInvocationId: string }>(
  database: TestDb,
  routine:
    | 'define_quantity_tier_v2'
    | 'revise_quantity_tier_v2'
    | 'lookup_quantity_tier_action_result_v1'
    | 'read_quantity_tier_schedule_v1',
  input: Input,
) =>
  database.transaction((transaction: Transaction) =>
    Effect.gen(function* callQuantityTierRoutine() {
      yield* transaction.execute(
        sql`
        select set_config('ontos.tenant_id', ${tenantId}, true),
               set_config('ontos.legal_entity_id', ${legalEntityId}, true)
      `,
        'objects',
      );
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input);
      let rows: readonly Result[];
      if (routine === 'define_quantity_tier_v2') {
        rows = yield* transaction.execute<{ readonly payload: RoutinePayload }>(
          sql`
          select payload from pricing.define_quantity_tier_v2(
            ${tenantId}::uuid, ${legalEntityId}::uuid, ${encoded}::jsonb
          )
        `,
          'objects',
        );
      } else if (routine === 'revise_quantity_tier_v2') {
        rows = yield* transaction.execute<{ readonly payload: RoutinePayload }>(
          sql`
            select payload from pricing.revise_quantity_tier_v2(
              ${tenantId}::uuid, ${legalEntityId}::uuid, ${encoded}::jsonb
            )
          `,
          'objects',
        );
      } else if (routine === 'lookup_quantity_tier_action_result_v1') {
        rows = yield* transaction.execute<{ readonly payload: RoutinePayload }>(
          sql`
            select payload from pricing.lookup_quantity_tier_action_result_v1(
              ${tenantId}::uuid, ${legalEntityId}::uuid, ${encoded}::jsonb
            )
          `,
          'objects',
        );
      } else {
        rows = yield* transaction.execute<{ readonly payload: RoutinePayload }>(
          sql`
            select payload from pricing.read_quantity_tier_schedule_v1(
              ${tenantId}::uuid, ${legalEntityId}::uuid, ${encoded}::jsonb
            )
          `,
          'objects',
        );
      }
      if (rows.length !== 1 || rows[0] === undefined) {
        throw new Error('Expected one Quantity Tier routine result');
      }
      return rows[0].payload;
    }),
  );

const callTierSetProof = <Input>(
  database: TestDb,
  routine:
    | 'read_current_quantity_tier_set_v1'
    | 'resolve_quantity_tier_set_proof_v1'
    | 'verify_quantity_tier_set_generation_v1',
  input: Input,
) =>
  database.transaction((transaction: Transaction) =>
    Effect.gen(function* callQuantityTierSetProofRoutine() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
        'objects',
      );
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input);
      let rows: readonly { readonly payload: TierSetProofPayload }[];
      if (routine === 'read_current_quantity_tier_set_v1') {
        rows = yield* transaction.execute<{ readonly payload: TierSetProofPayload }>(
          sql`select payload from pricing.read_current_quantity_tier_set_v1(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${encoded}::jsonb
              )`,
          'objects',
        );
      } else if (routine === 'resolve_quantity_tier_set_proof_v1') {
        rows = yield* transaction.execute<{ readonly payload: TierSetProofPayload }>(
          sql`select payload from pricing.resolve_quantity_tier_set_proof_v1(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${encoded}::jsonb
              )`,
          'objects',
        );
      } else {
        rows = yield* transaction.execute<{ readonly payload: TierSetProofPayload }>(
          sql`select payload from pricing.verify_quantity_tier_set_generation_v1(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${encoded}::jsonb
              )`,
          'objects',
        );
      }
      if (rows.length !== 1 || rows[0] === undefined) {
        throw new Error('Expected one Quantity Tier set proof result');
      }
      return rows[0].payload;
    }),
  );

const cleanup = (admin: TestDb) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupQuantityTierFixture() {
      yield* transaction.execute(
        sql`delete from pricing.material_evidence_proof_receipts
            where tenant_id = ${tenantId}::uuid and family = 'QUANTITY_TIER'`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_action_result_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_schedule_acknowledgements where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_schedule_heads where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_schedule_entries where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_schedule_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.quantity_tier_revisions where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.quantity_tiers where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.quantity_tier_set_heads where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_set_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.quantity_tier_set_roots where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(
        sql`delete from pricing.price_candidate_set_heads where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.price_candidate_set_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.price_candidate_set_roots where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.prices where tenant_id = ${tenantId}::uuid`);
    }),
  );

it.live('requires the exact future acknowledgement before same-value UNCHANGED and preserves its result', () =>
  Effect.scoped(
    Effect.gen(function* quantityTierManagementV2Proof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
      const catalogSelectionJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'e7970000-0000-4000-8000-000000000007',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef,
      });
      const unitRefJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(unitRef);
      yield* admin.execute(sql`
      insert into pricing.prices (
        price_id, tenant_id, legal_entity_id, catalog_selection, channel_id, market_id,
        currency_code, unit_ref, basis_quantity, price_group_selector,
        created_by_action_invocation_id, created_by_principal_id
      ) values (
        ${priceId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid,
        ${catalogSelectionJson}::jsonb,
        'B2C', 'cz-launch', 'CZK', ${unitRefJson}::jsonb, 1,
        '{"kind":"NO_GROUP"}'::jsonb,
        'e7970000-0000-4000-8000-000000000008'::uuid, ${principalId}::uuid
      )
    `);

      const define = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000010',
        effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2026-09-27T12:00:00.000Z' },
        expectedState: { state: 'ABSENT' },
        identityKey,
        reason: 'Define a zero-valued Tier.',
        requestCorrelationId: 'quantity-tier-v2:define',
        resultingUnitPrice: { amount: '0', currencyCode: 'CZK' },
        trustedOperationAt: '2026-09-27T09:00:00.000Z',
      };
      const created = yield* call(runtime, 'define_quantity_tier_v2', define);
      expect(created.outcome).toBe('QUANTITY_TIER_CREATED');
      expect(yield* call(runtime, 'define_quantity_tier_v2', define)).toEqual(created);
      expect(
        yield* call(runtime, 'define_quantity_tier_v2', {
          ...define,
          requestCorrelationId: 'quantity-tier-v2:define-retry',
          trustedOperationAt: '2026-09-27T09:30:00.000Z',
        }),
      ).toEqual(created);
      expect(
        yield* call(runtime, 'lookup_quantity_tier_action_result_v1', {
          actingPrincipalId: principalId,
          actionInvocationId: define.actionInvocationId,
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_RESULT_FOUND', result: created });
      expect(
        yield* call(runtime, 'lookup_quantity_tier_action_result_v1', {
          actingPrincipalId: 'e7970000-0000-4000-8000-000000000099',
          actionInvocationId: define.actionInvocationId,
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_RESULT_ABSENT' });

      const scheduled = yield* call(runtime, 'revise_quantity_tier_v2', {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000011',
        effectivePeriod: { effectiveFrom: '2026-09-27T14:00:00.000Z', effectiveTo: '2026-09-27T16:00:00.000Z' },
        expectedScheduleRevision: 1,
        identityKey,
        intent: 'SCHEDULE_REVISION',
        reason: 'Schedule a future value.',
        requestCorrelationId: 'quantity-tier-v2:schedule',
        resultingUnitPrice: { amount: '8', currencyCode: 'CZK' },
        trustedOperationAt: '2026-09-27T11:00:00.000Z',
      });
      expect(scheduled.outcome).toBe('QUANTITY_TIER_REVISED');
      const { schedule } = scheduled;
      if (schedule?.current === undefined) {
        throw new Error('Expected Current Quantity Tier schedule');
      }
      const sameValue = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000012',
        effectiveFrom: schedule.current.effectivePeriod.effectiveFrom,
        expectedCurrent: {
          effectivePeriod: schedule.current.effectivePeriod,
          identityKey: schedule.current.definition.identityKey,
          revision: schedule.current.definition.revision.revision,
          revisionId: schedule.current.definition.revision.revisionId,
          scheduleRevision: schedule.scheduleRevision,
        },
        identityKey,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Acknowledge the preserved future schedule.',
        requestCorrelationId: 'quantity-tier-v2:same-value',
        resultingUnitPrice: { amount: '0', currencyCode: 'CZK' },
        trustedOperationAt: '2026-09-27T11:00:00.000Z',
      };
      const challenge = yield* call(runtime, 'revise_quantity_tier_v2', sameValue);
      expect(challenge.outcome).toBe('QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED');
      if (challenge.acknowledgement === undefined) {
        throw new Error('Expected exact Quantity Tier acknowledgement');
      }
      expect(
        yield* call(runtime, 'lookup_quantity_tier_action_result_v1', {
          actingPrincipalId: principalId,
          actionInvocationId: sameValue.actionInvocationId,
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_RESULT_FOUND', result: challenge });
      expect(
        yield* call(runtime, 'revise_quantity_tier_v2', {
          ...sameValue,
          acknowledgement: challenge.acknowledgement,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000020',
          trustedOperationAt: '2026-09-27T12:30:00.000Z',
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'EFFECTIVE_BOUNDARY_STALE' });
      const acknowledged = {
        ...sameValue,
        acknowledgement: challenge.acknowledgement,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000015',
      };
      const unchanged = yield* call(runtime, 'revise_quantity_tier_v2', acknowledged);
      expect(unchanged.outcome).toBe('QUANTITY_TIER_UNCHANGED');
      expect(yield* call(runtime, 'revise_quantity_tier_v2', acknowledged)).toEqual(unchanged);
      expect(
        yield* call(runtime, 'revise_quantity_tier_v2', {
          ...acknowledged,
          requestCorrelationId: 'quantity-tier-v2:same-value-retry',
          trustedOperationAt: '2026-09-27T11:15:00.000Z',
        }),
      ).toEqual(unchanged);
      expect(
        yield* call(runtime, 'lookup_quantity_tier_action_result_v1', {
          actingPrincipalId: principalId,
          actionInvocationId: acknowledged.actionInvocationId,
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_RESULT_FOUND', result: unchanged });
      expect(
        yield* call(runtime, 'revise_quantity_tier_v2', {
          ...sameValue,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000013',
          expectedCurrent: { ...sameValue.expectedCurrent, scheduleRevision: 1 },
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'EXPECTED_CURRENT_STALE' });

      const successorIntent = {
        ...sameValue,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000014',
        effectiveFrom: '2026-09-27T11:30:00.000Z',
        reason: 'Create an immutable same-value successor from an explicit T.',
        requestCorrelationId: 'quantity-tier-v2:same-value-successor',
        trustedOperationAt: '2026-09-27T11:30:00.000Z',
      };
      const successorChallenge = yield* call(runtime, 'revise_quantity_tier_v2', successorIntent);
      expect(successorChallenge.outcome).toBe('QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED');
      if (successorChallenge.acknowledgement === undefined) {
        throw new Error('Expected exact successor Quantity Tier acknowledgement');
      }
      const revised = yield* call(runtime, 'revise_quantity_tier_v2', {
        ...successorIntent,
        acknowledgement: successorChallenge.acknowledgement,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000016',
      });
      expect(revised).toMatchObject({
        outcome: 'QUANTITY_TIER_REVISED',
        schedule: {
          current: {
            effectivePeriod: {
              effectiveFrom: successorIntent.effectiveFrom,
              effectiveTo: define.effectivePeriod.effectiveTo,
            },
          },
        },
      });
      expect(revised.schedule?.revisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            effectivePeriod: {
              effectiveFrom: define.effectivePeriod.effectiveFrom,
              effectiveTo: successorIntent.effectiveFrom,
            },
          }),
          expect.objectContaining({
            effectivePeriod: {
              effectiveFrom: successorIntent.effectiveFrom,
              effectiveTo: define.effectivePeriod.effectiveTo,
            },
          }),
        ]),
      );
      expect(
        yield* call(runtime, 'lookup_quantity_tier_action_result_v1', {
          actingPrincipalId: principalId,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000016',
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_RESULT_FOUND', result: revised });

      const privilegeRows = yield* admin.execute<{ readonly allowed: boolean }>(
        sql`
        select has_function_privilege(
          'ontos_runtime',
          'pricing.define_quantity_tier_v1(uuid,uuid,jsonb)',
          'EXECUTE'
        ) or has_function_privilege(
          'ontos_runtime',
          'pricing.revise_quantity_tier_v1(uuid,uuid,jsonb)',
          'EXECUTE'
        ) as allowed
      `,
        'objects',
      );
      expect(privilegeRows).toEqual([{ allowed: false }]);

      const raceIdentity = { ...identityKey, thresholdQuantity: '20' };
      const raceCommand = {
        actingPrincipalId: principalId,
        effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
        expectedState: { state: 'ABSENT' },
        identityKey: raceIdentity,
        reason: 'Race the exact same first Quantity Tier create.',
        resultingUnitPrice: { amount: '6', currencyCode: 'CZK' },
        trustedOperationAt: '2026-09-27T09:00:00.000Z',
      };
      const raced = yield* Effect.all(
        [
          call(runtime, 'define_quantity_tier_v2', {
            ...raceCommand,
            actionInvocationId: 'e7970000-0000-4000-8000-000000000017',
            requestCorrelationId: 'quantity-tier-v2:race-a',
          }),
          call(runtime, 'define_quantity_tier_v2', {
            ...raceCommand,
            actionInvocationId: 'e7970000-0000-4000-8000-000000000018',
            requestCorrelationId: 'quantity-tier-v2:race-b',
          }),
        ],
        { concurrency: 'unbounded' },
      );
      expect(raced.map(({ outcome }) => outcome).toSorted()).toEqual([
        'QUANTITY_TIER_CONFLICT',
        'QUANTITY_TIER_CREATED',
      ]);
      expect(raced.find(({ outcome }) => outcome === 'QUANTITY_TIER_CONFLICT')).toMatchObject({
        reason: 'EXPECTED_CURRENT_STALE',
      });

      const openSchedule = yield* call(runtime, 'read_quantity_tier_schedule_v1', {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000021',
        identityKey: raceIdentity,
        trustedOperationAt: '2026-09-27T11:00:00.000Z',
      });
      if (openSchedule.schedule?.current === undefined) {
        throw new Error('Expected raced open-ended Quantity Tier Current');
      }
      const openCurrent = openSchedule.schedule.current;
      const openRevised = yield* call(runtime, 'revise_quantity_tier_v2', {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000019',
        effectiveFrom: '2026-09-27T11:00:00.000Z',
        expectedCurrent: {
          effectivePeriod: openCurrent.effectivePeriod,
          identityKey: raceIdentity,
          revision: openCurrent.definition.revision.revision,
          revisionId: openCurrent.definition.revision.revisionId,
          scheduleRevision: openSchedule.schedule.scheduleRevision,
        },
        identityKey: raceIdentity,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Split an open-ended Current into an immutable successor.',
        requestCorrelationId: 'quantity-tier-v2:open-successor',
        resultingUnitPrice: { amount: '5', currencyCode: 'CZK' },
        trustedOperationAt: '2026-09-27T11:00:00.000Z',
      });
      expect(openRevised).toMatchObject({
        outcome: 'QUANTITY_TIER_REVISED',
        schedule: {
          current: { effectivePeriod: { effectiveFrom: '2026-09-27T11:00:00.000Z', effectiveTo: null } },
        },
      });
      expect(openRevised.schedule?.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2026-09-27T11:00:00.000Z' },
        { effectiveFrom: '2026-09-27T11:00:00.000Z', effectiveTo: null },
      ]);
    }),
  ),
);

it.live('retires Current only after exact acknowledgement and corrects one immutable Revision', () =>
  Effect.scoped(
    Effect.gen(function* retireAndCorrectQuantityTier() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
      const catalogSelectionJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'e7970000-0000-4000-8000-000000000007',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef,
      });
      const unitRefJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(unitRef);
      yield* admin.execute(sql`
        insert into pricing.prices (
          price_id, tenant_id, legal_entity_id, catalog_selection, channel_id, market_id,
          currency_code, unit_ref, basis_quantity, price_group_selector,
          created_by_action_invocation_id, created_by_principal_id
        ) values (
          ${priceId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid,
          ${catalogSelectionJson}::jsonb,
          'B2C', 'cz-launch', 'CZK', ${unitRefJson}::jsonb, 1,
          '{"kind":"NO_GROUP"}'::jsonb,
          'e7970000-0000-4000-8000-000000000108'::uuid, ${principalId}::uuid
        )
      `);

      const created = yield* call(runtime, 'define_quantity_tier_v2', {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000110',
        effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2999-09-27T12:00:00.000Z' },
        expectedState: { state: 'ABSENT' },
        identityKey,
        reason: 'Define the Quantity Tier retirement target.',
        requestCorrelationId: 'quantity-tier-v2:retire-define',
        resultingUnitPrice: { amount: '4', currencyCode: 'CZK' },
        trustedOperationAt: '2026-09-27T09:00:00.000Z',
      });
      expect(created.outcome).toBe('QUANTITY_TIER_CREATED');

      const scheduled = yield* call(runtime, 'revise_quantity_tier_v2', {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000111',
        effectivePeriod: { effectiveFrom: '2999-09-27T14:00:00.000Z', effectiveTo: '2999-09-27T16:00:00.000Z' },
        expectedScheduleRevision: 1,
        identityKey,
        intent: 'SCHEDULE_REVISION',
        reason: 'Schedule a future Quantity Tier before retirement.',
        requestCorrelationId: 'quantity-tier-v2:retire-schedule',
        resultingUnitPrice: { amount: '8', currencyCode: 'CZK' },
        trustedOperationAt: '2026-09-27T10:30:00.000Z',
      });
      if (scheduled.schedule?.current === undefined) {
        throw new Error('Expected Current Quantity Tier before retirement');
      }
      const proofEffectiveAt = '2026-09-27T10:30:00.000Z';
      const tierSetProof = yield* callTierSetProof(runtime, 'read_current_quantity_tier_set_v1', {
        effectiveAt: proofEffectiveAt,
        priceRef: identityKey.priceRef,
      });
      expect(tierSetProof).toMatchObject({
        authority: { generation: 3 },
        outcome: 'QUANTITY_TIER_SET_CURRENT',
        tierSet: { currentTiers: [{ definition: { revision: { revisionId: expect.any(String) } } }] },
      });
      if (tierSetProof.authority === undefined) {
        throw new Error('Expected durable Quantity Tier set proof authority');
      }
      const proofResolutionInput = {
        effectiveAt: proofEffectiveAt,
        priceRef: identityKey.priceRef,
        verificationRef: tierSetProof.authority.verificationRef,
      };
      const resolvedBeforeMutation = yield* callTierSetProof(
        runtime,
        'resolve_quantity_tier_set_proof_v1',
        proofResolutionInput,
      );
      expect(resolvedBeforeMutation).toMatchObject({
        authority: tierSetProof.authority,
        currentFacts: [{ verificationRef: tierSetProof.authority.verificationRef }],
        outcome: 'QUANTITY_TIER_SET_PROOF_RESOLVED',
      });
      const currentnessInput = {
        ...tierSetProof.authority,
        effectiveAt: proofEffectiveAt,
        priceRef: identityKey.priceRef,
        through: tierSetProof.authority.observedAt,
      };
      expect(
        yield* callTierSetProof(runtime, 'verify_quantity_tier_set_generation_v1', currentnessInput),
      ).toMatchObject({
        generation: tierSetProof.authority.generation,
        outcome: 'QUANTITY_TIER_SET_GENERATION_CURRENT',
        verificationRef: tierSetProof.authority.verificationRef,
      });
      const retirement = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000112',
        effectiveTo: '2026-09-27T11:00:00.000Z',
        expectedCurrent: {
          effectivePeriod: scheduled.schedule.current.effectivePeriod,
          identityKey,
          revision: scheduled.schedule.current.definition.revision.revision,
          revisionId: scheduled.schedule.current.definition.revision.revisionId,
          scheduleRevision: scheduled.schedule.scheduleRevision,
        },
        identityKey,
        intent: 'RETIRE_CURRENT',
        reason: 'End the Current Quantity Tier while preserving its future schedule.',
        requestCorrelationId: 'quantity-tier-v2:retire',
        trustedOperationAt: '2026-09-27T11:00:00.000Z',
      } as const;
      const retirementChallenge = yield* call(runtime, 'revise_quantity_tier_v2', retirement);
      expect(retirementChallenge.outcome).toBe('QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED');
      if (retirementChallenge.acknowledgement === undefined) {
        throw new Error('Expected exact Quantity Tier retirement acknowledgement');
      }
      const [challengeState] = yield* admin.execute<{
        readonly acknowledgementCount: number;
        readonly scheduleRevision: number;
      }>(
        sql`select head.schedule_revision as "scheduleRevision",
                   (select count(*)::integer
                      from pricing.quantity_tier_schedule_acknowledgements as acknowledgement
                     where acknowledgement.tenant_id = ${tenantId}::uuid) as "acknowledgementCount"
              from pricing.quantity_tier_schedule_heads as head
             where head.tenant_id = ${tenantId}::uuid
               and head.legal_entity_id = ${legalEntityId}::uuid`,
        'objects',
      );
      expect(challengeState).toEqual({ acknowledgementCount: 1, scheduleRevision: 2 });
      expect(
        yield* call(runtime, 'lookup_quantity_tier_action_result_v1', {
          actingPrincipalId: principalId,
          actionInvocationId: retirement.actionInvocationId,
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_RESULT_FOUND', result: retirementChallenge });

      const forgedAcknowledgement = {
        ...retirementChallenge.acknowledgement,
        fingerprint: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      };
      expect(
        yield* call(runtime, 'revise_quantity_tier_v2', {
          ...retirement,
          acknowledgement: forgedAcknowledgement,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000117',
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'ACKNOWLEDGEMENT_STALE' });
      const [afterForgedAcknowledgement] = yield* admin.execute<{
        readonly revisionCount: number;
        readonly scheduleRevision: number;
      }>(
        sql`select head.schedule_revision as "scheduleRevision",
                   (select count(*)::integer
                      from pricing.quantity_tier_revisions as revision
                     where revision.tenant_id = ${tenantId}::uuid
                       and revision.legal_entity_id = ${legalEntityId}::uuid) as "revisionCount"
              from pricing.quantity_tier_schedule_heads as head
             where head.tenant_id = ${tenantId}::uuid
               and head.legal_entity_id = ${legalEntityId}::uuid`,
        'objects',
      );
      expect(afterForgedAcknowledgement).toEqual({ revisionCount: 2, scheduleRevision: 2 });

      const retired = yield* call(runtime, 'revise_quantity_tier_v2', {
        ...retirement,
        acknowledgement: retirementChallenge.acknowledgement,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000113',
      });
      expect(retired).toMatchObject({
        outcome: 'QUANTITY_TIER_REVISED',
        schedule: { scheduleRevision: 3 },
      });
      expect(retired.schedule?.current).toBeUndefined();
      expect(retired.schedule?.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2026-09-27T11:00:00.000Z' },
        { effectiveFrom: '2999-09-27T14:00:00.000Z', effectiveTo: '2999-09-27T16:00:00.000Z' },
      ]);
      expect(yield* callTierSetProof(runtime, 'resolve_quantity_tier_set_proof_v1', proofResolutionInput)).toEqual(
        resolvedBeforeMutation,
      );
      expect(
        yield* callTierSetProof(runtime, 'verify_quantity_tier_set_generation_v1', currentnessInput),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_SET_GENERATION_CHANGED' });
      expect(
        yield* call(runtime, 'revise_quantity_tier_v2', {
          ...retirement,
          acknowledgement: retirementChallenge.acknowledgement,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000113',
          requestCorrelationId: 'quantity-tier-v2:retire-retry',
        }),
      ).toEqual(retired);

      const scheduledRevision = retired.schedule?.revisions.find(
        ({ effectivePeriod }) => effectivePeriod.effectiveFrom === '2999-09-27T14:00:00.000Z',
      );
      if (scheduledRevision === undefined) {
        throw new Error('Expected the preserved future Quantity Tier Revision');
      }
      const correction = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000114',
        expectedScheduleRevision: 3,
        identityKey,
        intent: 'CORRECT_REVISION',
        reason: 'Correct only the selected future Quantity Tier Revision.',
        requestCorrelationId: 'quantity-tier-v2:correct',
        resultingUnitPrice: { amount: '9', currencyCode: 'CZK' },
        targetEffectivePeriod: scheduledRevision.effectivePeriod,
        targetRevisionId: scheduledRevision.definition.revision.revisionId,
        trustedOperationAt: '2026-09-27T11:30:00.000Z',
      } as const;
      expect(
        yield* call(runtime, 'revise_quantity_tier_v2', {
          ...correction,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000115',
          expectedScheduleRevision: 2,
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'EXPECTED_SCHEDULE_STALE' });
      expect(
        yield* call(runtime, 'revise_quantity_tier_v2', {
          ...correction,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000116',
          targetEffectivePeriod: { ...correction.targetEffectivePeriod, effectiveTo: null },
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'EFFECTIVE_BOUNDARY_STALE' });

      const corrected = yield* call(runtime, 'revise_quantity_tier_v2', correction);
      expect(corrected).toMatchObject({ outcome: 'QUANTITY_TIER_REVISED', schedule: { scheduleRevision: 4 } });
      expect(
        corrected.schedule?.revisions.find(
          ({ effectivePeriod }) => effectivePeriod.effectiveFrom === '2999-09-27T14:00:00.000Z',
        ),
      ).toMatchObject({
        definition: { revision: { resultingUnitPrice: { amount: '9.000000000', currencyCode: 'CZK' } } },
        effectivePeriod: scheduledRevision.effectivePeriod,
        lineage: {
          correctedRevisionId: scheduledRevision.definition.revision.revisionId,
          kind: 'CORRECTION',
          previousRevisionId: scheduledRevision.definition.revision.revisionId,
        },
      });
      expect(yield* call(runtime, 'revise_quantity_tier_v2', correction)).toEqual(corrected);
      expect(
        yield* call(runtime, 'lookup_quantity_tier_action_result_v1', {
          actingPrincipalId: principalId,
          actionInvocationId: correction.actionInvocationId,
        }),
      ).toMatchObject({ outcome: 'QUANTITY_TIER_RESULT_FOUND', result: corrected });

      const lineage = yield* admin.execute<{
        readonly correctedRevisionId: null | string;
        readonly previousRevisionId: null | string;
        readonly transitionKind: string;
      }>(
        sql`select corrected_revision_id::text as "correctedRevisionId",
                   previous_revision_id::text as "previousRevisionId",
                   transition_kind as "transitionKind"
              from pricing.quantity_tier_revisions
             where tenant_id = ${tenantId}::uuid
               and action_invocation_id in (
                 'e7970000-0000-4000-8000-000000000113'::uuid,
                 'e7970000-0000-4000-8000-000000000114'::uuid
               )
             order by revision_number`,
        'objects',
      );
      expect(lineage).toEqual([
        {
          correctedRevisionId: null,
          previousRevisionId: scheduled.schedule.current.definition.revision.revisionId,
          transitionKind: 'RETIREMENT',
        },
        {
          correctedRevisionId: scheduledRevision.definition.revision.revisionId,
          previousRevisionId: scheduledRevision.definition.revision.revisionId,
          transitionKind: 'CORRECTION',
        },
      ]);
    }),
  ),
);
