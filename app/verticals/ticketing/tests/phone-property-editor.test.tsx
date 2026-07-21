import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { PhonePropertyEditor } from '../src/components/phone-property-editor';

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.phone.call': 'Call',
        'ticketing.phone.copiedDescription': 'The exact Phone value is on your clipboard.',
        'ticketing.phone.copiedTitle': 'Phone copied',
        'ticketing.phone.copy': 'Copy',
        'ticketing.phone.invalid': 'Enter one control-free line of at most 256 characters.',
        'ticketing.phone.save': 'Save',
        'ticketing.phone.saveFailedDescription': 'The Phone value could not be saved.',
        'ticketing.phone.saveFailedTitle': 'Phone save failed',
        'ticketing.phone.staleDescription':
          'Your Phone draft is still here. Reload before trying again.',
        'ticketing.phone.staleTitle': 'Phone changed elsewhere',
      })[key] ?? key,
  }),
}));

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));
const phoneLabel = 'Direct line';
rs.mock('@techsio/ui-kit/molecules/toast', () => ({
  toaster: { create: mocks.toastCreate },
}));

afterEach(() => {
  cleanup();
  mocks.toastCreate.mockClear();
});

test('a Viewer can copy exact Phone text and invoke its safely encoded tel handoff', async () => {
  const exactValue = ' +420 (777) 123-456, ext. 42 ';
  const copyText = rs.fn(() => Promise.resolve());
  const save = rs.fn();

  render(
    <PhonePropertyEditor
      collectionId="collection-1"
      copyText={copyText}
      label={phoneLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      readOnly
      revision={1}
      taskId="task-1"
      value={exactValue}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(exactValue));
  const callLink = screen.getByRole('link', { name: 'Call' });
  expect(callLink.getAttribute('href')).toBe(`tel:${encodeURIComponent(exactValue)}`);
  mocks.toastCreate.mockClear();
  fireEvent.click(callLink);
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(mocks.toastCreate).not.toHaveBeenCalled();
});

test('an accepted exact draft becomes the value used by reader handoffs', async () => {
  const exactValue = 'ústředna 123, linka 42';
  const copyText = rs.fn(() => Promise.resolve());
  const save = rs.fn(() =>
    Promise.resolve({
      taskRevision: 2,
      value: { propertyDefinitionId: 'property-1', revision: 1, value: exactValue },
    }),
  );

  render(
    <PhonePropertyEditor
      collectionId="collection-1"
      copyText={copyText}
      label={phoneLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={0}
      taskId="task-1"
      value={null}
    />,
  );

  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Call' })).toBeNull();

  fireEvent.change(screen.getByRole('textbox', { name: phoneLabel }), {
    target: { value: exactValue },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(exactValue));
  expect(screen.getByRole('link', { name: 'Call' }).getAttribute('href')).toBe(
    `tel:${encodeURIComponent(exactValue)}`,
  );
});

test('a stale Phone save keeps the exact unsaved draft and reports the conflict', async () => {
  const staleError = Object.assign(
    new Error('The Phone value changed elsewhere or is no longer available.'),
    { code: 'ticketing.updatePhonePropertyValue.stale_or_missing' },
  );
  const save = rs.fn(() => Promise.reject(staleError));
  render(
    <PhonePropertyEditor
      collectionId="collection-1"
      label={phoneLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
      value="committed"
    />,
  );

  const input = screen.getByRole('textbox', { name: phoneLabel }) as HTMLInputElement;
  const exactDraft = '  ústředna 123, linka 42  ';
  fireEvent.change(input, { target: { value: exactDraft } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(input.value).toBe(exactDraft);
  expect(mocks.toastCreate).toHaveBeenCalledWith({
    description: 'Your Phone draft is still here. Reload before trying again.',
    title: 'Phone changed elsewhere',
    type: 'warning',
  });
});
