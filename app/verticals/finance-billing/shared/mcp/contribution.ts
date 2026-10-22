import { defineOntosMcpContribution } from '@app/core-runtime';

export const financeBillingMcpContribution = defineOntosMcpContribution({
  approvals: true,
  commands: {
    ApplyAccountingObservation: 'hidden',
    ApplyPaymentObservation: 'hidden',
    AttachDocument: { title: { cs: 'Přiložit dokument', en: 'Attach a document' } },
    ConfirmAccountingExport: { title: { cs: 'Potvrdit export do účetnictví', en: 'Confirm an accounting export' } },
    ConfirmInvoice: { title: { cs: 'Schválit fakturu', en: 'Confirm an invoice' } },
    CreateAccountingExport: { title: { cs: 'Vytvořit export do účetnictví', en: 'Create an accounting export' } },
    CreateInvoiceDraft: { title: { cs: 'Vytvořit koncept faktury', en: 'Create an invoice draft' } },
    CreateInvoiceFromOpportunity: {
      title: { cs: 'Vytvořit fakturu z příležitosti', en: 'Create an invoice from an opportunity' },
    },
    CreateRecurringTemplate: {
      title: { cs: 'Vytvořit opakovanou fakturaci', en: 'Create a recurring invoice template' },
    },
    DeleteBudgetLine: { title: { cs: 'Smazat řádek rozpočtu', en: 'Delete a budget line' } },
    DeletePlanItem: { title: { cs: 'Smazat položku finančního plánu', en: 'Delete a financial plan item' } },
    GenerateRecurringInvoice: { title: { cs: 'Vygenerovat opakovanou fakturu', en: 'Generate a recurring invoice' } },
    HandOverAccountingExport: { title: { cs: 'Předat export účetní', en: 'Hand over an accounting export' } },
    MarkAccountingExportFailed: {
      title: { cs: 'Označit export do účetnictví jako neúspěšný', en: 'Mark an accounting export as failed' },
    },
    MarkInvoicesPrepared: { title: { cs: 'Připravit faktury ke schválení', en: 'Prepare invoices for approval' } },
    RecordIncomingInvoice: { title: { cs: 'Zaevidovat přijatou fakturu', en: 'Record an incoming invoice' } },
    RecordManualPayment: { title: { cs: 'Zaznamenat platbu', en: 'Record a manual payment' } },
    RecordReminder: { title: { cs: 'Zaznamenat upomínku', en: 'Record a payment reminder' } },
    RequestAccountingSync: {
      title: { cs: 'Vyžádat synchronizaci s účetnictvím', en: 'Request accounting synchronization' },
    },
    RetryAccountingSync: {
      title: { cs: 'Zopakovat synchronizaci s účetnictvím', en: 'Retry accounting synchronization' },
    },
    ReturnInvoiceToDraft: { title: { cs: 'Vrátit fakturu do konceptu', en: 'Return an invoice to draft' } },
    SetInvoiceDetails: { title: { cs: 'Nastavit údaje faktury', en: 'Set invoice details' } },
    SetOpeningBalance: { title: { cs: 'Nastavit počáteční zůstatek', en: 'Set an opening balance' } },
    SetPaymentTerms: { title: { cs: 'Nastavit splatnost', en: 'Set payment terms' } },
    SetPriorSettlement: { title: { cs: 'Nastavit dřívější vyrovnání faktury', en: 'Set a prior invoice settlement' } },
    SetRecurringTemplateActive: {
      title: { cs: 'Zapnout nebo vypnout opakovanou fakturaci', en: 'Activate or deactivate a recurring template' },
    },
    UpdateAccountingSetup: { title: { cs: 'Upravit nastavení účetnictví', en: 'Update accounting settings' } },
    UpdateInvoiceDraft: { title: { cs: 'Upravit koncept faktury', en: 'Update an invoice draft' } },
    UpsertBudgetLine: { title: { cs: 'Uložit řádek rozpočtu', en: 'Save a budget line' } },
    UpsertPlanItem: { title: { cs: 'Uložit položku finančního plánu', en: 'Save a financial plan item' } },
    UpsertPriceListItem: { title: { cs: 'Uložit položku ceníku', en: 'Save a price list item' } },
    VoidInvoice: { title: { cs: 'Stornovat fakturu', en: 'Void an invoice' } },
  },
  description: {
    cs: 'Faktury vydané i přijaté, platby, upomínky, opakované fakturace, rozpočty a exporty do účetnictví.',
    en: 'Outgoing and incoming invoices, payments, reminders, recurring billing, budgets and accounting exports.',
  },
  keywords:
    'faktura faktury fakturace vydaná přijatá platba úhrada upomínka splatnost dobropis storno opakovaná účetnictví export rozpočet plán ceník zůstatek invoice billing payment budget accounting',
  label: { cs: 'Finance a fakturace', en: 'Finance and billing' },
  page: '/finance',
  reads: {
    records: { title: { cs: 'Přehled financí a fakturace', en: 'Finance and billing overview' } },
  },
  revision: { read: 'records' },
});
