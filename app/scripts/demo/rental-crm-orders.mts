import { CrmCommandSchema } from '../../verticals/crm/shared/actions/apply-command.ts';
import { Console, DateTime, Effect, Schema } from 'effect';

import { EntityIdSchema, ShortTextSchema } from '../../verticals/crm/shared/domain/common.ts';

import { demoId } from './fixture-ids.mts';
import { DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';

const source = 'Správa pronájmů';
const clients = [
  { amount: '24000.00', key: 'siampark-kavarna-nabrezi' },
  { amount: '18500.00', key: 'siampark-ak-horak' },
  { amount: '42000.00', key: 'siampark-fyzio-pohyb' },
] as const;
const Records = Schema.Struct({
  revision: Schema.Int,
  state: Schema.Struct({
    clients: Schema.Struct({
      items: Schema.Array(Schema.Struct({ id: Schema.toEncoded(EntityIdSchema), name: Schema.String })),
    }),
    imports: Schema.Struct({
      customerLinks: Schema.Array(
        Schema.Struct({
          clientId: Schema.toEncoded(EntityIdSchema),
          externalCustomerId: ShortTextSchema,
          source: Schema.String,
        }),
      ),
      orders: Schema.Array(
        Schema.Struct({
          amount: Schema.optionalKey(Schema.String),
          clientId: Schema.optionalKey(Schema.toEncoded(EntityIdSchema)),
          currency: Schema.optionalKey(Schema.String),
          externalId: ShortTextSchema,
          pairing: Schema.String,
          source: Schema.String,
        }),
      ),
    }),
  }),
});
const command = Schema.toEncoded(CrmCommandSchema);
const header =
  'zdroj;id_objednavky;cislo_objednavky;datum_objednavky;id_zakaznika;nazev_zakaznika;castka;mena;stav;cas_udalosti;id_udalosti';
const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;

export const rentalCrmOrderPlan = (asOf: Date) =>
  Array.from({ length: 4 }, (_, index) => {
    const month = DateTime.subtract(DateTime.startOf(DateTime.makeUnsafe(asOf), 'month'), { months: 3 - index });
    const period = DateTime.formatIsoDateUtc(month).slice(0, 7);
    return clients.map(({ amount, key }, position) => ({
      amount,
      clientId: demoId('crm.client', key),
      externalId: `NAJ-${period}-${position + 1}`,
      orderedOn: `${period}-${String(index === 3 ? Math.min(DateTime.toPartsUtc(DateTime.makeUnsafe(asOf)).day, 3 + position * 6) : 3 + position * 6).padStart(2, '0')}`,
    }));
  }).flat();

/** Read-only prerequisite check, before the rental seed performs any business write. */
export const preflightRentalCrmOrders = (client: SeedClient, asOf: Date) =>
  Effect.gen(function* checkOrderPrerequisites() {
    const snapshot = yield* client.read('crm', Records);
    for (const spec of rentalCrmOrderPlan(asOf)) {
      if (!snapshot.state.clients.items.some((item) => item.id === spec.clientId)) {
        return yield* new DemoSeedError({ reason: 'Seed the Siampark CRM clients before rental orders.' });
      }
      const links = snapshot.state.imports.customerLinks.filter(
        (link) => link.source === source && link.externalCustomerId === spec.clientId,
      );
      const orders = snapshot.state.imports.orders.filter(
        (order) => order.source === source && order.externalId === spec.externalId,
      );
      if (
        links.length > 1 ||
        (links[0] !== undefined && links[0].clientId !== spec.clientId) ||
        orders.length > 1 ||
        (orders[0] !== undefined &&
          (orders[0].amount !== spec.amount ||
            orders[0].currency !== 'CZK' ||
            orders[0].pairing !== 'paired' ||
            orders[0].clientId !== spec.clientId))
      ) {
        return yield* new DemoSeedError({
          reason: `Rental order ${spec.externalId} conflicts with existing data; no overwrite performed.`,
        });
      }
    }
    return snapshot;
  });

/** The demo source goes through the same CSV import and approved customer links as a staff import. */
export const seedRentalCrmOrders = (client: SeedClient, asOf: Date) =>
  Effect.gen(function* seedOrders() {
    let snapshot = yield* preflightRentalCrmOrders(client, asOf);
    const plan = rentalCrmOrderPlan(asOf);
    for (const clientId of new Set(plan.map((order) => order.clientId))) {
      if (!snapshot.state.clients.items.some((item) => item.id === clientId)) {
        return yield* new DemoSeedError({
          reason: 'Seed the Siampark CRM clients before rental orders; no client is invented by the order seed.',
        });
      }
      const links = snapshot.state.imports.customerLinks.filter(
        (link) => link.source === source && link.externalCustomerId === clientId,
      );
      if (links.length > 1 || (links[0] !== undefined && links[0].clientId !== clientId)) {
        return yield* new DemoSeedError({ reason: 'Conflicting rental order customer link; no overwrite performed.' });
      }
      if (links.length === 0) {
        yield* client.apply(
          'crm',
          command,
          { _tag: 'LinkExternalCustomer', clientId, externalCustomerId: clientId, source },
          snapshot.revision,
        );
        snapshot = yield* client.read('crm', Records);
      }
    }
    const rows: string[] = [];
    for (const spec of plan) {
      const existing = snapshot.state.imports.orders.filter(
        (order) => order.source === source && order.externalId === spec.externalId,
      );
      if (existing.length > 1) {
        return yield* new DemoSeedError({ reason: 'Duplicate rental order source identity.' });
      }
      if (existing[0] !== undefined) {
        if (
          existing[0].amount !== spec.amount ||
          existing[0].currency !== 'CZK' ||
          existing[0].pairing !== 'paired' ||
          existing[0].clientId !== spec.clientId
        ) {
          return yield* new DemoSeedError({
            reason: `Rental order ${spec.externalId} diverged; no overwrite performed.`,
          });
        }
        continue;
      }
      const customer = snapshot.state.clients.items.find((item) => item.id === spec.clientId);
      if (customer === undefined) {
        return yield* new DemoSeedError({ reason: 'Rental order customer disappeared.' });
      }
      rows.push(
        [
          source,
          spec.externalId,
          spec.externalId,
          spec.orderedOn,
          spec.clientId,
          customer.name,
          spec.amount,
          'CZK',
          'Potvrzená',
          `${spec.orderedOn}T08:00:00Z`,
          `${spec.externalId}-confirmed`,
        ]
          .map(csvCell)
          .join(';'),
      );
    }
    if (rows.length > 0) {
      yield* client.apply(
        'crm',
        command,
        {
          _tag: 'ImportOrdersCsv',
          csv: [header, ...rows].join('\n'),
          fileName: `objednavky-pronajmu-${DateTime.formatIsoDateUtc(DateTime.makeUnsafe(asOf)).slice(0, 7)}.csv`,
        },
        snapshot.revision,
      );
    }
    yield* Console.log(
      `Rental CRM orders ready: ${plan.length}; imported ${rows.length} missing orders, including the current month.`,
    );
    return rows.length;
  });
