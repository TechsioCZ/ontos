// @effect-diagnostics asyncFunction:off
import { Pool } from 'pg';
import type { Customer } from '../../shared/apis/customer-detail.ts';

export const contactsE2eCustomers = {
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

export const contactsE2eContacts = {
  active: {
    contactId: '71000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-02T08:30:00.000Z',
    customerId: contactsE2eCustomers.active.customerId,
    email: 'active.contact@example.test',
    name: 'E2E Active Contact',
    phone: '+420 777 100 001',
    updatedAt: '2026-08-11T09:45:00.000Z',
  },
  archived: {
    archivedAt: '2026-08-13T12:00:00.000Z',
    contactId: '71000000-0000-4000-8000-000000000002',
    createdAt: '2026-07-02T07:30:00.000Z',
    customerId: contactsE2eCustomers.archived.customerId,
    email: 'archived.contact.with.a.deliberately.long.address@example.test',
    name: 'E2E Archived Contact with a deliberately long name',
    phone: '+420 777 100 002',
    updatedAt: '2026-08-13T12:00:00.000Z',
  },
} as const;

interface ContactsE2eCustomersFixtureOptions {
  readonly connectionString: string;
  readonly tenantIds: readonly string[];
}

export const createContactsE2eCustomersFixture = ({
  connectionString,
  tenantIds,
}: ContactsE2eCustomersFixtureOptions) => {
  const pool = new Pool({ connectionString });
  const cleanup = async () => {
    await pool.query('delete from contacts.contacts where tenant_id = any($1::uuid[])', [
      tenantIds,
    ]);
    await pool.query('delete from contacts.customers where tenant_id = any($1::uuid[])', [
      tenantIds,
    ]);
  };

  return {
    cleanup,
    close: () => pool.end(),
    seed: async (tenantId: string) => {
      await pool.query(
        `insert into contacts.customers
          (tenant_id, customer_id, name, ico, dic, legal_form_code,
           established_on, dissolved_on, created_at, updated_at, archived_at)
         values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null),
          ($1, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          tenantId,
          contactsE2eCustomers.active.customerId,
          contactsE2eCustomers.active.name,
          contactsE2eCustomers.active.ico,
          contactsE2eCustomers.active.dic,
          contactsE2eCustomers.active.legalFormCode,
          contactsE2eCustomers.active.establishedOn,
          contactsE2eCustomers.active.dissolvedOn,
          contactsE2eCustomers.active.createdAt,
          contactsE2eCustomers.active.updatedAt,
          contactsE2eCustomers.archived.customerId,
          contactsE2eCustomers.archived.name,
          contactsE2eCustomers.archived.ico,
          contactsE2eCustomers.archived.dic,
          contactsE2eCustomers.archived.legalFormCode,
          contactsE2eCustomers.archived.establishedOn,
          contactsE2eCustomers.archived.dissolvedOn,
          contactsE2eCustomers.archived.createdAt,
          contactsE2eCustomers.archived.updatedAt,
          contactsE2eCustomers.archived.archivedAt,
        ],
      );
      await pool.query(
        `insert into contacts.contacts
          (tenant_id, contact_id, customer_id, name, email, phone, created_at, updated_at, archived_at)
         values
          ($1, $2, $3, $4, $5, $6, $7, $8, null),
          ($1, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          tenantId,
          contactsE2eContacts.active.contactId,
          contactsE2eContacts.active.customerId,
          contactsE2eContacts.active.name,
          contactsE2eContacts.active.email,
          contactsE2eContacts.active.phone,
          contactsE2eContacts.active.createdAt,
          contactsE2eContacts.active.updatedAt,
          contactsE2eContacts.archived.contactId,
          contactsE2eContacts.archived.customerId,
          contactsE2eContacts.archived.name,
          contactsE2eContacts.archived.email,
          contactsE2eContacts.archived.phone,
          contactsE2eContacts.archived.createdAt,
          contactsE2eContacts.archived.updatedAt,
          contactsE2eContacts.archived.archivedAt,
        ],
      );
    },
  };
};
