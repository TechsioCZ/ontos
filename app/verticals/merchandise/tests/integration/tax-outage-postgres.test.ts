// Merchandise while Tax does not answer, on PostgreSQL through the real read runtime and the owner's write path. The
// company's rates were confirmed by Tax 30 hours ago and Tax is down now:
// - staff reads answer from the materialised rates (with the time Tax confirmed them), never fail and never wait;
// - an order edit that touches only existing lines needs no Tax;
// - a new order line or a new product price is refused with a clear reason, because the confirmation is too old;
// - with rates Tax confirmed 2 hours ago the same new price is stored;
// - with no rates stored at all a new price is refused too, and the staff read says the company has no rates.
import { randomUUID } from 'node:crypto';

import { defineDatabaseIdentityEnrollment, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import type { RecordsRequestEncoded } from '../../shared/apis/records.ts';
import { recordsRead } from '../../src/api/records.read.ts';
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
import { CompanyTaxRatesSchema, TaxRateSource, TaxRatesFailure } from '../../src/services/tax-rates.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { TEST_RATES, TEST_TAX_BOOK } from '../support/tax-fixtures.ts';
import { catalogState } from './support/merchandise-database.ts';

const companyOf = (principal: TrustedPrincipalContext): Effect.Effect<StoreScope> =>
  principal.legalEntityId === undefined
    ? Effect.die('The native fixture principal names no company')
    : Effect.succeed({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId });

/** The readable reason of a refused write. */
const conflictReason = (outcome: Effect.Effect<unknown, unknown>) =>
  outcome.pipe(
    Effect.flip,
    Effect.map((failure) => Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }))(failure).reason),
  );

const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
const nativeMerchandise = makeNativeReadTestContext({
  accessDecision: gate.bound,
  contextPermissions: [],
  moduleId: 'demo.merchandise',
  ownerFixtureRetention: 'retain-complete-context',
}).pipe(Effect.provideService(NativeReadTestOwnerRegistration, merchandiseRegistration));

it.live('Merchandise keeps working while Tax is down, and prices nothing new on rates confirmed too long ago', () =>
  Effect.scoped(
    Effect.gen(function* taxOutage() {
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
      yield* admin.transaction((tx) => replaceSnapshot(tx, company, catalogState, TEST_RATES));
      const confirmedHoursAgo = Effect.fn('TaxOutage.confirmed')(function* confirmedHoursAgo(hours: number) {
        const syncedAt = DateTime.subtract(yield* DateTime.now, { hours });
        const taxRates = yield* Schema.encodeEffect(CompanyTaxRatesSchema)({
          book: TEST_TAX_BOOK,
          source: 'TAX',
          syncedAt,
        });
        yield* admin.update(catalogHeads).set({ taxRates }).where(whereScope(catalogHeads, company));
        return syncedAt;
      });
      const confirmedAt = yield* confirmedHoursAgo(30);

      // Tax is down for the whole scenario; every call is counted.
      const calls = yield* Ref.make(0);
      const source = {
        read: () =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(new TaxRatesFailure({ kind: 'UNAVAILABLE' }))),
          ),
      };
      const read = (input: RecordsRequestEncoded) =>
        native.runtime
          .runRead({
            input,
            principal: native.principal,
            registration: recordsRead,
            transport: { correlationId: 'tax-outage' },
          })
          .pipe(
            Effect.provide(native.layer),
            Effect.provideService(AccessDecisionGate, gate.accessDecision),
            Effect.provideService(TaxRateSource, source),
          );
      const staff = yield* read({ view: { ordersLimit: 10, summary: true } });
      expect(staff.taxRates?.map((rate) => [rate.code, rate.ratePercent])).toEqual([
        ['cz.vat.standard', 21],
        ['cz.vat.reduced', 12],
      ]);
      expect(staff.sellerVatRegime).toBe('VAT_PAYER');
      expect(staff.taxRatesConfirmedAt).toEqual(confirmedAt);
      expect(staff.taxRatesSource).toBe('TAX');

      const apply = Effect.fn('TaxOutage.apply')(function* apply(
        command: typeof MerchandiseCommandPayloadSchema.Encoded.command,
        expectedRevision: number,
      ) {
        const payload = Schema.decodeSync(MerchandiseCommandPayloadSchema)({ command, expectedRevision });
        const scope = { ...native.principal, correlationId: `tax-outage-${randomUUID()}` };
        const tax = yield* prepareCommandTax(payload.command, scope).pipe(Effect.provideService(TaxRateSource, source));
        return yield* runtime.transaction((tx) =>
          installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(
            Effect.flatMap((scoped) =>
              persistenceService(scoped, {
                prepared: { actionInvocationId: scope.correlationId, payload, tax },
                scope,
              }),
            ),
            Effect.flatMap((services) => services.apply(payload.command, expectedRevision, scope.correlationId)),
          ),
        );
      });
      // An edit of the existing line only: no Tax needed, the stored rate and price stay.
      const edited = yield* apply(
        { _tag: 'EditOrder', id: 'o1', lines: [{ productId: 'p1', quantity: 2 }] },
        staff.revision,
      );
      const [order] = yield* admin
        .select()
        .from(orders)
        .where(and(whereScope(orders, company), eq(orders.id, 'o1')));
      expect(
        order === undefined
          ? undefined
          : Schema.decodeUnknownSync(
              Schema.Struct({
                lines: Schema.Array(
                  Schema.Struct({ quantity: Schema.Number, unitPriceMinor: Schema.Number, vatRate: Schema.Number }),
                ),
              }),
            )(order.document).lines,
      ).toEqual([{ quantity: 2, unitPriceMinor: 100, vatRate: 21 }]);
      // Stock for the line about to be added (a stock movement needs no Tax either).
      const stocked = yield* apply(
        { _tag: 'RecordStockMovement', delta: 5, productId: 'p3', reason: 'RECEIPT' },
        edited.revision,
      );
      // A new line and a new product price need a current rate: Tax is down and its confirmation is 30 hours old.
      expect(
        yield* conflictReason(
          apply(
            {
              _tag: 'EditOrder',
              id: 'o1',
              lines: [
                { productId: 'p1', quantity: 2 },
                { productId: 'p3', quantity: 1 },
              ],
            },
            stocked.revision,
          ),
        ),
      ).toContain('starší než 24 hodin');
      const newProduct = {
        _tag: 'CreateProduct',
        active: true,
        category: 'Šrouby',
        lowStockThreshold: 0,
        name: 'Nový šroub',
        priceMinor: 1000,
        sku: `NEW-${randomUUID().slice(0, 8)}`,
        taxClassificationCode: 'cz.vat.standard',
        unit: 'ks',
      } as const;
      expect(yield* conflictReason(apply(newProduct, stocked.revision))).toContain('starší než 24 hodin');
      // Confirmed 2 hours ago: the same price is stored at the confirmed rate.
      yield* confirmedHoursAgo(2);
      const created = yield* apply(newProduct, stocked.revision);
      const [stored] = yield* admin
        .select()
        .from(products)
        .where(whereScope(products, company))
        .pipe(Effect.map((rows) => rows.filter((row) => row.sku === newProduct.sku)));
      expect([created.revision > stocked.revision, stored?.grossPriceMinor]).toEqual([true, 1210]);
      // No rates stored at all and Tax still down: a new price is refused instead of being stored without its gross,
      // and the staff read says the company has no rates (no source) rather than calling them unconfirmed.
      yield* admin.update(catalogHeads).set({ taxRates: null }).where(whereScope(catalogHeads, company));
      const bare = yield* read({ view: { ordersLimit: 10, summary: true } });
      expect([bare.taxRates, bare.taxRatesSource, bare.taxRatesConfirmedAt]).toEqual([[], null, null]);
      expect(
        yield* conflictReason(apply({ ...newProduct, sku: `NEW-${randomUUID().slice(0, 8)}` }, bare.revision)),
      ).toContain('firma zatím nemá žádné sazby DPH');
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
