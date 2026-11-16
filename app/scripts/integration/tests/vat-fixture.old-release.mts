// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * Records the VAT transition fixture with the release before classifications. This file is written against that
 * release's code: copy it into a checkout of the trunk the deploy replaces as `scripts/integration/vat-fixture-record.test.mts`
 * and run it there on a clone of the deployed database (before any VAT migration), with ONTOS_VAT_FIXTURE_IN naming the
 * current fixture and ONTOS_VAT_FIXTURE_OUT the file to write. It is not part of this branch's own test projects.
 *
 * It stores the fixture's rows for a fresh company, then has that release write N1's jacket 38SA073510-BLK exactly as
 * stage holds it (product net mistyped 18 780,00 Kč, five real untiered variants at 8 780,00 / 10 623,80 Kč) through its
 * own commands, so every column is what that release computes. It then records the storefront answers (the jacket's
 * detail with its variant picker and a search for it included), places the fixture's order and one for a jacket
 * variant, records the answers after both, and writes rows, answers and orders.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { defineDatabaseIdentityEnrollment, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeCrypto } from '@effect/platform-node';
import { Config, Crypto, Effect, Predicate, Redacted, Schema, Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandPayloadSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import { recordsRead } from '../../verticals/merchandise/src/api/records.read.ts';
import { merchandiseRelations } from '../../verticals/merchandise/src/database/schema.ts';
import { readSnapshot } from '../../verticals/merchandise/src/services/merchandise-store.ts';
import { persistenceService } from '../../verticals/merchandise/src/services/persistence.service.ts';
import { merchandiseRegistration } from '../../verticals/merchandise/vertical.registration.ts';

const TABLES = [
  'catalog_heads',
  'categories',
  'products',
  'product_variants',
  'price_tiers',
  'stock_movements',
  'orders',
  'market_settings',
  'market_product_offers',
];
const MARKET_ID = '5f2d6c1e-7a3b-4c8d-9e0f-1a2b3c4d5e6f';
const STOREFRONT = { storefront: true };
export const JACKET_ID = 'spyder-jacket';
export const JACKET_SLUG = 'panska-bunda-spyder-vyper-jacket-cerna';
export const INFORMATIONAL_ID = 'informational-variants';
export const INFORMATIONAL_SLUG = 'tricko-barvy';
const views = {
  cards: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card' } } },
  cart: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', productIds: ['book-it', 'p-reduced', 'p2'] } } },
  category: { view: { ...STOREFRONT, storefrontCatalog: { categorySlug: 'metricke', fields: 'card' } } },
  detailBookIt: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'book-it' } } },
  detailInformational: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: INFORMATIONAL_SLUG } } },
  detailJacket: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: JACKET_SLUG } } },
  detailOddVariant: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'odd-variant' } } },
  detailReduced: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'kava-zrnkova' } } },
  featured: { view: { ...STOREFRONT, storefrontCatalog: { featured: true, fields: 'card' } } },
  legacyList: { view: { ...STOREFRONT, limit: 250, summary: true } },
  marketCards: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', marketId: MARKET_ID } } },
  marketDetail: {
    view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', marketId: MARKET_ID, slug: 'book-it' } },
  },
  priceAscending: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', sort: 'price-asc' } } },
  priceBounds: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', maxMinor: 60_000, minMinor: 100 } } },
  search: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', q: 'sroub' } } },
  searchJacket: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', q: 'spyder' } } },
};

const encodeResponse = Schema.encodeSync(RecordsResponseSchema);
const comparable = (response) => {
  const { actorPrincipalRef: _actor, revision: _revision, ...rest } = encodeResponse(response);
  void _actor;
  void _revision;
  return rest;
};
const uuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const plain = (value) => JSON.parse(JSON.stringify(value));

it.live('records the VAT transition fixture with the release before classifications', () =>
  Effect.gen(function* recordFixture() {
    const fixture = JSON.parse(readFileSync(yield* Config.String('ONTOS_VAT_FIXTURE_IN'), 'utf-8'));
    const out = yield* Config.String('ONTOS_VAT_FIXTURE_OUT');
    const connections = yield* loadDatabaseConnectionPair();
    const adminPg = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 2 });
    const runtimeDb = yield* makeTestDatabaseFromClient(
      yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 1 }),
      merchandiseRelations,
    );
    const allowAll = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
    const native = yield* makeNativeReadTestContext({
      accessDecision: allowAll.bound,
      connections: {
        admin: { connectionString: Redacted.make(connections.admin.connectionString) },
        runtime: { connectionString: Redacted.make(connections.runtime.connectionString) },
      },
      contextPermissions: [],
      moduleId: 'demo.merchandise',
      ownerFixtureRetention: 'retain-complete-context',
    }).pipe(
      Effect.provideService(NativeReadTestOwnerRegistration, merchandiseRegistration),
      Scope.provide(yield* Scope.make()),
    );
    const { legalEntityId, tenantId } = native.principal;
    const companyId = legalEntityId ?? '';
    // The fixture's rows as they stood before its order (two older orders included); the orders follow below.
    for (const table of TABLES) {
      yield* adminPg.unsafe(
        `insert into demo_merchandise.${table} select * from jsonb_populate_recordset(null::demo_merchandise.${table}, $1::jsonb)`,
        [
          JSON.stringify(
            (fixture.rows[table] ?? []).map((row) => ({ ...row, legal_entity_id: companyId, tenant_id: tenantId })),
          ),
        ],
      );
    }
    const revisionNow = adminPg
      .unsafe('select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2', [
        tenantId,
        companyId,
      ])
      .pipe(Effect.map(([head]) => head?.revision ?? 0));
    const apply = Effect.fn('VatFixture.apply')(function* apply(command, id) {
      const correlationId = id ?? (yield* uuid);
      const scope: OperationalScope = { ...native.principal, correlationId };
      const payload = Schema.decodeUnknownSync(MerchandiseCommandPayloadSchema)({
        command,
        expectedRevision: yield* revisionNow,
      });
      return yield* runtimeDb.transaction((tx) =>
        installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(
          Effect.flatMap((scoped) =>
            persistenceService(scoped, { prepared: { actionInvocationId: correlationId, payload }, scope }),
          ),
          Effect.flatMap((services) => services.apply(payload.command, payload.expectedRevision, correlationId)),
        ),
      );
    });

    // N1's jacket as stage holds it, written by this release: a mistyped product net and five consistent variants.
    yield* apply(
      {
        _tag: 'CreateProduct',
        active: true,
        category: 'Podložky',
        lowStockThreshold: 0,
        name: 'Pánská bunda Spyder Vyper Jacket – černá',
        priceMinor: 1_878_000,
        sku: '38SA073510-BLK',
        slug: JACKET_SLUG,
        unit: 'ks',
        vatRate: 21,
      },
      JACKET_ID,
    );
    yield* apply({
      _tag: 'UpdateProduct',
      id: JACKET_ID,
      patch: {
        variants: ['S', 'M', 'L', 'XL', 'XXL'].map((size) => ({
          attributes: `Velikost: ${size}`,
          name: size,
          priceMinor: 878_000,
          sku: `38SA073510-BLK-${size}`,
        })),
      },
    });
    // Stage's two variants without an id: informational ones (a name and attributes, no price), which this release
    // writes with a NULL `variant_id` and never sells; the product sells at its own price.
    yield* apply(
      {
        _tag: 'CreateProduct',
        active: true,
        category: 'Podložky',
        lowStockThreshold: 0,
        name: 'Tričko v barvách',
        priceMinor: 41_240,
        sku: 'TRICKO-BARVY',
        slug: INFORMATIONAL_SLUG,
        unit: 'ks',
        vatRate: 21,
        variants: [
          { attributes: 'Barva: černá', name: 'černá' },
          { attributes: 'Barva: bílá', name: 'bílá' },
        ],
      },
      INFORMATIONAL_ID,
    );
    yield* apply({ _tag: 'RecordStockMovement', delta: 4, productId: INFORMATIONAL_ID, reason: 'RECEIPT' });
    const store = { legalEntityId: companyId, tenantId };
    const snapshot = yield* runtimeDb.transaction((tx) =>
      installOperationalScope(
        tx,
        { ...native.principal, correlationId: 'vat-fixture-read' },
        defineDatabaseIdentityEnrollment([]),
      ).pipe(Effect.flatMap((scoped) => readSnapshot(scoped, store))),
    );
    const jacketVariants = snapshot?.state.products.find((entry) => entry.id === JACKET_ID)?.variants;
    expect(jacketVariants?.length).toBe(5);
    for (const variant of jacketVariants ?? []) {
      yield* apply({
        _tag: 'RecordStockMovement',
        delta: 3,
        productId: JACKET_ID,
        reason: 'RECEIPT',
        variantId: variant.id,
      });
    }

    const rows = {};
    for (const table of TABLES) {
      rows[table] = plain(
        yield* adminPg.unsafe(
          `select to_jsonb(t) as row from demo_merchandise.${table} t where tenant_id = $1 and legal_entity_id = $2 ${
            table === 'catalog_heads' ? '' : 'order by 1'
          }`,
          [tenantId, companyId],
        ),
      ).map((entry) => entry.row);
    }
    const read = (input) =>
      native.runtime
        .runRead({
          input,
          principal: native.principal,
          registration: recordsRead,
          transport: { correlationId: 'vat-fixture' },
        })
        .pipe(Effect.provide(native.layer), Effect.provideService(AccessDecisionGate, allowAll.accessDecision));
    const storefront = Effect.forEach(
      Object.entries(views),
      ([name, view]) => read(view).pipe(Effect.map((response) => [name, plain(comparable(response))])),
      { concurrency: 1 },
    ).pipe(Effect.map(Object.fromEntries));

    const before = yield* storefront;
    const orderOf = (placed) =>
      plain(Predicate.hasProperty(placed, 'storefrontOrder') ? placed.storefrontOrder : undefined);
    const order = orderOf(yield* apply(fixture.order.command.command));
    const jacketCommand = {
      _tag: 'PlaceStorefrontOrder',
      clientRequestId: 'vat-transition-order-jacket',
      contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
      deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' },
      lines: [
        { expectedUnitPriceMinor: 1_062_380, productId: JACKET_ID, quantity: 1, variantId: jacketVariants?.[1]?.id },
        { expectedUnitPriceMinor: 49_900, productId: INFORMATIONAL_ID, quantity: 1 },
      ],
      shippingMethod: 'ZASILKOVNA',
    };
    const jacketOrder = orderOf(yield* apply(jacketCommand));
    expect(jacketOrder?.lines?.map((line) => line.unitPriceMinor)).toEqual([1_062_380, 49_900]);
    const after = yield* storefront;
    const documentOf = (placed) =>
      adminPg
        .unsafe(
          'select document from demo_merchandise.orders where tenant_id = $1 and legal_entity_id = $2 and id = $3',
          [tenantId, companyId, placed?.orderId],
        )
        .pipe(Effect.map(([row]) => plain(row?.document)));
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          after,
          before,
          company: { legalEntityId: companyId, tenantId },
          jacketOrder: {
            command: { command: jacketCommand },
            document: yield* documentOf(jacketOrder),
            storefrontOrder: jacketOrder,
          },
          order: { command: fixture.order.command, document: yield* documentOf(order), storefrontOrder: order },
          rows,
        },
        null,
        2,
      )}\n`,
    );
    return yield* Effect.void;
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
