// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * Rollback, second half: the release before classifications takes over the database the new release wrote on. This
 * file is written against that release's code: the deploy rehearsal (`vat-deploy-rehearsal.sh`) copies it into a
 * checkout of the trunk the deploy replaces and runs it there, after `vat-reverse-new-release.test.mts` wrote its
 * report. It is not part of this branch's own test projects.
 *
 * The old release reads every product, order and ledger the new release wrote with its own decoders, rewrites each of
 * them through its own write paths (every product, the order, the ledger), and every amount stays exactly as written.
 * It sells every product and variant at the price the new release sold it at, written after Tax priced the company
 * included (N1's jacket at 10 623,80 per variant); only a variant priced at 12 % beside one stored at 10 % sells lower.
 */
import { readFileSync } from 'node:fs';

import {
  ActiveApplicationCompositionService,
  ReadRuntime,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Crypto, Effect, Layer, Redacted, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { ApplyCommandPayloadSchema } from '../../verticals/finance-billing/shared/actions/apply-command.ts';
import {
  CommandReferenceValidators,
  prepareApplyCommandServices,
} from '../../verticals/finance-billing/src/actions/apply-command.action.ts';
import { financeStates } from '../../verticals/finance-billing/src/database/schema.ts';
import { decodeFinanceState } from '../../verticals/finance-billing/src/services/finance-state-repository.ts';
import { MerchandiseCommandPayloadSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { merchandiseRelations } from '../../verticals/merchandise/src/database/schema.ts';
import { readSnapshot } from '../../verticals/merchandise/src/services/merchandise-store.ts';
import { persistenceService } from '../../verticals/merchandise/src/services/persistence.service.ts';
import { computeProductRecords } from '../../verticals/merchandise/src/services/stock-levels.ts';

const unused = () => Effect.die('Unexpected production reference transport');
const financeBoundary = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unused() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unused() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
  Layer.succeed(ReadRuntime, { runRead: unused }),
);
const uuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

it.live(
  'the release before classifications reads and rewrites everything the new release wrote, every amount kept',
  () =>
    Effect.gen(function* oldReleaseAfterRollback() {
      const report = JSON.parse(readFileSync(yield* Config.String('ONTOS_VAT_REVERSE_REPORT'), 'utf-8'));
      const { companyId, tenantId } = report;
      const connections = yield* loadDatabaseConnectionPair();
      const adminPg = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 2 });
      const runtimeDb = yield* makeTestDatabaseFromClient(
        yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 1 }),
        merchandiseRelations,
      );
      const scopeOf = (correlationId: string): OperationalScope => ({ ...report.principal, correlationId });
      const store = { legalEntityId: companyId, tenantId };

      // Every product and order decodes with this release's own schemas.
      const snapshot = yield* runtimeDb.transaction((tx) =>
        installOperationalScope(tx, scopeOf('vat-reverse-read'), defineDatabaseIdentityEnrollment([])).pipe(
          Effect.flatMap((scoped) => readSnapshot(scoped, store)),
        ),
      );
      const state = snapshot?.state;
      expect(state?.products.length).toBe(report.products.length);
      for (const written of report.products) {
        const product = state?.products.find((entry) => String(entry.id) === written.id);
        expect([written.id, product?.vatRate, product?.currentPriceMinor]).toEqual([
          written.id,
          written.rate,
          written.net,
        ]);
      }

      // What this release sells each product and variant at, with the vatRate the new release wrote: exactly what the
      // new release sold it at, and never more where its variants disagree.
      const records = computeProductRecords(state ?? { categories: [], movements: [], orders: [], products: [] });
      const sellingNow = Object.fromEntries(
        Object.keys(report.selling).map((id) => {
          const record = records.find((entry) => String(entry.id) === id);
          return [
            id,
            [
              record?.grossPriceMinor ?? null,
              ...(record?.variantRecords ?? []).map((entry) => entry.grossPriceMinor ?? null),
            ],
          ];
        }),
      );
      const lower = new Set<string>(report.sellingLowerAfterRollback);
      for (const [id, prices] of Object.entries<readonly (number | null)[]>(report.selling)) {
        if (lower.has(id)) {
          expect(sellingNow[id]?.length).toBe(prices.length);
          expect(sellingNow[id]?.every((price, index) => price !== null && price <= (prices[index] ?? 0))).toBe(true);
          expect(sellingNow[id]?.[0]).toBe(prices[0]);
        } else {
          expect([id, sellingNow[id]]).toEqual([id, prices]);
        }
      }
      expect(sellingNow['spyder-jacket']).toEqual([1_062_380, 1_062_380, 1_062_380, 1_062_380, 1_062_380, 1_062_380]);

      const revisionNow = adminPg
        .unsafe<{ readonly revision: number }>(
          'select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
          [tenantId, companyId],
        )
        .pipe(Effect.map(([head]) => head?.revision ?? 0));
      const apply = Effect.fn('VatReverse.oldApply')(function* apply(command: Schema.Json) {
        const correlationId = yield* uuid;
        const scope = scopeOf(correlationId);
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
      // It rewrites every product (an edit keeping its name) and the order the new release wrote (confirmed).
      for (const product of state?.products ?? []) {
        yield* apply({ _tag: 'UpdateProduct', id: product.id, patch: { name: product.name } });
      }
      yield* apply({ _tag: 'ChangeOrderStatus', id: report.orderId, status: 'CONFIRMED' });
      // A customer orders a jacket variant from this release: 10 623,80, as the new release charged.
      const jacketVariant = state?.products.find((entry) => String(entry.id) === 'spyder-jacket')?.variants?.[1]?.id;
      const jacketOrder = yield* apply({
        _tag: 'PlaceStorefrontOrder',
        clientRequestId: 'vat-reverse-old-jacket',
        contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
        deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' },
        lines: [
          { expectedUnitPriceMinor: 1_062_380, productId: 'spyder-jacket', quantity: 1, variantId: jacketVariant },
        ],
        shippingMethod: 'ZASILKOVNA',
      });
      const placed =
        jacketOrder !== null && typeof jacketOrder === 'object' && 'storefrontOrder' in jacketOrder
          ? jacketOrder.storefrontOrder
          : undefined;
      expect([placed?.outcome, placed?.lines.map((line) => line.unitPriceMinor)]).toEqual(['PLACED', [1_062_380]]);

      // Every amount stays exactly as the new release wrote it.
      const products = yield* adminPg.unsafe<{
        readonly gross: number | null;
        readonly id: string;
        readonly net: number;
        readonly rate: number;
      }>(
        `select id, current_price_minor::integer as net, gross_price_minor::integer as gross,
              (document ->> 'vatRate')::integer as rate
         from demo_merchandise.products where tenant_id = $1 and legal_entity_id = $2 order by id`,
        [tenantId, companyId],
      );
      expect(products).toEqual(report.products);
      const orders = yield* adminPg.unsafe<{ readonly id: string; readonly total: number }>(
        `select id, total_minor::integer as total from demo_merchandise.orders
        where tenant_id = $1 and legal_entity_id = $2 and id <> $3 order by id`,
        [tenantId, companyId, placed?.orderId ?? ''],
      );
      expect(orders).toEqual(report.orders);

      // Finance: the ledger decodes, and a write rewrites it whole; the invoice keeps its amounts.
      const reactivity = yield* Reactivity.make;
      const financeClient = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
        Effect.provideService(Reactivity.Reactivity, reactivity),
      );
      const financeDb = yield* makeWithDefaults({ relations: defineRelations({ financeStates }) }).pipe(
        Effect.provideService(PgClient.PgClient, financeClient),
      );
      const financeScope = scopeOf('vat-reverse-old-finance');
      const payload = yield* Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
        command: {
          _tag: 'UpsertPriceListItem',
          active: true,
          actorLabel: 'Staré vydání',
          name: 'Po návratu',
          unitPriceMinor: 5000,
          vatRate: 21,
        },
        expectedRevision: report.financeRevision,
      });
      const context: ActionServicePreparationContext = {
        actionInvocationId: yield* uuid,
        compositionRevision: 'vat-reverse-composition',
        scope: financeScope,
        transaction: (readFinance) =>
          financeDb
            .transaction((tx) =>
              installOperationalScope(tx, financeScope, defineDatabaseIdentityEnrollment([])).pipe(
                Effect.flatMap(readFinance),
              ),
            )
            .pipe(Effect.orDie),
      };
      const factory = yield* prepareApplyCommandServices(payload, context).pipe(
        Effect.provideService(CommandReferenceValidators, { invoice: () => Effect.void }),
      );
      const revision = yield* financeDb.transaction((tx) =>
        installOperationalScope(tx, financeScope, defineDatabaseIdentityEnrollment([])).pipe(
          Effect.flatMap((scoped) => factory(scoped, financeScope, context.compositionRevision)),
          Effect.flatMap((services) => services.save(services.prepared.transition.state, report.financeRevision)),
        ),
      );
      expect(revision).toBe(report.financeRevision + 1);
      const [row] = yield* adminPg.unsafe<{ readonly revision: number; readonly state: unknown }>(
        'select revision, state from finance_billing.finance_states where tenant_id = $1 and legal_entity_id = $2',
        [tenantId, companyId],
      );
      const { state: ledger } = yield* decodeFinanceState(row);
      const [invoice] = ledger.invoices;
      expect({
        subtotalMinor: invoice?.subtotalMinor,
        totalMinor: invoice?.totalMinor,
        vatMinor: invoice?.vatMinor,
        vatRecap: invoice?.vatRecap,
      }).toEqual(report.invoiceTotals);
      expect(invoice?.lines.map((line) => [line.vatRate, line.unitPriceMinor, line.quantity])).toEqual([
        [21, 100_000, 1],
        [12, 25_000, 2],
        [0, 5000, 1],
      ]);
      expect(ledger.recurringTemplates?.length).toBe(1);
      expect(ledger.priceList?.length).toBe(2);
      return yield* Effect.void;
    }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, financeBoundary))),
);
