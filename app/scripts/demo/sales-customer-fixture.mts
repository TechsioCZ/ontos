import {
  customerSegmentDefinitions,
  decodeSalesDemoSeedInput,
  SalesDemoSeedInputSchema,
  validateSalesDemoSeedInput,
} from '@app/shared-contracts/demo/sales-customer-fixtures';
import { Crypto, DateTime, Effect, FileSystem, Path, Schema } from 'effect';

import { salesDemoCustomers } from './data/sales-customers.mts';
import { demoId, demoLegalEntityId, demoTenantId, SALES_DEMO_NAMESPACE } from './fixture-ids.mts';

const invocation = (operation: string) => demoId('commerce.seed-invocation', `sales-demo-segments:${operation}`);

export const makeSalesDemoCustomerFixture = Effect.fn('SalesDemo.makeCustomerFixture')(function* makeFixture(
  runId: string,
  now: DateTime.Utc,
) {
  return yield* decodeSalesDemoSeedInput({
    actorPrincipalId: demoId('commerce.seed-principal', 'sales-demo-segments'),
    customers: salesDemoCustomers.map((customer) => ({
      ...customer,
      counterpartyId: demoId('party.counterparty', `ico-${customer.ico}`),
      membershipInvocationId: invocation(`membership:${customer.ico}`),
      partyId: demoId('party.customer', `ico-${customer.ico}`),
      profileInvocationId: invocation(`profile:${customer.ico}`),
    })),
    expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 15 })),
    format: 'sales-demo-customers/1',
    groups: customerSegmentDefinitions.map(({ businessCode }) => ({
      businessCode,
      invocationId: invocation(`group:${businessCode}`),
    })),
    issuedAt: DateTime.formatIso(now),
    legalEntityId: demoLegalEntityId,
    namespace: SALES_DEMO_NAMESPACE,
    runId,
    tenantId: demoTenantId,
  }).pipe(Effect.flatMap((input) => validateSalesDemoSeedInput(input, now)));
});

/** One invocation owns the directory and removes it after success, failure or interruption. */
export const withSalesDemoCustomerHandoff = Effect.fn('SalesDemo.withCustomerHandoff')(function* withHandoff<A, E, R>(
  consume: (paths: { readonly fixture: string; readonly roleHandoff: string }) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  return yield* Effect.scoped(
    Effect.gen(function* ownedHandoffScope() {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'sales-demo-customer-handoff-' });
      const fixture = path.join(directory, 'customers.json');
      const roleHandoff = path.join(directory, 'committed-roles.json');
      const input = yield* makeSalesDemoCustomerFixture(yield* crypto.randomUUIDv4(), yield* DateTime.now);
      yield* fs.writeFileString(
        fixture,
        yield* Schema.encodeEffect(Schema.fromJsonString(SalesDemoSeedInputSchema))(input),
        { flag: 'wx', mode: 0o600 },
      );
      return yield* consume({ fixture, roleHandoff });
    }),
  );
});
