import { defineOntosMcpContribution } from '@app/core-runtime';

export const legalAgreementsMcpContribution = defineOntosMcpContribution({
  approvals: true,
  commandFieldLabels: {
    contractRef: 'Smlouva',
  },
  commands: {
    ActivateContract: { title: { cs: 'Aktivovat smlouvu', en: 'Activate a contract' } },
    ArchiveDocument: { title: { cs: 'Archivovat dokument', en: 'Archive a document' } },
    CreateContract: { title: { cs: 'Vytvořit smlouvu', en: 'Create a contract' } },
    CreateDocument: { title: { cs: 'Vytvořit dokument ke smlouvě', en: 'Create a contract document' } },
    FinalizeDocument: { title: { cs: 'Dokončit dokument', en: 'Finalize a document' } },
    RecordSignedDocument: { title: { cs: 'Zaevidovat podepsaný dokument', en: 'Record a signed document' } },
    RenewContract: { title: { cs: 'Prodloužit smlouvu', en: 'Renew a contract' } },
    SetContractTerms: { title: { cs: 'Nastavit podmínky smlouvy', en: 'Set contract terms' } },
    TerminateContract: { title: { cs: 'Ukončit smlouvu', en: 'Terminate a contract' } },
    UpdateContract: { title: { cs: 'Upravit smlouvu', en: 'Update a contract' } },
    UpdateDocument: { title: { cs: 'Upravit dokument ke smlouvě', en: 'Update a contract document' } },
  },
  description: {
    cs: 'Nájemní a jiné smlouvy, jejich podmínky, podpisy a dokumenty.',
    en: 'Lease and other agreements, their terms, signatures and documents.',
  },
  keywords:
    'smlouva smlouvy dodatek dokument podpis podmínky prodloužení výpověď ukončení contract agreement signature',
  label: { cs: 'Smlouvy a dokumenty', en: 'Contracts and documents' },
  page: '/smlouvy',
  reads: {
    records: { title: { cs: 'Přehled smluv a dokumentů', en: 'Contracts and documents overview' } },
  },
  revision: { read: 'records' },
});
