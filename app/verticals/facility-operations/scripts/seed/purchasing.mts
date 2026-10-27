// Seed of agenda `purchasing` for Siampark (legal entity …0021). OWNED BY THE `purchasing` LANE (ops-purchasing).
// The seed is a replay of real commands through the same pure reducer the Action uses, so every number in the
// demo (stock on hand, partial deliveries, remaining quantities) is produced by the production rules.
// Deterministic: fixed resource ids and timestamps. Returns the ENCODED state.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Effect, Schema } from 'effect';
import type { OpsCommandInput } from '../../shared/domain/common.ts';
import { optionalField } from '../../shared/domain/common.ts';
import { PurchasingCommandSchema, evolvePurchasing } from '../../shared/commands/purchasing.ts';
import { PurchasingStateSchema, emptyPurchasingState } from '../../shared/domain/purchasing.ts';

const seedText = {
  date20260919: '2026-09-19',
  labelPropertyParkova: 'label:property-parkova',
  labelPropertyRiverside: 'label:property-riverside',
  naclo2607B: 'NaClO-2607-B',
  rezidenceParkovaParkova: 'Rezidence Parková (PARKOVA)',
  riversideOfficeParkKancelarR201R201: 'Riverside Office Park › Kancelář R201 (R201)',
  riversideOfficeParkRiverside: 'Riverside Office Park (RIVERSIDE)',
  seedPoAq: 'seed-po-aq',
  seedPoEl: 'seed-po-el',
  seedPoFi: 'seed-po-fi',
} as const;

const tenantId = '70000000-0000-4000-8000-000000000020';
const management = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };

type CommandInput = typeof PurchasingCommandSchema.Encoded;
interface Step {
  readonly at: string;
  readonly by?: typeof management;
  readonly command: CommandInput;
  readonly id: string;
}

const W = { chem: 'seed-wh-bz', main: 'seed-wh-tz', sanitary: 'seed-wh-uk' } as const;
const S = {
  aqua: 'seed-sup-aquachem',
  elektro: 'seed-sup-elektro',
  filtrace: 'seed-sup-filtrace',
  hygiena: 'seed-sup-hygiena',
  kovo: 'seed-sup-kovo',
} as const;
const item = (code: string) => `seed-item-${code.toLowerCase()}`;
const unitRef = (code: string, label: string) => ({
  id: `label:unit-${code.toLowerCase()}`,
  kind: 'unit' as const,
  label,
});
const taskRef = (key: string, label: string) => ({ id: `label:task-${key}`, kind: 'task' as const, label });

const steps: Step[] = [];
let counter = 0;
const add = (at: string, command: CommandInput, id?: string, by = management) => {
  counter += 1;
  steps.push({ at, by, command, id: id ?? `seed-purchasing-${String(counter).padStart(3, '0')}` });
};

// ── Sklady ─────────────────────────────────────────────────────────────────────────────────────────────────────
add(
  '2026-08-01T07:00:00Z',
  { _tag: 'StockWarehouseCreate', code: 'SKL-TZ', name: 'Hlavní sklad – technické zázemí' },
  W.main,
);
add(
  '2026-08-01T07:01:00Z',
  { _tag: 'StockWarehouseCreate', code: 'SKL-UK', name: 'Sklad úklidu a hygieny' },
  W.sanitary,
);
add(
  '2026-08-01T07:02:00Z',
  { _tag: 'StockWarehouseCreate', code: 'SKL-BZ', name: 'Strojovna bazénu – chemie' },
  W.chem,
);

// ── Dodavatelé ───────────────────────────────────────────────────────────────────────────────────────────────────
add(
  '2026-08-01T07:10:00Z',
  {
    _tag: 'PurchaseSupplierCreate',
    contact: 'Martina Křížová',
    email: 'objednavky@hygienapro.example',
    leadTimeDays: 5,
    name: 'HygienaPro CZ s.r.o.',
    phone: '+420 601 220 310',
  },
  S.hygiena,
);
add(
  '2026-08-01T07:11:00Z',
  {
    _tag: 'PurchaseSupplierCreate',
    contact: 'Ing. Tomáš Bureš',
    email: 'obchod@aquachem.example',
    leadTimeDays: 10,
    name: 'AquaChem Bohemia a.s.',
    note: 'Rámcová smlouva na bazénovou chemii, doprava zdarma nad 10 000 Kč.',
    phone: '+420 602 418 900',
  },
  S.aqua,
);
add(
  '2026-08-01T07:12:00Z',
  {
    _tag: 'PurchaseSupplierCreate',
    contact: 'Petr Šimánek',
    email: 'eshop@elektro-simanek.example',
    leadTimeDays: 7,
    name: 'Elektro Šimánek s.r.o.',
    phone: '+420 731 555 010',
  },
  S.elektro,
);
add(
  '2026-08-01T07:13:00Z',
  {
    _tag: 'PurchaseSupplierCreate',
    contact: 'Jiří Novák',
    email: 'novak@kovodilna.example',
    leadTimeDays: 21,
    name: 'Kovo Dílna Novák',
    phone: '+420 777 300 451',
  },
  S.kovo,
);
add(
  '2026-08-01T07:14:00Z',
  {
    _tag: 'PurchaseSupplierCreate',
    contact: 'Lenka Dvořáková',
    email: 'servis@filtraceplus.example',
    leadTimeDays: 10,
    name: 'Filtrace Plus s.r.o.',
    phone: '+420 608 112 233',
  },
  S.filtrace,
);

// ── Skladové položky (spotřební materiál, náhradní díly, chemie) ─────────────────────────────────────────────────
interface ItemSeed {
  readonly batch?: string;
  readonly category: 'consumable' | 'spare_part' | 'cleaning' | 'chemical' | 'tool';
  readonly leadTimeDays: number;
  readonly maximum: number;
  readonly minimum: number;
  readonly name: string;
  readonly note?: string;
  readonly opening: number;
  readonly price: number;
  readonly serialPrefix?: string;
  readonly sku: string;
  readonly supplierId?: string;
  readonly tracking: 'none' | 'batch' | 'serial';
  readonly unit: string;
  readonly warehouseId: string;
}
const items: ItemSeed[] = [
  {
    category: 'cleaning',
    leadTimeDays: 5,
    maximum: 120,
    minimum: 40,
    name: 'Toaletní papír 2vrstvý (bal. 8 rolí)',
    opening: 70,
    price: 15_900,
    sku: 'UK-001',
    supplierId: S.hygiena,
    tracking: 'none',
    unit: 'bal',
    warehouseId: W.sanitary,
  },
  {
    category: 'cleaning',
    leadTimeDays: 5,
    maximum: 60,
    minimum: 20,
    name: 'Papírové ručníky ZZ (karton)',
    opening: 30,
    price: 54_900,
    sku: 'UK-002',
    supplierId: S.hygiena,
    tracking: 'none',
    unit: 'karton',
    warehouseId: W.sanitary,
  },
  {
    batch: 'MY-2608-14',
    category: 'cleaning',
    leadTimeDays: 7,
    maximum: 30,
    minimum: 10,
    name: 'Tekuté mýdlo 5 l',
    opening: 16,
    price: 21_900,
    sku: 'UK-003',
    supplierId: S.hygiena,
    tracking: 'batch',
    unit: 'ks',
    warehouseId: W.sanitary,
  },
  {
    batch: 'DZ-2607-03',
    category: 'cleaning',
    leadTimeDays: 5,
    maximum: 72,
    minimum: 24,
    name: 'Dezinfekce povrchů 1 l',
    opening: 48,
    price: 8900,
    sku: 'UK-004',
    supplierId: S.hygiena,
    tracking: 'batch',
    unit: 'ks',
    warehouseId: W.sanitary,
  },
  {
    category: 'consumable',
    leadTimeDays: 5,
    maximum: 100,
    minimum: 30,
    name: 'Pytle na odpad 120 l (role 25 ks)',
    opening: 60,
    price: 12_900,
    sku: 'UK-005',
    supplierId: S.hygiena,
    tracking: 'none',
    unit: 'role',
    warehouseId: W.sanitary,
  },
  {
    category: 'consumable',
    leadTimeDays: 7,
    maximum: 60,
    minimum: 20,
    name: 'Posypová sůl 25 kg',
    note: 'Zimní údržba chodníků a parkoviště.',
    opening: 12,
    price: 18_500,
    sku: 'UK-006',
    supplierId: S.hygiena,
    tracking: 'none',
    unit: 'pytel',
    warehouseId: W.sanitary,
  },
  {
    batch: seedText.naclo2607B,
    category: 'chemical',
    leadTimeDays: 10,
    maximum: 24,
    minimum: 8,
    name: 'Chlornan sodný 25 kg (bazén)',
    opening: 14,
    price: 89_000,
    sku: 'BZ-001',
    supplierId: S.aqua,
    tracking: 'batch',
    unit: 'kanystr',
    warehouseId: W.chem,
  },
  {
    batch: 'PHM-2606-A',
    category: 'chemical',
    leadTimeDays: 10,
    maximum: 12,
    minimum: 4,
    name: 'pH mínus 25 kg',
    opening: 8,
    price: 129_000,
    sku: 'BZ-002',
    supplierId: S.aqua,
    tracking: 'batch',
    unit: 'kanystr',
    warehouseId: W.chem,
  },
  {
    batch: 'FL-2605-C',
    category: 'chemical',
    leadTimeDays: 10,
    maximum: 18,
    minimum: 6,
    name: 'Flokulant tekutý 5 l',
    opening: 8,
    price: 64_500,
    sku: 'BZ-003',
    supplierId: S.aqua,
    tracking: 'batch',
    unit: 'ks',
    warehouseId: W.chem,
  },
  {
    category: 'consumable',
    leadTimeDays: 10,
    maximum: 20,
    minimum: 5,
    name: 'Testovací tablety DPD1 (bal. 100 ks)',
    opening: 10,
    price: 42_000,
    sku: 'BZ-004',
    supplierId: S.aqua,
    tracking: 'none',
    unit: 'bal',
    warehouseId: W.chem,
  },
  {
    category: 'spare_part',
    leadTimeDays: 21,
    maximum: 3,
    minimum: 1,
    name: 'Oběhové čerpadlo bazénu 230 V / 0,75 kW',
    opening: 2,
    price: 2_450_000,
    serialPrefix: 'CP-2026-014',
    sku: 'ND-001',
    supplierId: S.kovo,
    tracking: 'serial',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'spare_part',
    leadTimeDays: 10,
    maximum: 40,
    minimum: 10,
    name: 'Tryska pískového filtru (náhradní)',
    opening: 18,
    price: 8500,
    sku: 'ND-002',
    supplierId: S.filtrace,
    tracking: 'none',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'spare_part',
    leadTimeDays: 7,
    maximum: 100,
    minimum: 30,
    name: 'LED trubice T8 150 cm',
    opening: 40,
    price: 18_900,
    sku: 'ND-003',
    supplierId: S.elektro,
    tracking: 'none',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'spare_part',
    leadTimeDays: 7,
    maximum: 30,
    minimum: 10,
    name: 'Jistič 16 A jednopólový',
    opening: 12,
    price: 16_500,
    sku: 'ND-004',
    supplierId: S.elektro,
    tracking: 'none',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'spare_part',
    leadTimeDays: 14,
    maximum: 12,
    minimum: 4,
    name: 'Optický detektor kouře (náhradní)',
    opening: 5,
    price: 129_000,
    serialPrefix: 'DK-5510',
    sku: 'ND-005',
    supplierId: S.elektro,
    tracking: 'serial',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'spare_part',
    leadTimeDays: 14,
    maximum: 6,
    minimum: 2,
    name: 'Hasicí přístroj práškový 6 kg',
    opening: 3,
    price: 119_000,
    serialPrefix: 'HP6-2210',
    sku: 'ND-006',
    supplierId: S.elektro,
    tracking: 'serial',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'spare_part',
    leadTimeDays: 10,
    maximum: 12,
    minimum: 4,
    name: 'Klínový řemen VZT SPZ 1250',
    opening: 6,
    price: 32_000,
    sku: 'ND-007',
    supplierId: S.filtrace,
    tracking: 'none',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'spare_part',
    leadTimeDays: 10,
    maximum: 36,
    minimum: 12,
    name: 'Kapsový filtr VZT F7 592×592',
    opening: 20,
    price: 41_500,
    sku: 'ND-008',
    supplierId: S.filtrace,
    tracking: 'none',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'consumable',
    leadTimeDays: 7,
    maximum: 80,
    minimum: 20,
    name: 'LED žárovka E27 10 W',
    opening: 85,
    price: 7900,
    sku: 'SP-001',
    supplierId: S.elektro,
    tracking: 'none',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'consumable',
    leadTimeDays: 7,
    maximum: 30,
    minimum: 10,
    name: 'Silikon sanitární bílý 310 ml',
    opening: 14,
    price: 14_900,
    sku: 'SP-002',
    supplierId: S.hygiena,
    tracking: 'none',
    unit: 'ks',
    warehouseId: W.main,
  },
  {
    category: 'tool',
    leadTimeDays: 14,
    maximum: 2,
    minimum: 0,
    name: 'Akumulátorová vrtačka 18 V',
    opening: 1,
    price: 399_000,
    serialPrefix: 'AV18-778',
    sku: 'NR-001',
    supplierId: S.elektro,
    tracking: 'serial',
    unit: 'ks',
    warehouseId: W.main,
  },
];

const serialsOf = (prefix: string, from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${from + index}`);

for (const [index, entry] of items.entries()) {
  add(
    `2026-08-01T08:${String(index).padStart(2, '0')}:00Z`,
    {
      _tag: 'StockItemCreate',
      category: entry.category,
      lastPriceMinor: entry.price,
      leadTimeDays: entry.leadTimeDays,
      maximum: entry.maximum,
      minimum: entry.minimum,
      name: entry.name,
      sku: entry.sku,
      tracking: entry.tracking,
      unit: entry.unit,
      warehouseId: entry.warehouseId,
      ...optionalField('supplierId', entry.supplierId),
      ...optionalField('note', entry.note),
    },
    item(entry.sku),
  );
}
// Počáteční stav = inventura 1. 8. 2026 (příjem s důvodem).
for (const [index, entry] of items.entries()) {
  add(`2026-08-01T10:${String(index).padStart(2, '0')}:00Z`, {
    _tag: 'StockReceipt',
    date: '2026-08-01',
    itemId: item(entry.sku),
    quantity: entry.opening,
    reason: 'Počáteční stav – inventura 1. 8. 2026',
    ...optionalField('batch', entry.batch),
    ...optionalField(
      'serialNumbers',
      entry.serialPrefix === undefined ? undefined : serialsOf(entry.serialPrefix, 1, entry.opening),
    ),
  });
}

// ── Pohyby srpen–říjen: výdeje na úkoly a jednotky, přesun, korekce ──────────────────────────────────────────────
const issue = (
  at: string,
  sku: string,
  quantity: number,
  reason: string,
  refs: readonly { readonly id: string; readonly kind: 'task' | 'unit' | 'property'; readonly label: string }[],
  extra: Partial<Extract<CommandInput, { readonly _tag: 'StockIssue' }>> = {},
) =>
  add(
    at,
    {
      _tag: 'StockIssue',
      date: at.slice(0, 10),
      itemId: item(sku),
      quantity,
      reason,
      refs: [...refs],
      ...extra,
    },
    undefined,
    operations,
  );

issue('2026-08-06T09:00:00Z', 'UK-001', 18, 'Doplnění toalet – bytový dům', [
  { id: seedText.labelPropertyParkova, kind: 'property', label: seedText.rezidenceParkovaParkova },
]);
issue('2026-08-06T09:10:00Z', 'UK-002', 8, 'Doplnění zásobníků – kanceláře', [
  unitRef('R201', seedText.riversideOfficeParkKancelarR201R201),
]);
issue('2026-08-12T08:30:00Z', 'BZ-001', 3, 'Dávkování chloru – týden 33', [], { batch: seedText.naclo2607B });
issue('2026-08-14T13:00:00Z', 'ND-003', 6, 'Výměna osvětlení chodby 2. NP', [
  unitRef('R201', seedText.riversideOfficeParkKancelarR201R201),
]);
issue('2026-08-19T08:30:00Z', 'BZ-001', 2, 'Dávkování chloru – týden 34', [], { batch: seedText.naclo2607B });
issue('2026-08-21T10:00:00Z', 'UK-005', 14, 'Úklid areálu po akci', [
  { id: seedText.labelPropertyRiverside, kind: 'property', label: seedText.riversideOfficeParkRiverside },
]);
issue('2026-09-02T07:45:00Z', 'UK-001', 22, 'Doplnění toalet – kanceláře', [
  { id: seedText.labelPropertyRiverside, kind: 'property', label: seedText.riversideOfficeParkRiverside },
]);
issue(
  '2026-09-03T11:00:00Z',
  'ND-001',
  1,
  'Výměna oběhového čerpadla – porucha 2. 9.',
  [taskRef('cerpadlo', 'Oprava oběhového čerpadla bazénu')],
  { serialNumbers: ['CP-2026-0141'] },
);
issue('2026-09-09T08:30:00Z', 'BZ-003', 5, 'Flokulace po odstávce filtrace', [], { batch: 'FL-2605-C' });
issue(
  '2026-09-10T14:00:00Z',
  'ND-005',
  2,
  'Výměna detektorů po revizi EPS',
  [taskRef('eps', 'Revize EPS – byty A1xx'), unitRef('A101', 'Rezidence Parková › Byt A101 · 2+kk (A101)')],
  { serialNumbers: ['DK-55101', 'DK-55102'] },
);
issue('2026-09-16T08:30:00Z', 'BZ-001', 4, 'Dávkování chloru – týdny 37–38', [], { batch: seedText.naclo2607B });
issue(
  '2026-09-18T09:30:00Z',
  'UK-003',
  6,
  'Doplnění dávkovačů mýdla',
  [{ id: seedText.labelPropertyRiverside, kind: 'property', label: seedText.riversideOfficeParkRiverside }],
  { batch: 'MY-2608-14' },
);
issue('2026-09-24T10:00:00Z', 'ND-008', 8, 'Výměna filtrů VZT – kavárna', [
  taskRef('vzt-r101', 'Revize vzduchotechniky – kavárna R101'),
  unitRef('R101', 'Riverside Office Park › Obchodní prostor R101 (R101)'),
]);
issue('2026-09-30T13:00:00Z', 'UK-002', 12, 'Doplnění zásobníků – kanceláře', [
  unitRef('R301', 'Riverside Office Park › Kancelář R301 (R301)'),
]);
issue('2026-10-01T08:00:00Z', 'ND-003', 8, 'Oprava osvětlení před kanceláří R201', [
  taskRef('svetla-r201', 'Oprava osvětlení před kanceláří R201'),
  unitRef('R201', seedText.riversideOfficeParkKancelarR201R201),
]);
issue('2026-10-06T08:30:00Z', 'BZ-001', 4, 'Dávkování chloru – týdny 40–41', [], { batch: seedText.naclo2607B });
issue('2026-10-07T09:00:00Z', 'UK-001', 16, 'Doplnění toalet – bytový dům', [
  { id: seedText.labelPropertyParkova, kind: 'property', label: seedText.rezidenceParkovaParkova },
]);
issue('2026-10-08T10:30:00Z', 'SP-002', 3, 'Přetěsnění sprchového koutu', [
  unitRef('A102', 'Rezidence Parková › Byt A102 · 3+kk (A102)'),
]);
issue('2026-10-13T08:30:00Z', 'BZ-002', 3, 'Korekce pH – týden 42', [], { batch: 'PHM-2606-A' });
issue('2026-10-14T12:00:00Z', 'UK-006', 8, 'Posyp – první mráz', [
  { id: seedText.labelPropertyParkova, kind: 'property', label: seedText.rezidenceParkovaParkova },
]);
issue('2026-10-15T09:00:00Z', 'UK-002', 4, 'Doplnění zásobníků – bytový dům', [
  { id: seedText.labelPropertyParkova, kind: 'property', label: seedText.rezidenceParkovaParkova },
]);

add(
  '2026-09-05T09:00:00Z',
  {
    _tag: 'StockTransfer',
    batch: 'DZ-2607-03',
    date: '2026-09-05',
    fromWarehouseId: W.sanitary,
    itemId: item('UK-004'),
    quantity: 12,
    reason: 'Příruční zásoba pro strojovnu bazénu',
    toWarehouseId: W.chem,
  },
  undefined,
  operations,
);
add(
  '2026-09-30T16:00:00Z',
  {
    _tag: 'StockAdjustment',
    date: '2026-09-30',
    delta: -2,
    itemId: item('UK-005'),
    reason: 'Inventura 30. 9.: 2 role poškozené vlhkostí, vyřazeno',
  },
  undefined,
  management,
);
add(
  '2026-09-30T16:05:00Z',
  {
    _tag: 'StockAdjustment',
    date: '2026-09-30',
    delta: 1,
    itemId: item('ND-002'),
    reason: 'Inventura 30. 9.: nalezena 1 tryska v dílně',
  },
  undefined,
  management,
);

// Plánované výdeje (materiálový plán).
add('2026-10-10T08:00:00Z', {
  _tag: 'StockPlannedIssueCreate',
  date: '2026-11-12',
  itemId: item('ND-008'),
  quantity: 12,
  reason: 'Revize VZT – výměna všech filtrů',
  refs: [taskRef('vzt-r101', 'Revize vzduchotechniky – kavárna R101')],
});
add('2026-10-10T08:05:00Z', {
  _tag: 'StockPlannedIssueCreate',
  date: '2026-11-03',
  itemId: item('UK-006'),
  quantity: 10,
  reason: 'Zimní údržba – listopad',
  refs: [{ id: seedText.labelPropertyParkova, kind: 'property', label: seedText.rezidenceParkovaParkova }],
});
add('2026-10-12T08:00:00Z', {
  _tag: 'StockPlannedIssueCreate',
  date: '2026-10-27',
  itemId: item('BZ-001'),
  quantity: 4,
  reason: 'Dávkování chloru – týdny 44–45',
  refs: [],
});

// ── S06: poptávky / nabídky dodavatelů → objednávky → dodávky → faktura ─────────────────────────────────────────
// 1) Chemie: nabídka → objednávka (cena z nabídky) → částečně dodáno, čeká zbytek.
add(
  '2026-09-22T09:00:00Z',
  {
    _tag: 'PurchaseQuoteCreate',
    currency: 'CZK',
    date: '2026-09-22',
    lines: [
      { description: 'Chlornan sodný 25 kg', itemId: item('BZ-001'), quantity: 12, unitPriceMinor: 89_000 },
      { description: 'Flokulant tekutý 5 l', itemId: item('BZ-003'), quantity: 10, unitPriceMinor: 64_500 },
      { description: 'Doprava (zdarma nad 10 000 Kč)', quantity: 1, unitPriceMinor: 0 },
    ],
    number: 'NAB-AQ-2026-118',
    supplierId: S.aqua,
    validUntil: '2026-10-22',
  },
  'seed-quote-aq-118',
);
add(
  '2026-09-23T10:00:00Z',
  {
    _tag: 'PurchaseOrderCreateFromQuote',
    expectedDate: '2026-10-03',
    quoteId: 'seed-quote-aq-118',
    warehouseId: W.chem,
  },
  seedText.seedPoAq,
);
add('2026-09-23T13:00:00Z', {
  _tag: 'PurchaseOrderTransition',
  note: 'Schváleno – rámcová smlouva AquaChem',
  orderId: seedText.seedPoAq,
  to: 'approved',
});
add('2026-09-23T13:05:00Z', {
  _tag: 'PurchaseOrderTransition',
  note: 'Odesláno e-mailem obchod@aquachem.example',
  orderId: seedText.seedPoAq,
  to: 'ordered',
});
add(
  '2026-10-02T11:00:00Z',
  {
    _tag: 'PurchaseOrderReceive',
    date: '2026-10-02',
    deliveryNote: 'DL-AQ-55821',
    lines: [
      { batch: 'NaClO-2609-K', lineId: 'seed-po-aq:line-1', quantity: 6 },
      { batch: 'FL-2609-A', lineId: 'seed-po-aq:line-2', quantity: 4 },
      { lineId: 'seed-po-aq:line-3', quantity: 1 },
    ],
    orderId: seedText.seedPoAq,
  },
  undefined,
  operations,
);
add('2026-10-05T09:00:00Z', {
  _tag: 'PurchaseOrderLinkInvoice',
  amountMinor: 958_320,
  invoiceDate: '2026-10-03',
  note: 'Dílčí faktura za 1. dodávku',
  number: 'FV-AQ-2026-04411',
  orderId: seedText.seedPoAq,
});

// 2) Elektro: nabídka → objednávka → kompletně dodáno, detektory se sériovými čísly, faktura připojena.
add(
  '2026-09-11T09:00:00Z',
  {
    _tag: 'PurchaseQuoteCreate',
    currency: 'CZK',
    date: '2026-09-11',
    lines: [
      { description: 'Optický detektor kouře', itemId: item('ND-005'), quantity: 4, unitPriceMinor: 129_000 },
      { description: 'LED trubice T8 150 cm', itemId: item('ND-003'), quantity: 40, unitPriceMinor: 18_900 },
    ],
    number: 'CN-2026-0912',
    supplierId: S.elektro,
    validUntil: '2026-10-11',
  },
  'seed-quote-el-0912',
);
add(
  '2026-09-12T08:00:00Z',
  {
    _tag: 'PurchaseOrderCreateFromQuote',
    expectedDate: seedText.date20260919,
    quoteId: 'seed-quote-el-0912',
    warehouseId: W.main,
  },
  seedText.seedPoEl,
);
add('2026-09-12T09:00:00Z', { _tag: 'PurchaseOrderTransition', orderId: seedText.seedPoEl, to: 'approved' });
add('2026-09-12T09:10:00Z', { _tag: 'PurchaseOrderTransition', orderId: seedText.seedPoEl, to: 'ordered' });
add(
  '2026-09-19T10:00:00Z',
  {
    _tag: 'PurchaseOrderReceive',
    date: seedText.date20260919,
    deliveryNote: 'DL-ES-20931',
    lines: [
      { lineId: 'seed-po-el:line-1', quantity: 4, serialNumbers: ['DK-55201', 'DK-55202', 'DK-55203', 'DK-55204'] },
      { lineId: 'seed-po-el:line-2', quantity: 40 },
    ],
    orderId: seedText.seedPoEl,
  },
  undefined,
  operations,
);
add('2026-09-22T10:00:00Z', {
  _tag: 'PurchaseOrderLinkInvoice',
  amountMinor: 1_539_120,
  invoiceDate: seedText.date20260919,
  number: 'FA-2026-3318',
  orderId: seedText.seedPoEl,
});

// 3) Filtrace: přímá objednávka (bez nabídky) – objednáno, čeká na dodání.
add(
  '2026-10-14T09:00:00Z',
  {
    _tag: 'PurchaseOrderCreate',
    currency: 'CZK',
    expectedDate: '2026-10-24',
    lines: [
      { description: 'Kapsový filtr VZT F7 592×592', itemId: item('ND-008'), quantity: 24, unitPriceMinor: 41_500 },
      { description: 'Klínový řemen VZT SPZ 1250', itemId: item('ND-007'), quantity: 4, unitPriceMinor: 32_000 },
    ],
    note: 'Na revizi VZT v listopadu',
    supplierId: S.filtrace,
    warehouseId: W.main,
  },
  seedText.seedPoFi,
);
add('2026-10-14T10:00:00Z', { _tag: 'PurchaseOrderTransition', orderId: seedText.seedPoFi, to: 'approved' });
add('2026-10-14T10:05:00Z', { _tag: 'PurchaseOrderTransition', orderId: seedText.seedPoFi, to: 'ordered' });

// 4) Hygiena: nabídka čeká na rozhodnutí (S06-01 lze předvést živě) + návrh objednávky.
add(
  '2026-10-16T09:00:00Z',
  {
    _tag: 'PurchaseQuoteCreate',
    currency: 'CZK',
    date: '2026-10-16',
    lines: [
      { description: 'Papírové ručníky ZZ (karton)', itemId: item('UK-002'), quantity: 2, unitPriceMinor: 54_900 },
      { description: 'Posypová sůl 25 kg', itemId: item('UK-006'), quantity: 40, unitPriceMinor: 18_500 },
    ],
    note: 'Cena platí při odběru celé palety soli.',
    number: 'NAB-HP-7741',
    supplierId: S.hygiena,
    validUntil: '2026-10-30',
  },
  'seed-quote-hp-7741',
);
add(
  '2026-10-17T09:00:00Z',
  {
    _tag: 'PurchaseQuoteCreate',
    currency: 'CZK',
    date: '2026-10-17',
    lines: [
      {
        description: 'Oběhové čerpadlo bazénu 230 V / 0,75 kW',
        itemId: item('ND-001'),
        quantity: 1,
        unitPriceMinor: 2_450_000,
      },
    ],
    number: 'KD-26-205',
    supplierId: S.kovo,
    validUntil: '2026-11-17',
  },
  'seed-quote-kd-205',
);
add(
  '2026-10-18T09:00:00Z',
  {
    _tag: 'PurchaseQuoteCreate',
    currency: 'CZK',
    date: '2026-10-15',
    lines: [
      {
        description: 'Oběhové čerpadlo 0,75 kW (alternativa)',
        itemId: item('ND-001'),
        quantity: 1,
        unitPriceMinor: 2_890_000,
      },
    ],
    number: 'FP-Q-1032',
    supplierId: S.filtrace,
  },
  'seed-quote-fp-1032',
);
add('2026-10-18T09:30:00Z', {
  _tag: 'PurchaseQuoteReject',
  note: 'Dražší než nabídka Kovo Dílna Novák.',
  quoteId: 'seed-quote-fp-1032',
});
add(
  '2026-10-19T08:00:00Z',
  {
    _tag: 'PurchaseOrderCreate',
    currency: 'CZK',
    expectedDate: '2026-10-29',
    lines: [
      {
        description: 'Toaletní papír 2vrstvý (bal. 8 rolí)',
        itemId: item('UK-001'),
        quantity: 60,
        unitPriceMinor: 15_900,
      },
      { description: 'Tekuté mýdlo 5 l', itemId: item('UK-003'), quantity: 10, unitPriceMinor: 21_900 },
    ],
    supplierId: S.hygiena,
    warehouseId: W.sanitary,
  },
  'seed-po-hp',
);

class PurchasingSeedStepFailed extends Schema.TaggedError<PurchasingSeedStepFailed>()('PurchasingSeedStepFailed', {
  cause: Schema.Defect(),
  commandTag: Schema.String,
  step: Schema.String,
}) {}

/** Replays commands in their recorded order and stops at the first refused step. */
export const buildPurchasingSeed = Effect.fn('FacilityOperations.buildPurchasingSeed')(function* buildPurchasingSeed() {
  const initial = yield* Schema.decodeUnknownEffect(PurchasingStateSchema)(emptyPurchasingState);
  return yield* Effect.reduce(
    steps,
    () => initial,
    (state, step) =>
      Effect.gen(function* replayPurchasingStep() {
        const [actor, now, command] = yield* Effect.all(
          [
            Schema.decodeUnknownEffect(PrincipalRefSchema)(step.by ?? management),
            Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(step.at),
            Schema.decodeUnknownEffect(PurchasingCommandSchema)(step.command),
          ],
          { concurrency: 1 },
        );
        const input: OpsCommandInput = { actor, now, resourceId: step.id };
        const result = yield* evolvePurchasing(state, command, input);
        return result.state;
      }).pipe(
        Effect.mapError(
          (cause) => new PurchasingSeedStepFailed({ cause, commandTag: step.command._tag, step: step.id }),
        ),
      ),
  );
});

export const seedPurchasingState = Effect.fn('FacilityOperations.seedPurchasingState')(function* seedPurchasingState() {
  const state = yield* buildPurchasingSeed();
  return yield* Schema.encodeEffect(PurchasingStateSchema)(state);
});
