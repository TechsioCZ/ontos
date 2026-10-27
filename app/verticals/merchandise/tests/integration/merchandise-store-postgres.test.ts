// Write paths of the normalized merchandise storage (merchandise-store.ts) against PostgreSQL: snapshot
// round-trip, and command writes that must touch only the rows the command changed.
import { randomUUID } from 'node:crypto';

import { asc } from 'drizzle-orm';
import { DateTime, Effect, Match, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import { StorefrontCatalogQuerySchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { OrderSchema } from '../../shared/domain/merchandise-model.ts';
import {
  catalogHeads,
  categories,
  orders,
  priceTiers,
  productVariants,
  products,
  stockMovements,
} from '../../src/database/schema.ts';
import { storefrontProducts } from '../../src/services/merchandise-queries.ts';
import {
  decodeOrderDocument,
  loadHead,
  loadWorkingSet,
  persistChange,
  readSnapshot,
  replaceSnapshot,
  whereScope,
} from '../../src/services/merchandise-store.ts';
import { isMerchandiseAiCommand } from '../../src/services/ai-changes.ts';
import { evolveMerchandiseState, workingSetRequestOf } from '../../src/services/persistence.service.ts';
import type { MerchandiseFixture } from './support/merchandise-database.ts';
import {
  at,
  catalogInput,
  catalogState,
  decodeState,
  encodeState,
  withMerchandise,
} from './support/merchandise-database.ts';

/** A missing fixture value fails the test before its fields are read. */
const requireFixture = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    expect.unreachable('The fixture must be present before its fields are read');
  }
  return value;
};

const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
const encodeOrder = Schema.encodeSync(OrderSchema);
const now = DateTime.makeUnsafe('2026-10-22T10:00:00.000Z');
const nowIso = '2026-10-22T10:00:00.000Z';
const actor = { principalId: randomUUID(), tenantId: randomUUID() };

/** Every stored row of the scope, in key order (ordinal columns included, so a re-insert shows up). */
const rowsOf = ({ db, scope }: MerchandiseFixture) =>
  Effect.gen(function* readStoredRows() {
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
const untouched = (rows: Rows) => rows.products.filter((row) => !['p1', 'p5'].includes(row.id));
const productRow = (rows: Rows, id: string) => rows.products.find((row) => row.id === id);
const othersOf = <Row extends { readonly productId: string }>(rows: readonly Row[], ids: readonly string[]) =>
  rows.filter((row) => !ids.includes(row.productId));

/** One command the way persistence runs it: locked head, working set, pure evolve, delta write. */
const runCommand = (
  fixture: MerchandiseFixture,
  input: typeof MerchandiseCommandSchema.Encoded,
  resourceId: string = randomUUID(),
) => {
  const command = decodeCommand(input);
  if (isMerchandiseAiCommand(command) || Predicate.isTagged(command, 'ResetDemoData')) {
    expect.unreachable('The fixture command must use the ordinary merchandise transition');
  }
  return fixture.db.transaction((transaction) =>
    Effect.gen(function* executeFixtureCommand() {
      const head = yield* loadHead(transaction, fixture.scope, { lock: true });
      if (head === undefined) {
        return yield* Effect.die('missing head');
      }
      const working = yield* loadWorkingSet(transaction, fixture.scope, head, workingSetRequestOf(command, resourceId));
      const change = yield* evolveMerchandiseState(working.state, command, { actor, now, resourceId });
      const revision =
        change.state === working.state
          ? working.revision
          : yield* persistChange(transaction, fixture.scope, working, change.state, now);
      return { change, revision, working };
    }),
  );
};

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
    Match.value(product).pipe(
      Match.when({ id: 'p1' }, (matched) => ({
        ...matched,
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
      Match.when({ id: 'p3' }, (matched) => ({
        ...matched,
        featuredPosition: 2,
        isNew: true,
        slug: 'matice',
        stockTracked: false,
      })),
      Match.when({ id: 'p4' }, (matched) => ({
        ...matched,
        active: false,
        demoArchive: { actor: requireFixture(catalogInput.orders[1].demoCleanup).actor, at, reason: 'Konec ukázky' },
      })),
      Match.orElse((unmodified) => unmodified),
    ),
  ),
};

it.live('readSnapshot returns exactly what replaceSnapshot wrote', () => {
  const state = decodeState(richInput);
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* merchandiseScenario1() {
      expect(fixture.revision).toBe(0);
      const snapshot = yield* readSnapshot(fixture.db, fixture.scope);
      expect(snapshot?.revision).toBe(0);
      expect(encodeState(requireFixture(snapshot).state)).toEqual(encodeState(state));
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
      expect('variants' in Schema.decodeUnknownSync(Schema.JsonObject)(productRow(rows, 'p1')?.document)).toBe(false);
      expect('priceTiers' in Schema.decodeUnknownSync(Schema.JsonObject)(productRow(rows, 'p1')?.document)).toBe(false);
      expect('priceTiers' in Schema.decodeUnknownSync(Schema.JsonObject)(rows.variants[0]?.document)).toBe(false);
      expect(productRow(rows, 'p3')?.stockOnHand).toBe(3);
      expect(productRow(rows, 'p4')?.archived).toBe(true);
    }),
  );
});

it.live('replaceSnapshot replaces the whole company and advances the revision', () =>
  withMerchandise(decodeState(richInput), (fixture) =>
    Effect.gen(function* merchandiseScenario2() {
      const smaller: MerchandiseState = {
        ...catalogState,
        movements: [],
        orders: [],
        products: catalogState.products.slice(1, 2),
      };
      const revision = yield* fixture.db.transaction((transaction) =>
        replaceSnapshot(transaction, fixture.scope, smaller),
      );
      expect(revision).toBe(1);
      const snapshot = yield* readSnapshot(fixture.db, fixture.scope);
      expect(snapshot?.revision).toBe(1);
      expect(encodeState(requireFixture(snapshot).state)).toEqual(encodeState(smaller));
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
    Effect.gen(function* merchandiseScenario3() {
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
      const [placed] = after.orders.slice(2);
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
      const stored = decodeOrderDocument(placed.document);
      expect(stored.billingAddress).toEqual(command.billingAddress);
      expect(stored.deliveryRecipient).toEqual(command.deliveryRecipient);
      expect(stored.contact).toEqual(command.contact);
      const snapshot = yield* readSnapshot(fixture.db, fixture.scope);
      expect(snapshot?.state.orders.find((order) => order.id === orderId)?.billingAddress).toEqual(
        command.billingAddress,
      );
      expect(snapshot?.state.orders.find((order) => order.id === orderId)?.deliveryRecipient).toEqual(
        command.deliveryRecipient,
      );
      const created = requireFixture(change.state.orders.find((order) => order.id === orderId));
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
      const p1Before = requireFixture(productRow(before, 'p1'));
      const p1After = requireFixture(productRow(after, 'p1'));
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
        query: Schema.decodeSync(StorefrontCatalogQuerySchema)({ fields: 'card', productIds: ['p1'] }),
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
    Effect.gen(function* merchandiseScenario4() {
      const before = yield* rowsOf(fixture);
      const { revision } = yield* runCommand(fixture, { _tag: 'ChangePrice', id: 'p2', priceMinor: 100 });
      expect(revision).toBe(fixture.revision + 1);
      const after = yield* rowsOf(fixture);

      const p2Before = requireFixture(productRow(before, 'p2'));
      const p2After = requireFixture(productRow(after, 'p2'));
      expect(p2After.currentPriceMinor).toBe(100);
      expect(p2After.grossPriceMinor).toBe(121);
      expect(p2After.ordinal).toBe(p2Before.ordinal);
      expect(p2After.createdAt).toEqual(p2Before.createdAt);
      expect(p2After.updatedAt.toISOString()).toBe(nowIso);
      const storedDocument = Schema.decodeUnknownSync(Schema.JsonObject)(p2After.document);
      const document = Schema.decodeUnknownSync(
        Schema.Struct({
          currentPriceMinor: Schema.Number,
          priceHistory: Schema.Array(Schema.Json),
          updatedAt: Schema.DateTimeUtcFromString,
        }),
      )(storedDocument);
      expect(document.currentPriceMinor).toBe(100);
      expect(document.priceHistory.length).toBe(1);
      expect(storedDocument.updatedAt).toBe(nowIso);
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
      const v1 = requireFixture(variantAfter.variants.find((row) => row.variantId === 'v1'));
      expect(v1.priceMinor).toBe(200);
      expect(v1.grossPriceMinor).toBe(242);
      expect(v1.stockOnHand).toBe(5);
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ priceHistory: Schema.optionalKey(Schema.Array(Schema.Json)) }))(
          v1.document,
        ).priceHistory?.length,
      ).toBe(1);
      const p1 = requireFixture(productRow(variantAfter, 'p1'));
      expect(p1.grossPriceMinor).toBe(242);
      expect(p1.stockOnHand).toBe(5);
      expect(p1.stockValueMinor).toBe(1000);
      expect(p1.ordinal).toBe(requireFixture(productRow(before, 'p1')).ordinal);
      expect(variantAfter.products.filter((row) => row.id !== 'p1')).toEqual(
        after.products.filter((row) => row.id !== 'p1'),
      );
      expect(yield* headRevision(fixture)).toBe(fixture.revision + 2);
    }),
  ),
);

it.live('persistChange against a stale revision reports a conflict instead of a revision', () =>
  withMerchandise(catalogState, (fixture) =>
    Effect.gen(function* merchandiseScenario5() {
      const before = yield* rowsOf(fixture);
      const command = decodeCommand({ _tag: 'ChangePrice', id: 'p3', priceMinor: 70 });
      if (isMerchandiseAiCommand(command) || Predicate.isTagged(command, 'ResetDemoData')) {
        expect.unreachable('The fixture command must use the ordinary merchandise transition');
      }
      const outcome = yield* fixture.db
        .transaction((transaction) =>
          Effect.gen(function* persistStaleRevision() {
            const head = requireFixture(yield* loadHead(transaction, fixture.scope, { lock: true }));
            const working = yield* loadWorkingSet(transaction, fixture.scope, head, workingSetRequestOf(command, 'x'));
            const change = yield* evolveMerchandiseState(working.state, command, { actor, now, resourceId: 'x' });
            const stale = { ...working, revision: working.revision + 7 };
            const revision = yield* persistChange(transaction, fixture.scope, stale, change.state, now);
            // Persistence turns `undefined` into a revision conflict, which rolls the transaction back.
            return revision ?? (yield* Effect.fail('conflict' as const));
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
        ...catalogInput.products[1],
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
    Effect.gen(function* merchandiseScenario6() {
      const before = yield* rowsOf(fixture);
      const { revision } = yield* runCommand(fixture, {
        _tag: 'UpdateCategory',
        id: 'c',
        patch: { name: 'Metrické šrouby' },
      });
      expect(revision).toBe(fixture.revision + 1);
      const after = yield* rowsOf(fixture);

      const category = requireFixture(after.categories.find((row) => row.id === 'c'));
      expect(category.name).toBe('Metrické šrouby');
      expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(category.history).length).toBe(1);
      expect(category.ordinal).toBe(requireFixture(before.categories.find((row) => row.id === 'c')).ordinal);
      expect(after.categories.find((row) => row.id === 'r')).toEqual(before.categories.find((row) => row.id === 'r'));

      for (const id of ['p1', 'p5']) {
        const old = requireFixture(productRow(before, id));
        const renamed = requireFixture(productRow(after, id));
        expect(renamed.category).toBe('Metrické šrouby');
        expect(renamed.updatedAt.toISOString()).toBe(nowIso);
        expect(renamed.document).toEqual({
          ...Schema.decodeUnknownSync(Schema.JsonObject)(old.document),
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
      const snapshot = yield* readSnapshot(fixture.db, fixture.scope);
      expect(
        snapshot?.state.products.filter((product) => product.categoryId === 'c').map((product) => product.category),
      ).toEqual(['Metrické šrouby', 'Metrické šrouby']);
    }),
  );
});

it.live('UpdateCategory without a rename leaves every product row alone', () =>
  withMerchandise(catalogState, (fixture) =>
    Effect.gen(function* merchandiseScenario7() {
      const before = yield* rowsOf(fixture);
      yield* runCommand(fixture, { _tag: 'UpdateCategory', id: 'c', patch: { heading: 'Metrické šrouby DIN' } });
      const after = yield* rowsOf(fixture);
      expect(after.categories.find((row) => row.id === 'c')?.heading).toBe('Metrické šrouby DIN');
      expect(after.products).toEqual(before.products);
    }),
  ),
);
