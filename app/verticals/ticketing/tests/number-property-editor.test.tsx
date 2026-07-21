import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { NumberPropertyEditor } from '../src/components/number-property-editor';

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.number.invalidDescription': 'Enter a valid number.',
        'ticketing.number.invalidTitle': 'Invalid number',
        'ticketing.number.saveFailedDescription': 'The Number could not be saved.',
        'ticketing.number.saveFailedTitle': 'Number save failed',
        'ticketing.number.staleDescription':
          'Your number draft is still here. Reload before trying again.',
        'ticketing.number.staleTitle': 'Number changed elsewhere',
      })[key] ?? key,
  }),
}));

rs.mock('@techsio/ui-kit/molecules/toast', () => ({
  toaster: { create: mocks.toastCreate },
}));

afterEach(() => {
  cleanup();
  mocks.toastCreate.mockClear();
});

const baseProps = {
  collectionId: 'collection-1',
  format: 'number' as const,
  label: 'Estimate',
  locale: 'cs-CZ',
  propertyDefinitionId: 'property-1',
  revision: 1,
  taskId: 'task-1',
  value: '10',
};

test('Percent presents direct localized percentage semantics without changing the stored value', () => {
  render(<NumberPropertyEditor {...baseProps} format="percent" onSave={rs.fn()} value="25" />);

  expect((screen.getByRole('textbox', { name: 'Estimate' }) as HTMLInputElement).value).toBe(
    '25 %',
  );
});

test('an invalid paste is rejected as a whole and retains the previous draft', () => {
  const save = rs.fn();
  render(<NumberPropertyEditor {...baseProps} onSave={save} />);
  const input = screen.getByRole('textbox', { name: 'Estimate' });
  fireEvent.focus(input);
  expect((input as HTMLInputElement).value).toBe('10');

  fireEvent.paste(input, { clipboardData: { getData: () => '12a5' } });

  expect((input as HTMLInputElement).value).toBe('10');
  expect(save).not.toHaveBeenCalled();
  expect(mocks.toastCreate).toHaveBeenCalledWith({
    description: 'Enter a valid number.',
    title: 'Invalid number',
    type: 'error',
  });
});

test('malformed and foreign grouping separators are rejected instead of changing the number', () => {
  const save = rs.fn();
  render(<NumberPropertyEditor {...baseProps} locale="en-GB" onSave={save} />);
  const input = screen.getByRole('textbox', { name: 'Estimate' });
  fireEvent.focus(input);

  fireEvent.paste(input, { clipboardData: { getData: () => '1,2' } });
  fireEvent.paste(input, { clipboardData: { getData: () => '1\u00A0234' } });

  expect((input as HTMLInputElement).value).toBe('10');
  expect(save).not.toHaveBeenCalled();
  expect(mocks.toastCreate).toHaveBeenCalledTimes(2);
});

test('localized input sends one canonical decimal with the form idempotency key', async () => {
  const save = rs.fn(() =>
    Promise.resolve({
      taskRevision: 2,
      value: { propertyDefinitionId: 'property-1', revision: 2, value: '12.5' },
    }),
  );
  render(<NumberPropertyEditor {...baseProps} onSave={save} />);
  const input = screen.getByRole('textbox', { name: 'Estimate' });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '12,5' } });
  fireEvent.blur(input);

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 1,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: '12.5',
    },
    expect.any(String),
  );
  expect((input as HTMLInputElement).value).toBe('12,5');
});

test('a stale save keeps the localized draft and reports the conflict through Toast', async () => {
  const staleError = Object.assign(new Error('The Number value changed elsewhere.'), {
    code: 'ticketing.updateNumberPropertyValue.stale_or_missing',
    errorTag: 'OperationDomainRejected',
    ok: false,
  });
  const save = rs.fn(() => Promise.reject(staleError));
  render(<NumberPropertyEditor {...baseProps} onSave={save} />);
  const input = screen.getByRole('textbox', { name: 'Estimate' });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '12,5' } });
  fireEvent.blur(input);

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect((input as HTMLInputElement).value).toBe('12,5');
  expect(mocks.toastCreate).toHaveBeenCalledWith({
    description: 'Your number draft is still here. Reload before trying again.',
    title: 'Number changed elsewhere',
    type: 'warning',
  });
});

test('external value, revision, format, and locale changes refresh only a non-editing display', async () => {
  const save = rs.fn(() =>
    Promise.resolve({
      taskRevision: 4,
      value: { propertyDefinitionId: 'property-1', revision: 4, value: '12.5' },
    }),
  );
  const { rerender } = render(
    <NumberPropertyEditor {...baseProps} locale="en-GB" onSave={save} value="1234.5" />,
  );
  const input = screen.getByRole('textbox', { name: 'Estimate' });

  rerender(
    <NumberPropertyEditor
      {...baseProps}
      format="number_with_separators"
      locale="cs-CZ"
      onSave={save}
      revision={2}
      value="2000.5"
    />,
  );
  expect((input as HTMLInputElement).value).toBe('2\u00A0000,5');

  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '12,5' } });
  rerender(
    <NumberPropertyEditor
      {...baseProps}
      format="percent"
      locale="cs-CZ"
      onSave={save}
      revision={3}
      value="25"
    />,
  );
  expect((input as HTMLInputElement).value).toBe('12,5');
  fireEvent.blur(input);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 3,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: '12.5',
    },
    expect.any(String),
  );
});
