import { addTestGatewayScopeGrantCleanup } from '@app/core-runtime/testing/gateway-scope-grant';
import { eq, inArray, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import {
  contactsRelations,
  organizationEngagementProfiles,
  personEngagementProfiles,
} from '../../src/db/engagement-schema.ts';
import {
  establishPartyGatewayScope,
  hasPostgreSqlCode,
  openBoundaryDatabases,
  openPartyBoundaryClients,
  registerPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantA = 'c1000000-0000-4000-8000-000000000001';
const tenantB = 'c1000000-0000-4000-8000-000000000002';
const fixtureTenants = [tenantA, tenantB] as const;

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect('enforces tenant isolation and canonical-reference uniqueness without cross-vertical FKs', () =>
    Effect.gen(function* testEffect1() {
      const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 1 });
      const { admin, runtime } = yield* openBoundaryDatabases(
        (client) => makeTestDatabaseFromClient(client, contactsRelations),
        clients,
      );
      const scopeA = yield* registerPartyGatewayScope(clients, { tenantId: tenantA });
      const scopeB = yield* registerPartyGatewayScope(clients, { tenantId: tenantB });
      yield* addTestGatewayScopeGrantCleanup(clients.admin, fixtureTenants);
      const cleanup = () =>
        purgeFixtureRows(
          [personEngagementProfiles, organizationEngagementProfiles].map((table) =>
            admin.delete(table).where(inArray(table.tenantId, fixtureTenants)),
          ),
        );

      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* cleanup();
      expect(yield* runtime.select().from(organizationEngagementProfiles)).toEqual([]);
      expect(
        hasPostgreSqlCode('42501')(
          yield* Effect.flip(
            runtime.insert(organizationEngagementProfiles).values({
              counterpartyResourceId: 'counterparty-a',
              partyResourceId: 'party-a',
              tenantId: tenantA,
            }),
          ),
        ),
      ).toBe(true);
      yield* runtime.transaction((transaction) =>
        Effect.gen(function* transactionTestBody() {
          yield* establishPartyGatewayScope(transaction, scopeA);
          yield* transaction.insert(organizationEngagementProfiles).values({
            counterpartyResourceId: 'counterparty-a',
            partyResourceId: 'party-a',
            tenantId: tenantA,
          });
          yield* transaction.insert(personEngagementProfiles).values({
            counterpartyResourceId: 'counterparty-a',
            partyResourceId: 'person-a',
            tenantId: tenantA,
          });
          const [prospect] = yield* transaction
            .insert(organizationEngagementProfiles)
            .values({
              partyResourceId: 'prospect-a',
              tenantId: tenantA,
            })
            .returning();
          expect(prospect?.counterpartyResourceId).toBe(null);
          const [unresolvedPerson] = yield* transaction
            .insert(personEngagementProfiles)
            .values({
              partyResourceId: 'unresolved-person-a',
              tenantId: tenantA,
            })
            .returning();
          expect(unresolvedPerson?.counterpartyResourceId).toBe(null);
        }),
      );
      expect(
        hasPostgreSqlCode('23505')(
          yield* Effect.flip(
            runtime.transaction((transaction) =>
              Effect.gen(function* transactionTestBody() {
                yield* establishPartyGatewayScope(transaction, scopeA);
                yield* transaction.insert(personEngagementProfiles).values({
                  partyResourceId: 'unresolved-person-a',
                  tenantId: tenantA,
                });
              }),
            ),
          ),
        ),
      ).toBe(true);
      expect(
        hasPostgreSqlCode('23505')(
          yield* Effect.flip(
            runtime.transaction((transaction) =>
              Effect.gen(function* transactionTestBody() {
                yield* establishPartyGatewayScope(transaction, scopeA);
                yield* transaction.insert(organizationEngagementProfiles).values({
                  counterpartyResourceId: 'counterparty-a',
                  partyResourceId: 'party-b',
                  tenantId: tenantA,
                });
              }),
            ),
          ),
        ),
      ).toBe(true);
      yield* runtime.transaction((transaction) =>
        Effect.gen(function* transactionTestBody() {
          yield* establishPartyGatewayScope(transaction, scopeB);
          yield* transaction.insert(organizationEngagementProfiles).values({
            counterpartyResourceId: 'counterparty-a',
            partyResourceId: 'party-a',
            tenantId: tenantB,
          });
          expect(
            yield* transaction
              .select()
              .from(organizationEngagementProfiles)
              .where(eq(organizationEngagementProfiles.tenantId, tenantA)),
          ).toEqual([]);
        }),
      );
      // The legacy session setting alone confers no tenant: reads see nothing and writes are refused.
      yield* runtime.transaction((transaction) =>
        Effect.gen(function* setConfigAloneReads() {
          yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantA}, true)`, 'objects');
          expect(yield* transaction.select().from(organizationEngagementProfiles)).toEqual([]);
          expect(yield* transaction.select().from(personEngagementProfiles)).toEqual([]);
        }),
      );
      expect(
        hasPostgreSqlCode('42501')(
          yield* Effect.flip(
            runtime.transaction((transaction) =>
              Effect.gen(function* setConfigAloneWrites() {
                yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantB}, true)`, 'objects');
                yield* transaction.insert(personEngagementProfiles).values({
                  partyResourceId: 'forged-person-b',
                  tenantId: tenantB,
                });
              }),
            ),
          ),
        ),
      ).toBe(true);
    }),
  );
});
