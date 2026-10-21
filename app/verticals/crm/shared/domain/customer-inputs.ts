// AREA: customer inputs (CRM.md §6, R01–R08). Register of what the customer still has to supply or decide: what is
// missing, who asked for it and when, what exactly it blocks, the evidence of the request and its state. A delivered
// sample keeps its schema version and approval date. R04 approval of the status mapping is what switches the sales
// report from raw statuses to business meanings (C03/C05: "storno / dodáno / uhrazeno" only after confirmation).
// Adding fields: make them Schema.optionalKey (persisted JSON from older revisions must still decode).
import { Schema } from 'effect';
import { IsoTimeSchema, LongTextSchema, PrincipalIdSchema, ShortTextSchema } from './common.ts';

export const customerInputIds = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08'] as const;
export const CustomerInputIdSchema = Schema.Literals(customerInputIds);
export type CustomerInputId = typeof CustomerInputIdSchema.Type;

export const CustomerInputStatusSchema = Schema.Literals(['requested', 'received', 'approved', 'not_needed']);
export type CustomerInputStatus = typeof CustomerInputStatusSchema.Type;

export const customerInputStatusLabels: Record<CustomerInputStatus, string> = {
  approved: 'Odsouhlaseno zákazníkem',
  not_needed: 'Už není potřeba',
  received: 'Dodáno – čeká na odsouhlasení',
  requested: 'Vyžádáno – čeká na zákazníka',
};

/** One state change of an input, newest last. */
export const CustomerInputChangeSchema = Schema.Struct({
  at: IsoTimeSchema,
  by: PrincipalIdSchema,
  note: Schema.optionalKey(LongTextSchema),
  status: CustomerInputStatusSchema,
});

export const CustomerInputSchema = Schema.Struct({
  /** Evidence of the request (document, e-mail, meeting minutes). */
  evidence: LongTextSchema,
  history: Schema.Array(CustomerInputChangeSchema),
  id: CustomerInputIdSchema,
  note: Schema.optionalKey(LongTextSchema),
  /** Calendar day the input was requested (YYYY-MM-DD). */
  requestedAt: IsoTimeSchema,
  requestedBy: ShortTextSchema,
  /** Calendar day the customer approved the delivered sample / rule. */
  sampleApprovedAt: Schema.optionalKey(IsoTimeSchema),
  /** Schema / template / mapping version of the delivered sample, e.g. "crm-orders-csv-v1", "stavy-v1". */
  sampleVersion: Schema.optionalKey(ShortTextSchema),
  status: CustomerInputStatusSchema,
  updatedAt: Schema.optionalKey(IsoTimeSchema),
  updatedBy: Schema.optionalKey(PrincipalIdSchema),
});
export type CustomerInput = typeof CustomerInputSchema.Type;

/** Persisted entries only; inputs nobody has touched yet come from the defaults below. */
export const CustomerInputsSliceSchema = Schema.Array(CustomerInputSchema);
export type CustomerInputsSlice = typeof CustomerInputsSliceSchema.Type;

export interface CustomerInputDefinition {
  /** What may be shown until the input arrives. */
  readonly demoFallback: string;
  readonly id: CustomerInputId;
  /** What must not be declared done without it. */
  readonly blocks: string;
  /** What the customer has to supply / decide. */
  readonly title: string;
}

/** CRM.md §6 table, verbatim meaning. */
export const customerInputDefinitions: readonly CustomerInputDefinition[] = [
  {
    blocks: 'Živé propojení s reálným e-shopem či účetnictvím',
    demoFallback: 'Import dle vzorové CSV šablony a demo data',
    id: 'R01',
    title: 'Vzorek objednávky a změny stavu; CSV, API nebo webhook; přístup / testovací prostředí',
  },
  {
    blocks: 'Správné odstranění duplicit napříč zdroji',
    demoFallback: 'Zdrojově označené záznamy; nejasné případy k prověření',
    id: 'R02',
    title: 'Určení autoritativního zdroje; pravidlo korelace e-shop / účetnictví',
  },
  {
    blocks: 'Automatické spolehlivé rozpoznání všech klientů',
    demoFallback: 'Ruční přiřazení objednávek',
    id: 'R03',
    title: 'Externí zákaznické ID a schválené mapování na Party / Counterparty',
  },
  {
    blocks: 'Čistá tržba, definitivní počet dokončených prodejů; statistiky podle významu stavů',
    demoFallback: 'Surové stavy; počty a hodnoty evidovaných objednávek',
    id: 'R04',
    title: 'Význam všech stavů, storen, vratek, změny cen',
  },
  {
    blocks: 'Prodejnost konkrétních výrobků',
    demoFallback: 'Souhrn podle objednávek a klientů',
    id: 'R05',
    title: 'Dostupnost položek, SKU a množství',
  },
  {
    blocks: 'Definitivní konfigurace obchodních oprávnění',
    demoFallback: 'Jednoduché přidělení a omezený přístup',
    id: 'R06',
    title: 'Organizace týmu, pravidla přidělení a sdílení klientů',
  },
  {
    blocks: 'Automatický výběr klientů k telefonátu (C07)',
    demoFallback: 'Ruční plán, počty a data objednávek',
    id: 'R07',
    title: 'Pravidlo opakovanosti a doporučení + testovací příklady',
  },
  {
    blocks: 'Bezpodmínečné produkční zpracování osobních údajů',
    demoFallback: 'Testovací / anonymní data, omezené role',
    id: 'R08',
    title: 'Pravidla ochrany kontaktů, právní titul, retenční doby',
  },
];

/** Version of the status mapping proposal and of the CSV template the demo offers for approval. */
export const proposedSampleVersions: Partial<Record<CustomerInputId, string>> = {
  R01: 'crm-orders-csv-v1',
  R04: 'stavy-v1',
};

/** Every input was requested with the demo assignment of 19. 10. 2026 (CRM.md §6 and §10). */
const defaultInput = (id: CustomerInputId): CustomerInput => ({
  evidence: 'Zadání CRM dema, kap. 6 „Co zákazník musí dodat / rozhodnout“ (19. 10. 2026)',
  history: [],
  id,
  requestedAt: '2026-10-19',
  requestedBy: 'Techsio – dodavatel dema',
  ...(proposedSampleVersions[id] === undefined ? {} : { sampleVersion: proposedSampleVersions[id] }),
  status: 'requested',
});

/** All eight inputs: persisted state over the defaults, in R01–R08 order. */
export const customerInputsOf = (slice: CustomerInputsSlice | undefined): readonly CustomerInput[] =>
  customerInputIds.map((id) => slice?.find((entry) => entry.id === id) ?? defaultInput(id));

export const customerInputOf = (slice: CustomerInputsSlice | undefined, id: CustomerInputId): CustomerInput =>
  slice?.find((entry) => entry.id === id) ?? defaultInput(id);

/**
 * True only when the customer approved R04 for exactly this mapping version. Until then the report shows raw
 * statuses only and never counts "stornované / dodané / uhrazené" (C03, C05).
 */
export const statusMappingApproved = (slice: CustomerInputsSlice | undefined, mappingVersion: string): boolean => {
  const input = customerInputOf(slice, 'R04');
  return input.status === 'approved' && input.sampleVersion === mappingVersion && input.sampleApprovedAt !== undefined;
};
