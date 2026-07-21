import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import {
  DateRangePropertyEditor,
  DateRangeTimeSupportControl,
} from '../src/components/date-range-property-editor';

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));
const propertyLabel = 'Delivery';

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string, values?: { count?: number }) =>
      ({
        'ticketing.dateRange.clear': 'Clear range',
        'ticketing.dateRange.disableCancel': 'Keep times',
        'ticketing.dateRange.disableConfirm': 'Remove times',
        'ticketing.dateRange.disableDescription': `${values?.count ?? 0} values contain times. Dates will be preserved.`,
        'ticketing.dateRange.disableTitle': 'Disable time support?',
        'ticketing.dateRange.empty': 'Empty',
        'ticketing.dateRange.endDate': 'End date',
        'ticketing.dateRange.endTime': 'End time',
        'ticketing.dateRange.error.equal_dates': 'Start and End must use different dates.',
        'ticketing.dateRange.error.incomplete_time_pair': 'Enter both times or neither.',
        'ticketing.dateRange.error.missing_end': 'End date is required.',
        'ticketing.dateRange.error.missing_start': 'Start date is required.',
        'ticketing.dateRange.error.start_after_end': 'Start cannot be after End.',
        'ticketing.dateRange.save': 'Save range',
        'ticketing.dateRange.saveFailedDescription': 'The Date Range could not be saved.',
        'ticketing.dateRange.saveFailedTitle': 'Date Range save failed',
        'ticketing.dateRange.startDate': 'Start date',
        'ticketing.dateRange.startTime': 'Start time',
        'ticketing.dateRange.timeSupport': 'Include time',
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

test('partial, reversed, equal-date, and incomplete-time drafts remain visible and uncommitted', () => {
  const save = rs.fn();
  render(
    <DateRangePropertyEditor
      collectionId="collection-1"
      label={propertyLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
      timeEnabled
      value={{
        endDate: '2026-07-15',
        endTime: null,
        startDate: '2026-07-12',
        startTime: null,
      }}
    />,
  );

  fireEvent.change(screen.getByLabelText('End date'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save range' }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText('End date is required.')).toBeDefined();
  expect((screen.getByLabelText('End date') as HTMLInputElement).value).toBe('');

  fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-07-11' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save range' }));
  expect(screen.getByText('Start cannot be after End.')).toBeDefined();

  fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-07-12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save range' }));
  expect(screen.getByText('Start and End must use different dates.')).toBeDefined();

  fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-07-15' } });
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save range' }));
  expect(screen.getByText('Enter both times or neither.')).toBeDefined();
  expect(save).not.toHaveBeenCalled();
});

test('time disable previews the complete-pair impact and only confirms on the destructive action', async () => {
  const configure = rs.fn(() => Promise.resolve());
  render(
    <DateRangeTimeSupportControl affectedValueCount={2} onConfigure={configure} timeEnabled />,
  );

  fireEvent.click(screen.getByRole('checkbox', { name: 'Include time' }));
  expect(await screen.findByRole('alertdialog')).toBeDefined();
  expect(screen.getByText('2 values contain times. Dates will be preserved.')).toBeDefined();
  expect(configure).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Keep times' }));
  expect(configure).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

  fireEvent.click(screen.getByRole('checkbox', { name: 'Include time' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove times' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith(false, true, 2));
});
