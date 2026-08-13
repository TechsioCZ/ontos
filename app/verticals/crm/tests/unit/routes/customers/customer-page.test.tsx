import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { Effect } from 'effect';
import type { ReactNode } from 'react';
import { PageCustomers } from '../../../../src/federation-entry.tsx';
import { CustomersPage } from '../../../../src/routes/[lang]/customers/page.tsx';
import type { CustomerPageModel } from '../../../../src/customers/customer-view-model.ts';

const {
  createMock,
  deleteMock,
  directoryMock,
  editMock,
  federatedI18nState,
  navigateMock,
  useLoaderDataMock,
} = rstest.hoisted(() => ({
  createMock: rstest.fn(),
  deleteMock: rstest.fn(),
  directoryMock: rstest.fn(),
  editMock: rstest.fn(),
  federatedI18nState: {
    resources: undefined as Record<string, Record<string, Record<string, string>>> | undefined,
    shellOnly: false,
  },
  navigateMock: rstest.fn(),
  useLoaderDataMock: rstest.fn(),
}));

const labels: Record<string, string> = {
  'crm.navigation.customers': 'Customers',
  'crm.navigation.deals': 'Deals',
  'crm.navigation.label': 'CRM sections',
  'crm.pages.customers.actions.cancel': 'Cancel',
  'crm.pages.customers.actions.create': 'Create customer',
  'crm.pages.customers.actions.delete': 'Delete customer',
  'crm.pages.customers.actions.edit': 'Edit customer',
  'crm.pages.customers.actions.nextPage': 'Next page',
  'crm.pages.customers.actions.retry': 'Try again',
  'crm.pages.customers.actions.save': 'Save changes',
  'crm.pages.customers.deleteDialog.pending': 'Deleting…',
  'crm.pages.customers.deleteDialog.title': 'Confirm deletion',
  'crm.pages.customers.description': 'Customer directory',
  'crm.pages.customers.detail.heading': 'Customer details',
  'crm.pages.customers.detail.notProvided': 'Not provided',
  'crm.pages.customers.fields.name': 'Company name',
  'crm.pages.customers.form.createTitle': 'Create customer',
  'crm.pages.customers.form.editTitle': 'Edit customer',
  'crm.pages.customers.form.pending': 'Saving…',
  'crm.pages.customers.form.summary': 'Review fields',
  'crm.pages.customers.issues.required': 'Required',
  'crm.pages.customers.list.caption': 'Customer companies',
  'crm.pages.customers.list.name': 'Company',
  'crm.pages.customers.states.conflict': 'Customer changed',
  'crm.pages.customers.states.empty': 'No customers',
  'crm.pages.customers.states.loading': 'Loading customers',
  'crm.pages.customers.states.notFound': 'Not found',
  'crm.pages.customers.states.validation.invalidPage': 'Invalid customer page',
  'crm.pages.customers.title': 'Customers',
  'crm.pages.customers.toast.created': 'Created',
};

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({
    children,
    resources,
  }: {
    readonly children: ReactNode;
    readonly resources: Record<string, Record<string, Record<string, string>>>;
  }) => {
    federatedI18nState.resources = resources;
    return children;
  },
  useModernI18n: () => ({
    language: federatedI18nState.shellOnly ? 'cs' : 'en',
    t: (key: string, options?: Record<string, unknown>) => {
      if (federatedI18nState.shellOnly) {
        return federatedI18nState.resources?.cs?.crm?.[key] ?? key;
      }
      return key === 'crm.pages.customers.list.page'
        ? `Page ${options?.page}`
        : (labels[key] ?? key.split('.').at(-1) ?? key);
    },
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: useLoaderDataMock,
  useNavigate: () => navigateMock,
}));

rstest.mock('../../../../src/api/create-customer-action-client.ts', () => ({
  executeCreateCustomerAction: createMock,
}));

rstest.mock('../../../../src/api/edit-customer-action-client.ts', () => ({
  executeEditCustomerAction: editMock,
}));

rstest.mock('../../../../src/api/delete-customer-action-client.ts', () => ({
  executeDeleteCustomerAction: deleteMock,
}));

rstest.mock('../../../../src/api/customer-directory-client.ts', () => ({
  executeCustomerDirectory: directoryMock,
}));

rstest.mock('../../../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const customerView = {
  address: null,
  companyRegistrationNumber: null,
  createdAt: '2026-08-11T00:00:00.000Z',
  customerId: '10000000-0000-4000-8000-000000000001',
  email: null,
  name: 'Acme',
  phone: null,
  taxIdentificationNumber: null,
  updatedAt: '2026-08-11T00:00:00.000Z',
  version: 1,
  website: null,
} as const;

const model: CustomerPageModel = {
  detail: {
    customerId: customerView.customerId,
    fields: [],
    name: customerView.name,
    version: customerView.version,
  },
  pagination: { page: 1 },
  rows: [
    {
      city: null,
      companyRegistrationNumber: null,
      customerId: customerView.customerId,
      email: null,
      href: `/en/customers?customer=${customerView.customerId}`,
      name: customerView.name,
      selected: true,
    },
  ],
  state: 'resolved',
};

const getNameInput = () => {
  const input = document.querySelector<HTMLInputElement>('input[name="name"]');
  expect(input).toBeTruthy();
  if (input === null) {
    throw new Error('Missing customer name input');
  }
  return input;
};

beforeEach(() => {
  federatedI18nState.resources = undefined;
  federatedI18nState.shellOnly = false;
  useLoaderDataMock.mockReturnValue(model);
  createMock.mockReturnValue(Effect.succeed(customerView));
  editMock.mockReturnValue(Effect.succeed({ ...customerView, version: 2 }));
  deleteMock.mockReturnValue(
    Effect.succeed({ customerId: customerView.customerId, deletedAt: '2026-08-11', version: 2 }),
  );
  directoryMock.mockImplementation((request: { readonly operation: string }) =>
    Effect.succeed(
      request.operation === 'detail'
        ? { customer: customerView, operation: 'detail' as const }
        : { items: [customerView], nextCursor: null, operation: 'list' as const },
    ),
  );
});

afterEach(() => {
  cleanup();
  toaster.remove();
  rstest.clearAllMocks();
});

test('create submits through the generated Action client and keeps the returned selection in the URL', async () => {
  const user = userEvent.setup();
  render(<CustomersPage target={{ writable: true }} />);
  await user.click(screen.getByRole('button', { name: 'Create customer' }));
  await user.type(getNameInput(), 'New Acme');
  await user.click(screen.getByRole('button', { name: 'Create customer' }));
  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  expect(createMock.mock.calls[0]?.[0]).toEqual({ name: 'New Acme' });
  expect(navigateMock.mock.calls[0]?.[0].to).toContain(`customer=${customerView.customerId}`);
});

test('links the embedded CRM page to both CRM sections without adding search', () => {
  render(<CustomersPage target={{ writable: true }} />);
  expect(screen.getByRole('navigation', { name: 'CRM sections' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Customers' }).getAttribute('href')).toBe(
    '?page=crm.core.page.customers',
  );
  expect(screen.getByRole('link', { name: 'Deals' }).getAttribute('href')).toBe(
    '?page=crm.core.page.deals',
  );
  expect(screen.queryByRole('search')).toBeNull();
});

test('renders Czech CRM copy from the federated page entry hosted by the Shell runtime', () => {
  federatedI18nState.shellOnly = true;
  useLoaderDataMock.mockReturnValue({ retryHref: '/cs/crm', state: 'unavailable' });

  render(<PageCustomers target={{ writable: true }} />);

  expect(screen.getByRole('heading', { name: 'Zákazníci' })).toBeTruthy();
  expect(
    screen.getByText(
      'Data zákazníků jsou dočasně nedostupná. Hodnoty formuláře zůstaly zachovány.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Zkusit znovu' })).toBeTruthy();
  expect(screen.queryByText('crm.pages.customers.title')).toBeNull();
});

test('ignores the Shell resolved loader model when rendered as an embedded page', async () => {
  useLoaderDataMock.mockReturnValue({
    shell: { state: 'authenticated' },
    state: 'resolved',
    target: { moduleId: 'crm.core' },
  });

  render(<CustomersPage target={{ writable: true }} />);

  expect(screen.getByText('Loading customers')).toBeTruthy();
  await waitFor(() => expect(directoryMock).toHaveBeenCalledTimes(1));
  expect(await screen.findAllByText('Acme')).not.toHaveLength(0);
});

test('hydrates through a stable loading state before showing URL validation', async () => {
  useLoaderDataMock.mockReturnValue({
    reason: 'invalid_page',
    resetHref: '/en/customers',
    state: 'validation',
  });

  render(<CustomersPage target={{ writable: true }} />);

  expect(await screen.findByText('Invalid customer page')).toBeTruthy();
  expect(directoryMock).not.toHaveBeenCalled();
});

test('edit sends the selected id/version and preserves the dialog on typed conflict', async () => {
  editMock.mockReturnValue(Effect.fail({ _tag: 'EditCustomerConflictProblem', status: 409 }));
  const user = userEvent.setup();
  render(<CustomersPage target={{ writable: true }} />);
  await user.click(screen.getByRole('button', { name: 'Edit customer' }));
  const name = getNameInput();
  await user.clear(name);
  await user.type(name, 'Edited locally');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Customer changed')).toBeTruthy();
  expect(name.value).toBe('Edited locally');
  expect(editMock.mock.calls[0]?.[0]).toMatchObject({
    customerId: customerView.customerId,
    expectedVersion: 1,
    name: 'Edited locally',
  });
});

test('delete calls only the generated delete Action with explicit current version', async () => {
  const user = userEvent.setup();
  render(<CustomersPage target={{ writable: true }} />);
  await user.click(screen.getByRole('button', { name: 'Delete customer' }));
  await user.click(screen.getByRole('button', { name: 'Delete customer' }));
  await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
  expect(deleteMock.mock.calls[0]?.[0]).toEqual({
    customerId: customerView.customerId,
    expectedVersion: 1,
  });
});
