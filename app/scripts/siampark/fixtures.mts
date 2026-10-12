import { CoreSearchProjectionDocumentSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { PropertyStateSchema } from '@app/siampark-property/contracts/records';
import { OccupancyStateSchema } from '@app/siampark-occupancy/contracts/records';
import { AgreementsStateSchema } from '@app/siampark-agreements/contracts/records';
import { WorkStateSchema } from '@app/siampark-work/contracts/records';
import { RelationshipsStateSchema } from '@app/siampark-relationships/contracts/records';
import { FinanceStateSchema } from '@app/siampark-billing-finance/contracts/records';

/** Public operator inputs. Owners validate and persist their own fixture independently. */
export const demoTenantId = '70000000-0000-4000-8000-000000000020';
export const demoLegalEntityId = '71000000-0000-4000-8000-000000000020';
export const demoTimestamp = '2026-10-05T09:00:00.000Z';
const fixturePropertyParkova = 'property.parkova';
const fixturePropertyRiverside = 'property.riverside';
const fixtureUnitParkovaA102 = 'unit.parkova.a102';
const fixtureUnitParkovaA103 = 'unit.parkova.a103';
const fixtureUnitRiversideB201 = 'unit.riverside.b201';
const fixtureAssetParkovaHvac01 = 'asset.parkova.hvac01';
const fixtureCustomerA102Tenant = 'customer.a102-tenant';
const fixtureCustomerB201Tenant = 'customer.b201-tenant';
const fixtureCustomerGoldenA101 = 'customer.golden-a101';
const fixtureGuestA103Shortstay = 'guest.a103-shortstay';
const fixtureSupplierMaintenance = 'supplier.maintenance';
const fixtureSupplierUtilities = 'supplier.utilities';
const fixtureCounterpartyA102 = 'counterparty.a102';
const fixtureCounterpartyB201 = 'counterparty.b201';
const fixtureCounterpartyMaintenance = 'counterparty.maintenance';
const fixtureCounterpartyUtilities = 'counterparty.utilities';
const fixtureOccupancyA102 = 'occupancy.a102';
const fixtureOccupancyA103 = 'occupancy.a103';
const fixtureOccupancyB201 = 'occupancy.b201';
const fixtureContractA102Lease = 'contract.a102.lease';
const fixtureContractB201Lease = 'contract.b201.lease';
const fixtureDocumentA102Lease = 'document.a102.lease';
const fixtureInvoiceA102Paid = 'invoice.a102.paid';
const fixtureTaskHvacMaintenance = 'task.hvac-maintenance';
const fixtureTaskB201Renewal = 'task.b201-renewal';
const fixtureTaskExternalAgentAssigned = 'task.external-agent-assigned';
const fixturePartyRegistry = 'party.registry';
const fixturePartyResourceType = 'party.registry.party';
const fixtureCounterpartyResourceType = 'party.registry.counterparty';
const fixtureSiamparkProperty = 'siampark.property';
const fixtureSiamparkAgreements = 'siampark.agreements';
const fixtureSiamparkBillingFinance = 'siampark.billing-finance';
const fixtureBookingConflict = 'booking.conflict';
const fixtureSignatureA102 = 'signature.a102';
const fixtureActivityFollowup = 'activity.followup';
const fixture20260101 = '2026-01-01';
const fixture20261015 = '2026-10-15';
const fixtureSiamparkRelationships = 'siampark.relationships';
const fixtureFinancialPlanEntry = 'financial-plan-entry';
const aliases = [
  fixturePropertyParkova,
  fixturePropertyRiverside,
  'unit.parkova.a101',
  fixtureUnitParkovaA102,
  fixtureUnitParkovaA103,
  fixtureUnitRiversideB201,
  'unit.riverside.b202',
  fixtureAssetParkovaHvac01,
  fixtureCustomerA102Tenant,
  fixtureCustomerB201Tenant,
  fixtureCustomerGoldenA101,
  fixtureGuestA103Shortstay,
  fixtureSupplierMaintenance,
  fixtureSupplierUtilities,
  fixtureCounterpartyA102,
  fixtureCounterpartyB201,
  'counterparty.golden',
  fixtureCounterpartyMaintenance,
  fixtureCounterpartyUtilities,
  fixtureOccupancyA102,
  fixtureOccupancyA103,
  fixtureOccupancyB201,
  fixtureContractA102Lease,
  fixtureContractB201Lease,
  fixtureDocumentA102Lease,
  'document.b201.lease',
  fixtureInvoiceA102Paid,
  'invoice.b201.overdue',
  'invoice.parkova.supplier',
  'invoice.riverside.supplier',
  'task-collection.operations',
  fixtureTaskHvacMaintenance,
  fixtureTaskB201Renewal,
  'task.operations-followup',
  fixtureTaskExternalAgentAssigned,
  'activity.completed',
  fixtureActivityFollowup,
  'activity.external',
  'booking.success',
  fixtureBookingConflict,
  'plan.parkova.revenue',
  'plan.parkova.cost',
  'plan.riverside.revenue',
  'plan.riverside.cost',
  'seed.invocation',
  fixtureSignatureA102,
  'email.followup',
] as const;
export type DemoAlias = (typeof aliases)[number];
export const demoId = (alias: DemoAlias): string =>
  `76000000-0000-4000-8000-${String(aliases.indexOf(alias) + 1).padStart(12, '0')}`;
export const demoRef = (moduleId: string, resource: string, alias: DemoAlias) => ({
  moduleId,
  resourceId: demoId(alias),
  resourceType: `${moduleId}.${resource}`,
  tenantId: demoTenantId,
});
export const demoAccounts = [
  {
    authBindingId: '73000000-0000-4000-8000-000000000021',
    authUserId: 'siampark-management',
    displayName: 'Management',
    email: 'management@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000021',
  },
  {
    authBindingId: '73000000-0000-4000-8000-000000000022',
    authUserId: 'siampark-operations',
    displayName: 'Operations',
    email: 'operations@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000022',
  },
  {
    authBindingId: '73000000-0000-4000-8000-000000000023',
    authUserId: 'siampark-finance',
    displayName: 'Finance',
    email: 'finance@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000023',
  },
  {
    authBindingId: '73000000-0000-4000-8000-000000000024',
    authUserId: 'siampark-external',
    displayName: 'External Agent',
    email: 'external@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000024',
  },
] as const;
const principal = (principalId: string) => ({ principalId, tenantId: demoTenantId });
const property = (alias: typeof fixturePropertyParkova | typeof fixturePropertyRiverside) =>
  demoRef(fixtureSiamparkProperty, 'property', alias);
const unit = (alias: DemoAlias) => demoRef(fixtureSiamparkProperty, 'unit', alias);
const cp = (alias: DemoAlias) => demoRef(fixturePartyRegistry, 'counterparty', alias);
const party = (alias: DemoAlias) => demoRef(fixturePartyRegistry, 'party', alias);
const occupancy = (alias: DemoAlias) => demoRef('siampark.occupancy', 'occupancy', alias);
const contract = (alias: DemoAlias) => demoRef(fixtureSiamparkAgreements, 'contract', alias);
const invoice = (alias: DemoAlias) => demoRef(fixtureSiamparkBillingFinance, 'invoice', alias);
const task = (alias: DemoAlias) => demoRef('siampark.work', 'task', alias);
const collectionRef = demoRef('siampark.work', 'task-collection', 'task-collection.operations');
const timestamps = { createdAt: demoTimestamp, updatedAt: demoTimestamp };

export const partyFixture = {
  counterparties: [
    { id: demoId(fixtureCounterpartyA102), partyId: demoId(fixtureCustomerA102Tenant), role: 'CUSTOMER' },
    { id: demoId(fixtureCounterpartyB201), partyId: demoId(fixtureCustomerB201Tenant), role: 'CUSTOMER' },
    { id: demoId('counterparty.golden'), partyId: demoId(fixtureCustomerGoldenA101), role: 'CUSTOMER' },
    { id: demoId(fixtureCounterpartyMaintenance), partyId: demoId(fixtureSupplierMaintenance), role: 'SUPPLIER' },
    { id: demoId(fixtureCounterpartyUtilities), partyId: demoId(fixtureSupplierUtilities), role: 'SUPPLIER' },
  ],
  parties: [
    { id: demoId(fixtureCustomerA102Tenant), name: 'Jana Nováková', type: 'PERSON' },
    { id: demoId(fixtureCustomerB201Tenant), name: 'Petr Dvořák', type: 'PERSON' },
    { id: demoId(fixtureCustomerGoldenA101), name: 'Eva Králová', type: 'PERSON' },
    { id: demoId(fixtureGuestA103Shortstay), name: 'Alex Morgan', type: 'PERSON' },
    { id: demoId(fixtureSupplierMaintenance), name: 'Servis Park DEMO', type: 'ORGANIZATION' },
    { id: demoId(fixtureSupplierUtilities), name: 'Energie DEMO', type: 'ORGANIZATION' },
  ],
} as const;
/** Rebuildable public search projection of the same synthetic canonical seed identities. */
export const demoSearchDocuments = [
  ...partyFixture.parties.map((row) => ({
    archived: false,
    facets: [],
    metadata: [],
    projectionVersion: '1',
    ref: {
      moduleId: fixturePartyRegistry,
      resourceId: row.id,
      resourceType: fixturePartyResourceType,
      tenantId: demoTenantId,
    },
    searchableText: [row.name],
    title: row.name,
  })),
  ...partyFixture.counterparties.map((row) => {
    const identity = partyFixture.parties.find((value) => value.id === row.partyId);
    return {
      archived: false,
      facets: [],
      metadata: [],
      projectionVersion: '1',
      ref: {
        moduleId: fixturePartyRegistry,
        resourceId: row.id,
        resourceType: fixtureCounterpartyResourceType,
        tenantId: demoTenantId,
      },
      searchableText: [identity?.name ?? 'Unnamed synthetic Party'],
      selectedLegalEntityId: demoLegalEntityId,
      subjectRef: {
        moduleId: fixturePartyRegistry,
        resourceId: row.partyId,
        resourceType: fixturePartyResourceType,
        tenantId: demoTenantId,
      },
      temporalFacets: [{ key: 'current-role', validFrom: '2026-01-01T00:00:00.000Z', value: row.role }],
      title: identity?.name ?? 'Unnamed synthetic Party',
    };
  }),
];
const propertyState = {
  assets: [
    {
      acquiredAt: '2025-01-01',
      assetRef: demoRef(fixtureSiamparkProperty, 'asset', fixtureAssetParkovaHvac01),
      category: 'HVAC',
      code: 'HVAC-01',
      lastServiceAt: '2026-04-01',
      lifecycleState: 'ACTIVE',
      name: 'Klimatizační jednotka',
      nextServiceAt: '2026-10-04',
      propertyRef: property(fixturePropertyParkova),
      serialNumber: 'DEMO-HVAC-01',
      unitRef: null,
    },
  ],
  properties: [
    {
      address: 'Parková 12, Praha',
      code: 'PARK',
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: demoLegalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId: demoTenantId,
      },
      lifecycleState: 'ACTIVE',
      name: 'Rezidence Parková',
      note: null,
      propertyRef: property(fixturePropertyParkova),
      ...timestamps,
    },
    {
      address: 'Nábřežní 8, Praha',
      code: 'RIVER',
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: demoLegalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId: demoTenantId,
      },
      lifecycleState: 'ACTIVE',
      name: 'Apartmány Riverside',
      note: null,
      propertyRef: property(fixturePropertyRiverside),
      ...timestamps,
    },
  ],
  units: (
    [
      'unit.parkova.a101',
      fixtureUnitParkovaA102,
      fixtureUnitParkovaA103,
      fixtureUnitRiversideB201,
      'unit.riverside.b202',
    ] as const
  ).map((alias) => ({
    capacity: 2,
    code: alias.slice(-4).toUpperCase(),
    lifecycleState: 'ACTIVE',
    name: alias.slice(-4).toUpperCase(),
    note: null,
    propertyRef: property(alias.startsWith('unit.parkova') ? fixturePropertyParkova : fixturePropertyRiverside),
    unitKind: 'APARTMENT',
    unitRef: unit(alias),
  })),
};
const occupancyState = {
  bookingObservations: [
    {
      attemptedAt: demoTimestamp,
      attempts: 1,
      completedAt: demoTimestamp,
      correlation: 'booking:A103:baseline',
      integrationKind: 'BOOKING',
      mode: 'SIMULATED',
      observationId: demoId('booking.success'),
      occupancyRef: occupancy(fixtureOccupancyA103),
      ownerResourceRef: occupancy(fixtureOccupancyA103),
      providerLabel: 'DEMO',
      requestSummary: 'Synthetic fixture: A103; 2026-10-03 → 2026-10-08; guests 2',
      resultSummary: 'SIMULATED: SUCCESS; booking:A103:baseline',
      state: 'SUCCESS',
    },
    {
      attemptedAt: demoTimestamp,
      attempts: 1,
      completedAt: demoTimestamp,
      correlation: 'booking:A103:conflict',
      integrationKind: 'BOOKING',
      mode: 'SIMULATED',
      observationId: demoId(fixtureBookingConflict),
      occupancyRef: null,
      ownerResourceRef: unit(fixtureUnitParkovaA103),
      providerLabel: 'DEMO',
      requestSummary: 'Synthetic fixture: A103; overlap with imported short stay',
      resultSummary: 'SIMULATED: CONFLICT; booking:A103:conflict',
      state: 'CONFLICT',
    },
  ],
  occupancies: [
    {
      contractRef: contract(fixtureContractA102Lease),
      customerCounterpartyRef: cp(fixtureCounterpartyA102),
      endDate: '2027-01-01',
      externalBookingCorrelation: null,
      guestPartyRef: null,
      kind: 'LONG_TERM_LEASE',
      note: null,
      occupancyRef: occupancy(fixtureOccupancyA102),
      peopleCount: null,
      startDate: fixture20260101,
      state: 'ACTIVE',
      unitRef: unit(fixtureUnitParkovaA102),
    },
    {
      contractRef: null,
      customerCounterpartyRef: null,
      endDate: '2026-10-08',
      externalBookingCorrelation: 'booking:A103:baseline',
      guestPartyRef: party(fixtureGuestA103Shortstay),
      kind: 'SHORT_STAY',
      note: 'Simulovaný import rezervace',
      occupancyRef: occupancy(fixtureOccupancyA103),
      peopleCount: 2,
      startDate: '2026-10-03',
      state: 'CONFIRMED',
      unitRef: unit(fixtureUnitParkovaA103),
    },
    {
      contractRef: contract(fixtureContractB201Lease),
      customerCounterpartyRef: cp(fixtureCounterpartyB201),
      endDate: '2026-10-25',
      externalBookingCorrelation: null,
      guestPartyRef: null,
      kind: 'LONG_TERM_LEASE',
      note: null,
      occupancyRef: occupancy(fixtureOccupancyB201),
      peopleCount: null,
      startDate: fixture20260101,
      state: 'ACTIVE',
      unitRef: unit(fixtureUnitRiversideB201),
    },
  ],
};
const agreementsState = {
  contracts: [
    {
      contractRef: contract(fixtureContractA102Lease),
      counterpartyRef: cp(fixtureCounterpartyA102),
      endDate: '2027-01-01',
      kind: 'LEASE',
      lifecycleState: 'ACTIVE',
      note: null,
      occupancyRef: occupancy(fixtureOccupancyA102),
      propertyRef: property(fixturePropertyParkova),
      renewalNoticeDate: '2026-12-01',
      signatureState: 'SIGNED',
      startDate: fixture20260101,
      supersedesContractRef: null,
      unitRef: unit(fixtureUnitParkovaA102),
    },
    {
      contractRef: contract(fixtureContractB201Lease),
      counterpartyRef: cp(fixtureCounterpartyB201),
      endDate: '2026-10-25',
      kind: 'LEASE',
      lifecycleState: 'ACTIVE',
      note: null,
      occupancyRef: occupancy(fixtureOccupancyB201),
      propertyRef: property(fixturePropertyRiverside),
      renewalNoticeDate: '2026-10-01',
      signatureState: 'SIGNED',
      startDate: fixture20260101,
      supersedesContractRef: null,
      unitRef: unit(fixtureUnitRiversideB201),
    },
  ],
  documents: [
    {
      contractRef: contract(fixtureContractA102Lease),
      documentRef: demoRef(fixtureSiamparkAgreements, 'document', fixtureDocumentA102Lease),
      fileName: 'a102-demo.pdf',
      kind: 'LEASE',
      lifecycleState: 'FINAL',
      signedDocumentReference: 'demo:signed:A102',
      title: 'Podepsaná nájemní smlouva A102',
      ...timestamps,
    },
    {
      contractRef: contract(fixtureContractB201Lease),
      documentRef: demoRef(fixtureSiamparkAgreements, 'document', 'document.b201.lease'),
      fileName: 'b201-demo.pdf',
      kind: 'LEASE',
      lifecycleState: 'FINAL',
      signedDocumentReference: 'demo:signed:B201',
      title: 'Podepsaná nájemní smlouva B201',
      ...timestamps,
    },
  ],
  signatureObservations: [
    {
      attemptedAt: demoTimestamp,
      completedAt: demoTimestamp,
      contractRef: contract(fixtureContractA102Lease),
      correlation: 'signature:A102:baseline',
      documentRef: demoRef(fixtureSiamparkAgreements, 'document', fixtureDocumentA102Lease),
      integrationKind: 'ELECTRONIC_SIGNATURE',
      mode: 'SIMULATED',
      observationId: demoId(fixtureSignatureA102),
      ownerResourceRef: contract(fixtureContractA102Lease),
      providerLabel: 'DEMO',
      requestSummary: 'Synthetic fixture: A102 lease signature request',
      resultSummary: 'SIMULATED: SIGNED; historical fixture receipt',
      signer: {
        contact: 'jana.novakova@example.test',
        counterpartyRef: cp(fixtureCounterpartyA102),
        displayName: 'Jana Nováková',
        partyRef: party(fixtureCustomerA102Tenant),
      },
      state: 'SIGNED',
    },
  ],
};
const workState = {
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: collectionRef,
    title: 'Provozní úkoly',
  },
  tasks: [
    {
      collectionRef,
      contextRefs: [
        property(fixturePropertyParkova),
        demoRef(fixtureSiamparkProperty, 'asset', fixtureAssetParkovaHvac01),
      ],
      dueDate: '2026-10-04',
      ownerPrincipalRef: principal(demoAccounts[1].principalId),
      priority: 'HIGH',
      ref: task(fixtureTaskHvacMaintenance),
      state: 'NEW',
      title: 'Servis HVAC-01',
      ...timestamps,
    },
    {
      collectionRef,
      contextRefs: [unit(fixtureUnitRiversideB201)],
      dueDate: fixture20261015,
      ownerPrincipalRef: principal(demoAccounts[1].principalId),
      priority: 'HIGH',
      ref: task(fixtureTaskB201Renewal),
      state: 'NEW',
      title: 'Prodloužit nájem B201',
      ...timestamps,
    },
    {
      collectionRef,
      contextRefs: [property(fixturePropertyParkova)],
      dueDate: '2026-10-12',
      ownerPrincipalRef: principal(demoAccounts[1].principalId),
      priority: 'NORMAL',
      ref: task('task.operations-followup'),
      state: 'IN_PROGRESS',
      title: 'Kontrola Parková',
      ...timestamps,
    },
    {
      collectionRef,
      contextRefs: [unit(fixtureUnitRiversideB201)],
      dueDate: '2026-10-10',
      ownerPrincipalRef: principal(demoAccounts[3].principalId),
      priority: 'NORMAL',
      ref: task(fixtureTaskExternalAgentAssigned),
      state: 'NEW',
      title: 'Dohodnout návštěvu B201',
      ...timestamps,
    },
  ],
};
const relationshipsState = {
  activities: [
    {
      contextRefs: [],
      counterpartyRef: cp(fixtureCounterpartyA102),
      createdAt: demoTimestamp,
      kind: 'CALL',
      occurredAt: demoTimestamp,
      ownerPrincipalRef: principal(demoAccounts[1].principalId),
      partyRef: party(fixtureCustomerA102Tenant),
      ref: demoRef(fixtureSiamparkRelationships, 'activity', 'activity.completed'),
      summary: 'Nájem A102 potvrzen',
    },
    {
      contextRefs: [],
      counterpartyRef: cp(fixtureCounterpartyB201),
      createdAt: demoTimestamp,
      followUpTaskRef: task(fixtureTaskB201Renewal),
      kind: 'EMAIL',
      occurredAt: demoTimestamp,
      ownerPrincipalRef: principal(demoAccounts[1].principalId),
      partyRef: party(fixtureCustomerB201Tenant),
      ref: demoRef(fixtureSiamparkRelationships, 'activity', fixtureActivityFollowup),
      summary: 'Připravit prodloužení B201',
    },
    {
      contextRefs: [],
      counterpartyRef: cp(fixtureCounterpartyB201),
      createdAt: demoTimestamp,
      followUpTaskRef: task(fixtureTaskExternalAgentAssigned),
      kind: 'NOTE',
      occurredAt: demoTimestamp,
      ownerPrincipalRef: principal(demoAccounts[3].principalId),
      partyRef: party(fixtureCustomerB201Tenant),
      ref: demoRef(fixtureSiamparkRelationships, 'activity', 'activity.external'),
      summary: 'Přiřazená návštěva B201',
    },
  ],
  emailObservations: [
    {
      attemptedAt: demoTimestamp,
      completedAt: demoTimestamp,
      correlation: 'notification:activity.b201.followup',
      integrationKind: 'EMAIL',
      mode: 'SIMULATED',
      observationId: demoId('email.followup'),
      ownerResourceRef: demoRef(fixtureSiamparkRelationships, 'activity', fixtureActivityFollowup),
      providerLabel: 'DEMO',
      receipt: 'DEMO-NOTIFICATION:activity.b201.followup',
      requestSummary: 'Notification for the recorded B201 renewal follow-up',
      resultSummary: 'SIMULATED: submission accepted; no message was sent',
      status: 'SUCCESS',
    },
  ],
};
const invoiceRows = [
  {
    accountingSyncState: 'SYNCED',
    alias: fixtureInvoiceA102Paid,
    contractRef: contract(fixtureContractA102Lease),
    counterpartyRef: cp(fixtureCounterpartyA102),
    direction: 'OUTGOING',
    documentNumber: 'DEMO-2026-A102',
    dueDate: '2026-09-15',
    occupancyRef: occupancy(fixtureOccupancyA102),
    paidMinor: 1_600_000,
    paymentState: 'PAID',
    propertyRef: property(fixturePropertyParkova),
    totalMinor: 1_600_000,
    unitRef: unit(fixtureUnitParkovaA102),
  },
  {
    accountingSyncState: 'FAILED',
    alias: 'invoice.b201.overdue',
    contractRef: contract(fixtureContractB201Lease),
    counterpartyRef: cp(fixtureCounterpartyB201),
    direction: 'OUTGOING',
    documentNumber: 'DEMO-2026-B201',
    dueDate: '2026-09-30',
    occupancyRef: occupancy(fixtureOccupancyB201),
    paidMinor: 0,
    paymentState: 'UNPAID',
    propertyRef: property(fixturePropertyRiverside),
    totalMinor: 1_800_000,
    unitRef: unit(fixtureUnitRiversideB201),
  },
  {
    accountingSyncState: 'SYNCED',
    alias: 'invoice.parkova.supplier',
    counterpartyRef: cp(fixtureCounterpartyMaintenance),
    direction: 'INCOMING',
    documentNumber: 'DEMO-SUP-PARK',
    dueDate: fixture20261015,
    paidMinor: 0,
    paymentState: 'UNPAID',
    propertyRef: property(fixturePropertyParkova),
    taskRef: task(fixtureTaskHvacMaintenance),
    totalMinor: 420_000,
  },
  {
    accountingSyncState: 'SYNCED',
    alias: 'invoice.riverside.supplier',
    counterpartyRef: cp(fixtureCounterpartyUtilities),
    direction: 'INCOMING',
    documentNumber: 'DEMO-SUP-RIVER',
    dueDate: fixture20261015,
    paidMinor: 0,
    paymentState: 'UNPAID',
    propertyRef: property(fixturePropertyRiverside),
    totalMinor: 260_000,
  },
] as const;
const financeState = {
  accountingObservations: invoiceRows.map(({ accountingSyncState, alias }) => {
    const observation = {
      attemptedAt: demoTimestamp,
      attemptId: `attempt:${alias}:1`,
      completedAt: demoTimestamp,
      correlation: `accounting:${alias}`,
      integrationKind: 'ACCOUNTING',
      invoiceRef: invoice(alias),
      latest: true,
      mode: 'SIMULATED',
      providerLabel: 'DEMO',
      requestSummary: 'Simulované zaúčtování',
      resultId: `result:${alias}:1`,
      resultSummary:
        accountingSyncState === 'FAILED' ? 'Simulovaná chyba poskytovatele' : 'Simulované zaúčtování potvrzeno',
      revision: 1,
      status: accountingSyncState === 'FAILED' ? 'FAILED' : 'SUCCESS',
    };
    return accountingSyncState === 'FAILED' ? observation : { ...observation, receipt: `DEMO-RECEIPT:${alias}` };
  }),
  financialPlanEntries: [
    {
      category: 'Nájemné',
      kind: 'REVENUE',
      plannedMinor: 3_600_000,
      propertyRef: property(fixturePropertyParkova),
      ref: demoRef(fixtureSiamparkBillingFinance, fixtureFinancialPlanEntry, 'plan.parkova.revenue'),
    },
    {
      category: 'Provoz',
      kind: 'COST',
      plannedMinor: 500_000,
      propertyRef: property(fixturePropertyParkova),
      ref: demoRef(fixtureSiamparkBillingFinance, fixtureFinancialPlanEntry, 'plan.parkova.cost'),
    },
    {
      category: 'Nájemné',
      kind: 'REVENUE',
      plannedMinor: 2_000_000,
      propertyRef: property(fixturePropertyRiverside),
      ref: demoRef(fixtureSiamparkBillingFinance, fixtureFinancialPlanEntry, 'plan.riverside.revenue'),
    },
    {
      category: 'Provoz',
      kind: 'COST',
      plannedMinor: 300_000,
      propertyRef: property(fixturePropertyRiverside),
      ref: demoRef(fixtureSiamparkBillingFinance, fixtureFinancialPlanEntry, 'plan.riverside.cost'),
    },
  ].map((row) => ({
    ...row,
    currency: 'CZK',
    periodEndExclusive: '2026-11-01',
    periodStart: '2026-10-01',
    state: 'CONFIRMED',
  })),
  invoices: invoiceRows.map(({ alias, ...row }) => {
    const record = {
      ...row,
      accountingCorrelation: `accounting:${alias}`,
      businessState: 'CONFIRMED',
      currency: 'CZK',
      issueDate: '2026-09-01',
      ref: invoice(alias),
      ...timestamps,
    };
    return row.accountingSyncState === 'SYNCED'
      ? { ...record, externalAccountingReference: `DEMO-RECEIPT:${alias}` }
      : record;
  }),
  paymentObservations: [
    {
      confirmedPaidMinor: 1_600_000,
      correlation: 'payment:A102:baseline',
      currency: 'CZK',
      invoiceRef: invoice(fixtureInvoiceA102Paid),
      mode: 'SIMULATED',
      observedAt: demoTimestamp,
      resultId: 'payment:A102:baseline',
    },
  ],
};
export const demoOwnerStates = {
  'siampark-agreements': agreementsState,
  'siampark-billing-finance': financeState,
  'siampark-occupancy': occupancyState,
  'siampark-property': propertyState,
  'siampark-relationships': relationshipsState,
  'siampark-work': workState,
};

// The operator serializes wire snapshots through each owner's published read contract.
const DemoOwnerStatesSchema = Schema.Struct({
  'siampark-agreements': Schema.toEncoded(AgreementsStateSchema),
  'siampark-billing-finance': Schema.toEncoded(FinanceStateSchema),
  'siampark-occupancy': Schema.toEncoded(OccupancyStateSchema),
  'siampark-property': Schema.toEncoded(PropertyStateSchema),
  'siampark-relationships': Schema.toEncoded(RelationshipsStateSchema),
  'siampark-work': Schema.toEncoded(WorkStateSchema),
});
const encodeOwnerFixture = <S extends Schema.Top>(schema: S, state: S['Encoded']) => {
  const fixtureSchema = Schema.Struct({
    legalEntityId: Schema.Literal(demoLegalEntityId),
    state: Schema.toEncoded(schema),
    tenantId: Schema.Literal(demoTenantId),
  });
  return Schema.decodeUnknownEffect(fixtureSchema)({
    legalEntityId: demoLegalEntityId,
    state,
    tenantId: demoTenantId,
  }).pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(fixtureSchema))));
};
export const demoOwnerPorts = Effect.gen(function* serializeOwnerFixtures() {
  const states = yield* Schema.decodeUnknownEffect(DemoOwnerStatesSchema)(demoOwnerStates);
  return [
    {
      encodedFixture: yield* encodeOwnerFixture(AgreementsStateSchema, states['siampark-agreements']),
      script: 'verticals/siampark-agreements/scripts/reset-demo.mts',
    },
    {
      encodedFixture: yield* encodeOwnerFixture(FinanceStateSchema, states['siampark-billing-finance']),
      script: 'verticals/siampark-billing-finance/scripts/reset-demo.mts',
    },
    {
      encodedFixture: yield* encodeOwnerFixture(OccupancyStateSchema, states['siampark-occupancy']),
      script: 'verticals/siampark-occupancy/scripts/reset-demo.mts',
    },
    {
      encodedFixture: yield* encodeOwnerFixture(PropertyStateSchema, states['siampark-property']),
      script: 'verticals/siampark-property/scripts/reset-demo.mts',
    },
    {
      encodedFixture: yield* encodeOwnerFixture(RelationshipsStateSchema, states['siampark-relationships']),
      script: 'verticals/siampark-relationships/scripts/reset-demo.mts',
    },
    {
      encodedFixture: yield* encodeOwnerFixture(WorkStateSchema, states['siampark-work']),
      script: 'verticals/siampark-work/scripts/reset-demo.mts',
    },
  ];
});

// Scalar inputs belong to the operator's development provisioning protocol.
const SeedUuidSchema = Schema.String.check(Schema.isUUID());
const SeedTextSchema = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(1000));
const PrincipalIdSchema = Schema.toEncoded(SeedUuidSchema.pipe(Schema.brand('DemoPrincipalId')));
const AuthBindingIdSchema = Schema.toEncoded(SeedUuidSchema.pipe(Schema.brand('DemoAuthBindingId')));
const AuthUserIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isPattern(/^siampark-(?:management|operations|finance|external)$/u)).pipe(
    Schema.brand('DemoAuthUserId'),
  ),
);
const SeedAccountSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  authUserId: AuthUserIdSchema,
  displayName: SeedTextSchema,
  email: Schema.String.check(Schema.isPattern(/^(?:management|operations|finance|external)@siampark\.demo$/u)),
  principalId: PrincipalIdSchema,
});
const SeedAccountsSchema = Schema.Array(SeedAccountSchema).check(
  Schema.isMinLength(4),
  Schema.isMaxLength(4),
  Schema.makeFilter(
    (accounts) =>
      new Set(accounts.map((account) => account.authUserId)).size === 4 &&
      accounts.every((account) => account.email === `${account.authUserId.slice('siampark-'.length)}@siampark.demo`),
  ),
);
export const AccountsFixtureSchema = Schema.Struct({ accounts: SeedAccountsSchema });
export const RelationshipSchema = Schema.Struct({
  relation: SeedTextSchema,
  resourceId: Schema.toEncoded(SeedTextSchema.pipe(Schema.brand('AuthorizationResourceId'))),
  resourceType: SeedTextSchema,
  subjectId: Schema.toEncoded(SeedTextSchema.pipe(Schema.brand('AuthorizationSubjectId'))),
  subjectType: SeedTextSchema,
});
export type Relationship = typeof RelationshipSchema.Type;
export const ContextFixtureSchema = Schema.Struct({
  accounts: SeedAccountsSchema,
  legalEntity: Schema.Struct({
    legalEntityId: Schema.Literal(demoLegalEntityId),
    legalName: SeedTextSchema,
    registrationCountry: Schema.Literal('CZ'),
    registrationNumber: SeedTextSchema,
  }),
  modules: Schema.Array(
    Schema.Struct({
      moduleId: Schema.toEncoded(SeedTextSchema.pipe(Schema.brand('DemoModuleId'))),
      stateId: Schema.toEncoded(SeedUuidSchema.pipe(Schema.brand('DemoStateId'))),
    }),
  ),
  relationships: Schema.Array(RelationshipSchema),
  searchDocuments: Schema.Array(CoreSearchProjectionDocumentSchema),
  tenant: Schema.Struct({
    defaultLocale: Schema.Literal('cs'),
    displayName: SeedTextSchema,
    slug: Schema.Literal('siampark-demo'),
    tenantId: Schema.Literal(demoTenantId),
  }),
});
export const PartyFixtureSchema = Schema.Struct({
  counterparties: Schema.Array(
    Schema.Struct({
      id: SeedUuidSchema,
      partyId: Schema.toEncoded(SeedUuidSchema.pipe(Schema.brand('DemoPartyId'))),
      role: Schema.Literals(['CUSTOMER', 'SUPPLIER']),
    }),
  ),
  invocationId: Schema.toEncoded(SeedUuidSchema.pipe(Schema.brand('DemoInvocationId'))),
  legalEntityId: Schema.Literal(demoLegalEntityId),
  parties: Schema.Array(
    Schema.Struct({ id: SeedUuidSchema, name: SeedTextSchema, type: Schema.Literals(['PERSON', 'ORGANIZATION']) }),
  ),
  principalId: PrincipalIdSchema,
  tenantId: Schema.Literal(demoTenantId),
});
export const encodeOperatorFixture = <S extends Schema.Top>(schema: S, input: S['Encoded']) =>
  Schema.decodeEffect(Schema.toEncoded(schema))(input).pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(schema)))),
  );
