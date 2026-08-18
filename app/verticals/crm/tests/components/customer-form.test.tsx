// @effect-diagnostics asyncFunction:off newPromise:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { CustomerForm } from '../../src/features/customers/customer-form.tsx';
import type { CustomerFormValues } from '../../src/features/customers/customer-form.tsx';

const copy = {
  cancel: 'Cancel',
  dicHint: 'Use at most 20 characters.',
  dicInvalid: 'Enter a DIČ with at most 20 characters.',
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
  save: 'Save changes',
  saving: 'Saving changes…',
} as const;

const readyValues: CustomerFormValues = {
  dic: 'CZ12345678',
  dissolvedOn: '',
  establishedOn: '2020-01-15',
  ico: '01234567',
  legalFormCode: '112',
  name: 'Acme Property Group',
};

const formProps = (
  overrides: Partial<ComponentProps<typeof CustomerForm>> = {},
): ComponentProps<typeof CustomerForm> => ({
  copy,
  onCancel: rstest.fn(),
  onSubmit: rstest.fn(),
  onValuesChange: rstest.fn(),
  values: readyValues,
  ...overrides,
});

const ControlledForm = ({
  onValuesChange,
  values: initialValues,
  ...props
}: ComponentProps<typeof CustomerForm>) => {
  const [values, setValues] = useState(initialValues);
  return (
    <CustomerForm
      {...props}
      onValuesChange={(nextValues) => {
        setValues(nextValues);
        onValuesChange(nextValues);
      }}
      values={values}
    />
  );
};

const ParentReplacementForm = () => {
  const [values, setValues] = useState<CustomerFormValues>(readyValues);
  return (
    <>
      <CustomerForm {...formProps()} onValuesChange={setValues} values={values} />
      <button
        onClick={() =>
          setValues({
            dic: '',
            dissolvedOn: '2026-08-17',
            establishedOn: '2021-02-03',
            ico: '87654321',
            legalFormCode: '121',
            name: 'ARES replacement',
          })
        }
        type="button"
      >
        Apply prefill
      </button>
    </>
  );
};

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('renders all six controlled Customer fields and empty optional values', () => {
  render(<CustomerForm {...formProps()} />);

  expect(screen.getByLabelText(/^Customer name/u).getAttribute('value')).toBe(
    'Acme Property Group',
  );
  expect(screen.getByLabelText(/^IČO/u).getAttribute('value')).toBe('01234567');
  expect(screen.getByLabelText(/^DIČ/u).getAttribute('value')).toBe('CZ12345678');
  expect(screen.getByLabelText(/^Legal-form code/u).getAttribute('value')).toBe('112');
  expect(screen.getByLabelText(/^Establishment date/u).getAttribute('value')).toBe('2020-01-15');
  expect(screen.getByLabelText(/^Dissolution date/u).getAttribute('value')).toBe('');
  expect(screen.getByLabelText(/^Establishment date/u).getAttribute('type')).toBe('date');
  expect(screen.getByLabelText(/^Dissolution date/u).getAttribute('type')).toBe('date');
});

test('renders a parent-driven replacement after the user has typed', async () => {
  const user = userEvent.setup();
  render(<ParentReplacementForm />);
  const name = screen.getByLabelText(/^Customer name/u);
  await user.clear(name);
  await user.type(name, 'Manual draft');
  expect(name.getAttribute('value')).toBe('Manual draft');

  await user.click(screen.getByRole('button', { name: 'Apply prefill' }));

  expect(screen.getByLabelText(/^Customer name/u).getAttribute('value')).toBe('ARES replacement');
  expect(screen.getByLabelText(/^IČO/u).getAttribute('value')).toBe('87654321');
  expect(screen.getByLabelText(/^DIČ/u).getAttribute('value')).toBe('');
  expect(screen.getByLabelText(/^Legal-form code/u).getAttribute('value')).toBe('121');
  expect(screen.getByLabelText(/^Establishment date/u).getAttribute('value')).toBe('2021-02-03');
  expect(screen.getByLabelText(/^Dissolution date/u).getAttribute('value')).toBe('2026-08-17');
});

test('emits complete semantic values for every field change without submitting', async () => {
  const onSubmit = rstest.fn();
  const onValuesChange = rstest.fn();
  const user = userEvent.setup();
  render(<ControlledForm {...formProps({ onSubmit, onValuesChange })} />);

  await user.clear(screen.getByLabelText(/^Customer name/u));
  await user.type(screen.getByLabelText(/^Customer name/u), 'Updated Customer');
  await user.clear(screen.getByLabelText(/^IČO/u));
  await user.type(screen.getByLabelText(/^IČO/u), '00000019');
  await user.clear(screen.getByLabelText(/^DIČ/u));
  await user.type(screen.getByLabelText(/^DIČ/u), 'cz00000019');
  await user.clear(screen.getByLabelText(/^Legal-form code/u));
  await user.type(screen.getByLabelText(/^Legal-form code/u), '121');
  await user.clear(screen.getByLabelText(/^Establishment date/u));
  await user.type(screen.getByLabelText(/^Establishment date/u), '2021-02-03');
  await user.clear(screen.getByLabelText(/^Dissolution date/u));
  await user.type(screen.getByLabelText(/^Dissolution date/u), '2026-08-17');

  expect(onValuesChange).toHaveBeenLastCalledWith({
    dic: 'cz00000019',
    dissolvedOn: '2026-08-17',
    establishedOn: '2021-02-03',
    ico: '00000019',
    legalFormCode: '121',
    name: 'Updated Customer',
  });
  expect(onSubmit).not.toHaveBeenCalled();
});

test('normalizes all values and preserves leading-zero IČO on keyboard submit', async () => {
  const onSubmit = rstest.fn(() => Promise.resolve());
  const user = userEvent.setup();
  render(
    <ControlledForm
      {...formProps({
        onSubmit,
        values: {
          dic: '  cz01234567  ',
          dissolvedOn: '',
          establishedOn: '2020-01-15',
          ico: '  01234567  ',
          legalFormCode: '  112  ',
          name: '  Acme Property Group  ',
        },
      })}
    />,
  );

  screen.getByLabelText(/^DIČ/u).focus();
  await user.keyboard('{Enter}');

  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith({
    dic: 'CZ01234567',
    dissolvedOn: '',
    establishedOn: '2020-01-15',
    ico: '01234567',
    legalFormCode: '112',
    name: 'Acme Property Group',
  });
});

test.each([
  ['Customer name', { ...readyValues, name: '   ' }, copy.nameRequired],
  ['Customer name', { ...readyValues, name: 'n'.repeat(201) }, copy.nameInvalid],
  ['IČO', { ...readyValues, ico: '1234567' }, copy.icoInvalid],
  ['DIČ', { ...readyValues, dic: 'X'.repeat(21) }, copy.dicInvalid],
  ['Legal-form code', { ...readyValues, legalFormCode: '12A' }, copy.legalFormCodeInvalid],
  [
    'Dissolution date',
    { ...readyValues, dissolvedOn: '2019-12-31' },
    copy.dissolvedBeforeEstablished,
  ],
] as const)('rejects invalid values and focuses %s first', async (field, values, message) => {
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  render(<ControlledForm {...formProps({ onSubmit, values })} />);

  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  const input = screen.getByLabelText(new RegExp(`^${field}`, 'u'));
  expect(document.activeElement).toBe(input);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-errormessage')).toMatch(/^customer-.+-error$/u);
  expect(screen.getByText(message)).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('accepts empty optional fields and equal lifecycle dates', async () => {
  const onSubmit = rstest.fn();
  const user = userEvent.setup();
  render(
    <ControlledForm
      {...formProps({
        onSubmit,
        values: {
          dic: '   ',
          dissolvedOn: '2020-01-15',
          establishedOn: '2020-01-15',
          ico: '',
          legalFormCode: '',
          name: readyValues.name,
        },
      })}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(onSubmit).toHaveBeenCalledWith({
    dic: '',
    dissolvedOn: '2020-01-15',
    establishedOn: '2020-01-15',
    ico: '',
    legalFormCode: '',
    name: readyValues.name,
  });
});

test('clears a local field error when that field changes', async () => {
  const user = userEvent.setup();
  render(<ControlledForm {...formProps({ values: { ...readyValues, ico: '123' } })} />);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(screen.getByText(copy.icoInvalid)).toBeTruthy();

  await user.type(screen.getByLabelText(/^IČO/u), '45678');

  expect(screen.queryByText(copy.icoInvalid)).toBeNull();
  expect(screen.getByLabelText(/^IČO/u).getAttribute('aria-invalid')).toBeNull();
});

test('suppresses duplicate submits while one semantic intent is unsettled and then releases', async () => {
  let settle!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- A controlled deferred promise keeps the form submission unsettled for this interaction test.
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onSubmit = rstest.fn(() => pending);
  const user = userEvent.setup();
  render(<ControlledForm {...formProps({ onSubmit })} />);

  const submit = screen.getByRole('button', { name: 'Save changes' });
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
  const { rerender } = render(
    <ControlledForm {...formProps({ onCancel, onSubmit, pending: false })} />,
  );

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();

  rerender(<ControlledForm {...formProps({ onCancel, onSubmit, pending: true })} />);
  for (const label of [
    'Customer name',
    'IČO',
    'DIČ',
    'Legal-form code',
    'Establishment date',
    'Dissolution date',
  ]) {
    expect(screen.getByLabelText(new RegExp(`^${label}`, 'u')).hasAttribute('disabled')).toBe(true);
  }
  expect(screen.getByRole('button', { name: 'Saving changes…' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);

  rerender(<ControlledForm {...formProps({ disabled: true, onCancel, onSubmit })} />);
  expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true);
});

test('exposes supplied field errors, accessible hints, and polite form status', () => {
  render(
    <CustomerForm
      {...formProps({
        fieldErrors: {
          dic: 'The server rejected this DIČ.',
          name: 'The server rejected this name.',
        },
        formStatus: { message: 'The edit could not be saved.', status: 'error' },
      })}
    />,
  );

  expect(screen.getByLabelText(/^Customer name/u).getAttribute('aria-errormessage')).toBe(
    'customer-name-error',
  );
  expect(screen.getByLabelText(/^DIČ/u).getAttribute('aria-errormessage')).toBe(
    'customer-dic-error',
  );
  expect(screen.getByLabelText(/^IČO/u).getAttribute('aria-describedby')).toBe('customer-ico-hint');
  expect(screen.getByText('The server rejected this name.')).toBeTruthy();
  expect(screen.getByText('The server rejected this DIČ.')).toBeTruthy();
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('The edit could not be saved.');
  expect(status.getAttribute('aria-live')).toBe('polite');
});

describe('CustomerForm architecture', () => {
  test('remains controlled owner-private UI-kit presentation without application dependencies', () => {
    const source = readFileSync(
      new URL('../../src/features/customers/customer-form.tsx', import.meta.url),
      'utf-8',
    );
    expect(source).toContain("from '@techsio/ui-kit/molecules/form-input'");
    expect(source).toContain("from '@techsio/ui-kit/atoms/button'");
    expect(source).toContain("from '@techsio/ui-kit/atoms/status-text'");
    expect(source).toContain('crm:sm:grid-cols-2');
    expect(source).not.toMatch(/initialValues|setValues|useEffect/u);
    expect(source).not.toMatch(/crm-client|shared\/api|useNavigate|useQuery|Effect|routeParams/u);
  });
});
