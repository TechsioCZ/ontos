/**
 * Štítky and Úkoly of the Nájempark (0021), Velkoobchod Hanák (0022) and Kavárna Doma (0023) demo companies, applied by
 * `seed-company-content.mts` through the public tagging and work-tasks Actions. Their records (rental tenants,
 * business cases, employees) come from Action-based seeds with server-generated IDs, so every reference here is a
 * natural key resolved through public reads at seed time: customer display name, employee login e-mail,
 * business case title. Tags are matched by name and tasks by title, so a re-run only adds what is missing.
 *
 * The e-shop companies (Kavárna Doma 0023, AKROS 0024) hold read-only Štítky; their catalogues live in the tagging
 * owner seed (`verticals/tagging/scripts/reset-demo.mts`) because their product and order IDs are deterministic.
 */
import type { TaskPrioritySchema, TaskState } from '@app/work-tasks/contracts/records';
import { DateTime, Schema } from 'effect';

import type { TagColor } from '../../verticals/tagging/shared/apis/records.ts';
import { legalTransitions } from '../../verticals/work-tasks/shared/actions/task-transitions.ts';
import { crmDemoLegalEntityId, eshopDemoLegalEntityId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { companyHumanAccounts, siamparkRentalPersonas } from './permissions.mts';
import { rentalStory } from './rental-seed.mts';

/** Tagging subject kinds whose records these companies keep (no products or orders). */
export const CompanySubjectKindSchema = Schema.Literals(['customer', 'employee', 'opportunity']);
export type CompanySubjectKind = typeof CompanySubjectKindSchema.Type;
type TaskPriority = typeof TaskPrioritySchema.Type;

/** A record a tag is assigned to, named by its natural key in the owning agenda. */
export type SubjectSpec =
  | { readonly kind: 'customer'; readonly name: string }
  | { readonly email: string; readonly kind: 'employee' }
  | { readonly kind: 'opportunity'; readonly title: string };

export interface TagSpec {
  readonly color: TagColor;
  readonly description: string;
  readonly name: string;
  readonly subjectKinds: readonly CompanySubjectKind[];
  readonly subjects: readonly SubjectSpec[];
}

export interface TaskSpec {
  /** Login e-mail of the responsible person (must be an assignable member of the company). */
  readonly assignee: string;
  /** Display name of the linked customer (Party Registry). */
  readonly customer?: string;
  readonly description: string;
  /** Due date relative to the seed day; negative values are overdue or already finished work. */
  readonly dueInDays: number;
  /** Title of the linked business case (sales pipeline). */
  readonly opportunity?: string;
  readonly priority: TaskPriority;
  readonly state: TaskState;
  readonly title: string;
}

export interface CompanyContent {
  readonly label: string;
  readonly legalEntityId: string;
  readonly tags: readonly TagSpec[];
  readonly tasks: readonly TaskSpec[];
  /** Company administrator who runs the Actions (holds tagging and work-tasks write). */
  readonly writerEmail: string;
}

/** Login e-mails of the demo personas (`permissions.mts`). */
const management = 'management@najempark.demo';
const operations = 'operations@najempark.demo';
const provoz = 'provoz@najempark.demo';
const finance = 'finance@najempark.demo';
const external = 'external@najempark.demo';
const hanakAdmin = 'spravce@hanak.demo';
const hanakManager = 'vedouci@hanak.demo';
const hanakRepA = 'obchodnik.a@hanak.demo';
const hanakRepB = 'obchodnik.b@hanak.demo';
const kavarnaAdmin = 'eshop@kavarna.demo';

const tenantName = (key: (typeof rentalStory.tenants)[number]['key']) =>
  rentalStory.tenants.find((tenant) => tenant.key === key)?.name ?? key;
const customer = (key: (typeof rentalStory.tenants)[number]['key']) =>
  ({ kind: 'customer', name: tenantName(key) }) as const;
const employee = (email: string) => ({ email, kind: 'employee' }) as const;
const rentalCase = rentalStory.opportunity.title;

const najempark: CompanyContent = {
  label: 'Nájempark',
  legalEntityId: rentalDemoLegalEntityId,
  tags: [
    {
      color: 'purple',
      description: 'Nájemci s dlouhodobou smlouvou a největším podílem na nájemném.',
      name: 'Klíčový nájemce',
      subjectKinds: ['customer'],
      subjects: [customer('kavarna'), customer('atelier')],
    },
    {
      color: 'green',
      description: 'Nový nájemce nebo rozjednaný nájem, který ještě nezačal.',
      name: 'Nový nájemce',
      subjectKinds: ['customer', 'opportunity'],
      subjects: [customer('lekarna'), { kind: 'opportunity', title: rentalCase }],
    },
    {
      color: 'red',
      description: 'Nájemné nebo zálohy na služby po splatnosti.',
      name: 'Pozdní platby',
      subjectKinds: ['customer'],
      subjects: [customer('atelier'), customer('technoservis')],
    },
    {
      color: 'orange',
      description: 'Nájem končí do tří měsíců; řešit prodloužení nebo předání prostor.',
      name: 'Končící nájem',
      subjectKinds: ['customer'],
      subjects: [customer('technoservis')],
    },
    {
      color: 'blue',
      description: 'Nájemce se stěhuje mezi jednotkami v areálu.',
      name: 'Stěhování v areálu',
      subjectKinds: ['customer'],
      subjects: [customer('novotny')],
    },
    {
      color: 'yellow',
      description: 'Gastro provoz: revize vzduchotechniky, tukové lapače a hygienické kontroly.',
      name: 'Gastro provoz',
      subjectKinds: ['customer'],
      subjects: [customer('kavarna')],
    },
    {
      color: 'gray',
      description: 'Drží pohotovost pro havárie v areálu mimo pracovní dobu.',
      name: 'Pohotovost',
      subjectKinds: ['employee'],
      subjects: [employee(operations)],
    },
    {
      color: 'pink',
      description: 'Externí spolupracovník bez přístupu k financím a smlouvám.',
      name: 'Externí spolupráce',
      subjectKinds: ['employee'],
      subjects: [employee(external)],
    },
  ],
  tasks: [
    {
      assignee: management,
      customer: tenantName('technoservis'),
      description: 'Nájem A101 končí 31. 10. a nájemce zvažuje prodloužení o rok; připravit dodatek s novým nájemným.',
      dueInDays: 1,
      priority: 'HIGH',
      state: 'IN_PROGRESS',
      title: 'Jednání o prodloužení nájmu A101 – Technoservis Praha',
    },
    {
      assignee: management,
      customer: tenantName('lekarna'),
      description: 'Smlouva na R301 čeká na odsouhlasení úprav dispozice; nástup nájemce 1. 12. 2026.',
      dueInDays: 10,
      opportunity: rentalCase,
      priority: 'HIGH',
      state: 'WAITING',
      title: 'Podepsat nájemní smlouvu R301 – Lékárna Na Nábřeží',
    },
    {
      assignee: management,
      description:
        'Obsazenost Rezidence Parková a Riverside Office Park, končící a nové nájmy, pohledávky po splatnosti.',
      dueInDays: 5,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Čtvrtletní přehled obsazenosti pro vlastníka',
    },
    {
      assignee: management,
      description: 'Sestavit plán oprav obou budov a rozpočet na příští rok, včetně rezervy na havárie.',
      dueInDays: 21,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Schválit plán oprav a rozpočet na rok 2027',
    },
    {
      assignee: operations,
      description: 'Elektřina, voda a teplo ve všech jednotkách; fotografie stavů uložit do provozního deníku.',
      dueInDays: 1,
      priority: 'HIGH',
      state: 'IN_PROGRESS',
      title: 'Odečty měřidel energií k 31. 10.',
    },
    {
      assignee: operations,
      description: 'Pravidelná roční revize hasicích přístrojů a hydrantů ve všech podlažích.',
      dueInDays: 12,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Revize hasicích přístrojů – Riverside Office Park',
    },
    {
      assignee: operations,
      description: 'Vyčistit okapy a svody, zkontrolovat krytinu a oplechování po podzimních bouřkách.',
      dueInDays: -3,
      priority: 'NORMAL',
      state: 'DONE',
      title: 'Kontrola střechy a okapů před zimou – Rezidence Parková',
    },
    {
      assignee: provoz,
      customer: tenantName('kavarna'),
      description: 'Výměna filtrů vzduchotechniky a digestoře; termín domluvit s kavárnou mimo otevírací dobu.',
      dueInDays: 6,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Výměna filtrů VZT v kavárně R101',
    },
    {
      assignee: provoz,
      description: 'Poptávka u dvou dodavatelů odeslána, čeká se na cenové nabídky na sezónu 2026/2027.',
      dueInDays: 14,
      priority: 'NORMAL',
      state: 'WAITING',
      title: 'Objednat zimní údržbu chodníků a parkoviště',
    },
    {
      assignee: provoz,
      customer: tenantName('novotny'),
      description: 'Vyklizení a úklid sklepní kóje po předání bytu A202.',
      dueInDays: -6,
      priority: 'LOW',
      state: 'DONE',
      title: 'Úklid sklepní kóje po vyklizení bytu A202',
    },
    {
      assignee: finance,
      customer: tenantName('atelier'),
      description: 'Dvě faktury za nájem R201 jsou po splatnosti; odeslat upomínku a nabídnout splátkový kalendář.',
      dueInDays: -4,
      priority: 'HIGH',
      state: 'IN_PROGRESS',
      title: 'Upomínka nájemného R201 – Ateliér Horák',
    },
    {
      assignee: finance,
      customer: tenantName('technoservis'),
      description: 'Po předání bytu A101 započíst nedoplatky a vrátit zbytek jistoty do 30 dnů.',
      dueInDays: 8,
      priority: 'HIGH',
      state: 'NEW',
      title: 'Vyúčtování kauce při skončení nájmu A101',
    },
    {
      assignee: finance,
      description: 'Připravit oznámení nájemcům podle inflační doložky ve smlouvách a nové předpisy plateb.',
      dueInDays: 40,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Indexace nájemného o inflaci od 1. 1. 2027',
    },
    {
      assignee: finance,
      description: 'Spárovat říjnové platby z bankovního výpisu s vydanými fakturami za nájem.',
      dueInDays: -1,
      priority: 'NORMAL',
      state: 'DONE',
      title: 'Spárovat přijaté platby nájemného za říjen',
    },
    {
      assignee: finance,
      customer: tenantName('kavarna'),
      description: 'Roční vyúčtování záloh na služby; čeká se na podklady od dodavatele tepla.',
      dueInDays: 25,
      priority: 'NORMAL',
      state: 'WAITING',
      title: 'Roční vyúčtování služeb – Kavárna U Parku',
    },
    {
      assignee: external,
      description: 'Zájemce z inzerce; ukázat byt 3+kk, předat ceník a podmínky nájmu.',
      dueInDays: 3,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Prohlídka volného bytu A102 se zájemcem',
    },
    {
      assignee: external,
      description: 'Nabídka skladu S01 pro e-shop z okolí: plocha, přístup pro dodávky, cena za m².',
      dueInDays: 9,
      priority: 'NORMAL',
      state: 'IN_PROGRESS',
      title: 'Připravit nabídku pronájmu skladu S01',
    },
    {
      assignee: external,
      description: 'Obvoláno pět zájemců z jarní kampaně; dva chtějí prohlídku v listopadu.',
      dueInDays: -5,
      priority: 'LOW',
      state: 'DONE',
      title: 'Obvolat zájemce o kanceláře v Riverside',
    },
  ],
  writerEmail: management,
};

const hanak: CompanyContent = {
  label: 'Velkoobchod Hanák',
  legalEntityId: crmDemoLegalEntityId,
  tags: [
    {
      color: 'purple',
      description: 'Odběratelé s nejvyšším obratem; pravidelná návštěva alespoň jednou měsíčně.',
      name: 'Klíčový odběratel',
      subjectKinds: ['customer'],
      subjects: [],
    },
    {
      color: 'orange',
      description: 'Restaurace, hotely a jídelny (HoReCa) s pravidelnými závozy.',
      name: 'Gastro a hotely',
      subjectKinds: ['customer'],
      subjects: [],
    },
    {
      color: 'blue',
      description: 'Prodejny potravin a pekárny s vlastním prodejem.',
      name: 'Maloobchod',
      subjectKinds: ['customer'],
      subjects: [],
    },
    {
      color: 'red',
      description: 'Klient klesá v odběrech nebo jedná s konkurencí.',
      name: 'Riziko odchodu',
      subjectKinds: ['customer'],
      subjects: [],
    },
    {
      color: 'green',
      description: 'Obchodník s vlastním rajonem a plánem návštěv.',
      name: 'Terénní obchodník',
      subjectKinds: ['employee'],
      subjects: [employee(hanakRepA), employee(hanakRepB)],
    },
    {
      color: 'gray',
      description: 'Schvaluje slevy, rámcové smlouvy a přidělení klientů.',
      name: 'Vedení firmy',
      subjectKinds: ['employee'],
      subjects: [employee(hanakAdmin), employee(hanakManager)],
    },
    {
      color: 'yellow',
      description: 'Zaučuje nové obchodníky a doprovází je na prvních návštěvách.',
      name: 'Mentor nováčků',
      subjectKinds: ['employee'],
      subjects: [employee(hanakManager)],
    },
  ],
  tasks: [
    {
      assignee: hanakAdmin,
      description: 'Vyjednat ceny mouky a pevné termíny dodávek na rok 2027; návrh smlouvy je u mlýna.',
      dueInDays: 20,
      priority: 'HIGH',
      state: 'IN_PROGRESS',
      title: 'Obnovit rámcovou smlouvu s mlýnem na rok 2027',
    },
    {
      assignee: hanakAdmin,
      description: 'Projít objednávky načtené z e-mailu a opravit neznámé kódy zboží.',
      dueInDays: 1,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Zkontrolovat import objednávek z e-mailu',
    },
    {
      assignee: hanakAdmin,
      description: 'Nového obchodního asistenta přidat do CRM a úkolů, bez přístupu ke slevám.',
      dueInDays: 4,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Nastavit přístupy pro nového obchodního asistenta',
    },
    {
      assignee: hanakAdmin,
      description: 'Bufet ukončil provoz; klienta archivovat a uzavřít otevřené nabídky.',
      dueInDays: -10,
      priority: 'LOW',
      state: 'DONE',
      title: 'Archivovat klienta Bufet Nádraží Břeclav',
    },
    {
      assignee: hanakManager,
      description: 'Cukrárna Sladká tečka a Penzion U Mlýna zatím nemají přiřazeného obchodníka.',
      dueInDays: 2,
      priority: 'HIGH',
      state: 'IN_PROGRESS',
      title: 'Přidělit obchodníka klientům bez vlastníka',
    },
    {
      assignee: hanakManager,
      description: 'Porovnat uskutečněné návštěvy s plánem oslovení u obou obchodníků.',
      dueInDays: 3,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Vyhodnotit plnění plánu návštěv za říjen',
    },
    {
      assignee: hanakManager,
      description: 'Distributor žádá 5 % slevu za roční odběr; čeká se na potvrzení objemů.',
      dueInDays: -1,
      priority: 'HIGH',
      state: 'WAITING',
      title: 'Schválit slevu 5 % pro Morava-Gastro distribuce',
    },
    {
      assignee: hanakManager,
      description: 'Představit vánoční sortiment, cíle na prosinec a rozdělení ochutnávek.',
      dueInDays: 6,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Porada obchodního týmu – vánoční sortiment',
    },
    {
      assignee: hanakRepA,
      description: 'Paní Malá zvažuje změnu dodavatele; nabídnout novou cenu mouky T650 a závoz 2× týdně.',
      dueInDays: 1,
      priority: 'HIGH',
      state: 'NEW',
      title: 'Zavolat Pekárně Malá kvůli nové ceně mouky',
    },
    {
      assignee: hanakRepA,
      description: 'Ochutnávka regionálních uzenin pro šéfkuchaře; přivézt vzorky a ceník.',
      dueInDays: 7,
      priority: 'NORMAL',
      state: 'IN_PROGRESS',
      title: 'Ochutnávka regionálních uzenin – Restaurace U Zlaté husy',
    },
    {
      assignee: hanakRepA,
      description: 'Dodávka droždí přišla po datu spotřeby; čeká se na vyjádření dodavatele.',
      dueInDays: -2,
      priority: 'HIGH',
      state: 'WAITING',
      title: 'Vyřešit reklamaci droždí – Potraviny Černá',
    },
    {
      assignee: hanakRepA,
      description: 'Ceník na 1. čtvrtletí 2027 včetně nového sortimentu snídaňových pečiv.',
      dueInDays: 12,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Poslat ceník na 1. čtvrtletí – Hotel Podhradí',
    },
    {
      assignee: hanakRepA,
      description: 'Jídelna vypisuje výběrové řízení na dodávky; předány podklady a vzorky.',
      dueInDays: -8,
      priority: 'NORMAL',
      state: 'DONE',
      title: 'Návštěva Školní jídelny ZŠ Blansko',
    },
    {
      assignee: hanakRepB,
      description: 'Vánoční menu: nabídnout kachny, zvěřinu a sváteční pečivo s dodáním do 20. 12.',
      dueInDays: 4,
      priority: 'HIGH',
      state: 'IN_PROGRESS',
      title: 'Nabídka vánočního sortimentu – Zámecká restaurace',
    },
    {
      assignee: hanakRepB,
      description: 'Hotel chce závozy úterý a pátek do 9:00; ověřit kapacitu trasy Zlín.',
      dueInDays: 8,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Domluvit závozové dny – Lázeňský hotel Morava',
    },
    {
      assignee: hanakRepB,
      description: 'Poslední dvě faktury byly uhrazeny po splatnosti; zvážit platbu předem.',
      dueInDays: 2,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Ověřit platební morálku – Catering Vsetín',
    },
    {
      assignee: hanakRepB,
      description: 'Předány vzorky moravských sýrů k degustačnímu menu.',
      dueInDays: -5,
      priority: 'LOW',
      state: 'DONE',
      title: 'Předat vzorky sýrů – Vinařství a restaurace Na Sklepích',
    },
    {
      assignee: hanakRepB,
      description: 'Klient schůzku zrušil, nový termín až po Novém roce.',
      dueInDays: -3,
      priority: 'NORMAL',
      state: 'CANCELLED',
      title: 'Prezentace kávového sortimentu – Bistro Král',
    },
  ],
  writerEmail: hanakAdmin,
};

const kavarna: CompanyContent = {
  label: 'Kavárna Doma',
  legalEntityId: eshopDemoLegalEntityId,
  // The e-shop administrator reads tags; its catalogue stays in the tagging owner seed.
  tags: [],
  tasks: [
    {
      assignee: kavarnaAdmin,
      description: 'Ověřit platby víkendových objednávek a předat zaplacené zásilky Ondřeji Křížovi k expedici.',
      dueInDays: 0,
      priority: 'HIGH',
      state: 'IN_PROGRESS',
      title: 'Připravit zaplacené objednávky kávy k expedici',
    },
    {
      assignee: kavarnaAdmin,
      description: 'Zákaznice čeká na výměnu poškozeného balení zrnkové kávy; potvrdit adresu a odeslání náhrady.',
      dueInDays: -2,
      priority: 'HIGH',
      state: 'WAITING',
      title: 'Dořešit reklamaci poškozené zásilky kávy',
    },
    {
      assignee: kavarnaAdmin,
      description: 'Porovnat zásobu espresso směsi a bezkofeinové kávy se stavem e-shopu, zapsat rozdíly po inventuře.',
      dueInDays: 1,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Zkontrolovat sklad kávy po víkendovém prodeji',
    },
    {
      assignee: kavarnaAdmin,
      description: 'Pražírna má potvrdit termín další várky a dostupnost 250g balení před spuštěním dárkové nabídky.',
      dueInDays: 3,
      priority: 'HIGH',
      state: 'WAITING',
      title: 'Potvrdit dodávku vánoční kávy s pražírnou',
    },
    {
      assignee: kavarnaAdmin,
      description: 'S Ondřejem Křížem spočítat krabice a výplňový materiál a objednat zásobu na příští dva týdny.',
      dueInDays: 2,
      priority: 'NORMAL',
      state: 'IN_PROGRESS',
      title: 'Doplnit obaly pro zásilky e-shopu',
    },
    {
      assignee: kavarnaAdmin,
      description: 'Připravit fotografie dárkových sad, text s doporučením kávy a termín rozeslání zákazníkům.',
      dueInDays: 7,
      priority: 'NORMAL',
      state: 'NEW',
      title: 'Připravit newsletter s dárkovými sadami kávy',
    },
    {
      assignee: kavarnaAdmin,
      description: 'Opravené popisy mletí a přípravy filtrované kávy jsou zveřejněné u produktů v e-shopu.',
      dueInDays: -1,
      priority: 'LOW',
      state: 'DONE',
      title: 'Doplnit doporučení přípravy k produktům',
    },
    {
      assignee: kavarnaAdmin,
      description:
        'Dodavatel vyprodal sezónní sirup; plánovanou slevovou akci nahradí nabídka dostupných dárkových sad.',
      dueInDays: -3,
      priority: 'LOW',
      state: 'CANCELLED',
      title: 'Spustit akci na sezónní kávový sirup',
    },
  ],
  writerEmail: kavarnaAdmin,
};

export const companyContent: readonly CompanyContent[] = [najempark, hanak, kavarna];

/** Login e-mail → principal ID of every Nájempark and CRM/e-shop company persona. */
export const personaPrincipalIds: ReadonlyMap<string, string> = new Map([
  ...siamparkRentalPersonas.map((persona) => [persona.email, persona.principalId] as const),
  ...companyHumanAccounts.map((account) => [account.email, account.principalId] as const),
]);

const sameName = (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase();

/** Tag specs whose name is not yet in the catalogue (case-insensitive, as the tagging owner enforces). */
export const missingTags = (specs: readonly TagSpec[], existing: readonly { readonly name: string }[]) =>
  specs.filter((spec) => !existing.some((tag) => sameName(tag.name, spec.name)));

/** The existing tag for a spec, if any. */
export const existingTag = <T extends { readonly name: string }>(spec: TagSpec, existing: readonly T[]) =>
  existing.find((tag) => sameName(tag.name, spec.name));

/** Task specs whose title is not yet in the company's task list. */
export const missingTasks = (specs: readonly TaskSpec[], existingTitles: readonly string[]) =>
  specs.filter((spec) => !existingTitles.includes(spec.title));

/** Shortest legal state path from NEW (the state CreateTask produces) to the target state. */
export const statePath = (target: TaskState): readonly TaskState[] => {
  const queue: (readonly TaskState[])[] = [[]];
  while (queue.length > 0) {
    const path = queue.shift() ?? [];
    const current = path.at(-1) ?? 'NEW';
    if (current === target) {
      return path;
    }
    for (const next of legalTransitions[current]) {
      if (!path.includes(next)) {
        queue.push([...path, next]);
      }
    }
  }
  return [];
};

/** Calendar due date `days` after `today`. */
export const dueDate = (today: DateTime.Utc, days: number) => DateTime.formatIsoDateUtc(DateTime.add(today, { days }));
