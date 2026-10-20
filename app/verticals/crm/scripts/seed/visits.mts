// Seed of the visits area (C02 visits, C06 manual plan) — owned by the crm-visits lane.
// reset-demo.mts calls seedVisits(); every date is relative to the reset time so the demo always shows
// "last 3 months of visits" and "a plan for the next 2 weeks". Ids are deterministic demoId()s.
import { DateTime } from 'effect';
import { demoId } from '../../../../scripts/demo/fixture-ids.mts';

interface Rep {
  readonly id: string;
  readonly principalId: string;
}

export interface VisitsSeedInput {
  readonly now: DateTime.Utc;
  readonly repA: Rep;
  readonly repB: Rep;
  /** Principal of the sales lead (Vedoucí obchodu). */
  readonly leadPrincipalId: string;
}

type Kind = 'visit' | 'call' | 'video' | 'email';

interface VisitSeed {
  readonly key: string;
  readonly client: string;
  readonly rep: 'a' | 'b' | 'lead';
  /** Days before the reset. */
  readonly daysAgo: number;
  /** Local (Prague) hour + minutes, e.g. 9.5 = 09:30. */
  readonly hour: number;
  readonly kind: Kind;
  readonly result: string;
  readonly note?: string;
  readonly nextStep?: string;
  /** Days after the reset (negative = already past). */
  readonly nextStepInDays?: number;
  readonly corrections?: readonly {
    readonly by: 'a' | 'b' | 'lead';
    readonly field: string;
    readonly previous?: string;
    readonly next?: string;
    readonly reason?: string;
    readonly hoursAfter: number;
  }[];
}

const VISITS: readonly VisitSeed[] = [
  // Jan Novák (A)
  {
    client: 'pekarna-mala',
    daysAgo: 84,
    hour: 9,
    key: 'a-01',
    kind: 'visit',
    note: 'Paní Malá zvažuje změnu dodavatele mouky, současný dodavatel zdražil o 12 %.',
    rep: 'a',
    result: 'Úvodní schůzka, předán katalog',
  },
  {
    client: 'zlata-husa',
    daysAgo: 77,
    hour: 14,
    key: 'a-02',
    kind: 'call',
    rep: 'a',
    result: 'Domluvena ochutnávka uzenin',
  },
  {
    client: 'hotel-podhradi',
    daysAgo: 70,
    hour: 10.5,
    key: 'a-03',
    kind: 'visit',
    note: 'Hotel chystá rekonstrukci kuchyně, objednávky omezí na podzim.',
    rep: 'a',
    result: 'Prezentace sortimentu pro snídaně',
  },
  {
    client: 'zs-blansko',
    daysAgo: 63,
    hour: 8.5,
    key: 'a-04',
    kind: 'email',
    rep: 'a',
    result: 'Zaslána nabídka na školní rok',
  },
  {
    client: 'potraviny-cerna',
    daysAgo: 56,
    hour: 11,
    key: 'a-05',
    kind: 'visit',
    note: 'Prodejna má málo místa ve skladu, preferuje menší a častější dodávky.',
    rep: 'a',
    result: 'Dohodnuty dodávky 1× týdně',
  },
  {
    client: 'kavarna-na-rohu',
    daysAgo: 49,
    hour: 15,
    key: 'a-06',
    kind: 'video',
    rep: 'a',
    result: 'Videohovor k sortimentu dezertů',
  },
  {
    client: 'pekarna-mala',
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
    client: 'zlata-husa',
    daysAgo: 35,
    hour: 13,
    key: 'a-08',
    kind: 'visit',
    note: 'Provozní pan Dvořák chce zkusit nový dodací režim od listopadu.',
    rep: 'a',
    result: 'Ochutnávka proběhla, zájem o uzeniny',
  },
  {
    client: 'zs-blansko',
    daysAgo: 28,
    hour: 10,
    key: 'a-09',
    kind: 'call',
    rep: 'a',
    result: 'Upřesněny alergeny v nabídce',
  },
  {
    client: 'pekarna-mala',
    daysAgo: 21,
    hour: 9,
    key: 'v1',
    kind: 'visit',
    note: 'Zájem o pravidelné dodávky 2× týdně.',
    rep: 'a',
    result: 'Představení podzimní nabídky mouky',
  },
  {
    client: 'hotel-podhradi',
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
    client: 'kavarna-na-rohu',
    daysAgo: 12,
    hour: 14.5,
    key: 'a-11',
    kind: 'email',
    rep: 'a',
    result: 'Odeslán ceník dezertů na zimní sezónu',
  },
  {
    client: 'zlata-husa',
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
    client: 'potraviny-cerna',
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
    client: 'bistro-kral',
    daysAgo: 88,
    hour: 10,
    key: 'b-01',
    kind: 'visit',
    note: 'Bistro rozšiřuje polední menu, hledá stálého dodavatele masa.',
    rep: 'b',
    result: 'Úvodní schůzka s jednatelem',
  },
  {
    client: 'lazensky-hotel',
    daysAgo: 80,
    hour: 13.5,
    key: 'b-02',
    kind: 'visit',
    rep: 'b',
    result: 'Prezentace pro F&B manažera',
  },
  {
    client: 'minimarket-hodonin',
    daysAgo: 72,
    hour: 9,
    key: 'b-03',
    kind: 'call',
    rep: 'b',
    result: 'Minimarket má zájem jen o trvanlivé zboží',
  },
  {
    client: 'catering-vsetin',
    daysAgo: 65,
    hour: 11,
    key: 'b-04',
    kind: 'video',
    note: 'Catering obsluhuje firemní akce do 300 osob, potřebuje rychlé doplnění zásob.',
    rep: 'b',
    result: 'Videohovor k sezónním akcím',
  },
  {
    client: 'zamecka-restaurace',
    daysAgo: 58,
    hour: 15,
    key: 'b-05',
    kind: 'visit',
    rep: 'b',
    result: 'Ochutnávka s šéfkuchařem',
  },
  {
    client: 'bistro-kral',
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
    client: 'lazensky-hotel',
    daysAgo: 37,
    hour: 9.5,
    key: 'b-07',
    kind: 'email',
    rep: 'b',
    result: 'Zaslán návrh ročního kontraktu',
  },
  {
    client: 'catering-vsetin',
    daysAgo: 24,
    hour: 14,
    key: 'b-08',
    kind: 'call',
    rep: 'b',
    result: 'Řešena pozdní dodávka, omluva a sleva 5 %',
  },
  {
    client: 'bistro-kral',
    daysAgo: 14,
    hour: 11,
    key: 'v3',
    kind: 'visit',
    note: 'Dobropis vystaví účetní systém.',
    rep: 'b',
    result: 'Reklamace dodávky vyřešena',
  },
  {
    client: 'minimarket-hodonin',
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
    client: 'lazensky-hotel',
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
  readonly key: string;
  readonly client: string;
  readonly rep: 'a' | 'b';
  /** Days after the reset (negative = overdue). */
  readonly dueInDays: number;
  readonly createdDaysAgo: number;
  readonly note?: string;
  readonly sourceVisit?: string;
  readonly done?: {
    readonly daysAgo: number;
    readonly note?: string;
    readonly visit?: string;
  };
}

const PLAN: readonly PlanSeed[] = [
  // A — open
  {
    client: 'kavarna-na-rohu',
    createdDaysAgo: 12,
    dueInDays: -2,
    key: 'p-a-1',
    note: 'Zeptat se na reakci k ceníku dezertů',
    rep: 'a',
  },
  {
    client: 'zs-blansko',
    createdDaysAgo: 6,
    dueInDays: 0,
    key: 'p-a-2',
    note: 'Potvrdit dodávky na listopad',
    rep: 'a',
  },
  {
    client: 'zlata-husa',
    createdDaysAgo: 9,
    dueInDays: 2,
    key: 'p-a-3',
    note: 'Ověřit spokojenost se zkušební objednávkou',
    rep: 'a',
    sourceVisit: 'v2',
  },
  {
    client: 'potraviny-cerna',
    createdDaysAgo: 3,
    dueInDays: 4,
    key: 'p1',
    note: 'Ozvat se k nové ceníkové nabídce.',
    rep: 'a',
    sourceVisit: 'a-12',
  },
  {
    client: 'hotel-podhradi',
    createdDaysAgo: 16,
    dueInDays: 9,
    key: 'p-a-4',
    note: 'Zaslat ceník snídaňového sortimentu po rekonstrukci',
    rep: 'a',
    sourceVisit: 'a-10',
  },
  {
    client: 'pekarna-mala',
    createdDaysAgo: 2,
    dueInDays: 13,
    key: 'p-a-5',
    note: 'Kontrola plnění rámcové dohody',
    rep: 'a',
  },
  // A — done
  {
    client: 'kavarna-na-rohu',
    createdDaysAgo: 20,
    done: { daysAgo: 12, note: 'Ceník odeslán e-mailem', visit: 'a-11' },
    dueInDays: -12,
    key: 'p-a-6',
    note: 'Poslat ceník dezertů',
    rep: 'a',
  },
  {
    client: 'zs-blansko',
    createdDaysAgo: 35,
    done: { daysAgo: 28, visit: 'a-09' },
    dueInDays: -28,
    key: 'p-a-7',
    note: 'Doplnit informace o alergenech',
    rep: 'a',
  },
  // B — open
  {
    client: 'minimarket-hodonin',
    createdDaysAgo: 10,
    dueInDays: 3,
    key: 'p-b-1',
    note: 'Nabídnout trvanlivý sortiment na Vánoce',
    rep: 'b',
    sourceVisit: 'b-09',
  },
  {
    client: 'zamecka-restaurace',
    createdDaysAgo: 2,
    dueInDays: 7,
    key: 'p2',
    note: 'Pozvat šéfkuchaře na zimní ochutnávku',
    rep: 'b',
  },
  {
    client: 'lazensky-hotel',
    createdDaysAgo: 5,
    dueInDays: 8,
    key: 'p-b-2',
    note: 'Poslat upravený návrh ročního kontraktu',
    rep: 'b',
    sourceVisit: 'v4',
  },
  {
    client: 'catering-vsetin',
    createdDaysAgo: 4,
    dueInDays: 1,
    key: 'p-b-3',
    note: 'Ověřit spokojenost po reklamaci',
    rep: 'b',
  },
  {
    client: 'bistro-kral',
    createdDaysAgo: 1,
    dueInDays: 12,
    key: 'p-b-4',
    note: 'Domluvit prodloužení objednávky masa',
    rep: 'b',
  },
  // B — done
  {
    client: 'catering-vsetin',
    createdDaysAgo: 30,
    done: { daysAgo: 24, note: 'Reklamace vyřízena po telefonu', visit: 'b-08' },
    dueInDays: -25,
    key: 'p-b-5',
    note: 'Vyřešit pozdní dodávku',
    rep: 'b',
  },
];

/** Encoded visits slice (VisitsSlice) for the reset time `now`. */
export const seedVisits = ({ leadPrincipalId, now, repA, repB }: VisitsSeedInput) => {
  const today = DateTime.startOf(now, 'day');
  // Prague is UTC+1/UTC+2; one hour offset keeps every seeded time inside working hours either way.
  const localAt = (daysAgo: number, hour: number) =>
    DateTime.formatIso(
      DateTime.add(DateTime.subtract(today, { days: daysAgo }), { minutes: Math.round((hour - 1) * 60) }),
    );
  const day = (inDays: number) => DateTime.formatIso(DateTime.add(today, { days: inDays })).slice(0, 10);
  const clientId = (key: string) => demoId('crm.client', key);
  const visitId = (key: string) => demoId('crm.visit', key);
  const principal = (who: 'a' | 'b' | 'lead') =>
    who === 'a' ? repA.principalId : who === 'b' ? repB.principalId : leadPrincipalId;
  const salesperson = (who: 'a' | 'b' | 'lead') => (who === 'a' ? repA.id : who === 'b' ? repB.id : undefined);
  const plannedBy = new Map(
    PLAN.flatMap((item) =>
      item.done?.visit === undefined ? [] : [[item.done.visit, demoId('crm.plan', item.key)] as const],
    ),
  );

  const items = VISITS.map((seed) => {
    const occurredAt = localAt(seed.daysAgo, seed.hour);
    const createdAt = localAt(seed.daysAgo, seed.hour + 1.5);
    const corrections = (seed.corrections ?? []).map((correction) => ({
      at: localAt(seed.daysAgo, seed.hour + correction.hoursAfter),
      by: principal(correction.by),
      field: correction.field,
      ...(correction.next === undefined ? {} : { next: correction.next }),
      ...(correction.previous === undefined ? {} : { previous: correction.previous }),
      ...(correction.reason === undefined ? {} : { reason: correction.reason }),
    }));
    const salespersonId = salesperson(seed.rep);
    const planItemId = plannedBy.get(seed.key);
    return {
      authorPrincipalId: principal(seed.rep),
      clientId: clientId(seed.client),
      corrections,
      createdAt,
      id: visitId(seed.key),
      kind: seed.kind,
      ...(seed.nextStep === undefined ? {} : { nextStep: seed.nextStep }),
      ...(seed.nextStepInDays === undefined ? {} : { nextStepDate: day(seed.nextStepInDays) }),
      ...(seed.note === undefined ? {} : { note: seed.note }),
      occurredAt,
      ...(planItemId === undefined ? {} : { planItemId }),
      result: seed.result,
      ...(salespersonId === undefined ? {} : { salespersonId }),
      updatedAt: corrections.at(-1)?.at ?? createdAt,
    };
  });

  const plan = PLAN.map((seed) => {
    const createdAt = localAt(seed.createdDaysAgo, 17);
    const doneAt = seed.done === undefined ? undefined : localAt(seed.done.daysAgo, 17);
    return {
      clientId: clientId(seed.client),
      createdAt,
      createdBy: principal(seed.rep),
      dueDate: day(seed.dueInDays),
      id: demoId('crm.plan', seed.key),
      ...(seed.note === undefined ? {} : { note: seed.note }),
      salespersonId: salesperson(seed.rep),
      ...(seed.sourceVisit === undefined ? {} : { sourceVisitId: visitId(seed.sourceVisit) }),
      status: seed.done === undefined ? 'open' : 'done',
      ...(seed.done === undefined
        ? {}
        : {
            doneAt,
            doneBy: principal(seed.rep),
            ...(seed.done.note === undefined ? {} : { doneNote: seed.done.note }),
            ...(seed.done.visit === undefined ? {} : { doneVisitId: visitId(seed.done.visit) }),
          }),
      updatedAt: doneAt ?? createdAt,
    };
  });

  return { items, plan };
};
