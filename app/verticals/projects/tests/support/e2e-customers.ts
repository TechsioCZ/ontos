// @effect-diagnostics asyncFunction:off
import { Pool } from 'pg';
import type { Customer } from '../../shared/apis/customer-detail.ts';

export const projectsE2eCustomers = {
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

export const projectsE2eContacts = {
  active: {
    contactId: '71000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-02T08:30:00.000Z',
    customerId: projectsE2eCustomers.active.customerId,
    email: 'active.contact@example.test',
    name: 'E2E Active Contact',
    phone: '+420 777 100 001',
    updatedAt: '2026-08-11T09:45:00.000Z',
  },
  archived: {
    archivedAt: '2026-08-13T12:00:00.000Z',
    contactId: '71000000-0000-4000-8000-000000000002',
    createdAt: '2026-07-02T07:30:00.000Z',
    customerId: projectsE2eCustomers.archived.customerId,
    email: 'archived.contact.with.a.deliberately.long.address@example.test',
    name: 'E2E Archived Contact with a deliberately long name',
    phone: '+420 777 100 002',
    updatedAt: '2026-08-13T12:00:00.000Z',
  },
} as const;

interface ProjectsE2eCustomersFixtureOptions {
  readonly connectionString: string;
  readonly tenantIds: readonly string[];
}

export const createProjectsE2eCustomersFixture = ({
  connectionString,
  tenantIds,
}: ProjectsE2eCustomersFixtureOptions) => {
  const pool = new Pool({ connectionString });
  const cleanup = async () => {
    await pool.query('delete from projects.contacts where tenant_id = any($1::uuid[])', [
      tenantIds,
    ]);
    await pool.query('delete from projects.customers where tenant_id = any($1::uuid[])', [
      tenantIds,
    ]);
  };

  return {
    cleanup,
    close: () => pool.end(),
    seed: async (tenantId: string) => {
      await pool.query(
        `insert into projects.customers
          (tenant_id, customer_id, name, ico, dic, legal_form_code,
           established_on, dissolved_on, created_at, updated_at, archived_at)
         values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null),
          ($1, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          tenantId,
          projectsE2eCustomers.active.customerId,
          projectsE2eCustomers.active.name,
          projectsE2eCustomers.active.ico,
          projectsE2eCustomers.active.dic,
          projectsE2eCustomers.active.legalFormCode,
          projectsE2eCustomers.active.establishedOn,
          projectsE2eCustomers.active.dissolvedOn,
          projectsE2eCustomers.active.createdAt,
          projectsE2eCustomers.active.updatedAt,
          projectsE2eCustomers.archived.customerId,
          projectsE2eCustomers.archived.name,
          projectsE2eCustomers.archived.ico,
          projectsE2eCustomers.archived.dic,
          projectsE2eCustomers.archived.legalFormCode,
          projectsE2eCustomers.archived.establishedOn,
          projectsE2eCustomers.archived.dissolvedOn,
          projectsE2eCustomers.archived.createdAt,
          projectsE2eCustomers.archived.updatedAt,
          projectsE2eCustomers.archived.archivedAt,
        ],
      );
      await pool.query(
        `insert into projects.contacts
          (tenant_id, contact_id, customer_id, name, email, phone, created_at, updated_at, archived_at)
         values
          ($1, $2, $3, $4, $5, $6, $7, $8, null),
          ($1, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          tenantId,
          projectsE2eContacts.active.contactId,
          projectsE2eContacts.active.customerId,
          projectsE2eContacts.active.name,
          projectsE2eContacts.active.email,
          projectsE2eContacts.active.phone,
          projectsE2eContacts.active.createdAt,
          projectsE2eContacts.active.updatedAt,
          projectsE2eContacts.archived.contactId,
          projectsE2eContacts.archived.customerId,
          projectsE2eContacts.archived.name,
          projectsE2eContacts.archived.email,
          projectsE2eContacts.archived.phone,
          projectsE2eContacts.archived.createdAt,
          projectsE2eContacts.archived.updatedAt,
          projectsE2eContacts.archived.archivedAt,
        ],
      );
    },
  };
};
