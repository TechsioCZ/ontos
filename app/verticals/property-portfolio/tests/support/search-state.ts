import { DateTime, Schema } from 'effect';
import { PropertyStateSchema } from '../../shared/apis/records.ts';

export const searchTenantId = '10000000-0000-4000-8000-000000000001';
export const searchCompanyId = '20000000-0000-4000-8000-000000000001';
export const searchRecordIds = [1, 2, 3].map((id) => `40000000-0000-4000-8000-${String(id).padStart(12, '0')}`);
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'property.portfolio',
  resourceId,
  resourceType: `property.portfolio.${resourceType}`,
  tenantId: searchTenantId,
});
const at = '2026-11-01T00:00:00Z';
const propertyRef = ref('property', '40000000-0000-4000-8000-000000000099');

/** Current owner aggregate, supplied in the real Drizzle state-table column order by native Read tests. */
export const searchState = Schema.decodeUnknownSync(PropertyStateSchema)({
  assets: searchRecordIds.map((id, index) => ({
    acquiredAt: null,
    assetRef: ref('asset', id),
    category: 'Machine',
    code: `A${index}`,
    lastServiceAt: null,
    lifecycleState: 'ACTIVE',
    name: ['A park', 'B park', 'C park'][index],
    nextServiceAt: null,
    propertyRef,
    serialNumber: null,
    unitRef: null,
  })),
  properties: [
    {
      address: 'Secret boulevard',
      code: 'HIDDEN-PARENT',
      createdAt: at,
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: searchCompanyId,
        resourceType: 'core.identity.legal-entity',
        tenantId: searchTenantId,
      },
      lifecycleState: 'ACTIVE',
      name: 'Private parent',
      note: null,
      propertyRef,
      updatedAt: at,
    },
    ...searchRecordIds.map((id, index) => ({
      address: 'Own address',
      code: `P${index}`,
      createdAt: at,
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: searchCompanyId,
        resourceType: 'core.identity.legal-entity',
        tenantId: searchTenantId,
      },
      lifecycleState: 'ACTIVE',
      name: ['A park', 'B park', 'C park'][index],
      note: null,
      propertyRef: ref('property', id),
      updatedAt: at,
    })),
  ],
  units: searchRecordIds.map((id, index) => ({
    capacity: null,
    code: `U${index}`,
    lifecycleState: 'ACTIVE',
    name: ['A park', 'B park', 'C park'][index],
    note: null,
    propertyRef,
    unitKind: null,
    unitRef: ref('unit', id),
  })),
});

export const searchStateRow = (state = searchState) => ({
  legalEntityId: searchCompanyId,
  payload: state,
  revision: 42,
  tenantId: searchTenantId,
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(at)),
});
