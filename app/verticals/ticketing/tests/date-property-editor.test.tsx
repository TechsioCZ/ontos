import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { DatePropertyEditor } from '../src/components/date-property-editor';

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));
const czechLabel = 'Datum kontroly';
const englishLabel = 'Review date';

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.date.clear': 'Clear',
        'ticketing.date.empty': 'Empty',
        'ticketing.date.invalid': 'Enter a real calendar date.',
        'ticketing.date.nextMonth': 'Next month',
        'ticketing.date.previousMonth': 'Previous month',
        'ticketing.date.save': 'Save date',
        'ticketing.date.saveFailedDescription': 'The Date could not be saved.',
        'ticketing.date.saveFailedTitle': 'Date save failed',
        'ticketing.date.staleDescription':
          'Your date draft is still here. Reload before trying again.',
        'ticketing.date.staleTitle': 'Date changed elsewhere',
        'ticketing.date.today': 'Today',
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

const localToday = (): string => {
  const today = new Date();
  return [
    String(today.getFullYear()).padStart(4, '0'),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
};

test('an Empty picker opens the current month, navigation is inert, and Today saves local date', async () => {
  const save = rs.fn((draft) =>
    Promise.resolve({
      taskRevision: 2,
      value: {
        propertyDefinitionId: draft.propertyDefinitionId,
        revision: 1,
        value: draft.value,
      },
    }),
  );
  const now = new Date();
  const currentMonth = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
  }).format(now);

  render(
    <DatePropertyEditor
      collectionId="collection-1"
      label={englishLabel}
      locale="en-GB"
      onSave={save}
      propertyDefinitionId="property-1"
      revision={0}
      taskId="task-1"
      value={null}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Review date: Empty' }));
  expect(await screen.findByText(currentMonth)).toBeDefined();
  expect(save).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(save).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 0,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: localToday(),
    },
    expect.any(String),
  );
});

test('localized manual input rejects an impossible date without replacing the committed value', async () => {
  const save = rs.fn((draft) =>
    Promise.resolve({
      taskRevision: 3,
      value: {
        propertyDefinitionId: draft.propertyDefinitionId,
        revision: 2,
        value: draft.value,
      },
    }),
  );

  render(
    <DatePropertyEditor
      collectionId="collection-1"
      label={englishLabel}
      locale="en-GB"
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
      value="2026-07-13"
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Review date: 13/07/2026' }));
  const input = await screen.findByRole('textbox', { name: 'Review date' });
  fireEvent.change(input, { target: { value: '31/04/2026' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save date' }));

  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText('Enter a real calendar date.')).toBeDefined();
  expect((input as HTMLInputElement).value).toBe('31/04/2026');
  expect(screen.getByRole('button', { name: 'Review date: 13/07/2026' })).toBeDefined();

  fireEvent.change(input, { target: { value: '29/02/2028' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save date' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 1,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: '2028-02-29',
    },
    expect.any(String),
  );
});

test('cs-CZ input maps to canonical storage and a stale failure preserves the localized draft', async () => {
  const staleError = Object.assign(
    new Error('The Date value changed elsewhere or is no longer available.'),
    {
      code: 'ticketing.updateDatePropertyValue.stale_or_missing',
      errorTag: 'OperationDomainRejected',
      ok: false,
    },
  );
  const save = rs.fn(() => Promise.reject(staleError));

  render(
    <DatePropertyEditor
      collectionId="collection-1"
      label={czechLabel}
      locale="cs-CZ"
      onSave={save}
      propertyDefinitionId="property-1"
      revision={4}
      taskId="task-1"
      value="2026-07-13"
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Datum kontroly: 13. 07. 2026' }));
  const input = await screen.findByRole('textbox', { name: 'Datum kontroly' });
  fireEvent.change(input, { target: { value: '20. 08. 2026' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save date' }));

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 4,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: '2026-08-20',
    },
    expect.any(String),
  );
  expect(mocks.toastCreate).toHaveBeenCalledWith({
    description: 'Your date draft is still here. Reload before trying again.',
    title: 'Date changed elsewhere',
    type: 'warning',
  });
  expect((input as HTMLInputElement).value).toBe('20. 08. 2026');
  expect(screen.getByRole('button', { name: 'Datum kontroly: 13. 07. 2026' })).toBeDefined();
});

test('a stored Date opens its month and an adjacent-month day selects its actual date', async () => {
  const save = rs.fn((draft) =>
    Promise.resolve({
      taskRevision: 3,
      value: {
        propertyDefinitionId: draft.propertyDefinitionId,
        revision: 2,
        value: draft.value,
      },
    }),
  );

  render(
    <DatePropertyEditor
      collectionId="collection-1"
      label={englishLabel}
      locale="en-GB"
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
      value="2026-07-13"
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Review date: 13/07/2026' }));
  expect(await screen.findByText('July 2026')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: /1 August 2026/iu }));

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 1,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: '2026-08-01',
    },
    expect.any(String),
  );
});

test('clearing removes the value revision so a replacement uses the absent-value revision', async () => {
  const save = rs.fn((draft) =>
    Promise.resolve(
      draft.value === null
        ? { taskRevision: 3, value: null }
        : {
            taskRevision: 4,
            value: {
              propertyDefinitionId: draft.propertyDefinitionId,
              revision: 1,
              value: draft.value,
            },
          },
    ),
  );

  render(
    <DatePropertyEditor
      collectionId="collection-1"
      label={englishLabel}
      locale="en-GB"
      onSave={save}
      propertyDefinitionId="property-1"
      revision={7}
      taskId="task-1"
      value="2026-07-13"
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Review date: 13/07/2026' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

  const input = screen.getByRole('textbox', { name: 'Review date' });
  fireEvent.change(input, { target: { value: '14/07/2026' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save date' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls.at(1)?.at(0)).toEqual({
    collectionId: 'collection-1',
    expectedRevision: 0,
    propertyDefinitionId: 'property-1',
    taskId: 'task-1',
    value: '2026-07-14',
  });
});
