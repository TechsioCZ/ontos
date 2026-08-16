// @effect-diagnostics asyncFunction:off newPromise:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { CustomerForm } from '../../src/features/customers/customer-form.tsx';

const copy = {
  cancel: 'Cancel',
  nameLabel: 'Customer name',
  nameRequired: 'Enter a Customer name.',
  save: 'Save changes',
  saving: 'Saving changes…',
} as const;

const formProps = (
  overrides: Partial<ComponentProps<typeof CustomerForm>> = {},
): ComponentProps<typeof CustomerForm> => ({
  copy,
  initialValues: { name: 'Acme Property Group' },
  onCancel: rstest.fn(),
  onSubmit: rstest.fn(),
  ...overrides,
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('renders edit values and emits current values without submitting', async () => {
  const onValuesChange = rstest.fn();
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  render(<CustomerForm {...formProps({ onSubmit, onValuesChange })} />);

  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  expect(name.getAttribute('value')).toBe('Acme Property Group');
  await user.clear(name);
  await user.type(name, 'Updated Customer');

  expect(onValuesChange).toHaveBeenLastCalledWith({ name: 'Updated Customer' });
  expect(onSubmit).not.toHaveBeenCalled();
});

test('supports future-create empty values and focuses the required field', async () => {
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  render(<CustomerForm {...formProps({ initialValues: { name: '' }, onSubmit })} />);

  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  expect(document.activeElement).toBe(name);
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(name.getAttribute('aria-describedby')).toBe('customer-name-error');
  expect(screen.getByText('Enter a Customer name.')).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('validates whitespace and submits one normalized intent from the keyboard', async () => {
  const onSubmit = rstest.fn(() => Promise.resolve());
  const user = userEvent.setup();
  render(<CustomerForm {...formProps({ initialValues: { name: '   ' }, onSubmit })} />);

  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  name.focus();
  await user.keyboard('{Enter}');
  expect(onSubmit).not.toHaveBeenCalled();

  await user.clear(name);
  await user.type(name, '  New name  ');
  await user.keyboard('{Enter}');
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith({ name: 'New name' });
});

test('suppresses duplicate submits while one semantic intent is unsettled', async () => {
  let settle!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- A controlled deferred promise keeps the form submission unsettled for this interaction test.
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onSubmit = rstest.fn(() => pending);
  const user = userEvent.setup();
  render(<CustomerForm {...formProps({ onSubmit })} />);

  const submit = screen.getByRole('button', { name: 'Save changes' });
  await user.dblClick(submit);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  settle();
  await pending;
});

test('releases the duplicate-submit guard after a rejected presentation callback', async () => {
  const onSubmit = rstest
    .fn(() => Promise.resolve())
    .mockRejectedValueOnce(new Error('presentation callback failed'))
    .mockResolvedValueOnce();
  const user = userEvent.setup();
  render(<CustomerForm {...formProps({ onSubmit })} />);

  const submit = screen.getByRole('button', { name: 'Save changes' });
  await user.click(submit);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  await user.click(submit);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
});

test('uses UI-kit pending controls and keeps cancel mutation-free', async () => {
  const onCancel = rstest.fn();
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  const { rerender } = render(<CustomerForm {...formProps({ onCancel, onSubmit })} />);

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();

  rerender(<CustomerForm {...formProps({ onCancel, onSubmit, pending: true })} />);
  expect(screen.getByRole('textbox', { name: /^Customer name/u }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Saving changes…' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
});

test('exposes server field errors and form status with accessible relationships', () => {
  render(
    <CustomerForm
      {...formProps({
        formStatus: { message: 'The edit could not be saved.', status: 'error' },
        nameError: 'Use a valid Customer name.',
      })}
    />,
  );

  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  expect(name.getAttribute('aria-errormessage')).toBe('customer-name-error');
  expect(screen.getByText('Use a valid Customer name.')).toBeTruthy();
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('The edit could not be saved.');
  expect(status.getAttribute('aria-live')).toBe('polite');
});

describe('CustomerForm architecture', () => {
  test('remains an owner-private presentation component without application dependencies', () => {
    const source = readFileSync(
      new URL('../../src/features/customers/customer-form.tsx', import.meta.url),
      'utf-8',
    );
    expect(source).toContain("from '@techsio/ui-kit/molecules/form-input'");
    expect(source).toContain("from '@techsio/ui-kit/atoms/button'");
    expect(source).toContain("from '@techsio/ui-kit/atoms/status-text'");
    expect(source).not.toMatch(/crm-client|shared\/api|useNavigate|useQuery|Effect|routeParams/u);
  });
});
