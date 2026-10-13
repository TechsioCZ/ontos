// Sales-demo customer fixture for party.registry. Side-effect free so other owner seeds can import it.
//
// Identity contract (client-supplied, deterministic across cold resets), identical to
// app/scripts/demo/fixture-ids.mts `demoId`:
//   Party        demoId('party.customer', `ico-${ico}`)
//   Counterparty demoId('party.counterparty', `ico-${ico}`)
// The vertical's TypeScript project cannot import app/scripts, so the UUIDv5 derivation is mirrored here
// and reset-demo.mts verifies the shared namespace, Tenant and Legal Entity against fixture-ids at runtime.
import { createHash } from 'node:crypto';

/** Must equal `SALES_DEMO_NAMESPACE` in app/scripts/demo/fixture-ids.mts. */
export const SALES_DEMO_NAMESPACE = '5a1e5d3e-0000-5000-8000-0000000d3e70' as const;
export const salesDemoTenantId = '70000000-0000-4000-8000-000000000020' as const;
export const salesDemoLegalEntityId = '71000000-0000-4000-8000-000000000020' as const;

const uuidBytes = (uuid: string) => Buffer.from(uuid.replaceAll('-', ''), 'hex');

/** RFC 9562 UUIDv5; byte-for-byte the fixture-ids derivation. */
const uuidV5 = (namespace: string, name: string): string => {
  // oxlint-disable-next-line sonarjs/hashing -- RFC 9562 UUIDv5 mandates SHA-1; IDs are public fixture identities.
  const hash = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf-8').digest().subarray(0, 16);
  hash.writeUInt8((hash.readUInt8(6) % 16) + 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) % 64) + 0x80, 8);
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** Same value as fixture-ids `demoId(namespace, key)`. */
export const demoId = (namespace: string, key: string): string => uuidV5(SALES_DEMO_NAMESPACE, `${namespace}:${key}`);

export interface SalesDemoCustomer {
  readonly city: string;
  readonly domain: string;
  /** Eight-digit IČO with a valid mod-11 checksum; DIČ is `CZ${ico}`. */
  readonly ico: string;
  readonly mailbox: string;
  readonly name: string;
  /** International form; the owner normalizes it to E.164. */
  readonly phone: string;
  readonly postalCode: string;
  readonly street: string;
}

export const salesDemoCustomers: readonly SalesDemoCustomer[] = [
  {
    city: 'Jihlava',
    domain: 'strojirny-vysocina.cz',
    ico: '25741136',
    mailbox: 'obchod',
    name: 'Strojírny Vysočina s.r.o.',
    phone: '+420 567 210 410',
    postalCode: '586 01',
    street: 'Havlíčkova 112',
  },
  {
    city: 'Olomouc',
    domain: 'pekarny-morava.cz',
    ico: '44474504',
    mailbox: 'nakup',
    name: 'Pekárny Morava a.s.',
    phone: '+420 585 224 310',
    postalCode: '779 00',
    street: 'Pavelčákova 18',
  },
  {
    city: 'Prostějov',
    domain: 'elektro-hanak.cz',
    ico: '63207877',
    mailbox: 'info',
    name: 'Elektro Hanák s.r.o.',
    phone: '+420 582 330 118',
    postalCode: '796 01',
    street: 'Plumlovská 46',
  },
  {
    city: 'Písek',
    domain: 'drevostavby-sumava.cz',
    ico: '81941242',
    mailbox: 'obchod',
    name: 'Dřevostavby Šumava s.r.o.',
    phone: '+420 382 214 560',
    postalCode: '397 01',
    street: 'Budějovická 77',
  },
  {
    city: 'Ústí nad Labem',
    domain: 'labska-logistika.cz',
    ico: '00674613',
    mailbox: 'objednavky',
    name: 'Labská logistika a.s.',
    phone: '+420 475 220 913',
    postalCode: '400 01',
    street: 'Masarykova 210',
  },
  {
    city: 'Trutnov',
    domain: 'krkonosska-stavebni.cz',
    ico: '19407980',
    mailbox: 'info',
    name: 'Krkonošská stavební s.r.o.',
    phone: '+420 499 812 340',
    postalCode: '541 01',
    street: 'Horská 15',
  },
  {
    city: 'Břeclav',
    domain: 'vinarstvi-palava.cz',
    ico: '38141353',
    mailbox: 'obchod',
    name: 'Moravské vinařství Pálava s.r.o.',
    phone: '+420 519 322 471',
    postalCode: '690 02',
    street: '17. listopadu 9',
  },
  {
    city: 'Plzeň',
    domain: 'psd-plzen.cz',
    ico: '56874723',
    mailbox: 'nakup',
    name: 'Plzeňské strojírenské dílny a.s.',
    phone: '+420 377 445 120',
    postalCode: '301 00',
    street: 'Klatovská 140',
  },
  {
    city: 'Brno',
    domain: 'brnenska-softwarova.cz',
    ico: '75608090',
    mailbox: 'fakturace',
    name: 'Brněnská softwarová s.r.o.',
    phone: '+420 541 220 707',
    postalCode: '602 00',
    street: 'Kounicova 38',
  },
  {
    city: 'Ostrava',
    domain: 'ostravska-ocel.cz',
    ico: '94341460',
    mailbox: 'obchod',
    name: 'Ostravská ocelová konstrukce a.s.',
    phone: '+420 596 112 830',
    postalCode: '702 00',
    street: 'Nádražní 120',
  },
  {
    city: 'Liberec',
    domain: 'ltz-liberec.cz',
    ico: '13074831',
    mailbox: 'info',
    name: 'Liberecké textilní závody s.r.o.',
    phone: '+420 485 103 220',
    postalCode: '460 01',
    street: 'Jablonecká 52',
  },
  {
    city: 'České Budějovice',
    domain: 'cb-potraviny.cz',
    ico: '31808204',
    mailbox: 'nakup',
    name: 'Českobudějovické potraviny a.s.',
    phone: '+420 386 352 900',
    postalCode: '370 01',
    street: 'Lannova třída 63',
  },
  {
    city: 'Hradec Králové',
    domain: 'hzt-hradec.cz',
    ico: '50541579',
    mailbox: 'obchod',
    name: 'Hradecká zdravotnická technika s.r.o.',
    phone: '+420 495 512 316',
    postalCode: '500 02',
    street: 'Gočárova třída 1620',
  },
  {
    city: 'Pardubice',
    domain: 'pardubicka-chemie.cz',
    ico: '69274941',
    mailbox: 'objednavky',
    name: 'Pardubická chemie s.r.o.',
    phone: '+420 466 615 204',
    postalCode: '530 09',
    street: 'Hradecká 571',
  },
  {
    city: 'Zlín',
    domain: 'obuv-moravia.cz',
    ico: '88008312',
    mailbox: 'info',
    name: 'Zlínská obuv Moravia s.r.o.',
    phone: '+420 577 434 118',
    postalCode: '760 01',
    street: 'třída Tomáše Bati 3792',
  },
  {
    city: 'Karlovy Vary',
    domain: 'kv-lazenske-sluzby.cz',
    ico: '06741681',
    mailbox: 'recepce',
    name: 'Karlovarské lázeňské služby a.s.',
    phone: '+420 353 224 780',
    postalCode: '360 01',
    street: 'Zahradní 45',
  },
  {
    city: 'Kladno',
    domain: 'kladenska-slevarna.cz',
    ico: '25475053',
    mailbox: 'obchod',
    name: 'Kladenská slévárna s.r.o.',
    phone: '+420 312 248 650',
    postalCode: '272 01',
    street: 'Dělnická 1810',
  },
  {
    city: 'Most',
    domain: 'mostecka-energetika.cz',
    ico: '44208421',
    mailbox: 'nakup',
    name: 'Mostecká energetika a.s.',
    phone: '+420 476 104 330',
    postalCode: '434 01',
    street: 'Budovatelů 2830',
  },
  {
    city: 'Opava',
    domain: 'opavske-cukrovary.cz',
    ico: '62941798',
    mailbox: 'obchod',
    name: 'Opavské cukrovary s.r.o.',
    phone: '+420 553 712 914',
    postalCode: '746 01',
    street: 'Krnovská 69',
  },
  {
    city: 'Frýdek-Místek',
    domain: 'frydecka-nabytkarna.cz',
    ico: '81675160',
    mailbox: 'info',
    name: 'Frýdecká nábytkárna s.r.o.',
    phone: '+420 558 432 615',
    postalCode: '738 01',
    street: 'Těšínská 1349',
  },
  {
    city: 'Teplice',
    domain: 'teplicke-sklarny.cz',
    ico: '00408531',
    mailbox: 'obchod',
    name: 'Teplické sklárny a.s.',
    phone: '+420 417 534 211',
    postalCode: '415 01',
    street: 'Duchcovská 56',
  },
  {
    city: 'Třebíč',
    domain: 'agro-trebic.cz',
    ico: '19141904',
    mailbox: 'nakup',
    name: 'Agro Třebíč s.r.o.',
    phone: '+420 568 841 230',
    postalCode: '674 01',
    street: 'Brněnská 412',
  },
  {
    city: 'Přerov',
    domain: 'prerovske-strojirny.cz',
    ico: '37875272',
    mailbox: 'obchod',
    name: 'Přerovské strojírny s.r.o.',
    phone: '+420 581 207 445',
    postalCode: '750 02',
    street: 'Dluhonská 2900',
  },
  {
    city: 'Kolín',
    domain: 'kolinska-elektrotechnika.cz',
    ico: '56608641',
    mailbox: 'fakturace',
    name: 'Kolínská elektrotechnika a.s.',
    phone: '+420 321 722 908',
    postalCode: '280 02',
    street: 'Ovčárecká 314',
  },
  {
    city: 'Tábor',
    domain: 'taborske-pivovary.cz',
    ico: '75342014',
    mailbox: 'objednavky',
    name: 'Táborské pivovary s.r.o.',
    phone: '+420 381 251 670',
    postalCode: '390 02',
    street: 'Pražská 1530',
  },
  {
    city: 'Znojmo',
    domain: 'znojemska-zelenina.cz',
    ico: '94075387',
    mailbox: 'obchod',
    name: 'Znojemská zelenina s.r.o.',
    phone: '+420 515 224 301',
    postalCode: '669 02',
    street: 'Dobšická 38',
  },
  {
    city: 'Příbram',
    domain: 'pribramske-kovohute.cz',
    ico: '12808750',
    mailbox: 'nakup',
    name: 'Příbramské kovohutě a.s.',
    phone: '+420 318 627 410',
    postalCode: '261 01',
    street: 'Pražská 159',
  },
  {
    city: 'Cheb',
    domain: 'chebske-stavebniny.cz',
    ico: '31542123',
    mailbox: 'info',
    name: 'Chebské stavebniny s.r.o.',
    phone: '+420 354 433 812',
    postalCode: '350 02',
    street: 'Americká 1980',
  },
  {
    city: 'Kroměříž',
    domain: 'kromerizska-tiskarna.cz',
    ico: '50275496',
    mailbox: 'obchod',
    name: 'Kroměřížská tiskárna s.r.o.',
    phone: '+420 573 331 905',
    postalCode: '767 01',
    street: 'Velehradská 4410',
  },
  {
    city: 'Vsetín',
    domain: 'valasske-drevo.cz',
    ico: '69008868',
    mailbox: 'obchod',
    name: 'Valašské dřevařské závody s.r.o.',
    phone: '+420 571 418 226',
    postalCode: '755 01',
    street: 'Smetanova 1484',
  },
  {
    city: 'Šumperk',
    domain: 'sumperske-plasty.cz',
    ico: '87742233',
    mailbox: 'info',
    name: 'Šumperské plasty s.r.o.',
    phone: '+420 583 212 734',
    postalCode: '787 01',
    street: 'Jesenická 2650',
  },
  {
    city: 'Uherské Hradiště',
    domain: 'slovacke-mlekarny.cz',
    ico: '06475604',
    mailbox: 'nakup',
    name: 'Slovácké mlékárny a.s.',
    phone: '+420 572 551 840',
    postalCode: '686 01',
    street: 'Průmyslová 1162',
  },
  {
    city: 'Hodonín',
    domain: 'nafta-servis-hodonin.cz',
    ico: '25208977',
    mailbox: 'obchod',
    name: 'Hodonínský naftový servis s.r.o.',
    phone: '+420 518 351 207',
    postalCode: '695 01',
    street: 'Brněnská 3880',
  },
  {
    city: 'Litoměřice',
    domain: 'litomericka-zahradnictvi.cz',
    ico: '43942342',
    mailbox: 'objednavky',
    name: 'Litoměřická zahradnictví s.r.o.',
    phone: '+420 416 731 518',
    postalCode: '412 01',
    street: 'Žernosecká 1220',
  },
  {
    city: 'Chomutov',
    domain: 'chomutovska-valcovna.cz',
    ico: '62675711',
    mailbox: 'obchod',
    name: 'Chomutovská válcovna s.r.o.',
    phone: '+420 474 620 381',
    postalCode: '430 01',
    street: 'Spořická 4949',
  },
  {
    city: 'Praha',
    domain: 'vysocanske-it.cz',
    ico: '81409087',
    mailbox: 'info',
    name: 'Vysočanské IT služby s.r.o.',
    phone: '+420 222 512 640',
    postalCode: '190 00',
    street: 'Freyova 982/27',
  },
  {
    city: 'Praha',
    domain: 'prazska-distribucni.cz',
    ico: '00142450',
    mailbox: 'nakup',
    name: 'Pražská distribuční a.s.',
    phone: '+420 224 815 330',
    postalCode: '110 00',
    street: 'Na Florenci 2116/15',
  },
  {
    city: 'Mladá Boleslav',
    domain: 'boleslavske-autodily.cz',
    ico: '18875823',
    mailbox: 'obchod',
    name: 'Boleslavské autodíly s.r.o.',
    phone: '+420 326 712 441',
    postalCode: '293 01',
    street: 'Jičínská 1350',
  },
  {
    city: 'Nový Jičín',
    domain: 'novojicinske-klobouky.cz',
    ico: '37609190',
    mailbox: 'info',
    name: 'Novojičínské klobouky s.r.o.',
    phone: '+420 556 712 305',
    postalCode: '741 01',
    street: 'Husova 1210',
  },
  {
    city: 'Děčín',
    domain: 'decinska-lodni-doprava.cz',
    ico: '56342560',
    mailbox: 'objednavky',
    name: 'Děčínská lodní doprava a.s.',
    phone: '+420 412 513 260',
    postalCode: '405 02',
    street: 'Ústecká 1800',
  },
];

/** Canonical Party identity of a seeded customer. */
export const salesDemoCustomerPartyId = (ico: string): string => demoId('party.customer', `ico-${ico}`);

/** Counterparty identity of a seeded customer in the demo Legal Entity. */
export const salesDemoCustomerCounterpartyId = (ico: string): string => demoId('party.counterparty', `ico-${ico}`);
