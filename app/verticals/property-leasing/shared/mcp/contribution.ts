import { OntosMcpHidden, defineOntosMcpContribution } from '@app/core-runtime';

export const propertyLeasingMcpContribution = defineOntosMcpContribution({
  approvalReview: { read: 'agent-review' },
  approvals: true,
  commands: {
    Activate: { title: { cs: 'Zahájit nájem', en: 'Activate a lease' } },
    Cancel: { title: { cs: 'Zrušit nájem', en: 'Cancel a lease' } },
    Complete: { title: { cs: 'Ukončit nájem', en: 'Complete a lease' } },
    Confirm: { title: { cs: 'Potvrdit nájem', en: 'Confirm a lease' } },
    CreateDraft: { title: { cs: 'Vytvořit návrh nájmu', en: 'Create a lease draft' } },
    CreateRegistrationSheet: { title: { cs: 'Vytvořit přihlašovací list', en: 'Create a registration sheet' } },
    ImportBooking: { title: { cs: 'Importovat rezervaci', en: 'Import a booking' } },
    PrepareNotice: { title: { cs: 'Připravit oznámení', en: 'Prepare a notice' } },
    RetryBooking: { title: { cs: 'Zopakovat zpracování rezervace', en: 'Retry processing a booking' } },
    SetRentTerms: { title: { cs: 'Nastavit nájemní podmínky', en: 'Set rent terms' } },
    UpdateCounterpartyDossier: { title: { cs: 'Upravit spis protistrany', en: 'Update a counterparty dossier' } },
    UpdateDraft: { title: { cs: 'Upravit návrh nájmu', en: 'Update a lease draft' } },
    UpdateTenantDossier: { title: { cs: 'Upravit spis nájemníka', en: 'Update a tenant dossier' } },
  },
  description: {
    cs: 'Nájmy jednotek, nájemníci, obsazenost, přihlašovací listy a rezervace.',
    en: 'Unit leases, tenants, occupancy, registration sheets and bookings.',
  },
  keywords:
    'nájem nájmy pronájem nájemník nájemné nájemní smlouva obsazenost rezervace pobyt přihlašovací list oznámení lease tenant rent booking',
  label: { cs: 'Pronájmy a obsazenost', en: 'Leasing and occupancy' },
  page: '/najmy',
  reads: {
    'agent-review': OntosMcpHidden,
    records: { title: { cs: 'Přehled nájmů a obsazenosti', en: 'Leases and occupancy overview' } },
  },
  revision: { read: 'records' },
});
