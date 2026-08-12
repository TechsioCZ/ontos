import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import { CustomerWorkspace } from '../../src/customers/customer-workspace.tsx';
import { customerRecordToDetail } from '../../src/customers/customer-view-model.ts';
import type {
  CustomerPageModel,
  CustomerWorkspaceCopy,
} from '../../src/customers/customer-view-model.ts';

afterEach(cleanup);

const getInput = (name: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  expect(input).toBeTruthy();
  if (input === null) {
    throw new Error(`Missing input ${name}`);
  }
  return input;
};

const copy: CustomerWorkspaceCopy = {
  actions: {
    cancel: 'Cancel',
    create: 'Create customer',
    delete: 'Delete customer',
    edit: 'Edit customer',
    nextPage: 'Next page',
    retry: 'Try again',
    save: 'Save changes',
  },
  deleteDialog: {
    description: (name) => `Delete ${name}? History stays.`,
    pending: 'Deleting…',
    title: 'Confirm deletion',
  },
  detail: {
    heading: 'Customer details',
    notProvided: 'Not provided',
    selectPrompt: 'Select a customer',
  },
  fields: {
    addressLine1: 'Address line 1',
    addressLine2: 'Address line 2',
    city: 'City',
    companyRegistrationNumber: 'Company registration number',
    countryCode: 'Country code',
    email: 'Email',
    name: 'Company name',
    phone: 'Phone',
    postalCode: 'Postal code',
    region: 'Region',
    taxIdentificationNumber: 'Tax identification number',
    website: 'Website',
  },
  form: {
    createTitle: 'Create customer',
    editTitle: 'Edit customer',
    pending: 'Saving…',
    summary: 'Review fields',
  },
  issues: {
    invalid_country_code: 'Invalid country code',
    invalid_email: 'Invalid email',
    invalid_website: 'Invalid website',
    required: 'Required',
    server_validation: 'Server validation failed',
    too_long: 'Too long',
  },
  list: {
    caption: 'Customer companies',
    city: 'City',
    companyRegistrationNumber: 'Registration number',
    email: 'Email',
    name: 'Company',
    page: (page) => `Page ${page}`,
  },
  states: {
    conflict: 'Customer changed',
    empty: 'No customers',
    forbidden: 'Forbidden',
    loading: 'Loading customers',
    notFound: 'Not found',
    readOnly: 'Read only',
    unavailable: 'Unavailable',
    validation: {
      invalid_cursor: 'Invalid cursor',
      invalid_page: 'Invalid page',
      invalid_selection: 'Invalid selection',
    },
  },
  toast: { created: 'Created', deleted: 'Deleted', updated: 'Updated' },
};

const customer = customerRecordToDetail({
  address: {
    addressLine1: 'A very long street address that remains fully available to assistive technology',
    addressLine2: null,
    city: 'Prague',
    countryCode: 'CZ',
    postalCode: '110 00',
    region: null,
  },
  companyRegistrationNumber: '12345678',
  customerId: '10000000-0000-4000-8000-000000000001',
  email: 'hello@example.test',
  name: 'A very long company name that must wrap without losing any semantic content',
  phone: '+420 123 456 789',
  taxIdentificationNumber: 'CZ12345678',
  version: 3,
  website: 'https://example.test',
});

const resolved: CustomerPageModel = {
  detail: customer,
  pagination: { nextHref: '/en/customers?page=2&cursor=next', page: 1 },
  rows: [
    {
      city: 'Prague',
      companyRegistrationNumber: '12345678',
      customerId: customer.customerId,
      email: 'hello@example.test',
      href: `/en/customers?customer=${customer.customerId}`,
      name: customer.name,
      selected: true,
    },
  ],
  state: 'resolved',
};

const props = (model: CustomerPageModel = resolved) => ({
  copy,
  model,
  onCreate: rstest.fn(() => Promise.resolve({ customer: {} as never, state: 'success' as const })),
  onDelete: rstest.fn(() => Promise.resolve({ state: 'success' as const })),
  onEdit: rstest.fn(() => Promise.resolve({ customer: {} as never, state: 'success' as const })),
  onNavigate: rstest.fn(),
  onRetry: rstest.fn(),
  writable: true,
});

describe('CustomerWorkspace states', () => {
  it.each([
    [{ state: 'loading' }, 'Loading customers'],
    [{ pagination: { page: 1 }, state: 'empty' }, 'No customers'],
    [{ state: 'forbidden' }, 'Forbidden'],
    [{ state: 'not_found' }, 'Not found'],
    [
      { reason: 'invalid_cursor', resetHref: '/en/customers', state: 'validation' },
      'Invalid cursor',
    ],
    [{ retryHref: '/en/customers', state: 'unavailable' }, 'Unavailable'],
  ] as const)('renders %s explicitly', (model, message) => {
    render(<CustomerWorkspace {...props(model)} />);
    expect(screen.getByText(message)).toBeTruthy();
  });

  it('keeps active data readable but removes every write action for read-only/deprecated targets', () => {
    render(<CustomerWorkspace {...props()} writable={false} />);
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.getAllByText(customer.name).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Create customer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit customer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete customer' })).toBeNull();
  });
});

describe('CustomerWorkspace navigation and layout', () => {
  it('renders semantic desktop and narrow list structures, preserves long content, and has no search behavior', async () => {
    const viewProps = props();
    const user = userEvent.setup();
    render(<CustomerWorkspace {...viewProps} />);
    expect(screen.getByRole('table', { name: 'Customer companies' })).toBeTruthy();
    expect(screen.getByRole('list').className).toContain('crm:sm:hidden');
    expect(screen.getAllByText(customer.name).length).toBeGreaterThan(0);
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText(/search/iu)).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Next page' }));
    expect(viewProps.onNavigate).toHaveBeenCalledWith('/en/customers?page=2&cursor=next');
  });
});

describe('CustomerWorkspace forms', () => {
  it('validates inline, focuses the first invalid field, and submits all fields by keyboard once', async () => {
    const viewProps = props({ pagination: { page: 1 }, state: 'empty' });
    const user = userEvent.setup();
    render(<CustomerWorkspace {...viewProps} />);
    await user.click(screen.getByRole('button', { name: 'Create customer' }));
    const name = getInput('name');
    const form = name.closest('form');
    expect(form).toBeTruthy();
    if (form === null) {
      throw new Error('Missing customer form');
    }
    fireEvent.submit(form);
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(screen.getByText('Required')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBeTruthy();
    await user.type(name, 'New Company');
    await user.type(getInput('email'), 'new@example.test');
    await user.type(getInput('countryCode'), 'cz');
    await user.type(getInput('addressLine1'), 'Main Street 1');
    await user.type(getInput('city'), 'Prague');
    await user.type(getInput('postalCode'), '110 00');
    await user.type(getInput('website'), 'https://example.test');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(viewProps.onCreate).toHaveBeenCalledTimes(1));
    expect(viewProps.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        addressLine1: 'Main Street 1',
        city: 'Prague',
        countryCode: 'cz',
        email: 'new@example.test',
        name: 'New Company',
        postalCode: '110 00',
      }),
    );
  });

  it('preserves edited values after a stale-version conflict', async () => {
    const viewProps = props();
    viewProps.onEdit = rstest.fn(() => Promise.resolve({ state: 'conflict' as const }));
    const user = userEvent.setup();
    render(<CustomerWorkspace {...viewProps} />);
    await user.click(screen.getByRole('button', { name: 'Edit customer' }));
    const name = getInput('name');
    await user.clear(name);
    await user.type(name, 'Locally edited company');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Customer changed')).toBeTruthy();
    expect(name.value).toBe('Locally edited company');
  });

  it('preserves edited values and exposes retryable feedback when the Action is unavailable', async () => {
    const viewProps = props();
    viewProps.onEdit = rstest.fn(() => Promise.resolve({ state: 'unavailable' as const }));
    const user = userEvent.setup();
    render(<CustomerWorkspace {...viewProps} />);
    await user.click(screen.getByRole('button', { name: 'Edit customer' }));
    const name = getInput('name');
    await user.clear(name);
    await user.type(name, 'Unsaved local value');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Unavailable')).toBeTruthy();
    expect(name.value).toBe('Unsaved local value');
    expect(screen.getByRole('dialog', { name: 'Edit customer' })).toBeTruthy();
  });
});

describe('CustomerWorkspace deletion', () => {
  it('requires explicit confirmation and returns focus after cancel', async () => {
    const user = userEvent.setup();
    render(<CustomerWorkspace {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Delete customer' });
    await user.click(trigger);
    expect(screen.getByRole('alertdialog', { name: 'Confirm deletion' })).toBeTruthy();
    expect(screen.getByText(`Delete ${customer.name}? History stays.`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('maps delete failure separately and only announces success after completion', async () => {
    const deleteResult = Promise.withResolvers<{ readonly state: 'success' }>();
    const viewProps = props();
    viewProps.onDelete = rstest.fn(() => deleteResult.promise);
    const user = userEvent.setup();
    render(<CustomerWorkspace {...viewProps} />);
    await user.click(screen.getByRole('button', { name: 'Delete customer' }));
    await user.click(screen.getByRole('button', { name: 'Delete customer' }));
    await user.click(screen.getByRole('button', { name: 'Deleting…' }));
    expect(viewProps.onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Deleted')).toBeNull();
    deleteResult.resolve({ state: 'success' });
    expect(await screen.findByText('Deleted')).toBeTruthy();
  });

  it('keeps explicit deletion open when a stale-version conflict occurs', async () => {
    const viewProps = props();
    viewProps.onDelete = rstest.fn(() => Promise.resolve({ state: 'conflict' as const }));
    const user = userEvent.setup();
    render(<CustomerWorkspace {...viewProps} />);
    await user.click(screen.getByRole('button', { name: 'Delete customer' }));
    await user.click(screen.getByRole('button', { name: 'Delete customer' }));
    expect(await screen.findByText('Customer changed')).toBeTruthy();
    expect(screen.getByRole('alertdialog', { name: 'Confirm deletion' })).toBeTruthy();
  });
});
