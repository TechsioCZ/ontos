// Exact historical synthetic seed; comparison prevents removing edited or newly linked records.
const LEGAL_MODULE_ID = 'legal.agreements';
const CONTRACT_RESOURCE_TYPE = 'legal.agreements.contract';
const LEGACY_TENANT_ID = '70000000-0000-4000-8000-000000000020';
const PROPERTY_MODULE_ID = 'property.portfolio';
const UNIT_RESOURCE_TYPE = 'property.portfolio.unit';
const LEGACY_DOCUMENT_TIMESTAMP = '2026-10-05T09:00:00.000Z';

export const legacyRentalBaseline = {
  contracts: [
    {
      contractRef: {
        moduleId: LEGAL_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000023',
        resourceType: CONTRACT_RESOURCE_TYPE,
        tenantId: LEGACY_TENANT_ID,
      },
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: '76000000-0000-4000-8000-000000000015',
        resourceType: 'party.registry.counterparty',
        tenantId: LEGACY_TENANT_ID,
      },
      endDate: '2027-01-01',
      kind: 'LEASE',
      lifecycleState: 'ACTIVE',
      note: null,
      occupancyRef: {
        moduleId: 'property.leasing',
        resourceId: '76000000-0000-4000-8000-000000000020',
        resourceType: 'property.leasing.occupancy',
        tenantId: LEGACY_TENANT_ID,
      },
      propertyRef: {
        moduleId: PROPERTY_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000001',
        resourceType: 'property.portfolio.property',
        tenantId: LEGACY_TENANT_ID,
      },
      renewalNoticeDate: '2026-12-01',
      signatureState: 'SIGNED',
      startDate: '2026-01-01',
      supersedesContractRef: null,
      unitRef: {
        moduleId: PROPERTY_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000004',
        resourceType: UNIT_RESOURCE_TYPE,
        tenantId: LEGACY_TENANT_ID,
      },
    },
    {
      contractRef: {
        moduleId: LEGAL_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000024',
        resourceType: CONTRACT_RESOURCE_TYPE,
        tenantId: LEGACY_TENANT_ID,
      },
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: '76000000-0000-4000-8000-000000000016',
        resourceType: 'party.registry.counterparty',
        tenantId: LEGACY_TENANT_ID,
      },
      endDate: '2026-10-25',
      kind: 'LEASE',
      lifecycleState: 'ACTIVE',
      note: null,
      occupancyRef: {
        moduleId: 'property.leasing',
        resourceId: '76000000-0000-4000-8000-000000000022',
        resourceType: 'property.leasing.occupancy',
        tenantId: LEGACY_TENANT_ID,
      },
      propertyRef: {
        moduleId: PROPERTY_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000002',
        resourceType: 'property.portfolio.property',
        tenantId: LEGACY_TENANT_ID,
      },
      renewalNoticeDate: '2026-10-01',
      signatureState: 'SIGNED',
      startDate: '2026-01-01',
      supersedesContractRef: null,
      unitRef: {
        moduleId: PROPERTY_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000006',
        resourceType: UNIT_RESOURCE_TYPE,
        tenantId: LEGACY_TENANT_ID,
      },
    },
  ],
  documents: [
    {
      contractRef: {
        moduleId: LEGAL_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000023',
        resourceType: CONTRACT_RESOURCE_TYPE,
        tenantId: LEGACY_TENANT_ID,
      },
      createdAt: LEGACY_DOCUMENT_TIMESTAMP,
      documentRef: {
        moduleId: LEGAL_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000025',
        resourceType: 'legal.agreements.document',
        tenantId: LEGACY_TENANT_ID,
      },
      fileName: 'a102-demo.pdf',
      kind: 'LEASE',
      lifecycleState: 'FINAL',
      signedDocumentReference: 'demo:signed:A102',
      title: 'Podepsaná nájemní smlouva A102',
      updatedAt: LEGACY_DOCUMENT_TIMESTAMP,
    },
    {
      contractRef: {
        moduleId: LEGAL_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000024',
        resourceType: CONTRACT_RESOURCE_TYPE,
        tenantId: LEGACY_TENANT_ID,
      },
      createdAt: LEGACY_DOCUMENT_TIMESTAMP,
      documentRef: {
        moduleId: LEGAL_MODULE_ID,
        resourceId: '76000000-0000-4000-8000-000000000026',
        resourceType: 'legal.agreements.document',
        tenantId: LEGACY_TENANT_ID,
      },
      fileName: 'b201-demo.pdf',
      kind: 'LEASE',
      lifecycleState: 'FINAL',
      signedDocumentReference: 'demo:signed:B201',
      title: 'Podepsaná nájemní smlouva B201',
      updatedAt: LEGACY_DOCUMENT_TIMESTAMP,
    },
  ],
};
