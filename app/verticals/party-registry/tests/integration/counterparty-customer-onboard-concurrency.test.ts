import { addTestGatewayScopeGrantCleanup } from '@app/core-runtime/testing/gateway-scope-grant';
import { eq } from 'drizzle-orm';
import { Effect, Predicate } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import {
  parties,
  partyRelations,
  counterparties,
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
  counterpartyRolePeriods,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';
import { onboardCounterpartyCustomerRecord } from '../../src/services/counterparty-persistence.service.ts';
import {
  establishPartyGatewayScope,
  openBoundaryDatabases,
  openPartyBoundaryClients,
  registerPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = '91000000-0000-4000-8000-000000000001';
const legalEntityId = '92000000-0000-4000-8000-000000000001';
const partyId = '93000000-0000-4000-8000-000000000001';
const rollbackPartyId = '93000000-0000-4000-8000-000000000002';
const principalId = '94000000-0000-4000-8000-000000000001';
const rolePeriodStart = '2026-01-01T00:00:00.000Z';

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'PostgreSQL locking yields one Counterparty and one equivalent CUSTOMER period for concurrent requests',
    () =>
      Effect.gen(function* onboardConcurrency() {
        const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 2 });
        const { admin, runtime } = yield* openBoundaryDatabases(
          (client) => makeTestDatabaseFromClient(client, partyRelations),
          clients,
        );
        const scope = yield* registerPartyGatewayScope(clients, { legalEntityId, tenantId });
        yield* addTestGatewayScopeGrantCleanup(clients.admin, [tenantId]);
        const cleanup = purgeFixtureRows(
          [
            counterpartyRoleAdminReadModels,
            counterpartyAdminReadModels,
            counterpartyRolePeriods,
            counterparties,
            parties,
          ].map((table) => admin.delete(table).where(eq(table.tenantId, tenantId))),
        );
        yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
        yield* admin.insert(parties).values({
          currentDisplayName: 'Concurrent customer',
          currentType: 'ORGANIZATION',
          partyId,
          tenantId,
        });

        const scoped = <Value, Failure>(operation: (transaction: PartyTransaction) => Effect.Effect<Value, Failure>) =>
          runtime.transaction((transaction) =>
            Effect.gen(function* scopedTransaction() {
              yield* establishPartyGatewayScope(transaction, scope);
              return yield* operation(transaction);
            }),
          );
        const input = (actionInvocationId: string) => ({
          actionInvocationId,
          counterpartyProvenance: {
            evidenceReference: 'concurrency:context',
            method: 'SIGNED_CONTRACT',
            reason: 'Concurrent contract fixture',
            source: 'party-registry.integration',
          },
          customerEvidence: {
            evidenceReference: 'concurrency:customer',
            method: 'SIGNED_CONTRACT',
            reason: 'Concurrent customer fixture',
            source: 'party-registry.integration',
          },
          legalEntityId,
          partyId,
          policyVersion: 'counterparty-customer-onboard.v1',
          principalId,
          provenance: {
            evidenceReference: 'concurrency:customer',
            method: 'SIGNED_CONTRACT',
            reason: 'Concurrent customer fixture',
            source: 'party-registry.integration',
          },
          tenantId,
          validFrom: rolePeriodStart,
          validTo: null,
        });
        const results = yield* Effect.forEach(
          ['95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002'],
          (actionInvocationId) =>
            scoped((transaction) => onboardCounterpartyCustomerRecord(transaction, input(actionInvocationId))),
          { concurrency: 'unbounded' },
        );

        expect(results.every((result) => Predicate.isTagged(result, 'onboarded'))).toBe(true);
        expect(
          results.filter((result) => Predicate.isTagged(result, 'onboarded') && result.counterpartyCreated),
        ).toHaveLength(1);
        expect(
          results.filter((result) => Predicate.isTagged(result, 'onboarded') && result.rolePeriodCreated),
        ).toHaveLength(1);
        expect(yield* admin.select().from(counterparties).where(eq(counterparties.tenantId, tenantId))).toHaveLength(1);
        const roles = yield* admin
          .select()
          .from(counterpartyRolePeriods)
          .where(eq(counterpartyRolePeriods.tenantId, tenantId));
        expect(roles).toHaveLength(1);
        expect(roles[0]?.roleType).toBe('CUSTOMER');
        expect(roles[0]?.validFrom.toISOString()).toBe(rolePeriodStart);
        expect(roles[0]?.validTo).toBe(null);

        const emptyPeriod = {
          ...input('95000000-0000-4000-8000-000000000004'),
          validFrom: '2025-01-01T00:00:00.000Z',
          validTo: '2025-01-01T00:00:00.000Z',
        };
        const firstEmpty = yield* scoped((transaction) => onboardCounterpartyCustomerRecord(transaction, emptyPeriod));
        const replayEmpty = yield* scoped((transaction) =>
          onboardCounterpartyCustomerRecord(transaction, {
            ...emptyPeriod,
            actionInvocationId: '95000000-0000-4000-8000-000000000005',
          }),
        );
        if (!Predicate.isTagged(firstEmpty, 'onboarded') || !Predicate.isTagged(replayEmpty, 'onboarded')) {
          return yield* Effect.die(new Error('Empty-period onboarding failed'));
        }
        expect(firstEmpty.rolePeriodCreated).toBe(true);
        expect(replayEmpty.rolePeriodCreated).toBe(false);
        expect(replayEmpty.role.rolePeriodRef).toEqual(firstEmpty.role.rolePeriodRef);
        expect(
          yield* admin.select().from(counterpartyRolePeriods).where(eq(counterpartyRolePeriods.tenantId, tenantId)),
        ).toHaveLength(2);

        yield* admin.insert(parties).values({
          currentDisplayName: 'Rollback customer',
          currentType: 'ORGANIZATION',
          partyId: rollbackPartyId,
          tenantId,
        });
        const roleWriteFailure = yield* scoped((transaction) =>
          onboardCounterpartyCustomerRecord(transaction, {
            ...input('95000000-0000-4000-8000-000000000003'),
            partyId: rollbackPartyId,
            validTo: '2025-01-01T00:00:00.000Z',
          }),
        ).pipe(Effect.flip);
        expect(Predicate.isTagged(roleWriteFailure, 'CounterpartyPersistenceUnavailable')).toBe(true);
        expect(
          yield* admin.select().from(counterparties).where(eq(counterparties.partyId, rollbackPartyId)),
        ).toHaveLength(0);
      }),
  );
});
