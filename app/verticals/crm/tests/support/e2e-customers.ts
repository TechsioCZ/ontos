// @effect-diagnostics asyncFunction:off
import { Pool } from 'pg';

export const crmE2eCustomers = {
  active: {
    createdAt: '2026-08-01T08:00:00.000Z',
    customerId: '70000000-0000-4000-8000-000000000001',
    name: 'E2E Alpha Customer',
    updatedAt: '2026-08-10T09:30:00.000Z',
  },
  archived: {
    archivedAt: '2026-08-12T11:00:00.000Z',
    createdAt: '2026-07-01T07:00:00.000Z',
    customerId: '70000000-0000-4000-8000-000000000002',
    name: 'E2E Archived Customer',
    updatedAt: '2026-08-12T11:00:00.000Z',
  },
} as const;

interface CrmE2eCustomersFixtureOptions {
  readonly connectionString: string;
  readonly tenantIds: readonly string[];
}

export const createCrmE2eCustomersFixture = ({
  connectionString,
  tenantIds,
}: CrmE2eCustomersFixtureOptions) => {
  const pool = new Pool({ connectionString });
  const cleanup = async () => {
    await pool.query('delete from crm.customers where tenant_id = any($1::uuid[])', [tenantIds]);
  };

  return {
    cleanup,
    close: () => pool.end(),
    seed: async (tenantId: string) => {
      await pool.query(
        `insert into crm.customers
          (tenant_id, customer_id, name, created_at, updated_at, archived_at)
         values
          ($1, $2, $3, $4, $5, null),
          ($1, $6, $7, $8, $9, $10)`,
        [
          tenantId,
          crmE2eCustomers.active.customerId,
          crmE2eCustomers.active.name,
          crmE2eCustomers.active.createdAt,
          crmE2eCustomers.active.updatedAt,
          crmE2eCustomers.archived.customerId,
          crmE2eCustomers.archived.name,
          crmE2eCustomers.archived.createdAt,
          crmE2eCustomers.archived.updatedAt,
          crmE2eCustomers.archived.archivedAt,
        ],
      );
    },
  };
};
