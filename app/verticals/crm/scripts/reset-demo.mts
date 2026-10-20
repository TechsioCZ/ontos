// Sales-demo owner seed for demo.crm.
// Contract: app/scripts/demo/reset-demo.mts spawns this script with `--sales-demo`, DATABASE_ADMIN_URL
// and DEMO_RESET_PROFILE=sales in the environment, in a fixed owner order. IDs come from demoId() in
// app/scripts/demo/fixture-ids.mts; this script writes only the crm state row of the demo tenant.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { demoId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { CrmStateSchema } from '../shared/apis/records.ts';
import { crmRelations, crmStates } from '../src/database/schema.ts';
import { seedVisits } from './seed/visits.mts';
import { seedImports } from '../shared/imports/demo-seed.ts';

class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

/** CRM demo company "Velkoobchod Hanák s.r.o." (fixed identity, see BRIEF). */
export const crmLegalEntityId = '71000000-0000-4000-8000-000000000022';
const seedPrincipal = demoId('core.principal', 'hanak-spravce');

/** Salespeople; principal ids match the companies lane personas (scripts/demo/permissions.mts). */
const SALESPEOPLE = [
  {
    active: true,
    email: 'obchodnik.a@hanak.demo',
    id: demoId('crm.salesperson', 'a'),
    name: 'Jan Novák',
    phone: '+420 602 111 222',
    principalId: demoId('core.principal', 'hanak-obchodnik-a'),
  },
  {
    active: true,
    email: 'obchodnik.b@hanak.demo',
    id: demoId('crm.salesperson', 'b'),
    name: 'Petra Svobodová',
    phone: '+420 603 333 444',
    principalId: demoId('core.principal', 'hanak-obchodnik-b'),
  },
] as const;
const [repA, repB] = SALESPEOPLE;

interface ClientSeed {
  readonly key: string;
  readonly name: string;
  readonly regNo?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly owner?: string;
  readonly contacts: readonly {
    readonly name: string;
    readonly role?: string;
    readonly email?: string;
    readonly phone?: string;
  }[];
}

/** Synthetic companies (fictional; IČO-like numbers are not real registrations). */
const CLIENTS: readonly ClientSeed[] = [
  {
    address: 'Masarykova 12, Brno',
    contacts: [
      { email: 'jirina.mala@pekarna-mala.demo', name: 'Jiřina Malá', phone: '+420 731 100 201', role: 'Majitelka' },
      { email: 'nakup@pekarna-mala.demo', name: 'Tomáš Veselý', role: 'Nákupčí' },
    ],
    email: 'info@pekarna-mala.demo',
    key: 'pekarna-mala',
    name: 'Pekárna Malá s.r.o.',
    owner: repA.id,
    phone: '+420 541 100 200',
    regNo: '90000101',
  },
  {
    address: 'Nádražní 5, Olomouc',
    contacts: [
      {
        email: 'k.dvorak@restaurace-u-zlate-husy.demo',
        name: 'Karel Dvořák',
        phone: '+420 732 200 301',
        role: 'Provozní',
      },
    ],
    email: 'objednavky@restaurace-u-zlate-husy.demo',
    key: 'zlata-husa',
    name: 'Restaurace U Zlaté husy',
    owner: repA.id,
    phone: '+420 585 200 300',
    regNo: '90000102',
  },
  {
    address: 'Palackého 44, Prostějov',
    contacts: [{ name: 'Eva Černá', role: 'Vedoucí prodejny' }],
    email: 'prodejna@potraviny-cerna.demo',
    key: 'potraviny-cerna',
    name: 'Potraviny Černá',
    owner: repA.id,
    phone: '+420 582 300 400',
    regNo: '90000103',
  },
  {
    address: 'Hlavní 1, Vyškov',
    contacts: [],
    email: 'recepce@hotel-podhradi.demo',
    key: 'hotel-podhradi',
    name: 'Hotel Podhradí a.s.',
    owner: repA.id,
    phone: '+420 517 400 500',
    regNo: '90000104',
  },
  {
    address: 'Školní 8, Blansko',
    contacts: [{ email: 'jidelna@zs-blansko.demo', name: 'Marie Horáková', role: 'Vedoucí jídelny' }],
    email: 'jidelna@zs-blansko.demo',
    key: 'zs-blansko',
    name: 'Školní jídelna ZŠ Blansko',
    owner: repA.id,
    regNo: '90000105',
  },
  {
    address: 'Okružní 3, Kroměříž',
    contacts: [],
    key: 'kavarna-na-rohu',
    name: 'Kavárna Na Rohu',
    owner: repA.id,
    phone: '+420 573 500 600',
  },
  {
    address: 'Průmyslová 20, Zlín',
    contacts: [
      { email: 'p.kral@bistro-kral.demo', name: 'Petr Král', phone: '+420 733 600 701', role: 'Jednatel' },
      { name: 'Lucie Králová', role: 'Účetní' },
    ],
    email: 'bistro@bistro-kral.demo',
    key: 'bistro-kral',
    name: 'Bistro Král s.r.o.',
    owner: repB.id,
    phone: '+420 577 600 700',
    regNo: '90000107',
  },
  {
    address: 'Zámecká 2, Uherské Hradiště',
    contacts: [{ name: 'Ondřej Šťastný', role: 'Šéfkuchař' }],
    email: 'kuchyne@zamecka-restaurace.demo',
    key: 'zamecka-restaurace',
    name: 'Zámecká restaurace',
    owner: repB.id,
    phone: '+420 572 700 800',
    regNo: '90000108',
  },
  {
    address: 'Tržní 15, Hodonín',
    contacts: [],
    email: 'info@minimarket-hodonin.demo',
    key: 'minimarket-hodonin',
    name: 'Minimarket Hodonín',
    owner: repB.id,
    regNo: '90000109',
  },
  {
    address: 'Lázeňská 9, Luhačovice',
    contacts: [
      { email: 'f&b@lazne-hotel.demo', name: 'Zdeněk Procházka', phone: '+420 734 900 101', role: 'F&B manažer' },
    ],
    email: 'recepce@lazne-hotel.demo',
    key: 'lazensky-hotel',
    name: 'Lázeňský hotel Morava',
    owner: repB.id,
    phone: '+420 577 900 100',
    regNo: '90000110',
  },
  {
    address: 'Polní 31, Vsetín',
    contacts: [],
    key: 'catering-vsetin',
    name: 'Catering Vsetín s.r.o.',
    owner: repB.id,
    phone: '+420 571 000 111',
    regNo: '90000111',
  },
  {
    address: 'Dlouhá 7, Přerov',
    contacts: [{ name: 'Alena Pokorná', role: 'Majitelka' }],
    email: 'cukrarna@sladka-tecka.demo',
    key: 'sladka-tecka',
    name: 'Cukrárna Sladká tečka',
    regNo: '90000112',
  },
];

const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

/** Encoded CRM state, anchored at the reset time so repeated resets stay deterministic in ids. */
const seedState = (now: DateTime.Utc) => {
  const at = (days: number, hours = 0) => DateTime.formatIso(DateTime.subtract(now, { days, hours }));
  const clientId = (key: string) => demoId('crm.client', key);
  const items = CLIENTS.map((seed, index) => ({
    ...defined({
      address: seed.address,
      email: seed.email,
      ownerSalespersonId: seed.owner,
      phone: seed.phone,
      regNo: seed.regNo,
    }),
    createdAt: at(200 - index * 3),
    createdBy: seedPrincipal,
    id: clientId(seed.key),
    kind: 'organization',
    name: seed.name,
    status: 'active',
    updatedAt: at(200 - index * 3),
  }));
  const contacts = CLIENTS.flatMap((seed, index) =>
    seed.contacts.map((contact, position) => ({
      ...defined({ email: contact.email, phone: contact.phone, role: contact.role }),
      clientId: clientId(seed.key),
      createdAt: at(190 - index * 3),
      createdBy: seedPrincipal,
      id: demoId('crm.contact', `${seed.key}-${position}`),
      name: contact.name,
      status: 'active',
      updatedAt: at(190 - index * 3),
    })),
  );
  const assignmentHistory = [
    ...CLIENTS.flatMap((seed, index) =>
      seed.owner === undefined
        ? []
        : [
            {
              at: at(199 - index * 3),
              by: seedPrincipal,
              clientId: clientId(seed.key),
              id: demoId('crm.assignment', seed.key),
              toSalespersonId: seed.owner,
            },
          ],
    ),
  ];
  const visits = seedVisits({
    leadPrincipalId: demoId('core.principal', 'hanak-vedouci'),
    now,
    repA,
    repB,
  });
  return {
    clients: { assignmentHistory, contacts, items },
    imports: { batches: [], customerLinks: [], orders: [], pairingHistory: [] },
    salespeople: SALESPEOPLE,
    visits,
  };
};

const writeState = Effect.fn('Crm.writeDemoState')(function* writeDemoState() {
  const now = yield* DateTime.now;
  const decoded = yield* Schema.decodeUnknownEffect(CrmStateSchema)(seedState(now));
  // crm-imports: approved customer links + one completed CSV import (demo-data/01-uvodni-import-objednavek.csv).
  const state = yield* seedImports(decoded, {
    by: demoId('core.principal', 'hanak-vedouci'),
    clientIdOf: (key) => demoId('crm.client', key),
    importedAt: DateTime.formatIso(DateTime.subtract(now, { days: 1, hours: 3 })),
    invocationId: demoId('crm.import', 'initial'),
    linkedAt: DateTime.formatIso(DateTime.subtract(now, { days: 170 })),
  });
  const encoded = yield* Schema.encodeEffect(CrmStateSchema)(state);
  const db = yield* makeWithDefaults({ relations: crmRelations });
  yield* db
    .insert(crmStates)
    .values({
      legalEntityId: crmLegalEntityId,
      revision: 1,
      state: encoded,
      tenantId: demoTenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 1, state: encoded, updatedAt: DateTime.toDateUtc(now) },
      target: [crmStates.tenantId, crmStates.legalEntityId],
    });
  return yield* Console.log(
    `CRM demo state reset: ${encoded.salespeople.length} salespeople, ${encoded.clients.items.length} clients, ${encoded.clients.contacts.length} contacts, ${encoded.visits.items.length} visits, ${encoded.imports.orders.length} imported orders`,
  );
});

const resetPgLive = PgClient.layerFrom(
  Effect.gen(function* resetPool() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
);

const resetDemo = Effect.fn('Crm.resetDemo')(function* resetDemo(options: {
  readonly salesDemo: boolean;
  readonly validateOnly: boolean;
}) {
  if (!options.salesDemo) {
    return yield* new ResetInputError({ reason: '--sales-demo is required' });
  }
  // Validate-only is a no-op: nothing is written.
  if (options.validateOnly) {
    return yield* Console.log('crm: sales-demo seed validated; no data changed');
  }
  return yield* writeState();
});

const cli = Command.make(
  'reset-crm-demo',
  {
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  resetDemo,
);

const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(resetPgLive),
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)));
