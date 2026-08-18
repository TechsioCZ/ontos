// @effect-diagnostics asyncFunction:off
import { Pool } from 'pg';
import type { Customer } from '../../shared/apis/customer-detail.ts';

export const crmE2eCustomers = {
  active: {
    archivedAt: null,
    createdAt: '2026-08-01T08:00:00.000Z',
    customerId: '70000000-0000-4000-8000-000000000001',
    dic: 'CZ00123456',
    dissolvedOn: '2026-08-17',
    establishedOn: '2020-01-02',
    ico: '00123456',
    legalFormCode: '112',
    name: 'E2E Alpha Customer',
    updatedAt: '2026-08-10T09:30:00.000Z',
  },
  archived: {
    archivedAt: '2026-08-12T11:00:00.000Z',
    createdAt: '2026-07-01T07:00:00.000Z',
    customerId: '70000000-0000-4000-8000-000000000002',
    dic: null,
    dissolvedOn: null,
    establishedOn: null,
    ico: null,
    legalFormCode: null,
    name: 'E2E Archived Customer',
    updatedAt: '2026-08-12T11:00:00.000Z',
  },
} as const satisfies Record<'active' | 'archived', Customer>;

export const crmE2eContacts = {
  active: {
    contactId: '71000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-02T08:30:00.000Z',
    customerId: crmE2eCustomers.active.customerId,
    email: 'active.contact@example.test',
    name: 'E2E Active Contact',
    phone: '+420 777 100 001',
    updatedAt: '2026-08-11T09:45:00.000Z',
  },
  archived: {
    archivedAt: '2026-08-13T12:00:00.000Z',
    contactId: '71000000-0000-4000-8000-000000000002',
    createdAt: '2026-07-02T07:30:00.000Z',
    customerId: crmE2eCustomers.archived.customerId,
    email: 'archived.contact.with.a.deliberately.long.address@example.test',
    name: 'E2E Archived Contact with a deliberately long name',
    phone: '+420 777 100 002',
    updatedAt: '2026-08-13T12:00:00.000Z',
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
    await pool.query('delete from crm.contacts where tenant_id = any($1::uuid[])', [tenantIds]);
    await pool.query('delete from crm.customers where tenant_id = any($1::uuid[])', [tenantIds]);
  };

  return {
    cleanup,
    close: () => pool.end(),
    seed: async (tenantId: string) => {
      await pool.query(
        `insert into crm.customers
          (tenant_id, customer_id, name, ico, dic, legal_form_code,
           established_on, dissolved_on, created_at, updated_at, archived_at)
         values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null),
          ($1, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          tenantId,
          crmE2eCustomers.active.customerId,
          crmE2eCustomers.active.name,
          crmE2eCustomers.active.ico,
          crmE2eCustomers.active.dic,
          crmE2eCustomers.active.legalFormCode,
          crmE2eCustomers.active.establishedOn,
          crmE2eCustomers.active.dissolvedOn,
          crmE2eCustomers.active.createdAt,
          crmE2eCustomers.active.updatedAt,
          crmE2eCustomers.archived.customerId,
          crmE2eCustomers.archived.name,
          crmE2eCustomers.archived.ico,
          crmE2eCustomers.archived.dic,
          crmE2eCustomers.archived.legalFormCode,
          crmE2eCustomers.archived.establishedOn,
          crmE2eCustomers.archived.dissolvedOn,
          crmE2eCustomers.archived.createdAt,
          crmE2eCustomers.archived.updatedAt,
          crmE2eCustomers.archived.archivedAt,
        ],
      );
      await pool.query(
        `insert into crm.contacts
          (tenant_id, contact_id, customer_id, name, email, phone, created_at, updated_at, archived_at)
         values
          ($1, $2, $3, $4, $5, $6, $7, $8, null),
          ($1, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          tenantId,
          crmE2eContacts.active.contactId,
          crmE2eContacts.active.customerId,
          crmE2eContacts.active.name,
          crmE2eContacts.active.email,
          crmE2eContacts.active.phone,
          crmE2eContacts.active.createdAt,
          crmE2eContacts.active.updatedAt,
          crmE2eContacts.archived.contactId,
          crmE2eContacts.archived.customerId,
          crmE2eContacts.archived.name,
          crmE2eContacts.archived.email,
          crmE2eContacts.archived.phone,
          crmE2eContacts.archived.createdAt,
          crmE2eContacts.archived.updatedAt,
          crmE2eContacts.archived.archivedAt,
        ],
      );
    },
  };
};
