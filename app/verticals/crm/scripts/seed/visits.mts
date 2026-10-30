// Seed of the visits area (C02 visits, C06 manual plan) — owned by the crm-visits lane.
// reset-demo.mts calls seedVisits(); every date is relative to the reset time so the demo always shows
// "last 3 months of visits" and "a plan for the next 2 weeks". Ids are deterministic demoId()s.
import { DateTime, Schema } from 'effect';
import type { PlanItemSchema, VisitSchema, VisitCorrectionSchema, VisitKind } from '../../shared/domain/visits.ts';
import { demoId } from '../../../../scripts/demo/fixture-ids.mts';

interface Rep {
  readonly id: string;
  readonly principalId: string;
}

export interface VisitsSeedInput {
  /** Principal of the sales lead (Vedoucí obchodu). */
  readonly leadPrincipalId: string;
  readonly now: DateTime.Utc;
  readonly repA: Rep;
  readonly repB: Rep;
}

const bakeryClientKey = 'pekarna-mala';
const gooseRestaurantClientKey = 'zlata-husa';
const castleHotelClientKey = 'hotel-podhradi';
const blanskoSchoolClientKey = 'zs-blansko';
const cernaShopClientKey = 'potraviny-cerna';
const cornerCafeClientKey = 'kavarna-na-rohu';
const kralBistroClientKey = 'bistro-kral';
const spaHotelClientKey = 'lazensky-hotel';
const castleRestaurantClientKey = 'zamecka-restaurace';
const vsetinCateringClientKey = 'catering-vsetin';
const hodoninMinimarketClientKey = 'minimarket-hodonin';

type Kind = VisitKind;
const SeedAuthorSchema = Schema.Literals(['a', 'b', 'lead']);
type SeedAuthor = typeof SeedAuthorSchema.Type;

interface VisitSeed {
  readonly client: string;
  readonly corrections?: readonly {
    readonly by: SeedAuthor;
    readonly field: string;
    readonly hoursAfter: number;
    readonly next?: string;
    readonly previous?: string;
    readonly reason?: string;
  }[];
  /** Days before the reset. */
  readonly daysAgo: number;
  /** Local (Prague) hour + minutes, e.g. 9.5 = 09:30. */
  readonly hour: number;
  readonly key: string;
  readonly kind: Kind;
  readonly nextStep?: string;
  /** Days after the reset (negative = already past). */
  readonly nextStepInDays?: number;
  readonly note?: string;
  readonly rep: SeedAuthor;
  readonly result: string;
}

const VISITS: readonly VisitSeed[] = [
  // Jan Novák (A)
  {
    client: bakeryClientKey,
    daysAgo: 84,
    hour: 9,
    key: 'a-01',
    kind: 'visit',
    note: 'Paní Malá zvažuje změnu dodavatele mouky, současný dodavatel zdražil o 12 %.',
    rep: 'a',
    result: 'Úvodní schůzka, předán katalog',
  },
  {
    client: gooseRestaurantClientKey,
    daysAgo: 77,
    hour: 14,
    key: 'a-02',
    kind: 'call',
    rep: 'a',
    result: 'Domluvena ochutnávka uzenin',
  },
  {
    client: castleHotelClientKey,
    daysAgo: 70,
    hour: 10.5,
    key: 'a-03',
    kind: 'visit',
    note: 'Hotel chystá rekonstrukci kuchyně, objednávky omezí na podzim.',
    rep: 'a',
    result: 'Prezentace sortimentu pro snídaně',
  },
  {
    client: blanskoSchoolClientKey,
    daysAgo: 63,
    hour: 8.5,
    key: 'a-04',
    kind: 'email',
    rep: 'a',
    result: 'Zaslána nabídka na školní rok',
  },
  {
    client: cernaShopClientKey,
    daysAgo: 56,
    hour: 11,
    key: 'a-05',
    kind: 'visit',
    note: 'Prodejna má málo místa ve skladu, preferuje menší a častější dodávky.',
    rep: 'a',
    result: 'Dohodnuty dodávky 1× týdně',
  },
  {
    client: cornerCafeClientKey,
    daysAgo: 49,
    hour: 15,
    key: 'a-06',
    kind: 'video',
    rep: 'a',
    result: 'Videohovor k sortimentu dezertů',
  },
  {
    client: bakeryClientKey,
    corrections: [
      {
        by: 'a',
        field: 'Poznámka',
        hoursAfter: 20,
        next: 'Odebírá hladkou mouku T530 a žitnou T960, cca 800 kg měsíčně.',
        previous: 'Odebírá hladkou mouku, cca 600 kg měsíčně.',
        reason: 'Upřesněno po kontrole objednávek',
      },
    ],
    daysAgo: 42,
    hour: 9.5,
    key: 'a-07',
    kind: 'visit',
    note: 'Odebírá hladkou mouku T530 a žitnou T960, cca 800 kg měsíčně.',
    rep: 'a',
    result: 'Podepsána rámcová dohoda',
  },
  {
    client: gooseRestaurantClientKey,
    daysAgo: 35,
    hour: 13,
    key: 'a-08',
    kind: 'visit',
    note: 'Provozní pan Dvořák chce zkusit nový dodací režim od listopadu.',
    rep: 'a',
    result: 'Ochutnávka proběhla, zájem o uzeniny',
  },
  {
    client: blanskoSchoolClientKey,
    daysAgo: 28,
    hour: 10,
    key: 'a-09',
    kind: 'call',
    rep: 'a',
    result: 'Upřesněny alergeny v nabídce',
  },
  {
    client: bakeryClientKey,
    daysAgo: 21,
    hour: 9,
    key: 'v1',
    kind: 'visit',
    note: 'Zájem o pravidelné dodávky 2× týdně.',
    rep: 'a',
    result: 'Představení podzimní nabídky mouky',
  },
  {
    client: castleHotelClientKey,
    daysAgo: 16,
    hour: 11,
    key: 'a-10',
    kind: 'call',
    nextStep: 'Zaslat ceník snídaňového sortimentu po rekonstrukci',
    nextStepInDays: 9,
    rep: 'a',
    result: 'Rekonstrukce kuchyně končí v listopadu',
  },
  {
    client: cornerCafeClientKey,
    daysAgo: 12,
    hour: 14.5,
    key: 'a-11',
    kind: 'email',
    rep: 'a',
    result: 'Odeslán ceník dezertů na zimní sezónu',
  },
  {
    client: gooseRestaurantClientKey,
    daysAgo: 9,
    hour: 10,
    key: 'v2',
    kind: 'visit',
    nextStep: 'Ověřit spokojenost se zkušební objednávkou',
    nextStepInDays: 2,
    rep: 'a',
    result: 'Dohodnuta zkušební objednávka',
  },
  {
    client: cernaShopClientKey,
    daysAgo: 3,
    hour: 16,
    key: 'a-12',
    kind: 'call',
    nextStep: 'Ozvat se k nové ceníkové nabídce',
    nextStepInDays: 4,
    rep: 'a',
    result: 'Paní Černá chce nový ceník na prosinec',
  },
  // Petra Svobodová (B)
  {
    client: kralBistroClientKey,
    daysAgo: 88,
    hour: 10,
    key: 'b-01',
    kind: 'visit',
    note: 'Bistro rozšiřuje polední menu, hledá stálého dodavatele masa.',
    rep: 'b',
    result: 'Úvodní schůzka s jednatelem',
  },
  {
    client: spaHotelClientKey,
    daysAgo: 80,
    hour: 13.5,
    key: 'b-02',
    kind: 'visit',
    rep: 'b',
    result: 'Prezentace pro F&B manažera',
  },
  {
    client: hodoninMinimarketClientKey,
    daysAgo: 72,
    hour: 9,
    key: 'b-03',
    kind: 'call',
    rep: 'b',
    result: 'Minimarket má zájem jen o trvanlivé zboží',
  },
  {
    client: vsetinCateringClientKey,
    daysAgo: 65,
    hour: 11,
    key: 'b-04',
    kind: 'video',
    note: 'Catering obsluhuje firemní akce do 300 osob, potřebuje rychlé doplnění zásob.',
    rep: 'b',
    result: 'Videohovor k sezónním akcím',
  },
  {
    client: castleRestaurantClientKey,
    daysAgo: 58,
    hour: 15,
    key: 'b-05',
    kind: 'visit',
    rep: 'b',
    result: 'Ochutnávka s šéfkuchařem',
  },
  {
    client: kralBistroClientKey,
    corrections: [
      {
        by: 'lead',
        field: 'Výsledek',
        hoursAfter: 30,
        next: 'Objednávka masa na 4 týdny potvrzena',
        previous: 'Objednávka potvrzena',
        reason: 'Doplněn rozsah objednávky pro přehled vedení',
      },
    ],
    daysAgo: 44,
    hour: 10.5,
    key: 'b-06',
    kind: 'visit',
    rep: 'b',
    result: 'Objednávka masa na 4 týdny potvrzena',
  },
  {
    client: spaHotelClientKey,
    daysAgo: 37,
    hour: 9.5,
    key: 'b-07',
    kind: 'email',
    rep: 'b',
    result: 'Zaslán návrh ročního kontraktu',
  },
  {
    client: vsetinCateringClientKey,
    daysAgo: 24,
    hour: 14,
    key: 'b-08',
    kind: 'call',
    rep: 'b',
    result: 'Řešena pozdní dodávka, omluva a sleva 5 %',
  },
  {
    client: kralBistroClientKey,
    daysAgo: 14,
    hour: 11,
    key: 'v3',
    kind: 'visit',
    note: 'Dobropis vystaví účetní systém.',
    rep: 'b',
    result: 'Reklamace dodávky vyřešena',
  },
  {
    client: hodoninMinimarketClientKey,
    daysAgo: 10,
    hour: 16,
    key: 'b-09',
    kind: 'call',
    nextStep: 'Nabídnout trvanlivý sortiment na Vánoce',
    nextStepInDays: 3,
    rep: 'b',
    result: 'Majitel chce vánoční nabídku',
  },
  {
    client: spaHotelClientKey,
    daysAgo: 5,
    hour: 13,
    key: 'v4',
    kind: 'visit',
    nextStep: 'Poslat upravený návrh ročního kontraktu',
    nextStepInDays: 8,
    rep: 'b',
    result: 'Jednání o ročním kontraktu',
  },
  // Vedoucí obchodu: unassigned prospect
  {
    client: 'sladka-tecka',
    daysAgo: 19,
    hour: 10,
    key: 'lead-01',
    kind: 'call',
    note: 'Klient zatím nemá přiděleného obchodníka; rozhodne se po nové sezóně.',
    rep: 'lead',
    result: 'Úvodní telefonát s majitelkou',
  },
];

interface PlanSeed {
  readonly client: string;
  readonly createdDaysAgo: number;
  readonly done?: {
    readonly daysAgo: number;
    readonly note?: string;
    readonly visit?: string;
  };
  /** Days after the reset (negative = overdue). */
  readonly dueInDays: number;
  readonly key: string;
  readonly note?: string;
  readonly rep: 'a' | 'b';
  readonly sourceVisit?: string;
}

const PLAN: readonly PlanSeed[] = [
  // A — open
  {
    client: cornerCafeClientKey,
    createdDaysAgo: 12,
    dueInDays: -2,
    key: 'p-a-1',
    note: 'Zeptat se na reakci k ceníku dezertů',
    rep: 'a',
  },
  {
    client: blanskoSchoolClientKey,
    createdDaysAgo: 6,
    dueInDays: 0,
    key: 'p-a-2',
    note: 'Potvrdit dodávky na listopad',
    rep: 'a',
  },
  {
    client: gooseRestaurantClientKey,
    createdDaysAgo: 9,
    dueInDays: 2,
    key: 'p-a-3',
    note: 'Ověřit spokojenost se zkušební objednávkou',
    rep: 'a',
    sourceVisit: 'v2',
  },
  {
    client: cernaShopClientKey,
    createdDaysAgo: 3,
    dueInDays: 4,
    key: 'p1',
    note: 'Ozvat se k nové ceníkové nabídce.',
    rep: 'a',
    sourceVisit: 'a-12',
  },
  {
    client: castleHotelClientKey,
    createdDaysAgo: 16,
    dueInDays: 9,
    key: 'p-a-4',
    note: 'Zaslat ceník snídaňového sortimentu po rekonstrukci',
    rep: 'a',
    sourceVisit: 'a-10',
  },
  {
    client: bakeryClientKey,
    createdDaysAgo: 2,
    dueInDays: 13,
    key: 'p-a-5',
    note: 'Kontrola plnění rámcové dohody',
    rep: 'a',
  },
  // A — done
  {
    client: cornerCafeClientKey,
    createdDaysAgo: 20,
    done: { daysAgo: 12, note: 'Ceník odeslán e-mailem', visit: 'a-11' },
    dueInDays: -12,
    key: 'p-a-6',
    note: 'Poslat ceník dezertů',
    rep: 'a',
  },
  {
    client: blanskoSchoolClientKey,
    createdDaysAgo: 35,
    done: { daysAgo: 28, visit: 'a-09' },
    dueInDays: -28,
    key: 'p-a-7',
    note: 'Doplnit informace o alergenech',
    rep: 'a',
  },
  // B — open
  {
    client: hodoninMinimarketClientKey,
    createdDaysAgo: 10,
    dueInDays: 3,
    key: 'p-b-1',
    note: 'Nabídnout trvanlivý sortiment na Vánoce',
    rep: 'b',
    sourceVisit: 'b-09',
  },
  {
    client: castleRestaurantClientKey,
    createdDaysAgo: 2,
    dueInDays: 7,
    key: 'p2',
    note: 'Pozvat šéfkuchaře na zimní ochutnávku',
    rep: 'b',
  },
  {
    client: spaHotelClientKey,
    createdDaysAgo: 5,
    dueInDays: 8,
    key: 'p-b-2',
    note: 'Poslat upravený návrh ročního kontraktu',
    rep: 'b',
    sourceVisit: 'v4',
  },
  {
    client: vsetinCateringClientKey,
    createdDaysAgo: 4,
    dueInDays: 1,
    key: 'p-b-3',
    note: 'Ověřit spokojenost po reklamaci',
    rep: 'b',
  },
  {
    client: kralBistroClientKey,
    createdDaysAgo: 1,
    dueInDays: 12,
    key: 'p-b-4',
    note: 'Domluvit prodloužení objednávky masa',
    rep: 'b',
  },
  // B — done
  {
    client: vsetinCateringClientKey,
    createdDaysAgo: 30,
    done: { daysAgo: 24, note: 'Reklamace vyřízena po telefonu', visit: 'b-08' },
    dueInDays: -25,
    key: 'p-b-5',
    note: 'Vyřešit pozdní dodávku',
    rep: 'b',
  },
];

const clientId = (key: string) => demoId('crm.client', key);
const visitId = (key: string) => demoId('crm.visit', key);

/** Encoded visits slice (VisitsSlice) for the reset time `now`. */
export const seedVisits = ({ leadPrincipalId, now, repA, repB }: VisitsSeedInput) => {
  const today = DateTime.startOf(now, 'day');
  // Prague is UTC+1/UTC+2; one hour offset keeps every seeded time inside working hours either way.
  const localAt = (daysAgo: number, hour: number) =>
    DateTime.formatIso(
      DateTime.add(DateTime.subtract(today, { days: daysAgo }), { minutes: Math.round((hour - 1) * 60) }),
    );
  const day = (inDays: number) => DateTime.formatIso(DateTime.add(today, { days: inDays })).slice(0, 10);
  const principal = (who: SeedAuthor) => {
    if (who === 'a') {
      return repA.principalId;
    }
    return who === 'b' ? repB.principalId : leadPrincipalId;
  };
  const salesperson = (who: SeedAuthor) => {
    if (who === 'a') {
      return repA.id;
    }
    return who === 'b' ? repB.id : undefined;
  };
  const plannedBy = new Map(
    PLAN.flatMap((item) =>
      item.done?.visit === undefined ? [] : [[item.done.visit, demoId('crm.plan', item.key)] as const],
    ),
  );

  const items = VISITS.map((seed) => {
    const occurredAt = localAt(seed.daysAgo, seed.hour);
    const createdAt = localAt(seed.daysAgo, seed.hour + 1.5);
    const corrections: (typeof VisitCorrectionSchema.Encoded)[] = (seed.corrections ?? []).map((correction) => {
      const result: typeof VisitCorrectionSchema.Encoded = {
        at: localAt(seed.daysAgo, seed.hour + correction.hoursAfter),
        by: principal(correction.by),
        field: correction.field,
      };
      if (correction.next !== undefined) {
        Object.assign(result, { next: correction.next });
      }
      if (correction.previous !== undefined) {
        Object.assign(result, { previous: correction.previous });
      }
      if (correction.reason !== undefined) {
        Object.assign(result, { reason: correction.reason });
      }
      return result;
    });
    const salespersonId = salesperson(seed.rep);
    const planItemId = plannedBy.get(seed.key);
    const visit: typeof VisitSchema.Encoded = {
      authorPrincipalId: principal(seed.rep),
      clientId: clientId(seed.client),
      corrections,
      createdAt,
      id: visitId(seed.key),
      kind: seed.kind,
      occurredAt,
      result: seed.result,
      updatedAt: corrections.at(-1)?.at ?? createdAt,
    };
    if (seed.nextStep !== undefined) {
      Object.assign(visit, { nextStep: seed.nextStep });
    }
    if (seed.nextStepInDays !== undefined) {
      Object.assign(visit, { nextStepDate: day(seed.nextStepInDays) });
    }
    if (seed.note !== undefined) {
      Object.assign(visit, { note: seed.note });
    }
    if (planItemId !== undefined) {
      Object.assign(visit, { planItemId });
    }
    if (salespersonId !== undefined) {
      Object.assign(visit, { salespersonId });
    }
    return visit;
  });

  const plan = PLAN.map((seed) => {
    const createdAt = localAt(seed.createdDaysAgo, 17);
    const doneAt = seed.done === undefined ? undefined : localAt(seed.done.daysAgo, 17);
    const item: typeof PlanItemSchema.Encoded = {
      clientId: clientId(seed.client),
      createdAt,
      createdBy: principal(seed.rep),
      dueDate: day(seed.dueInDays),
      id: demoId('crm.plan', seed.key),
      salespersonId: seed.rep === 'a' ? repA.id : repB.id,
      status: seed.done === undefined ? 'open' : 'done',
      updatedAt: doneAt ?? createdAt,
    };
    if (seed.note !== undefined) {
      Object.assign(item, { note: seed.note });
    }
    if (seed.sourceVisit !== undefined) {
      Object.assign(item, { sourceVisitId: visitId(seed.sourceVisit) });
    }
    if (seed.done !== undefined) {
      Object.assign(item, { doneAt, doneBy: principal(seed.rep) });
      if (seed.done.note !== undefined) {
        Object.assign(item, { doneNote: seed.done.note });
      }
      if (seed.done.visit !== undefined) {
        Object.assign(item, { doneVisitId: visitId(seed.done.visit) });
      }
    }
    return item;
  });

  return { items, plan };
};
