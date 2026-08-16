// @effect-diagnostics asyncFunction:off newPromise:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { ContactForm } from '../../src/features/contacts/contact-form.tsx';

const copy = {
  cancel: 'Cancel',
  emailInvalid: 'Enter a valid email address.',
  emailLabel: 'Email',
  emailRequired: 'Enter an email address.',
  nameInvalid: 'Enter a name with at most 200 characters.',
  nameLabel: 'Contact name',
  nameRequired: 'Enter a Contact name.',
  phoneCountryLabel: 'Choose phone country',
  phoneInvalid: 'Enter a phone number with at most 100 characters.',
  phoneLabel: 'Phone',
  phonePlaceholder: 'Phone number',
  phoneRequired: 'Enter a phone number.',
  submit: 'Create Contact',
  submitting: 'Creating Contact…',
} as const;

const readyValues = {
  email: 'ada@example.test',
  name: 'Ada Lovelace',
  phone: '123 456 789',
} as const;

const formProps = (
  overrides: Partial<ComponentProps<typeof ContactForm>> = {},
): ComponentProps<typeof ContactForm> => ({
  copy,
  initialValues: readyValues,
  onCancel: rstest.fn(),
  onSubmit: rstest.fn(),
  ...overrides,
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('renders empty create values and populated future-edit values', () => {
  const { unmount } = render(
    <ContactForm {...formProps({ initialValues: { email: '', name: '', phone: '' } })} />,
  );
  expect(screen.getByRole('textbox', { name: /^Contact name/u }).getAttribute('value')).toBe('');
  expect(screen.getByRole('textbox', { name: /^Email/u }).getAttribute('value')).toBe('');
  expect(screen.getByRole('textbox', { name: /^Phone/u }).getAttribute('value')).toBe('');

  unmount();
  render(<ContactForm {...formProps()} />);
  expect(screen.getByRole('textbox', { name: /^Contact name/u }).getAttribute('value')).toBe(
    'Ada Lovelace',
  );
  expect(screen.getByRole('textbox', { name: /^Email/u }).getAttribute('value')).toBe(
    'ada@example.test',
  );
  expect(screen.getByRole('textbox', { name: /^Phone/u }).getAttribute('value')).toBe('123456789');
});

test('emits field changes without submitting and preserves the compound phone control', async () => {
  const onValuesChange = rstest.fn();
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  render(<ContactForm {...formProps({ onSubmit, onValuesChange })} />);

  const name = screen.getByRole('textbox', { name: /^Contact name/u });
  await user.clear(name);
  await user.type(name, 'Grace Hopper');
  const email = screen.getByRole('textbox', { name: /^Email/u });
  await user.clear(email);
  await user.type(email, 'grace@example.test');
  const phone = screen.getByRole('textbox', { name: /^Phone/u });
  await user.clear(phone);
  await user.type(phone, '987654321');

  expect(onValuesChange).toHaveBeenLastCalledWith({
    email: 'grace@example.test',
    name: 'Grace Hopper',
    phone: expect.any(String),
  });
  expect(screen.getByRole('combobox', { name: 'Choose phone country' })).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('trims all values and submits one semantic intent from the keyboard', async () => {
  const onSubmit = rstest.fn(() => Promise.resolve());
  const user = userEvent.setup();
  render(
    <ContactForm
      {...formProps({
        initialValues: {
          email: '  ada@example.test  ',
          name: '  Ada Lovelace  ',
          phone: '  123 456 789  ',
        },
        onSubmit,
      })}
    />,
  );

  screen.getByRole('textbox', { name: /^Email/u }).focus();
  await user.keyboard('{Enter}');

  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith({
    email: 'ada@example.test',
    name: 'Ada Lovelace',
    phone: '123 456 789',
  });
});

test.each([
  [{ email: readyValues.email, name: '   ', phone: readyValues.phone }, 'Contact name'],
  [{ email: '', name: readyValues.name, phone: readyValues.phone }, 'Email'],
  [{ email: readyValues.email, name: readyValues.name, phone: '' }, 'Phone'],
] as const)(
  'validates required fields and focuses %s in deterministic order',
  async (values, field) => {
    const onSubmit = rstest.fn();
    const user = userEvent.setup();
    render(<ContactForm {...formProps({ initialValues: values, onSubmit })} />);

    await user.click(screen.getByRole('button', { name: 'Create Contact' }));

    const input = screen.getByRole('textbox', { name: new RegExp(`^${field}`, 'u') });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-errormessage')).toMatch(
      /^contact-(?:name|email|phone)-error$/u,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

test.each([
  [{ ...readyValues, name: 'n'.repeat(201) }, copy.nameInvalid, 'Contact name'],
  [{ ...readyValues, email: 'invalid' }, copy.emailInvalid, 'Email'],
  [{ ...readyValues, email: `${'a'.repeat(309)}@example.test` }, copy.emailInvalid, 'Email'],
  [{ ...readyValues, phone: '1'.repeat(101) }, copy.phoneInvalid, 'Phone'],
] as const)('enforces the current Action field contract', async (values, message, field) => {
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  render(<ContactForm {...formProps({ initialValues: values, onSubmit })} />);

  await user.click(screen.getByRole('button', { name: 'Create Contact' }));

  expect(screen.getByText(message)).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole('textbox', { name: new RegExp(`^${field}`, 'u') }),
  );
  expect(onSubmit).not.toHaveBeenCalled();
});

test('accepts non-E.164 phone text because native phone validation remains disabled', async () => {
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  render(
    <ContactForm
      {...formProps({ initialValues: { ...readyValues, phone: 'extension 42' }, onSubmit })}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Create Contact' }));

  expect(onSubmit).toHaveBeenCalledWith({ ...readyValues, phone: 'extension 42' });
});

test('suppresses duplicate submits until the presentation callback settles, then releases', async () => {
  let settle!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- A controlled deferred promise keeps the form submission unsettled for this interaction test.
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onSubmit = rstest.fn(() => pending);
  const user = userEvent.setup();
  render(<ContactForm {...formProps({ onSubmit })} />);

  const submit = screen.getByRole('button', { name: 'Create Contact' });
  await user.dblClick(submit);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  settle();
  await pending;
  await user.click(submit);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
});

test('disables every control while pending or read-only and keeps Cancel mutation-free', async () => {
  const onCancel = rstest.fn();
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  const { rerender } = render(<ContactForm {...formProps({ onCancel, onSubmit })} />);

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();

  rerender(<ContactForm {...formProps({ onCancel, onSubmit, pending: true })} />);
  expect(screen.getByRole('textbox', { name: /^Contact name/u }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('textbox', { name: /^Email/u }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('textbox', { name: /^Phone/u }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Creating Contact…' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);

  rerender(<ContactForm {...formProps({ disabled: true, onCancel, onSubmit })} />);
  expect(screen.getByRole('button', { name: 'Create Contact' }).hasAttribute('disabled')).toBe(
    true,
  );
});

test('associates supplied field errors and announces form feedback politely', async () => {
  const onValuesChange = rstest.fn();
  const user = userEvent.setup();
  render(
    <ContactForm
      {...formProps({
        fieldErrors: {
          email: 'The server rejected this email.',
          name: 'The server rejected this name.',
          phone: 'The server rejected this phone.',
        },
        formStatus: { message: 'The Contact could not be created.', status: 'error' },
        onValuesChange,
      })}
    />,
  );

  for (const [field, id] of [
    ['Contact name', 'contact-name-error'],
    ['Email', 'contact-email-error'],
    ['Phone', 'contact-phone-error'],
  ] as const) {
    expect(
      screen
        .getByRole('textbox', { name: new RegExp(`^${field}`, 'u') })
        .getAttribute('aria-errormessage'),
    ).toBe(id);
  }
  const status = screen.getAllByRole('status').at(-1);
  expect(status?.textContent).toBe('The Contact could not be created.');
  expect(status?.getAttribute('aria-live')).toBe('polite');

  await user.type(screen.getByRole('textbox', { name: /^Contact name/u }), ' changed');
  expect(onValuesChange).toHaveBeenCalled();
  expect(screen.queryByText('The server rejected this email.')).toBeNull();
  expect(screen.queryByText('The server rejected this name.')).toBeNull();
  expect(screen.queryByText('The server rejected this phone.')).toBeNull();
  expect(screen.queryByText('The Contact could not be created.')).toBeNull();
});

describe('ContactForm architecture', () => {
  test('remains an owner-private UI-kit presentation component without application dependencies', () => {
    const source = readFileSync(
      new URL('../../src/features/contacts/contact-form.tsx', import.meta.url),
      'utf-8',
    );
    expect(source).toContain("from '@techsio/ui-kit/molecules/form-input'");
    expect(source).toContain("from '@techsio/ui-kit/molecules/phone-input'");
    expect(source).toContain("from '@techsio/ui-kit/atoms/button'");
    expect(source).toContain("from '@techsio/ui-kit/atoms/status-text'");
    expect(source).toContain('nativeValidation={false}');
    expect(source).not.toMatch(
      /crm-client|shared\/api|useNavigate|useQuery|Effect|routeParams|customerId/u,
    );
  });
});
