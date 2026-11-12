// The governed Merchandise reads and the first write through Core's real Read and Action runtimes on PostgreSQL: the
// registered owner entrypoints, the access gate, the scoped runtime-role transaction and the owner factory. One
// company holds a catalog; the other never had a head row.
import { NodeCrypto } from '@effect/platform-node';
import {
  CoreSearchProjectionHitSchema,
  CoreSearchQueryRuntime,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import type { RecordsRequestEncoded } from '../../shared/apis/records.ts';
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
import { recordsRead } from '../../src/api/records.read.ts';
import { ordersRead } from '../../src/search/orders.provider.ts';
import { productsRead } from '../../src/search/products.provider.ts';
import { replaceSnapshot, whereScope } from '../../src/services/merchandise-store.ts';
import type { StoreScope } from '../../src/services/merchandise-store.ts';
import { persistenceService } from '../../src/services/persistence.service.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { catalogState } from './support/merchandise-database.ts';
import { TEST_COMPANY_TAX_RATES, TEST_RATES, TEST_TAX_BOOK } from '../support/tax-fixtures.ts';
import { CompanyTaxRatesSchema, TaxRateSource } from '../../src/services/tax-rates.ts';

type Fixture = Effect.Success<ReturnType<typeof makeNativeReadTestContext>>;

const companyOf = (principal: TrustedPrincipalContext): Effect.Effect<StoreScope> =>
  principal.legalEntityId === undefined
    ? Effect.die('The native fixture principal names no company')
    : Effect.succeed({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId });

/** One allowing gate, both for Core's runtime decision and for the owner's own rights questions. */
const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });

const nativeMerchandise = makeNativeReadTestContext({
  accessDecision: gate.bound,
  contextPermissions: [],
  moduleId: 'demo.merchandise',
  ownerFixtureRetention: 'retain-complete-context',
}).pipe(Effect.provideService(NativeReadTestOwnerRegistration, merchandiseRegistration));

const readRecords = (fixture: Fixture, input: RecordsRequestEncoded) =>
  fixture.runtime
    .runRead({
      input,
      principal: fixture.principal,
      registration: recordsRead,
      transport: { correlationId: 'merchandise-records-runtime' },
    })
    .pipe(
      Effect.provide(fixture.layer),
      Effect.provideService(AccessDecisionGate, gate.accessDecision),
      // Staff reads show the company's rates from Tax; the fixture's Tax answers the Czech baseline.
      Effect.provideService(TaxRateSource, { read: () => Effect.succeed(TEST_TAX_BOOK) }),
    );

const staffView: RecordsRequestEncoded = {};
const storefrontView: RecordsRequestEncoded = { view: { storefront: true, storefrontCatalog: { fields: 'card' } } };

/** A stale Core index hit for a record the company does not hold. */
const staleHitOf = (company: StoreScope, resource: 'order' | 'product') =>
  Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
    archived: false,
    facets: [],
    metadata: [],
    ref: {
      moduleId: 'demo.merchandise',
      resourceId: `${company.legalEntityId}.stale-${resource}`,
      resourceType: `demo.merchandise.${resource}`,
      tenantId: company.tenantId,
    },
    relevance: { score: 1000, version: '1' },
    selectedLegalEntityId: company.legalEntityId,
    title: 'Stale',
  });

/** Runs a search provider with Core's index answering only that stale hit; the owner rematches on its own rows. */
const withStaleIndex = <A, E, R>(
  fixture: Fixture,
  company: StoreScope,
  resource: 'order' | 'product',
  read: Effect.Effect<A, E, R>,
) =>
  read.pipe(
    Effect.provide(fixture.layer),
    Effect.provideService(AccessDecisionGate, gate.accessDecision),
    Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([staleHitOf(company, resource)]) }),
  );

it.live(
  'serves records and both search providers through the Core read runtime with and without a catalog head, and the first write creates it',
  () =>
    Effect.scoped(
      Effect.gen(function* recordsRuntime() {
        const connections = yield* loadDatabaseConnectionPair();
        const admin = yield* makeTestDatabaseFromClient(
          yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 }),
          merchandiseRelations,
        );
        const stocked = yield* nativeMerchandise;
        const empty = yield* nativeMerchandise;
        const [stockedCompany, emptyCompany] = yield* Effect.all([
          companyOf(stocked.principal),
          companyOf(empty.principal),
        ]);
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [stockedCompany, emptyCompany],
            (scope) =>
              Effect.all(
                [products, productVariants, priceTiers, stockMovements, orders, categories, catalogHeads].map((table) =>
                  admin.delete(table).where(whereScope(table, scope)),
                ),
                { concurrency: 1 },
              ),
            { discard: true },
          ).pipe(Effect.orDie),
        );
        const stockedRevision = yield* admin.transaction((tx) =>
          replaceSnapshot(tx, stockedCompany, catalogState, TEST_RATES),
        );
        // The stocked company synced with Tax; the empty one never did.
        yield* admin
          .update(catalogHeads)
          .set({ taxRates: yield* Schema.encodeEffect(CompanyTaxRatesSchema)(TEST_COMPANY_TAX_RATES) })
          .where(whereScope(catalogHeads, stockedCompany));

        // A company with a catalog: unchanged revision and its products.
        const stockedRead = yield* readRecords(stocked, staffView);
        expect(stockedRead.revision).toBe(stockedRevision);
        expect(stockedRead.products.length).toBeGreaterThan(0);

        // A company that never had a head: an empty catalog at revision 0 for staff and the storefront view alike.
        const emptyRead = yield* readRecords(empty, staffView);
        expect({ products: emptyRead.products, revision: emptyRead.revision }).toEqual({ products: [], revision: 0 });
        const storefront = yield* readRecords(empty, storefrontView);
        expect({ products: storefront.products, revision: storefront.revision }).toEqual({
          products: [],
          revision: 0,
        });
        expect(yield* admin.select().from(catalogHeads).where(whereScope(catalogHeads, emptyCompany))).toEqual([]);
        // The Core index still answers a stale hit for the empty company; the provider's current rematch on its rows
        // (the path that used to require a head) must drop it and answer an empty page, not an unavailable search.
        const searchInput = { principal: empty.principal, transport: { correlationId: 'merchandise-search-runtime' } };
        const productHits = yield* withStaleIndex(
          empty,
          emptyCompany,
          'product',
          empty.runtime.runRead({ ...searchInput, input: { query: 'kava' }, registration: productsRead }),
        );
        const orderHits = yield* withStaleIndex(
          empty,
          emptyCompany,
          'order',
          empty.runtime.runRead({ ...searchInput, input: { query: 'kava' }, registration: ordersRead }),
        );
        expect({ orders: orderHits, products: productHits }).toEqual({ orders: [], products: [] });

        // The first write, through the owner's persistence in a runtime-role transaction scoped to the empty company,
        // creates the head; the governed read then answers its revision.
        const payload = Schema.decodeSync(MerchandiseCommandPayloadSchema)({
          command: { _tag: 'CreateCategory', id: 'prvni', name: 'První kategorie', parentId: null, slug: 'prvni' },
          expectedRevision: 0,
        });
        const runtimeDb = yield* makeTestDatabaseFromClient(
          yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 1 }),
          merchandiseRelations,
        );
        const scope = { ...empty.principal, correlationId: 'merchandise-first-write' };
        const written = yield* runtimeDb.transaction((tx) =>
          Effect.gen(function* firstWrite() {
            const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
            const services = yield* persistenceService(scoped, {
              prepared: {
                actionInvocationId: scope.correlationId,
                payload,
                tax: { book: TEST_TAX_BOOK, refused: false },
              },
              scope,
            });
            return yield* services.apply(payload.command, payload.expectedRevision, scope.correlationId);
          }),
        );
        expect(written.revision).toBe(1);
        expect((yield* readRecords(empty, staffView)).revision).toBe(1);
        expect((yield* readRecords(stocked, staffView)).revision).toBe(stockedRevision);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);
