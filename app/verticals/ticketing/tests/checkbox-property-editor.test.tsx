import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { CheckboxPropertyEditor } from '../src/components/checkbox-property-editor';

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.checkbox.saveFailedDescription': 'The Checkbox could not be saved.',
        'ticketing.checkbox.saveFailedTitle': 'Checkbox save failed',
        'ticketing.checkbox.staleDescription':
          'Your checked draft is still here. Reload before trying again.',
        'ticketing.checkbox.staleTitle': 'Checkbox changed elsewhere',
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

test('a stale save keeps the checked draft and reports the conflict through Toast', async () => {
  const approvedLabel = 'Approved';
  const staleError = Object.assign(
    new Error('The Checkbox value changed elsewhere or is no longer available.'),
    {
      code: 'ticketing.updateCheckboxPropertyValue.stale_or_missing',
      errorTag: 'OperationDomainRejected',
      ok: false,
    },
  );
  const save = rs.fn(() => Promise.reject(staleError));

  render(
    <CheckboxPropertyEditor
      collectionId="collection-1"
      label={approvedLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
      value={false}
    />,
  );

  const checkbox = screen.getByRole('checkbox', { name: approvedLabel });
  fireEvent.click(checkbox);

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 1,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: true,
    },
    expect.any(String),
  );
  expect(mocks.toastCreate).toHaveBeenCalledWith({
    description: 'Your checked draft is still here. Reload before trying again.',
    title: 'Checkbox changed elsewhere',
    type: 'warning',
  });
  expect((checkbox as HTMLInputElement).checked).toBe(true);
});
