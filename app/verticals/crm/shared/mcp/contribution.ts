/** CRM tools offered to agents, without approval plumbing or internal status callbacks. */
import { OntosMcpHidden, defineOntosMcpContribution } from '@app/core-runtime';

export const crmMcpContribution = defineOntosMcpContribution({
  // Clients are private per salesperson: proposals about clients the reader cannot see stay hidden.
  approvalReview: { privateRecords: true, read: 'agent-review' },
  approvals: true,
  approvalsPage: { label: { cs: 'Otevřít v CRM', en: 'Open in CRM' }, path: '/crm/schvalovani-ai' },
  commandFieldLabels: {
    address: 'Adresa',
    dueDate: 'Termín',
    email: 'E-mail',
    kind: 'Druh',
    name: 'Název',
    note: 'Poznámka',
    phone: 'Telefon',
    reason: 'Důvod',
    regNo: 'IČO',
    segment: 'Segment',
    status: 'Stav',
    vatNo: 'DIČ',
    website: 'Web',
  },
  commands: {
    AddContactPerson: { title: { cs: 'Přidat kontaktní osobu', en: 'Add a contact person' } },
    AiDecideChanges: 'hidden',
    AiProposeChanges: 'hidden',
    AiRevertBatch: 'hidden',
    ArchiveClient: { title: { cs: 'Archivovat klienta', en: 'Archive a client' } },
    AssignClient: { title: { cs: 'Přiřadit klienta obchodníkovi', en: 'Assign a client to a salesperson' } },
    CompletePlanItem: { title: { cs: 'Dokončit plánovaný kontakt', en: 'Complete a planned contact' } },
    CorrectVisit: { title: { cs: 'Opravit návštěvu', en: 'Correct a visit' } },
    CreateClient: { title: { cs: 'Založit klienta', en: 'Create a client' } },
    ImportOrdersCsv: { title: { cs: 'Importovat objednávky z CSV', en: 'Import orders from CSV' } },
    LinkClientParty: {
      title: { cs: 'Propojit klienta se subjektem v registru', en: 'Link a client to a registry party' },
    },
    LinkExternalCustomer: {
      title: { cs: 'Propojit klienta s externím zákazníkem', en: 'Link a client to an external customer' },
    },
    PairOrder: { title: { cs: 'Spárovat objednávku s klientem', en: 'Pair an order with a client' } },
    PlanContact: { title: { cs: 'Naplánovat kontakt', en: 'Plan a contact' } },
    RecordVisit: { title: { cs: 'Zaznamenat návštěvu', en: 'Record a visit' } },
    RegisterSalesperson: { title: { cs: 'Zaregistrovat obchodníka', en: 'Register a salesperson' } },
    RemoveContactPerson: { title: { cs: 'Odebrat kontaktní osobu', en: 'Remove a contact person' } },
    ResolveOrderDuplicate: { title: { cs: 'Vyřešit duplicitní objednávku', en: 'Resolve a duplicate order' } },
    ResolveOrderStatusEvent: 'hidden',
    RestoreClient: { title: { cs: 'Obnovit klienta', en: 'Restore a client' } },
    SetSalespersonActive: {
      title: { cs: 'Aktivovat nebo vyřadit obchodníka', en: 'Activate or deactivate a salesperson' },
    },
    SyncClientParties: {
      title: { cs: 'Synchronizovat klienty s registrem subjektů', en: 'Synchronize clients with the party registry' },
    },
    UnpairOrder: { title: { cs: 'Zrušit spárování objednávky', en: 'Unpair an order' } },
    UpdateClient: { title: { cs: 'Upravit klienta', en: 'Update a client' } },
    UpdateContactPerson: { title: { cs: 'Upravit kontaktní osobu', en: 'Update a contact person' } },
    UpdateCustomerInput: {
      description: {
        cs: 'Upravit stav zákaznického požadavku, doklady a schválení dodaného vzorku.',
        en: 'Update a customer requirement, its evidence and approval of a delivered sample.',
      },
      title: { cs: 'Upravit údaje zákazníka', en: 'Update a customer requirement' },
    },
    UpdatePlanItem: { title: { cs: 'Upravit plánovaný kontakt', en: 'Update a planned contact' } },
  },
  description: {
    cs: 'Klienti, kontaktní osoby, návštěvy, plán kontaktů, obchodníci a párování objednávek.',
    en: 'Clients, contact people, visits, contact plans, salespeople and order matching.',
  },
  keywords:
    'zákazník klient kontakt kontaktní osoba návštěva schůzka obchodník plán kontaktů objednávka crm customer client visit salesperson order',
  label: { cs: 'CRM – klienti a obchodníci', en: 'CRM – clients and salespeople' },
  ownProposalEngine: true,
  page: '/crm/klienti',
  reads: {
    'agent-review': OntosMcpHidden,
    records: { title: { cs: 'Přehled klientů, kontaktů a objednávek', en: 'Clients, contacts and orders overview' } },
  },
  recordLinks: [
    {
      commands: [
        ...[
          'AddContactPerson',
          'AssignClient',
          'LinkClientParty',
          'LinkExternalCustomer',
          'PlanContact',
          'RecordVisit',
        ].map((tag) => ({ idField: 'clientId', tag })),
        ...['ArchiveClient', 'RestoreClient', 'UpdateClient'].map((tag) => ({ idField: 'id', tag })),
      ],
      idField: 'id',
      labelField: 'name',
      path: '/crm/klienti',
      proposalTargetKind: 'client',
      queryParam: 'klient',
      recordsPath: 'state.clients.items',
      resourceType: 'demo.crm.client',
    },
  ],
  revision: { read: 'records' },
});
