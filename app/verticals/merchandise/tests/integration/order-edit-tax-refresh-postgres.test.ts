// An order edit and Tax's refresh, on PostgreSQL, prepared as the Action prepares it (`prepareCommandTax` with the
// preparation snapshot):
// the company's rates were confirmed by Tax two hours ago (standard 21 %), Tax has since declared 23 % and answers
// only when the test lets it.
// - an edit that touches only the order's existing lines never waits for Tax;
// - an edit that adds a line waits for the company's refresh, so the new line takes Tax's current 23 %.
import { randomUUID } from 'node:crypto';

import { defineDatabaseIdentityEnrollment, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { ScopedTransactionExecutor, TrustedPrincipalContext } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { makeNativeReadTestContext, NativeReadTestOwnerRegistration } from '@app/core-runtime/testing/native-reads';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { DateTime, Deferred, Effect, Fiber, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import {
  catalogHeads,
  categories,
  merchandiseRelations,
  orders,
  priceTiers,
  productVariants,
  products,
  stockMovements,
} from '../../src/database/schema.ts';
import { replaceSnapshot, whereScope } from '../../src/services/merchandise-store.ts';
import type { StoreScope } from '../../src/services/merchandise-store.ts';
import { persistenceService, prepareCommandTax } from '../../src/services/persistence.service.ts';
import { CompanyTaxRatesSchema, TaxRateSource } from '../../src/services/tax-rates.ts';
import type { TaxRateBook } from '../../src/services/tax-rates.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { TEST_PRICING, TEST_TAX_BOOK, testTaxBook } from '../support/tax-fixtures.ts';
import { catalogState } from './support/merchandise-database.ts';

const companyOf = (principal: TrustedPrincipalContext): Effect.Effect<StoreScope> =>
  principal.legalEntityId === undefined
    ? Effect.die('The native fixture principal names no company')
    : Effect.succeed({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId });

const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
const nativeMerchandise = makeNativeReadTestContext({
  accessDecision: gate.bound,
  contextPermissions: [],
  moduleId: 'demo.merchandise',
  ownerFixtureRetention: 'retain-complete-context',
}).pipe(Effect.provideService(NativeReadTestOwnerRegistration, merchandiseRegistration));

const LinesSchema = Schema.Struct({
  lines: Schema.Array(Schema.Struct({ productId: ProductIdSchema, quantity: Schema.Number, vatRate: Schema.Number })),
});

it.live('an order edit waits for Tax only when it adds a line, and prices that line at the current rate', () =>
  Effect.scoped(
    Effect.gen(function* orderEditRefresh() {
      const connections = yield* loadDatabaseConnectionPair();
      const admin = yield* makeTestDatabaseFromClient(
        yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 }),
        merchandiseRelations,
      );
      const runtime = yield* makeTestDatabaseFromClient(
        yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 1 }),
        merchandiseRelations,
      );
      const native = yield* nativeMerchandise;
      const company = yield* companyOf(native.principal);
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [products, productVariants, priceTiers, stockMovements, orders, categories, catalogHeads].map((table) =>
            admin.delete(table).where(whereScope(table, company)),
          ),
          { concurrency: 1 },
        ).pipe(Effect.orDie),
      );
      yield* admin.transaction((tx) => replaceSnapshot(tx, company, catalogState, TEST_PRICING));
      const taxRates = yield* Schema.encodeEffect(CompanyTaxRatesSchema)({
        book: TEST_TAX_BOOK,
        source: 'TAX',
        syncedAt: DateTime.subtract(yield* DateTime.now, { hours: 2 }),
      });
      yield* admin.update(catalogHeads).set({ taxRates }).where(whereScope(catalogHeads, company));

      // Tax answers 23 % for the standard classification, but only once the test releases it.
      const calls = yield* Ref.make(0);
      const release = yield* Deferred.make<TaxRateBook>();
      const source = {
        read: () => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Deferred.await(release))),
      };
      const apply = Effect.fn('OrderEditRefresh.apply')(function* apply(
        command: typeof MerchandiseCommandPayloadSchema.Encoded.command,
        expectedRevision: number,
      ) {
        const payload = Schema.decodeSync(MerchandiseCommandPayloadSchema)({ command, expectedRevision });
        const scope = { ...native.principal, correlationId: `order-edit-refresh-${randomUUID()}` };
        const inScope = <A, E, R>(use: (tx: ScopedTransactionExecutor) => Effect.Effect<A, E, R>) =>
          runtime.transaction((tx) =>
            installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(Effect.flatMap(use)),
          );
        // As the Action's preparation does: Tax's answer first (with the order read in a snapshot), then the write.
        const tax = yield* prepareCommandTax(payload.command, scope, (use) => inScope(use).pipe(Effect.orDie)).pipe(
          Effect.provideService(TaxRateSource, source),
        );
        return yield* inScope((tx) =>
          persistenceService(tx, { prepared: { actionInvocationId: scope.correlationId, payload, tax }, scope }).pipe(
            Effect.flatMap((services) => services.apply(payload.command, expectedRevision, scope.correlationId)),
          ),
        );
      });
      const orderLines = admin
        .select()
        .from(orders)
        .where(and(whereScope(orders, company), eq(orders.id, 'o1')))
        .pipe(
          Effect.map(([order]) =>
            order === undefined ? [] : Schema.decodeUnknownSync(LinesSchema)(order.document).lines,
          ),
        );
      const [head] = yield* admin.select().from(catalogHeads).where(whereScope(catalogHeads, company));
      const stocked = yield* apply(
        { _tag: 'RecordStockMovement', delta: 5, productId: 'p3', reason: 'RECEIPT' },
        head?.revision ?? 0,
      );

      // Only the existing line changes: done at once, while Tax has not answered.
      const edited = yield* apply(
        { _tag: 'EditOrder', id: 'o1', lines: [{ productId: 'p1', quantity: 2 }] },
        stocked.revision,
      ).pipe(Effect.timeout('2 seconds'));
      expect(yield* orderLines).toEqual([{ productId: 'p1', quantity: 2, vatRate: 21 }]);

      // A new line: the edit waits for the refresh, and the line takes Tax's current rate.
      const adding = yield* Effect.forkChild(
        apply(
          {
            _tag: 'EditOrder',
            id: 'o1',
            lines: [
              { productId: 'p1', quantity: 2 },
              { productId: 'p3', quantity: 1 },
            ],
          },
          edited.revision,
        ),
      );
      // Tax answers half a second later: an edit that did not wait would have been stored at 21 % by then.
      yield* Effect.sleep('500 millis');
      yield* Deferred.succeed(release, testTaxBook({ reduced: '12', standard: '23' }));
      yield* Fiber.join(adding);
      expect(yield* orderLines).toEqual([
        { productId: 'p1', quantity: 2, vatRate: 21 },
        { productId: 'p3', quantity: 1, vatRate: 23 },
      ]);
      expect(yield* Ref.get(calls)).toBe(1);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
