// Write paths of the normalized merchandise storage (merchandise-store.ts) against PostgreSQL: snapshot
// round-trip, and command writes that must touch only the rows the command changed.
import { randomUUID } from 'node:crypto';

import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { asc } from 'drizzle-orm';
import { DateTime, Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  MerchandiseCommandSchema,
  MerchandiseLifecycleConflict,
  MerchandiseNotFound,
} from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { StorefrontCatalogQuerySchema } from '../../shared/apis/records.ts';
import {
  CatalogChangeSchema,
  OrderSchema,
  ProductIdSchema,
  ProductSchema,
  ProductVariantSchema,
} from '../../shared/domain/merchandise-model.ts';
import {
  catalogHeads,
  categories,
  orders,
  priceTiers,
  productVariants,
  products,
  stockMovements,
} from '../../src/database/schema.ts';
import { categoryTree, storefrontProducts } from '../../src/services/merchandise-queries.ts';
import {
  decodeOrderDocument,
  loadHead,
  loadWorkingSet,
  persistChange,
  readSnapshot,
  replaceSnapshot,
  whereScope,
} from '../../src/services/merchandise-store.ts';
import { evolveMerchandiseState, workingSetRequestOf } from '../../src/services/persistence.service.ts';
import type { MerchandiseFixture } from './support/merchandise-database.ts';
import {
  at,
  catalogInput,
  catalogState,
  withStoredGross,
  decodeState,
  encodeState,
  withMerchandise,
} from './support/merchandise-database.ts';
import { TEST_RATES, TEST_TAX } from '../support/tax-fixtures.ts';

const encodeOrder = Schema.encodeSync(OrderSchema);
const now = DateTime.makeUnsafe('2026-10-22T10:00:00.000Z');
const nowIso = '2026-10-22T10:00:00.000Z';
const actor = Schema.decodeUnknownSync(PrincipalRefSchema)({ principalId: randomUUID(), tenantId: randomUUID() });
const archivedActor = Schema.decodeUnknownSync(PrincipalRefSchema)(catalogInput.orders[1]?.demoCleanup?.actor);
const decodeProductDocument = Schema.decodeUnknownSync(Schema.toEncoded(ProductSchema));
const decodeVariantDocument = Schema.decodeUnknownSync(Schema.toEncoded(ProductVariantSchema));
const decodeCategoryHistory = Schema.decodeUnknownSync(Schema.Array(CatalogChangeSchema));
const requiredFixtureValue = <Value>(value: Value | undefined) =>
  value === undefined ? Effect.die('Required merchandise fixture value is missing') : Effect.succeed(value);

/** Every stored row of the scope, in key order (ordinal columns included, so a re-insert shows up). */
const rowsOf = ({ db, scope }: MerchandiseFixture) =>
  Effect.gen(function* readScopedRows() {
    return {
      categories: yield* db.select().from(categories).where(whereScope(categories, scope)).orderBy(asc(categories.id)),
      head: (yield* db.select().from(catalogHeads).where(whereScope(catalogHeads, scope)))[0],
      movements: yield* db
        .select()
        .from(stockMovements)
        .where(whereScope(stockMovements, scope))
        .orderBy(asc(stockMovements.ordinal)),
      orders: yield* db.select().from(orders).where(whereScope(orders, scope)).orderBy(asc(orders.ordinal)),
      products: yield* db.select().from(products).where(whereScope(products, scope)).orderBy(asc(products.id)),
      tiers: yield* db
        .select()
        .from(priceTiers)
        .where(whereScope(priceTiers, scope))
        .orderBy(asc(priceTiers.productId), asc(priceTiers.variantPosition), asc(priceTiers.position)),
      variants: yield* db
        .select()
        .from(productVariants)
        .where(whereScope(productVariants, scope))
        .orderBy(asc(productVariants.productId), asc(productVariants.position)),
    };
  });

type Rows = Effect.Success<ReturnType<typeof rowsOf>>;
const productRow = (rows: Rows, id: string) => rows.products.find((row) => row.id === id);
const untouched = (rows: Rows) => rows.products.filter((row) => !['p1', 'p5'].includes(row.id));
const othersOf = <Row extends { readonly productId: string }>(rows: readonly Row[], ids: readonly string[]) =>
  rows.filter((row) => !ids.includes(row.productId));

/** One command the way persistence runs it: locked head, working set, pure evolve, delta write. */
const decodeWorkingCommand = (input: typeof MerchandiseCommandSchema.Encoded) =>
  Schema.decodeEffect(MerchandiseCommandSchema)(input).pipe(
    Effect.flatMap((command) =>
      Match.value(command).pipe(
        Match.tag(
          'AiDecideChanges',
          'AiProposeChanges',
          'AiRevertBatch',
          'ConfigureMarket',
          'RemoveMarket',
          'ResetDemoData',
          'SetMarketProductOffers',
          'SetProductMarketOffer',
          () => Effect.die('This fixture only runs working-set commands'),
        ),
        Match.orElse((supported) => Effect.succeed(supported)),
      ),
    ),
  );
const runCommand = (
  fixture: MerchandiseFixture,
  input: typeof MerchandiseCommandSchema.Encoded,
  resourceId: string = randomUUID(),
) =>
  Effect.gen(function* applyFixtureCommand() {
    const command = yield* decodeWorkingCommand(input);
    return yield* fixture.db.transaction((transaction) =>
      Effect.gen(function* persistFixtureCommand() {
        const head = yield* loadHead(transaction, fixture.scope, { lock: true });
        if (head === undefined) {
          return yield* Effect.die('missing head');
        }
        const working = yield* loadWorkingSet(
          transaction,
          fixture.scope,
          head,
          workingSetRequestOf(command, resourceId),
        );
        const change = yield* evolveMerchandiseState(working.state, command, { actor, now, resourceId, tax: TEST_TAX });
        const revision =
          change.state === working.state
            ? working.revision
            : yield* persistChange(transaction, fixture.scope, working, change.state, now, TEST_RATES, {});
        return { change, revision, working };
      }),
    );
  });

const headRevision = ({ db, scope }: MerchandiseFixture) =>
  db
    .select({ revision: catalogHeads.revision })
    .from(catalogHeads)
    .where(whereScope(catalogHeads, scope))
    .pipe(Effect.map((rows) => rows[0]?.revision));

// ------------------------------------------------------------------------------------------------ snapshot

const richInput = {
  ...catalogInput,
  aiChanges: { batches: [], changes: [], log: [] },
  categories: catalogInput.categories.map((category) =>
    category.id === 'c' ? { ...category, published: false } : category,
  ),
  movements: [
    ...catalogInput.movements,
    { at, delta: 4, id: 'receipt-p3', note: 'Naskladnění', productId: 'p3', reason: 'RECEIPT', reference: 'DL-1' },
    { at, delta: -1, id: 'issue-p3', productId: 'p3', reason: 'ISSUE' },
  ],
  products: catalogInput.products.map((product) =>
    Match.value(product.id).pipe(
      Match.when('p1', () => ({
        ...product,
        priceTiers: [
          { minimumQuantity: 1, priceExcludingVatMinor: 100, priceMinor: 121 },
          { minimumQuantity: 50, priceExcludingVatMinor: 90, priceMinor: 109 },
        ],
        variants: [
          {
            attributes: 'zinek',
            id: 'v1',
            name: 'M8 × 20',
            parameters: [{ label: 'Délka', unit: 'mm', value: '20' }],
            priceMinor: 100,
            priceTiers: [{ minimumQuantity: 10, priceExcludingVatMinor: 95, priceMinor: 115 }],
            sku: 'P1-M8',
            unit: 'bal',
          },
          { attributes: 'pouze informace', name: 'Informační' },
          { active: false, attributes: '', id: 'v2', name: 'M10', priceMinor: 150, sku: 'P1-M10' },
        ],
      })),
      Match.when('p3', () => ({ ...product, featuredPosition: 2, isNew: true, slug: 'matice', stockTracked: false })),
      Match.when('p4', () => ({
        ...product,
        active: false,
        demoArchive: { actor: archivedActor, at, reason: 'Konec ukázky' },
      })),
      Match.orElse(() => product),
    ),
  ),
};

it.live('readSnapshot returns exactly what replaceSnapshot wrote', () => {
  const state = withStoredGross(decodeState(richInput));
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* snapshotRoundTrip() {
      expect(fixture.revision).toBe(0);
      const snapshot = yield* requiredFixtureValue(yield* readSnapshot(fixture.db, fixture.scope));
      expect(snapshot?.revision).toBe(0);
      expect(encodeState(snapshot.state)).toEqual(encodeState(state));
      const rows = yield* rowsOf(fixture);
      expect(
        rows.variants.map((row) => [row.productId, row.position, row.variantId, row.stockOnHand, row.unit]),
      ).toEqual([
        ['p1', 0, 'v1', 5, 'bal'],
        ['p1', 1, null, 0, 'ks'],
        ['p1', 2, 'v2', 0, 'ks'],
      ]);
      expect(rows.tiers.map((row) => [row.productId, row.variantPosition, row.position, row.priceMinor])).toEqual([
        ['p1', -1, 0, 121],
        ['p1', -1, 1, 109],
        ['p1', 0, 0, 115],
      ]);
      // Documents never repeat what lives in their own rows.
      const storedProduct = yield* requiredFixtureValue(productRow(rows, 'p1'));
      const storedVariant = yield* requiredFixtureValue(rows.variants[0]);
      expect('variants' in decodeProductDocument(storedProduct.document)).toBe(false);
      expect('priceTiers' in decodeProductDocument(storedProduct.document)).toBe(false);
      expect('priceTiers' in decodeVariantDocument(storedVariant.document)).toBe(false);
      expect(productRow(rows, 'p3')?.stockOnHand).toBe(3);
      expect(productRow(rows, 'p4')?.archived).toBe(true);
    }),
  );
});

const storedCatalog = withStoredGross(catalogState);

it.live('replaceSnapshot replaces the whole company and advances the revision', () =>
  withMerchandise(withStoredGross(decodeState(richInput)), (fixture) =>
    Effect.gen(function* replaceCompanySnapshot() {
      const smaller: MerchandiseState = {
        ...storedCatalog,
        movements: [],
        orders: [],
        products: storedCatalog.products.slice(1, 2),
      };
      const revision = yield* fixture.db.transaction((transaction) =>
        replaceSnapshot(transaction, fixture.scope, smaller),
      );
      expect(revision).toBe(1);
      const snapshot = yield* requiredFixtureValue(yield* readSnapshot(fixture.db, fixture.scope));
      expect(snapshot?.revision).toBe(1);
      expect(encodeState(snapshot.state)).toEqual(encodeState(smaller));
      const rows = yield* rowsOf(fixture);
      expect(rows.variants).toEqual([]);
      expect(rows.tiers).toEqual([]);
      expect(rows.head?.aiChanges).toBeNull();
    }),
  ),
);

// ------------------------------------------------------------------------------------------------ commands

it.live('PlaceStorefrontOrder writes one order, its ORDER movements and stock columns, nothing else', () =>
  withMerchandise(catalogState, (fixture) =>
    Effect.gen(function* storefrontOrderPersistence() {
      const before = yield* rowsOf(fixture);
      const orderId = `order-${randomUUID()}`;
      const command = {
        _tag: 'PlaceStorefrontOrder',
        billingAddress: { city: 'Praha', country: 'CZ', postalCode: '11000', street: 'Fakturační 2' },
        clientRequestId: `client-${randomUUID()}`,
        contact: { email: 'jana@example.cz', name: 'Jana Nováková', phone: '+420777123456' },
        deliveryAddress: { city: 'Brno', postalCode: '60200', street: 'Hlavní 1' },
        deliveryRecipient: { firstName: 'Petr', lastName: 'Novák', phone: '+420777987654' },
        lines: [{ expectedUnitPriceMinor: 121, productId: 'p1', quantity: 2, variantId: 'v1' }],
        partyId: 'test-customer-party',
        shippingMethod: 'ZASILKOVNA',
      } satisfies typeof MerchandiseCommandSchema.Encoded;
      const { change, revision } = yield* runCommand(fixture, command, orderId);
      expect(change.storefrontOrder?.outcome).toBe('PLACED');
      expect(revision).toBe(fixture.revision + 1);
      expect(yield* headRevision(fixture)).toBe(fixture.revision + 1);

      const after = yield* rowsOf(fixture);
      // Orders: the existing ones untouched, exactly one new row.
      expect(after.orders.slice(0, 2)).toEqual(before.orders);
      expect(after.orders.length).toBe(3);
      const placed = yield* requiredFixtureValue(after.orders[2]);
      expect(placed.id).toBe(orderId);
      expect(placed.number).toBe('OBJ-2026-0003');
      expect(placed.channel).toBe('STOREFRONT');
      expect(placed.clientRequestId).toBe(command.clientRequestId);
      expect(placed.status).toBe('NEW');
      expect(placed.removed).toBe(false);
      expect(placed.document).toMatchObject({
        billingAddress: command.billingAddress,
        deliveryRecipient: command.deliveryRecipient,
      });
      const stored = yield* decodeOrderDocument(placed.document);
      expect(stored.billingAddress).toEqual(command.billingAddress);
      expect(stored.deliveryRecipient).toEqual(command.deliveryRecipient);
      expect(stored.contact).toEqual(command.contact);
      const snapshot = yield* requiredFixtureValue(yield* readSnapshot(fixture.db, fixture.scope));
      expect(snapshot?.state.orders.find((order) => order.id === orderId)?.billingAddress).toEqual(
        command.billingAddress,
      );
      expect(snapshot?.state.orders.find((order) => order.id === orderId)?.deliveryRecipient).toEqual(
        command.deliveryRecipient,
      );
      const created = yield* requiredFixtureValue(change.state.orders.find((order) => order.id === orderId));
      expect(encodeOrder(stored)).toEqual(encodeOrder(created));
      expect(placed.totalMinor).toBe(created.totalMinor);

      // Ledger: the old receipt untouched, one ORDER movement per line.
      expect(after.movements.slice(0, 1)).toEqual(before.movements);
      expect(
        after.movements
          .slice(1)
          .map((row) => [row.id, row.productId, row.variantId, row.delta, row.reason, row.reference]),
      ).toEqual([[`${orderId}:0`, 'p1', 'v1', -2, 'ORDER', 'OBJ-2026-0003']]);

      // Stock columns of the ordered product and variant follow the ledger; its document stays as it was.
      const p1Before = yield* requiredFixtureValue(productRow(before, 'p1'));
      const p1After = yield* requiredFixtureValue(productRow(after, 'p1'));
      expect(p1After.stockOnHand).toBe(3);
      expect(after.variants.find((row) => row.variantId === 'v1')?.stockOnHand).toBe(3);
      expect({ ...p1After, stockOnHand: p1Before.stockOnHand, stockValueMinor: p1Before.stockValueMinor }).toEqual(
        p1Before,
      );
      expect(after.variants.map((row) => ({ ...row, stockOnHand: 0 }))).toEqual(
        before.variants.map((row) => ({ ...row, stockOnHand: 0 })),
      );
      // Everything else is byte-for-byte unchanged.
      expect(after.products.filter((row) => row.id !== 'p1')).toEqual(before.products.filter((row) => row.id !== 'p1'));
      expect(after.tiers).toEqual(before.tiers);
      expect(after.categories).toEqual(before.categories);

      // Reads see the new stock without loading the ledger.
      const card = yield* storefrontProducts(fixture.db, fixture.scope, {
        query: { fields: 'card', productIds: [Schema.decodeUnknownSync(ProductIdSchema)('p1')] },
      });
      expect(card.products[0]?.stockOnHand).toBe(3);
      expect(card.products[0]?.variantSummary?.stockOnHand).toBe(3);

      // A repeated submission replays the stored order and writes nothing.
      const replay = yield* runCommand(fixture, command);
      expect(replay.change.storefrontOrder?.outcome).toBe('REPLAYED');
      expect(replay.change.state).toBe(replay.working.state);
      expect(yield* rowsOf(fixture)).toEqual(after);
    }),
  ),
);

it.live('both order creation paths advance past the highest numeric sequence after 9999', () =>
  withMerchandise(
    decodeState({
      ...catalogInput,
      orders: catalogInput.orders.map((order, index) => ({
        ...order,
        number: index === 0 ? 'OBJ-2026-9999' : 'OBJ-2026-10000',
      })),
    }),
    (fixture) =>
      Effect.gen(function* numericOrderSequence() {
        const staffOrderId = randomUUID();
        const staff = yield* runCommand(fixture, {
          _tag: 'CreateOrder',
          id: staffOrderId,
          lines: [{ productId: 'p1', quantity: 1, variantId: 'v1' }],
          partyId: 'test-customer-party',
        });
        expect(staff.working.state.lastOrderNumber).toBe('OBJ-2026-10000');
        expect(staff.change.state.orders.find((order) => order.id === staffOrderId)?.number).toBe('OBJ-2026-10001');

        const storefront = yield* runCommand(fixture, {
          _tag: 'PlaceStorefrontOrder',
          clientRequestId: randomUUID(),
          contact: { email: 'customer@example.test', name: 'Customer' },
          deliveryAddress: { city: 'Brno', postalCode: '60200', street: 'Hlavní 1' },
          lines: [{ expectedUnitPriceMinor: 121, productId: 'p1', quantity: 1, variantId: 'v1' }],
          partyId: 'test-customer-party',
          shippingMethod: 'OSOBNI_ODBER',
        });
        expect(storefront.working.state.lastOrderNumber).toBe('OBJ-2026-10001');
        expect(storefront.change.storefrontOrder?.orderNumber).toBe('OBJ-2026-10002');
        const stored = yield* rowsOf(fixture);
        expect(stored.orders.map((order) => order.number)).toEqual([
          'OBJ-2026-9999',
          'OBJ-2026-10000',
          'OBJ-2026-10001',
          'OBJ-2026-10002',
        ]);
      }),
  ),
);

const tieredInput = {
  ...catalogInput,
  products: catalogInput.products.map((product) =>
    product.id === 'p2'
      ? {
          ...product,
          priceTiers: [
            { minimumQuantity: 1, priceExcludingVatMinor: 50, priceMinor: 61 },
            { minimumQuantity: 10, priceExcludingVatMinor: 45, priceMinor: 55 },
          ],
        }
      : product,
  ),
};

it.live('ChangePrice rewrites only the repriced product with its tiers, keeping its stock and catalog position', () =>
  withMerchandise(decodeState(tieredInput), (fixture) =>
    Effect.gen(function* changePricePersistence() {
      const before = yield* rowsOf(fixture);
      const { revision } = yield* runCommand(fixture, { _tag: 'ChangePrice', id: 'p2', priceMinor: 100 });
      expect(revision).toBe(fixture.revision + 1);
      const after = yield* rowsOf(fixture);

      const p2Before = yield* requiredFixtureValue(productRow(before, 'p2'));
      const p2After = yield* requiredFixtureValue(productRow(after, 'p2'));
      expect(p2After.currentPriceMinor).toBe(100);
      expect(p2After.grossPriceMinor).toBe(121);
      expect(p2After.ordinal).toBe(p2Before.ordinal);
      expect(p2After.createdAt).toEqual(p2Before.createdAt);
      expect(p2After.updatedAt.toISOString()).toBe(nowIso);
      const document = decodeProductDocument(p2After.document);
      expect(document.currentPriceMinor).toBe(100);
      expect(document.priceHistory.length).toBe(1);
      expect(document.updatedAt).toBe(nowIso);
      expect(
        after.tiers
          .filter((row) => row.productId === 'p2')
          .map((row) => [
            row.variantPosition,
            row.position,
            row.minimumQuantity,
            row.priceMinor,
            row.priceExcludingVatMinor,
          ]),
      ).toEqual([
        [-1, 0, 1, 121, 100],
        [-1, 1, 10, 109, 90],
      ]);

      expect(after.products.filter((row) => row.id !== 'p2')).toEqual(before.products.filter((row) => row.id !== 'p2'));
      expect(othersOf(after.tiers, ['p2'])).toEqual(othersOf(before.tiers, ['p2']));
      expect(after.variants).toEqual(before.variants);
      expect(after.movements).toEqual(before.movements);
      expect(after.orders).toEqual(before.orders);
      expect(after.categories).toEqual(before.categories);

      // A variant price change rewrites that product's variants but keeps their stock.
      yield* runCommand(fixture, { _tag: 'ChangePrice', id: 'p1', priceMinor: 200, variantId: 'v1' });
      const variantAfter = yield* rowsOf(fixture);
      const v1 = yield* requiredFixtureValue(variantAfter.variants.find((row) => row.variantId === 'v1'));
      expect(v1.priceMinor).toBe(200);
      expect(v1.grossPriceMinor).toBe(242);
      expect(v1.stockOnHand).toBe(5);
      expect(decodeVariantDocument(v1.document).priceHistory?.length).toBe(1);
      const p1 = yield* requiredFixtureValue(productRow(variantAfter, 'p1'));
      expect(p1.grossPriceMinor).toBe(242);
      expect(p1.stockOnHand).toBe(5);
      expect(p1.stockValueMinor).toBe(1000);
      expect(p1.ordinal).toBe((yield* requiredFixtureValue(productRow(before, 'p1'))).ordinal);
      expect(variantAfter.products.filter((row) => row.id !== 'p1')).toEqual(
        after.products.filter((row) => row.id !== 'p1'),
      );
      expect(yield* headRevision(fixture)).toBe(fixture.revision + 2);
    }),
  ),
);

it.live('persistChange against a stale revision reports a conflict instead of a revision', () =>
  withMerchandise(catalogState, (fixture) =>
    Effect.gen(function* staleRevisionConflict() {
      const before = yield* rowsOf(fixture);
      const command = yield* decodeWorkingCommand({ _tag: 'ChangePrice', id: 'p3', priceMinor: 70 });
      const outcome = yield* fixture.db
        .transaction((transaction) =>
          Effect.gen(function* staleRevisionTransaction() {
            const head = yield* requiredFixtureValue(yield* loadHead(transaction, fixture.scope, { lock: true }));
            const working = yield* loadWorkingSet(transaction, fixture.scope, head, workingSetRequestOf(command, 'x'));
            const change = yield* evolveMerchandiseState(working.state, command, {
              actor,
              now,
              resourceId: 'x',
              tax: TEST_TAX,
            });
            const stale = { ...working, revision: working.revision + 7 };
            const revision = yield* persistChange(transaction, fixture.scope, stale, change.state, now, TEST_RATES, {});
            // Persistence turns `undefined` into a revision conflict, which rolls the transaction back.
            return revision ?? (yield* Effect.fail('conflict'));
          }),
        )
        .pipe(Effect.flip);
      expect(outcome).toBe('conflict');
      expect(yield* rowsOf(fixture)).toEqual(before);
    }),
  ),
);

it.live('UpdateCategory rename renames every product of the category in column and document', () => {
  const input = {
    ...catalogInput,
    products: [
      ...catalogInput.products,
      {
        ...decodeProductDocument(catalogInput.products[1]),
        category: 'Šrouby',
        categoryId: 'c',
        categoryPathIds: ['c', 'r'],
        id: 'p5',
        isSale: false,
        name: 'Šroub nerezový',
        sku: 'P5',
      },
    ],
  };
  return withMerchandise(decodeState(input), (fixture) =>
    Effect.gen(function* renameCategoryPersistence() {
      const before = yield* rowsOf(fixture);
      const { revision } = yield* runCommand(fixture, {
        _tag: 'UpdateCategory',
        id: 'c',
        patch: { name: 'Metrické šrouby' },
      });
      expect(revision).toBe(fixture.revision + 1);
      const after = yield* rowsOf(fixture);

      const category = yield* requiredFixtureValue(after.categories.find((row) => row.id === 'c'));
      expect(category.name).toBe('Metrické šrouby');
      expect(decodeCategoryHistory(category.history).length).toBe(1);
      expect(category.ordinal).toBe(
        (yield* requiredFixtureValue(before.categories.find((row) => row.id === 'c'))).ordinal,
      );
      expect(after.categories.find((row) => row.id === 'r')).toEqual(before.categories.find((row) => row.id === 'r'));

      for (const id of ['p1', 'p5']) {
        const old = yield* requiredFixtureValue(productRow(before, id));
        const renamed = yield* requiredFixtureValue(productRow(after, id));
        expect(renamed.category).toBe('Metrické šrouby');
        expect(renamed.updatedAt.toISOString()).toBe(nowIso);
        expect(renamed.document).toEqual({
          ...decodeProductDocument(old.document),
          category: 'Metrické šrouby',
          updatedAt: nowIso,
        });
        expect({ ...renamed, category: old.category, document: old.document, updatedAt: old.updatedAt }).toEqual(old);
      }
      expect(untouched(after)).toEqual(untouched(before));
      expect(after.variants).toEqual(before.variants);
      expect(after.tiers).toEqual(before.tiers);
      expect(after.movements).toEqual(before.movements);
      expect(after.orders).toEqual(before.orders);

      // The renamed documents still decode.
      const snapshot = yield* requiredFixtureValue(yield* readSnapshot(fixture.db, fixture.scope));
      expect(
        snapshot?.state.products.filter((product) => product.categoryId === 'c').map((product) => product.category),
      ).toEqual(['Metrické šrouby', 'Metrické šrouby']);
    }),
  );
});

it.live('CreateCategory grows the tree after products exist; a product moved into it is listed under its slug', () =>
  withMerchandise(decodeState(catalogInput), (fixture) =>
    Effect.gen(function* createCategoryPersistence() {
      const before = yield* rowsOf(fixture);
      const { revision } = yield* runCommand(fixture, {
        _tag: 'CreateCategory',
        id: 'nove',
        name: 'Nové šrouby',
        parentId: 'r',
        slug: 'nove-srouby',
      });
      expect(revision).toBe(fixture.revision + 1);
      const after = yield* rowsOf(fixture);
      const created = yield* requiredFixtureValue(after.categories.find((row) => row.id === 'nove'));
      expect(created.parentId).toBe('r');
      expect(created.published).toBe(true);
      expect(after.categories.length).toBe(before.categories.length + 1);
      expect(after.categories.find((row) => row.id === 'r')?.hasChildren).toBe(true);

      yield* runCommand(fixture, { _tag: 'UpdateProduct', id: 'p1', patch: { categoryId: 'nove' } });
      const moved = yield* requiredFixtureValue(productRow(yield* rowsOf(fixture), 'p1'));
      expect(moved.categoryId).toBe('nove');
      expect(moved.category).toBe('Nové šrouby');

      const listed = yield* storefrontProducts(fixture.db, fixture.scope, {
        query: Schema.decodeSync(StorefrontCatalogQuerySchema)({ categorySlug: 'nove-srouby', fields: 'card' }),
      });
      expect(listed.products.map((product) => product.id)).toEqual(['p1']);
      // The storefront navigation shows the roots and the children of the active category.
      const nodes = yield* categoryTree(fixture.db, fixture.scope, { activeId: 'r', storefront: true });
      expect(nodes.map((node) => node.id)).toContain('nove');
    }),
  ),
);

it.live('UpdateCategory without a rename leaves every product row alone', () =>
  withMerchandise(catalogState, (fixture) =>
    Effect.gen(function* updateCategoryWithoutRename() {
      const before = yield* rowsOf(fixture);
      yield* runCommand(fixture, { _tag: 'UpdateCategory', id: 'c', patch: { heading: 'Metrické šrouby DIN' } });
      const after = yield* rowsOf(fixture);
      expect(after.categories.find((row) => row.id === 'c')?.heading).toBe('Metrické šrouby DIN');
      expect(after.products).toEqual(before.products);
    }),
  ),
);

it.live('secondary membership persists through locked working sets and filters without duplicate products', () =>
  withMerchandise(withStoredGross(decodeState(richInput)), (fixture) =>
    Effect.gen(function* categoryMembershipPersistence() {
      yield* runCommand(fixture, {
        _tag: 'CreateCategory',
        id: 'secondary',
        name: 'Sport',
        parentId: null,
        slug: 'sport',
      });
      const before = yield* rowsOf(fixture);
      yield* runCommand(fixture, {
        _tag: 'UpdateProduct',
        id: 'p1',
        patch: { additionalCategoryIds: ['secondary'] },
      });
      const stored = yield* rowsOf(fixture);
      const row = yield* requiredFixtureValue(productRow(stored, 'p1'));
      expect(row.categoryId).toBe('c');
      expect(row.categoryPathIds).toEqual(['c', 'r', 'secondary']);
      expect(decodeProductDocument(row.document).additionalCategoryIds).toEqual(['secondary']);
      const snapshot = yield* requiredFixtureValue(yield* readSnapshot(fixture.db, fixture.scope));
      expect(snapshot.state.products.find((product) => product.id === 'p1')?.additionalCategoryIds).toEqual([
        'secondary',
      ]);
      const page = yield* storefrontProducts(fixture.db, fixture.scope, {
        query: Schema.decodeSync(StorefrontCatalogQuerySchema)({ categorySlug: 'sport', fields: 'card' }),
      });
      expect(page.total).toBe(1);
      expect(page.products.map((product) => product.id)).toEqual(['p1']);
      // A move with no new additional field must load and retain the stored secondary category.
      yield* runCommand(fixture, { _tag: 'UpdateProduct', id: 'p1', patch: { categoryId: 'r' } });
      const moved = yield* rowsOf(fixture);
      expect((yield* requiredFixtureValue(productRow(moved, 'p1'))).categoryPathIds).toEqual(['r', 'secondary']);
      expect(moved.variants).toEqual(before.variants);
      expect(moved.tiers).toEqual(before.tiers);
      expect(moved.movements).toEqual(before.movements);
      expect(moved.orders).toEqual(before.orders);
      yield* runCommand(fixture, { _tag: 'UpdateProduct', id: 'p1', patch: { additionalCategoryIds: [] } });
      const removed = yield* storefrontProducts(fixture.db, fixture.scope, {
        query: Schema.decodeSync(StorefrontCatalogQuerySchema)({ categorySlug: 'sport', fields: 'card' }),
      });
      expect(removed.total).toBe(0);
    }),
  ),
);

it.live('Bulk native memberships commit one scoped delta and roll back entirely on a later invalid primary', () =>
  withMerchandise(withStoredGross(decodeState(richInput)), (fixture) =>
    Effect.gen(function* bulkCategoryMembershipPersistence() {
      yield* runCommand(fixture, {
        _tag: 'CreateCategory',
        id: 'secondary',
        name: 'Sport',
        parentId: null,
        slug: 'sport',
      });
      const before = yield* rowsOf(fixture);
      // p1 has a valid primary; p2's legacy primary x is absent from the category table.
      const failure = yield* runCommand(fixture, {
        _tag: 'BulkUpdateProducts',
        ids: ['p1', 'p2'],
        patch: { additionalCategoryIds: ['secondary'] },
      }).pipe(Effect.flip);
      expect(Schema.is(MerchandiseLifecycleConflict)(failure)).toBe(true);
      expect(yield* rowsOf(fixture)).toEqual(before);
      const missingProduct = yield* runCommand(fixture, {
        _tag: 'BulkUpdateProducts',
        ids: ['p1', 'missing'],
        patch: { additionalCategoryIds: ['secondary'] },
      }).pipe(Effect.flip);
      expect(Schema.is(MerchandiseNotFound)(missingProduct)).toBe(true);
      expect(yield* rowsOf(fixture)).toEqual(before);
      const missingCategory = yield* runCommand(fixture, {
        _tag: 'BulkUpdateProducts',
        ids: ['p1', 'p3'],
        patch: { additionalCategoryIds: ['missing'] },
      }).pipe(Effect.flip);
      expect(Schema.is(MerchandiseLifecycleConflict)(missingCategory)).toBe(true);
      expect(yield* rowsOf(fixture)).toEqual(before);
      const result = yield* runCommand(fixture, {
        _tag: 'BulkUpdateProducts',
        ids: ['p1', 'p1', 'p3'],
        patch: { additionalCategoryIds: ['secondary'], categoryId: 'r' },
      });
      expect(result.revision).toBe((before.head?.revision ?? -1) + 1);
      expect(result.change.entityIds).toEqual(['p1', 'p3']);
      const after = yield* rowsOf(fixture);
      for (const id of ['p1', 'p3']) {
        const row = yield* requiredFixtureValue(productRow(after, id));
        const document = decodeProductDocument(row.document);
        expect(row.categoryId).toBe('r');
        expect(row.categoryPathIds).toEqual(['r', 'secondary']);
        expect(document.additionalCategoryIds).toEqual(['secondary']);
        expect(document.contentHistory?.at(-1)?.fields).toContain('Další kategorie');
        expect(row.currentPriceMinor).toBe((yield* requiredFixtureValue(productRow(before, id))).currentPriceMinor);
      }
      expect(after.products.filter((row) => !['p1', 'p3'].includes(row.id))).toEqual(
        before.products.filter((row) => !['p1', 'p3'].includes(row.id)),
      );
      expect(after.variants).toEqual(before.variants);
      expect(after.tiers).toEqual(before.tiers);
      expect(after.movements).toEqual(before.movements);
      expect(after.orders).toEqual(before.orders);
      const page = yield* storefrontProducts(fixture.db, fixture.scope, {
        query: Schema.decodeSync(StorefrontCatalogQuerySchema)({ categorySlug: 'sport', fields: 'card' }),
      });
      expect(page.total).toBe(2);
      expect(new Set(page.products.map((product) => product.id))).toEqual(new Set(['p1', 'p3']));
      yield* runCommand(fixture, {
        _tag: 'BulkUpdateProducts',
        ids: ['p1', 'p3'],
        patch: { categoryId: 'c' },
      });
      const moved = yield* rowsOf(fixture);
      for (const id of ['p1', 'p3']) {
        expect((yield* requiredFixtureValue(productRow(moved, id))).categoryPathIds).toEqual(['c', 'r', 'secondary']);
      }
      yield* runCommand(fixture, {
        _tag: 'BulkUpdateProducts',
        ids: ['p1', 'p3'],
        patch: { additionalCategoryIds: [] },
      });
      const removed = yield* storefrontProducts(fixture.db, fixture.scope, {
        query: Schema.decodeSync(StorefrontCatalogQuerySchema)({ categorySlug: 'sport', fields: 'card' }),
      });
      expect(removed.total).toBe(0);
    }),
  ),
);
