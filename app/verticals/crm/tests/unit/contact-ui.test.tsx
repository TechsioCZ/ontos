import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import { Toaster, toaster } from '@techsio/ui-kit/molecules/toast';
import { ContactPanel } from '../../src/contacts/contact-panel.tsx';
import type {
  ContactPanelCopy,
  ContactPanelModel,
  ContactPanelProps,
} from '../../src/contacts/contact-view-model.ts';

afterEach(() => {
  toaster.dismiss();
  cleanup();
});

const customerId = '10000000-0000-4000-8000-000000000001';
const contactId = '20000000-0000-4000-8000-000000000002';

const copy: ContactPanelCopy = {
  actions: {
    cancel: 'Cancel',
    create: 'Create contact',
    delete: 'Delete contact',
    edit: 'Edit contact',
    nextPage: 'Next contact page',
    retry: 'Try again',
    save: 'Save changes',
  },
  deleteDialog: {
    description: (name) => `Delete ${name}? History stays.`,
    pending: 'Deleting…',
    title: 'Confirm contact deletion',
  },
  detail: {
    heading: 'Contact details',
    notProvided: 'Not provided',
    selectPrompt: 'Select a contact',
  },
  fields: {
    email: 'Email',
    firstName: 'First name',
    jobTitle: 'Job title',
    lastName: 'Last name',
    phone: 'Phone',
  },
  form: {
    createTitle: 'Create contact',
    editTitle: 'Edit contact',
    pending: 'Saving…',
    summary: 'Review contact fields',
  },
  heading: (customerName) => `Contacts for ${customerName}`,
  issues: {
    invalid_email: 'Invalid email',
    name_required: 'Enter a name',
    server_validation: 'Server validation failed',
    too_long: 'Too long',
  },
  list: {
    caption: 'Customer contacts',
    email: 'Email',
    jobTitle: 'Job title',
    name: 'Contact',
    page: (page) => `Contact page ${page}`,
    phone: 'Phone',
  },
  nameFallback: 'Unnamed contact',
  states: {
    conflict: 'Contact changed',
    empty: 'No contacts',
    forbidden: 'Contact access forbidden',
    loading: 'Loading contacts',
    notFound: 'Contact not found',
    readOnly: 'Contacts are read only',
    unavailable: 'Contacts unavailable',
    validation: {
      foreign_selection: 'Foreign contact',
      invalid_cursor: 'Invalid contact cursor',
      invalid_page: 'Invalid contact page',
      invalid_selection: 'Invalid contact selection',
      policy: 'Contact policy prevents this request',
    },
  },
  toast: { created: 'Contact created', deleted: 'Contact deleted', updated: 'Contact updated' },
};

const detail = {
  contactId,
  customerId,
  email: 'long.contact@example.test',
  firstName: 'A very long first name that must wrap without losing semantic content',
  jobTitle: 'A very long job title that remains fully available in narrow layouts',
  lastName: 'A very long last name that also remains complete',
  phone: '+420 123 456 789',
  version: 4,
};

const resolved: ContactPanelModel = {
  customerId,
  customerName: 'Acme',
  detail,
  pagination: { nextHref: `/en/customers?customer=${customerId}&contactPage=2`, page: 1 },
  rows: [
    {
      contactId,
      email: detail.email,
      firstName: detail.firstName,
      href: `/en/customers?customer=${customerId}&contact=${contactId}`,
      jobTitle: detail.jobTitle,
      lastName: detail.lastName,
      phone: detail.phone,
      selected: true,
    },
    {
      contactId: '30000000-0000-4000-8000-000000000003',
      email: null,
      firstName: null,
      href: `/en/customers?customer=${customerId}&contact=30000000-0000-4000-8000-000000000003`,
      jobTitle: null,
      lastName: 'OnlyLast',
      phone: null,
      selected: false,
    },
  ],
  state: 'resolved',
};

const makeProps = (model: ContactPanelModel = resolved): ContactPanelProps => ({
  copy,
  model,
  onCreate: rstest.fn(() => Promise.resolve({ contact: detail, state: 'success' as const })),
  onDelete: rstest.fn(() => Promise.resolve({ state: 'success' as const })),
  onEdit: rstest.fn(() => Promise.resolve({ contact: detail, state: 'success' as const })),
  onMutationSuccess: rstest.fn(),
  onNavigate: rstest.fn(),
  onRetry: rstest.fn(),
  writable: true,
});

const renderPanel = (props: ContactPanelProps) =>
  render(
    <>
      <Toaster />
      <ContactPanel {...props} />
    </>,
  );

const getInput = (name: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  expect(input).toBeTruthy();
  if (input === null) {
    throw new Error(`Missing input ${name}`);
  }
  return input;
};

describe('ContactPanel states', () => {
  it.each([
    [{ customerId, customerName: 'Acme', state: 'loading' }, 'Loading contacts'],
    [{ customerId, customerName: 'Acme', pagination: { page: 1 }, state: 'empty' }, 'No contacts'],
    [{ customerId, customerName: 'Acme', state: 'forbidden' }, 'Contact access forbidden'],
    [{ customerId, customerName: 'Acme', state: 'not_found' }, 'Contact not found'],
    [
      {
        customerId,
        customerName: 'Acme',
        reason: 'foreign_selection',
        resetHref: `/en/customers?customer=${customerId}`,
        state: 'validation',
      },
      'Foreign contact',
    ],
    [
      {
        customerId,
        customerName: 'Acme',
        retryHref: `/en/customers?customer=${customerId}`,
        state: 'conflict',
      },
      'Contact changed',
    ],
    [
      {
        customerId,
        customerName: 'Acme',
        retryHref: `/en/customers?customer=${customerId}`,
        state: 'unavailable',
      },
      'Contacts unavailable',
    ],
  ] as const)('renders %s explicitly', (model, message) => {
    renderPanel(makeProps(model));
    expect(screen.getByText(message)).toBeTruthy();
  });

  it('keeps data readable while removing every write action for read-only/deprecated modules', () => {
    renderPanel({ ...makeProps(), writable: false });
    expect(screen.getByText('Contacts are read only')).toBeTruthy();
    expect(screen.getAllByText('OnlyLast').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Create contact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit contact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete contact' })).toBeNull();
  });
});

describe('ContactPanel navigation and responsive semantics', () => {
  it('renders semantic desktop and stacked narrow lists, complete partial/long names, and no search', async () => {
    const props = makeProps();
    const user = userEvent.setup();
    renderPanel(props);
    expect(screen.getByRole('table', { name: 'Customer contacts' })).toBeTruthy();
    expect(screen.getByRole('list').className).toContain('crm:sm:hidden');
    expect(screen.getAllByText('OnlyLast').length).toBeGreaterThan(0);
    expect(screen.getAllByText(`${detail.firstName} ${detail.lastName}`).length).toBeGreaterThan(0);
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Next contact page' }));
    expect(props.onNavigate).toHaveBeenCalledWith(
      `/en/customers?customer=${customerId}&contactPage=2`,
    );
  });
});

describe('ContactPanel forms', () => {
  it('focuses the first invalid name field and exposes only the agreed Contact fields', async () => {
    const props = makeProps({
      customerId,
      customerName: 'Acme',
      pagination: { page: 1 },
      state: 'empty',
    });
    const user = userEvent.setup();
    renderPanel(props);
    await user.click(screen.getByRole('button', { name: 'Create contact' }));
    const firstName = getInput('firstName');
    const form = firstName.closest('form');
    expect(form).toBeTruthy();
    if (form === null) {
      throw new Error('Missing Contact form');
    }
    fireEvent.submit(form);
    await waitFor(() => expect(document.activeElement).toBe(firstName));
    expect(screen.getByText('Enter a name')).toBeTruthy();
    expect(getInput('lastName')).toBeTruthy();
    expect(getInput('email')).toBeTruthy();
    expect(getInput('phone')).toBeTruthy();
    expect(getInput('jobTitle')).toBeTruthy();
    expect(document.querySelector('input[name="customerId"]')).toBeNull();
    expect(document.querySelector('input[name="isPrimaryContact"]')).toBeNull();
    expect(document.querySelector('input[name="delete"]')).toBeNull();
  });

  it('prevents duplicate submission and distinguishes pending from completed success', async () => {
    const pending = Promise.withResolvers<{
      readonly contact: typeof detail;
      readonly state: 'success';
    }>();
    const props = {
      ...makeProps({
        customerId,
        customerName: 'Acme',
        pagination: { page: 1 },
        state: 'empty',
      }),
      onCreate: rstest.fn(() => pending.promise),
    };
    const user = userEvent.setup();
    renderPanel(props);
    const trigger = screen.getByRole('button', { name: 'Create contact' });
    await user.click(trigger);
    await user.type(getInput('firstName'), 'Ada');
    const form = getInput('firstName').closest('form');
    if (form === null) {
      throw new Error('Missing Contact form');
    }
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy();
    expect(screen.queryByText('Contact created')).toBeNull();
    pending.resolve({ contact: detail, state: 'success' });
    expect(await screen.findByText('Contact created')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('preserves edited values after conflict and unavailable failures', async () => {
    const props = {
      ...makeProps(),
      onEdit: rstest
        .fn()
        .mockResolvedValueOnce({ state: 'conflict' as const })
        .mockResolvedValueOnce({ state: 'unavailable' as const }),
    };
    const user = userEvent.setup();
    renderPanel(props);
    await user.click(screen.getByRole('button', { name: 'Edit contact' }));
    const firstName = getInput('firstName');
    await user.clear(firstName);
    await user.type(firstName, 'Unsaved Ada');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Contact changed')).toBeTruthy();
    expect(firstName.value).toBe('Unsaved Ada');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Contacts unavailable')).toBeTruthy();
    expect(firstName.value).toBe('Unsaved Ada');
  });
});

describe('ContactPanel deletion', () => {
  it('requires named soft-delete confirmation and returns focus after cancel', async () => {
    const user = userEvent.setup();
    renderPanel(makeProps());
    const trigger = screen.getByRole('button', { name: 'Delete contact' });
    await user.click(trigger);
    expect(screen.getByRole('alertdialog', { name: 'Confirm contact deletion' })).toBeTruthy();
    expect(
      screen.getByText(`Delete ${detail.firstName} ${detail.lastName}? History stays.`),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('keeps confirmation open for stale conflict and announces success only after completion', async () => {
    const props = {
      ...makeProps(),
      onDelete: rstest
        .fn()
        .mockResolvedValueOnce({ state: 'conflict' as const })
        .mockResolvedValueOnce({ state: 'success' as const }),
    };
    const user = userEvent.setup();
    renderPanel(props);
    const trigger = screen.getByRole('button', { name: 'Delete contact' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Delete contact' }));
    expect(await screen.findByText('Contact changed')).toBeTruthy();
    expect(screen.getByRole('alertdialog', { name: 'Confirm contact deletion' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete contact' }));
    expect(await screen.findByText('Contact deleted')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
