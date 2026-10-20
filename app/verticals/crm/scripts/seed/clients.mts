// Seed of the clients area (C00/C01) — owned by the crm-clients lane.
// Synthetic Moravian B2B customers of Velkoobchod Hanák (bakeries, restaurants, hotels, shops, canteens) with
// 2–3 contact persons each, assignment history (incl. one reassignment with a reason), one archived client, one
// person client and readable change-log events. Names, IČO and e-mails are fictional (IČO-like numbers are not
// real registrations). Keys are referenced by the visits and imports seeds — never rename an existing key.
import { DateTime } from 'effect';
import { demoId } from '../../../../scripts/demo/fixture-ids.mts';

interface ContactSeed {
  readonly name: string;
  readonly role?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly note?: string;
  readonly primary?: boolean;
}

interface ClientSeed {
  readonly key: string;
  readonly kind?: 'organization' | 'person';
  readonly name: string;
  readonly segment: string;
  readonly regNo?: string;
  readonly vatNo?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly website?: string;
  readonly note?: string;
  /** 'a' | 'b' = Jan Novák / Petra Svobodová; absent = unassigned. */
  readonly owner?: 'a' | 'b';
  /** Reassigned from this rep `reassignedDaysAgo` days ago (the seed history shows both steps). */
  readonly previousOwner?: 'a' | 'b';
  readonly reassignedDaysAgo?: number;
  readonly reassignReason?: string;
  readonly archivedDaysAgo?: number;
  readonly contacts: readonly ContactSeed[];
}

export const CLIENT_SEEDS: readonly ClientSeed[] = [
  // ---- Jan Novák (A): Brno, Olomouc, Prostějov, Vyškov, Blansko, Kroměříž, Mikulov ----
  {
    address: 'Masarykova 12, 602 00 Brno',
    contacts: [
      { email: 'jirina.mala@pekarna-mala.demo', name: 'Jiřina Malá', phone: '+420 731 100 201', primary: true, role: 'Majitelka' },
      { email: 'nakup@pekarna-mala.demo', name: 'Tomáš Veselý', phone: '+420 731 100 202', role: 'Nákupčí', note: 'Objednává v pondělí do 10:00, mouku vždy po paletách.' },
      { name: 'Hana Šimková', phone: '+420 731 100 203', role: 'Vedoucí výroby' },
    ],
    email: 'info@pekarna-mala.demo',
    key: 'pekarna-mala',
    name: 'Pekárna Malá s.r.o.',
    note: 'Rodinná pekárna se třemi prodejnami v Brně. Dodávky mouky a droždí 2× týdně, platba převodem 14 dní.',
    owner: 'a',
    phone: '+420 541 100 200',
    regNo: '90000101',
    segment: 'bakery',
    vatNo: 'CZ90000101',
    website: 'www.pekarna-mala.demo',
  },
  {
    address: 'Nádražní 5, 779 00 Olomouc',
    contacts: [
      { email: 'k.dvorak@restaurace-u-zlate-husy.demo', name: 'Karel Dvořák', phone: '+420 732 200 301', primary: true, role: 'Provozní' },
      { email: 'kuchyne@restaurace-u-zlate-husy.demo', name: 'Martin Pospíšil', phone: '+420 732 200 302', role: 'Šéfkuchař' },
    ],
    email: 'objednavky@restaurace-u-zlate-husy.demo',
    key: 'zlata-husa',
    name: 'Restaurace U Zlaté husy',
    note: 'Tradiční česká kuchyně, 120 míst. Zájem o regionální mouku a uzeniny.',
    owner: 'a',
    phone: '+420 585 200 300',
    regNo: '90000102',
    segment: 'restaurant',
    vatNo: 'CZ90000102',
  },
  {
    address: 'Palackého 44, 796 01 Prostějov',
    contacts: [
      { email: 'eva.cerna@potraviny-cerna.demo', name: 'Eva Černá', phone: '+420 733 300 401', primary: true, role: 'Vedoucí prodejny' },
      { name: 'Jaroslav Černý', phone: '+420 733 300 402', role: 'Jednatel' },
    ],
    email: 'prodejna@potraviny-cerna.demo',
    key: 'potraviny-cerna',
    name: 'Potraviny Černá',
    owner: 'a',
    phone: '+420 582 300 400',
    regNo: '90000103',
    segment: 'retail',
  },
  {
    address: 'Hlavní 1, 682 01 Vyškov',
    contacts: [
      { email: 'f.benes@hotel-podhradi.demo', name: 'František Beneš', phone: '+420 734 400 501', primary: true, role: 'Ředitel hotelu' },
      { email: 'restaurace@hotel-podhradi.demo', name: 'Zuzana Kolářová', phone: '+420 734 400 502', role: 'Vedoucí restaurace' },
      { email: 'sklad@hotel-podhradi.demo', name: 'Pavel Urban', role: 'Skladník', note: 'Přebírá zboží po–pá 7:00–11:00.' },
    ],
    email: 'recepce@hotel-podhradi.demo',
    key: 'hotel-podhradi',
    name: 'Hotel Podhradí a.s.',
    note: 'Kongresový hotel, 64 pokojů, snídaně formou bufetu.',
    owner: 'a',
    phone: '+420 517 400 500',
    regNo: '90000104',
    segment: 'hotel',
    vatNo: 'CZ90000104',
    website: 'www.hotel-podhradi.demo',
  },
  {
    address: 'Školní 8, 678 01 Blansko',
    contacts: [
      { email: 'jidelna@zs-blansko.demo', name: 'Marie Horáková', phone: '+420 735 500 601', primary: true, role: 'Vedoucí jídelny' },
      { email: 'ekonom@zs-blansko.demo', name: 'Ing. Ladislav Mareš', phone: '+420 516 500 602', role: 'Ekonom školy', note: 'Schvaluje rámcové smlouvy a faktury.' },
    ],
    email: 'jidelna@zs-blansko.demo',
    key: 'zs-blansko',
    name: 'Školní jídelna ZŠ Blansko',
    note: 'Příspěvková organizace, 450 obědů denně. Dodávky podle rámcové smlouvy.',
    owner: 'a',
    regNo: '90000105',
    segment: 'institution',
  },
  {
    address: 'Okružní 3, 767 01 Kroměříž',
    contacts: [
      { email: 'anna@kavarna-na-rohu.demo', name: 'Anna Křížová', phone: '+420 736 600 701', primary: true, role: 'Majitelka' },
      { name: 'David Hrubý', phone: '+420 736 600 702', role: 'Barista a cukrář' },
    ],
    key: 'kavarna-na-rohu',
    name: 'Kavárna Na Rohu',
    owner: 'a',
    phone: '+420 573 500 600',
    segment: 'cafe',
  },
  {
    address: 'Náměstí 6, 692 01 Mikulov',
    contacts: [
      { email: 'reditel@hotel-galant.demo', name: 'Ing. Robert Svoboda', phone: '+420 737 700 801', primary: true, role: 'Ředitel' },
      { email: 'fb@hotel-galant.demo', name: 'Kateřina Moravcová', phone: '+420 737 700 802', role: 'F&B manažerka' },
      { name: 'Jiří Staněk', phone: '+420 737 700 803', role: 'Šéfkuchař' },
    ],
    email: 'recepce@hotel-galant.demo',
    key: 'hotel-galant',
    name: 'Hotel Galant Mikulov s.r.o.',
    note: 'Wellness hotel ve vinařské oblasti. Sezónní špičky duben–říjen.',
    owner: 'a',
    phone: '+420 519 700 800',
    previousOwner: 'b',
    reassignReason: 'Rozdělení regionů: Břeclavsko přebírá Jan Novák, Petra Svobodová se soustředí na Zlínský kraj.',
    reassignedDaysAgo: 45,
    regNo: '90000113',
    segment: 'hotel',
    vatNo: 'CZ90000113',
    website: 'www.hotel-galant.demo',
  },
  {
    address: 'Hulínská 2410, 767 01 Kroměříž',
    contacts: [
      { email: 'obchod@morava-gastro.demo', name: 'Libor Navrátil', phone: '+420 738 800 901', primary: true, role: 'Obchodní ředitel' },
      { email: 'nakup@morava-gastro.demo', name: 'Simona Bartošová', phone: '+420 738 800 902', role: 'Nákupčí' },
    ],
    email: 'info@morava-gastro.demo',
    key: 'morava-gastro',
    name: 'Morava-Gastro distribuce s.r.o.',
    note: 'Menší distributor pro gastro v okrese Kroměříž, odebírá celé palety.',
    owner: 'a',
    phone: '+420 573 800 900',
    regNo: '90000114',
    segment: 'wholesale',
    vatNo: 'CZ90000114',
  },
  {
    address: 'Nádražní 1, 690 02 Břeclav',
    archivedDaysAgo: 30,
    contacts: [{ name: 'Milan Kučera', phone: '+420 739 900 111', primary: true, role: 'Provozovatel' }],
    key: 'bufet-breclav',
    name: 'Bufet Nádraží Břeclav',
    note: 'Provoz ukončen k 30. 9. 2026. Archivováno, historie zůstává dohledatelná.',
    owner: 'a',
    regNo: '90000115',
    segment: 'restaurant',
  },
  // ---- Petra Svobodová (B): Zlín, Uherské Hradiště, Hodonín, Luhačovice, Vsetín, Rožnov, Strážnice ----
  {
    address: 'Průmyslová 20, 760 01 Zlín',
    contacts: [
      { email: 'p.kral@bistro-kral.demo', name: 'Petr Král', phone: '+420 733 600 701', primary: true, role: 'Jednatel' },
      { email: 'ucetni@bistro-kral.demo', name: 'Lucie Králová', phone: '+420 733 600 702', role: 'Účetní' },
      { name: 'Ondřej Fiala', phone: '+420 733 600 703', role: 'Vedoucí kuchyně' },
    ],
    email: 'bistro@bistro-kral.demo',
    key: 'bistro-kral',
    name: 'Bistro Král s.r.o.',
    note: 'Dvě bistra ve Zlíně, obědová menu. Citlivé na cenu, preferuje týdenní objednávky.',
    owner: 'b',
    phone: '+420 577 600 700',
    regNo: '90000107',
    segment: 'restaurant',
    vatNo: 'CZ90000107',
  },
  {
    address: 'Zámecká 2, 686 01 Uherské Hradiště',
    contacts: [
      { email: 'kuchyne@zamecka-restaurace.demo', name: 'Ondřej Šťastný', phone: '+420 734 700 801', primary: true, role: 'Šéfkuchař' },
      { email: 'provoz@zamecka-restaurace.demo', name: 'Veronika Tomanová', phone: '+420 734 700 802', role: 'Provozní' },
    ],
    email: 'kuchyne@zamecka-restaurace.demo',
    key: 'zamecka-restaurace',
    name: 'Zámecká restaurace',
    owner: 'b',
    phone: '+420 572 700 800',
    regNo: '90000108',
    segment: 'restaurant',
    vatNo: 'CZ90000108',
  },
  {
    address: 'Tržní 15, 695 01 Hodonín',
    contacts: [
      { email: 'vedouci@minimarket-hodonin.demo', name: 'Radka Holubová', phone: '+420 735 800 901', primary: true, role: 'Vedoucí prodejny' },
      { name: 'Josef Vlček', phone: '+420 735 800 902', role: 'Majitel' },
    ],
    email: 'info@minimarket-hodonin.demo',
    key: 'minimarket-hodonin',
    name: 'Minimarket Hodonín',
    owner: 'b',
    regNo: '90000109',
    segment: 'retail',
  },
  {
    address: 'Lázeňská 9, 763 26 Luhačovice',
    contacts: [
      { email: 'fb@lazne-hotel.demo', name: 'Zdeněk Procházka', phone: '+420 734 900 101', primary: true, role: 'F&B manažer' },
      { email: 'nakup@lazne-hotel.demo', name: 'Ivana Machalová', phone: '+420 734 900 102', role: 'Nákup a logistika' },
      { email: 'reditel@lazne-hotel.demo', name: 'MUDr. Aleš Kubíček', role: 'Generální ředitel', note: 'Podepisuje roční kontrakty.' },
    ],
    email: 'recepce@lazne-hotel.demo',
    key: 'lazensky-hotel',
    name: 'Lázeňský hotel Morava',
    note: 'Lázeňský hotel se 180 lůžky, dietní stravování. Jedná se o ročním kontraktu.',
    owner: 'b',
    phone: '+420 577 900 100',
    regNo: '90000110',
    segment: 'hotel',
    vatNo: 'CZ90000110',
    website: 'www.lazne-hotel.demo',
  },
  {
    address: 'Polní 31, 755 01 Vsetín',
    contacts: [
      { email: 'objednavky@catering-vsetin.demo', name: 'Michaela Zbranková', phone: '+420 736 000 112', primary: true, role: 'Vedoucí provozu' },
      { name: 'Roman Pavelka', phone: '+420 736 000 113', role: 'Jednatel' },
    ],
    key: 'catering-vsetin',
    name: 'Catering Vsetín s.r.o.',
    note: 'Firemní stravování a svatby, výkyvy objednávek podle sezóny.',
    owner: 'b',
    phone: '+420 571 000 111',
    regNo: '90000111',
    segment: 'catering',
    vatNo: 'CZ90000111',
  },
  {
    address: 'Horní Paseky 1120, 756 61 Rožnov pod Radhoštěm',
    contacts: [
      { email: 'provoz@hotel-pod-javorniky.demo', name: 'Barbora Janíková', phone: '+420 737 100 201', primary: true, role: 'Provozní ředitelka' },
      { name: 'Vlastimil Juřica', phone: '+420 737 100 202', role: 'Šéfkuchař' },
    ],
    email: 'recepce@hotel-pod-javorniky.demo',
    key: 'hotel-javorniky',
    name: 'Hotel Pod Javorníky s.r.o.',
    owner: 'b',
    phone: '+420 571 100 200',
    regNo: '90000116',
    segment: 'hotel',
    vatNo: 'CZ90000116',
  },
  {
    address: 'Sklepní 14, 696 62 Strážnice',
    contacts: [
      { email: 'vino@na-sklepich.demo', name: 'Antonín Hanáček', phone: '+420 738 200 301', primary: true, role: 'Majitel' },
      { name: 'Klára Hanáčková', phone: '+420 738 200 302', role: 'Vedoucí restaurace' },
    ],
    email: 'restaurace@na-sklepich.demo',
    key: 'na-sklepich',
    name: 'Vinařství a restaurace Na Sklepích',
    owner: 'b',
    phone: '+420 518 200 300',
    regNo: '90000117',
    segment: 'restaurant',
  },
  {
    address: 'Kvítková 88, 760 01 Zlín',
    contacts: [],
    email: 'radek.malina@stanky.demo',
    key: 'radek-malina',
    kind: 'person',
    name: 'Radek Malina',
    note: 'OSVČ, stánek s občerstvením na trzích a festivalech (květen–září).',
    owner: 'b',
    phone: '+420 739 300 401',
    segment: 'catering',
  },
  // ---- Bez obchodníka (vidí jen vedení a správce) ----
  {
    address: 'Dlouhá 7, 750 02 Přerov',
    contacts: [
      { email: 'alena@sladka-tecka.demo', name: 'Alena Pokorná', phone: '+420 739 400 501', primary: true, role: 'Majitelka' },
      { name: 'Tereza Pokorná', role: 'Cukrářka' },
    ],
    email: 'cukrarna@sladka-tecka.demo',
    key: 'sladka-tecka',
    name: 'Cukrárna Sladká tečka',
    note: 'Nový zájemce z veletrhu Gastro Olomouc. Zatím bez přiděleného obchodníka.',
    regNo: '90000112',
    segment: 'cafe',
  },
  {
    address: 'Mlýnská 3, 784 01 Litovel',
    contacts: [
      { email: 'penzion@u-mlyna.demo', name: 'Stanislav Vrba', phone: '+420 739 500 601', primary: true, role: 'Majitel' },
      { name: 'Jana Vrbová', phone: '+420 739 500 602', role: 'Kuchařka' },
    ],
    email: 'penzion@u-mlyna.demo',
    key: 'penzion-u-mlyna',
    name: 'Penzion U Mlýna',
    phone: '+420 585 500 600',
    regNo: '90000118',
    segment: 'hotel',
  },
];

const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

export interface ClientsSeedInput {
  readonly now: DateTime.Utc;
  readonly repA: { readonly id: string };
  readonly repB: { readonly id: string };
  /** Principal shown as the author of seeded records (Správce). */
  readonly adminPrincipalId: string;
  /** Principal of the sales lead (Vedoucí obchodu), author of the reassignment. */
  readonly leadPrincipalId: string;
}

/** Encoded clients slice: items, contacts, assignmentHistory, events. */
export const seedClients = ({ adminPrincipalId, leadPrincipalId, now, repA, repB }: ClientsSeedInput) => {
  const at = (days: number, hours = 0) => DateTime.formatIso(DateTime.subtract(now, { days, hours }));
  const clientId = (key: string) => demoId('crm.client', key);
  const rep = (who: 'a' | 'b') => (who === 'a' ? repA.id : repB.id);
  const createdDays = (index: number) => 220 - index * 7;

  const items = CLIENT_SEEDS.map((seed, index) => {
    const kind = seed.kind ?? 'organization';
    const updated = seed.archivedDaysAgo ?? seed.reassignedDaysAgo ?? createdDays(index);
    return {
      ...defined({
        address: seed.address,
        archivedAt: seed.archivedDaysAgo === undefined ? undefined : at(seed.archivedDaysAgo),
        email: seed.email,
        note: seed.note,
        ownerSalespersonId: seed.owner === undefined ? undefined : rep(seed.owner),
        phone: seed.phone,
        regNo: seed.regNo,
        segment: seed.segment,
        vatNo: seed.vatNo,
        website: seed.website,
      }),
      createdAt: at(createdDays(index)),
      createdBy: adminPrincipalId,
      id: clientId(seed.key),
      kind,
      name: seed.name,
      status: seed.archivedDaysAgo === undefined ? 'active' : 'archived',
      updatedAt: at(updated),
    };
  });

  const contacts = CLIENT_SEEDS.flatMap((seed, index) =>
    seed.contacts.map((contact, position) => ({
      ...defined({ email: contact.email, note: contact.note, phone: contact.phone, role: contact.role }),
      ...(contact.primary === true ? { primary: true } : {}),
      clientId: clientId(seed.key),
      createdAt: at(createdDays(index) - 1 - position),
      createdBy: adminPrincipalId,
      id: demoId('crm.contact', `${seed.key}-${position}`),
      name: contact.name,
      status: 'active',
      updatedAt: at(createdDays(index) - 1 - position),
    })),
  );

  const assignmentHistory = CLIENT_SEEDS.flatMap((seed, index) => {
    if (seed.owner === undefined) {
      return [];
    }
    const first = seed.previousOwner ?? seed.owner;
    const initial = {
      at: at(createdDays(index), -1),
      by: adminPrincipalId,
      clientId: clientId(seed.key),
      id: demoId('crm.assignment', seed.key),
      toSalespersonId: rep(first),
    };
    if (seed.previousOwner === undefined || seed.reassignedDaysAgo === undefined) {
      return [initial];
    }
    return [
      initial,
      {
        ...defined({ reason: seed.reassignReason }),
        at: at(seed.reassignedDaysAgo),
        by: leadPrincipalId,
        clientId: clientId(seed.key),
        fromSalespersonId: rep(seed.previousOwner),
        id: demoId('crm.assignment', `${seed.key}-2`),
        toSalespersonId: rep(seed.owner),
      },
    ];
  });

  const events = CLIENT_SEEDS.flatMap((seed, index) => {
    const id = clientId(seed.key);
    const base = [
      {
        at: at(createdDays(index)),
        by: adminPrincipalId,
        clientId: id,
        id: demoId('crm.client-event', `${seed.key}-created`),
        kind: 'client_created',
        subject: seed.name,
      },
      ...seed.contacts.map((contact, position) => ({
        at: at(createdDays(index) - 1 - position),
        by: adminPrincipalId,
        clientId: id,
        id: demoId('crm.client-event', `${seed.key}-contact-${position}`),
        kind: 'contact_added',
        subject: contact.name,
      })),
    ];
    if (seed.archivedDaysAgo !== undefined) {
      base.push({
        at: at(seed.archivedDaysAgo),
        by: leadPrincipalId,
        clientId: id,
        id: demoId('crm.client-event', `${seed.key}-archived`),
        kind: 'client_archived',
        subject: seed.name,
      });
    }
    return base;
  });
  // A couple of realistic later edits.
  const edits = [
    { days: 60, fields: ['phone', 'note'], key: 'pekarna-mala', who: adminPrincipalId },
    { days: 20, fields: ['address'], key: 'catering-vsetin', who: leadPrincipalId },
  ].map((edit) => ({
    at: at(edit.days),
    by: edit.who,
    clientId: clientId(edit.key),
    fields: edit.fields,
    id: demoId('crm.client-event', `${edit.key}-edit-${edit.days}`),
    kind: 'client_updated',
    subject: CLIENT_SEEDS.find((seed) => seed.key === edit.key)?.name ?? edit.key,
  }));

  return { assignmentHistory, contacts, events: [...events, ...edits], items };
};
