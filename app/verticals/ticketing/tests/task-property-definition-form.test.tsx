import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import {
  creatableTaskPropertyDatatypes,
  TaskPropertyDefinitionForm,
} from '../src/components/task-property-definition-form';

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.propertyDefinition.create': 'Create field',
        'ticketing.propertyDefinition.creating': 'Creating field',
        'ticketing.propertyDefinition.mandatoryHelp': 'Tasks must have a value for this field.',
        'ticketing.propertyDefinition.mandatoryLabel': 'Mandatory',
        'ticketing.propertyDefinition.nameLabel': 'Field name',
        'ticketing.propertyDefinition.typeLabel': 'Field type',
        'ticketing.propertyDefinition.typePlaceholder': 'Select a field type',
        'ticketing.propertyDefinition.types.checkbox': 'Checkbox',
        'ticketing.propertyDefinition.types.created_by': 'Created by',
        'ticketing.propertyDefinition.types.created_time': 'Created time',
        'ticketing.propertyDefinition.types.date': 'Date',
        'ticketing.propertyDefinition.types.date_range': 'Date range',
        'ticketing.propertyDefinition.types.email': 'Email',
        'ticketing.propertyDefinition.types.last_edited_by': 'Last edited by',
        'ticketing.propertyDefinition.types.last_edited_time': 'Last edited time',
        'ticketing.propertyDefinition.types.number': 'Number',
        'ticketing.propertyDefinition.types.phone': 'Phone',
        'ticketing.propertyDefinition.types.text': 'Text',
        'ticketing.propertyDefinition.types.url': 'URL',
      })[key] ?? key,
  }),
}));

afterEach(() => cleanup());

test('offers every repeatable datatype rendered by the Ticketing page', () => {
  expect(creatableTaskPropertyDatatypes).toEqual([
    'checkbox',
    'date',
    'date_range',
    'email',
    'number',
    'phone',
    'text',
    'url',
    'created_time',
    'created_by',
    'last_edited_time',
    'last_edited_by',
  ]);
});

test('creates multiple named fields of the selected type with independent mandatory state', async () => {
  const onCreate = rs.fn(() => Promise.resolve());
  render(<TaskPropertyDefinitionForm onCreate={onCreate} />);

  const nativeTypeSelect = document.querySelector<HTMLSelectElement>(
    'select[name="task-property-datatype"]',
  );
  expect(nativeTypeSelect).not.toBeNull();
  fireEvent.change(nativeTypeSelect as HTMLSelectElement, { target: { value: 'url' } });
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Field type' })).toHaveTextContent('URL'),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Primary link' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Mandatory' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Mandatory' })).toBeChecked());
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  await waitFor(() =>
    expect(onCreate).toHaveBeenNthCalledWith(1, {
      datatype: 'url',
      mandatory: true,
      name: 'Primary link',
    }),
  );
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Field name' })).toHaveValue(''));
  expect(screen.getByRole('checkbox', { name: 'Mandatory' })).not.toBeChecked();
  expect(screen.getByRole('combobox', { name: 'Field type' })).toHaveTextContent('URL');

  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Backup link' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  await waitFor(() =>
    expect(onCreate).toHaveBeenNthCalledWith(2, {
      datatype: 'url',
      mandatory: false,
      name: 'Backup link',
    }),
  );
});
