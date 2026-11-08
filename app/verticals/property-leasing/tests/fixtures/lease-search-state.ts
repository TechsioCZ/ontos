import { Schema } from 'effect';
import { OccupancyStateSchema } from '../../shared/apis/records.ts';

export const leaseSearchTenantId = '10000000-0000-4000-8000-000000000001';
export const leaseSearchCompanyId = '20000000-0000-4000-8000-000000000001';
export const leaseSearchState = (resourceIds: readonly string[]) =>
  Schema.decodeUnknownSync(OccupancyStateSchema)({
    occupancies: resourceIds.map((resourceId) => ({
      contractRef: null,
      customerCounterpartyRef: null,
      endDate: null,
      externalBookingCorrelation: null,
      guestPartyRef: null,
      kind: 'LONG_TERM_LEASE',
      note: null,
      occupancyRef: {
        moduleId: 'property.leasing',
        resourceId,
        resourceType: 'property.leasing.occupancy',
        tenantId: leaseSearchTenantId,
      },
      peopleCount: null,
      startDate: '2026-11-01',
      state: 'ACTIVE',
      unitRef: {
        moduleId: 'property.portfolio',
        resourceId: '50000000-0000-4000-8000-000000000001',
        resourceType: 'property.portfolio.unit',
        tenantId: leaseSearchTenantId,
      },
    })),
  });
