#!/usr/bin/env node
/**
 * LOCAL ONLY. Siampark (0021) CRM state for S00 "Externí obchodník smí číst jen svěřené kontakty a případy".
 *
 *   node --env-file=.env scripts/demo/seed-siampark-crm.mts          # writes only when Siampark has no CRM state
 *   node --env-file=.env scripts/demo/seed-siampark-crm.mts --reset  # replaces the Siampark CRM state
 *
 * Six prospective tenants (none has a lease yet). Vedení entrusted three of them to the external salesperson
 * (external@siampark.demo); the other three stay with Vedení or unassigned. external@ holds only
 * `demo.crm.read_assigned` (scripts/demo/permissions.mts), so the crm owner returns just the three entrusted
 * clients with their contacts, calls/meetings and planned contacts. The Hanák CRM row (0022) is never touched.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, DateTime, Effect, Option, Schema } from 'effect';

import { Command, Flag } from 'effect/unstable/cli';
import { Reactivity } from 'effect/unstable/reactivity';
import { CrmStateSchema } from '@app/crm/contracts/records';
import { demoId, demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { siamparkRentalPersonas } from './permissions.mts';

class CrmSeedFailure extends Schema.TaggedError<CrmSeedFailure>()('CrmSeedFailure', { message: Schema.String }) {}
const principalOf = (email: string) =>
  Effect.gen(function* fixturePrincipal() {
    const persona = siamparkRentalPersonas.find((entry) => entry.email === email);
    if (persona === undefined) {
      return yield* new CrmSeedFailure({ message: `Siampark persona ${email} is missing` });
    }
    return persona.principalId;
  });
const optionalFields = (fields: Readonly<Record<string, string | boolean | undefined>>) => {
  const present: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      present[key] = value;
    }
  }
  return present;
};

interface ContactSeed {
  readonly email?: string;
  readonly name: string;
  readonly note?: string;
  readonly phone?: string;
  readonly primary?: boolean;
  readonly role?: string;
}
interface VisitSeed {
  readonly daysAgo: number;
  readonly hour: number;
  readonly key: string;
  readonly kind: 'visit' | 'call' | 'video' | 'email';
  readonly nextStep?: string;
  readonly nextStepInDays?: number;
  readonly note?: string;
  readonly result: string;
}
interface ClientSeed {
  readonly address?: string;
  readonly contacts: readonly ContactSeed[];
  readonly email?: string;
  readonly key: string;
  readonly kind?: 'organization' | 'person';
  readonly name: string;
  readonly note: string;
  /** Who holds the client: the external salesperson (entrusted), Vedení, or nobody. */
  readonly owner?: 'externi' | 'vedeni';
  readonly phone?: string;
  readonly plan?: { readonly dueInDays: number; readonly key: string; readonly note: string };
  readonly regNo?: string;
  readonly segment?: string;
  readonly visits: readonly VisitSeed[];
  readonly website?: string;
}

const clients: readonly ClientSeed[] = [
  {
    address: 'Nábřežní 14, 602 00 Brno',
    contacts: [
      {
        email: 'jana.koubkova@kavarna-nabrezi.demo',
        name: 'Jana Koubková',
        phone: '+420 736 410 221',
        primary: true,
        role: 'Jednatelka',
      },
      {
        email: 'provoz@kavarna-nabrezi.demo',
        name: 'Ondřej Bláha',
        note: 'Řeší technické zázemí: odvětrání, přípojka vody, sklad.',
        phone: '+420 736 410 222',
        role: 'Provozní',
      },
    ],
    email: 'info@kavarna-nabrezi.demo',
    key: 'siampark-kavarna-nabrezi',
    name: 'Kavárna Na Nábřeží s.r.o.',
    note: 'Hledá obchodní prostor v přízemí s výlohou, 60–80 m², nástup od ledna 2027.',
    owner: 'externi',
    phone: '+420 515 410 220',
    plan: { dueInDays: 2, key: 'siampark-kavarna-nabrezi', note: 'Poslat půdorys R101 a podmínky nájmu.' },
    regNo: '91000211',
    segment: 'cafe',
    visits: [
      {
        daysAgo: 9,
        hour: 10,
        key: 'siampark-kavarna-nabrezi-telefon',
        kind: 'call',
        note: 'Zájem o přízemí v Riverside Office Park, preferuje výlohu do ulice.',
        result: 'Úvodní telefonát, upřesněna plocha',
      },
      {
        daysAgo: 4,
        hour: 14,
        key: 'siampark-kavarna-nabrezi-prohlidka',
        kind: 'visit',
        nextStep: 'Poslat půdorys R101 a podmínky nájmu.',
        nextStepInDays: 2,
        note: 'Prohlídka jednotky R101 s jednatelkou a provozním. Řešili odvětrání a sklad.',
        result: 'Prohlídka prostoru proběhla',
      },
    ],
  },
  {
    address: 'Husova 8, 602 00 Brno',
    contacts: [
      {
        email: 'm.horak@ak-horak.demo',
        name: 'JUDr. Michal Horák',
        phone: '+420 777 520 101',
        primary: true,
        role: 'Partner kanceláře',
      },
      {
        email: 'recepce@ak-horak.demo',
        name: 'Lenka Pospíšilová',
        phone: '+420 777 520 102',
        role: 'Office manažerka',
      },
    ],
    email: 'kancelar@ak-horak.demo',
    key: 'siampark-ak-horak',
    name: 'Advokátní kancelář Horák & partneři',
    note: 'Rozšiřuje tým, potřebuje kanceláře kolem 120 m² se zasedačkou a dvěma parkovacími místy.',
    owner: 'externi',
    phone: '+420 515 520 100',
    plan: { dueInDays: 5, key: 'siampark-ak-horak', note: 'Domluvit druhou prohlídku s partnery kanceláře.' },
    regNo: '91000212',
    visits: [
      {
        daysAgo: 6,
        hour: 9,
        key: 'siampark-ak-horak-email',
        kind: 'email',
        note: 'Zaslán přehled volných kanceláří ve 2. patře a orientační cena za m².',
        result: 'Odeslána nabídka volných kanceláří',
      },
    ],
  },
  {
    contacts: [],
    email: 'pavel.stastny@posta.demo',
    key: 'siampark-pavel-stastny',
    kind: 'person',
    name: 'Ing. Pavel Šťastný',
    note: 'Živnostník, hledá suchý sklad 30–40 m² s přístupem pro dodávku.',
    owner: 'externi',
    phone: '+420 605 330 418',
    visits: [
      {
        daysAgo: 2,
        hour: 16,
        key: 'siampark-pavel-stastny-telefon',
        kind: 'call',
        note: 'Volný sklad je jen v areálu Jih; nabídnuta prohlídka příští týden.',
        result: 'Telefonát, zájem o sklad v areálu Jih',
      },
    ],
  },
  {
    address: 'Lidická 22, 602 00 Brno',
    contacts: [
      {
        email: 'vedeni@fyzio-pohyb.demo',
        name: 'Mgr. Tereza Navrátilová',
        phone: '+420 739 610 330',
        primary: true,
        role: 'Majitelka',
      },
    ],
    email: 'recepce@fyzio-pohyb.demo',
    key: 'siampark-fyzio-pohyb',
    name: 'Fyzioterapie Pohyb s.r.o.',
    note: 'Vyjednává Vedení přímo: bezbariérový prostor 150 m², sleva za delší nájem.',
    owner: 'vedeni',
    phone: '+420 515 610 330',
    regNo: '91000213',
    visits: [
      {
        daysAgo: 3,
        hour: 11,
        key: 'siampark-fyzio-pohyb-schuzka',
        kind: 'visit',
        note: 'Jednání o slevě za pětiletý nájem; čeká se na schválení vedením.',
        result: 'Jednání o podmínkách nájmu',
      },
    ],
  },
  {
    address: 'Technická 3, 616 00 Brno',
    contacts: [
      {
        email: 'facility@dataservis-morava.demo',
        name: 'Radek Kolář',
        phone: '+420 731 720 440',
        primary: true,
        role: 'Facility manažer',
      },
    ],
    email: 'info@dataservis-morava.demo',
    key: 'siampark-dataservis',
    name: 'DataServis Morava a.s.',
    note: 'Strategický zájemce o celé patro; důvěrné podmínky, řeší jen Vedení.',
    owner: 'vedeni',
    phone: '+420 515 720 440',
    regNo: '91000214',
    visits: [],
  },
  {
    address: 'Kounicova 41, 602 00 Brno',
    contacts: [{ name: 'Alena Marková', phone: '+420 608 810 551', primary: true, role: 'Majitelka' }],
    key: 'siampark-kvetinarstvi-lilie',
    name: 'Květinářství Lilie',
    note: 'Poptávka z webu, zatím nikomu nesvěřena.',
    phone: '+420 608 810 550',
    segment: 'retail',
    visits: [],
  },
];

const salespersonNamespace = 'crm.salesperson';
const managementEmail = 'management@siampark.demo';
const clientId = (seed: ClientSeed) => demoId('crm.client', seed.key);
const seedState = (now: DateTime.Utc, managementPrincipal: string, externalPrincipal: string) => {
  const salespeople = [
    {
      active: true,
      email: managementEmail,
      id: demoId(salespersonNamespace, 'siampark-vedeni'),
      name: 'Vedení Siampark',
      phone: '+420 515 900 100',
      principalId: managementPrincipal,
    },
    {
      active: true,
      email: 'external@siampark.demo',
      id: demoId(salespersonNamespace, 'siampark-externi'),
      name: 'Martin Krejčí',
      phone: '+420 724 518 330',
      principalId: externalPrincipal,
    },
  ] as const;
  const [vedeni, externi] = salespeople;
  const ownerOf = (seed: ClientSeed) => {
    if (seed.owner === 'externi') {
      return Option.some(externi.id);
    }
    if (seed.owner === 'vedeni') {
      return Option.some(vedeni.id);
    }
    return Option.none();
  };
  const authorOf = (seed: ClientSeed) => (seed.owner === 'externi' ? externalPrincipal : managementPrincipal);

  const today = DateTime.startOf(now, 'day');
  // Prague is UTC+1/UTC+2; one hour offset keeps every seeded time inside working hours.
  const at = (daysAgo: number, hour = 9) =>
    DateTime.formatIso(DateTime.add(DateTime.subtract(today, { days: daysAgo }), { minutes: (hour - 1) * 60 }));
  const day = (inDays: number) => DateTime.formatIso(DateTime.add(today, { days: inDays })).slice(0, 10);
  const created = at(21, 9);
  const entrusted = at(14, 10);
  const items = clients.map((seed) => {
    const owner = Option.getOrUndefined(ownerOf(seed));
    return {
      ...optionalFields({ address: seed.address }),
      createdAt: created,
      createdBy: managementPrincipal,
      ...optionalFields({ email: seed.email }),
      id: clientId(seed),
      kind: seed.kind ?? 'organization',
      name: seed.name,
      note: seed.note,
      ...optionalFields({ ownerSalespersonId: owner }),
      ...optionalFields({ phone: seed.phone }),
      ...optionalFields({ regNo: seed.regNo }),
      ...optionalFields({ segment: seed.segment }),
      status: 'active' as const,
      updatedAt: owner === undefined ? created : entrusted,
    };
  });
  const contacts = clients.flatMap((seed) =>
    seed.contacts.map((contact, index) => ({
      clientId: clientId(seed),
      createdAt: created,
      createdBy: managementPrincipal,
      ...optionalFields({ email: contact.email }),
      id: demoId('crm.contact', `${seed.key}-${index + 1}`),
      name: contact.name,
      ...optionalFields({ note: contact.note }),
      ...optionalFields({ phone: contact.phone }),
      ...optionalFields({ primary: contact.primary }),
      ...optionalFields({ role: contact.role }),
      status: 'active' as const,
      updatedAt: created,
    })),
  );
  const assignmentHistory = clients.flatMap((seed) => {
    const owner = Option.getOrUndefined(ownerOf(seed));
    return owner === undefined
      ? []
      : [
          {
            at: entrusted,
            by: managementPrincipal,
            clientId: clientId(seed),
            id: demoId('crm.assignment', seed.key),
            ...(seed.owner === 'externi'
              ? { reason: 'Svěřeno externímu obchodníkovi: zájemce přišel z jeho sítě, vede jednání o pronájmu.' }
              : { reason: 'Jednání vede přímo Vedení.' }),
            toSalespersonId: owner,
          },
        ];
  });
  const events = clients.flatMap((seed) => [
    {
      at: created,
      by: managementPrincipal,
      clientId: clientId(seed),
      id: demoId('crm.event', `${seed.key}-created`),
      kind: 'client_created' as const,
    },
    ...seed.contacts.map((contact, index) => ({
      at: created,
      by: managementPrincipal,
      clientId: clientId(seed),
      id: demoId('crm.event', `${seed.key}-contact-${index + 1}`),
      kind: 'contact_added' as const,
      subject: contact.name,
    })),
    ...(seed.owner === undefined
      ? []
      : [
          {
            at: entrusted,
            by: managementPrincipal,
            clientId: clientId(seed),
            id: demoId('crm.event', `${seed.key}-assigned`),
            kind: 'assigned' as const,
            subject: seed.owner === 'externi' ? externi.name : vedeni.name,
          },
        ]),
  ]);
  const visits = clients.flatMap((seed) =>
    seed.visits.map((visit) => ({
      authorPrincipalId: authorOf(seed),
      clientId: clientId(seed),
      corrections: [],
      createdAt: at(visit.daysAgo, visit.hour + 1),
      id: demoId('crm.visit', visit.key),
      kind: visit.kind,
      ...optionalFields({ nextStep: visit.nextStep }),
      ...optionalFields({ nextStepDate: visit.nextStepInDays === undefined ? undefined : day(visit.nextStepInDays) }),
      ...optionalFields({ note: visit.note }),
      occurredAt: at(visit.daysAgo, visit.hour),
      result: visit.result,
      ...optionalFields({ salespersonId: Option.getOrUndefined(ownerOf(seed)) }),
      updatedAt: at(visit.daysAgo, visit.hour + 1),
    })),
  );
  const plan = clients.flatMap((seed) =>
    seed.plan === undefined
      ? []
      : [
          {
            clientId: clientId(seed),
            createdAt: at(2, 15),
            createdBy: authorOf(seed),
            dueDate: day(seed.plan.dueInDays),
            id: demoId('crm.plan', seed.plan.key),
            note: seed.plan.note,
            ...optionalFields({ salespersonId: Option.getOrUndefined(ownerOf(seed)) }),
            status: 'open' as const,
          },
        ],
  );
  return {
    clients: { assignmentHistory, contacts, events, items },
    imports: { batches: [], customerLinks: [], orders: [], pairingHistory: [] },
    salespeople,
    visits: { items: visits, plan },
  };
};

const program = (reset: boolean) =>
  Effect.gen(function* seedSiamparkCrm() {
    const managementPrincipal = yield* principalOf(managementEmail);
    const externalPrincipal = yield* principalOf('external@siampark.demo');
    const now = yield* DateTime.now;
    const decoded = yield* Schema.decodeUnknownEffect(CrmStateSchema)(
      seedState(now, managementPrincipal, externalPrincipal),
    );
    const encoded = yield* Schema.encodeEffect(CrmStateSchema)(decoded);
    const sql = yield* PgClient.PgClient;
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(CrmStateSchema))(decoded);
    const rows = reset
      ? yield* sql`
        insert into demo_crm.crm_states (tenant_id, legal_entity_id, revision, state, updated_at)
        values (${demoTenantId}, ${rentalDemoLegalEntityId}, 1, ${json}::jsonb, now())
        on conflict (tenant_id, legal_entity_id)
        do update set state = excluded.state, revision = demo_crm.crm_states.revision + 1, updated_at = now()
        returning revision`
      : yield* sql`
        insert into demo_crm.crm_states (tenant_id, legal_entity_id, revision, state, updated_at)
        values (${demoTenantId}, ${rentalDemoLegalEntityId}, 1, ${json}::jsonb, now())
        on conflict (tenant_id, legal_entity_id) do nothing
        returning revision`;
    const entrustedCount = encoded.clients.items.filter(
      (client) => client.ownerSalespersonId === demoId(salespersonNamespace, 'siampark-externi'),
    ).length;
    yield* Console.log(
      rows.length === 0
        ? 'Siampark CRM state already exists; nothing changed (use --reset to replace it).'
        : `Siampark CRM state written: ${encoded.clients.items.length} clients, ${entrustedCount} entrusted to external@siampark.demo, ${encoded.visits.items.length} visits, ${encoded.visits.plan.length} planned contacts.`,
    );
  });

const pgLive = PgClient.layerConfig({ url: Config.Redacted('DATABASE_ADMIN_URL') });

const command = Command.make('seed-siampark-crm', { reset: Flag.Boolean('reset') }, ({ reset }) => program(reset));
NodeRuntime.runMain(
  Command.run(command, { version: '1.0.0' }).pipe(
    Effect.provide(pgLive),
    Effect.provide(Reactivity.layer),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
