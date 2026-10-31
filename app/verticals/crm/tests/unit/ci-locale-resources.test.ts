import { FederatedI18nBoundary } from '@modern-js/i18n-integration/federation';
import { getI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { ModernI18nProvider, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { createElement } from 'react';
import { jsx } from 'react/jsx-runtime';
import { Effect } from 'effect';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'effect-rstest';
import { crmI18nResources } from '../../src/crm/i18n.ts';

type ExpectedCopy = readonly [key: string, cs: string, en: string];

// Fixed expected UI copy, independent of the catalogs assembled by crmI18nResources.
// Keep this test self-contained: .codex integration fragments are not runtime inputs.
const workflowCopy: readonly ExpectedCopy[] = [
  ['crm.ciWorkflow.aiApprovalLog', 'Deník AI a schvalování', 'AI and approval log'],
  ['crm.ciWorkflow.approvedLinks', 'Schválené vazby', 'Approved links'],
  ['crm.ciWorkflow.awaitingPairing', 'K napárování', 'Awaiting pairing'],
  ['crm.ciWorkflow.batchView', 'Zobrazení dávek', 'Batch view'],
  ['crm.ciWorkflow.businessOverview', 'Obchodní přehled', 'Business overview'],
  ['crm.ciWorkflow.chartCurrency', 'Měna grafu', 'Chart currency'],
  ['crm.ciWorkflow.client', 'Klient', 'Client'],
  ['crm.ciWorkflow.clientAssignment', 'Přiřazení ke klientovi', 'Client assignment'],
  ['crm.ciWorkflow.clientsWithOrders', 'Klienti s objednávkou', 'Clients with an order'],
  ['crm.ciWorkflow.completeContact', 'Vyřídit kontakt', 'Complete contact'],
  ['crm.ciWorkflow.completed30Days', 'Vyřízeno za 30 dní', 'Completed in 30 days'],
  ['crm.ciWorkflow.contactOn', 'Ozvat se dne', 'Contact on'],
  ['crm.ciWorkflow.contactOutcome', 'Jak to dopadlo (krátce)', 'Outcome (briefly)'],
  ['crm.ciWorkflow.contactToday', 'K oslovení dnes', 'To contact today'],
  ['crm.ciWorkflow.crmClient', 'Klient v CRM', 'CRM client'],
  ['crm.ciWorkflow.crossSourceDuplicate', 'Duplicita mezi zdroji', 'Duplicate across sources'],
  ['crm.ciWorkflow.csvContents', 'Obsah CSV (první řádek je hlavička)', 'CSV contents (the first row is the header)'],
  ['crm.ciWorkflow.csvFile', 'Soubor CSV', 'CSV file'],
  ['crm.ciWorkflow.csvImport', 'Import objednávek z CSV', 'Import orders from CSV'],
  ['crm.ciWorkflow.decisionNote', 'Poznámka k rozhodnutí (nepovinná)', 'Decision note (optional)'],
  ['crm.ciWorkflow.decisionNotePlaceholder', 'Např. ověřeno s obchodníkem', 'E.g. verified with the salesperson'],
  ['crm.ciWorkflow.emptyQueue', 'Fronta je prázdná', 'The queue is empty'],
  ['crm.ciWorkflow.excludedFromReport', 'Vyloučeno z přehledu', 'Excluded from the report'],
  ['crm.ciWorkflow.groupBy', 'Seskupit podle', 'Group by'],
  ['crm.ciWorkflow.importBatches', 'Importní dávky', 'Import batches'],
  ['crm.ciWorkflow.importedSkuItems', 'Importované položky (SKU)', 'Imported items (SKU)'],
  ['crm.ciWorkflow.items', 'Položky', 'Items'],
  ['crm.ciWorkflow.itemsNotProvided', 'Položky neposkytnuty — bez dat', 'Items not provided — no data'],
  [
    'crm.ciWorkflow.managementApprovalsOnly',
    'Schvalování je vyhrazeno vedení',
    'Approvals are reserved for management',
  ],
  ['crm.ciWorkflow.managementPairingOnly', 'Párování provádí vedení obchodu', 'Sales management handles pairing'],
  ['crm.ciWorkflow.monthlyOrderCounts', 'Počet objednávek po měsících', 'Monthly order counts'],
  ['crm.ciWorkflow.monthlyOrderValue', 'Hodnota objednávek tento měsíc', 'Order value this month'],
  ['crm.ciWorkflow.monthlyTrend', 'Vývoj po měsících', 'Monthly trend'],
  ['crm.ciWorkflow.needsReview', 'Vyžaduje kontrolu', 'Requires review'],
  ['crm.ciWorkflow.newApprovedLink', 'Nová schválená vazba', 'New approved link'],
  ['crm.ciWorkflow.noCompletedContacts', 'Zatím žádné vyřízené kontakty', 'No completed contacts yet'],
  ['crm.ciWorkflow.noData', 'Bez dat', 'No data'],
  ['crm.ciWorkflow.noImportsYet', 'Zatím žádný import', 'No imports yet'],
  ['crm.ciWorkflow.noOrders', 'Bez objednávek', 'No orders'],
  ['crm.ciWorkflow.noOrdersYet', 'Zatím žádné objednávky', 'No orders yet'],
  ['crm.ciWorkflow.note', 'Poznámka', 'Note'],
  ['crm.ciWorkflow.nothingToReview', 'Nic ke kontrole', 'Nothing to review'],
  ['crm.ciWorkflow.openContacts', 'Otevřené kontakty', 'Open contacts'],
  ['crm.ciWorkflow.orderChartData', 'Vývoj objednávek a dostupná data grafů', 'Order trends and available chart data'],
  ['crm.ciWorkflow.ordersToResolve', 'Objednávky k dořešení', 'Orders to resolve'],
  ['crm.ciWorkflow.overdue', 'Po termínu', 'Overdue'],
  ['crm.ciWorkflow.pairingReason', 'Důvod přiřazení a zdroj ověření', 'Reason for assignment and verification source'],
  ['crm.ciWorkflow.period', 'Období', 'Period'],
  ['crm.ciWorkflow.planNotePlaceholder', 'např. zeptat se na zimní nabídku', 'e.g. ask about the winter offer'],
  [
    'crm.ciWorkflow.recordVisit',
    'Zároveň zapsat návštěvu / telefonát do historie',
    'Also record the visit / call in the history',
  ],
  ['crm.ciWorkflow.recordedOrderValue', 'Hodnota evidovaných objednávek', 'Recorded order value'],
  ['crm.ciWorkflow.recordedOrders', 'Evidované objednávky', 'Recorded orders'],
  ['crm.ciWorkflow.responsibleSalesperson', 'Odpovědný obchodník', 'Responsible salesperson'],
  ['crm.ciWorkflow.salesAtAGlance', 'Prodeje v kostce', 'Sales at a glance'],
  ['crm.ciWorkflow.salesperson', 'Obchodník', 'Salesperson'],
  ['crm.ciWorkflow.sampleFiles', 'Vzorové soubory', 'Sample files'],
  ['crm.ciWorkflow.searchClient', 'Vyhledejte klienta', 'Search for a client'],
  ['crm.ciWorkflow.searchOrder', 'Hledat objednávku', 'Search orders'],
  [
    'crm.ciWorkflow.searchOrderPlaceholder',
    'Číslo, ID, zákazník, IČO, stav',
    'Number, ID, customer, company ID, status',
  ],
  ['crm.ciWorkflow.selectClient', 'Vyberte klienta', 'Select a client'],
  ['crm.ciWorkflow.show', 'Zobrazit', 'Show'],
  ['crm.ciWorkflow.source', 'Zdroj', 'Source'],
  ['crm.ciWorkflow.sourceCustomerId', 'ID zákazníka ve zdroji', 'Customer ID in the source'],
  ['crm.ciWorkflow.sourceSystem', 'Zdrojový systém', 'Source system'],
  ['crm.ciWorkflow.status', 'Stav', 'Status'],
  ['crm.ciWorkflow.targetClient', 'Cílový klient', 'Target client'],
  ['crm.ciWorkflow.today', 'Dnes', 'Today'],
  ['crm.ciWorkflow.uncertainClient', 'Nejistý klient', 'Uncertain client'],
  ['crm.ciWorkflow.unpaired', 'Nenapárované', 'Unpaired'],
  ['crm.ciWorkflow.within14Days', 'Do 14 dní', 'Within 14 days'],
];

const clientsCopy: readonly ExpectedCopy[] = [
  ['crm.ciClientsVisits.clients.active', 'Aktivní klienti', 'Active clients'],
  ['crm.ciClientsVisits.clients.assignedSalesperson', 'Přidělený obchodník', 'Assigned salesperson'],
  ['crm.ciClientsVisits.clients.assignedToMe', 'Přidělení mně', 'Assigned to me'],
  ['crm.ciClientsVisits.clients.cannotDisplay', 'Klienta nelze zobrazit', 'The client cannot be displayed'],
  ['crm.ciClientsVisits.clients.cardUnavailable', 'Kartu nelze otevřít', 'The client card cannot be opened'],
  ['crm.ciClientsVisits.clients.contactedLast30Days', 'Kontaktováno za 30 dní', 'Contacted in the last 30 days'],
  ['crm.ciClientsVisits.clients.customerRegistry', 'Evidence zákazníků', 'Customer registry'],
  [
    'crm.ciClientsVisits.clients.existingRegistryCustomer',
    'Existující zákazník v evidenci zákazníků',
    'Existing customer in the customer registry',
  ],
  [
    'crm.ciClientsVisits.clients.exportDescription',
    'Klienti a kontaktní osoby podle aktuálních filtrů; jen záznamy, které smíte vidět',
    'Clients and contact persons matching the current filters; only records you are allowed to view',
  ],
  ['crm.ciClientsVisits.clients.linkedToRegistry', 'Propojeno s evidencí zákazníků', 'Linked to the customer registry'],
  ['crm.ciClientsVisits.clients.newSalesperson', 'Nový obchodník', 'New salesperson'],
  ['crm.ciClientsVisits.clients.notFound', 'Klient nenalezen', 'Client not found'],
  ['crm.ciClientsVisits.clients.recordedOrderValue', 'Hodnota evidovaných objednávek', 'Value of recorded orders'],
  ['crm.ciClientsVisits.clients.recordedOrders', 'Evidované objednávky', 'Recorded orders'],
  [
    'crm.ciClientsVisits.clients.registryIdentity',
    'Identita v evidenci zákazníků',
    'Identity in the customer registry',
  ],
  ['crm.ciClientsVisits.clients.salespeople', 'Obchodníci', 'Salespeople'],
  ['crm.ciClientsVisits.clients.searchLabel', 'Hledat klienta', 'Search for a client'],
  [
    'crm.ciClientsVisits.clients.searchPlaceholder',
    'Název, IČO, telefon, e-mail, kontaktní osoba',
    'Name, company registration number, phone, e-mail, contact person',
  ],
  ['crm.ciClientsVisits.clients.withoutContact', 'Klienti bez kontaktu', 'Clients without contact'],
  ['crm.ciClientsVisits.clients.withoutSalesperson', 'Bez obchodníka', 'Without a salesperson'],
  ['crm.ciClientsVisits.contacts.empty', 'Bez kontaktních osob', 'No contact persons'],
  ['crm.ciClientsVisits.contacts.primary', 'Hlavní kontakt klienta', 'Primary client contact'],
  ['crm.ciClientsVisits.contacts.removeFromForm', 'Odebrat osobu z formuláře', 'Remove this person from the form'],
  ['crm.ciClientsVisits.contacts.roleExample', 'např. Nákupčí', 'e.g. Buyer'],
  ['crm.ciClientsVisits.contacts.rolesExample', 'např. Nákupčí, Provozní', 'e.g. Buyer, Operations manager'],
  ['crm.ciClientsVisits.contacts.title', 'Kontaktní osoby', 'Contact persons'],
  ['crm.ciClientsVisits.fields.address', 'Adresa', 'Address'],
  [
    'crm.ciClientsVisits.fields.addressPlaceholder',
    'Ulice a číslo, PSČ Město',
    'Street and number, postal code and city',
  ],
  ['crm.ciClientsVisits.fields.client', 'Klient', 'Client'],
  ['crm.ciClientsVisits.fields.date', 'Datum', 'Date'],
  ['crm.ciClientsVisits.fields.dueDate', 'Termín', 'Due date'],
  ['crm.ciClientsVisits.fields.email', 'E-mail', 'E-mail'],
  ['crm.ciClientsVisits.fields.fullName', 'Jméno a příjmení', 'Full name'],
  ['crm.ciClientsVisits.fields.jobRole', 'Pracovní role', 'Job role'],
  ['crm.ciClientsVisits.fields.note', 'Poznámka', 'Note'],
  ['crm.ciClientsVisits.fields.period', 'Období', 'Period'],
  ['crm.ciClientsVisits.fields.phone', 'Telefon', 'Phone'],
  ['crm.ciClientsVisits.fields.registrationNumber', 'IČO', 'Company registration number'],
  ['crm.ciClientsVisits.fields.salesperson', 'Obchodník', 'Salesperson'],
  ['crm.ciClientsVisits.fields.segment', 'Segment', 'Segment'],
  ['crm.ciClientsVisits.fields.status', 'Stav', 'Status'],
  ['crm.ciClientsVisits.fields.taxId', 'DIČ', 'Tax identification number'],
  ['crm.ciClientsVisits.fields.time', 'Čas', 'Time'],
  ['crm.ciClientsVisits.fields.type', 'Typ', 'Type'],
  ['crm.ciClientsVisits.fields.website', 'Web', 'Website'],
  ['crm.ciClientsVisits.history.empty', 'Bez historie', 'No history'],
  [
    'crm.ciClientsVisits.visits.addNextStepToMyPlan',
    'Zařadit další krok do mého plánu K oslovení',
    'Add the next step to my To contact plan',
  ],
  [
    'crm.ciClientsVisits.visits.addNextStepToPlan',
    'Zařadit další krok do plánu K oslovení',
    'Add the next step to the To contact plan',
  ],
  ['crm.ciClientsVisits.visits.clientPlaceholder', 'Vyhledejte klienta', 'Search for a client'],
  ['crm.ciClientsVisits.visits.contactOnDate', 'Ozvat se dne', 'Contact on'],
  ['crm.ciClientsVisits.visits.contactsLast30Days', 'Kontakty za 30 dní', 'Contacts in the last 30 days'],
  ['crm.ciClientsVisits.visits.correctRecord', 'Opravit záznam', 'Correct the record'],
  ['crm.ciClientsVisits.visits.correctedRecords', 'Opravené záznamy', 'Corrected records'],
  [
    'crm.ciClientsVisits.visits.correctionExample',
    'např. překlep, upřesnění po telefonu',
    'e.g. a typo, clarification by phone',
  ],
  ['crm.ciClientsVisits.visits.correctionReason', 'Důvod opravy', 'Reason for correction'],
  ['crm.ciClientsVisits.visits.empty', 'Bez návštěv', 'No visits'],
  [
    'crm.ciClientsVisits.visits.inPersonLast30Days',
    'Osobní návštěvy za 30 dní',
    'In-person visits in the last 30 days',
  ],
  ['crm.ciClientsVisits.visits.lastContact', 'Poslední kontakt', 'Last contact'],
  ['crm.ciClientsVisits.visits.lastContactAnyType', 'Poslední kontakt (jakýkoli)', 'Last contact (any type)'],
  ['crm.ciClientsVisits.visits.lastVisit', 'Poslední návštěva', 'Last visit'],
  ['crm.ciClientsVisits.visits.nextPlannedContact', 'Příští plánovaný kontakt', 'Next planned contact'],
  ['crm.ciClientsVisits.visits.nextStep', 'Co udělat', 'What to do'],
  ['crm.ciClientsVisits.visits.recordVisit', 'Zapsat návštěvu', 'Record a visit'],
  ['crm.ciClientsVisits.visits.recordedContacts', 'Zapsané kontakty', 'Recorded contacts'],
  ['crm.ciClientsVisits.visits.responsibleSalesperson', 'Odpovědný obchodník', 'Responsible salesperson'],
  ['crm.ciClientsVisits.visits.result', 'Výsledek', 'Result'],
  ['crm.ciClientsVisits.visits.searchLabel', 'Hledat v návštěvách', 'Search visits'],
  ['crm.ciClientsVisits.visits.searchPlaceholder', 'Hledat v záznamech', 'Search records'],
];

const TranslationProbe = ({ keys }: { readonly keys: readonly string[] }) => {
  const { language, t } = useModernI18n();
  return createElement('pre', { lang: language }, JSON.stringify(keys.map((key) => t(key))));
};

describe.each([
  { area: 'workflow', copies: workflowCopy, count: 70 },
  { area: 'clients and visits', copies: clientsCopy, count: 68 },
])('CRM $area runtime locale resources', ({ copies, count }) => {
  it.effect.each([
    { expected: copies.map(([key, cs]) => ({ key, value: cs })), hostCopy: 'Pouze hostitel', language: 'cs' },
    { expected: copies.map(([key, , en]) => ({ key, value: en })), hostCopy: 'Host only', language: 'en' },
  ])(
    'renders every exact $language value through the native CRM namespace boundary',
    ({ expected, hostCopy, language }) =>
      Effect.gen(function* renderNativeTranslations() {
        expect(expected).toHaveLength(count);
        const host = yield* Effect.promise(() => getI18nInstance());
        yield* Effect.promise(() =>
          host.init({
            defaultNS: 'translation',
            fallbackLng: language,
            initImmediate: false,
            lng: language,
            ns: ['translation'],
            resources: {
              cs: { translation: { hostOnly: 'Pouze hostitel' } },
              en: { translation: { hostOnly: 'Host only' } },
            },
          }),
        );
        const keys = expected.map(({ key }) => key);
        // None of these keys can resolve from the host's default namespace or resources.
        for (const key of keys) {
          expect(host.t(key)).toBe(key);
        }
        // The .ts test uses React's JSX runtime to render the real providers without JSX syntax.
        const actual = renderToStaticMarkup(
          jsx(ModernI18nProvider, {
            children: jsx(FederatedI18nBoundary, {
              children: jsx(TranslationProbe, { keys }),
              defaultNamespace: 'crm',
              fallbackLanguage: language,
              resources: crmI18nResources,
              supportedLanguages: ['cs', 'en'],
            }),
            value: { i18nInstance: host, language, languages: ['cs', 'en'] },
          }),
        );
        expect(actual).toBe(
          renderToStaticMarkup(
            createElement('pre', { lang: language }, JSON.stringify(expected.map(({ value }) => value))),
          ),
        );
        // The boundary must not populate or switch the host's default namespace.
        for (const key of keys) {
          expect(host.t(key)).toBe(key);
        }
        expect(host.t('hostOnly')).toBe(hostCopy);
      }),
  );
});
