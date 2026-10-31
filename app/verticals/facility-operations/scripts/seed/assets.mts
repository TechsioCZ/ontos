// Seed of agenda `assets` for Nájempark (legal entity …0021). OWNED BY THE `assets` LANE (ops-assets).
// Returns the ENCODED state (ISO strings, plain ids); validated against AssetsStateSchema by reset-demo.mts.
// Property/unit ids are the property-portfolio records of the rental seed (Rezidence Parková, Riverside Office
// Park). Labels are display snapshots, so the UI still reads well if the property seed is ever re-created.
// Depreciation amounts are hand-entered EVIDENCE (approved values), never a legal calculation.
import type { AssetsStateEncoded } from '../../shared/domain/assets.ts';

const seedText = {
  date20190615: '2019-06-15',
  date20190620: '2019-06-20',
  date20190701: '2019-07-01',
  date20190715: '2019-07-15',
  date20190930: '2019-09-30',
  date20200403: '2020-04-03',
  date20210301: '2021-03-01',
  date20210412: '2021-04-12',
  date20210503: '2021-05-03',
  date20210601: '2021-06-01',
  date20220110: '2022-01-10',
  date20220420: '2022-04-20',
  date20220801: '2022-08-01',
  date20220915: '2022-09-15',
  date20221107: '2022-11-07',
  date20230116: '2023-01-16',
  date20230201: '2023-02-01',
  date20230510: '2023-05-10',
  date20240214: '2024-02-14',
  date20240601: '2024-06-01',
  date20240701: '2024-07-01',
  date20250312: '2025-03-12',
  date20251215: '2025-12-15',
  date20251231: '2025-12-31',
  date20260112: '2026-01-12',
  date20260430: '2026-04-30',
  date20260630: '2026-06-30',
  date20260902: '2026-09-02',
  date20260903: '2026-09-03',
  date20260904: '2026-09-04',
  date20261018: '2026-10-18',
  date20261112: '2026-11-12',
  elektroRevizeCz: 'Elektro Revize CZ',
  janDvorak: 'Jan Dvořák',
  ks2021007Priloha5: 'KS-2021/007 (příloha 5)',
  odbornaProhlidkaVytahuCtvrtletni: 'Odborná prohlídka výtahu (čtvrtletní)',
  rovnomerny: 'Rovnoměrný',
  rovnomerny31Zdp: 'Rovnoměrný (§ 31 ZDP)',
  tomasVesely: 'Tomáš Veselý',
} as const;

type EncodedAsset = AssetsStateEncoded['assets'][number];
type EncodedEvent = NonNullable<EncodedAsset['events']>[number];
type EncodedService = NonNullable<EncodedAsset['services']>[number];
type EncodedEntry = NonNullable<NonNullable<EncodedAsset['depreciationPlans']>[number]['entries']>[number];
type MutableEntry = { -readonly [Key in keyof EncodedEntry]: EncodedEntry[Key] };
type EncodedInventoryItem = NonNullable<EncodedInventory['items']>[number];
type MutableInventoryItem = { -readonly [Key in keyof EncodedInventoryItem]: EncodedInventoryItem[Key] };
type EncodedPlan = NonNullable<EncodedAsset['depreciationPlans']>[number];
type EncodedInventory = NonNullable<AssetsStateEncoded['inventories']>[number];
type EncodedInvestment = NonNullable<AssetsStateEncoded['investments']>[number];

const tenantId = '70000000-0000-4000-8000-000000000020';
const management = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };
const finance = { principalId: '72000000-0000-4000-8000-000000000023', tenantId };

const parkova = { code: 'PARKOVA', id: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b', name: 'Rezidence Parková' };
const riverside = { code: 'RIVERSIDE', id: '6a0197b3-4b13-46c5-a3ab-8dbb46dda58e', name: 'Riverside Office Park' };
type Property = typeof parkova;

const units = {
  A101: { id: '5bdfdfea-bbce-41dc-875c-5569a4c704ba', name: 'Byt A101 · 2+kk', property: parkova },
  A102: { id: '3280be49-3108-4dae-a97f-b19965353638', name: 'Byt A102 · 3+kk', property: parkova },
  A201: { id: '7331ff5b-4415-473a-9fc7-e3b338f44ba8', name: 'Byt A201 · 1+kk', property: parkova },
  R101: { id: 'bf65f06e-fe64-4787-813f-6a62bad12409', name: 'Obchodní prostor R101', property: riverside },
  R201: { id: 'ec2c089a-69d4-459d-a67f-83d986add5f8', name: 'Kancelář R201', property: riverside },
  R301: { id: '05444cc8-c6e6-4f2b-934b-a46d53d854be', name: 'Kancelář R301', property: riverside },
  S01: { id: '1ecbca7a-0c49-49c3-a122-3d0d03476cad', name: 'Sklad S01', property: riverside },
} as const;
type UnitCode = keyof typeof units;

const atProperty = (property: Property) => ({
  location: { id: property.id, kind: 'property' as const, label: `${property.name} (${property.code})` },
  propertyId: property.id,
});
const atUnit = (code: UnitCode) => {
  const unit = units[code];
  return {
    location: { id: unit.id, kind: 'unit' as const, label: `${unit.property.name} › ${unit.name} (${code})` },
    propertyId: unit.property.id,
  };
};

const kc = (crowns: number) => Math.round(crowns * 100);
const ts = (date: string, time = '09:00:00') => `${date}T${time}Z`;
const assetId = (index: number) => `siampark-asset-${String(index).padStart(3, '0')}`;

let sequence = 0;
const nextId = (prefix: string) => {
  sequence += 1;
  return `seed-${prefix}-${String(sequence).padStart(4, '0')}`;
};

const event = (
  kind: EncodedEvent['kind'],
  date: string,
  note: string,
  extra: Partial<Pick<EncodedEvent, 'documentRef' | 'newValueMinor' | 'previousValueMinor'>> = {},
  by = management,
): EncodedEvent => ({ at: ts(date), by, date, id: nextId('event'), kind, note, ...extra });

const service = (fields: Omit<EncodedService, 'at' | 'by' | 'id'>, by = operations): EncodedService => ({
  ...fields,
  at: ts(fields.performedOn ?? '2026-09-01', '10:30:00'),
  by,
  id: nextId('service'),
});

const plan = (
  fields: Omit<EncodedPlan, 'createdAt' | 'createdBy' | 'entries' | 'history' | 'id'> & {
    readonly confirmedOn?: string;
    readonly createdOn: NonNullable<EncodedAsset['acquisitionDate']>;
    readonly entries?: readonly (readonly [
      period: string,
      crowns: number,
      documentRef?: string,
      partial?: boolean,
      note?: string,
      recordedOn?: string,
    ])[];
  },
): EncodedPlan => {
  const { confirmedOn, createdOn, entries = [], ...rest } = fields;
  const recorded = entries.map(([period, crowns, documentRef, partial, note, recordedOn]): EncodedEntry => {
    const entry: MutableEntry = {
      amountMinor: kc(crowns),
      // The period is not an audit timestamp: a partial-year write uses its actual document date.
      at: ts(recordedOn ?? (period.length === 4 ? `${period}-12-31` : `${period}-28`), '14:00:00'),
      by: finance,
      id: nextId('entry'),
      period,
    };
    if (documentRef !== undefined) {
      entry.documentRef = documentRef;
    }
    if (partial === true) {
      entry.partial = true;
    }
    if (note !== undefined) {
      entry.note = note;
    }
    return entry;
  });
  return {
    ...rest,
    createdAt: ts(createdOn),
    createdBy: finance,
    entries: recorded,
    history: [
      { at: ts(createdOn), by: finance, change: 'created' as const },
      ...(confirmedOn === undefined
        ? []
        : [
            {
              at: ts(confirmedOn, '11:00:00'),
              by: management,
              change: 'confirmed' as const,
              note: 'Schváleno vedením',
            },
          ]),
      ...recorded.map((entry) => ({
        at: entry.at,
        by: finance,
        change: 'entry_recorded' as const,
        note: entry.period,
      })),
    ],
    id: nextId('plan'),
  };
};

const yearly = (from: number, to: number, crowns: number, documentPrefix: string) =>
  Array.from({ length: to - from + 1 }, (_, index) => {
    const year = from + index;
    return [String(year), crowns, `${documentPrefix}-${year}`] as const;
  });

interface AssetSeed extends Omit<EncodedAsset, 'createdAt' | 'createdBy' | 'id' | 'updatedAt' | 'updatedBy'> {
  readonly createdOn: NonNullable<EncodedAsset['acquisitionDate']>;
}

const asset = (index: number, fields: AssetSeed): EncodedAsset => {
  const { createdOn, ...rest } = fields;
  return {
    status: 'active',
    ...rest,
    createdAt: ts(createdOn, '08:15:00'),
    createdBy: management,
    id: assetId(index),
    updatedAt: ts('2026-10-12', '16:20:00'),
    updatedBy: management,
  };
};

const acquired = (date: string, crowns: number, documentRef: string) =>
  event('acquisition', date, 'Pořízení zapsáno podle dokladu', { documentRef, newValueMinor: kc(crowns) });

const buildAssets = (): EncodedAsset[] => [
  // ── Budovy ───────────────────────────────────────────────────────────────────────────────────────────
  asset(1, {
    ...atProperty(parkova),
    acquisitionDate: seedText.date20190615,
    acquisitionMethod: 'construction',
    acquisitionValueMinor: kc(48_500_000),
    category: 'Bytový dům',
    createdOn: seedText.date20260902,
    currentValueDate: seedText.date20251231,
    currentValueMinor: kc(61_200_000),
    depreciationPlans: [
      plan({
        baseMinor: kc(48_500_000),
        confirmedOn: seedText.date20190930,
        createdOn: seedText.date20190715,
        entries: [
          ['2019', 485_000, 'ID-2019-118', false, 'Poměrná část roku od zařazení'],
          ...yearly(2020, 2025, 970_000, 'ID-ODP'),
        ],
        interval: 'yearly',
        method: seedText.rovnomerny,
        startDate: seedText.date20190701,
        status: 'confirmed',
        type: 'accounting',
        years: 50,
      }),
      plan({
        baseMinor: kc(48_500_000),
        confirmedOn: seedText.date20190930,
        createdOn: seedText.date20190715,
        entries: [['2019', 494_700, 'DP-2019'], ...yearly(2020, 2025, 979_700, 'DP')],
        interval: 'yearly',
        method: seedText.rovnomerny31Zdp,
        note: 'Hodnoty převzaty z daňového přiznání; aplikace je nepočítá.',
        startDate: seedText.date20190701,
        status: 'confirmed',
        taxGroup: '6',
        type: 'tax',
        years: 50,
      }),
    ],
    events: [
      event('construction', '2018-04-02', 'Zahájení výstavby, stavební povolení SP-2017/884', {
        documentRef: 'SP-2017/884',
      }),
      acquired(seedText.date20190615, 48_500_000, 'Kolaudační souhlas KS-2019/221'),
      event('placed_in_service', seedText.date20190701, 'Zařazeno do užívání po kolaudaci'),
      event('ownership', '2019-08-20', 'Zápis vlastnického práva do katastru nemovitostí, řízení V-5120/2019', {
        documentRef: 'V-5120/2019',
      }),
      event(
        'construction',
        '2024-05-14',
        'Výměna střešní krytiny a zateplení střechy (technické zhodnocení posouzeno účetní)',
      ),
      event(
        'value_change',
        seedText.date20251231,
        'Ocenění pro refinancování úvěru podle znaleckého posudku č. 214/2025',
        { documentRef: 'ZP-214/2025', newValueMinor: kc(61_200_000), previousValueMinor: kc(48_500_000) },
        finance,
      ),
    ],
    inventoryNumber: 'BUD-001',
    kind: 'building',
    name: 'Bytový dům Rezidence Parková',
    placedInServiceDate: seedText.date20190701,
    responsible: 'Ing. Petra Malá (správa nemovitostí)',
    services: [
      service({
        kind: 'permit',
        nextDueOn: '2027-01-31',
        note: 'Nástavba 5. NP – podáno na stavební úřad Praha 4',
        permitState: 'in_progress',
        responsible: 'Ing. Petra Malá',
        title: 'Stavební povolení – nástavba 5. NP',
      }),
      service({
        kind: 'inspection',
        nextDueOn: '2027-04-30',
        performedOn: '2026-04-28',
        responsible: 'Ing. Petra Malá',
        result: 'ok',
        supplier: 'Statika Novák s.r.o.',
        title: 'Prohlídka statiky a fasády',
      }),
      service({
        kind: 'revision',
        nextDueOn: '2026-11-05',
        performedOn: '2025-11-05',
        result: 'ok',
        supplier: 'Hromosvody Praha',
        title: 'Revize hromosvodu',
      }),
    ],
  }),
  asset(2, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20210301,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(126_000_000),
    category: 'Administrativní budova',
    createdOn: seedText.date20260902,
    currentValueDate: seedText.date20251231,
    currentValueMinor: kc(134_500_000),
    depreciationPlans: [
      plan({
        baseMinor: kc(126_000_000),
        confirmedOn: '2021-04-30',
        createdOn: '2021-03-20',
        entries: [
          ['2021', 2_100_000, 'ID-2021-044', false, 'Poměrná část roku'],
          ...yearly(2022, 2025, 2_520_000, 'ID-ODP'),
        ],
        interval: 'yearly',
        method: seedText.rovnomerny,
        startDate: seedText.date20210301,
        status: 'confirmed',
        type: 'accounting',
        years: 50,
      }),
      plan({
        baseMinor: kc(126_000_000),
        createdOn: '2021-03-20',
        interval: 'yearly',
        method: seedText.rovnomerny31Zdp,
        note: 'Čeká na potvrzení daňovým poradcem; částky zatím nezadány.',
        startDate: seedText.date20210301,
        status: 'draft',
        taxGroup: '6',
        type: 'tax',
        years: 50,
      }),
    ],
    events: [
      acquired(seedText.date20210301, 126_000_000, 'KS-2021/007 (kupní smlouva)'),
      event('ownership', '2021-03-18', 'Vklad vlastnického práva, řízení V-1234/2021', { documentRef: 'V-1234/2021' }),
      event('placed_in_service', seedText.date20210301, 'Zařazeno do užívání ke dni nabytí'),
      event(
        'value_change',
        seedText.date20251231,
        'Přecenění podle tržního ocenění pro banku (výnosová metoda)',
        { documentRef: 'ZP-301/2025', newValueMinor: kc(134_500_000), previousValueMinor: kc(126_000_000) },
        finance,
      ),
    ],
    inventoryNumber: 'BUD-002',
    kind: 'building',
    name: 'Administrativní budova Riverside Office Park',
    placedInServiceDate: seedText.date20210301,
    responsible: 'Tomáš Veselý (facility management)',
    services: [
      service({
        kind: 'permit',
        performedOn: '2025-08-12',
        permitState: 'granted',
        responsible: seedText.tomasVesely,
        title: 'Změna užívání 3. NP na kanceláře',
      }),
      service({
        kind: 'revision',
        nextDueOn: '2026-11-18',
        note: 'Drobné závady odstraněny do 30 dnů.',
        performedOn: '2023-11-18',
        result: 'defects',
        supplier: seedText.elektroRevizeCz,
        title: 'Revize elektroinstalace (budova)',
      }),
      service({
        documentRef: 'Revizní zpráva elektro – Riverside 2026',
        kind: 'revision',
        nextDueOn: '2029-09-18',
        note: 'Závady R1 a R2 dle revizní zprávy z 18. 9. 2026; odstranění dosud nepotvrzeno. Nahrazuje termín revize z roku 2023.',
        performedOn: '2026-09-18',
        responsible: seedText.tomasVesely,
        result: 'defects',
        supplier: 'Ing. Pavel Šťastný',
        title: 'Revize elektroinstalace (budova)',
      }),
      service({
        kind: 'inspection',
        nextDueOn: '2026-12-15',
        performedOn: seedText.date20251215,
        result: 'ok',
        supplier: 'HZS – odborně způsobilá osoba',
        title: 'Kontrola požárně bezpečnostních zařízení',
      }),
    ],
  }),
  asset(3, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20210301,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(18_400_000),
    category: 'Parkovací dům',
    createdOn: seedText.date20260902,
    currentValueDate: seedText.date20210301,
    currentValueMinor: kc(18_400_000),
    events: [acquired(seedText.date20210301, 18_400_000, 'KS-2021/007 (kupní smlouva, příloha 2)')],
    inventoryNumber: 'BUD-003',
    kind: 'building',
    name: 'Podzemní parkoviště Riverside (64 stání)',
    placedInServiceDate: seedText.date20210301,
    responsible: seedText.tomasVesely,
    services: [
      service({
        kind: 'revision',
        nextDueOn: '2026-11-05',
        performedOn: '2026-05-05',
        result: 'ok',
        supplier: 'Hörmann servis',
        title: 'Revize garážových vrat',
      }),
      service({
        kind: 'inspection',
        nextDueOn: '2027-02-10',
        performedOn: '2026-02-10',
        result: 'ok',
        supplier: 'Detekce CO Praha',
        title: 'Kontrola detekce CO a odvětrání',
      }),
    ],
  }),
  // ── Technologie ──────────────────────────────────────────────────────────────────────────────────────
  asset(4, {
    ...atProperty(parkova),
    acquisitionDate: seedText.date20190615,
    acquisitionMethod: 'construction',
    acquisitionValueMinor: kc(1_850_000),
    category: 'Vytápění',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20190615,
    currentValueMinor: kc(1_850_000),
    depreciationPlans: [
      plan({
        baseMinor: kc(1_850_000),
        confirmedOn: seedText.date20190930,
        createdOn: seedText.date20190715,
        entries: [['2019', 61_700, 'ID-2019-119'], ...yearly(2020, 2025, 123_300, 'ID-ODP')],
        interval: 'yearly',
        method: seedText.rovnomerny,
        startDate: seedText.date20190701,
        status: 'confirmed',
        type: 'accounting',
        years: 15,
      }),
      plan({
        baseMinor: kc(1_850_000),
        confirmedOn: seedText.date20190930,
        createdOn: seedText.date20190715,
        entries: [['2019', 102_100, 'DP-2019'], ...yearly(2020, 2025, 194_200, 'DP')],
        interval: 'yearly',
        method: seedText.rovnomerny31Zdp,
        startDate: seedText.date20190701,
        status: 'confirmed',
        taxGroup: '3',
        type: 'tax',
        years: 10,
      }),
    ],
    events: [
      acquired(seedText.date20190615, 1_850_000, 'Předávací protokol PP-K-01'),
      event('placed_in_service', seedText.date20190701, 'Uvedení do provozu'),
    ],
    inventoryNumber: 'TEC-001',
    kind: 'technology',
    name: 'Plynová kotelna Viessmann Vitocrossal 200 (2× 160 kW)',
    placedInServiceDate: seedText.date20190701,
    responsible: 'Jan Dvořák (technik)',
    serialNumber: 'VC200-7731-0451',
    services: [
      service({
        kind: 'revision',
        nextDueOn: seedText.date20261112,
        performedOn: '2025-11-12',
        result: 'ok',
        supplier: 'Plynservis Morava s.r.o.',
        title: 'Revize plynového zařízení',
      }),
      service({
        kind: 'service',
        nextDueOn: '2027-09-20',
        performedOn: '2026-09-20',
        result: 'ok',
        supplier: 'Viessmann servis',
        title: 'Roční servis kotlů a čištění',
      }),
      service({
        kind: 'inspection',
        nextDueOn: '2026-10-10',
        performedOn: '2024-10-10',
        result: 'ok',
        supplier: 'Kominictví Šťastný',
        title: 'Kontrola spalinové cesty',
      }),
    ],
  }),
  asset(5, {
    ...atProperty(parkova),
    acquisitionDate: seedText.date20190615,
    acquisitionMethod: 'construction',
    acquisitionValueMinor: kc(1_420_000),
    category: 'Výtahy',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20190615,
    currentValueMinor: kc(1_420_000),
    events: [acquired(seedText.date20190615, 1_420_000, 'Předávací protokol PP-V-01')],
    inventoryNumber: 'TEC-002',
    kind: 'technology',
    name: 'Osobní výtah Schindler 3300',
    placedInServiceDate: seedText.date20190701,
    responsible: seedText.janDvorak,
    serialNumber: 'SCH3300-55821',
    services: [
      service({
        kind: 'inspection',
        nextDueOn: '2026-10-28',
        performedOn: '2026-07-28',
        result: 'ok',
        supplier: 'Schindler CZ',
        title: seedText.odbornaProhlidkaVytahuCtvrtletni,
      }),
      service({
        kind: 'revision',
        nextDueOn: '2027-03-15',
        performedOn: '2024-03-15',
        result: 'ok',
        supplier: 'TÜV SÜD Czech',
        title: 'Odborná zkouška výtahu (3 roky)',
      }),
    ],
  }),
  asset(6, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20210301,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(1_980_000),
    category: 'Výtahy',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20210301,
    currentValueMinor: kc(1_980_000),
    events: [acquired(seedText.date20210301, 1_980_000, seedText.ks2021007Priloha5)],
    inventoryNumber: 'TEC-003',
    kind: 'technology',
    name: 'Výtah KONE MonoSpace 500 – jádro A',
    placedInServiceDate: seedText.date20210301,
    responsible: seedText.tomasVesely,
    serialNumber: 'KONE-MS5-24410',
    services: [
      service({
        kind: 'inspection',
        nextDueOn: seedText.date20261112,
        performedOn: '2026-08-12',
        result: 'ok',
        supplier: 'KONE a.s.',
        title: seedText.odbornaProhlidkaVytahuCtvrtletni,
      }),
    ],
  }),
  asset(7, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20210301,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(1_980_000),
    category: 'Výtahy',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20210301,
    currentValueMinor: kc(1_980_000),
    events: [acquired(seedText.date20210301, 1_980_000, seedText.ks2021007Priloha5)],
    inventoryNumber: 'TEC-004',
    kind: 'technology',
    name: 'Výtah KONE MonoSpace 500 – jádro B',
    placedInServiceDate: seedText.date20210301,
    responsible: seedText.tomasVesely,
    serialNumber: 'KONE-MS5-24411',
    services: [
      service({
        kind: 'inspection',
        nextDueOn: seedText.date20261112,
        note: 'Opotřebené vodicí čelisti – objednána výměna.',
        performedOn: '2026-08-12',
        result: 'defects',
        supplier: 'KONE a.s.',
        title: seedText.odbornaProhlidkaVytahuCtvrtletni,
      }),
    ],
  }),
  asset(8, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20230510,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(2_160_000),
    category: 'Vzduchotechnika',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20230510,
    currentValueMinor: kc(2_160_000),
    depreciationPlans: [
      plan({
        baseMinor: kc(2_160_000),
        confirmedOn: '2026-01-31',
        createdOn: '2026-01-15',
        entries: Array.from(
          { length: 9 },
          (_, index) =>
            [
              `2026-${String(index + 1).padStart(2, '0')}`,
              15_000,
              `ID-2026-${String(index + 1).padStart(2, '0')}-VZT`,
            ] as const,
        ),
        interval: 'monthly',
        method: 'Rovnoměrný (měsíční)',
        note: 'Od 2026 účtováno měsíčně podle pokynu účetní.',
        startDate: '2026-01-01',
        status: 'confirmed',
        type: 'accounting',
        years: 12,
      }),
    ],
    events: [
      acquired(seedText.date20230510, 2_160_000, 'FP-2023-0518'),
      event('placed_in_service', '2023-06-01', 'Uvedení do provozu po zaregulování'),
    ],
    inventoryNumber: 'TEC-005',
    kind: 'technology',
    name: 'Vzduchotechnická jednotka Atrea Duplex 8000',
    placedInServiceDate: '2023-06-01',
    responsible: seedText.tomasVesely,
    serialNumber: 'ATR-D8000-1193',
    services: [
      service({
        kind: 'service',
        nextDueOn: '2026-11-30',
        performedOn: '2026-05-30',
        result: 'ok',
        supplier: 'Atrea servis',
        title: 'Výměna filtrů a servis VZT',
      }),
    ],
  }),
  asset(9, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20220420,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(1_340_000),
    category: 'Chlazení',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20220420,
    currentValueMinor: kc(1_340_000),
    events: [acquired(seedText.date20220420, 1_340_000, 'FP-2022-0412')],
    inventoryNumber: 'TEC-006',
    kind: 'technology',
    name: 'Chladicí jednotka Daikin EWAD-TZ',
    placedInServiceDate: '2022-05-01',
    responsible: seedText.tomasVesely,
    serialNumber: 'DKN-EWAD-88310',
    services: [
      service({
        kind: 'inspection',
        nextDueOn: '2027-04-15',
        performedOn: '2026-04-15',
        result: 'ok',
        supplier: 'Klima Servis Praha',
        title: 'Kontrola těsnosti chladiva (F-plyny)',
      }),
    ],
  }),
  asset(10, {
    ...atProperty(parkova),
    acquisitionDate: seedText.date20240601,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(890_000),
    category: 'Energetika',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20240601,
    currentValueMinor: kc(890_000),
    depreciationPlans: [
      plan({
        baseMinor: kc(890_000),
        createdOn: '2026-10-01',
        interval: 'yearly',
        method: seedText.rovnomerny,
        note: 'Návrh – čeká na potvrzení vedením.',
        startDate: seedText.date20240701,
        status: 'draft',
        type: 'accounting',
        years: 20,
      }),
    ],
    events: [
      acquired(seedText.date20240601, 890_000, 'FP-2024-0601'),
      event('placed_in_service', seedText.date20240701, 'Připojení k distribuční soustavě PREdistribuce'),
    ],
    inventoryNumber: 'TEC-007',
    kind: 'technology',
    name: 'Fotovoltaická elektrárna 30 kWp (střecha)',
    placedInServiceDate: seedText.date20240701,
    responsible: seedText.janDvorak,
    services: [
      service({
        kind: 'revision',
        nextDueOn: '2028-06-20',
        performedOn: '2024-06-20',
        result: 'ok',
        supplier: 'Solar Revize s.r.o.',
        title: 'Výchozí revize FVE',
      }),
      service({
        kind: 'service',
        nextDueOn: '2027-05-15',
        performedOn: '2026-05-15',
        result: 'ok',
        supplier: 'Solar Revize s.r.o.',
        title: 'Čištění panelů a termovize',
      }),
    ],
  }),
  asset(11, {
    ...atUnit('S01'),
    acquisitionDate: seedText.date20210301,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(760_000),
    category: 'Elektro',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20210301,
    currentValueMinor: kc(760_000),
    events: [acquired(seedText.date20210301, 760_000, seedText.ks2021007Priloha5)],
    inventoryNumber: 'TEC-008',
    kind: 'technology',
    name: 'Hlavní rozvodna NN',
    placedInServiceDate: seedText.date20210301,
    responsible: seedText.tomasVesely,
    services: [
      service({
        kind: 'revision',
        nextDueOn: '2026-12-03',
        performedOn: '2023-12-03',
        result: 'ok',
        supplier: seedText.elektroRevizeCz,
        title: 'Revize rozvodny NN',
      }),
    ],
  }),
  asset(12, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20220915,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(1_120_000),
    category: 'Energetika',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20220915,
    currentValueMinor: kc(1_120_000),
    events: [acquired(seedText.date20220915, 1_120_000, 'FP-2022-0915')],
    inventoryNumber: 'TEC-009',
    kind: 'technology',
    name: 'Záložní dieselagregát Cummins C150 D5',
    placedInServiceDate: '2022-10-01',
    responsible: seedText.tomasVesely,
    serialNumber: 'CUM-C150-77120',
    services: [
      service({
        kind: 'inspection',
        nextDueOn: '2026-10-15',
        performedOn: '2026-04-15',
        result: 'ok',
        supplier: 'Cummins servis',
        title: 'Zkouška pod zatížením (pololetní)',
      }),
    ],
  }),
  asset(13, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20230201,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(640_000),
    category: 'Měření a regulace',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20230201,
    currentValueMinor: kc(640_000),
    events: [acquired(seedText.date20230201, 640_000, 'FP-2023-0201')],
    inventoryNumber: 'TEC-010',
    kind: 'technology',
    name: 'Systém MaR Siemens Desigo CC',
    placedInServiceDate: '2023-02-15',
    responsible: seedText.tomasVesely,
    services: [
      service({
        kind: 'service',
        nextDueOn: '2027-02-15',
        performedOn: '2026-02-15',
        result: 'ok',
        supplier: 'Siemens Smart Infrastructure',
        title: 'Aktualizace a servis řídicího systému',
      }),
    ],
  }),
  asset(14, {
    ...atProperty(parkova),
    acquisitionDate: seedText.date20190615,
    acquisitionMethod: 'construction',
    acquisitionValueMinor: kc(285_000),
    category: 'Voda',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20190615,
    currentValueMinor: kc(285_000),
    events: [acquired(seedText.date20190615, 285_000, 'Předávací protokol PP-VO-01')],
    inventoryNumber: 'TEC-011',
    kind: 'technology',
    name: 'Domácí vodárna a změkčovač vody',
    placedInServiceDate: seedText.date20190701,
    responsible: seedText.janDvorak,
    services: [
      service({
        kind: 'service',
        nextDueOn: '2027-01-20',
        performedOn: '2026-07-20',
        result: 'ok',
        supplier: 'Aqua Servis',
        title: 'Regenerace a servis změkčovače',
      }),
    ],
  }),
  asset(15, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20250312,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(214_000),
    category: 'Elektromobilita',
    createdOn: seedText.date20260903,
    currentValueDate: seedText.date20250312,
    currentValueMinor: kc(214_000),
    events: [acquired(seedText.date20250312, 214_000, 'FP-2025-0312')],
    inventoryNumber: 'TEC-012',
    kind: 'technology',
    name: 'Nabíjecí stanice ABB Terra AC (2× 22 kW)',
    placedInServiceDate: '2025-03-20',
    responsible: seedText.tomasVesely,
    services: [
      service({
        kind: 'revision',
        nextDueOn: '2027-03-20',
        performedOn: '2025-03-20',
        result: 'ok',
        supplier: seedText.elektroRevizeCz,
        title: 'Výchozí revize nabíjecích stanic',
      }),
    ],
  }),
  // ── Vybavení ─────────────────────────────────────────────────────────────────────────────────────────
  asset(16, {
    ...atUnit('A101'),
    acquisitionDate: seedText.date20190620,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(186_000),
    category: 'Kuchyně',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20190620,
    currentValueMinor: kc(186_000),
    events: [acquired(seedText.date20190620, 186_000, 'FP-2019-0620')],
    inventoryNumber: 'VYB-001',
    kind: 'equipment',
    name: 'Kuchyňská linka se spotřebiči – byt A101',
    responsible: seedText.janDvorak,
  }),
  asset(17, {
    ...atUnit('A102'),
    acquisitionDate: seedText.date20190620,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(214_000),
    category: 'Kuchyně',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20190620,
    currentValueMinor: kc(214_000),
    events: [acquired(seedText.date20190620, 214_000, 'FP-2019-0620')],
    inventoryNumber: 'VYB-002',
    kind: 'equipment',
    name: 'Kuchyňská linka se spotřebiči – byt A102',
    responsible: seedText.janDvorak,
  }),
  asset(18, {
    ...atUnit('A201'),
    acquisitionDate: seedText.date20220801,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(96_500),
    category: 'Nábytek',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20220801,
    currentValueMinor: kc(96_500),
    events: [acquired(seedText.date20220801, 96_500, 'FP-2022-0801')],
    inventoryNumber: 'VYB-003',
    kind: 'equipment',
    name: 'Vybavení bytu A201 (nábytek, svítidla)',
    responsible: seedText.janDvorak,
  }),
  asset(19, {
    ...atProperty(parkova),
    acquisitionDate: seedText.date20230116,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(78_900),
    category: 'Prádelna',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20230116,
    currentValueMinor: kc(78_900),
    events: [acquired(seedText.date20230116, 78_900, 'FP-2023-0116')],
    inventoryNumber: 'VYB-004',
    kind: 'equipment',
    name: 'Profesionální pračka Miele PWM 908',
    responsible: seedText.janDvorak,
    serialNumber: 'MIE-908-44120',
    services: [
      service({
        kind: 'service',
        nextDueOn: '2027-01-16',
        performedOn: '2026-01-16',
        result: 'ok',
        supplier: 'Miele Professional',
        title: 'Roční servis pračky',
      }),
    ],
  }),
  asset(20, {
    ...atUnit('R101'),
    acquisitionDate: seedText.date20210412,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(142_000),
    category: 'Nábytek',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20210412,
    currentValueMinor: kc(142_000),
    events: [acquired(seedText.date20210412, 142_000, 'FP-2021-0412')],
    inventoryNumber: 'VYB-005',
    kind: 'equipment',
    name: 'Recepční pult a vybavení vstupní haly',
    responsible: seedText.tomasVesely,
  }),
  asset(21, {
    ...atUnit('R201'),
    acquisitionDate: seedText.date20210503,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(238_000),
    category: 'Nábytek',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20210503,
    currentValueMinor: kc(238_000),
    events: [acquired(seedText.date20210503, 238_000, 'FP-2021-0503')],
    inventoryNumber: 'VYB-006',
    kind: 'equipment',
    name: 'Kancelářský nábytek – kancelář R201',
    responsible: seedText.tomasVesely,
  }),
  asset(22, {
    ...atUnit('R301'),
    acquisitionDate: seedText.date20240214,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(124_500),
    category: 'AV technika',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20240214,
    currentValueMinor: kc(124_500),
    events: [acquired(seedText.date20240214, 124_500, 'FP-2024-0214')],
    inventoryNumber: 'VYB-007',
    kind: 'equipment',
    name: 'Konferenční technika (projektor Epson, ozvučení)',
    responsible: seedText.tomasVesely,
    serialNumber: 'EPS-EB-L630-2291',
  }),
  asset(23, {
    ...atUnit('S01'),
    acquisitionDate: seedText.date20210601,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(165_000),
    category: 'Sklad',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20260430,
    currentValueMinor: kc(130_000),
    depreciationPlans: [
      plan({
        baseMinor: kc(165_000),
        confirmedOn: '2021-06-30',
        createdOn: '2021-06-10',
        entries: [
          ['2021', 13_750, 'ID-2021-ODP'],
          ['2022', 16_500, 'ID-2022-ODP'],
          ['2023', 16_500, 'ID-2023-ODP'],
          ['2024', 16_500, 'ID-2024-ODP'],
          ['2025', 16_500, 'ID-2025-ODP'],
          [
            '2026',
            35_000,
            'PS-2026-04',
            true,
            'Odpis části hodnoty – poškození regálu při manipulaci',
            seedText.date20260430,
          ],
        ],
        interval: 'yearly',
        method: seedText.rovnomerny,
        startDate: seedText.date20210601,
        status: 'confirmed',
        type: 'accounting',
        years: 10,
      }),
    ],
    events: [
      acquired(seedText.date20210601, 165_000, 'FP-2021-0601'),
      event(
        'value_change',
        seedText.date20260430,
        'Poškození dvou polí regálu vysokozdvižným vozíkem, snížení evidované hodnoty',
        { documentRef: 'PS-2026-04', newValueMinor: kc(130_000), previousValueMinor: kc(165_000) },
        operations,
      ),
    ],
    inventoryNumber: 'VYB-008',
    kind: 'equipment',
    name: 'Paletový regálový systém',
    responsible: seedText.tomasVesely,
    services: [
      service({
        kind: 'inspection',
        nextDueOn: '2026-11-25',
        note: 'Poškozená pole označena a vyřazena z provozu.',
        performedOn: '2025-11-25',
        result: 'defects',
        supplier: 'Regály Revize s.r.o.',
        title: 'Roční kontrola regálů (ČSN EN 15635)',
      }),
    ],
  }),
  asset(24, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20221107,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(68_400),
    category: 'Úklid',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20221107,
    currentValueMinor: kc(68_400),
    events: [acquired(seedText.date20221107, 68_400, 'FP-2022-1107')],
    inventoryNumber: 'VYB-009',
    kind: 'equipment',
    name: 'Podlahový mycí stroj Kärcher B 40',
    responsible: seedText.tomasVesely,
    serialNumber: 'KAR-B40-301877',
  }),
  asset(25, {
    ...atProperty(parkova),
    acquisitionDate: seedText.date20200403,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(89_900),
    category: 'Zahrada',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20200403,
    currentValueMinor: kc(89_900),
    events: [acquired(seedText.date20200403, 89_900, 'FP-2020-0403')],
    inventoryNumber: 'VYB-010',
    kind: 'equipment',
    name: 'Zahradní traktor Husqvarna TC 242T',
    responsible: seedText.janDvorak,
    services: [
      service({
        kind: 'service',
        nextDueOn: '2027-03-31',
        performedOn: '2026-03-31',
        result: 'ok',
        supplier: 'Husqvarna servis Praha',
        title: 'Předsezónní servis',
      }),
    ],
  }),
  asset(26, {
    ...atUnit('R101'),
    acquisitionDate: seedText.date20210412,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(42_900),
    category: 'Kuchyňka',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20210412,
    currentValueMinor: kc(42_900),
    disposal: {
      date: seedText.date20260630,
      documentRef: 'LP-2026-06',
      kind: 'liquidation',
      reason: 'Neopravitelná závada spařovací jednotky, ekologická likvidace',
    },
    events: [
      acquired(seedText.date20210412, 42_900, 'FP-2021-0412'),
      event(
        'liquidation',
        seedText.date20260630,
        'Neopravitelná závada spařovací jednotky, ekologická likvidace',
        { documentRef: 'LP-2026-06', previousValueMinor: kc(42_900) },
        operations,
      ),
    ],
    inventoryNumber: 'VYB-011',
    kind: 'equipment',
    name: 'Kávovar Jura GIGA X3 – recepce',
    status: 'disposed',
  }),
  asset(27, {
    ...atProperty(riverside),
    acquisitionDate: seedText.date20220110,
    acquisitionMethod: 'purchase',
    acquisitionValueMinor: kc(38_500),
    category: 'IT',
    createdOn: seedText.date20260904,
    currentValueDate: seedText.date20220110,
    currentValueMinor: kc(38_500),
    disposal: {
      date: '2026-03-18',
      documentRef: 'FV-2026-0318',
      kind: 'sale',
      proceedsMinor: kc(4500),
      reason: 'Prodej zaměstnanci po obměně techniky',
    },
    events: [
      acquired(seedText.date20220110, 38_500, 'FP-2022-0110'),
      event(
        'sale',
        '2026-03-18',
        'Prodej zaměstnanci po obměně techniky',
        { documentRef: 'FV-2026-0318', newValueMinor: kc(4500), previousValueMinor: kc(38_500) },
        finance,
      ),
    ],
    inventoryNumber: 'VYB-012',
    kind: 'equipment',
    name: 'Notebook správce areálu Lenovo ThinkPad T14',
    status: 'disposed',
  }),
];

const item = (
  index: number,
  name: string,
  inventoryNumber: string,
  result: 'pending' | 'found' | 'missing' | 'difference',
  extra: Partial<EncodedInventoryItem> = {},
): EncodedInventoryItem => {
  const checked: Partial<MutableInventoryItem> = {};
  if (result !== 'pending') {
    checked.checkedAt = ts(seedText.date20261018, '10:15:00');
    checked.checkedBy = operations;
  }
  return { assetId: assetId(index), inventoryNumber, name, result, ...checked, ...extra };
};

const buildInventories = (): EncodedInventory[] => [
  {
    closedAt: ts('2025-12-16', '15:00:00'),
    createdAt: ts(seedText.date20251215, '08:00:00'),
    createdBy: operations,
    date: seedText.date20251215,
    id: 'seed-inventory-2025-parkova',
    items: [
      {
        ...item(1, 'Bytový dům Rezidence Parková', 'BUD-001', 'found'),
        checkedAt: ts(seedText.date20251215, '10:00:00'),
      },
      {
        ...item(4, 'Plynová kotelna Viessmann Vitocrossal 200 (2× 160 kW)', 'TEC-001', 'found'),
        checkedAt: ts(seedText.date20251215, '10:20:00'),
      },
      {
        ...item(5, 'Osobní výtah Schindler 3300', 'TEC-002', 'found'),
        checkedAt: ts(seedText.date20251215, '10:30:00'),
      },
      {
        ...item(14, 'Domácí vodárna a změkčovač vody', 'TEC-011', 'found'),
        checkedAt: ts(seedText.date20251215, '10:40:00'),
      },
      {
        ...item(16, 'Kuchyňská linka se spotřebiči – byt A101', 'VYB-001', 'found'),
        checkedAt: ts(seedText.date20251215, '11:00:00'),
      },
      {
        ...item(17, 'Kuchyňská linka se spotřebiči – byt A102', 'VYB-002', 'found'),
        checkedAt: ts(seedText.date20251215, '11:10:00'),
      },
      {
        ...item(18, 'Vybavení bytu A201 (nábytek, svítidla)', 'VYB-003', 'difference', {
          followUp: {
            assignee: seedText.janDvorak,
            createdAt: ts(seedText.date20251215, '11:30:00'),
            createdBy: operations,
            dueDate: '2026-01-15',
            id: 'seed-followup-a201',
            resolution: 'Chybějící stojací lampa nalezena ve sklepní kóji, vrácena do bytu.',
            resolvedAt: ts('2026-01-09', '13:00:00'),
            resolvedBy: operations,
            status: 'done',
            title: 'Dohledat chybějící stojací lampu z bytu A201',
          },
          note: 'Chybí 1 ks stojací lampy',
        }),
        checkedAt: ts(seedText.date20251215, '11:20:00'),
      },
      {
        ...item(19, 'Profesionální pračka Miele PWM 908', 'VYB-004', 'found'),
        checkedAt: ts(seedText.date20251215, '11:40:00'),
      },
      {
        ...item(25, 'Zahradní traktor Husqvarna TC 242T', 'VYB-010', 'found'),
        checkedAt: ts(seedText.date20251215, '12:00:00'),
      },
    ],
    note: 'Roční inventura k 31. 12. 2025.',
    scope: atProperty(parkova).location,
    status: 'closed',
    title: 'Inventura 2025 – Rezidence Parková',
    updatedAt: ts('2025-12-16', '15:00:00'),
    updatedBy: operations,
  },
  {
    createdAt: ts(seedText.date20261018, '08:00:00'),
    createdBy: operations,
    date: seedText.date20261018,
    id: 'seed-inventory-2026-riverside',
    items: [
      item(2, 'Administrativní budova Riverside Office Park', 'BUD-002', 'found'),
      item(3, 'Podzemní parkoviště Riverside (64 stání)', 'BUD-003', 'found'),
      item(6, 'Výtah KONE MonoSpace 500 – jádro A', 'TEC-003', 'found'),
      item(7, 'Výtah KONE MonoSpace 500 – jádro B', 'TEC-004', 'found'),
      item(8, 'Vzduchotechnická jednotka Atrea Duplex 8000', 'TEC-005', 'found'),
      item(9, 'Chladicí jednotka Daikin EWAD-TZ', 'TEC-006', 'pending'),
      item(11, 'Hlavní rozvodna NN', 'TEC-008', 'found'),
      item(12, 'Záložní dieselagregát Cummins C150 D5', 'TEC-009', 'pending'),
      item(13, 'Systém MaR Siemens Desigo CC', 'TEC-010', 'pending'),
      item(15, 'Nabíjecí stanice ABB Terra AC (2× 22 kW)', 'TEC-012', 'pending'),
      item(20, 'Recepční pult a vybavení vstupní haly', 'VYB-005', 'found'),
      item(21, 'Kancelářský nábytek – kancelář R201', 'VYB-006', 'found'),
      item(22, 'Konferenční technika (projektor Epson, ozvučení)', 'VYB-007', 'missing', {
        followUp: {
          assignee: seedText.tomasVesely,
          createdAt: ts(seedText.date20261018, '10:40:00'),
          createdBy: operations,
          dueDate: '2026-10-27',
          id: 'seed-followup-r301',
          status: 'open',
          title: 'Dohledat projektor Epson z kanceláře R301',
        },
        note: 'Projektor není v R301; nájemce uvádí, že jej převzal facility management.',
      }),
      item(23, 'Paletový regálový systém', 'VYB-008', 'difference', {
        note: 'Dvě pole regálu demontována po poškození, v evidenci stále jako kompletní.',
      }),
      item(24, 'Podlahový mycí stroj Kärcher B 40', 'VYB-009', 'pending'),
    ],
    note: 'Mimořádná inventura před změnou nájemce v R301.',
    scope: atProperty(riverside).location,
    status: 'open',
    title: 'Inventura 2026 – Riverside Office Park',
    updatedAt: ts(seedText.date20261018, '10:40:00'),
    updatedBy: operations,
  },
];

const buildTemplates = (): NonNullable<AssetsStateEncoded['templates']> => [
  {
    createdAt: ts(seedText.date20260112),
    createdBy: finance,
    id: 'seed-template-budovy',
    interval: 'yearly',
    method: seedText.rovnomerny,
    name: 'Budovy – účetní, 50 let',
    note: 'Podle účetní politiky Nájemparku, schváleno 12. 1. 2026.',
    type: 'accounting',
    years: 50,
  },
  {
    createdAt: ts(seedText.date20260112),
    createdBy: finance,
    id: 'seed-template-technologie',
    interval: 'yearly',
    method: seedText.rovnomerny31Zdp,
    name: 'Technologie – daňová skupina 3, 10 let',
    taxGroup: '3',
    type: 'tax',
    years: 10,
  },
  {
    createdAt: ts(seedText.date20260112),
    createdBy: finance,
    id: 'seed-template-vybaveni',
    interval: 'yearly',
    method: seedText.rovnomerny,
    name: 'Vybavení – účetní, 6 let',
    type: 'accounting',
    years: 6,
  },
];

/** S15 plán investic: plausible investments of both properties (two completed with actual amounts). */
export const seedInvestments = (): EncodedInvestment[] => {
  const stamp = (date: string, by = management) => ({
    createdAt: ts(date, '08:30:00'),
    createdBy: by,
    updatedAt: ts(date, '08:30:00'),
    updatedBy: by,
  });
  return [
    {
      ...stamp('2026-01-20'),
      ...atProperty(parkova),
      actualAmountMinor: kc(412_600),
      actualDate: '2026-06-18',
      assetId: assetId(4),
      description: 'Výměna hořáků a regulace plynové kotelny, nová ekvitermní regulace.',
      id: 'seed-investment-001',
      plannedAmountMinor: kc(380_000),
      plannedDate: seedText.date20260630,
      priority: 'high',
      responsible: 'Ing. Pavel Dvořák',
      status: 'done',
      title: 'Modernizace kotelny Rezidence Parková',
    },
    {
      ...stamp('2026-02-03'),
      ...atProperty(riverside),
      actualAmountMinor: kc(168_900),
      actualDate: '2026-08-29',
      description: 'LED svítidla s čidly pohybu v garážích a na chodbách, snížení spotřeby elektřiny.',
      id: 'seed-investment-002',
      plannedAmountMinor: kc(185_000),
      plannedDate: '2026-09-15',
      priority: 'medium',
      responsible: 'Provoz Nájempark',
      status: 'done',
      title: 'LED osvětlení garáží Riverside',
    },
    {
      ...stamp('2026-03-11'),
      ...atProperty(riverside),
      description: 'Výměna řídicí jednotky a lan osobního výtahu po revizní zprávě.',
      id: 'seed-investment-003',
      plannedAmountMinor: kc(640_000),
      plannedDate: '2026-11-30',
      priority: 'high',
      responsible: 'Ing. Pavel Dvořák',
      status: 'approved',
      title: 'Rekonstrukce výtahu Riverside',
    },
    {
      ...stamp('2026-04-07'),
      ...atUnit('A102'),
      description: 'Nová koupelna a podlahy před dalším pronájmem bytu A102.',
      id: 'seed-investment-004',
      plannedAmountMinor: kc(295_000),
      plannedDate: '2027-02-28',
      priority: 'medium',
      status: 'planned',
      title: 'Rekonstrukce bytu A102',
    },
    {
      ...stamp('2026-05-19', finance),
      ...atProperty(parkova),
      description: 'Fotovoltaika 30 kWp na střeše bytového domu, varianta s baterií.',
      id: 'seed-investment-005',
      plannedAmountMinor: kc(1_150_000),
      plannedDate: '2027-06-30',
      priority: 'low',
      responsible: 'Management Nájempark',
      status: 'planned',
      title: 'Fotovoltaická elektrárna na střeše',
    },
  ];
};

export const seedAssetsState = (): AssetsStateEncoded => {
  sequence = 0;
  return {
    assets: buildAssets(),
    inventories: buildInventories(),
    investments: seedInvestments(),
    templates: buildTemplates(),
  };
};
