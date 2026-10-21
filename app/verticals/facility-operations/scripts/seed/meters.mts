// Seed of agenda `meters` for Siampark (legal entity …0021). OWNED BY THE `meters` LANE (ops-meters).
// Returns the ENCODED state with fixed ids/timestamps so reseeds are deterministic.
// Property/unit references are display snapshots of the rental seed (Rezidence Parková, Riverside Office Park);
// the ids are the ones the live rental seed produced, the labels keep the screens readable if ids ever change.
//
// Story: every unit has its meters with monthly readings from 30. 4. 2026 (installation/initial reading) to
// 30. 9. 2026, a few have a mid-October reading without a cost yet. Deliberate cases for the demo:
//   - A202 voda: září +85 % (podezření na únik), R101 elektřina: srpen +43 % (klimatizace) → anomaly highlight;
//   - S01 nový podružný elektroměr: one reading only → „bez předchozího odečtu“ (S04-02);
//   - A101 elektřina: a mistyped reading voided with a reason (history kept).
import type { MetersStateEncoded } from '../../shared/domain/meters.ts';

type Medium = 'ELECTRICITY' | 'WATER' | 'GAS' | 'HEAT';
type Location = { readonly id: string; readonly kind: 'property' | 'unit'; readonly label: string };

const tenantId = '70000000-0000-4000-8000-000000000020';
const management = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };

const parkovaName = 'Rezidence Parková';
const riversideName = 'Riverside Office Park';
const property = (id: string, name: string, code: string): Location => ({ id, kind: 'property', label: `${name} (${code})` });
const unit = (id: string, propertyName: string, name: string, code: string): Location => ({
  id,
  kind: 'unit',
  label: `${propertyName} › ${name} (${code})`,
});

const parkova = property('f5ef97e9-2935-4ebc-83e6-aa9d475e561b', parkovaName, 'PARKOVA');
const riverside = property('6a0197b3-4b13-46c5-a3ab-8dbb46dda58e', riversideName, 'RIVERSIDE');
const a101 = unit('5bdfdfea-bbce-41dc-875c-5569a4c704ba', parkovaName, 'Byt A101 · 2+kk', 'A101');
const a102 = unit('3280be49-3108-4dae-a97f-b19965353638', parkovaName, 'Byt A102 · 3+kk', 'A102');
const a201 = unit('7331ff5b-4415-473a-9fc7-e3b338f44ba8', parkovaName, 'Byt A201 · 1+kk', 'A201');
const a202 = unit('675f7443-390d-4f9c-adfd-2a0471e9f331', parkovaName, 'Byt A202 · 2+kk', 'A202');
const r101 = unit('bf65f06e-fe64-4787-813f-6a62bad12409', riversideName, 'Obchodní prostor R101', 'R101');
const r201 = unit('ec2c089a-69d4-459d-a67f-83d986add5f8', riversideName, 'Kancelář R201', 'R201');
const r301 = unit('05444cc8-c6e6-4f2b-934b-a46d53d854be', riversideName, 'Kancelář R301', 'R301');
const s01 = unit('1ecbca7a-0c49-49c3-a122-3d0d03476cad', riversideName, 'Sklad S01', 'S01');

const meterId = (n: number) => `73040000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const readingId = (n: number, index: number) =>
  `73040000-0000-4000-8000-${String(n).padStart(4, '0')}${String(index).padStart(8, '0')}`;

/** Closing dates of the monthly periods; the first entry is the initial reading. */
const monthEnds = ['2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30'] as const;
/** Small deterministic month-to-month variation (never above the 30 % anomaly threshold on its own). */
const wiggle = [1, 0.97, 1.04, 0.99, 1.03] as const;
const readers = ['Petr Novák (správce areálu)', 'Jana Dvořáková (provoz)'] as const;

/** Price per unit of measure in haléře (indicative, used only for seeded period costs). */
const priceMinor: Readonly<Record<Medium, number>> = { ELECTRICITY: 620, GAS: 3_200, HEAT: 98_000, WATER: 12_800 };
const unitOf: Readonly<Record<Medium, string>> = { ELECTRICITY: 'kWh', GAS: 'm³', HEAT: 'GJ', WATER: 'm³' };
const decimalsOf: Readonly<Record<Medium, number>> = { ELECTRICITY: 0, GAS: 1, HEAT: 2, WATER: 2 };
const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

interface MeterSpec {
  readonly n: number;
  readonly serialNumber: string;
  readonly medium: Medium;
  readonly location: Location;
  readonly start: number;
  /** Consumption per month May…September (before wiggle). */
  readonly monthly: readonly number[];
  readonly supplyPoint?: string;
  readonly supplier?: string;
  readonly consumer?: string;
  readonly contract?: string;
  readonly note?: string;
  /** Multiplies one period (index 0 = May) to stage an anomaly, with a note on that reading. */
  readonly spike?: { readonly period: number; readonly factor: number; readonly note: string };
  /** Mid-October reading: consumption so far in October (no cost yet). */
  readonly october?: number;
  /** Only an initial reading on this date (new meter). */
  readonly onlyInitial?: { readonly date: string; readonly value: number };
  /** Adds a mistyped reading on this date that was voided. */
  readonly voidedTypo?: { readonly date: string; readonly value: number };
}

const flat = (value: number) => [value, value, value, value, value] as const;
const pre = 'ČEZ Prodej, a.s.';
const water = 'Pražské vodovody a kanalizace, a.s.';

const specs: readonly MeterSpec[] = [
  { n: 1, serialNumber: 'EL-PK-A101', medium: 'ELECTRICITY', location: a101, start: 18_420, monthly: flat(185), supplyPoint: 'EAN 859182400100457101', supplier: pre, contract: 'ČEZ-2025-PK-01', consumer: 'Nájemce bytu A101', voidedTypo: { date: '2026-07-15', value: 19_560 } },
  { n: 2, serialNumber: 'VO-PK-A101', medium: 'WATER', location: a101, start: 412.35, monthly: flat(4.6), supplyPoint: 'Podružný vodoměr A101', supplier: water, contract: 'PVK-2019-0457' },
  { n: 3, serialNumber: 'EL-PK-A102', medium: 'ELECTRICITY', location: a102, start: 26_870, monthly: flat(245), supplyPoint: 'EAN 859182400100457102', supplier: pre, contract: 'ČEZ-2025-PK-01', october: 120 },
  { n: 4, serialNumber: 'VO-PK-A102', medium: 'WATER', location: a102, start: 688.1, monthly: flat(6.8), supplyPoint: 'Podružný vodoměr A102', supplier: water, contract: 'PVK-2019-0457' },
  { n: 5, serialNumber: 'EL-PK-A201', medium: 'ELECTRICITY', location: a201, start: 9_310, monthly: flat(128), supplyPoint: 'EAN 859182400100457201', supplier: pre, contract: 'ČEZ-2025-PK-01' },
  { n: 6, serialNumber: 'VO-PK-A201', medium: 'WATER', location: a201, start: 233.62, monthly: flat(3.1), supplyPoint: 'Podružný vodoměr A201', supplier: water, contract: 'PVK-2019-0457' },
  { n: 7, serialNumber: 'EL-PK-A202', medium: 'ELECTRICITY', location: a202, start: 15_044, monthly: flat(176), supplyPoint: 'EAN 859182400100457202', supplier: pre, contract: 'ČEZ-2025-PK-01' },
  { n: 8, serialNumber: 'VO-PK-A202', medium: 'WATER', location: a202, start: 517.4, monthly: flat(4.9), supplyPoint: 'Podružný vodoměr A202', supplier: water, contract: 'PVK-2019-0457', spike: { factor: 1.85, note: 'Výrazně vyšší spotřeba, protéká WC. Nahlášeno údržbě.', period: 4 }, october: 2.7 },
  { n: 9, serialNumber: 'PL-PK-KOT1', medium: 'GAS', location: parkova, start: 48_210.4, monthly: [900, 610, 505, 520, 600], supplyPoint: 'EIC 27ZG100Z0045712K', supplier: 'Pražská plynárenská, a.s.', contract: 'PP-2024-0981', note: 'Hlavní plynoměr kotelny (vytápění a ohřev vody celého domu).' },
  { n: 10, serialNumber: 'EL-RV-R101', medium: 'ELECTRICITY', location: r101, start: 84_150, monthly: flat(1_380), supplyPoint: 'EAN 859182400200811101', supplier: pre, contract: 'ČEZ-2024-RV-07', consumer: 'Nájemce obchodního prostoru R101', spike: { factor: 1.5, note: 'Celý měsíc v provozu klimatizace výlohy.', period: 3 } },
  { n: 11, serialNumber: 'VO-RV-R101', medium: 'WATER', location: r101, start: 1_204.5, monthly: flat(9.5), supplyPoint: 'Podružný vodoměr R101', supplier: water, contract: 'PVK-2021-1120' },
  { n: 12, serialNumber: 'EL-RV-R201', medium: 'ELECTRICITY', location: r201, start: 52_330, monthly: flat(910), supplyPoint: 'EAN 859182400200811201', supplier: pre, contract: 'ČEZ-2024-RV-07', october: 470 },
  { n: 13, serialNumber: 'TE-RV-R201', medium: 'HEAT', location: r201, start: 612.4, monthly: [6.2, 3.6, 3.1, 3.2, 3.7], supplyPoint: 'Předávací stanice tepla RV-2', supplier: 'Pražská teplárenská a.s.', contract: 'PT-2022-3301' },
  { n: 14, serialNumber: 'EL-RV-R301', medium: 'ELECTRICITY', location: r301, start: 47_905, monthly: flat(860), supplyPoint: 'EAN 859182400200811301', supplier: pre, contract: 'ČEZ-2024-RV-07' },
  { n: 15, serialNumber: 'TE-RV-R301', medium: 'HEAT', location: r301, start: 587.15, monthly: [5.8, 3.4, 2.9, 3.0, 3.5], supplyPoint: 'Předávací stanice tepla RV-3', supplier: 'Pražská teplárenská a.s.', contract: 'PT-2022-3301' },
  { n: 16, serialNumber: 'VO-RV-R301', medium: 'WATER', location: r301, start: 890.75, monthly: flat(11.2), supplyPoint: 'Podružný vodoměr R301', supplier: water, contract: 'PVK-2021-1120' },
  { n: 17, serialNumber: 'EL-RV-S01', medium: 'ELECTRICITY', location: s01, start: 21_760, monthly: flat(310), supplyPoint: 'EAN 859182400200811901', supplier: pre, contract: 'ČEZ-2024-RV-07' },
  { n: 18, serialNumber: 'EL-RV-S01-CH', medium: 'ELECTRICITY', location: s01, start: 0, monthly: flat(0), supplier: pre, note: 'Nový podružný elektroměr chladicího boxu, osazen 1. 10. 2026.', onlyInitial: { date: '2026-10-01', value: 0 } },
  { n: 19, serialNumber: 'EL-RV-HLAVNI', medium: 'ELECTRICITY', location: riverside, start: 912_400, monthly: flat(5_150), supplyPoint: 'EAN 859182400200811000', supplier: pre, contract: 'ČEZ-2024-RV-07', note: 'Hlavní elektroměr budovy (společné prostory a technologie).', october: 2_480 },
];

const audit = (at: string, by = operations) => ({ createdAt: at, createdBy: by, updatedAt: at, updatedBy: by });

const buildMeter = (spec: MeterSpec): MetersStateEncoded['meters'][number] => {
  const decimals = decimalsOf[spec.medium];
  const unitLabel = unitOf[spec.medium];
  const installedAt = `${spec.onlyInitial?.date ?? monthEnds[0]}T07:30:00.000Z`;
  type Reading = NonNullable<MetersStateEncoded['meters'][number]['readings']>[number];
  const readings: Reading[] = [];
  const push = (date: string, value: number, extra: Partial<Reading> = {}) => {
    const index = readings.length + 1;
    readings.push({
      ...audit(`${date}T08:${String(10 + index).padStart(2, '0')}:00.000Z`),
      date,
      id: readingId(spec.n, index),
      readBy: readers[(spec.n + index) % readers.length] ?? readers[0],
      unit: unitLabel,
      value: round(value, decimals),
      ...extra,
    });
  };
  if (spec.onlyInitial === undefined) {
    let value = spec.start;
    push(monthEnds[0], value, { note: 'Počáteční stav při převzetí do evidence.' });
    spec.monthly.forEach((base, period) => {
      const factor = (wiggle[period] ?? 1) * (spec.spike?.period === period ? spec.spike.factor : 1);
      const consumption = round(base * factor, decimals);
      value += consumption;
      const date = monthEnds[period + 1] ?? monthEnds[0];
      push(date, value, {
        costMinor: Math.round(consumption * priceMinor[spec.medium]),
        ...(spec.spike?.period === period ? { note: spec.spike.note } : {}),
      });
    });
    if (spec.october !== undefined) {
      push('2026-10-15', value + spec.october, { note: 'Průběžný odečet, náklad zatím nevyfakturován.' });
    }
  } else {
    push(spec.onlyInitial.date, spec.onlyInitial.value, { note: 'Počáteční stav nového měřidla.' });
  }
  if (spec.voidedTypo !== undefined) {
    const at = `${spec.voidedTypo.date}T09:00:00.000Z`;
    readings.push({
      ...audit(at),
      date: spec.voidedTypo.date,
      id: readingId(spec.n, 90),
      note: 'Průběžná kontrola.',
      readBy: readers[1],
      unit: unitLabel,
      updatedAt: `${spec.voidedTypo.date}T09:20:00.000Z`,
      updatedBy: management,
      value: spec.voidedTypo.value,
      voided: { at: `${spec.voidedTypo.date}T09:20:00.000Z`, by: management, reason: 'Překlep při zápisu (prohozené číslice), stav ověřen fotkou.' },
    });
  }
  const last = readings.at(-1)?.updatedAt ?? installedAt;
  const optional = <K extends string>(key: K, value: string | undefined) =>
    value === undefined ? {} : ({ [key]: value } as Record<K, string>);
  return {
    ...audit(installedAt, management),
    ...optional('contract', spec.contract),
    ...optional('consumer', spec.consumer),
    ...optional('note', spec.note),
    ...optional('supplier', spec.supplier),
    ...optional('supplyPoint', spec.supplyPoint),
    id: meterId(spec.n),
    location: spec.location,
    medium: spec.medium,
    readings,
    serialNumber: spec.serialNumber,
    status: 'ACTIVE',
    unit: unitLabel,
    updatedAt: last,
    updatedBy: operations,
  };
};

export const seedMetersState = (): MetersStateEncoded => ({ meters: specs.map(buildMeter) });
