import { randomUUID } from 'node:crypto';

import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { PriceGroupDefinitionResponseSchema } from '../../shared/apis/price-group-definition.ts';
import type { ExpectedPriceGroupCurrentEvidence, PriceGroupDefinitionRevision } from '../../shared/domain/price-group.ts';
import { PriceGroupCurrentnessFailure, PriceGroupExpectedCurrentConflict } from '../../shared/domain/price-group-errors.ts';
import { readPriceGroupDefinition } from '../../src/api/price-group-definition.read.ts';
import { priceGroupCatalogRelations } from '../../src/database/schema.ts';
import type { PriceGroupCatalogPersistence, PriceGroupCurrentDefinitionSnapshot } from '../../src/persistence/price-group-catalog-persistence.ts';
import { priceGroupCatalogPersistenceFromRoutineInvoker } from '../../src/persistence/price-group-catalog-persistence.ts';

const requiredContract = { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 };
const at = (instant: string) => new Date(instant);
const expected = (snapshot: PriceGroupCurrentDefinitionSnapshot): ExpectedPriceGroupCurrentEvidence => ({
  catalogRevision: snapshot.catalogRevision,
  definitionRevisionId: snapshot.definition.definitionRevisionId,
  definitionRevisionNumber: snapshot.definition.revisionNumber,
  meaningFingerprint: snapshot.definition.meaningFingerprint,
  priceGroupRef: snapshot.definition.priceGroupRef,
});
const accepted = (definition: PriceGroupDefinitionRevision): ExpectedPriceGroupCurrentEvidence => ({
  catalogRevision: definition.acceptedCatalogRevision,
  definitionRevisionId: definition.definitionRevisionId,
  definitionRevisionNumber: definition.revisionNumber,
  meaningFingerprint: definition.meaningFingerprint,
  priceGroupRef: definition.priceGroupRef,
});

const fixture = Effect.gen(function* priceGroupFixture() {
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const scope = { authMethod: 'system' as const, correlationId: randomUUID(), principalId, tenantId };
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, priceGroupCatalogRelations);
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, priceGroupCatalogRelations);
  const cleanup = () => admin.transaction((transaction) => Effect.gen(function* cleanupTenant() {
    yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
    yield* transaction.execute(sql`delete from price_group_catalog.price_group_containment_projection_intents where tenant_id = ${tenantId}::uuid`);
    yield* transaction.execute(sql`delete from price_group_catalog.price_group_retirements where tenant_id = ${tenantId}::uuid`);
    yield* transaction.execute(sql`delete from price_group_catalog.price_group_compatibility_support where tenant_id = ${tenantId}::uuid`);
    yield* transaction.execute(sql`delete from price_group_catalog.price_group_definition_effective_intervals where tenant_id = ${tenantId}::uuid`);
    yield* transaction.execute(sql`delete from price_group_catalog.price_group_definition_revisions where tenant_id = ${tenantId}::uuid`);
    yield* transaction.execute(sql`delete from price_group_catalog.price_groups where tenant_id = ${tenantId}::uuid`);
    yield* transaction.execute(sql`delete from price_group_catalog.price_group_catalog_ledger where tenant_id = ${tenantId}::uuid`);
  }));
  yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
  const run = <Value, Failure>(operation: (services: PriceGroupCatalogPersistence) => Effect.Effect<Value, Failure>) =>
    runtime.transaction((transaction) => Effect.gen(function* scopedOperation() {
      yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
      const invoker = scopedRoutineInvokerFromTransaction((statement) => transaction.execute(statement, 'objects'), scope);
      return yield* operation(priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope));
    }));
  const result = yield* run((services) => services.createPriceGroup({
    actingPrincipalId: principalId,
    actionInvocationId: randomUUID(),
    businessCode: 'DEALER',
    classificationPurpose: 'Dealer classification with a stable business meaning.',
    compatibilityContracts: [requiredContract],
    description: 'Initial accepted definition.',
    displayName: 'Dealer',
    effectiveFrom: at('2026-08-01T00:00:00.000Z'),
    expectedCatalogRevision: 0,
    reason: 'Create the regression fixture.',
    trustedEffectiveAt: at('2026-08-01T00:00:00.000Z'),
  }));
  const initial = result.businessResult.initialDefinition;
  const retire = (expectation = accepted(initial)) => run((services) => services.retirePriceGroup({
    actingPrincipalId: principalId,
    actionInvocationId: randomUUID(),
    effectiveAt: at('2026-09-25T00:00:00.000Z'),
    expectedCurrent: expectation,
    reason: 'Terminal retirement without assignment remapping.',
    trustedEffectiveAt: at('2026-09-10T00:00:00.000Z'),
  }));
  const revisionInput = (expectation: ExpectedPriceGroupCurrentEvidence) => ({
    actingPrincipalId: principalId,
    actionInvocationId: randomUUID(),
    classificationPurpose: initial.classificationPurpose,
    compatibilityContracts: [requiredContract],
    description: 'Cosmetic clarification, unchanged classification.',
    displayName: 'Dealers',
    effectiveFrom: at('2026-09-20T00:00:00.000Z'),
    effectiveTo: at('2026-09-25T00:00:00.000Z'),
    expectedCurrent: expectation,
    reason: 'Clarify before the terminal boundary.',
    semanticDecision: { comparedDefinitionRevisionId: expectation.definitionRevisionId, decision: 'SAME_MEANING' as const },
    trustedEffectiveAt: at('2026-09-15T00:00:00.000Z'),
  });
  const eraseAcceptedInterval = () => admin.transaction((transaction) => Effect.gen(function* corruptAcceptedEvidence() {
    yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
    yield* transaction.execute(sql`delete from price_group_catalog.price_group_definition_effective_intervals
      where tenant_id = ${tenantId}::uuid and price_group_id = ${initial.priceGroupRef.resourceId}::uuid
      and definition_revision_id = ${initial.definitionRevisionId}::uuid
      and schedule_catalog_revision = ${initial.acceptedCatalogRevision}`);
  }));
  return { eraseAcceptedInterval, initial, principalId, retire, revisionInput, run, tenantId };
});

it.live('B3 rejects a pre-retirement fence rather than translating it into the fresh schedule', () =>
  Effect.scoped(Effect.gen(function* rejectStaleFence() {
    const { initial, retire, revisionInput, run } = yield* fixture;
    const retirement = yield* retire();
    const result = yield* Effect.result(run((services) => services.createDefinitionRevision(revisionInput(accepted(initial)))));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.is(PriceGroupExpectedCurrentConflict)(result.failure)).toBe(true);
    }
    const current = yield* run((services) => services.readCurrentDefinition(initial.priceGroupRef, at('2026-09-15T00:00:00.000Z')));
    expect(current.catalogRevision).toBe(retirement.acceptedCatalogRevision);
    expect(current.definition.definitionRevisionId).toBe(initial.definitionRevisionId);
  })),
);

it.live('B3 accepts the exact fresh read token after scheduled retirement and replays the revision unchanged', () =>
  Effect.scoped(Effect.gen(function* roundTripFreshFence() {
    const { initial, retire, revisionInput, run } = yield* fixture;
    const retirement = yield* retire();
    const current = yield* run((services) => services.readCurrentDefinition(initial.priceGroupRef, at('2026-09-15T00:00:00.000Z')));
    expect(current.catalogRevision).toBe(retirement.acceptedCatalogRevision);
    const input = revisionInput(expected(current));
    const revision = yield* run((services) => services.createDefinitionRevision(input));
    const replayed = yield* run((services) => services.createDefinitionRevision(input));
    expect(replayed).toEqual(revision);
    const before = yield* run((services) => services.validateCompatibility(initial.priceGroupRef, requiredContract,
      at('2026-09-24T23:59:59.999Z'), accepted(revision)));
    const boundary = yield* run((services) => services.validateCompatibility(initial.priceGroupRef, requiredContract,
      at('2026-09-25T00:00:00.000Z'), accepted(revision)));
    expect(before).toMatchObject({ kind: 'USABLE' });
    expect(boundary).toMatchObject({ kind: 'RETIRED' });
  })),
);

it.live('B4 reads the exact accepted future revision after retirement removes it from the Current schedule', () =>
  Effect.scoped(Effect.gen(function* preserveAcceptedFutureRevision() {
    const { initial, retire, revisionInput, run, tenantId } = yield* fixture;
    const { effectiveTo: _end, ...openInput } = revisionInput(accepted(initial));
    const future = yield* run((services) => services.createDefinitionRevision({
      ...openInput,
      effectiveFrom: at('2026-09-30T00:00:00.000Z'),
      trustedEffectiveAt: at('2026-09-01T00:00:00.000Z'),
    }));
    const before = yield* run((services) => services.readCurrentDefinition(initial.priceGroupRef, at('2026-09-10T00:00:00.000Z')));
    yield* retire(expected(before));
    const historical = yield* run((services) => readPriceGroupDefinition({
      definitionRevisionId: future.definitionRevisionId,
      priceGroupRef: initial.priceGroupRef,
      trustedOperationAt: '2026-09-26T00:00:00.000Z',
    }, tenantId, services));
    expect(Schema.is(PriceGroupDefinitionResponseSchema)(historical)).toBe(true);
    expect(historical).toMatchObject({
      definition: future,
      identity: { lifecycle: { retiredAt: '2026-09-25T00:00:00.000Z', state: 'RETIRED' } },
      selection: 'HISTORICAL',
    });
    const terminal = yield* run((services) => services.readCurrentDefinition(initial.priceGroupRef, at('2026-09-26T00:00:00.000Z')));
    expect(terminal.definition.definitionRevisionId).toBe(initial.definitionRevisionId);
    expect(terminal.identity.lifecycle.state).toBe('RETIRED');
    const original = yield* run((services) => services.readDefinitionRevision(initial.priceGroupRef, initial.definitionRevisionId,
      at('2026-09-26T00:00:00.000Z')));
    expect(original.definition).toEqual(initial);
  })),
);

it.live('B4 missing accepted evidence stays a typed failure even when another schedule still contains the revision', () =>
  Effect.scoped(Effect.gen(function* failClosedOnMissingAcceptedEvidence() {
    const { eraseAcceptedInterval, initial, retire, run } = yield* fixture;
    yield* retire();
    yield* eraseAcceptedInterval();
    const outcome = yield* Effect.result(run((services) => services.readDefinitionRevision(initial.priceGroupRef,
      initial.definitionRevisionId, at('2026-09-26T00:00:00.000Z'))));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(Schema.is(PriceGroupCurrentnessFailure)(outcome.failure)).toBe(true);
      expect(outcome.failure).toMatchObject({ reason: 'UNVERIFIABLE_CURRENTNESS' });
    }
  })),
);
