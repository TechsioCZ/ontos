// Prices stored without their gross, and a company Tax refuses after it was in charge, on PostgreSQL through the real
// read runtime and the owner's write path:
// - a price stored without a gross gets it from the next staff read or write once a rate is usable, even when Tax's
//   answer did not change; a stored gross is never touched;
// - Tax refusing a company it was in charge of prices a new product at the rates Tax confirmed while that is recent,
//   and refuses the price once the confirmation is older than 24 hours; it never stores one without its gross.
import { randomUUID } from 'node:crypto';

import { defineDatabaseIdentityEnrollment, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
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
import { persistenceService } from '../../src/services/persistence.service.ts';
import type { PreparedTax } from '../../src/services/persistence.service.ts';
import { CompanyTaxRatesSchema, TaxRateSource, currentTaxRateBook } from '../../src/services/tax-rates.ts';
import type { FetchedTaxRates } from '../../src/services/tax-rates.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { TEST_PRICING, TEST_TAX_BOOK } from '../support/tax-fixtures.ts';
import { catalogState } from './support/merchandise-database.ts';

const companyOf = (principal: TrustedPrincipalContext): Effect.Effect<StoreScope> =>
  principal.legalEntityId === undefined
    ? Effect.die('The native fixture principal names no company')
    : Effect.succeed({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId });

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

/** A new standard-rated product priced at 10 Kč net. */
const newProduct = (sku: string) =>
  ({
    _tag: 'CreateProduct',
    active: true,
    category: 'Šrouby',
    lowStockThreshold: 0,
    name: 'Nový šroub',
    priceMinor: 1000,
    sku,
    taxClassificationCode: 'cz.vat.standard',
    unit: 'ks',
  }) as const;

/** Tax refuses the company (as prepared before the owner transaction opened). */
const REFUSED: PreparedTax = { fetched: Option.getOrUndefined(Option.none<FetchedTaxRates>()), refused: true };

it.live(
  'missing gross prices are filled once a rate is usable; Tax refusing after it was in charge prices nothing without a gross',
  () =>
    Effect.scoped(
      Effect.gen(function* missingGross() {
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
        const confirmedHoursAgo = Effect.fn('MissingGross.confirmed')(function* confirmedHoursAgo(hours: number) {
          const taxRates = yield* Schema.encodeEffect(CompanyTaxRatesSchema)({
            book: TEST_TAX_BOOK,
            source: 'TAX',
            syncedAt: DateTime.subtract(yield* DateTime.now, { hours }),
          });
          yield* admin.update(catalogHeads).set({ taxRates }).where(whereScope(catalogHeads, company));
        });
        const grossOf = (id: string) =>
          admin
            .select({ gross: products.grossPriceMinor })
            .from(products)
            .where(and(whereScope(products, company), eq(products.id, id)))
            .pipe(Effect.map(([row]) => row?.gross));
        const dropGross = (id: string) =>
          admin
            .update(products)
            .set({ grossPriceMinor: null })
            .where(and(whereScope(products, company), eq(products.id, id)));
        const source = { read: () => Effect.succeed(TEST_TAX_BOOK) };
        const read = (input: RecordsRequestEncoded) =>
          native.runtime
            .runRead({
              input,
              principal: native.principal,
              registration: recordsRead,
              transport: { correlationId: 'missing-gross' },
            })
            .pipe(
              Effect.provide(native.layer),
              Effect.provideService(AccessDecisionGate, gate.accessDecision),
              Effect.provideService(TaxRateSource, source),
            );
        const apply = Effect.fn('MissingGross.apply')(function* apply(
          command: typeof MerchandiseCommandPayloadSchema.Encoded.command,
          expectedRevision: number,
          tax: PreparedTax,
        ) {
          const payload = Schema.decodeSync(MerchandiseCommandPayloadSchema)({ command, expectedRevision });
          const scope = { ...native.principal, correlationId: `missing-gross-${randomUUID()}` };
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

        // Tax confirmed the rates a minute ago and answers the same now (this process has its answer).
        yield* confirmedHoursAgo(0.02);
        yield* currentTaxRateBook({ ...native.principal, correlationId: 'missing-gross' }).pipe(
          Effect.provideService(TaxRateSource, source),
        );
        const nutGross = yield* grossOf('p3');
        const revisionNow = admin
          .select({ revision: catalogHeads.revision })
          .from(catalogHeads)
          .where(whereScope(catalogHeads, company))
          .pipe(Effect.map(([row]) => row?.revision ?? 0));
        // The washer was stored without a gross. The read that stores Tax's (unchanged) answer fills it: 50 net at 21 %
        // is 61 with VAT; the nut's stored gross is untouched, and readers see a new revision.
        yield* dropGross('p2');
        const before = yield* revisionNow;
        const filled = yield* read({ view: { ordersLimit: 0, summary: true } });
        expect([yield* grossOf('p2'), yield* grossOf('p3'), filled.revision > before]).toEqual([61, nutGross, true]);
        // A read with nothing to store fills it too (when no writer holds the company).
        yield* dropGross('p2');
        const again = yield* read({ view: { ordersLimit: 0, summary: true } });
        expect([yield* grossOf('p2'), again.revision > filled.revision]).toEqual([61, true]);

        // A write fills it as well, though Tax's answer did not change.
        yield* dropGross('p2');
        const answered: PreparedTax = {
          fetched: { book: TEST_TAX_BOOK, fetchedAt: yield* DateTime.now },
          refused: false,
        };
        yield* apply(
          { _tag: 'RecordStockMovement', delta: 1, productId: 'p3', reason: 'RECEIPT' },
          again.revision,
          answered,
        );
        expect(yield* grossOf('p2')).toBe(61);

        // Tax now refuses the company it was in charge of. Confirmed 2 hours ago: a new price is priced at those rates.
        yield* confirmedHoursAgo(2);
        const [head] = yield* admin.select().from(catalogHeads).where(whereScope(catalogHeads, company));
        const recentSku = `NEW-${randomUUID().slice(0, 8)}`;
        const created = yield* apply(newProduct(recentSku), head?.revision ?? 0, REFUSED);
        const [stored] = yield* admin
          .select()
          .from(products)
          .where(and(whereScope(products, company), eq(products.sku, recentSku)));
        expect(stored?.grossPriceMinor).toBe(1210);
        // Confirmed 30 hours ago: the price is refused, never stored without its gross.
        yield* confirmedHoursAgo(30);
        expect(
          yield* conflictReason(apply(newProduct(`NEW-${randomUUID().slice(0, 8)}`), created.revision, REFUSED)),
        ).toContain('starší než 24 hodin');
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);
