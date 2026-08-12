import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { Effect } from 'effect';
import type { ContactView, CustomerView } from '../../../../shared/apis/customer-directory.ts';
import type { CustomerPageModel } from '../../../../src/customers/customer-view-model.ts';
import {
  contactDeleteFailure,
  contactMutationFailure,
  loadCustomerPageModel,
  parseCustomerRouteState,
} from '../../../../src/routes/[lang]/customers/page.data.ts';
import type { CustomerPageClients } from '../../../../src/routes/[lang]/customers/page.data.ts';
import { CustomersPage } from '../../../../src/routes/[lang]/customers/page.tsx';

const {
  createContactMock,
  createCustomerMock,
  deleteContactMock,
  deleteCustomerMock,
  directoryMock,
  editContactMock,
  editCustomerMock,
  navigateMock,
  useLoaderDataMock,
} = rstest.hoisted(() => ({
  createContactMock: rstest.fn(),
  createCustomerMock: rstest.fn(),
  deleteContactMock: rstest.fn(),
  deleteCustomerMock: rstest.fn(),
  directoryMock: rstest.fn(),
  editContactMock: rstest.fn(),
  editCustomerMock: rstest.fn(),
  navigateMock: rstest.fn(),
  useLoaderDataMock: rstest.fn(),
}));

const customerId = '10000000-0000-4000-8000-000000000001';
const contactId = '20000000-0000-4000-8000-000000000002';
const otherCustomerId = '30000000-0000-4000-8000-000000000003';
const customerCursor = `YWNtZQ.${customerId}`;
const contactCursor = `${btoa(JSON.stringify(['lovelace', 'ada']))
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/u, '')}.${contactId}`;

const customer: CustomerView = {
  address: null,
  companyRegistrationNumber: null,
  createdAt: '2026-08-11T00:00:00.000Z',
  customerId,
  email: null,
  name: 'Acme',
  phone: null,
  taxIdentificationNumber: null,
  updatedAt: '2026-08-11T00:00:00.000Z',
  version: 1,
  website: null,
};

const contact: ContactView = {
  contactId,
  createdAt: '2026-08-11T00:00:00.000Z',
  customerId,
  customerLabel: 'Acme',
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  firstName: 'Ada',
  isPrimaryContact: false,
  jobTitle: 'Director',
  lastName: 'Lovelace',
  phone: '+420 123 456 789',
  updatedAt: '2026-08-11T00:00:00.000Z',
  version: 3,
};

const makeDirectory = (overrides: { readonly contactDetail?: ContactView } = {}) =>
  rstest.fn<CustomerPageClients['directory']>((payload) => {
    switch (payload.operation) {
      case 'list': {
        return Effect.succeed({ items: [customer], nextCursor: customerCursor, operation: 'list' });
      }
      case 'detail': {
        return Effect.succeed({ customer, operation: 'detail' });
      }
      case 'contacts': {
        return Effect.succeed({
          customerId,
          customerLabel: customer.name,
          items: [contact],
          nextCursor: contactCursor,
          operation: 'contacts',
        });
      }
      case 'contact_detail': {
        return Effect.succeed({
          contact: overrides.contactDetail ?? contact,
          operation: 'contact_detail',
        });
      }
      default: {
        return payload satisfies never;
      }
    }
  });

test('parses bounded Contact cursor/page/selection while retaining Customer URL state', () => {
  expect(
    parseCustomerRouteState(
      new URL(
        `https://crm.example.test/en/customers?page=2&cursor=${encodeURIComponent(
          customerCursor,
        )}&customer=${customerId}&contactPage=2&contactCursor=${encodeURIComponent(
          contactCursor,
        )}&contact=${contactId}`,
      ),
    ),
  ).toEqual({
    state: 'valid',
    value: {
      contactCursor,
      contactPage: 2,
      cursor: customerCursor,
      page: 2,
      selectedContactId: contactId,
      selectedCustomerId: customerId,
    },
  });
});

test.each([
  ['contactPage=0', 'invalid_page'],
  ['contactPage=2', 'invalid_cursor'],
  ['contactCursor=bad', 'invalid_cursor'],
  ['contact=bad', 'invalid_selection'],
] as const)('keeps a valid Customer selection while mapping %s to %s', async (query, reason) => {
  const directory = makeDirectory();
  const model = await loadCustomerPageModel(
    { url: `https://crm.example.test/en/customers?customer=${customerId}&${query}` },
    { directory },
  );
  expect(model).toMatchObject({
    contacts: { customerId, reason, state: 'validation' },
    detail: { customerId },
    state: 'resolved',
  });
  expect(directory.mock.calls.some(([payload]) => payload.operation === 'contacts')).toBe(false);
});

test('loads nested pagination and direct detail only through the generated directory seam', async () => {
  const directory = makeDirectory();
  const model = await loadCustomerPageModel(
    {
      url: `https://crm.example.test/en/customers?page=2&cursor=${encodeURIComponent(
        customerCursor,
      )}&customer=${customerId}&contactPage=2&contactCursor=${encodeURIComponent(
        contactCursor,
      )}&contact=${contactId}`,
    },
    { directory },
  );
  expect(model).toMatchObject({
    contacts: {
      detail: { contactId, customerId, version: 3 },
      pagination: { page: 2 },
      rows: [{ contactId, selected: true }],
      state: 'resolved',
    },
    detail: { customerId },
    state: 'resolved',
  });
  expect(directory.mock.calls.map(([payload]) => payload.operation)).toEqual([
    'list',
    'detail',
    'contacts',
    'contact_detail',
  ]);
  const nextHref =
    model.state === 'resolved' && model.contacts?.state === 'resolved'
      ? model.contacts.pagination.nextHref
      : undefined;
  const nextUrl = new URL(nextHref ?? '', 'https://crm.example.test');
  expect(nextUrl.searchParams.get('page')).toBe('2');
  expect(nextUrl.searchParams.get('cursor')).toBe(customerCursor);
  expect(nextUrl.searchParams.get('customer')).toBe(customerId);
  expect(nextUrl.searchParams.get('contactPage')).toBe('3');
  expect(nextUrl.searchParams.get('contactCursor')).toBe(contactCursor);
  expect(nextUrl.searchParams.get('contact')).toBe(contactId);
  expect([...nextUrl.searchParams.keys()].some((key) => key.toLowerCase().includes('search'))).toBe(
    false,
  );
});

test('rejects a direct foreign Contact without losing the surrounding Customer', async () => {
  const directory = makeDirectory({
    contactDetail: { ...contact, customerId: otherCustomerId, customerLabel: 'Other' },
  });
  const model = await loadCustomerPageModel(
    { url: `https://crm.example.test/en/customers?customer=${customerId}&contact=${contactId}` },
    { directory },
  );
  expect(model).toMatchObject({
    contacts: { customerId, reason: 'foreign_selection', state: 'validation' },
    detail: { customerId },
    state: 'resolved',
  });
});

test.each([
  [{ _tag: 'CustomerDirectoryForbiddenProblem' }, 'forbidden'],
  [{ _tag: 'CustomerDirectoryNotFoundProblem' }, 'not_found'],
  [{ _tag: 'CustomerDirectoryPolicyConflictProblem' }, 'conflict'],
  [{ _tag: 'CustomerDirectoryPolicyProblem' }, 'validation'],
  [{ _tag: 'CustomerDirectoryUnavailableProblem' }, 'unavailable'],
] as const)('maps Contact read failure %s to nested %s state', async (failure, state) => {
  const directory = makeDirectory();
  directory.mockImplementation((payload) => {
    if (payload.operation === 'contacts') {
      return Effect.fail(failure);
    }
    if (payload.operation === 'list') {
      return Effect.succeed({ items: [customer], nextCursor: null, operation: 'list' });
    }
    return Effect.succeed({ customer, operation: 'detail' });
  });
  const model = await loadCustomerPageModel(
    { url: `https://crm.example.test/en/customers?customer=${customerId}` },
    { directory },
  );
  expect(model).toMatchObject({ contacts: { customerId, state }, state: 'resolved' });
  if (failure._tag === 'CustomerDirectoryPolicyProblem') {
    expect(model).toMatchObject({ contacts: { reason: 'policy' } });
  }
});

test('maps typed Contact mutation and deletion failures exhaustively', () => {
  expect(contactMutationFailure({ _tag: 'EditContactRejectedProblem', status: 422 })).toEqual({
    issues: [{ code: 'server_validation' }],
    state: 'validation',
  });
  expect(contactMutationFailure({ _tag: 'EditContactForbiddenProblem', status: 403 })).toEqual({
    state: 'forbidden',
  });
  expect(contactMutationFailure({ _tag: 'EditContactNotFoundProblem', status: 404 })).toEqual({
    state: 'not_found',
  });
  expect(contactMutationFailure({ _tag: 'EditContactConflictProblem', status: 409 })).toEqual({
    state: 'conflict',
  });
  expect(contactMutationFailure({ _tag: 'EditContactUnavailableProblem', status: 503 })).toEqual({
    state: 'unavailable',
  });
  expect(contactMutationFailure({ _tag: 'EditContactPreconditionProblem', status: 428 })).toEqual({
    state: 'unavailable',
  });
  expect(contactDeleteFailure({ _tag: 'DeleteContactValidationProblem', status: 400 })).toEqual({
    state: 'unavailable',
  });
});

const labels: Record<string, string> = {
  'crm.pages.customers.actions.create': 'Create customer',
  'crm.pages.customers.contacts.actions.cancel': 'Cancel',
  'crm.pages.customers.contacts.actions.create': 'Create contact',
  'crm.pages.customers.contacts.actions.delete': 'Delete contact',
  'crm.pages.customers.contacts.actions.edit': 'Edit contact',
  'crm.pages.customers.contacts.actions.save': 'Save contact changes',
  'crm.pages.customers.contacts.deleteDialog.pending': 'Deleting contact…',
  'crm.pages.customers.contacts.deleteDialog.title': 'Confirm contact deletion',
  'crm.pages.customers.contacts.fields.email': 'Contact email',
  'crm.pages.customers.contacts.fields.firstName': 'First name',
  'crm.pages.customers.contacts.fields.jobTitle': 'Job title',
  'crm.pages.customers.contacts.fields.lastName': 'Last name',
  'crm.pages.customers.contacts.fields.phone': 'Contact phone',
  'crm.pages.customers.contacts.form.createTitle': 'Create contact',
  'crm.pages.customers.contacts.form.editTitle': 'Edit contact',
  'crm.pages.customers.contacts.form.pending': 'Saving contact…',
  'crm.pages.customers.contacts.form.summary': 'Review contact fields',
  'crm.pages.customers.contacts.issues.nameRequired': 'Enter a Contact name',
  'crm.pages.customers.contacts.list.caption': 'Customer contacts',
  'crm.pages.customers.contacts.states.conflict': 'Contact changed',
  'crm.pages.customers.contacts.states.loading': 'Loading contacts',
  'crm.pages.customers.contacts.toast.created': 'Contact created',
  'crm.pages.customers.contacts.toast.deleted': 'Contact deleted',
  'crm.pages.customers.detail.notProvided': 'Not provided',
  'crm.pages.customers.list.caption': 'Customer companies',
  'crm.pages.customers.title': 'Customers',
};

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'crm.pages.customers.contacts.heading') {
        return `Contacts for ${options?.customerName}`;
      }
      if (key.endsWith('.page')) {
        return `Page ${options?.page}`;
      }
      if (key.endsWith('.description') && options?.contactName !== undefined) {
        return `Delete ${options.contactName}? History stays.`;
      }
      return labels[key] ?? key.split('.').at(-1) ?? key;
    },
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: useLoaderDataMock,
  useNavigate: () => navigateMock,
}));

rstest.mock('../../../../src/api/create-contact-action-client.ts', () => ({
  executeCreateContactAction: createContactMock,
}));
rstest.mock('../../../../src/api/edit-contact-action-client.ts', () => ({
  executeEditContactAction: editContactMock,
}));
rstest.mock('../../../../src/api/delete-contact-action-client.ts', () => ({
  executeDeleteContactAction: deleteContactMock,
}));
rstest.mock('../../../../src/api/create-customer-action-client.ts', () => ({
  executeCreateCustomerAction: createCustomerMock,
}));
rstest.mock('../../../../src/api/edit-customer-action-client.ts', () => ({
  executeEditCustomerAction: editCustomerMock,
}));
rstest.mock('../../../../src/api/delete-customer-action-client.ts', () => ({
  executeDeleteCustomerAction: deleteCustomerMock,
}));
rstest.mock('../../../../src/api/customer-directory-client.ts', () => ({
  executeCustomerDirectory: directoryMock,
}));
rstest.mock('../../../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const pageModel: CustomerPageModel = {
  contacts: {
    customerId,
    customerName: customer.name,
    detail: {
      contactId,
      customerId,
      email: contact.email,
      firstName: contact.firstName,
      jobTitle: contact.jobTitle,
      lastName: contact.lastName,
      phone: contact.phone,
      version: contact.version,
    },
    pagination: { page: 1 },
    rows: [
      {
        contactId,
        email: contact.email,
        firstName: contact.firstName,
        href: `/en/customers?customer=${customerId}&contact=${contactId}`,
        jobTitle: contact.jobTitle,
        lastName: contact.lastName,
        phone: contact.phone,
        selected: true,
      },
    ],
    state: 'resolved',
  },
  detail: { customerId, fields: [], name: customer.name, version: customer.version },
  pagination: { page: 1 },
  rows: [
    {
      city: null,
      companyRegistrationNumber: null,
      customerId,
      email: null,
      href: `/en/customers?customer=${customerId}`,
      name: customer.name,
      selected: true,
    },
  ],
  state: 'resolved',
};

beforeEach(() => {
  window.history.replaceState({}, '', `/en/customers?customer=${customerId}&contact=${contactId}`);
  useLoaderDataMock.mockReturnValue(pageModel);
  createContactMock.mockReturnValue(Effect.succeed(contact));
  editContactMock.mockReturnValue(Effect.succeed({ ...contact, version: 4 }));
  deleteContactMock.mockReturnValue(
    Effect.succeed({
      contactId,
      customerId,
      customerLabel: customer.name,
      deletedAt: '2026-08-11T00:00:00.000Z',
      version: 4,
    }),
  );
  createCustomerMock.mockReturnValue(Effect.succeed(customer));
  editCustomerMock.mockReturnValue(Effect.succeed(customer));
  deleteCustomerMock.mockReturnValue(Effect.succeed({ customerId, deletedAt: 'now', version: 2 }));
  directoryMock.mockImplementation((payload: { readonly operation: string }) => {
    switch (payload.operation) {
      case 'list': {
        return Effect.succeed({ items: [customer], nextCursor: null, operation: 'list' });
      }
      case 'detail': {
        return Effect.succeed({ customer, operation: 'detail' });
      }
      case 'contacts': {
        return Effect.succeed({
          customerId,
          customerLabel: customer.name,
          items: [contact],
          nextCursor: null,
          operation: 'contacts',
        });
      }
      default: {
        return Effect.succeed({ contact, operation: 'contact_detail' });
      }
    }
  });
});

afterEach(() => {
  cleanup();
  toaster.remove();
  rstest.clearAllMocks();
});

const getContactInput = (name: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  expect(input).toBeTruthy();
  if (input === null) {
    throw new Error(`Missing Contact input ${name}`);
  }
  return input;
};

test('Contact create uses the generated Action and preserves Customer selection in the URL', async () => {
  let resolveContacts: ((effect: Effect.Effect<unknown>) => void) | undefined;
  directoryMock.mockImplementation((payload: { readonly operation: string }) => {
    switch (payload.operation) {
      case 'list': {
        return Effect.succeed({ items: [customer], nextCursor: null, operation: 'list' });
      }
      case 'detail': {
        return Effect.succeed({ customer, operation: 'detail' });
      }
      case 'contacts': {
        return Effect.callback((resume) => {
          resolveContacts = resume;
        });
      }
      default: {
        return Effect.succeed({ contact, operation: 'contact_detail' });
      }
    }
  });
  const user = userEvent.setup();
  render(<CustomersPage target={{ writable: true }} />);
  const trigger = screen.getByRole('button', { name: 'Create contact' });
  await user.click(trigger);
  await user.type(getContactInput('firstName'), 'Grace');
  await user.type(getContactInput('email'), 'grace@example.test');
  await user.click(screen.getByRole('button', { name: 'Create contact' }));
  await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(1));
  expect(createContactMock.mock.calls[0]?.[0]).toEqual({
    customerId,
    email: 'grace@example.test',
    firstName: 'Grace',
  });
  const navigated = navigateMock.mock.calls[0]?.[0].to as string;
  const url = new URL(navigated, 'https://crm.example.test');
  expect(url.searchParams.get('customer')).toBe(customerId);
  expect(url.searchParams.get('contact')).toBe(contactId);
  expect(await screen.findByText('Contact created')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await waitFor(() =>
    expect(directoryMock.mock.calls.some(([payload]) => payload.operation === 'contacts')).toBe(
      true,
    ),
  );
  expect(screen.getAllByText(customer.name).length).toBeGreaterThan(0);
  expect(screen.getByText('Contacts for Acme')).toBeTruthy();
  resolveContacts?.(
    Effect.succeed({
      customerId,
      customerLabel: customer.name,
      items: [{ ...contact, displayName: 'Grace Lovelace', firstName: 'Grace' }],
      nextCursor: null,
      operation: 'contacts',
    }),
  );
  expect(await screen.findAllByText('Grace Lovelace')).not.toHaveLength(0);
});

test('Contact navigation keeps Customer context visible while only Contacts are loading', async () => {
  let resolveContacts: ((effect: Effect.Effect<unknown>) => void) | undefined;
  directoryMock.mockImplementation((payload: { readonly operation: string }) => {
    switch (payload.operation) {
      case 'list': {
        return Effect.succeed({ items: [customer], nextCursor: null, operation: 'list' });
      }
      case 'detail': {
        return Effect.succeed({ customer, operation: 'detail' });
      }
      case 'contacts': {
        return Effect.callback((resume) => {
          resolveContacts = resume;
        });
      }
      default: {
        return Effect.succeed({ contact, operation: 'contact_detail' });
      }
    }
  });
  const user = userEvent.setup();
  render(<CustomersPage target={{ writable: true }} />);
  await user.click(screen.getAllByRole('link', { name: 'Ada Lovelace' })[0] as HTMLElement);
  expect(await screen.findByText('Loading contacts')).toBeTruthy();
  expect(screen.getAllByText(customer.name).length).toBeGreaterThan(0);
  expect(screen.getByText('Contacts for Acme')).toBeTruthy();

  resolveContacts?.(
    Effect.succeed({
      customerId,
      customerLabel: customer.name,
      items: [contact],
      nextCursor: null,
      operation: 'contacts',
    }),
  );
  await waitFor(() => expect(screen.queryByText('Loading contacts')).toBeNull());
});

test('Contact edit sends only agreed fields plus selected id/version and preserves values on conflict', async () => {
  editContactMock.mockReturnValue(Effect.fail({ _tag: 'EditContactConflictProblem', status: 409 }));
  const user = userEvent.setup();
  render(<CustomersPage target={{ writable: true }} />);
  await user.click(screen.getByRole('button', { name: 'Edit contact' }));
  const firstName = getContactInput('firstName');
  await user.clear(firstName);
  await user.type(firstName, 'Locally edited');
  await user.click(screen.getByRole('button', { name: 'Save contact changes' }));
  expect(await screen.findByText('Contact changed')).toBeTruthy();
  expect(firstName.value).toBe('Locally edited');
  expect(editContactMock.mock.calls[0]?.[0]).toEqual({
    contactId,
    email: contact.email,
    expectedVersion: contact.version,
    firstName: 'Locally edited',
    jobTitle: contact.jobTitle,
    lastName: contact.lastName,
    phone: contact.phone,
  });
  expect(editContactMock.mock.calls[0]?.[0]).not.toHaveProperty('customerId');
  expect(editContactMock.mock.calls[0]?.[0]).not.toHaveProperty('isPrimaryContact');
});

test('Contact delete invokes only the generated soft-delete Action and keeps Customer context', async () => {
  const user = userEvent.setup();
  render(<CustomersPage target={{ writable: true }} />);
  await user.click(screen.getByRole('button', { name: 'Delete contact' }));
  await user.click(screen.getByRole('button', { name: 'Delete contact' }));
  await waitFor(() => expect(deleteContactMock).toHaveBeenCalledTimes(1));
  expect(deleteContactMock.mock.calls[0]?.[0]).toEqual({
    contactId,
    expectedVersion: contact.version,
  });
  const navigated = navigateMock.mock.calls[0]?.[0].to as string;
  const url = new URL(navigated, 'https://crm.example.test');
  expect(url.searchParams.get('customer')).toBe(customerId);
  expect(url.searchParams.has('contact')).toBe(false);
});
