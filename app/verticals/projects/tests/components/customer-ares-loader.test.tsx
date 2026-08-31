// @effect-diagnostics asyncFunction:off newPromise:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { CustomerAresLoader } from '../../src/features/customers/customer-ares-loader.tsx';
import { CustomerForm } from '../../src/features/customers/customer-form.tsx';

const copy = {
  formLabel: 'Load Customer data from ARES',
  icoInvalid: 'Enter an IČO containing exactly eight digits.',
  icoLabel: 'IČO',
  lookingUp: 'Loading from ARES…',
  lookup: 'Load from ARES',
} as const;

const loaderProps = (
  overrides: Partial<ComponentProps<typeof CustomerAresLoader>> = {},
): ComponentProps<typeof CustomerAresLoader> => ({
  copy,
  onLookup: rstest.fn(),
  ...overrides,
});

const customerFormCopy = {
  cancel: 'Cancel',
  dicHint: 'Use at most 32 characters.',
  dicInvalid: 'Enter a DIČ with at most 32 characters.',
  dicLabel: 'DIČ',
  dissolvedBeforeEstablished: 'Dissolution cannot be before establishment.',
  dissolvedOnHint: 'Leave empty while the Customer exists.',
  dissolvedOnLabel: 'Dissolution date',
  establishedOnHint: 'Use the official establishment date.',
  establishedOnLabel: 'Establishment date',
  icoHint: 'Enter exactly eight digits.',
  icoInvalid: 'Enter an eight-digit IČO.',
  icoLabel: 'IČO',
  legalFormCodeHint: 'Enter the three-digit legal-form code.',
  legalFormCodeInvalid: 'Enter a three-digit legal-form code.',
  legalFormCodeLabel: 'Legal-form code',
  nameHint: 'Use the official business name.',
  nameInvalid: 'Enter a Customer name with at most 200 characters.',
  nameLabel: 'Customer name',
  nameRequired: 'Enter a Customer name.',
  save: 'Create Customer',
  saving: 'Creating Customer…',
} as const;

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('renders one accessible IČO input and one primary lookup action', () => {
  render(<CustomerAresLoader {...loaderProps()} />);

  const form = screen.getByRole('form', { name: copy.formLabel });
  expect(within(form).getAllByRole('textbox')).toHaveLength(1);
  expect(within(form).getByRole('textbox', { name: /^IČO/u })).toBeTruthy();
  expect(within(form).getAllByRole('button')).toHaveLength(1);
  expect(within(form).getByRole('button', { name: copy.lookup }).getAttribute('type')).toBe(
    'submit',
  );
});

test('emits a valid click intent with whitespace trimmed', async () => {
  const onLookup = rstest.fn();
  const user = userEvent.setup();
  render(<CustomerAresLoader {...loaderProps({ onLookup })} />);

  await user.type(screen.getByRole('textbox', { name: /^IČO/u }), '  12345678  ');
  await user.click(screen.getByRole('button', { name: copy.lookup }));

  expect(onLookup).toHaveBeenCalledTimes(1);
  expect(onLookup).toHaveBeenCalledWith('12345678');
});

test('preserves leading zeroes and supports Enter as one lookup intent', async () => {
  const onLookup = rstest.fn();
  const user = userEvent.setup();
  render(<CustomerAresLoader {...loaderProps({ onLookup })} />);

  const input = screen.getByRole('textbox', { name: /^IČO/u });
  await user.type(input, '00123456');
  await user.keyboard('{Enter}');

  expect(onLookup).toHaveBeenCalledTimes(1);
  expect(onLookup).toHaveBeenCalledWith('00123456');
});

test.each(['1234567', '123456789', '12A45678', '１２３４５６７８'])(
  'rejects non-eight-ASCII-digit IČO %s, describes the error, and focuses the input',
  async (ico) => {
    const onLookup = rstest.fn();
    const user = userEvent.setup();
    render(<CustomerAresLoader {...loaderProps({ onLookup })} />);

    const input = screen.getByRole('textbox', { name: /^IČO/u });
    await user.type(input, ico);
    await user.click(screen.getByRole('button', { name: copy.lookup }));

    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('customer-ares-ico-error');
    expect(input.getAttribute('aria-errormessage')).toBe('customer-ares-ico-error');
    expect(screen.getByText(copy.icoInvalid)).toBeTruthy();
    expect(onLookup).not.toHaveBeenCalled();
  },
);

test('clears only the local format error when the IČO changes', async () => {
  const user = userEvent.setup();
  render(
    <CustomerAresLoader
      {...loaderProps({
        status: { message: 'ARES is temporarily unavailable.', status: 'error' },
      })}
    />,
  );

  const input = screen.getByRole('textbox', { name: /^IČO/u });
  await user.type(input, 'invalid');
  await user.click(screen.getByRole('button', { name: copy.lookup }));
  expect(screen.getByText(copy.icoInvalid)).toBeTruthy();

  await user.type(input, '1');
  expect(screen.queryByText(copy.icoInvalid)).toBeNull();
  expect(screen.getByText('ARES is temporarily unavailable.')).toBeTruthy();
  expect(input.hasAttribute('aria-invalid')).toBe(false);
});

test('suppresses repeat activation while one lookup callback is unsettled', async () => {
  let settle!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- A controlled deferred promise keeps the lookup intent unsettled for the interaction guard test.
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onLookup = rstest.fn(() => pending);
  const user = userEvent.setup();
  render(<CustomerAresLoader {...loaderProps({ onLookup })} />);

  await user.type(screen.getByRole('textbox', { name: /^IČO/u }), '12345678');
  await user.dblClick(screen.getByRole('button', { name: copy.lookup }));
  expect(onLookup).toHaveBeenCalledTimes(1);

  settle();
  await pending;
  await user.click(screen.getByRole('button', { name: copy.lookup }));
  await waitFor(() => expect(onLookup).toHaveBeenCalledTimes(2));
});

test('suppresses repeated Enter activation while one lookup callback is unsettled', async () => {
  let settle!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- A controlled deferred promise keeps the keyboard lookup intent unsettled for the interaction guard test.
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onLookup = rstest.fn(() => pending);
  const user = userEvent.setup();
  render(<CustomerAresLoader {...loaderProps({ onLookup })} />);

  const input = screen.getByRole('textbox', { name: /^IČO/u });
  await user.type(input, '12345678');
  await user.keyboard('{Enter}{Enter}');
  expect(onLookup).toHaveBeenCalledTimes(1);

  settle();
  await pending;
});

test('releases the interaction guard after a rejected presentation callback', async () => {
  const onLookup = rstest
    .fn(() => Promise.resolve())
    .mockRejectedValueOnce(new Error('presentation callback failed'))
    .mockResolvedValueOnce();
  const user = userEvent.setup();
  render(<CustomerAresLoader {...loaderProps({ onLookup })} />);

  await user.type(screen.getByRole('textbox', { name: /^IČO/u }), '12345678');
  const button = screen.getByRole('button', { name: copy.lookup });
  await user.click(button);
  await waitFor(() => expect(onLookup).toHaveBeenCalledTimes(1));
  await user.click(button);
  await waitFor(() => expect(onLookup).toHaveBeenCalledTimes(2));
});

test('disables repeat interaction and exposes loading copy while pending or disabled', async () => {
  const onLookup = rstest.fn();
  const user = userEvent.setup();
  const { rerender } = render(<CustomerAresLoader {...loaderProps({ onLookup, pending: true })} />);

  const pendingInput = screen.getByRole('textbox', { name: /^IČO/u });
  const pendingButton = screen.getByRole('button', { name: copy.lookingUp });
  expect(pendingInput.hasAttribute('disabled')).toBe(true);
  expect(pendingButton.hasAttribute('disabled')).toBe(true);
  await user.click(pendingButton);
  expect(onLookup).not.toHaveBeenCalled();

  rerender(<CustomerAresLoader {...loaderProps({ disabled: true, onLookup })} />);
  expect(screen.getByRole('textbox', { name: /^IČO/u }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: copy.lookup }).hasAttribute('disabled')).toBe(true);
});

test('announces parent-owned lookup status politely and removes it when the parent clears it', () => {
  const { rerender } = render(
    <CustomerAresLoader
      {...loaderProps({ status: { message: 'No company was found.', status: 'warning' } })}
    />,
  );

  const status = screen.getByRole('status');
  expect(status.textContent).toBe('No company was found.');
  expect(status.getAttribute('aria-live')).toBe('polite');

  rerender(<CustomerAresLoader {...loaderProps()} />);
  expect(screen.queryByRole('status')).toBeNull();
});

test('stays in a sibling form and never submits Customer creation', async () => {
  const onLookup = rstest.fn();
  const onCreateCustomer = rstest.fn();
  const user = userEvent.setup();
  const { container } = render(
    <div>
      <CustomerAresLoader {...loaderProps({ onLookup })} />
      <CustomerForm
        copy={customerFormCopy}
        onCancel={rstest.fn()}
        onSubmit={onCreateCustomer}
        onValuesChange={rstest.fn()}
        values={{
          dic: '',
          dissolvedOn: '',
          establishedOn: '',
          ico: '',
          legalFormCode: '',
          name: 'Acme Property Group',
        }}
      />
    </div>,
  );

  const aresForm = screen.getByRole('form', { name: copy.formLabel });
  const ico = within(aresForm).getByRole('textbox', { name: /^IČO/u });
  const customerName = screen.getByRole('textbox', { name: /^Customer name/u });
  expect(container.querySelectorAll('form')).toHaveLength(2);
  expect(ico.closest('form')).not.toBe(customerName.closest('form'));

  await user.type(ico, '12345678');
  await user.keyboard('{Enter}');
  expect(onLookup).toHaveBeenCalledWith('12345678');
  expect(onCreateCustomer).not.toHaveBeenCalled();
});

describe('CustomerAresLoader architecture', () => {
  test('remains owner-private presentation without BFF, Effect, fetch, or domain imports', () => {
    const source = readFileSync(
      new URL('../../src/features/customers/customer-ares-loader.tsx', import.meta.url),
      'utf-8',
    );
    expect(source).toContain("from '@techsio/ui-kit/molecules/form-input'");
    expect(source).toContain("from '@techsio/ui-kit/atoms/button'");
    expect(source).toContain("from '@techsio/ui-kit/atoms/status-text'");
    expect(source).not.toMatch(
      /projects-client|shared\/api|useNavigate|useQuery|Effect|fetch\(|Customer(?:Dto|Record|Response)|routeParams/u,
    );
  });
});
