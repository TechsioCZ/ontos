import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { TaskPropertyDefinitionActions } from '../src/components/task-property-definition-actions';

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string, options?: { readonly count?: number; readonly name?: string }) =>
      ({
        'ticketing.propertyActions.copyValuesAlways':
          'Existing values are always copied for this field type.',
        'ticketing.propertyActions.copyValuesHelp':
          'Copy every Task’s current value to the duplicate.',
        'ticketing.propertyActions.copyValuesLabel': 'Copy current values',
        'ticketing.propertyActions.copyValuesNever':
          'Stored values are not copied for this field type.',
        'ticketing.propertyActions.delete': `Delete ${options?.name ?? 'field'}`,
        'ticketing.propertyActions.deleteConfirm': 'Delete field',
        'ticketing.propertyActions.deleteDescription':
          'This permanently removes the field from this collection.',
        'ticketing.propertyActions.deleteImpact': `Affected Tasks: ${options?.count ?? 0}.`,
        'ticketing.propertyActions.deleteImpactLoading': 'Checking affected Tasks…',
        'ticketing.propertyActions.deleteImpactRetry': 'Check again',
        'ticketing.propertyActions.deleteImpactUnavailable':
          'The deletion impact is unavailable. Check again before deleting.',
        'ticketing.propertyActions.deleting': 'Deleting field',
        'ticketing.propertyActions.duplicate': `Duplicate ${options?.name ?? 'field'}`,
        'ticketing.propertyActions.duplicateConfirm': 'Duplicate field',
        'ticketing.propertyActions.duplicateDescription':
          'The duplicate keeps this field’s configuration.',
        'ticketing.propertyActions.duplicating': 'Duplicating field',
      })[key] ?? key,
  }),
}));

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));
const propertyLabel = 'Notes';
const scheduleLabel = 'Schedule';
const idLabel = 'ID';

rs.mock('@techsio/ui-kit/molecules/toast', () => ({
  toaster: { create: mocks.toastCreate },
}));

afterEach(() => {
  cleanup();
  mocks.toastCreate.mockClear();
});

test('duplicates with an explicit copy-values choice and deletes after showing live impact', async () => {
  const onDelete = rs.fn(() => Promise.resolve());
  const onDuplicate = rs.fn(() => Promise.resolve());
  const onLoadDeletionImpact = rs.fn(() =>
    Promise.resolve({
      impactCount: 2,
      impactRevision: 'impact-2',
      propertyDefinitionId: 'property-1',
      revision: 3,
    }),
  );

  render(
    <TaskPropertyDefinitionActions
      collectionId="collection-1"
      label={propertyLabel}
      onDelete={onDelete}
      onDuplicate={onDuplicate}
      onLoadDeletionImpact={onLoadDeletionImpact}
      propertyDefinitionId="property-1"
      revision={3}
      valueCopyPolicy="optional"
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Duplicate Notes' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Copy current values' }));
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Copy current values' })).toBeChecked(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate field' }));

  await waitFor(() => expect(onDuplicate).toHaveBeenCalledTimes(1));
  expect(onDuplicate).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      copyValues: true,
      expectedRevision: 3,
      propertyDefinitionId: 'property-1',
    },
    expect.any(String),
  );
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Duplicate Notes' })).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: 'Delete Notes' }));
  expect(await screen.findByText('Affected Tasks: 2.')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Delete field' }));

  await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  expect(onLoadDeletionImpact).toHaveBeenCalledTimes(1);
  expect(onDelete).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      confirmed: true,
      expectedImpactCount: 2,
      expectedImpactRevision: 'impact-2',
      expectedRevision: 3,
      propertyDefinitionId: 'property-1',
    },
    expect.any(String),
  );
});

test('explains fixed datatype copy behavior without offering an ineffective choice', async () => {
  const onDuplicate = rs.fn(() => Promise.resolve());
  const commonProps = {
    collectionId: 'collection-1',
    onDelete: rs.fn(() => Promise.resolve()),
    onDuplicate,
    onLoadDeletionImpact: () =>
      Promise.resolve({ impactCount: 0, propertyDefinitionId: 'property-1', revision: 1 }),
    revision: 1,
  } as const;

  const { unmount } = render(
    <TaskPropertyDefinitionActions
      {...commonProps}
      label={scheduleLabel}
      propertyDefinitionId="date-range-1"
      valueCopyPolicy="always"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate Schedule' }));
  expect(
    await screen.findByText('Existing values are always copied for this field type.'),
  ).toBeDefined();
  expect(screen.queryByRole('checkbox', { name: 'Copy current values' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate field' }));
  await waitFor(() => expect(onDuplicate).toHaveBeenCalledTimes(1));
  expect(onDuplicate.mock.calls[0]?.[0].copyValues).toBe(true);
  unmount();

  render(
    <TaskPropertyDefinitionActions
      {...commonProps}
      label={propertyLabel}
      propertyDefinitionId="text-1"
      valueCopyPolicy="never"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate Notes' }));
  expect(
    await screen.findByText('Stored values are not copied for this field type.'),
  ).toBeDefined();
  expect(screen.queryByRole('checkbox', { name: 'Copy current values' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate field' }));
  await waitFor(() => expect(onDuplicate).toHaveBeenCalledTimes(2));
  expect(onDuplicate.mock.calls[1]?.[0].copyValues).toBe(false);
});

test('requires a successful impact check and refreshes stale impact after deletion fails', async () => {
  let impactAttempt = 0;
  const onLoadDeletionImpact = rs.fn(() => {
    impactAttempt += 1;
    return impactAttempt === 1
      ? Promise.reject(new Error('Impact unavailable'))
      : Promise.resolve({
          impactCount: impactAttempt,
          impactRevision: `impact-${impactAttempt}`,
          propertyDefinitionId: 'property-1',
          revision: 3,
        });
  });
  let deleteAttempt = 0;
  const onDelete = rs.fn(() => {
    deleteAttempt += 1;
    return deleteAttempt === 1 ? Promise.reject(new Error('Impact changed')) : Promise.resolve();
  });

  render(
    <TaskPropertyDefinitionActions
      collectionId="collection-1"
      label={propertyLabel}
      onDelete={onDelete}
      onDuplicate={rs.fn(() => Promise.resolve())}
      onLoadDeletionImpact={onLoadDeletionImpact}
      propertyDefinitionId="property-1"
      revision={3}
      valueCopyPolicy="optional"
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Delete Notes' }));
  expect(
    await screen.findByText('The deletion impact is unavailable. Check again before deleting.'),
  ).toBeDefined();
  expect(screen.getByRole('button', { name: 'Delete field' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText('Affected Tasks: 2.')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Delete field' }));

  await waitFor(() => expect(onLoadDeletionImpact).toHaveBeenCalledTimes(3));
  expect(await screen.findByText('Affected Tasks: 3.')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Delete field' }));

  await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
  expect(onDelete.mock.calls[1]?.[0]).toEqual({
    collectionId: 'collection-1',
    confirmed: true,
    expectedImpactCount: 3,
    expectedImpactRevision: 'impact-3',
    expectedRevision: 3,
    propertyDefinitionId: 'property-1',
  });
  expect(onDelete.mock.calls[1]?.[1]).not.toBe(onDelete.mock.calls[0]?.[1]);
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog', { name: 'Delete Notes' })).toBeNull(),
  );
});

test('can expose delete without duplicate for ID fields', () => {
  render(
    <TaskPropertyDefinitionActions
      canDuplicate={false}
      collectionId="collection-1"
      label={idLabel}
      onDelete={rs.fn(() => Promise.resolve())}
      onDuplicate={rs.fn(() => Promise.resolve())}
      onLoadDeletionImpact={() =>
        Promise.resolve({ impactCount: 0, propertyDefinitionId: 'id-1', revision: 1 })
      }
      propertyDefinitionId="id-1"
      revision={1}
      valueCopyPolicy="optional"
    />,
  );

  expect(screen.getByRole('button', { name: 'Delete ID' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Duplicate ID' })).toBeNull();
});
