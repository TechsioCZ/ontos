import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { sql } from 'drizzle-orm';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { PriceGroupDefinitionRevision } from '../../shared/domain/price-group.ts';
import { RetirePriceGroupPayloadSchema } from '../../shared/actions/retire-price-group.ts';
import {
  PriceGroupCodeConflict,
  PriceGroupCurrentnessFailure,
  PriceGroupEffectivePeriodConflict,
  PriceGroupExpectedCurrentConflict,
  PriceGroupIdempotencyReuseConflict,
  PriceGroupLifecycleConflict,
  PriceGroupRetirementEffectiveTimeConflict,
} from '../../shared/domain/price-group-errors.ts';
import { priceGroupCatalogRelations } from '../../src/database/schema.ts';
import { handleRetirePriceGroup, retirePriceGroupAction } from '../../src/actions/retire-price-group.action.ts';
import { priceGroupCatalogPersistenceFromRoutineInvoker } from '../../src/persistence/price-group-catalog-persistence.ts';

const tenantId = 'a3400000-0000-4000-8000-000000000001';
const otherTenantId = 'a3400000-0000-4000-8000-000000000002';
const principalId = 'a3400000-0000-4000-8000-000000000003';
const createInvocationId = 'a3400000-0000-4000-8000-000000000004';
const duplicateInvocationId = 'a3400000-0000-4000-8000-000000000005';
const revisionInvocationId = 'a3400000-0000-4000-8000-000000000006';
const revisionId = 'a3400000-0000-4000-8000-000000000007';
const retireInvocationId = 'a3400000-0000-4000-8000-000000000008';
const secondRetireInvocationId = 'a3400000-0000-4000-8000-000000000009';
const competingCreateInvocationId = 'a3400000-0000-4000-8000-000000000010';
const competingCreateInvocationId2 = 'a3400000-0000-4000-8000-000000000011';
const retroactiveRevisionInvocationId = 'a3400000-0000-4000-8000-000000000012';
const retroactiveRevisionId = 'a3400000-0000-4000-8000-000000000013';
const staleRevisionInvocationId = 'a3400000-0000-4000-8000-000000000014';
const staleRevisionId = 'a3400000-0000-4000-8000-000000000015';
const competingRetireInvocationId = 'a3400000-0000-4000-8000-000000000016';
const backdatedRetireInvocationId = 'a3400000-0000-4000-8000-000000000017';
const preRetirementRevisionInvocationId = 'a3400000-0000-4000-8000-000000000018';
const preRetirementRevisionId = 'a3400000-0000-4000-8000-000000000019';
const boundaryRevisionInvocationId = 'a3400000-0000-4000-8000-000000000020';
const boundaryRevisionId = 'a3400000-0000-4000-8000-000000000021';
const actionDbCreateInvocationId = 'a3400000-0000-4000-8000-000000000022';
const actionDbRetireInvocationId = 'a3400000-0000-4000-8000-000000000023';
const openEndedRevisionInvocationId = 'a3400000-0000-4000-8000-000000000024';
const openEndedRevisionId = 'a3400000-0000-4000-8000-000000000025';
const raceCreateInvocationId = 'a3400000-0000-4000-8000-000000000026';
const raceRetireInvocationId = 'a3400000-0000-4000-8000-000000000027';
const raceRevisionInvocationId = 'a3400000-0000-4000-8000-000000000028';
const raceRevisionId = 'a3400000-0000-4000-8000-000000000029';
const shortRevisionInvocationId = 'a3400000-0000-4000-8000-000000000030';
const shortRevisionId = 'a3400000-0000-4000-8000-000000000031';
const fingerprint = 'a'.repeat(64);
const requiredContract = {
  contractId: 'commerce.customer-price-group-assignment',
  version: 1,
} as const;

interface RoutinePayload {
  readonly _tag: string;
  readonly definition?: PriceGroupDefinitionRevision;
}

interface RoutineRow extends Record<string, unknown> {
  readonly payload: RoutinePayload;
}

it.live('executes the tenant-only Price Group lifecycle through the six governed routines', () =>
  Effect.scoped(
    Effect.gen(function* governedRoutineBehavior() {
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, priceGroupCatalogRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, priceGroupCatalogRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanupTenant() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_containment_projection_intents where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_retirements where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_compatibility_support where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_definition_effective_intervals where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_definition_revisions where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_groups where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_catalog_ledger where tenant_id = ${tenantId}::uuid`,
            );
          }),
        );

      const scope = {
        authMethod: 'system' as const,
        correlationId: 'price-group-governed-routine-test',
        principalId,
        tenantId,
      };
      const inScope = <Value, Failure>(
        operation: (invoker: ReturnType<typeof scopedRoutineInvokerFromTransaction>) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedOperation() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            const invoker = scopedRoutineInvokerFromTransaction(
              // oxlint-disable-next-line sonarjs/no-nested-functions -- The callback retains its scoped executor; remove-when: Core exposes the bound executor directly.
              (statement) => transaction.execute(statement, 'objects'),
              scope,
            );
            return yield* operation(invoker);
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const createInput = {
        actingPrincipalId: principalId,
        actionInvocationId: createInvocationId,
        businessCode: 'DEALER',
        classificationPurpose: 'Classifies customers eligible for dealer pricing.',
        compatibilityContracts: [requiredContract],
        description: 'Dealer price classification.',
        displayName: 'Dealer',
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        expectedCatalogRevision: 0,
        meaningFingerprint: fingerprint,
        reason: 'Approved initial dealer definition.',
        trustedEffectiveAt: new Date('2026-08-01T00:00:00.000Z'),
      };
      const [createdOutcome, replayedOutcome] = yield* Effect.all(
        [
          inScope((invoker) =>
            priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup(createInput),
          ),
          inScope((invoker) =>
            priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup(createInput),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      const created = createdOutcome.definition;
      expect(created).toMatchObject({
        acceptedCatalogRevision: 1,
        revisionNumber: 1,
      });

      expect(replayedOutcome).toEqual(createdOutcome);

      const conflictingReuse = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
            ...createInput,
            displayName: 'Changed replay intent',
          }),
        ),
      );
      expect(Schema.is(PriceGroupIdempotencyReuseConflict)(conflictingReuse)).toBe(true);

      const duplicateCode = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
            ...createInput,
            actionInvocationId: duplicateInvocationId,
            expectedCatalogRevision: 1,
            meaningFingerprint: 'b'.repeat(64),
          }),
        ),
      );
      expect(Schema.is(PriceGroupCodeConflict)(duplicateCode)).toBe(true);

      const competingCreateInput = {
        ...createInput,
        actionInvocationId: competingCreateInvocationId,
        businessCode: 'WHOLESALE',
        classificationPurpose: 'Classifies customers eligible for wholesale pricing.',
        description: 'Wholesale price classification.',
        displayName: 'Wholesale',
        expectedCatalogRevision: 1,
        meaningFingerprint: 'c'.repeat(64),
        reason: 'Approved initial wholesale definition.',
      };
      const competingCreates = yield* Effect.all(
        [
          inScope((invoker) =>
            Effect.result(
              priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup(competingCreateInput),
            ),
          ),
          inScope((invoker) =>
            Effect.result(
              priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
                ...competingCreateInput,
                actionInvocationId: competingCreateInvocationId2,
                meaningFingerprint: 'd'.repeat(64),
              }),
            ),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      const competingSuccesses = competingCreates.flatMap((result) =>
        Result.isSuccess(result) ? [result.success.definition] : [],
      );
      const competingFailures = competingCreates.flatMap((result) =>
        Result.isFailure(result) ? [result.failure] : [],
      );
      expect(competingSuccesses).toHaveLength(1);
      expect(competingFailures).toHaveLength(1);
      expect(Schema.is(PriceGroupCodeConflict)(competingFailures[0])).toBe(true);
      const [competingGroup] = competingSuccesses;
      if (competingGroup === undefined) {
        yield* Effect.die('Expected exactly one successful competing Price Group create');
      }
      expect(competingGroup.acceptedCatalogRevision).toBe(2);

      const zeroCurrent = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readCurrentDefinition(
            created.priceGroupRef,
            new Date('2026-07-31T23:59:59.999Z'),
          ),
        ),
      );
      expect(Schema.is(PriceGroupCurrentnessFailure)(zeroCurrent)).toBe(true);
      if (Schema.is(PriceGroupCurrentnessFailure)(zeroCurrent)) {
        expect(zeroCurrent.candidateDefinitionRevisionIds).toEqual([]);
        expect(zeroCurrent.reason).toBe('ZERO_CURRENT_DEFINITIONS');
      }

      const expectedCurrent = {
        catalogRevision: created.acceptedCatalogRevision,
        definitionRevisionId: created.definitionRevisionId,
        definitionRevisionNumber: created.revisionNumber,
        meaningFingerprint: created.meaningFingerprint,
        priceGroupRef: created.priceGroupRef,
      };

      const retroactive = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
            actingPrincipalId: principalId,
            actionInvocationId: retroactiveRevisionInvocationId,
            classificationPurpose: created.classificationPurpose,
            compatibilityContracts: [requiredContract],
            definitionRevisionId: retroactiveRevisionId,
            description: 'Rejected retroactive dealer clarification.',
            displayName: 'Dealer',
            effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
            expectedCurrent,
            meaningFingerprint: fingerprint,
            reason: 'Attempted retroactive clarification.',
            trustedEffectiveAt: new Date('2026-09-10T00:00:00.000Z'),
          }),
        ),
      );
      expect(Schema.is(PriceGroupEffectivePeriodConflict)(retroactive)).toBe(true);
      const historical = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readCurrentDefinition(
          created.priceGroupRef,
          new Date('2026-09-05T00:00:00.000Z'),
        ),
      );
      expect(historical.definition.definitionRevisionId).toBe(created.definitionRevisionId);
      expect(historical.identity.priceGroupRef).toEqual(created.priceGroupRef);

      const revised = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
          actingPrincipalId: principalId,
          actionInvocationId: revisionInvocationId,
          classificationPurpose: created.classificationPurpose,
          compatibilityContracts: [requiredContract],
          definitionRevisionId: revisionId,
          description: 'Dealer price classification, clarified without changing meaning.',
          displayName: 'Dealer',
          effectiveFrom: new Date('2026-09-15T00:00:00.000Z'),
          expectedCurrent,
          meaningFingerprint: fingerprint,
          reason: 'Approved non-material clarification.',
          trustedEffectiveAt: new Date('2026-09-10T00:00:00.000Z'),
        }),
      );
      expect(revised).toMatchObject({
        acceptedCatalogRevision: 3,
        definitionRevisionId: revisionId,
        previousDefinitionRevisionId: created.definitionRevisionId,
        revisionNumber: 2,
      });
      const beforeScheduledBoundary = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readCurrentDefinition(
          created.priceGroupRef,
          new Date('2026-09-12T00:00:00.000Z'),
        ),
      );
      expect(beforeScheduledBoundary.catalogRevision).toBe(3);
      expect(beforeScheduledBoundary.definition.acceptedCatalogRevision).toBe(1);
      expect(beforeScheduledBoundary.definition.definitionRevisionId).toBe(created.definitionRevisionId);
      expect(beforeScheduledBoundary.identity.businessCode).toBe('DEALER');
      const supersededRevision = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readDefinitionRevision(
          created.priceGroupRef,
          created.definitionRevisionId,
          new Date('2026-09-15T00:00:00.000Z'),
        ),
      );
      expect(supersededRevision.definition.effectivePeriod.effectiveTo).toBe('2026-09-15T00:00:00.000Z');

      const staleRevision = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
            actingPrincipalId: principalId,
            actionInvocationId: staleRevisionInvocationId,
            classificationPurpose: created.classificationPurpose,
            compatibilityContracts: [requiredContract],
            definitionRevisionId: staleRevisionId,
            description: 'Stale dealer clarification.',
            displayName: 'Dealer',
            effectiveFrom: new Date('2026-09-16T00:00:00.000Z'),
            expectedCurrent,
            meaningFingerprint: fingerprint,
            reason: 'Attempted stale clarification.',
            trustedEffectiveAt: new Date('2026-09-11T00:00:00.000Z'),
          }),
        ),
      );
      expect(Schema.is(PriceGroupExpectedCurrentConflict)(staleRevision)).toBe(true);

      const compatibility = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).validateCompatibility(
          revised.priceGroupRef,
          requiredContract,
          new Date('2026-09-15T00:00:00.000Z'),
          {
            catalogRevision: revised.acceptedCatalogRevision,
            definitionRevisionId: revised.definitionRevisionId,
            definitionRevisionNumber: revised.revisionNumber,
            meaningFingerprint: revised.meaningFingerprint,
            priceGroupRef: revised.priceGroupRef,
          },
        ),
      );
      expect(compatibility).toMatchObject({
        evidence: {
          catalogRevision: 3,
          definitionRevisionId: revisionId,
          definitionRevisionNumber: 2,
        },
        kind: 'USABLE',
      });

      const retirementExpectedCurrent = {
        catalogRevision: revised.acceptedCatalogRevision,
        definitionRevisionId: revised.definitionRevisionId,
        definitionRevisionNumber: revised.revisionNumber,
        meaningFingerprint: revised.meaningFingerprint,
        priceGroupRef: revised.priceGroupRef,
      };

      const backdatedRetirement = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup({
            actingPrincipalId: principalId,
            actionInvocationId: backdatedRetireInvocationId,
            effectiveAt: new Date('2026-09-19T00:00:00.000Z'),
            expectedCurrent: retirementExpectedCurrent,
            reason: 'Attempted backdated retirement.',
            trustedEffectiveAt: new Date('2026-09-20T00:00:00.000Z'),
          }),
        ),
      );
      expect(Schema.is(PriceGroupRetirementEffectiveTimeConflict)(backdatedRetirement)).toBe(true);

      const competingRetirementInput = {
        actingPrincipalId: principalId,
        actionInvocationId: competingRetireInvocationId,
        effectiveAt: new Date('2026-09-22T00:00:00.000Z'),
        expectedCurrent: {
          catalogRevision: competingGroup.acceptedCatalogRevision,
          definitionRevisionId: competingGroup.definitionRevisionId,
          definitionRevisionNumber: competingGroup.revisionNumber,
          meaningFingerprint: competingGroup.meaningFingerprint,
          priceGroupRef: competingGroup.priceGroupRef,
        },
        reason: 'Wholesale classification retired.',
        trustedEffectiveAt: new Date('2026-09-20T00:00:00.000Z'),
      };
      const competingRetirement = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup(competingRetirementInput),
      );
      const replayedCompetingRetirement = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup(competingRetirementInput),
      );
      expect(competingRetirement.acceptedCatalogRevision).toBe(4);
      expect(replayedCompetingRetirement).toEqual(competingRetirement);
      expect(competingRetirement.retirementEffectiveAt).toBe('2026-09-22T00:00:00.000Z');
      expect(competingRetirement.trustedOperationAt).toBe('2026-09-20T00:00:00.000Z');
      expect(competingRetirement.retirementProvenance.trustedAt).toBe('2026-09-20T00:00:00.000Z');
      expect(Date.parse(competingRetirement.verifiedAt)).toBeGreaterThanOrEqual(
        Date.parse(competingRetirement.trustedOperationAt),
      );

      const shortPreRetirementRevision = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
            actingPrincipalId: principalId,
            actionInvocationId: shortRevisionInvocationId,
            classificationPurpose: competingGroup.classificationPurpose,
            compatibilityContracts: [requiredContract],
            definitionRevisionId: shortRevisionId,
            description: 'Invalid revision ending before scheduled retirement.',
            displayName: 'Wholesale',
            effectiveFrom: new Date('2026-09-21T06:00:00.000Z'),
            effectiveTo: new Date('2026-09-21T12:00:00.000Z'),
            expectedCurrent: {
              catalogRevision: competingGroup.acceptedCatalogRevision,
              definitionRevisionId: competingGroup.definitionRevisionId,
              definitionRevisionNumber: competingGroup.revisionNumber,
              meaningFingerprint: competingGroup.meaningFingerprint,
              priceGroupRef: competingGroup.priceGroupRef,
            },
            meaningFingerprint: competingGroup.meaningFingerprint,
            reason: 'Attempted revision ending before the retirement boundary.',
            trustedEffectiveAt: new Date('2026-09-21T00:00:00.000Z'),
          }),
        ),
      );
      expect(Schema.is(PriceGroupEffectivePeriodConflict)(shortPreRetirementRevision)).toBe(true);
      const unchangedAfterShortRevision = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readCurrentDefinition(
          competingGroup.priceGroupRef,
          new Date('2026-09-21T11:59:59.999Z'),
        ),
      );
      expect(unchangedAfterShortRevision.catalogRevision).toBe(competingGroup.acceptedCatalogRevision);
      expect(unchangedAfterShortRevision.definition.definitionRevisionId).toBe(competingGroup.definitionRevisionId);

      const preRetirementRevision = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
          actingPrincipalId: principalId,
          actionInvocationId: preRetirementRevisionInvocationId,
          classificationPurpose: competingGroup.classificationPurpose,
          compatibilityContracts: [requiredContract],
          definitionRevisionId: preRetirementRevisionId,
          description: 'Wholesale clarification before scheduled retirement.',
          displayName: 'Wholesale',
          effectiveFrom: new Date('2026-09-21T12:00:00.000Z'),
          effectiveTo: new Date('2026-09-22T00:00:00.000Z'),
          expectedCurrent: {
            catalogRevision: competingGroup.acceptedCatalogRevision,
            definitionRevisionId: competingGroup.definitionRevisionId,
            definitionRevisionNumber: competingGroup.revisionNumber,
            meaningFingerprint: competingGroup.meaningFingerprint,
            priceGroupRef: competingGroup.priceGroupRef,
          },
          meaningFingerprint: competingGroup.meaningFingerprint,
          reason: 'Approved clarification wholly before retirement.',
          trustedEffectiveAt: new Date('2026-09-21T00:00:00.000Z'),
        }),
      );
      expect(preRetirementRevision.acceptedCatalogRevision).toBe(5);
      const replayedAfterPreRetirementRevision = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup(competingRetirementInput),
      );
      expect(replayedAfterPreRetirementRevision).toEqual(competingRetirement);

      const atBoundaryRevision = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
            actingPrincipalId: principalId,
            actionInvocationId: boundaryRevisionInvocationId,
            classificationPurpose: competingGroup.classificationPurpose,
            compatibilityContracts: [requiredContract],
            definitionRevisionId: boundaryRevisionId,
            description: 'Invalid clarification at the retirement boundary.',
            displayName: 'Wholesale',
            effectiveFrom: new Date('2026-09-22T00:00:00.000Z'),
            effectiveTo: new Date('2026-09-23T00:00:00.000Z'),
            expectedCurrent: {
              catalogRevision: preRetirementRevision.acceptedCatalogRevision,
              definitionRevisionId: preRetirementRevision.definitionRevisionId,
              definitionRevisionNumber: preRetirementRevision.revisionNumber,
              meaningFingerprint: preRetirementRevision.meaningFingerprint,
              priceGroupRef: preRetirementRevision.priceGroupRef,
            },
            meaningFingerprint: preRetirementRevision.meaningFingerprint,
            reason: 'Attempted clarification at retirement boundary.',
            trustedEffectiveAt: new Date('2026-09-21T00:00:00.000Z'),
          }),
        ),
      );
      expect(Schema.is(PriceGroupEffectivePeriodConflict)(atBoundaryRevision)).toBe(true);

      const openEndedRevision = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
            actingPrincipalId: principalId,
            actionInvocationId: openEndedRevisionInvocationId,
            classificationPurpose: competingGroup.classificationPurpose,
            compatibilityContracts: [requiredContract],
            definitionRevisionId: openEndedRevisionId,
            description: 'Invalid open-ended clarification before retirement.',
            displayName: 'Wholesale',
            effectiveFrom: new Date('2026-09-21T18:00:00.000Z'),
            expectedCurrent: {
              catalogRevision: preRetirementRevision.acceptedCatalogRevision,
              definitionRevisionId: preRetirementRevision.definitionRevisionId,
              definitionRevisionNumber: preRetirementRevision.revisionNumber,
              meaningFingerprint: preRetirementRevision.meaningFingerprint,
              priceGroupRef: preRetirementRevision.priceGroupRef,
            },
            meaningFingerprint: preRetirementRevision.meaningFingerprint,
            reason: 'Attempted open-ended clarification before retirement.',
            trustedEffectiveAt: new Date('2026-09-21T00:00:00.000Z'),
          }),
        ),
      );
      expect(Schema.is(PriceGroupEffectivePeriodConflict)(openEndedRevision)).toBe(true);

      const preRetirementCurrent = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readCurrentDefinition(
          competingGroup.priceGroupRef,
          new Date('2026-09-21T23:59:59.999Z'),
        ),
      );
      expect(preRetirementCurrent.identity.lifecycle).toMatchObject({ retiredAt: null, state: 'ACTIVE' });
      expect(preRetirementCurrent.definition.definitionRevisionId).toBe(preRetirementRevisionId);
      const historicalBeforeRetirement = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readDefinitionRevision(
          competingGroup.priceGroupRef,
          preRetirementRevision.definitionRevisionId,
          new Date('2026-09-21T23:59:59.999Z'),
        ),
      );
      expect(historicalBeforeRetirement.identity.lifecycle).toMatchObject({ retiredAt: null, state: 'ACTIVE' });
      const preRetirementCompatibility = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).validateCompatibility(
          competingGroup.priceGroupRef,
          requiredContract,
          new Date('2026-09-21T23:59:59.999Z'),
          {
            catalogRevision: preRetirementRevision.acceptedCatalogRevision,
            definitionRevisionId: preRetirementRevision.definitionRevisionId,
            definitionRevisionNumber: preRetirementRevision.revisionNumber,
            meaningFingerprint: preRetirementRevision.meaningFingerprint,
            priceGroupRef: preRetirementRevision.priceGroupRef,
          },
        ),
      );
      expect(preRetirementCompatibility.kind).toBe('USABLE');
      const atRetirementCurrent = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readCurrentDefinition(
          competingGroup.priceGroupRef,
          new Date('2026-09-22T00:00:00.000Z'),
        ),
      );
      expect(atRetirementCurrent.identity.lifecycle).toMatchObject({
        retiredAt: '2026-09-22T00:00:00.000Z',
        state: 'RETIRED',
      });
      expect(atRetirementCurrent.definition.definitionRevisionId).toBe(preRetirementRevisionId);
      const historicalAtRetirement = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readDefinitionRevision(
          competingGroup.priceGroupRef,
          preRetirementRevision.definitionRevisionId,
          new Date('2026-09-22T00:00:00.000Z'),
        ),
      );
      expect(historicalAtRetirement.identity.lifecycle).toMatchObject({
        retiredAt: '2026-09-22T00:00:00.000Z',
        state: 'RETIRED',
      });
      const atRetirementCompatibility = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).validateCompatibility(
          competingGroup.priceGroupRef,
          requiredContract,
          new Date('2026-09-22T00:00:00.000Z'),
          {
            catalogRevision: preRetirementRevision.acceptedCatalogRevision,
            definitionRevisionId: preRetirementRevision.definitionRevisionId,
            definitionRevisionNumber: preRetirementRevision.revisionNumber,
            meaningFingerprint: preRetirementRevision.meaningFingerprint,
            priceGroupRef: preRetirementRevision.priceGroupRef,
          },
        ),
      );
      expect(atRetirementCompatibility).toMatchObject({
        evidence: {
          acceptedCatalogRevision: 4,
          currentDefinitionRevisionId: preRetirementRevisionId,
          currentDefinitionRevisionNumber: 2,
          retiredAt: '2026-09-22T00:00:00.000Z',
        },
        kind: 'RETIRED',
      });

      const retirement = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup({
          actingPrincipalId: principalId,
          actionInvocationId: retireInvocationId,
          effectiveAt: new Date('2026-09-22T00:00:00.000Z'),
          expectedCurrent: retirementExpectedCurrent,
          reason: 'Dealer classification retired.',
          trustedEffectiveAt: new Date('2026-09-20T00:00:00.000Z'),
        }),
      );
      expect(retirement.acceptedCatalogRevision).toBe(6);

      const terminalRetirement = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup({
            actingPrincipalId: principalId,
            actionInvocationId: secondRetireInvocationId,
            effectiveAt: new Date('2026-09-23T00:00:00.000Z'),
            expectedCurrent: retirementExpectedCurrent,
            reason: 'Attempted second retirement.',
            trustedEffectiveAt: new Date('2026-09-20T00:00:00.000Z'),
          }),
        ),
      );
      expect(Schema.is(PriceGroupLifecycleConflict)(terminalRetirement)).toBe(true);

      const retiredDecision = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).validateCompatibility(
          revised.priceGroupRef,
          requiredContract,
          new Date('2026-09-23T00:00:00.000Z'),
          retirementExpectedCurrent,
        ),
      );
      expect(retiredDecision).toMatchObject({
        evidence: {
          acceptedCatalogRevision: 6,
          currentDefinitionRevisionId: revisionId,
          currentDefinitionRevisionNumber: 2,
        },
        kind: 'RETIRED',
      });

      const actionDbGroupOutcome = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
          ...createInput,
          actionInvocationId: actionDbCreateInvocationId,
          businessCode: 'ACTION_DB',
          classificationPurpose: 'Proves Action-to-PostgreSQL retirement clock ordering.',
          description: 'Action database retirement proof.',
          displayName: 'Action DB',
          expectedCatalogRevision: 6,
          meaningFingerprint: 'e'.repeat(64),
          reason: 'Create Action database proof identity.',
        }),
      );
      const actionDbGroup = actionDbGroupOutcome.definition;
      const actionRetirementPayload = Schema.decodeUnknownSync(RetirePriceGroupPayloadSchema)({
        effectiveAt: '2026-10-01T00:00:00.000Z',
        expectedCurrent: {
          catalogRevision: actionDbGroup.acceptedCatalogRevision,
          definitionRevisionId: actionDbGroup.definitionRevisionId,
          definitionRevisionNumber: actionDbGroup.revisionNumber,
          meaningFingerprint: actionDbGroup.meaningFingerprint,
          priceGroupRef: actionDbGroup.priceGroupRef,
        },
        reason: 'Schedule retirement through the real Action and database path.',
      });
      const actionDbRetirement = yield* inScope((invoker) => {
        const collector = createActionCollector(
          retirePriceGroupAction.descriptor.domainEvents,
          'pricing.price-group-catalog',
          retirePriceGroupAction.descriptor.accessEvidencePolicy,
          retirePriceGroupAction.descriptor.auditEvidenceSchema,
        );
        return handleRetirePriceGroup(actionRetirementPayload, {
          actionInvocationId: actionDbRetireInvocationId,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services: priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope),
        });
      });
      expect(Date.parse(actionDbRetirement.trustedOperationAt)).toBeLessThanOrEqual(
        Date.parse(actionDbRetirement.verifiedAt),
      );
      expect(Date.parse(actionDbRetirement.trustedOperationAt)).toBeLessThan(
        Date.parse(actionDbRetirement.retirementEffectiveAt),
      );

      const raceGroupOutcome = yield* inScope((invoker) =>
        priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
          ...createInput,
          actionInvocationId: raceCreateInvocationId,
          businessCode: 'RACE',
          classificationPurpose: 'Proves retirement and revision serialization.',
          description: 'Retirement and revision serialization proof.',
          displayName: 'Race',
          expectedCatalogRevision: 8,
          meaningFingerprint: 'f'.repeat(64),
          reason: 'Create retirement and revision serialization proof.',
        }),
      );
      const raceGroup = raceGroupOutcome.definition;
      const raceExpectedCurrent = {
        catalogRevision: raceGroup.acceptedCatalogRevision,
        definitionRevisionId: raceGroup.definitionRevisionId,
        definitionRevisionNumber: raceGroup.revisionNumber,
        meaningFingerprint: raceGroup.meaningFingerprint,
        priceGroupRef: raceGroup.priceGroupRef,
      };
      const raceRetirementInput = {
        actingPrincipalId: principalId,
        actionInvocationId: raceRetireInvocationId,
        effectiveAt: new Date('2026-10-10T00:00:00.000Z'),
        expectedCurrent: raceExpectedCurrent,
        reason: 'Schedule retirement concurrently with a pre-boundary revision.',
        trustedEffectiveAt: new Date('2026-09-23T00:00:00.000Z'),
      };
      const [raceRetirementResult, raceRevisionResult] = yield* Effect.all(
        [
          inScope((invoker) =>
            Effect.result(
              priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup(raceRetirementInput),
            ),
          ),
          inScope((invoker) =>
            Effect.result(
              priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createDefinitionRevision({
                actingPrincipalId: principalId,
                actionInvocationId: raceRevisionInvocationId,
                classificationPurpose: raceGroup.classificationPurpose,
                compatibilityContracts: [requiredContract],
                definitionRevisionId: raceRevisionId,
                description: 'Serialized pre-retirement revision.',
                displayName: 'Race',
                effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
                effectiveTo: new Date('2026-10-10T00:00:00.000Z'),
                expectedCurrent: raceExpectedCurrent,
                meaningFingerprint: raceGroup.meaningFingerprint,
                reason: 'Revise concurrently with scheduled retirement.',
                trustedEffectiveAt: new Date('2026-09-24T00:00:00.000Z'),
              }),
            ),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      expect(Result.isSuccess(raceRevisionResult)).toBe(true);
      const raceRevision = Result.getOrThrow(raceRevisionResult);
      if (Result.isSuccess(raceRetirementResult)) {
        const replayedRaceRetirement = yield* inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup(raceRetirementInput),
        );
        expect(replayedRaceRetirement).toEqual(raceRetirementResult.success);
      } else {
        expect(Schema.is(PriceGroupExpectedCurrentConflict)(raceRetirementResult.failure)).toBe(true);
        const retriedRaceRetirement = yield* inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).retirePriceGroup({
            ...raceRetirementInput,
            expectedCurrent: {
              catalogRevision: raceRevision.acceptedCatalogRevision,
              definitionRevisionId: raceRevision.definitionRevisionId,
              definitionRevisionNumber: raceRevision.revisionNumber,
              meaningFingerprint: raceRevision.meaningFingerprint,
              priceGroupRef: raceRevision.priceGroupRef,
            },
          }),
        );
        expect(retriedRaceRetirement.currentDefinitionRevisionId).toBe(raceRevision.definitionRevisionId);
      }

      yield* admin.transaction((transaction) =>
        Effect.gen(function* corruptHistoricalScheduleForProof() {
          yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
          yield* transaction.execute(
            sql`delete from price_group_catalog.price_group_definition_effective_intervals
                 where tenant_id = ${tenantId}::uuid
                   and price_group_id = ${created.priceGroupRef.resourceId}::uuid
                   and definition_revision_id = ${created.definitionRevisionId}::uuid
                   and schedule_catalog_revision = 3`,
          );
        }),
      );
      const corruptHistoricalRead = yield* Effect.flip(
        inScope((invoker) =>
          priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).readDefinitionRevision(
            created.priceGroupRef,
            created.definitionRevisionId,
            new Date('2026-09-23T00:00:00.000Z'),
          ),
        ),
      );
      expect(Schema.is(PriceGroupCurrentnessFailure)(corruptHistoricalRead)).toBe(true);
      if (Schema.is(PriceGroupCurrentnessFailure)(corruptHistoricalRead)) {
        expect(corruptHistoricalRead.reason).toBe('UNVERIFIABLE_CURRENTNESS');
        expect(corruptHistoricalRead.candidateDefinitionRevisionIds).toEqual([created.definitionRevisionId]);
      }

      const wrongScope = yield* Effect.flip(
        runtime.transaction((transaction) =>
          Effect.gen(function* rejectWrongScope() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* transaction.execute<RoutineRow>(
              sql`select * from price_group_catalog.read_current_definition(
                    ${otherTenantId}::uuid, ${created.priceGroupRef.resourceId}::uuid,
                    '2026-09-20T00:00:00Z'::timestamptz
                  )`,
              'objects',
            );
          }),
        ),
      );
      expect(wrongScope).toBeDefined();

      const directTableAccess = yield* Effect.flip(
        runtime.execute(sql`select * from price_group_catalog.price_groups`, 'objects'),
      );
      expect(directTableAccess).toBeDefined();
    }),
  ),
);
