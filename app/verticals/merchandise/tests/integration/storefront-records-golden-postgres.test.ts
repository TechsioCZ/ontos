// The storefront `records` responses must not change when products name a VAT classification instead of a rate:
// the storefront apps read `vatRate` and the gross prices. The golden file was produced by the code before
// classifications (the same fixtures, read through the same governed read) and is compared field by field, gross
// prices included, after the per-run identities (actor, revision) are removed.
import { readFileSync } from 'node:fs';

import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
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
import { replaceSnapshot, whereScope } from '../../src/services/merchandise-store.ts';
import type { StoreScope } from '../../src/services/merchandise-store.ts';
import { CompanyTaxRatesSchema } from '../../src/services/tax-rates.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { TEST_COMPANY_TAX_RATES, TEST_PRICING } from '../support/tax-fixtures.ts';
import { catalogInput, decodeState } from './support/merchandise-database.ts';

type Fixture = Effect.Success<ReturnType<typeof makeNativeReadTestContext>>;

const GOLDEN = new URL('../fixtures/storefront-records-golden.json', import.meta.url);

/** A reduced-rate product beside the fixture's standard-rate ones, with tiers, so both rates and tiers are covered. */
const reducedProduct = {
  ...catalogInput.products[1],
  category: 'Káva',
  currentPriceMinor: 25_804,
  id: 'p-reduced',
  name: 'Káva zrnková',
  priceTiers: [
    { minimumQuantity: 1, priceExcludingVatMinor: 25_804, priceMinor: 28_900 },
    { minimumQuantity: 10, priceExcludingVatMinor: 23_224, priceMinor: 26_011 },
  ],
  sku: 'KAVA-1',
  slug: 'kava-zrnkova',
  taxClassificationCode: 'cz.vat.reduced',
};
/**
 * Products whose stored gross is not net plus VAT, as on stage: off by one minor unit (source rounding), off by a lot,
 * and a gross of 0 beside a net price. Their prices must come back exactly as stored.
 */
const storedGross = (id: string, net: number, gross: number) => ({
  ...catalogInput.products[1],
  currentPriceMinor: net,
  id,
  name: `Uložená cena ${id}`,
  priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: net, priceMinor: gross }],
  sku: id.toUpperCase(),
  slug: id,
  taxClassificationCode: 'cz.vat.standard',
});
const oddVariantProduct = {
  ...catalogInput.products[1],
  currentPriceMinor: 1_878_000,
  id: 'p-odd-variant',
  name: 'Varianta s uloženou cenou',
  sku: 'ODD-VARIANT',
  slug: 'odd-variant',
  taxClassificationCode: 'cz.vat.standard',
  variants: [
    {
      attributes: '',
      id: 'v-odd',
      name: 'Černá',
      priceMinor: 1_878_000,
      priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 1_878_000, priceMinor: 1_062_380 }],
      sku: 'ODD-BLK',
    },
    { attributes: '', id: 'v-plain', name: 'Bílá', priceMinor: 9999, sku: 'ODD-WHT' },
  ],
};
const goldenState = decodeState({
  ...catalogInput,
  products: [
    ...catalogInput.products,
    reducedProduct,
    storedGross('p-off-one', 1000, 1211),
    storedGross('p-off-more', 446, 646),
    storedGross('p-zero-gross', 500, 0),
    oddVariantProduct,
  ],
});

/** The company synced with Tax's Czech baseline, priced at it: what every selling company is after the migration. */
const writeCatalog = (admin: Effect.Success<ReturnType<typeof adminDatabase>>, company: StoreScope) =>
  Effect.gen(function* writeSyncedCatalog() {
    yield* admin.transaction((tx) => replaceSnapshot(tx, company, goldenState, TEST_PRICING));
    const taxRates = yield* Schema.encodeEffect(CompanyTaxRatesSchema)(TEST_COMPANY_TAX_RATES);
    yield* admin.update(catalogHeads).set({ taxRates }).where(whereScope(catalogHeads, company));
  });

const adminDatabase = () =>
  Effect.gen(function* adminDatabaseOf() {
    const connections = yield* loadDatabaseConnectionPair();
    return yield* makeTestDatabaseFromClient(
      yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 }),
      merchandiseRelations,
    );
  });

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

/** The storefront views the storefront apps use: listing cards, detail pages, cart, search, sorting, featured. */
const storefrontViews = {
  cards: { view: { storefront: true, storefrontCatalog: { fields: 'card' } } },
  cart: { view: { storefront: true, storefrontCatalog: { fields: 'full', productIds: ['p1'], variantIds: ['v1'] } } },
  category: { view: { storefront: true, storefrontCatalog: { categorySlug: 'metricke', fields: 'card' } } },
  detail: { view: { storefront: true, storefrontCatalog: { fields: 'full', slug: 'kava-zrnkova' } } },
  featured: { view: { storefront: true, storefrontCatalog: { featured: true, fields: 'card' } } },
  legacyList: { view: { limit: 250, storefront: true, summary: true } },
  oddVariantDetail: { view: { storefront: true, storefrontCatalog: { fields: 'full', slug: 'odd-variant' } } },
  priceAscending: { view: { storefront: true, storefrontCatalog: { fields: 'card', sort: 'price-asc' } } },
  priceBounds: { view: { storefront: true, storefrontCatalog: { fields: 'card', maxMinor: 30_000, minMinor: 100 } } },
  search: { view: { storefront: true, storefrontCatalog: { fields: 'card', q: 'sroub' } } },
} satisfies Readonly<Record<string, RecordsRequestEncoded>>;

const encodeResponse = Schema.encodeSync(RecordsResponseSchema);

/** The encoded response without the per-run identities (the actor and the catalog revision of a fresh company). */
const comparable = (response: typeof RecordsResponseSchema.Type) => {
  const { actorPrincipalRef: _actor, revision: _revision, ...rest } = encodeResponse(response);
  void _actor;
  void _revision;
  return rest;
};

const readView = (fixture: Fixture, input: RecordsRequestEncoded) =>
  fixture.runtime
    .runRead({
      input,
      principal: fixture.principal,
      registration: recordsRead,
      transport: { correlationId: 'merchandise-storefront-golden' },
    })
    .pipe(Effect.provide(fixture.layer), Effect.provideService(AccessDecisionGate, gate.accessDecision));

it.live('storefront records responses keep the shape and gross prices they had before VAT classifications', () =>
  Effect.scoped(
    Effect.gen(function* storefrontGolden() {
      const admin = yield* adminDatabase();
      const fixture = yield* nativeMerchandise;
      const company = yield* companyOf(fixture.principal);
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [products, productVariants, priceTiers, stockMovements, orders, categories, catalogHeads].map((table) =>
            admin.delete(table).where(whereScope(table, company)),
          ),
          { concurrency: 1 },
        ).pipe(Effect.orDie),
      );
      yield* writeCatalog(admin, company);
      const actual = Object.fromEntries(
        yield* Effect.forEach(
          Object.entries(storefrontViews),
          ([name, view]) =>
            readView(fixture, view).pipe(Effect.map((response) => [name, comparable(response)] as const)),
          { concurrency: 1 },
        ),
      );
      const golden: unknown = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
      expect(actual).toEqual(golden);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
