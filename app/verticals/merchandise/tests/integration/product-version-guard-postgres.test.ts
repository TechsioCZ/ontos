// A product edit from the editor names the product version it was read at (`expectedUpdatedAt`), run through
// `persistenceService.apply` on PostgreSQL as the Action runs it:
// - another product's edit and a stock movement move the company's catalogue revision but never refuse the edit;
// - a second edit naming the version the first one replaced is refused, and writes nothing;
// - an edit naming the version the last write left goes through;
// - a caller that names no version keeps the catalogue-revision check.
import { randomUUID } from 'node:crypto';

import { defineDatabaseIdentityEnrollment, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { ScopedTransactionExecutor, TrustedPrincipalContext } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeNativeReadTestContext, NativeReadTestOwnerRegistration } from '@app/core-runtime/testing/native-reads';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
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
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { TEST_PRICING, TEST_TAX_BOOK } from '../support/tax-fixtures.ts';
import { at, catalogState } from './support/merchandise-database.ts';

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

const ProductDocumentSchema = Schema.Struct({ lowStockThreshold: Schema.Number, name: Schema.String });

it.live('a product edit naming its version is refused only when that product changed since', () =>
  Effect.scoped(
    Effect.gen(function* productVersionGuard() {
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
        syncedAt: yield* DateTime.now,
      });
      yield* admin.update(catalogHeads).set({ taxRates }).where(whereScope(catalogHeads, company));
      const source = { read: () => Effect.succeed(TEST_TAX_BOOK) };

      const apply = Effect.fn('ProductVersionGuard.apply')(function* apply(
        command: typeof MerchandiseCommandPayloadSchema.Encoded.command,
        expectedRevision: number,
      ) {
        const payload = Schema.decodeSync(MerchandiseCommandPayloadSchema)({ command, expectedRevision });
        const scope = { ...native.principal, correlationId: `product-version-guard-${randomUUID()}` };
        const inScope = <A, E, R>(use: (tx: ScopedTransactionExecutor) => Effect.Effect<A, E, R>) =>
          runtime.transaction((tx) =>
            installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(Effect.flatMap(use)),
          );
        const tax = yield* prepareCommandTax(payload.command, scope, (use) => inScope(use).pipe(Effect.orDie)).pipe(
          Effect.provideService(TaxRateSource, source),
        );
        return yield* inScope((tx) =>
          persistenceService(tx, { prepared: { actionInvocationId: scope.correlationId, payload, tax }, scope }).pipe(
            Effect.flatMap((services) => services.apply(payload.command, expectedRevision, scope.correlationId)),
          ),
        );
      });
      const head = admin
        .select({ revision: catalogHeads.revision })
        .from(catalogHeads)
        .where(whereScope(catalogHeads, company))
        .pipe(Effect.map(([row]) => row?.revision ?? 0));
      const p1 = admin
        .select()
        .from(products)
        .where(and(whereScope(products, company), eq(products.id, 'p1')))
        .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(ProductDocumentSchema)(row?.document)));

      // The editor reads p1 at the seeded revision; meanwhile another product is edited and stock is received.
      const loaded = yield* head;
      const other = yield* apply({ _tag: 'UpdateProduct', id: 'p3', patch: { lowStockThreshold: 4 } }, loaded);
      yield* apply({ _tag: 'RecordStockMovement', delta: 5, productId: 'p3', reason: 'RECEIPT' }, other.revision);
      expect(yield* head).toBeGreaterThan(loaded);

      // The save made against the revision p1 was read at still goes through.
      const saved = yield* apply(
        { _tag: 'UpdateProduct', expectedUpdatedAt: at, id: 'p1', patch: { lowStockThreshold: 7 } },
        loaded,
      );
      expect((yield* p1).lowStockThreshold).toBe(7);
      expect(saved.updatedAt).toBeDefined();
      const version = saved.updatedAt === undefined ? at : DateTime.formatIso(saved.updatedAt);
      expect(version).not.toBe(at);

      // Another session still holding the version that save replaced is refused, and nothing is written.
      const before = { head: yield* head, product: yield* p1 };
      const stale = yield* Effect.exit(
        apply({ _tag: 'UpdateProduct', expectedUpdatedAt: at, id: 'p1', patch: { name: 'Jiný název' } }, before.head),
      );
      expect(Exit.isFailure(stale)).toBe(true);
      expect({ head: yield* head, product: yield* p1 }).toEqual(before);

      // A save naming the version the last write left goes through, whatever the catalogue revision moved to.
      yield* apply({ _tag: 'RecordStockMovement', delta: -1, productId: 'p3', reason: 'ISSUE' }, before.head);
      yield* apply(
        { _tag: 'UpdateProduct', expectedUpdatedAt: version, id: 'p1', patch: { lowStockThreshold: 0 } },
        loaded,
      );
      expect((yield* p1).lowStockThreshold).toBe(0);

      // A caller naming no product version keeps the catalogue-revision check.
      const unversioned = yield* Effect.exit(
        apply({ _tag: 'UpdateProduct', id: 'p1', patch: { lowStockThreshold: 3 } }, loaded),
      );
      expect(Exit.isFailure(unversioned)).toBe(true);
      expect((yield* p1).lowStockThreshold).toBe(0);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
