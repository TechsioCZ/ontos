/**
 * Czech labels for the MCP catalog: module names, command and read titles, write-policy sentences.
 * Pure data and functions, no I/O.
 */
import type { Access, CatalogEntry } from '../capabilities/types.ts';
import type { WritePolicy } from '../session.ts';

export const MODULE_CS: Readonly<Record<string, { readonly label: string; readonly description: string }>> = {
  'commerce.customer-context': {
    label: 'Zákaznický kontext e-shopu',
    description: 'Zákaznické profily, skupiny, adresy a nákupní pravidla e-shopu (interní platformní modul).',
  },
  'demo.crm': {
    label: 'CRM – klienti a obchodníci',
    description: 'Klienti, kontaktní osoby, návštěvy, plán kontaktů, obchodníci a párování objednávek.',
  },
  'demo.merchandise': {
    label: 'E-shop – katalog, sklad a objednávky',
    description: 'Produkty, kategorie, ceny, skladové pohyby a objednávky e-shopu.',
  },
  'demo.sales-insights': {
    label: 'Obchodní přehledy a metriky',
    description: 'Obchodní metriky a jejich cíle.',
  },
  'demo.sales-pipeline': {
    label: 'Obchodní příležitosti',
    description: 'Příležitosti, jejich fáze, hodnoty a odpovědní obchodníci.',
  },
  'facility.operations': {
    label: 'Provoz – majetek, měřidla, agenda, nákupy',
    description: 'Majetek, měřidla a odečty, bezpečnost, dokumenty, provozní agenda, sklad, nákupy a prodej.',
  },
  'demo.tagging': {
    label: 'Štítky',
    description: 'Štítky a jejich přiřazení k zákazníkům, objednávkám, produktům, zaměstnancům a příležitostem.',
  },
  'demo.workforce': {
    label: 'Lidé a role',
    description: 'Zaměstnanci, jejich role a oddělení.',
  },
  'party.registry': {
    label: 'Registr subjektů',
    description: 'Zákazníci a partneři (firmy i osoby), kontakty, identifikátory a vztahy.',
  },
  'legal.agreements': {
    label: 'Smlouvy a dokumenty',
    description: 'Nájemní a jiné smlouvy, jejich podmínky, podpisy a dokumenty.',
  },
  'finance.billing': {
    label: 'Finance a fakturace',
    description:
      'Faktury vydané i přijaté, platby, upomínky, opakované fakturace, rozpočty a exporty do účetnictví.',
  },
  'property.leasing': {
    label: 'Pronájmy a obsazenost',
    description: 'Nájmy jednotek, nájemníci, obsazenost, přihlašovací listy a rezervace.',
  },
  'property.portfolio': {
    label: 'Nemovitosti a jednotky',
    description: 'Nemovitosti, jednotky a jejich vybavení.',
  },
  'work.tasks': {
    label: 'Úkoly a projekty',
    description: 'Úkoly, projekty, přiřazení, stavy a komentáře.',
  },
  'platform.approvals': {
    label: 'Schvalování změn',
    description: 'Návrhy změn, které schvaluje člověk.',
  },
};

/** Czech module label, or `fallback` when the module has no Czech label. */
export const moduleLabelCs = (moduleId: string, fallback: string): string => MODULE_CS[moduleId]?.label ?? fallback;

/** Czech module description, or '' when the module is unknown. */
export const moduleDescriptionCs = (moduleId: string): string => MODULE_CS[moduleId]?.description ?? '';

/** Keys are `<moduleId>/<Tag>` (module-specific) or `<Tag>`. */
export const COMMAND_TITLE_CS: Readonly<Record<string, string>> = {
  CreateTask: 'Vytvořit úkol',
  UpdateTask: 'Upravit úkol',
  AssignTask: 'Přiřadit úkol',
  ChangeTaskState: 'Změnit stav úkolu',
  SetTaskArchived: 'Skrýt nebo zobrazit úkol',
  BulkAssignTasks: 'Hromadně přiřadit úkoly',
  BulkChangeTaskState: 'Hromadně změnit stav úkolů',
  CreateProject: 'Vytvořit projekt',
  UpdateProject: 'Upravit projekt',
  AddTaskComment: 'Přidat komentář k úkolu',
  CreateClient: 'Založit klienta',
  UpdateClient: 'Upravit klienta',
  ArchiveClient: 'Archivovat klienta',
  RestoreClient: 'Obnovit klienta',
  AddContactPerson: 'Přidat kontaktní osobu',
  UpdateContactPerson: 'Upravit kontaktní osobu',
  RemoveContactPerson: 'Odebrat kontaktní osobu',
  AssignClient: 'Přiřadit klienta obchodníkovi',
  RecordVisit: 'Zaznamenat návštěvu',
  CorrectVisit: 'Opravit návštěvu',
  PlanContact: 'Naplánovat kontakt',
  UpdatePlanItem: 'Upravit plánovaný kontakt',
  CompletePlanItem: 'Dokončit plánovaný kontakt',
  PairOrder: 'Spárovat objednávku s klientem',
  UnpairOrder: 'Zrušit spárování objednávky',
  ImportOrdersCsv: 'Importovat objednávky z CSV',
  RegisterSalesperson: 'Zaregistrovat obchodníka',
  SetSalespersonActive: 'Aktivovat nebo vyřadit obchodníka',
  AiProposeChanges: 'Navrhnout změny ke schválení',
  AiDecideChanges: 'Schválit nebo zamítnout navržené změny',
  AiRevertBatch: 'Vrátit celou dávku AI změn',
  CreateOpportunity: 'Vytvořit příležitost',
  UpdateOpportunity: 'Upravit příležitost',
  ArchiveOpportunity: 'Archivovat příležitost',
  AssignOpportunity: 'Přiřadit příležitost obchodníkovi',
  ChangeOpportunityStage: 'Změnit fázi příležitosti',
  BulkUpdateOpportunities: 'Hromadně upravit příležitosti',
  CreateProduct: 'Vytvořit produkt',
  UpdateProduct: 'Upravit produkt',
  UpdateCategory: 'Upravit kategorii',
  ChangePrice: 'Změnit cenu',
  BulkUpdateProducts: 'Hromadně upravit produkty',
  RecordStockMovement: 'Zaznamenat skladový pohyb',
  CreateOrder: 'Vytvořit objednávku',
  ChangeOrderStatus: 'Změnit stav objednávky',
  EditOrder: 'Upravit objednávku',
  PlaceStorefrontOrder: 'Přijmout objednávku z e-shopu',
  ResetDemoData: 'Obnovit ukázková data',
  ArchiveDemoProduct: 'Archivovat ukázkový produkt',
  RemoveDemoOrder: 'Odebrat ukázkovou objednávku',
  CreateTag: 'Vytvořit štítek',
  UpdateTag: 'Upravit štítek',
  DeleteTag: 'Smazat štítek',
  AssignTag: 'Přiřadit štítek',
  UnassignTag: 'Odebrat štítek',
  CreateEmployee: 'Přidat zaměstnance',
  UpdateEmployee: 'Upravit zaměstnance',
  BulkUpdateEmployees: 'Hromadně upravit zaměstnance',
  CreateMetric: 'Vytvořit metriku',
  UpdateMetric: 'Upravit metriku',
  AssignMetric: 'Přiřadit metriku',
  ChangeMetricState: 'Změnit stav metriky',
  CreateInvoiceDraft: 'Vytvořit koncept faktury',
  UpdateInvoiceDraft: 'Upravit koncept faktury',
  CreateInvoiceFromOpportunity: 'Vytvořit fakturu z příležitosti',
  MarkInvoicesPrepared: 'Připravit faktury ke schválení',
  ConfirmInvoice: 'Schválit fakturu',
  ReturnInvoiceToDraft: 'Vrátit fakturu do konceptu',
  VoidInvoice: 'Stornovat fakturu',
  RecordIncomingInvoice: 'Zaevidovat přijatou fakturu',
  RecordManualPayment: 'Zaznamenat platbu',
  RecordReminder: 'Zaznamenat upomínku',
  SetPaymentTerms: 'Nastavit splatnost',
  CreateRecurringTemplate: 'Vytvořit opakovanou fakturaci',
  GenerateRecurringInvoice: 'Vygenerovat opakovanou fakturu',
  CreateAccountingExport: 'Vytvořit export do účetnictví',
  'property.leasing/CreateDraft': 'Vytvořit návrh nájmu',
  'property.leasing/UpdateDraft': 'Upravit návrh nájmu',
  SetRentTerms: 'Nastavit nájemní podmínky',
  'property.leasing/Confirm': 'Potvrdit nájem',
  'property.leasing/Activate': 'Zahájit nájem',
  'property.leasing/Complete': 'Ukončit nájem',
  'property.leasing/Cancel': 'Zrušit nájem',
  UpdateTenantDossier: 'Upravit spis nájemníka',
  CreateRegistrationSheet: 'Vytvořit přihlašovací list',
  PrepareNotice: 'Připravit oznámení',
  CreateContract: 'Vytvořit smlouvu',
  UpdateContract: 'Upravit smlouvu',
  ActivateContract: 'Aktivovat smlouvu',
  SetContractTerms: 'Nastavit podmínky smlouvy',
  TerminateContract: 'Ukončit smlouvu',
  RenewContract: 'Prodloužit smlouvu',
  SendSignature: 'Odeslat k podpisu',
  CreateProperty: 'Vytvořit nemovitost',
  UpdateProperty: 'Upravit nemovitost',
  CreateUnit: 'Vytvořit jednotku',
  UpdateUnit: 'Upravit jednotku',
  AssetCreate: 'Zaevidovat majetek',
  AssetUpdate: 'Upravit majetek',
  MeterCreate: 'Zaevidovat měřidlo',
  MeterReadingRecord: 'Zapsat odečet měřidla',
  AgendaEventCreate: 'Vytvořit událost v agendě',
  AgendaEventUpdate: 'Upravit událost v agendě',
  DocumentCreate: 'Vytvořit dokument',
  SecurityIncidentReport: 'Nahlásit bezpečnostní incident',
  PurchaseOrderCreate: 'Vytvořit nákupní objednávku',
  SalesQuoteCreate: 'Vytvořit nabídku zákazníkovi',
  StockReceipt: 'Příjem na sklad',
  StockIssue: 'Výdej ze skladu',
};

/** Verb prefixes of command tags, in match order (longer prefixes come before their shorter siblings). */
export const VERB_CS: readonly (readonly [string, string])[] = [
  ['Create', 'Vytvořit'],
  ['Update', 'Upravit'],
  ['Archive', 'Archivovat'],
  ['Restore', 'Obnovit'],
  ['Delete', 'Smazat'],
  ['Remove', 'Odebrat'],
  ['Add', 'Přidat'],
  ['Unassign', 'Odebrat přiřazení'],
  ['Assign', 'Přiřadit'],
  ['Change', 'Změnit'],
  ['Set', 'Nastavit'],
  ['Record', 'Zaznamenat'],
  ['Cancel', 'Zrušit'],
  ['Confirm', 'Potvrdit'],
  ['Complete', 'Dokončit'],
  ['Activate', 'Aktivovat'],
  ['Import', 'Importovat'],
  ['Link', 'Propojit'],
  ['Unpair', 'Zrušit spárování'],
  ['Pair', 'Spárovat'],
  ['Resolve', 'Vyřešit'],
  ['Bulk', 'Hromadně'],
  ['Mark', 'Označit'],
  ['Generate', 'Vygenerovat'],
  ['Request', 'Vyžádat'],
  ['Retry', 'Zopakovat'],
  ['Apply', 'Použít'],
  ['Upsert', 'Uložit'],
  ['Void', 'Stornovat'],
  ['Terminate', 'Ukončit'],
  ['Renew', 'Prodloužit'],
  ['Send', 'Odeslat'],
  ['Finalize', 'Dokončit'],
  ['Prepare', 'Připravit'],
  ['Register', 'Zaregistrovat'],
  ['Correct', 'Opravit'],
  ['Plan', 'Naplánovat'],
  ['Sync', 'Synchronizovat'],
  ['Return', 'Vrátit'],
  ['HandOver', 'Předat'],
  ['Observe', 'Zaznamenat'],
];

/** Czech title of a command tag: module-specific entry, generic entry, verb prefix, or `Akce <tag>`. */
export const commandTitleCs = (moduleId: string, tag: string): string => {
  const known = COMMAND_TITLE_CS[`${moduleId}/${tag}`] ?? COMMAND_TITLE_CS[tag];
  if (known !== undefined) {
    return known;
  }
  const verb = VERB_CS.find(
    ([prefix]) => tag.startsWith(prefix) && (tag.length === prefix.length || /[A-Z]/u.test(tag.charAt(prefix.length))),
  );
  return verb !== undefined ? `${verb[1]} – ${tag}` : `Akce ${tag}`;
};

export const READ_TITLE_CS: Readonly<Record<string, string>> = {
  'party.registry/customer-list': 'Seznam zákazníků',
  'party.registry/party-detail': 'Detail subjektu',
  'party.registry/ares-lookup': 'Vyhledání firmy v ARES',
  'party.registry/party-contact-points': 'Kontakty subjektu',
  'party.registry/counterparty-read': 'Detail obchodního partnera',
  'party.registry/party-match': 'Vyhledání shody subjektu',
};

/** Czech title of a governed read. */
export const readTitleCs = (moduleId: string, slug: string, moduleLabel: string): string =>
  READ_TITLE_CS[`${moduleId}/${slug}`] ?? (slug === 'records' ? `Přehled: ${moduleLabel}` : `Čtení ${slug} – ${moduleLabel}`);

export const ACTION_TITLE_CS: Readonly<Record<string, string>> = {
  'create-party': 'Založit subjekt',
  'update-party': 'Upravit subjekt',
  'add-contact-point': 'Přidat kontakt subjektu',
  'execute-privacy-measure': 'Provést opatření ochrany osobních údajů',
};

/** Czech title of a named Action. */
export const actionTitleCs = (slug: string): string => ACTION_TITLE_CS[slug] ?? `Akce ${slug}`;

export const ACCESS_CS: Readonly<Record<Access, string>> = {
  allowed: 'povoleno',
  denied: 'nepovoleno',
  unknown: 'nelze předem ověřit (rozhodne server)',
};

export const WRITE_POLICY_CS: Readonly<Record<WritePolicy, string>> = {
  read_only: 'jen čtení – toto připojení nic nemění',
  direct: 'zápis přímo přes Actions (server ověří oprávnění a zapíše audit)',
  approval: 'zápis jen přes schválení – každá změna čeká na rozhodnutí člověka v aplikaci',
};

/** Czech title of any catalog entry. */
export const entryTitleCs = (entry: CatalogEntry, moduleLabel: string): string => {
  if (entry.kind === 'read') {
    return readTitleCs(entry.moduleId, entry.slug, moduleLabel);
  }
  if (entry.commandTag !== undefined) {
    return commandTitleCs(entry.moduleId, entry.commandTag);
  }
  return actionTitleCs(entry.actionSlug);
};

/** Czech description of a catalog entry, including the write path that applies to the principal. */
export const entryDescriptionCs = (entry: CatalogEntry, moduleLabel: string, policy: WritePolicy): string => {
  const title = entryTitleCs(entry, moduleLabel);
  if (entry.kind === 'read') {
    return `${title} (${moduleLabel}). Čtení přes governed read; vrací jen data, která tento účet smí vidět. Id: ${entry.id}.`;
  }
  if (policy === 'read_only') {
    return `${title} (${moduleLabel}). Toto připojení smí jen číst. Id: ${entry.id}.`;
  }
  if (policy === 'approval') {
    return `${title} (${moduleLabel}). Pouze NÁVRH: data se nezmění, změnu schválí nebo zamítne člověk v aplikaci. Id: ${entry.id}.`;
  }
  return `${title} (${moduleLabel}). Zápis přes governed Action: server ověří oprávnění a zapíše audit. Id: ${entry.id}.`;
};
